//! Pure occurrence-driven graph reconciliation. The caller reserves the entire returned
//! batch and reconciles again in the same transaction before launching any owner.
use std::collections::{BTreeMap, BTreeSet};

use crate::execution::{
    occurrence_deliverable, ArtifactCollection, ContextCause, ExecutionCandidate,
    ExecutionContext, ExecutionLifecycle, TaskExecutionState,
};
use crate::playbook::{ArtifactSelector, InputMode, NormalizedPlaybook, NormalizedStep};

struct Graph {
    producers: Vec<(ArtifactSelector, String)>,
    components: Vec<BTreeSet<String>>,
}

impl Graph {
    fn new(definition: &NormalizedPlaybook) -> Result<Self, String> {
        let mut producers = Vec::new();
        for step in &definition.step {
            for output in &step.outputs {
                producers.push((ArtifactSelector::parse(&output.path)?, step.key.clone()));
            }
        }
        let n = definition.step.len();
        let mut edges = vec![Vec::new(); n];
        let mut reverse = vec![Vec::new(); n];
        for (consumer, step) in definition.step.iter().enumerate() {
            for input in &step.inputs {
                let selector = ArtifactSelector::parse(&input.path)?;
                for (output, producer) in &producers {
                    if selector.overlaps(output) {
                        let source = definition.step.iter().position(|s| &s.key == producer).ok_or("missing producer")?;
                        edges[source].push(consumer);
                        reverse[consumer].push(source);
                    }
                }
            }
        }
        fn visit(node: usize, edges: &[Vec<usize>], seen: &mut [bool], order: &mut Vec<usize>) {
            if seen[node] { return; }
            seen[node] = true;
            for &next in &edges[node] { visit(next, edges, seen, order); }
            order.push(node);
        }
        let mut order = Vec::new();
        let mut seen = vec![false; n];
        for node in 0..n { visit(node, &edges, &mut seen, &mut order); }
        seen.fill(false);
        let mut components = Vec::new();
        for node in order.into_iter().rev() {
            if seen[node] { continue; }
            let mut members = Vec::new();
            visit(node, &reverse, &mut seen, &mut members);
            if members.len() > 1 || edges[node].contains(&node) {
                components.push(members.into_iter().map(|i| definition.step[i].key.clone()).collect());
            }
        }
        Ok(Self { producers, components })
    }

    fn producer(&self, path: &str) -> Option<&str> {
        self.producers.iter().find(|(selector, _)| selector.matches(path)).map(|(_, step)| step.as_str())
    }
}

fn identity<T: serde::Serialize>(kind: &str, value: &T) -> Result<String, String> {
    // Structural IDs, not hashes: no collisions or dependency on event arrival order.
    serde_json::to_string(&(kind, value)).map_err(|e| e.to_string())
}

fn nearest_member<'a>(state: &'a TaskExecutionState, context: &str) -> Option<(&'a str, &'a str, &'a str)> {
    let mut current = state.contexts.get(context)?;
    loop {
        match &current.cause {
            ContextCause::Member { collection_id, occurrence_id } => {
                return Some((current.parent_id.as_deref()?, collection_id, occurrence_id));
            }
            // A fresh activation must not contribute to its previous pass's family.
            ContextCause::Loop { .. } => return None,
            ContextCause::Root => {}
        }
        current = state.contexts.get(current.parent_id.as_deref()?)?;
    }
}

fn resolve_single(state: &TaskExecutionState, graph: &Graph, context: &str, path: &str) -> Option<String> {
    let mut current = state.contexts.get(context)?;
    loop {
        if let Some(ids) = current.bindings.get(path) {
            let mut delivered = ids.iter().filter(|id| state.occurrences.get(*id).is_some_and(|o| occurrence_deliverable(state, o)));
            let first = delivered.next()?;
            return if delivered.next().is_none() { Some(first.clone()) } else { None };
        }
        if let ContextCause::Loop { component_steps, .. } = &current.cause {
            if graph.producer(path).is_some_and(|p| component_steps.contains(p)) { return None; }
        }
        current = state.contexts.get(current.parent_id.as_deref()?)?;
    }
}

fn entry_roles(state: &TaskExecutionState, graph: &Graph, component: &BTreeSet<String>) -> BTreeSet<String> {
    let mut roles = BTreeSet::new();
    for execution in state.executions.values().filter(|e| !e.candidate.manual && component.contains(&e.candidate.step_key)) {
        for (path, ids) in &execution.candidate.inputs {
            if !graph.producer(path).is_some_and(|p| component.contains(p)) { continue; }
            if ids.iter().any(|id| state.occurrences.get(id).is_some_and(|o| {
                o.producer_execution_id.as_ref().and_then(|id| state.executions.get(id))
                    .is_none_or(|producer| !component.contains(&producer.candidate.step_key))
            })) {
                roles.insert(path.clone());
            }
        }
    }
    roles
}

fn route_occurrences(state: &mut TaskExecutionState, graph: &Graph) -> Result<(), String> {
    let entries: Vec<_> = graph.components.iter().map(|component| entry_roles(state, graph, component)).collect();
    let mut triggers: BTreeMap<(usize, String), BTreeMap<String, Vec<String>>> = BTreeMap::new();
    let delivered: Vec<_> = state.occurrences.values().filter(|o| occurrence_deliverable(state, o)).cloned().collect();
    for occurrence in delivered {
        let producer = occurrence.producer_execution_id.as_ref().and_then(|id| state.executions.get(id));
        if producer.is_some_and(|e| e.candidate.manual) { continue; }
        let reentry = producer.and_then(|e| graph.components.iter().enumerate().find(|(index, component)| {
            component.contains(&e.candidate.step_key) && entries[*index].contains(&occurrence.logical_path)
        }).map(|(index, _)| index));
        if let Some(index) = reentry {
            triggers.entry((index, occurrence.context_id.clone())).or_default()
                .entry(occurrence.logical_path.clone()).or_default().push(occurrence.id.clone());
        } else {
            let context = state.contexts.get_mut(&occurrence.context_id).ok_or("occurrence has unknown context")?;
            let ids = context.bindings.entry(occurrence.logical_path).or_default();
            if !ids.contains(&occurrence.id) { ids.push(occurrence.id); ids.sort(); }
        }
    }
    for ((index, parent), mut bindings) in triggers {
        // One AND entry is one activation. Never make a partial activation, or
        // choose a latest occurrence when the causal context is ambiguous.
        if entries[index].iter().any(|role| bindings.get(role).is_none_or(|ids| ids.len() != 1)) { continue; }
        for ids in bindings.values_mut() { ids.sort(); }
        let trigger_occurrences = bindings.values().flatten().cloned().collect::<BTreeSet<_>>();
        // Trigger occurrence IDs are globally unique; embedding the parent ID
        // would recursively expand every previous pass into this identifier.
        let id = identity("loop", &(&graph.components[index], &trigger_occurrences))?;
        state.contexts.entry(id.clone()).or_insert(ExecutionContext {
            id, parent_id: Some(parent), cause: ContextCause::Loop {
                component_steps: graph.components[index].clone(), trigger_occurrences,
            }, bindings,
        });
    }
    Ok(())
}

fn initiating_each_selectors(
    definition: &NormalizedPlaybook,
    state: &TaskExecutionState,
    collection: &ArtifactCollection,
    source_id: &str,
) -> Result<Vec<ArtifactSelector>, String> {
    // A downstream exact step or local merge retains its initiating Each
    // bindings in execution ancestry. Those selectors define the obligated
    // subset, not every member of a broader producer output declaration.
    let mut pending: Vec<_> = collection.expected_execution_ids.iter().collect();
    let mut visited = BTreeSet::new();
    let mut paths = BTreeSet::new();
    while let Some(id) = pending.pop() {
        if !visited.insert(id) { continue; }
        let execution = state.executions.get(id).ok_or("unknown collection ancestor")?;
        if execution.candidate.each_collection_id.as_deref() == Some(source_id) {
            let step = definition.step.iter().find(|step| step.key == execution.candidate.step_key)
                .ok_or("unknown collection ancestor step")?;
            let input = step.inputs.iter().find(|input| input.mode == InputMode::Each)
                .ok_or("collection ancestor lacks its each selector")?;
            paths.insert(&input.path);
        }
        pending.extend(execution.parent_execution_ids.iter());
    }
    paths.into_iter().map(|path| ArtifactSelector::parse(path)).collect()
}

fn configure_collections(definition: &NormalizedPlaybook, state: &mut TaskExecutionState) -> Result<(), String> {
    // Local collections retain unknown cardinality. Derived families aggregate
    // one source collection only; they never flatten child collections.
    let mut additions = Vec::new();
    for execution in state.executions.values().filter(|e| !e.candidate.manual) {
        let step = definition.step.iter().find(|s| s.key == execution.candidate.step_key).ok_or("unknown execution step")?;
        for output in &step.outputs {
            let selector = ArtifactSelector::parse(&output.path)?;
            let consumed_as_collection = definition.step.iter().flat_map(|step| &step.inputs).any(|input| {
                input.mode != InputMode::Single && ArtifactSelector::parse(&input.path).is_ok_and(|input| input.overlaps(&selector))
            });
            if !selector.wildcard && !consumed_as_collection { continue; }
            let id = identity("output", &(&execution.id, &output.path))?;
            additions.push(ArtifactCollection {
                id, context_id: execution.candidate.context_id.clone(), selector: output.path.clone(),
                producer_step: step.key.clone(), source_collection_id: None,
                expected_execution_ids: BTreeSet::from([execution.id.clone()]),
                member_occurrence_ids: BTreeSet::new(), membership_closed: false,
            });
            if let Some((parent, source, _)) = nearest_member(state, &execution.candidate.context_id) {
                let id = identity("family", &(parent, source, &step.key, &output.path))?;
                additions.push(ArtifactCollection {
                    id, context_id: parent.into(), selector: output.path.clone(), producer_step: step.key.clone(),
                    source_collection_id: Some(source.into()), expected_execution_ids: BTreeSet::from([execution.id.clone()]),
                    member_occurrence_ids: BTreeSet::new(), membership_closed: false,
                });
            }
        }
    }
    for addition in additions {
        state.collections.entry(addition.id.clone()).and_modify(|collection| {
            collection.expected_execution_ids.extend(addition.expected_execution_ids.clone());
        }).or_insert(addition);
    }
    let memberships: Vec<_> = state.collections.values().map(|collection| {
        let members = state.occurrences.values().filter(|occurrence| {
            occurrence.selector == collection.selector && occurrence.producer_execution_id.as_ref()
                .is_some_and(|id| collection.expected_execution_ids.contains(id))
        }).map(|o| o.id.clone()).collect::<BTreeSet<_>>();
        (collection.id.clone(), members)
    }).collect();
    for (id, members) in memberships {
        for member in &members {
            state.occurrences.get_mut(member).ok_or("missing collection occurrence")?.collection_ids.insert(id.clone());
        }
        state.collections.get_mut(&id).ok_or("missing collection")?.member_occurrence_ids = members;
    }
    // A family can depend on a family recorded earlier in this same transaction.
    // Closure is monotone, so a fixed point handles arbitrary nesting/order.
    loop {
        let mut closable = Vec::new();
        for collection in state.collections.values() {
            if collection.membership_closed || collection.member_occurrence_ids.is_empty() { continue; }
            if !collection.expected_execution_ids.iter().all(|id| state.executions.get(id).is_some_and(|e| {
                e.lifecycle == ExecutionLifecycle::Completed && e.shutdown_confirmed && e.receipt_id.is_some()
            })) { continue; }
            if let Some(source_id) = &collection.source_collection_id {
                let source = state.collections.get(source_id).ok_or("unknown source collection")?;
                if !source.membership_closed { continue; }
                let selectors = initiating_each_selectors(definition, state, collection, source_id)?;
                let represented: BTreeSet<_> = collection.expected_execution_ids.iter().filter_map(|id| {
                    let execution = state.executions.get(id)?;
                    let (_, source, member) = nearest_member(state, &execution.candidate.context_id)?;
                    (source == source_id).then_some(member)
                }).collect();
                let mut missing = false;
                for id in &source.member_occurrence_ids {
                    let occurrence = state.occurrences.get(id).ok_or("unknown source collection member")?;
                    if selectors.iter().all(|selector| selector.matches(&occurrence.logical_path))
                        && !represented.contains(id.as_str()) {
                        missing = true;
                        break;
                    }
                }
                if missing { continue; }
            }
            closable.push(collection.id.clone());
        }
        if closable.is_empty() { break; }
        for id in closable { state.collections.get_mut(&id).ok_or("missing closing collection")?.membership_closed = true; }
    }
    Ok(())
}

fn bind_singles(step: &NormalizedStep, state: &TaskExecutionState, graph: &Graph, candidate: &mut ExecutionCandidate) -> bool {
    for input in step.inputs.iter().filter(|i| i.mode == InputMode::Single) {
        let Some(id) = resolve_single(state, graph, &candidate.context_id, &input.path) else { return false; };
        candidate.inputs.insert(input.path.clone(), vec![id]);
    }
    true
}

fn candidate(step: &NormalizedStep, context: &str) -> ExecutionCandidate {
    ExecutionCandidate {
        step_key: step.key.clone(), context_id: context.into(), inputs: BTreeMap::new(),
        complete_collection_id: None, each_collection_id: None, each_member_id: None, manual: false,
    }
}

/// Reconcile only recorded occurrences and contexts. Files, timestamps, session
/// mirrors, and manual executions cannot make an ordinary binding eligible.
/// Reserve every candidate, then call again before committing or launching: this
/// records the entire expected worker set even when capacity allows only one owner.
pub fn reconcile_graph(definition: &NormalizedPlaybook, state: &mut TaskExecutionState) -> Result<Vec<ExecutionCandidate>, String> {
    if state.creation != "ready" { return Ok(Vec::new()); }
    let graph = Graph::new(definition)?;
    route_occurrences(state, &graph)?;
    configure_collections(definition, state)?;
    let mut candidates = BTreeMap::new();
    for step in &definition.step {
        if let Some(input) = step.inputs.iter().find(|i| i.mode != InputMode::Single) {
            let selector = ArtifactSelector::parse(&input.path)?;
            let collections: Vec<_> = state.collections.values().filter(|collection| {
                collection.membership_closed && ArtifactSelector::parse(&collection.selector).is_ok_and(|s| selector.overlaps(&s))
            }).cloned().collect();
            for collection in collections {
                if input.mode == InputMode::Each {
                    // Local producer batches preserve nested member ancestry.
                    if collection.source_collection_id.is_some() { continue; }
                    for member in &collection.member_occurrence_ids {
                        let occurrence = state.occurrences.get(member).ok_or("unknown collection member")?;
                        if !selector.matches(&occurrence.logical_path) { continue; }
                        let id = identity("member", &(&collection.id, member))?;
                        state.contexts.entry(id.clone()).or_insert(ExecutionContext {
                            id: id.clone(), parent_id: Some(collection.context_id.clone()),
                            cause: ContextCause::Member { collection_id: collection.id.clone(), occurrence_id: member.clone() },
                            bindings: BTreeMap::from([(occurrence.logical_path.clone(), vec![member.clone()])]),
                        });
                        let mut binding = candidate(step, &id);
                        binding.each_collection_id = Some(collection.id.clone());
                        binding.each_member_id = Some(member.clone());
                        binding.inputs.insert(input.path.clone(), vec![member.clone()]);
                        if bind_singles(step, state, &graph, &mut binding) { candidates.insert(binding.binding_key()?, binding); }
                    }
                } else {
                    // An each worker's local subset is not a complete family.
                    if collection.source_collection_id.is_none() && collection.expected_execution_ids.iter().any(|id| {
                        state.executions.get(id).is_some_and(|e| nearest_member(state, &e.candidate.context_id).is_some())
                    }) { continue; }
                    let members: Vec<_> = collection.member_occurrence_ids.iter().filter(|id| {
                        state.occurrences.get(*id).is_some_and(|o| selector.matches(&o.logical_path))
                    }).cloned().collect();
                    if members.is_empty() { continue; }
                    let mut binding = candidate(step, &collection.context_id);
                    binding.complete_collection_id = Some(collection.id.clone());
                    binding.inputs.insert(input.path.clone(), members);
                    if bind_singles(step, state, &graph, &mut binding) { candidates.insert(binding.binding_key()?, binding); }
                }
            }
        } else {
            for context in state.contexts.values() {
                if step.inputs.is_empty() && !matches!(context.cause, ContextCause::Root) { continue; }
                let mut binding = candidate(step, &context.id);
                if !bind_singles(step, state, &graph, &mut binding) { continue; }
                // Inheritance supplies governing context, not a cross-product of
                // new executions for every descendant with the same old seeds.
                if !step.inputs.is_empty() && !binding.inputs.values().flatten().any(|id| {
                    state.occurrences.get(id).is_some_and(|o| o.context_id == context.id)
                        || matches!(&context.cause, ContextCause::Loop { trigger_occurrences, .. } if trigger_occurrences.contains(id))
                }) { continue; }
                candidates.insert(binding.binding_key()?, binding);
            }
        }
    }
    for execution in state.executions.values().filter(|e| !e.candidate.manual) { candidates.remove(&execution.binding_key); }
    Ok(candidates.into_values().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::execution::{
        accept_execution_completion, claim_execution_launch, confirm_execution_exit,
        grant_execution_completion, install_seed, new_execution_state, record_execution_spawn,
        recover_execution_owner, request_execution_start, reserve_execution, CompletionOutcome,
        LaunchChoices,
    };
    use crate::playbook::{
        parse_playbook_md, render_playbook_md, InputSelector, OutputSelector, PlaybookRef, PlaybookScope,
    };
    use std::path::PathBuf;

    fn step(key: &str, inputs: &[(&str, InputMode)], outputs: &[&str]) -> NormalizedStep {
        NormalizedStep {
            key: key.into(), title: key.into(), short: String::new(),
            is_coding_step: false, auto_advance_default: true,
            inputs: inputs.iter().map(|(path, mode)| InputSelector { path: (*path).into(), mode: *mode }).collect(),
            outputs: outputs.iter().map(|path| OutputSelector { path: (*path).into() }).collect(),
            model: String::new(), harness: String::new(), prompt: "Write the assigned output.\n".into(),
        }
    }

    struct Fixture {
        repo: PathBuf,
        definition: NormalizedPlaybook,
        state: TaskExecutionState,
    }

    impl Drop for Fixture {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.repo); }
    }

    impl Fixture {
        fn new(steps: Vec<NormalizedStep>) -> Self {
            let source = render_playbook_md(&NormalizedPlaybook {
                version: 2, key: "graph".into(), title: "Graph".into(), description: String::new(),
                default_model: String::new(), default_harness: "omp".into(),
                section_order: steps.iter().map(|s| s.key.clone()).collect(), step: steps, preamble: String::new(),
            });
            let definition = parse_playbook_md(&source).unwrap();
            let mut state = new_execution_state(
                PlaybookRef { scope: PlaybookScope::Repo, key: "graph".into() }, &source,
                "test-lane".into(), 10, definition.step.iter().map(|s| s.key.clone()).collect(),
                LaunchChoices::default(),
            ).unwrap();
            state.creation = "ready".into();
            let repo = std::env::temp_dir().join(format!("alinery-graph-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(crate::artifacts_dir(&repo, "task")).unwrap();
            let mut fixture = Self { repo, definition, state };
            fixture.seed("ticket.md", "00-ticket.md", "2 3 5");
            fixture
        }

        fn seed(&mut self, logical: &str, physical: &str, contents: &str) -> String {
            let path = crate::artifacts_dir(&self.repo, "task").join(physical);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, contents).unwrap();
            install_seed(&mut self.state, logical, physical).unwrap()
        }

        fn ready(&mut self) -> Vec<ExecutionCandidate> {
            reconcile_graph(&self.definition, &mut self.state).unwrap()
        }

        fn reserve(&mut self, candidate: ExecutionCandidate) -> String {
            reserve_execution(
                &self.repo, "task", &self.definition, &mut self.state, candidate,
                &LaunchChoices::default(), None, true,
            ).unwrap()
        }

        fn tick(&mut self) -> Vec<String> {
            let candidates = self.ready();
            let ids = candidates.into_iter().map(|candidate| self.reserve(candidate)).collect();
            // This is the daemon transaction contract: expectations before launch.
            assert!(self.ready().is_empty());
            ids
        }

        fn named(&self, ids: &[String], step: &str) -> String {
            ids.iter().find(|id| self.state.executions[*id].candidate.step_key == step).unwrap().clone()
        }

        fn start(&mut self, id: &str) {
            assert!(claim_execution_launch(&mut self.state, id).unwrap());
            let owner = self.state.executions[id].owner_session_id.clone();
            record_execution_spawn(&mut self.state, id, &owner, Ok(())).unwrap();
        }

        fn write(&self, id: &str, outputs: &[(&str, &str)]) {
            for (logical, contents) in outputs {
                let assignment = self.state.executions[id].outputs.iter().find(|output| {
                    ArtifactSelector::parse(&output.selector).unwrap().matches(logical)
                }).unwrap();
                let physical = if let Some((prefix, suffix)) = assignment.selector.split_once('*') {
                    let member = &logical[prefix.len()..logical.len() - suffix.len()];
                    assignment.relative_path.replace('*', member)
                } else { assignment.relative_path.clone() };
                let path = crate::artifacts_dir(&self.repo, "task").join(physical);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, contents).unwrap();
            }
        }

        fn accept(&mut self, id: &str) -> CompletionOutcome {
            let owner = self.state.executions[id].owner_session_id.clone();
            accept_execution_completion(&self.repo, "task", &mut self.state, id, &owner).unwrap()
        }

        fn exit(&mut self, id: &str) {
            let owner = self.state.executions[id].owner_session_id.clone();
            confirm_execution_exit(&mut self.state, id, &owner, Some(0)).unwrap();
        }

        fn finish(&mut self, id: &str, outputs: &[(&str, &str)]) {
            self.start(id);
            self.write(id, outputs);
            assert!(matches!(self.accept(id), CompletionOutcome::Accepted { .. }));
            self.exit(id);
        }

        fn numbers(&self, id: &str, selector: &str) -> Vec<i64> {
            self.state.executions[id].candidate.inputs[selector].iter().flat_map(|id| {
                std::fs::read_to_string(crate::artifacts_dir(&self.repo, "task").join(&self.state.occurrences[id].relative_path))
                    .unwrap().split_whitespace().map(|n| n.parse::<i64>().unwrap()).collect::<Vec<_>>()
            }).collect()
        }

        fn output_ids(&self, id: &str) -> BTreeSet<String> {
            self.state.occurrences.values().filter(|o| o.producer_execution_id.as_deref() == Some(id))
                .map(|o| o.id.clone()).collect()
        }

        fn restart(&mut self) {
            self.state = serde_json::from_slice(&serde_json::to_vec(&self.state).unwrap()).unwrap();
        }
    }

    #[test]
    fn exact_fork_joins_only_results_of_its_numbers_occurrence() {
        use InputMode::Single;
        let mut f = Fixture::new(vec![
            step("combine", &[("sum.md", Single), ("product.md", Single)], &["answer.md"]),
            step("product", &[("numbers.md", Single)], &["product.md"]),
            step("seed", &[("ticket.md", Single)], &["numbers.md"]),
            step("sum", &[("numbers.md", Single)], &["sum.md"]),
        ]);
        let ids = f.tick();
        let seed = f.named(&ids, "seed");
        f.finish(&seed, &[("numbers.md", "2 3 5")]);
        let ids = f.tick();
        let sum = f.named(&ids, "sum");
        let product = f.named(&ids, "product");
        assert_eq!(f.state.executions[&sum].candidate.inputs["numbers.md"].iter().cloned().collect::<BTreeSet<_>>(), f.output_ids(&seed));
        let product_value: i64 = f.numbers(&product, "numbers.md").iter().product();
        f.finish(&product, &[("product.md", &product_value.to_string())]);
        assert!(f.ready().is_empty());
        let sum_value: i64 = f.numbers(&sum, "numbers.md").iter().sum();
        f.start(&sum);
        f.write(&sum, &[("sum.md", &sum_value.to_string())]);
        assert!(matches!(f.accept(&sum), CompletionOutcome::Accepted { .. }));
        assert!(f.ready().is_empty(), "accepted but live is not a handoff");
        f.exit(&sum);
        let ids = f.tick();
        let combine = f.named(&ids, "combine");
        let actual = f.state.executions[&combine].candidate.inputs.values().flatten().cloned().collect::<BTreeSet<_>>();
        assert_eq!(actual, f.output_ids(&sum).union(&f.output_ids(&product)).cloned().collect());
        assert_eq!(f.state.executions[&combine].depth, 3);
        let answer = f.numbers(&combine, "sum.md")[0] + f.numbers(&combine, "product.md")[0];
        f.finish(&combine, &[("answer.md", &answer.to_string())]);
        assert_eq!(answer, 40);
    }

    fn fanout() -> Fixture {
        use InputMode::{Complete, Each, Single};
        Fixture::new(vec![
            step("collect", &[("result-*.md", Complete)], &["answer.md"]),
            step("square", &[("request-*.md", Each)], &["result-*.md"]),
            step("seed", &[("ticket.md", Single)], &["request-*.md"]),
        ])
    }

    #[test]
    fn complete_waits_for_every_expected_worker_and_source_exit() {
        let mut f = fanout();
        let ids = f.tick();
        let seed = f.named(&ids, "seed");
        f.start(&seed);
        f.write(&seed, &[("request-a.md", "2"), ("request-b.md", "3"), ("request-c.md", "5")]);
        assert!(matches!(f.accept(&seed), CompletionOutcome::Accepted { .. }));
        assert!(f.ready().is_empty());
        f.exit(&seed);
        let workers = f.tick();
        let family = f.state.collections.values().find(|c| c.selector == "result-*.md" && c.source_collection_id.is_some()).unwrap();
        assert_eq!(family.expected_execution_ids, workers.iter().cloned().collect());
        let b = workers.iter().find(|id| f.numbers(id, "request-*.md") == [3]).unwrap().clone();
        for id in workers.iter().filter(|id| **id != b) {
            let value = f.numbers(id, "request-*.md")[0].pow(2);
            f.finish(id, &[("result-square.md", &value.to_string())]);
        }
        assert!(f.ready().is_empty(), "queued B remains expected");
        f.start(&b);
        assert!(f.ready().is_empty(), "reviewing B remains expected");
        f.exit(&b);
        assert!(f.ready().is_empty(), "failed B remains expected");
        let owner = recover_execution_owner(&mut f.state, &b).unwrap();
        request_execution_start(&mut f.state, &b).unwrap();
        f.start(&b);
        grant_execution_completion(&mut f.state, &b, &owner).unwrap();
        let value = f.numbers(&b, "request-*.md")[0].pow(2);
        f.write(&b, &[("result-square.md", &value.to_string())]);
        assert!(matches!(f.accept(&b), CompletionOutcome::Accepted { .. }));
        assert!(f.ready().is_empty(), "finishing B remains expected");
        f.exit(&b);
        let ids = f.tick();
        let collect = f.named(&ids, "collect");
        assert_eq!(f.state.executions[&collect].candidate.inputs["result-*.md"].iter().cloned().collect::<BTreeSet<_>>(),
            workers.iter().flat_map(|id| f.output_ids(id)).collect());
        let answer: i64 = f.numbers(&collect, "result-*.md").iter().sum();
        f.finish(&collect, &[("answer.md", &answer.to_string())]);
        assert_eq!(answer, 38);
    }

    #[test]
    fn nested_fanout_closes_the_correct_family_after_restart() {
        use InputMode::{Complete, Each, Single};
        let mut f = Fixture::new(vec![
            step("parent", &[("local-*.md", Complete)], &["answer.md", "ticket.md"]),
            step("local", &[("inner-result-*.md", Complete)], &["local-*.md"]),
            step("worker", &[("inner-request-*.md", Each), ("policy.md", Single)], &["inner-result-*.md"]),
            step("expand", &[("outer-*.md", Each)], &["inner-request-*.md"]),
            step("seed", &[("ticket.md", Single)], &["outer-*.md"]),
        ]);
        let policy = f.seed("policy.md", "policy.md", "7");
        let ids = f.tick();
        let seed = f.named(&ids, "seed");
        f.finish(&seed, &[("outer-a.md", "2"), ("outer-b.md", "3")]);
        let expanders = f.tick();
        for id in &expanders {
            if f.numbers(id, "outer-*.md") == [2] {
                f.finish(id, &[("inner-request-a1.md", "1"), ("inner-request-a2.md", "2")]);
            } else {
                f.finish(id, &[("inner-request-b1.md", "3"), ("inner-request-b2.md", "4"), ("inner-request-b3.md", "5")]);
            }
        }
        let workers = f.tick();
        assert_eq!(workers.len(), 5);
        for id in &workers { assert_eq!(f.state.executions[id].candidate.inputs["policy.md"], [policy.clone()]); }
        let delayed = workers.iter().find(|id| f.numbers(id, "inner-request-*.md") == [4]).unwrap().clone();
        for number in [5, 2, 3, 1] {
            let id = workers.iter().find(|id| f.numbers(id, "inner-request-*.md") == [number]).unwrap();
            f.finish(id, &[("inner-result-value.md", &number.to_string())]);
        }
        f.restart();
        let first = f.tick();
        let local_a = f.named(&first, "local");
        assert_eq!(f.numbers(&local_a, "inner-result-*.md").into_iter().collect::<BTreeSet<_>>(), BTreeSet::from([1, 2]));
        let value: i64 = f.numbers(&local_a, "inner-result-*.md").iter().sum();
        f.finish(&local_a, &[("local-total.md", &value.to_string())]);
        assert!(f.ready().is_empty(), "parent cannot consume the first local subset");
        f.finish(&delayed, &[("inner-result-value.md", "4")]);
        let second = f.tick();
        let local_b = f.named(&second, "local");
        assert_eq!(f.numbers(&local_b, "inner-result-*.md").into_iter().collect::<BTreeSet<_>>(), BTreeSet::from([3, 4, 5]));
        let value: i64 = f.numbers(&local_b, "inner-result-*.md").iter().sum();
        f.finish(&local_b, &[("local-total.md", &value.to_string())]);
        let ids = f.tick();
        let parent = f.named(&ids, "parent");
        let bound = f.state.executions[&parent].candidate.inputs["local-*.md"].iter().cloned().collect::<BTreeSet<_>>();
        assert_eq!(bound, f.output_ids(&local_a).union(&f.output_ids(&local_b)).cloned().collect());
        assert!(workers.iter().flat_map(|id| f.output_ids(id)).all(|id| !bound.contains(&id)));
        assert_eq!(f.numbers(&parent, "local-*.md").iter().sum::<i64>(), 15);
        f.finish(&parent, &[("answer.md", "15"), ("ticket.md", "next cohort")]);
        let ids = f.tick();
        let next_seed = f.named(&ids, "seed");
        f.finish(&next_seed, &[("outer-a.md", "1")]);
        let ids = f.tick();
        let next_expand = f.named(&ids, "expand");
        f.finish(&next_expand, &[("inner-request-a1.md", "100")]);
        let ids = f.tick();
        let next_worker = f.named(&ids, "worker");
        assert_eq!(f.numbers(&next_worker, "inner-request-*.md"), [100]);
        assert_eq!(f.state.executions[&next_worker].candidate.inputs["policy.md"], [policy]);
        f.finish(&next_worker, &[("inner-result-value.md", "100")]);
        let ids = f.tick();
        let next_local = f.named(&ids, "local");
        assert_eq!(f.numbers(&next_local, "inner-result-*.md"), [100]);
        assert_eq!(f.state.executions[&next_local].candidate.inputs["inner-result-*.md"].iter().cloned().collect::<BTreeSet<_>>(),
            f.output_ids(&next_worker));
    }

    #[test]
    fn fresh_ticket_reentry_invalidates_prior_pass_outputs() {
        use InputMode::Single;
        let mut f = Fixture::new(vec![
            step("d", &[("c.md", Single)], &["ticket.md"]),
            step("b", &[("a.md", Single)], &["b.md"]),
            step("a", &[("ticket.md", Single)], &["a.md"]),
            step("c", &[("b.md", Single)], &["c.md"]),
        ]);
        for (key, output, depth) in [("a", "a.md", 1), ("b", "b.md", 2), ("c", "c.md", 3)] {
            let ids = f.tick();
            let id = f.named(&ids, key);
            assert_eq!(f.state.executions[&id].depth, depth);
            f.finish(&id, &[(output, "1")]);
        }
        let ids = f.tick();
        let d = f.named(&ids, "d");
        assert_eq!(f.state.executions[&d].depth, 4);
        f.start(&d);
        f.write(&d, &[("ticket.md", "next")]);
        assert!(matches!(f.accept(&d), CompletionOutcome::Accepted { .. }));
        assert!(f.ready().is_empty());
        f.exit(&d);
        let ids = f.tick();
        let a2 = f.named(&ids, "a");
        assert_eq!(f.state.executions[&a2].depth, 5);
        assert_eq!(f.state.executions[&a2].candidate.inputs["ticket.md"].iter().cloned().collect::<BTreeSet<_>>(), f.output_ids(&d));
        f.restart();
        f.write(&d, &[("ticket.md", "rewritten")]);
        std::fs::write(crate::artifacts_dir(&f.repo, "task").join("999-ticket-99.md"), "unaccepted").unwrap();
        assert!(f.ready().is_empty());
        assert!(f.ready().is_empty());
    }

    #[test]
    fn loop_fork_join_never_reuses_a_previous_activation_sibling() {
        use InputMode::Single;
        let mut f = Fixture::new(vec![
            step("join", &[("sum.md", Single), ("product.md", Single)], &["joined.md"]),
            step("continue", &[("joined.md", Single)], &["ticket.md"]),
            step("sum", &[("numbers.md", Single), ("policy.md", Single)], &["sum.md"]),
            step("product", &[("numbers.md", Single)], &["product.md"]),
            step("seed", &[("ticket.md", Single)], &["numbers.md"]),
        ]);
        let policy = f.seed("policy.md", "policy.md", "11");
        let ids = f.tick();
        let seed = f.named(&ids, "seed");
        f.finish(&seed, &[("numbers.md", "2 3 5")]);
        let branches = f.tick();
        let old_sum = f.named(&branches, "sum");
        let old_product = f.named(&branches, "product");
        f.finish(&old_sum, &[("sum.md", "10")]);
        f.finish(&old_product, &[("product.md", "30")]);
        let ids = f.tick();
        let join = f.named(&ids, "join");
        f.finish(&join, &[("joined.md", "40")]);
        let ids = f.tick();
        let continuation = f.named(&ids, "continue");
        f.finish(&continuation, &[("ticket.md", "second")]);
        let ids = f.tick();
        let seed2 = f.named(&ids, "seed");
        f.finish(&seed2, &[("numbers.md", "3 4")]);
        let branches = f.tick();
        let sum2 = f.named(&branches, "sum");
        let product2 = f.named(&branches, "product");
        assert_eq!(f.state.executions[&sum2].candidate.inputs["policy.md"], [policy]);
        f.finish(&sum2, &[("sum.md", "7")]);
        assert!(f.ready().is_empty());
        assert!(matches!(f.accept(&old_product), CompletionOutcome::Accepted { .. }));
        f.exit(&old_product);
        f.restart();
        assert!(f.ready().is_empty());
        f.finish(&product2, &[("product.md", "12")]);
        let ids = f.tick();
        let join2 = f.named(&ids, "join");
        assert_eq!(f.state.executions[&join2].candidate.inputs.values().flatten().cloned().collect::<BTreeSet<_>>(),
            f.output_ids(&sum2).union(&f.output_ids(&product2)).cloned().collect());
    }

    #[test]
    fn and_entry_emitted_together_creates_one_complete_activation() {
        use InputMode::Single;
        let mut f = Fixture::new(vec![
            step("entry", &[("ticket.md", Single), ("request.md", Single)], &["result.md"]),
            step("continue", &[("result.md", Single)], &["ticket.md", "request.md"]),
        ]);
        f.seed("request.md", "request.md", "initial");
        let ids = f.tick();
        let entry = f.named(&ids, "entry");
        f.finish(&entry, &[("result.md", "done")]);
        let ids = f.tick();
        let continuation = f.named(&ids, "continue");
        f.start(&continuation);
        f.write(&continuation, &[("ticket.md", "next")]);
        assert!(matches!(f.accept(&continuation), CompletionOutcome::InvalidOutputs { .. }));
        assert!(f.ready().is_empty());
        f.write(&continuation, &[("request.md", "next")]);
        assert!(matches!(f.accept(&continuation), CompletionOutcome::Accepted { .. }));
        assert!(f.ready().is_empty());
        f.exit(&continuation);
        let ids = f.tick();
        assert_eq!(ids.len(), 1);
        let next = f.named(&ids, "entry");
        assert_eq!(f.state.executions[&next].candidate.inputs.values().flatten().cloned().collect::<BTreeSet<_>>(), f.output_ids(&continuation));
        assert_eq!(f.state.contexts.values().filter(|c| matches!(c.cause, ContextCause::Loop { .. })).count(), 1);
    }

    #[test]
    fn roots_terminal_steps_and_human_pause_do_not_invent_work() {
        use InputMode::Single;
        let mut f = Fixture::new(vec![
            step("missing", &[("evidence.md", Single)], &["missing.md"]),
            step("second", &[("ticket.md", Single)], &["second.md"]),
            step("root", &[], &["root.md"]),
            step("first", &[("ticket.md", Single)], &["first.md"]),
        ]);
        let attachments = crate::artifacts_dir(&f.repo, "task").join("attachments");
        std::fs::create_dir_all(&attachments).unwrap();
        std::fs::write(attachments.join("evidence.md"), "not a seed").unwrap();
        let ids = f.tick();
        assert_eq!(ids.iter().map(|id| f.state.executions[id].candidate.step_key.as_str()).collect::<BTreeSet<_>>(),
            BTreeSet::from(["first", "root", "second"]));
        let root = f.named(&ids, "root");
        f.start(&root);
        assert!(matches!(f.accept(&root), CompletionOutcome::InvalidOutputs { .. }));
        assert_eq!(f.state.executions[&root].lifecycle, ExecutionLifecycle::Running);
        assert!(f.ready().is_empty());
        f.write(&root, &[("root.md", "done")]);
        assert!(matches!(f.accept(&root), CompletionOutcome::Accepted { .. }));
        f.exit(&root);
        f.restart();
        assert!(f.ready().is_empty());
    }

    #[test]
    fn ordinary_binding_dedup_survives_replay_and_manual_work() {
        let mut f = fanout();
        let same_binding = f.ready().pop().unwrap();
        let seed = f.reserve(same_binding.clone());
        assert_eq!(seed, f.reserve(same_binding));
        f.finish(&seed, &[("request-a.md", "2"), ("request-b.md", "3")]);
        let workers = f.tick();
        let first = workers[0].clone();
        let second = workers[1].clone();
        let mut independent = f.state.executions[&second].candidate.clone();
        independent.manual = true;
        let manual = f.reserve(independent);
        f.finish(&manual, &[("result-manual.md", "999")]);
        f.finish(&first, &[("result-square.md", "4")]);
        f.restart();
        assert!(f.ready().is_empty(), "manual work cannot replace the outstanding worker");
        f.finish(&second, &[("result-square.md", "9"), ("result-extra.md", "16")]);
        let ids = f.tick();
        let collect = f.named(&ids, "collect");
        assert_eq!(f.state.executions[&collect].candidate.inputs["result-*.md"].iter().cloned().collect::<BTreeSet<_>>(),
            f.output_ids(&first).union(&f.output_ids(&second)).cloned().collect());
        assert_eq!(f.numbers(&collect, "result-*.md").iter().sum::<i64>(), 29);
        assert!(f.ready().is_empty());
    }

    #[test]
    fn wildcard_member_delivers_to_exact_single_consumer() {
        use InputMode::Single;
        let mut f = Fixture::new(vec![
            step("seed", &[("ticket.md", Single)], &["request-*.md"]),
            step("selected", &[("request-a.md", Single)], &["answer.md"]),
        ]);
        let ids = f.tick();
        let seed = f.named(&ids, "seed");
        f.finish(&seed, &[("request-a.md", "2"), ("request-b.md", "3")]);
        let candidates = f.ready();
        assert_eq!(candidates.len(), 1, "accepted wildcard members also satisfy exact logical inputs");
        let selected = &candidates[0];
        assert_eq!(selected.step_key, "selected");
        let expected = f.state.occurrences.values().find(|o| o.logical_path == "request-a.md").unwrap();
        assert_eq!(selected.inputs["request-a.md"], [expected.id.clone()]);
    }

    #[test]
    fn narrowed_each_family_closes_through_exact_chained_outputs() {
        use InputMode::{Complete, Each, Single};
        let mut f = Fixture::new(vec![
            step("seed", &[("ticket.md", Single)], &["request-*.md"]),
            step("worker", &[("request-a*.md", Each)], &["work.md"]),
            step("publish", &[("work.md", Single)], &["result-*.md"]),
            step("collect", &[("result-*.md", Complete)], &["answer.md"]),
        ]);
        let ids = f.tick();
        let seed = f.named(&ids, "seed");
        f.finish(&seed, &[("request-a1.md", "2"), ("request-a2.md", "3"), ("request-b.md", "999")]);
        let workers = f.tick();
        assert_eq!(workers.len(), 2);
        for id in &workers {
            let value = f.numbers(id, "request-a*.md")[0];
            f.finish(id, &[("work.md", &value.to_string())]);
        }
        let publishers = f.tick();
        assert_eq!(publishers.len(), 2);
        let first = publishers[0].clone();
        let second = publishers[1].clone();
        let value = f.numbers(&first, "work.md")[0];
        f.finish(&first, &[("result-value.md", &value.to_string())]);
        assert!(f.ready().is_empty(), "a selected but unfinished member still blocks");
        f.restart();
        let value = f.numbers(&second, "work.md")[0];
        f.finish(&second, &[("result-value.md", &value.to_string())]);
        let ready = f.ready();
        assert_eq!(ready.len(), 1, "unmatched source members are not worker obligations");
        assert_eq!(ready[0].step_key, "collect");
        assert_eq!(ready[0].inputs["result-*.md"].iter().cloned().collect::<BTreeSet<_>>(),
            f.output_ids(&first).union(&f.output_ids(&second)).cloned().collect());
    }

    #[test]
    fn each_context_does_not_duplicate_an_exact_single_binding() {
        use InputMode::{Each, Single};
        let mut f = Fixture::new(vec![
            step("seed", &[("ticket.md", Single)], &["request-a.md"]),
            step("each", &[("request-*.md", Each)], &["worker.md"]),
            step("exact", &[("request-a.md", Single)], &["answer.md"]),
        ]);
        let ids = f.tick();
        let seed = f.named(&ids, "seed");
        f.finish(&seed, &[("request-a.md", "2")]);
        let candidates = f.ready();
        let exact: Vec<_> = candidates.iter().filter(|candidate| candidate.step_key == "exact").collect();
        assert_eq!(exact.len(), 1, "a synthetic Member context cannot fork an unchanged exact binding");
        assert_eq!(exact[0].context_id, "root");
        assert_eq!(candidates.iter().filter(|candidate| candidate.step_key == "each").count(), 1);
    }
}
