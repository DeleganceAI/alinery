//! Pure occurrence-driven graph reconciliation. The caller reserves the entire returned
//! batch and reconciles again in the same transaction before launching any owner.
use std::collections::{BTreeMap, BTreeSet};

use crate::execution::{occurrence_deliverable, ArtifactCollection, ContextCause, ExecutionCandidate, ExecutionContext, ExecutionLifecycle, TaskExecutionState};
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
            if seen[node] {
                return;
            }
            seen[node] = true;
            for &next in &edges[node] {
                visit(next, edges, seen, order);
            }
            order.push(node);
        }
        let mut order = Vec::new();
        let mut seen = vec![false; n];
        for node in 0..n {
            visit(node, &edges, &mut seen, &mut order);
        }
        seen.fill(false);
        let mut components = Vec::new();
        for node in order.into_iter().rev() {
            if seen[node] {
                continue;
            }
            let mut members = Vec::new();
            visit(node, &reverse, &mut seen, &mut members);
            if members.len() > 1 || edges[node].contains(&node) {
                components.push(members.into_iter().map(|i| definition.step[i].key.clone()).collect());
            }
        }
        Ok(Self { producers, components })
    }

    fn producers<'a>(&'a self, path: &'a str) -> impl Iterator<Item = &'a str> {
        self.producers.iter().filter(move |(selector, _)| selector.matches(path)).map(|(_, step)| step.as_str())
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

type RoleOccurrences = BTreeMap<String, BTreeSet<String>>;

// Both views are derived once per reconciliation. Full ancestry validates the
// causal graph and identifies changing evidence; the frontier cuts old passes
// and retains the concrete role identities that can constrain a current join.
#[derive(Default)]
struct Provenance {
    ancestors: BTreeMap<String, BTreeSet<String>>,
    frontier: BTreeMap<String, RoleOccurrences>,
    trigger_frontier: BTreeMap<String, (usize, RoleOccurrences)>,
    entries: Vec<BTreeSet<String>>,
}

impl Provenance {
    fn new(state: &TaskExecutionState, graph: &Graph) -> Result<Self, String> {
        let mut result = Self::default();
        let mut active = BTreeSet::new();
        let mut order = Vec::new();
        // An explicit DFS stack bounds traversal by recorded nodes, including
        // malformed cycles, without consuming the process call stack.
        for root in state
            .occurrences
            .keys()
            .chain(state.executions.values().flat_map(|e| e.candidate.inputs.values().flatten()))
            .chain(state.contexts.values().flat_map(|context| context.bindings.values().flatten()))
        {
            let mut pending = vec![(root.as_str(), false)];
            while let Some((id, expanded)) = pending.pop() {
                if result.ancestors.contains_key(id) {
                    continue;
                }
                let occurrence = state.occurrences.get(id).ok_or_else(|| format!("provenance references missing occurrence {id}"))?;
                let producer = occurrence
                    .producer_execution_id
                    .as_ref()
                    .map(|producer| {
                        state
                            .executions
                            .get(producer)
                            .ok_or_else(|| format!("occurrence {id} references missing producer {producer}"))
                    })
                    .transpose()?;
                if expanded {
                    let mut ancestors = BTreeSet::from([id.to_string()]);
                    if let Some(producer) = producer {
                        for input in producer.candidate.inputs.values().flatten() {
                            ancestors.extend(result.ancestors[input].iter().cloned());
                        }
                    }
                    result.ancestors.insert(id.to_string(), ancestors);
                    active.remove(id);
                    order.push(id.to_string());
                } else {
                    if !active.insert(id.to_string()) {
                        return Err(format!("cycle in occurrence provenance at {id}, producer {:?}", occurrence.producer_execution_id));
                    }
                    pending.push((id, true));
                    if let Some(producer) = producer {
                        pending.extend(producer.candidate.inputs.values().flatten().map(|input| (input.as_str(), false)));
                    }
                }
            }
        }
        result.entries = graph.components.iter().map(|component| entry_roles(state, graph, component)).collect();
        let mut publications: BTreeMap<(&str, Option<usize>), RoleOccurrences> = BTreeMap::new();
        for occurrence in state.occurrences.values() {
            if let Some(producer) = &occurrence.producer_execution_id {
                publications
                    .entry((producer, result.reentry(state, graph, &occurrence.id)))
                    .or_default()
                    .entry(occurrence.logical_path.clone())
                    .or_default()
                    .insert(occurrence.id.clone());
            }
        }
        for id in order {
            let occurrence = &state.occurrences[&id];
            let mut roles = RoleOccurrences::new();
            if let Some(producer) = occurrence.producer_execution_id.as_ref().map(|id| &state.executions[id]) {
                for input in producer.candidate.inputs.values().flatten() {
                    for (path, ids) in &result.frontier[input] {
                        roles.entry(path.clone()).or_default().extend(ids.iter().cloned());
                    }
                }
                let boundary = result.reentry(state, graph, &id);
                let published = &publications[&(producer.id.as_str(), boundary)];
                if let Some(index) = boundary {
                    // Pair fresh roles using their originating branch/pass, but
                    // never let historical entry IDs fill a partial fresh set.
                    let mut pairing = roles.clone();
                    pairing.retain(|path, _| !result.entries[index].contains(path));
                    pairing.extend(published.clone());
                    result.trigger_frontier.insert(id.clone(), (index, pairing));
                    for ids in roles.values_mut() {
                        ids.retain(|id| result.invariant(state, &graph.components[index], &result.entries[index], id));
                    }
                    roles.retain(|_, ids| !ids.is_empty());
                }
                // Co-publication is identity evidence only within one routing
                // destination: an old-pass stop retains its consumed design,
                // while a co-published entry request begins the fresh pass.
                roles.extend(published.clone());
            } else {
                roles.insert(occurrence.logical_path.clone(), BTreeSet::from([id.clone()]));
            }
            result.frontier.insert(id, roles);
        }
        Ok(result)
    }

    fn reentry(&self, state: &TaskExecutionState, graph: &Graph, id: &str) -> Option<usize> {
        let occurrence = &state.occurrences[id];
        let producer = state.executions.get(occurrence.producer_execution_id.as_ref()?)?;
        graph
            .components
            .iter()
            .enumerate()
            .position(|(index, component)| component.contains(&producer.candidate.step_key) && self.entries[index].contains(&occurrence.logical_path))
    }

    fn invariant(&self, state: &TaskExecutionState, component: &BTreeSet<String>, entries: &BTreeSet<String>, id: &str) -> bool {
        let occurrence = &state.occurrences[id];
        if occurrence
            .producer_execution_id
            .as_ref()
            .is_some_and(|producer| component.contains(&state.executions[producer].candidate.step_key))
        {
            return false;
        }
        !self.ancestors[id].iter().any(|ancestor| entries.contains(&state.occurrences[ancestor].logical_path))
    }

    fn compatible(&self, left: &str, right: &str) -> bool {
        let (left_roles, right_roles) = match (self.trigger_frontier.get(left), self.trigger_frontier.get(right)) {
            (Some((left_component, left)), Some((right_component, right))) if left_component == right_component => (left, right),
            _ => (&self.frontier[left], &self.frontier[right]),
        };
        // A retained exact companion outranks its old co-publication evidence.
        // Full ancestry cannot do this: fresh loop boundaries cut stale roles.
        left_roles.values().any(|ids| ids.contains(right))
            || right_roles.values().any(|ids| ids.contains(left))
            || left_roles.iter().all(|(role, ids)| right_roles.get(role).is_none_or(|other| !ids.is_disjoint(other)))
    }

    fn compatible_member(&self, companion: &str, member: &str, role: &str, governing_member: Option<&String>) -> bool {
        // Membership is fixed, not a second Single governing role. A local
        // governing publication can replace inherited evidence for descendants
        // of its actual Member scope, but cannot relax other branch identities.
        if self.ancestors[companion].contains(member) {
            return true;
        }
        if governing_member.is_some_and(|scope| self.ancestors[companion].contains(scope) && self.ancestors[member].contains(scope)) {
            return self.frontier[companion]
                .iter()
                .all(|(path, ids)| path == role || self.frontier[member].get(path).is_none_or(|other| !ids.is_disjoint(other)));
        }
        self.compatible(companion, member)
    }
}

fn local_output(state: &TaskExecutionState, context: &str, path: &str) -> bool {
    state.executions.values().any(|e| {
        !e.candidate.manual
            && e.candidate.context_id == context
            && e.outputs
                .iter()
                .any(|output| ArtifactSelector::parse(&output.selector).is_ok_and(|selector| selector.matches(path)))
    })
}

#[derive(Default)]
struct SingleResolution {
    ids: BTreeSet<String>,
    shadowed: bool,
    governing_member: Option<String>,
}

fn visible_singles(state: &TaskExecutionState, graph: &Graph, provenance: &Provenance, context: &str, path: &str) -> Result<SingleResolution, String> {
    let mut next = Some(context);
    let mut visited = BTreeSet::new();
    let mut boundaries = Vec::new();
    while let Some(id) = next {
        if !visited.insert(id) {
            return Err(format!("cycle in context ancestry at {id}"));
        }
        let current = state.contexts.get(id).ok_or_else(|| format!("missing context {id}"))?;
        let local = local_output(state, id, path);
        if let Some(ids) = current.bindings.get(path) {
            return Ok(SingleResolution {
                ids: ids
                    .iter()
                    .filter(|id| {
                        occurrence_deliverable(state, &state.occurrences[*id])
                            && boundaries
                                .iter()
                                .all(|index: &usize| provenance.invariant(state, &graph.components[*index], &provenance.entries[*index], id))
                    })
                    .cloned()
                    .collect(),
                shadowed: local || !boundaries.is_empty(),
                governing_member: if local && boundaries.is_empty() {
                    nearest_member(state, id).map(|(_, _, member)| member.to_string())
                } else {
                    None
                },
            });
        }
        // A known local obligation shadows an older ancestor even before its
        // publication, and acceptance alone still does not deliver the output.
        if local {
            return Ok(SingleResolution {
                shadowed: true,
                ..SingleResolution::default()
            });
        }
        if let ContextCause::Loop { component_steps, .. } = &current.cause {
            if let Some(index) = graph.components.iter().position(|component| component == component_steps) {
                boundaries.push(index);
            }
        }
        next = current.parent_id.as_deref();
    }
    Ok(SingleResolution::default())
}

fn join_error(step: &str, state: &TaskExecutionState, pools: &RoleOccurrences) -> String {
    let references: Vec<_> = pools
        .iter()
        .map(|(role, ids)| {
            let occurrences: Vec<_> = ids
                .iter()
                .map(|id| format!("{id} (producer {})", state.occurrences[id].producer_execution_id.as_deref().unwrap_or("seed")))
                .collect();
            format!("{role}: {}", occurrences.join(", "))
        })
        .collect();
    format!("unsupported ambiguous join for {step}: {}", references.join("; "))
}

fn enumerate_singles(
    step: &str,
    state: &TaskExecutionState,
    provenance: &Provenance,
    pools: &RoleOccurrences,
    fixed: &[String],
    governing_members: &BTreeMap<String, String>,
) -> Result<Vec<BTreeMap<String, Vec<String>>>, String> {
    if pools.values().any(BTreeSet::is_empty) {
        return Ok(Vec::new());
    }
    let Some((anchor_role, anchors)) = pools.iter().max_by_key(|(_, ids)| ids.len()) else {
        return Ok(vec![BTreeMap::new()]);
    };
    let mut results = BTreeSet::new();
    for anchor in anchors {
        if !fixed
            .iter()
            .all(|id| provenance.compatible_member(anchor, id, anchor_role, governing_members.get(anchor_role)))
        {
            continue;
        }
        let mut selected = BTreeMap::from([(anchor_role.clone(), vec![anchor.clone()])]);
        let mut remaining = pools.clone();
        remaining.remove(anchor_role);
        loop {
            for (role, ids) in &mut remaining {
                ids.retain(|id| {
                    fixed.iter().all(|member| provenance.compatible_member(id, member, role, governing_members.get(role)))
                        && selected.values().flatten().all(|other| provenance.compatible(id, other))
                });
            }
            if remaining.values().any(BTreeSet::is_empty) {
                break;
            }
            if remaining.is_empty() {
                results.insert(selected);
                break;
            }
            let Some((role, ids)) = remaining.iter().find(|(_, ids)| ids.len() == 1) else {
                // A missing sibling is not an alternative complete binding.
                // Prune unsupported companions to a fixed point, without
                // enumerating combinations or inventing a pairing policy.
                let mut unsupported = Vec::new();
                for (role, ids) in &remaining {
                    for id in ids {
                        if remaining
                            .iter()
                            .any(|(other_role, others)| role != other_role && !others.iter().any(|other| provenance.compatible(id, other)))
                        {
                            unsupported.push((role.clone(), id.clone()));
                        }
                    }
                }
                if unsupported.is_empty() {
                    return Err(join_error(step, state, pools));
                }
                for (role, id) in unsupported {
                    remaining.get_mut(&role).unwrap().remove(&id);
                }
                continue;
            };
            let role = role.clone();
            let id = ids.first().unwrap().clone();
            remaining.remove(&role);
            selected.insert(role, vec![id]);
        }
    }
    // A Complete input is indivisible. If every member has evidence but no
    // companion agrees with them all, choosing one member would lose ownership.
    if results.is_empty()
        && fixed.len() > 1
        && pools.iter().any(|(role, ids)| {
            fixed
                .iter()
                .all(|member| ids.iter().any(|id| provenance.compatible_member(id, member, role, governing_members.get(role))))
        })
    {
        return Err(join_error(step, state, pools));
    }
    Ok(results.into_iter().collect())
}

fn entry_roles(state: &TaskExecutionState, graph: &Graph, component: &BTreeSet<String>) -> BTreeSet<String> {
    let mut roles = BTreeSet::new();
    for execution in state.executions.values().filter(|e| !e.candidate.manual && component.contains(&e.candidate.step_key)) {
        for (path, ids) in &execution.candidate.inputs {
            if !graph.producers(path).any(|p| component.contains(p)) {
                continue;
            }
            if ids.iter().any(|id| {
                state.occurrences.get(id).is_some_and(|o| {
                    o.producer_execution_id
                        .as_ref()
                        .and_then(|id| state.executions.get(id))
                        .is_none_or(|producer| !component.contains(&producer.candidate.step_key))
                })
            }) {
                roles.insert(path.clone());
            }
        }
    }
    roles
}

fn route_occurrences(state: &mut TaskExecutionState, graph: &Graph, provenance: &Provenance) -> Result<(), String> {
    let mut triggers: BTreeMap<(usize, String), RoleOccurrences> = BTreeMap::new();
    let delivered: Vec<_> = state.occurrences.values().filter(|o| occurrence_deliverable(state, o)).cloned().collect();
    for occurrence in delivered {
        let producer = occurrence.producer_execution_id.as_ref().and_then(|id| state.executions.get(id));
        if producer.is_some_and(|e| e.candidate.manual) {
            continue;
        }
        if let Some(index) = provenance.reentry(state, graph, &occurrence.id) {
            triggers
                .entry((index, occurrence.context_id.clone()))
                .or_default()
                .entry(occurrence.logical_path.clone())
                .or_default()
                .insert(occurrence.id.clone());
        } else {
            let context = state.contexts.get_mut(&occurrence.context_id).ok_or("occurrence has unknown context")?;
            let ids = context.bindings.entry(occurrence.logical_path).or_default();
            if !ids.contains(&occurrence.id) {
                ids.push(occurrence.id);
                ids.sort();
            }
        }
    }
    for ((index, parent), mut pools) in triggers {
        for role in &provenance.entries[index] {
            pools.entry(role.clone()).or_default();
        }
        let consumer = graph.components[index].iter().cloned().collect::<Vec<_>>().join(", ");
        for bindings in enumerate_singles(&consumer, state, provenance, &pools, &[], &BTreeMap::new())? {
            let trigger_occurrences = bindings.values().flatten().cloned().collect::<BTreeSet<_>>();
            let id = identity("loop", &(&graph.components[index], &trigger_occurrences))?;
            state.contexts.entry(id.clone()).or_insert(ExecutionContext {
                id,
                parent_id: Some(parent.clone()),
                cause: ContextCause::Loop {
                    component_steps: graph.components[index].clone(),
                    trigger_occurrences,
                },
                bindings,
            });
        }
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
        if !visited.insert(id) {
            continue;
        }
        let execution = state.executions.get(id).ok_or("unknown collection ancestor")?;
        if execution.candidate.each_collection_id.as_deref() == Some(source_id) {
            let step = definition
                .step
                .iter()
                .find(|step| step.key == execution.candidate.step_key)
                .ok_or("unknown collection ancestor step")?;
            let input = step
                .inputs
                .iter()
                .find(|input| input.mode == InputMode::Each)
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
            let consumed_as_collection = definition
                .step
                .iter()
                .flat_map(|step| &step.inputs)
                .any(|input| input.mode != InputMode::Single && ArtifactSelector::parse(&input.path).is_ok_and(|input| input.overlaps(&selector)));
            if !selector.wildcard && !consumed_as_collection {
                continue;
            }
            let id = identity("output", &(&execution.id, &output.path))?;
            additions.push(ArtifactCollection {
                id,
                context_id: execution.candidate.context_id.clone(),
                selector: output.path.clone(),
                producer_step: step.key.clone(),
                source_collection_id: None,
                expected_execution_ids: BTreeSet::from([execution.id.clone()]),
                member_occurrence_ids: BTreeSet::new(),
                membership_closed: false,
            });
            if let Some((parent, source, _)) = nearest_member(state, &execution.candidate.context_id) {
                let id = identity("family", &(parent, source, &step.key, &output.path))?;
                additions.push(ArtifactCollection {
                    id,
                    context_id: parent.into(),
                    selector: output.path.clone(),
                    producer_step: step.key.clone(),
                    source_collection_id: Some(source.into()),
                    expected_execution_ids: BTreeSet::from([execution.id.clone()]),
                    member_occurrence_ids: BTreeSet::new(),
                    membership_closed: false,
                });
            }
        }
    }
    for addition in additions {
        state
            .collections
            .entry(addition.id.clone())
            .and_modify(|collection| {
                collection.expected_execution_ids.extend(addition.expected_execution_ids.clone());
            })
            .or_insert(addition);
    }
    let memberships: Vec<_> = state
        .collections
        .values()
        .map(|collection| {
            let members = state
                .occurrences
                .values()
                .filter(|occurrence| {
                    occurrence.selector == collection.selector && occurrence.producer_execution_id.as_ref().is_some_and(|id| collection.expected_execution_ids.contains(id))
                })
                .map(|o| o.id.clone())
                .collect::<BTreeSet<_>>();
            (collection.id.clone(), members)
        })
        .collect();
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
            if collection.membership_closed {
                continue;
            }
            if !collection.expected_execution_ids.iter().all(|id| {
                state
                    .executions
                    .get(id)
                    .is_some_and(|e| e.lifecycle == ExecutionLifecycle::Completed && e.shutdown_confirmed && e.receipt_id.is_some())
            }) {
                continue;
            }
            if let Some(source_id) = &collection.source_collection_id {
                let source = state.collections.get(source_id).ok_or("unknown source collection")?;
                if !source.membership_closed {
                    continue;
                }
                let selectors = initiating_each_selectors(definition, state, collection, source_id)?;
                let represented: BTreeSet<_> = collection
                    .expected_execution_ids
                    .iter()
                    .filter_map(|id| {
                        let execution = state.executions.get(id)?;
                        let (_, source, member) = nearest_member(state, &execution.candidate.context_id)?;
                        (source == source_id).then_some(member)
                    })
                    .collect();
                let mut missing = false;
                for id in &source.member_occurrence_ids {
                    let occurrence = state.occurrences.get(id).ok_or("unknown source collection member")?;
                    if selectors.iter().all(|selector| selector.matches(&occurrence.logical_path)) && !represented.contains(id.as_str()) {
                        missing = true;
                        break;
                    }
                }
                if missing {
                    continue;
                }
            }
            closable.push(collection.id.clone());
        }
        if closable.is_empty() {
            break;
        }
        for id in closable {
            state.collections.get_mut(&id).ok_or("missing closing collection")?.membership_closed = true;
        }
    }
    Ok(())
}

fn bind_singles(step: &NormalizedStep, state: &TaskExecutionState, graph: &Graph, provenance: &Provenance, base: ExecutionCandidate) -> Result<Vec<ExecutionCandidate>, String> {
    let fixed: Vec<_> = base.inputs.values().flatten().cloned().collect();
    let mut pools = BTreeMap::new();
    let mut governing_members = BTreeMap::new();
    for input in step.inputs.iter().filter(|i| i.mode == InputMode::Single) {
        let mut resolved = visible_singles(state, graph, provenance, &base.context_id, &input.path)?;
        // Collection members can carry companions in their own Member context,
        // while Complete remains placed at the family's governing context.
        if !resolved.shadowed {
            for member in &fixed {
                if let Some(companions) = provenance.frontier[member].get(&input.path) {
                    resolved
                        .ids
                        .extend(companions.iter().filter(|id| occurrence_deliverable(state, &state.occurrences[*id])).cloned());
                }
            }
        }
        if let Some(member) = resolved.governing_member {
            governing_members.insert(input.path.clone(), member);
        }
        pools.insert(input.path.clone(), resolved.ids);
    }
    enumerate_singles(&step.key, state, provenance, &pools, &fixed, &governing_members).map(|maps| {
        maps.into_iter()
            .map(|inputs| {
                let mut binding = base.clone();
                binding.inputs.extend(inputs);
                binding
            })
            .collect()
    })
}

fn candidate(step: &NormalizedStep, context: &str) -> ExecutionCandidate {
    ExecutionCandidate {
        step_key: step.key.clone(),
        context_id: context.into(),
        inputs: BTreeMap::new(),
        complete_collection_id: None,
        each_collection_id: None,
        each_member_id: None,
        manual: false,
    }
}

/// Reconcile only recorded occurrences and contexts. Files, timestamps, session
/// mirrors, and manual executions cannot make an ordinary binding eligible.
/// Reserve every candidate, then call again before committing or launching: this
/// records the entire expected worker set even when capacity allows only one owner.
pub fn reconcile_graph(definition: &NormalizedPlaybook, state: &mut TaskExecutionState) -> Result<Vec<ExecutionCandidate>, String> {
    if state.creation != "ready" {
        return Ok(Vec::new());
    }
    let graph = Graph::new(definition)?;
    let provenance = Provenance::new(state, &graph)?;
    route_occurrences(state, &graph, &provenance)?;
    configure_collections(definition, state)?;
    let mut candidates = BTreeMap::new();
    for step in &definition.step {
        if let Some(input) = step.inputs.iter().find(|i| i.mode != InputMode::Single) {
            let selector = ArtifactSelector::parse(&input.path)?;
            let collections: Vec<_> = state
                .collections
                .values()
                .filter(|collection| collection.membership_closed && ArtifactSelector::parse(&collection.selector).is_ok_and(|s| selector.overlaps(&s)))
                .cloned()
                .collect();
            for collection in collections {
                if input.mode == InputMode::Each {
                    // Local producer batches preserve nested member ancestry.
                    if collection.source_collection_id.is_some() {
                        continue;
                    }
                    for member in &collection.member_occurrence_ids {
                        let occurrence = state.occurrences.get(member).ok_or("unknown collection member")?;
                        if !selector.matches(&occurrence.logical_path) {
                            continue;
                        }
                        let id = identity("member", &(&collection.id, member))?;
                        state.contexts.entry(id.clone()).or_insert(ExecutionContext {
                            id: id.clone(),
                            parent_id: Some(collection.context_id.clone()),
                            cause: ContextCause::Member {
                                collection_id: collection.id.clone(),
                                occurrence_id: member.clone(),
                            },
                            bindings: BTreeMap::from([(occurrence.logical_path.clone(), vec![member.clone()])]),
                        });
                        let mut binding = candidate(step, &id);
                        binding.each_collection_id = Some(collection.id.clone());
                        binding.each_member_id = Some(member.clone());
                        binding.inputs.insert(input.path.clone(), vec![member.clone()]);
                        for binding in bind_singles(step, state, &graph, &provenance, binding)? {
                            candidates.insert(binding.binding_key()?, binding);
                        }
                    }
                } else {
                    // An each worker's local subset is not a complete family.
                    if collection.source_collection_id.is_none()
                        && collection
                            .expected_execution_ids
                            .iter()
                            .any(|id| state.executions.get(id).is_some_and(|e| nearest_member(state, &e.candidate.context_id).is_some()))
                    {
                        continue;
                    }
                    let members: Vec<_> = collection
                        .member_occurrence_ids
                        .iter()
                        .filter(|id| state.occurrences.get(*id).is_some_and(|o| selector.matches(&o.logical_path)))
                        .cloned()
                        .collect();
                    if members.is_empty() {
                        continue;
                    }
                    let mut binding = candidate(step, &collection.context_id);
                    binding.complete_collection_id = Some(collection.id.clone());
                    binding.inputs.insert(input.path.clone(), members);
                    for binding in bind_singles(step, state, &graph, &provenance, binding)? {
                        candidates.insert(binding.binding_key()?, binding);
                    }
                }
            }
        } else {
            for context in state.contexts.values() {
                if step.inputs.is_empty() && !matches!(context.cause, ContextCause::Root) {
                    continue;
                }
                for binding in bind_singles(step, state, &graph, &provenance, candidate(step, &context.id))? {
                    // Inheritance supplies governing context, not new ordinary
                    // activations with unchanged inputs in every Member context.
                    if !step.inputs.is_empty()
                        && !binding.inputs.values().flatten().any(|id| {
                            state.occurrences.get(id).is_some_and(|o| o.context_id == context.id)
                                || matches!(&context.cause, ContextCause::Loop { trigger_occurrences, .. } if trigger_occurrences.contains(id))
                        })
                    {
                        continue;
                    }
                    candidates.insert(binding.binding_key()?, binding);
                }
            }
        }
    }
    for execution in state.executions.values().filter(|e| !e.candidate.manual) {
        candidates.remove(&execution.binding_key);
    }
    Ok(candidates.into_values().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::execution::{
        accept_execution_completion, claim_execution_launch, confirm_execution_exit, grant_execution_completion, install_seed, new_execution_state, record_execution_spawn,
        recover_execution_owner, request_execution_start, reserve_execution, CompletionOutcome, LaunchChoices,
    };
    use crate::playbook::{parse_playbook_md, render_playbook_md, InputSelector, OutputSelector, PlaybookRef, PlaybookScope};
    use std::path::PathBuf;

    fn step(key: &str, inputs: &[(&str, InputMode)], outputs: &[&str]) -> NormalizedStep {
        NormalizedStep {
            key: key.into(),
            title: key.into(),
            short: String::new(),
            is_coding_step: false,
            auto_advance_default: true,
            inputs: inputs
                .iter()
                .map(|(path, mode)| InputSelector {
                    path: (*path).into(),
                    mode: *mode,
                })
                .collect(),
            outputs: outputs.iter().map(|path| OutputSelector { path: (*path).into() }).collect(),
            model: String::new(),
            harness: String::new(),
            prompt: "Write the assigned output.\n".into(),
        }
    }

    struct Fixture {
        repo: PathBuf,
        definition: NormalizedPlaybook,
        state: TaskExecutionState,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.repo);
        }
    }

    impl Fixture {
        fn new(steps: Vec<NormalizedStep>) -> Self {
            let source = render_playbook_md(&NormalizedPlaybook {
                version: 2,
                key: "graph".into(),
                title: "Graph".into(),
                description: String::new(),
                default_model: String::new(),
                default_harness: "omp".into(),
                section_order: steps.iter().map(|s| s.key.clone()).collect(),
                step: steps,
                preamble: String::new(),
            });
            let definition = parse_playbook_md(&source).unwrap();
            let mut state = new_execution_state(
                PlaybookRef {
                    scope: PlaybookScope::Repo,
                    key: "graph".into(),
                },
                &source,
                "test-lane".into(),
                10,
                definition.step.iter().map(|s| s.key.clone()).collect(),
                LaunchChoices::default(),
            )
            .unwrap();
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
            reserve_execution(&self.repo, "task", &self.definition, &mut self.state, candidate, &LaunchChoices::default(), None, true).unwrap()
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
                let assignment = self.state.executions[id]
                    .outputs
                    .iter()
                    .find(|output| ArtifactSelector::parse(&output.selector).unwrap().matches(logical))
                    .unwrap();
                let physical = if let Some((prefix, suffix)) = assignment.selector.split_once('*') {
                    let member = &logical[prefix.len()..logical.len() - suffix.len()];
                    assignment.relative_path.replace('*', member)
                } else {
                    assignment.relative_path.clone()
                };
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
            self.state.executions[id].candidate.inputs[selector]
                .iter()
                .flat_map(|id| {
                    std::fs::read_to_string(crate::artifacts_dir(&self.repo, "task").join(&self.state.occurrences[id].relative_path))
                        .unwrap()
                        .split_whitespace()
                        .map(|n| n.parse::<i64>().unwrap())
                        .collect::<Vec<_>>()
                })
                .collect()
        }

        fn output_ids(&self, id: &str) -> BTreeSet<String> {
            self.state
                .occurrences
                .values()
                .filter(|o| o.producer_execution_id.as_deref() == Some(id))
                .map(|o| o.id.clone())
                .collect()
        }

        fn output(&self, producer: &str, role: &str) -> String {
            self.output_ids(producer).into_iter().find(|id| self.state.occurrences[id].logical_path == role).unwrap()
        }

        fn bound(&mut self, key: &str, context: &str, inputs: &[(&str, &str)]) -> String {
            let step = self.definition.step.iter().find(|step| step.key == key).unwrap();
            let mut binding = candidate(step, context);
            binding.inputs = inputs.iter().map(|(path, id)| ((*path).into(), vec![(*id).into()])).collect();
            self.reserve(binding)
        }

        fn restart(&mut self) {
            self.state = serde_json::from_slice(&serde_json::to_vec(&self.state).unwrap()).unwrap();
        }
    }

    #[test]
    fn shared_exact_requests_bind_independently() {
        use InputMode::Single;
        for reverse_declarations in [false, true] {
            for reverse_completion in [false, true] {
                for staggered in [false, true] {
                    let mut steps = vec![
                        step("checker", &[("ticket.md", Single)], &["request.md"]),
                        step("synthesis", &[("ticket.md", Single)], &["request.md"]),
                        step("later", &[("ticket.md", Single)], &["request.md"]),
                        step("designer", &[("request.md", Single), ("brief.md", Single)], &["design.md"]),
                    ];
                    if reverse_declarations {
                        steps.reverse();
                    }
                    let mut f = Fixture::new(steps);
                    let brief = f.seed("brief.md", "brief.md", "governing brief");
                    let roots = f.tick();
                    let mut publishers = [f.named(&roots, "checker"), f.named(&roots, "synthesis")];
                    if reverse_completion {
                        publishers.reverse();
                    }
                    let mut designers = Vec::new();
                    for publisher in &publishers {
                        f.finish(publisher, &[("request.md", "identical request")]);
                        if staggered {
                            designers.extend(f.tick());
                            let request = f.output_ids(publisher).into_iter().next().unwrap();
                            assert!(designers.iter().any(|id| f.state.executions[id].candidate.inputs["request.md"] == [request.clone()]));
                        }
                    }
                    designers.extend(f.tick());
                    let expected: BTreeSet<_> = publishers
                        .iter()
                        .map(|id| {
                            BTreeMap::from([
                                ("request.md".into(), f.output_ids(id).into_iter().collect::<Vec<_>>()),
                                ("brief.md".into(), vec![brief.clone()]),
                            ])
                        })
                        .collect();
                    assert_eq!(
                        designers.iter().map(|id| f.state.executions[id].candidate.inputs.clone()).collect::<BTreeSet<_>>(),
                        expected,
                        "each accepted occurrence must receive its own complete Single binding"
                    );
                    let paths: BTreeSet<_> = designers.iter().map(|id| f.state.executions[id].outputs[0].relative_path.clone()).collect();
                    assert_eq!(paths.len(), 2, "independent continuations cannot overwrite each other");
                    for id in &designers {
                        assert!(f.state.executions[id].candidate.inputs.values().all(|ids| ids.len() == 1));
                        f.finish(id, &[("design.md", "design")]);
                    }
                    f.restart();
                    assert!(f.tick().is_empty(), "handled bindings must not replay");
                    let later = f.named(&roots, "later");
                    f.finish(&later, &[("request.md", "identical request")]);
                    let next = f.tick();
                    assert_eq!(next.len(), 1);
                    assert_eq!(
                        f.state.executions[&next[0]].candidate.inputs["request.md"],
                        f.output_ids(&later).into_iter().collect::<Vec<_>>()
                    );
                    assert!(!paths.contains(&f.state.executions[&next[0]].outputs[0].relative_path));
                    f.restart();
                    assert!(f.tick().is_empty());
                }
            }
        }
    }

    #[test]
    fn shared_exact_companions_follow_request_lineage() {
        use InputMode::Single;
        let mut f = Fixture::new(vec![
            step("first", &[("ticket.md", Single)], &["request.md", "brief.md"]),
            step("second", &[("ticket.md", Single)], &["request.md", "brief.md"]),
            step("designer", &[("request.md", Single), ("brief.md", Single)], &["design.md"]),
            step("plan", &[("design.md", Single)], &["plan.md"]),
            step("check", &[("design.md", Single)], &["check.md"]),
            step("side", &[("design.md", Single)], &["side.md"]),
            step("join", &[("plan.md", Single), ("check.md", Single), ("side.md", Single)], &["answer.md"]),
        ]);
        let roots = f.tick();
        let publishers = [f.named(&roots, "first"), f.named(&roots, "second")];
        for id in &publishers {
            f.finish(id, &[("request.md", "same"), ("brief.md", "same")]);
        }
        let designers = f.tick();
        let expected: BTreeSet<_> = publishers.iter().map(|id| f.output_ids(id)).collect();
        assert_eq!(
            designers
                .iter()
                .map(|id| f.state.executions[id].candidate.inputs.values().flatten().cloned().collect::<BTreeSet<_>>())
                .collect::<BTreeSet<_>>(),
            expected,
            "co-published pairs must not cross"
        );
        let mut joins = Vec::new();
        for designer in &designers {
            f.finish(designer, &[("design.md", "design")]);
        }
        let siblings = f.tick();
        for designer in designers.iter().rev() {
            let design = f.output_ids(designer).into_iter().next().unwrap();
            let own: Vec<_> = siblings
                .iter()
                .filter(|id| f.state.executions[*id].candidate.inputs["design.md"] == [design.clone()])
                .cloned()
                .collect();
            let plan = f.named(&own, "plan");
            let check = f.named(&own, "check");
            let side = f.named(&own, "side");
            f.finish(&plan, &[("plan.md", "plan")]);
            assert!(f.tick().is_empty(), "a missing sibling cannot come from the other request");
            f.finish(&check, &[("check.md", "check")]);
            assert!(f.tick().is_empty(), "the other request's changing side output is not a companion");
            f.finish(&side, &[("side.md", "side")]);
            let ready = f.tick();
            assert_eq!(ready.len(), 1);
            assert_eq!(
                f.state.executions[&ready[0]].candidate.inputs.values().flatten().cloned().collect::<BTreeSet<_>>(),
                [&plan, &check, &side].into_iter().flat_map(|id| f.output_ids(id)).collect()
            );
            joins.extend(ready);
        }
        assert_eq!(joins.len(), 2);
        f.restart();
        assert!(f.tick().is_empty());
    }

    #[test]
    fn shared_exact_missing_companion_waits() {
        use InputMode::Single;
        let mut f = Fixture::new(vec![
            step("first", &[("ticket.md", Single)], &["request.md"]),
            step("second", &[("ticket.md", Single)], &["request.md"]),
            step("brief", &[("ticket.md", Single)], &["brief.md"]),
            step("designer", &[("request.md", Single), ("brief.md", Single)], &["design.md"]),
        ]);
        let roots = f.tick();
        let first = f.named(&roots, "first");
        f.finish(&first, &[("request.md", "same")]);
        assert!(f.tick().is_empty(), "request alone cannot satisfy AND");
        let brief = f.named(&roots, "brief");
        f.start(&brief);
        f.write(&brief, &[("brief.md", "governing brief")]);
        assert!(matches!(f.accept(&brief), CompletionOutcome::Accepted { .. }));
        assert!(f.tick().is_empty(), "accepted-but-live is not deliverable");
        f.exit(&brief);
        let first_design = f.tick();
        assert_eq!(first_design.len(), 1, "do not wait for a hypothetical alternative request");
        assert_eq!(
            f.state.executions[&first_design[0]].candidate.inputs["request.md"],
            f.output_ids(&first).into_iter().collect::<Vec<_>>()
        );
        let second = f.named(&roots, "second");
        f.finish(&second, &[("request.md", "same")]);
        let second_design = f.tick();
        assert_eq!(second_design.len(), 1, "the later request remains eligible");
        assert_eq!(
            f.state.executions[&second_design[0]].candidate.inputs["request.md"],
            f.output_ids(&second).into_iter().collect::<Vec<_>>()
        );
        assert_eq!(
            f.state.executions[&second_design[0]].candidate.inputs["brief.md"],
            f.output_ids(&brief).into_iter().collect::<Vec<_>>()
        );
    }

    #[test]
    fn shared_exact_uncorrelated_join_reports_problem() {
        use InputMode::Single;
        let mut f = Fixture::new(vec![
            step("request-one", &[("ticket.md", Single)], &["request.md"]),
            step("request-two", &[("ticket.md", Single)], &["request.md"]),
            step("brief-one", &[("ticket.md", Single)], &["brief.md"]),
            step("brief-two", &[("ticket.md", Single)], &["brief.md"]),
            step("designer", &[("request.md", Single), ("brief.md", Single)], &["design.md"]),
        ]);
        let roots = f.tick();
        for id in &roots {
            let role = f.state.executions[id].outputs[0].selector.clone();
            f.finish(id, &[(&role, "independent alternative")]);
        }
        let records = f.state.executions.clone();
        let occurrences = f.state.occurrences.clone();
        let error = reconcile_graph(&f.definition, &mut f.state).expect_err("independent alternatives are a playbook problem, not indefinite waiting");
        for reference in ["designer", "request.md", "brief.md"] {
            assert!(error.contains(reference), "{error}");
        }
        for id in &roots {
            assert!(error.contains(id), "missing conflicting producer {id}: {error}");
            for occurrence in f.output_ids(id) {
                assert!(error.contains(&occurrence), "missing conflicting occurrence {occurrence}: {error}");
            }
        }
        assert_eq!(f.state.executions, records, "diagnosing a malformed join must not rewrite earlier work");
        assert_eq!(f.state.occurrences, occurrences);
    }

    #[test]
    fn shared_exact_loop_requests_create_distinct_activations() {
        use InputMode::Single;
        for internal_first in [false, true] {
            for simultaneous in [false, true] {
                let mut steps = vec![
                    step("clarifier", &[("ticket.md", Single)], &["request.md"]),
                    step("designer", &[("request.md", Single), ("brief.md", Single)], &["design.md"]),
                    step("checker", &[("design.md", Single)], &["request.md", "stop.md"]),
                    step("synthesis", &[("stop.md", Single)], &["request.md"]),
                ];
                if internal_first {
                    steps.swap(0, 2);
                }
                let mut f = Fixture::new(steps);
                let brief = f.seed("brief.md", "brief.md", "invariant");
                for (key, role) in [("clarifier", "request.md"), ("designer", "design.md")] {
                    let ids = f.tick();
                    let id = f.named(&ids, key);
                    f.finish(&id, &[(role, "same")]);
                }
                let ids = f.tick();
                let checker = f.named(&ids, "checker");
                f.finish(&checker, &[("request.md", "same"), ("stop.md", "stop")]);
                let stop = f.output_ids(&checker).into_iter().find(|id| f.state.occurrences[id].logical_path == "stop.md").unwrap();
                let mut designers = Vec::new();
                let synthesis = if simultaneous {
                    // Reserve a valid stop binding without routing the first request yet.
                    f.reserve(ExecutionCandidate {
                        step_key: "synthesis".into(),
                        context_id: f.state.occurrences[&stop].context_id.clone(),
                        inputs: BTreeMap::from([("stop.md".into(), vec![stop])]),
                        complete_collection_id: None,
                        each_collection_id: None,
                        each_member_id: None,
                        manual: false,
                    })
                } else {
                    let ids = f.tick();
                    designers.extend(ids.iter().filter(|id| f.state.executions[*id].candidate.step_key == "designer").cloned());
                    f.named(&ids, "synthesis")
                };
                f.finish(&synthesis, &[("request.md", "same")]);
                designers.extend(f.tick().into_iter().filter(|id| f.state.executions[id].candidate.step_key == "designer"));
                let requests: BTreeSet<_> = [&checker, &synthesis]
                    .into_iter()
                    .flat_map(|id| f.output_ids(id))
                    .filter(|id| f.state.occurrences[id].logical_path == "request.md")
                    .collect();
                assert_eq!(
                    designers
                        .iter()
                        .flat_map(|id| f.state.executions[id].candidate.inputs["request.md"].clone())
                        .collect::<BTreeSet<_>>(),
                    requests,
                    "each continuation request must enter the loop"
                );
                let mut contexts = BTreeSet::new();
                let mut paths = BTreeSet::new();
                for id in &designers {
                    let record = &f.state.executions[id];
                    assert_eq!(record.candidate.inputs["brief.md"], std::slice::from_ref(&brief));
                    let ContextCause::Loop { trigger_occurrences, .. } = &f.state.contexts[&record.candidate.context_id].cause else {
                        panic!("continuation must have a loop activation");
                    };
                    assert_eq!(*trigger_occurrences, record.candidate.inputs["request.md"].iter().cloned().collect());
                    contexts.insert(record.candidate.context_id.clone());
                    paths.insert(record.outputs[0].relative_path.clone());
                }
                assert_eq!(contexts.len(), 2);
                assert_eq!(paths.len(), 2);
                f.restart();
                assert!(f.tick().is_empty());
            }
        }
    }

    #[test]
    fn shared_exact_explicit_companions_follow_consumed_briefs() {
        use InputMode::Single;
        let mut f = Fixture::new(vec![
            step("brief-one", &[("ticket.md", Single)], &["brief.md"]),
            step("brief-two", &[("ticket.md", Single)], &["brief.md"]),
            step("request", &[("brief.md", Single)], &["request.md"]),
            step("other-request", &[("absent.md", Single)], &["request.md"]),
            step("designer", &[("request.md", Single), ("brief.md", Single)], &["design.md"]),
        ]);
        let roots = f.tick();
        let mut expected = BTreeSet::new();
        for root in roots {
            f.finish(&root, &[("brief.md", "own brief")]);
            let brief = f.output(&root, "brief.md");
            let request = f.bound("request", "root", &[("brief.md", &brief)]);
            f.finish(&request, &[("request.md", "same")]);
            expected.insert(BTreeMap::from([
                ("request.md".into(), vec![f.output(&request, "request.md")]),
                ("brief.md".into(), vec![brief]),
            ]));
        }
        let ready = f.tick();
        assert_eq!(ready.iter().map(|id| f.state.executions[id].candidate.inputs.clone()).collect::<BTreeSet<_>>(), expected);
        f.restart();
        assert!(f.tick().is_empty());
    }

    #[test]
    fn shared_exact_member_inheritance_does_not_replay() {
        use InputMode::{Each, Single};
        let mut f = Fixture::new(vec![
            step("one", &[("ticket.md", Single)], &["request-a.md"]),
            step("two", &[("ticket.md", Single)], &["request-a.md"]),
            step("each", &[("request-*.md", Each)], &["worker.md"]),
            step("exact", &[("request-a.md", Single), ("brief.md", Single)], &["answer.md"]),
        ]);
        let brief = f.seed("brief.md", "brief.md", "invariant");
        let roots = f.tick();
        for root in &roots {
            f.finish(root, &[("request-a.md", "same")]);
        }
        let ready = f.tick();
        let exact: Vec<_> = ready.iter().filter(|id| f.state.executions[*id].candidate.step_key == "exact").collect();
        assert_eq!(
            exact.iter().map(|id| f.state.executions[*id].candidate.inputs.clone()).collect::<BTreeSet<_>>(),
            roots
                .iter()
                .map(|root| BTreeMap::from([("request-a.md".into(), vec![f.output(root, "request-a.md")]), ("brief.md".into(), vec![brief.clone()]),]))
                .collect()
        );
        assert!(exact.iter().all(|id| f.state.executions[*id].candidate.context_id == "root"));
        assert_eq!(ready.iter().filter(|id| f.state.executions[*id].candidate.step_key == "each").count(), 2);
        f.restart();
        assert!(f.tick().is_empty());
    }

    #[test]
    fn shared_exact_local_missing_and_live_companion_shadows_ancestor() {
        use InputMode::{Each, Single};
        let mut f = Fixture::new(vec![
            step("source", &[("ticket.md", Single)], &["items/*.md"]),
            step("request", &[("items/*.md", Each)], &["request.md"]),
            step("brief", &[("items/*.md", Each)], &["brief.md"]),
            step("other-request", &[("absent.md", Single)], &["request.md"]),
            step("designer", &[("request.md", Single), ("brief.md", Single)], &["design.md"]),
        ]);
        let old = f.seed("brief.md", "old-brief.md", "old governing brief");
        let roots = f.tick();
        f.finish(&roots[0], &[("items/a.md", "one")]);
        let workers = f.tick();
        let request = f.named(&workers, "request");
        let brief = f.named(&workers, "brief");
        f.finish(&request, &[("request.md", "fresh")]);
        assert!(f.tick().is_empty(), "a reserved local companion shadows the ancestor before publication");
        f.start(&brief);
        f.write(&brief, &[("brief.md", "fresh")]);
        assert!(matches!(f.accept(&brief), CompletionOutcome::Accepted { .. }));
        assert!(f.tick().is_empty(), "a live local publication cannot expose the old ancestor");
        f.exit(&brief);
        let ready = f.tick();
        assert_eq!(ready.len(), 1);
        assert_eq!(
            f.state.executions[&ready[0]].candidate.inputs,
            BTreeMap::from([
                ("request.md".into(), vec![f.output(&request, "request.md")]),
                ("brief.md".into(), vec![f.output(&brief, "brief.md")]),
            ])
        );
        assert!(!f.state.executions[&ready[0]].candidate.inputs["brief.md"].contains(&old));
    }

    #[test]
    fn shared_exact_delayed_ambiguity_preserves_committed_history() {
        use InputMode::Single;
        let mut f = Fixture::new(vec![
            step("request-one", &[("ticket.md", Single)], &["request.md"]),
            step("request-two", &[("ticket.md", Single)], &["request.md"]),
            step("brief-two", &[("ticket.md", Single)], &["brief.md"]),
            step("designer", &[("request.md", Single), ("brief.md", Single)], &["design.md"]),
        ]);
        let seed = f.seed("brief.md", "seed-brief.md", "first brief");
        let roots = f.tick();
        let first = f.named(&roots, "request-one");
        f.finish(&first, &[("request.md", "first")]);
        let ready = f.tick();
        let designer = f.named(&ready, "designer");
        f.finish(&designer, &[("design.md", "committed")]);
        for key in ["request-two", "brief-two"] {
            let id = f.named(&roots, key);
            let role = f.state.executions[&id].outputs[0].selector.clone();
            f.finish(&id, &[(&role, "independent")]);
        }
        let executions = f.state.executions.clone();
        let occurrences = f.state.occurrences.clone();
        let error = reconcile_graph(&f.definition, &mut f.state).expect_err("late ambiguity must be diagnosed");
        for reference in ["designer", "request.md", "brief.md", "seed", &seed] {
            assert!(error.contains(reference), "{error}");
        }
        for root in &roots {
            assert!(error.contains(root), "{error}");
            for id in f.output_ids(root) {
                assert!(error.contains(&id), "{error}");
            }
        }
        assert_eq!(f.state.executions, executions, "committed records, including immutable receipt IDs, are unchanged");
        assert_eq!(f.state.occurrences, occurrences);
    }

    #[test]
    fn shared_exact_corrupt_provenance_reports_error() {
        use InputMode::Single;
        for corruption in ["producer", "input", "cycle", "context-binding"] {
            let mut f = Fixture::new(vec![
                step("one", &[("ticket.md", Single)], &["request.md"]),
                step("two", &[("absent.md", Single)], &["request.md"]),
                step("designer", &[("request.md", Single)], &["design.md"]),
            ]);
            let roots = f.tick();
            let root = f.named(&roots, "one");
            f.finish(&root, &[("request.md", "valid publication")]);
            let request = f.output(&root, "request.md");
            let reference = match corruption {
                "producer" => {
                    f.state.occurrences.get_mut(&request).unwrap().producer_execution_id = Some("missing-producer".into());
                    "missing-producer".to_string()
                }
                "input" => {
                    f.state
                        .executions
                        .get_mut(&root)
                        .unwrap()
                        .candidate
                        .inputs
                        .insert("ticket.md".into(), vec!["missing-input".into()]);
                    "missing-input".to_string()
                }
                "context-binding" => {
                    f.state
                        .contexts
                        .get_mut("root")
                        .unwrap()
                        .bindings
                        .insert("request.md".into(), vec!["missing-context-occurrence".into()]);
                    "missing-context-occurrence".to_string()
                }
                _ => {
                    f.state
                        .executions
                        .get_mut(&root)
                        .unwrap()
                        .candidate
                        .inputs
                        .insert("ticket.md".into(), vec![request.clone()]);
                    request
                }
            };
            let error = reconcile_graph(&f.definition, &mut f.state).expect_err("corrupt causal references must terminate with an error");
            assert!(error.contains(&reference), "{corruption}: {error}");
        }
    }

    #[test]
    fn shared_exact_compound_entry_requires_fresh_set() {
        use InputMode::Single;
        for separate in [false, true] {
            for partial in [false, true] {
                let mut f = Fixture::new(vec![
                    step("initial", &[("ticket.md", Single)], &["request.md", "direction.md"]),
                    step("designer", &[("request.md", Single), ("direction.md", Single)], &["design.md"]),
                    step("continue", &[("design.md", Single)], &["request.md", "direction.md", "stop.md"]),
                    step("direction", &[("design.md", Single)], &["direction.md", "stop-direction.md"]),
                ]);
                let roots = f.tick();
                f.finish(&roots[0], &[("request.md", "initial"), ("direction.md", "initial")]);
                let ids = f.tick();
                let designer = f.named(&ids, "designer");
                f.finish(&designer, &[("design.md", "pass")]);
                let ids = f.tick();
                let continuation = f.named(&ids, "continue");
                let direction = f.named(&ids, "direction");
                let outputs = if !partial && !separate {
                    vec![("request.md", "fresh"), ("direction.md", "fresh"), ("stop.md", "meaningful stop")]
                } else {
                    vec![("request.md", "fresh"), ("stop.md", "meaningful stop")]
                };
                f.finish(&continuation, &outputs);
                if separate && !partial {
                    assert!(f.tick().is_empty(), "fresh request alone cannot borrow the old direction");
                    f.finish(&direction, &[("direction.md", "fresh")]);
                } else {
                    f.finish(&direction, &[("stop-direction.md", "no direction")]);
                }
                let accepted = f.output_ids(&continuation);
                let receipt = f.accept(&continuation);
                let ready = f.tick();
                let expected: BTreeSet<_> = [&continuation, &direction]
                    .into_iter()
                    .flat_map(|id| f.output_ids(id))
                    .filter(|id| matches!(f.state.occurrences[id].logical_path.as_str(), "request.md" | "direction.md"))
                    .collect();
                if partial {
                    assert!(ready.is_empty());
                    assert!(!f.state.contexts.values().any(|context| matches!(context.cause, ContextCause::Loop { .. })));
                } else {
                    assert_eq!(ready.len(), 1);
                    let next = &f.state.executions[&ready[0]].candidate;
                    assert_eq!(next.inputs.values().flatten().cloned().collect::<BTreeSet<_>>(), expected);
                    let ContextCause::Loop { trigger_occurrences, .. } = &f.state.contexts[&next.context_id].cause else {
                        panic!("fresh compound activation")
                    };
                    assert_eq!(trigger_occurrences, &expected);
                }
                f.write(&continuation, &[("direction.md", "late cannot expand receipt")]);
                f.restart();
                assert_eq!(f.accept(&continuation), receipt);
                assert_eq!(f.output_ids(&continuation), accepted);
                assert!(f.tick().is_empty());
            }
        }
    }

    #[test]
    fn shared_exact_compound_unrelated_alternatives_error() {
        use InputMode::Single;
        let mut f = Fixture::new(vec![
            step("initial", &[("ticket.md", Single)], &["request.md", "direction.md"]),
            step("designer", &[("request.md", Single), ("direction.md", Single)], &["design.md"]),
            step("request-one", &[("design.md", Single)], &["request.md"]),
            step("request-two", &[("design.md", Single)], &["request.md"]),
            step("direction-one", &[("design.md", Single)], &["direction.md"]),
            step("direction-two", &[("design.md", Single)], &["direction.md"]),
        ]);
        let roots = f.tick();
        f.finish(&roots[0], &[("request.md", "initial"), ("direction.md", "initial")]);
        let ids = f.tick();
        let designer = f.named(&ids, "designer");
        f.finish(&designer, &[("design.md", "pass")]);
        let ids = f.tick();
        // All alternatives share only this prior pass; no request identifies a direction.
        for id in &ids {
            let role = f.state.executions[id].outputs[0].selector.clone();
            f.finish(id, &[(&role, "independent alternative")]);
        }
        let error = reconcile_graph(&f.definition, &mut f.state).expect_err("a common previous pass does not pair alternatives");
        for reference in ["designer", "request.md", "direction.md"] {
            assert!(error.contains(reference), "{error}");
        }
        for id in &ids {
            assert!(error.contains(id), "{error}");
        }
    }

    #[test]
    fn shared_exact_loop_companions_are_fresh() {
        use InputMode::Single;
        for internal_first in [false, true] {
            let mut steps = vec![
                step("initial", &[("ticket.md", Single)], &["request.md"]),
                step("governing", &[("ticket.md", Single)], &["governing.md"]),
                step("designer", &[("request.md", Single), ("policy.md", Single), ("governing.md", Single)], &["design.md"]),
                step("checker", &[("design.md", Single), ("governing.md", Single)], &["request.md", "side.md", "stop.md"]),
                step("side", &[("request.md", Single)], &["side.md"]),
                step("join", &[("design.md", Single), ("side.md", Single)], &["answer.md"]),
            ];
            if internal_first {
                steps.swap(0, 3);
            }
            let mut f = Fixture::new(steps);
            let policy = f.seed("policy.md", "policy.md", "invariant");
            let roots = f.tick();
            let initial = f.named(&roots, "initial");
            let governing = f.named(&roots, "governing");
            f.finish(&initial, &[("request.md", "first")]);
            f.finish(&governing, &[("governing.md", "unchanged governing evidence")]);
            let governing_id = f.output(&governing, "governing.md");
            let ids = f.tick();
            let first_design = f.named(&ids, "designer");
            let first_side = f.named(&ids, "side");
            f.finish(&first_design, &[("design.md", "first")]);
            f.finish(&first_side, &[("side.md", "old request side")]);
            let ids = f.tick();
            let checker = f.named(&ids, "checker");
            let first_join = f.named(&ids, "join");
            assert_eq!(f.state.executions[&first_join].candidate.inputs["side.md"], [f.output(&first_side, "side.md")]);
            f.finish(&checker, &[("request.md", "next"), ("stop.md", "also stop")]);
            let ids = f.tick();
            let next_design = f.named(&ids, "designer");
            let next_side = f.named(&ids, "side");
            assert_eq!(
                f.state.executions[&next_design].candidate.inputs,
                BTreeMap::from([
                    ("request.md".into(), vec![f.output(&checker, "request.md")]),
                    ("policy.md".into(), vec![policy]),
                    ("governing.md".into(), vec![governing_id]),
                ])
            );
            f.finish(&next_design, &[("design.md", "next")]);
            let ids = f.tick();
            assert!(
                ids.iter().all(|id| f.state.executions[id].candidate.step_key != "join"),
                "old outside evidence cannot satisfy new pass"
            );
            f.start(&next_side);
            f.write(&next_side, &[("side.md", "current side")]);
            assert!(matches!(f.accept(&next_side), CompletionOutcome::Accepted { .. }));
            assert!(f.tick().is_empty());
            f.exit(&next_side);
            let ids = f.tick();
            let join = f.named(&ids, "join");
            assert_eq!(
                f.state.executions[&join].candidate.inputs,
                BTreeMap::from([
                    ("design.md".into(), vec![f.output(&next_design, "design.md")]),
                    ("side.md".into(), vec![f.output(&next_side, "side.md")]),
                ])
            );
            f.restart();
            assert!(f.tick().is_empty());
        }
    }

    #[test]
    fn shared_exact_collection_companions_keep_ownership() {
        use InputMode::{Complete, Each, Single};
        let mut f = Fixture::new(vec![
            step("one", &[("ticket.md", Single)], &["request-a.md", "brief.md"]),
            step("two", &[("ticket.md", Single)], &["request-a.md", "brief.md"]),
            step("each", &[("request-*.md", Each), ("brief.md", Single)], &["worker.md"]),
            step("complete", &[("request-*.md", Complete), ("brief.md", Single)], &["answer.md"]),
        ]);
        let roots = f.tick();
        for id in &roots {
            f.finish(id, &[("request-a.md", "same"), ("brief.md", "own")]);
        }
        let ready = f.tick();
        for key in ["each", "complete"] {
            let bindings: Vec<_> = ready.iter().map(|id| &f.state.executions[id].candidate).filter(|c| c.step_key == key).collect();
            assert_eq!(
                bindings.iter().map(|c| c.inputs.clone()).collect::<BTreeSet<_>>(),
                roots
                    .iter()
                    .map(|id| BTreeMap::from([
                        ("request-*.md".into(), vec![f.output(id, "request-a.md")]),
                        ("brief.md".into(), vec![f.output(id, "brief.md")]),
                    ]))
                    .collect()
            );
            for binding in bindings {
                let collection_id = if key == "each" {
                    binding.each_collection_id.as_ref()
                } else {
                    binding.complete_collection_id.as_ref()
                }
                .unwrap();
                let collection = &f.state.collections[collection_id];
                assert_eq!(collection.member_occurrence_ids, binding.inputs["request-*.md"].iter().cloned().collect());
                let request = &binding.inputs["request-*.md"][0];
                assert_eq!(
                    collection.expected_execution_ids,
                    BTreeSet::from([f.state.occurrences[request].producer_execution_id.clone().unwrap()])
                );
                if key == "each" {
                    assert_eq!(binding.each_member_id.as_ref(), Some(request));
                }
            }
        }
        f.restart();
        assert!(f.tick().is_empty());
    }

    #[test]
    fn shared_exact_complete_rejects_conflicting_member_companions() {
        use InputMode::{Complete, Each, Single};
        let mut f = Fixture::new(vec![
            step("source", &[("ticket.md", Single)], &["items/*.md"]),
            step("worker", &[("items/*.md", Each)], &["request-a.md", "brief.md"]),
            step("other", &[("absent.md", Single)], &["request-a.md", "brief.md"]),
            step("collect", &[("request-*.md", Complete), ("brief.md", Single)], &["answer.md"]),
        ]);
        let roots = f.tick();
        f.finish(&roots[0], &[("items/a.md", "A"), ("items/b.md", "B")]);
        let workers = f.tick();
        for id in &workers {
            f.finish(id, &[("request-a.md", "request"), ("brief.md", "member-specific")]);
        }
        let error = reconcile_graph(&f.definition, &mut f.state).expect_err("a whole collection cannot select one member's governing brief");
        assert!(error.contains("collect") && error.contains("brief.md"), "{error}");
        for id in &workers {
            assert!(error.contains(&f.output(id, "brief.md")), "{error}");
        }
    }

    #[test]
    fn shared_exact_collection_companion_respects_local_shadow() {
        use InputMode::{Each, Single};
        let mut f = Fixture::new(vec![
            step("source", &[("ticket.md", Single)], &["items/*.md", "brief.md"]),
            step("local-brief", &[("items/*.md", Each)], &["brief.md"]),
            step("other-brief", &[("absent.md", Single)], &["brief.md"]),
            step("consumer", &[("items/*.md", Each), ("brief.md", Single), ("gate.md", Single)], &["answer.md"]),
        ]);
        let roots = f.tick();
        let source = f.named(&roots, "source");
        f.finish(&source, &[("items/a.md", "member"), ("brief.md", "old")]);
        let old = f.output(&source, "brief.md");
        let workers = f.tick();
        let local = f.named(&workers, "local-brief");
        let gate = f.seed("gate.md", "gate.md", "ready");
        assert!(f.tick().is_empty(), "member ancestry cannot override a reserved local companion");
        f.start(&local);
        f.write(&local, &[("brief.md", "fresh")]);
        assert!(matches!(f.accept(&local), CompletionOutcome::Accepted { .. }));
        assert!(f.tick().is_empty(), "member ancestry cannot override a live local companion");
        f.exit(&local);
        let ids = f.tick();
        let consumer = f.named(&ids, "consumer");
        let binding = &f.state.executions[&consumer].candidate;
        assert_eq!(
            binding.inputs,
            BTreeMap::from([
                ("items/*.md".into(), vec![f.output(&source, "items/a.md")]),
                ("brief.md".into(), vec![f.output(&local, "brief.md")]),
                ("gate.md".into(), vec![gate]),
            ])
        );
        assert!(!binding.inputs["brief.md"].contains(&old));
        assert_eq!(binding.each_collection_id, f.state.executions[&local].candidate.each_collection_id);
        assert_eq!(binding.each_member_id, f.state.executions[&local].candidate.each_member_id);
    }

    #[test]
    fn shared_exact_nested_collection_companion_respects_ancestor_shadow() {
        use InputMode::{Each, Single};
        let mut f = Fixture::new(vec![
            step("source", &[("ticket.md", Single)], &["items/*.md", "brief.md"]),
            step("local-brief", &[("items/*.md", Each)], &["brief.md"]),
            step("expander", &[("items/*.md", Each)], &["chunks/*.md"]),
            step("consumer", &[("chunks/*.md", Each), ("brief.md", Single), ("gate.md", Single)], &["answer.md"]),
        ]);
        let roots = f.tick();
        let source = f.named(&roots, "source");
        f.finish(&source, &[("items/a.md", "member"), ("brief.md", "old")]);
        let workers = f.tick();
        let local = f.named(&workers, "local-brief");
        let expander = f.named(&workers, "expander");
        f.finish(&expander, &[("chunks/a.md", "nested member")]);
        let gate = f.seed("gate.md", "gate.md", "ready");
        assert!(f.tick().is_empty(), "a parent Member's pending companion shadows carried ancestry in nested Members");
        f.start(&local);
        f.write(&local, &[("brief.md", "fresh")]);
        assert!(matches!(f.accept(&local), CompletionOutcome::Accepted { .. }));
        assert!(f.tick().is_empty(), "a parent Member's live companion cannot expose carried old evidence");
        f.exit(&local);
        let ids = f.tick();
        let consumer = f.named(&ids, "consumer");
        let binding = &f.state.executions[&consumer].candidate;
        assert_eq!(
            binding.inputs,
            BTreeMap::from([
                ("chunks/*.md".into(), vec![f.output(&expander, "chunks/a.md")]),
                ("brief.md".into(), vec![f.output(&local, "brief.md")]),
                ("gate.md".into(), vec![gate]),
            ])
        );
        assert_ne!(binding.context_id, f.state.executions[&local].candidate.context_id);
        assert_eq!(binding.each_member_id.as_ref(), Some(&f.output(&expander, "chunks/a.md")));
        f.restart();
        assert!(f.tick().is_empty());
    }

    #[test]
    fn shared_exact_loop_stop_retains_its_consumed_design() {
        use InputMode::Single;
        let mut f = Fixture::new(vec![
            step("initial", &[("ticket.md", Single)], &["request.md"]),
            step("designer", &[("request.md", Single)], &["design.md"]),
            step("checker", &[("design.md", Single)], &["request.md", "stop.md"]),
            step("plan", &[("design.md", Single)], &["plan.md"]),
            step("report", &[("design.md", Single), ("plan.md", Single), ("stop.md", Single)], &["answer.md"]),
        ]);
        let roots = f.tick();
        f.finish(&roots[0], &[("request.md", "initial")]);
        let ids = f.tick();
        let designer = f.named(&ids, "designer");
        f.finish(&designer, &[("design.md", "old pass")]);
        let ids = f.tick();
        let checker = f.named(&ids, "checker");
        let plan = f.named(&ids, "plan");
        f.finish(&checker, &[("request.md", "fresh request"), ("stop.md", "old pass conclusion")]);
        f.finish(&plan, &[("plan.md", "old pass plan")]);
        let ids = f.tick();
        let report = f.named(&ids, "report");
        assert_eq!(
            f.state.executions[&report].candidate.inputs,
            BTreeMap::from([
                ("design.md".into(), vec![f.output(&designer, "design.md")]),
                ("plan.md".into(), vec![f.output(&plan, "plan.md")]),
                ("stop.md".into(), vec![f.output(&checker, "stop.md")]),
            ])
        );
        assert_eq!(f.state.executions[&report].candidate.context_id, f.state.executions[&checker].candidate.context_id);
        let next = f.named(&ids, "designer");
        assert_eq!(f.state.executions[&next].candidate.inputs["request.md"], [f.output(&checker, "request.md")]);
        f.finish(&next, &[("design.md", "fresh pass")]);
        let ids = f.tick();
        assert!(
            ids.iter().all(|id| f.state.executions[id].candidate.step_key != "report"),
            "old stop cannot conclude the fresh pass"
        );
    }

    #[test]
    fn shared_exact_compound_separate_producers_preserve_prior_branch() {
        use InputMode::Single;
        let mut f = Fixture::new(vec![
            step("initial-one", &[("ticket.md", Single)], &["request.md", "direction.md"]),
            step("initial-two", &[("ticket.md", Single)], &["request.md", "direction.md"]),
            step("designer", &[("request.md", Single), ("direction.md", Single)], &["design.md"]),
            step("request", &[("design.md", Single)], &["request.md"]),
            step("direction", &[("design.md", Single)], &["direction.md"]),
        ]);
        let roots = f.tick();
        for id in &roots {
            f.finish(id, &[("request.md", "initial"), ("direction.md", "initial")]);
        }
        let designers = f.tick();
        assert_eq!(designers.len(), 2);
        for id in &designers {
            f.finish(id, &[("design.md", "own branch")]);
        }
        let continuations = f.tick();
        let mut expected = BTreeSet::new();
        for designer in &designers {
            let design = f.output(designer, "design.md");
            let own: Vec<_> = continuations
                .iter()
                .filter(|id| f.state.executions[*id].candidate.inputs["design.md"] == [design.clone()])
                .cloned()
                .collect();
            let request = f.named(&own, "request");
            let direction = f.named(&own, "direction");
            f.finish(&request, &[("request.md", "fresh")]);
            f.finish(&direction, &[("direction.md", "fresh")]);
            expected.insert(BTreeMap::from([
                ("request.md".into(), vec![f.output(&request, "request.md")]),
                ("direction.md".into(), vec![f.output(&direction, "direction.md")]),
            ]));
        }
        let ready = f.tick();
        assert_eq!(ready.iter().map(|id| f.state.executions[id].candidate.inputs.clone()).collect::<BTreeSet<_>>(), expected);
        for id in &ready {
            let binding = &f.state.executions[id].candidate;
            let ContextCause::Loop { trigger_occurrences, .. } = &f.state.contexts[&binding.context_id].cause else {
                panic!("fresh paired activation")
            };
            assert_eq!(trigger_occurrences, &binding.inputs.values().flatten().cloned().collect());
        }
        f.restart();
        assert!(f.tick().is_empty());
    }

    #[test]
    fn shared_exact_singleton_companions_must_agree_with_each_other() {
        use InputMode::Single;
        let mut f = Fixture::new(vec![
            step("request-one", &[("ticket.md", Single)], &["request.md"]),
            step("request-two", &[("ticket.md", Single)], &["request.md"]),
            step("anchor-one", &[("ticket.md", Single)], &["anchor.md"]),
            step("anchor-two", &[("ticket.md", Single)], &["anchor.md"]),
            step("brief", &[("request.md", Single)], &["brief.md"]),
            step("check", &[("request.md", Single)], &["check.md"]),
            step("join", &[("anchor.md", Single), ("brief.md", Single), ("check.md", Single)], &["answer.md"]),
        ]);
        let roots = f.tick();
        for root in &roots {
            let role = f.state.executions[root].outputs[0].selector.clone();
            f.finish(root, &[(&role, "same")]);
        }
        let first = f.output(&f.named(&roots, "request-one"), "request.md");
        let second = f.output(&f.named(&roots, "request-two"), "request.md");
        let workers = f.tick();
        let brief = workers
            .iter()
            .find(|id| {
                let binding = &f.state.executions[*id].candidate;
                binding.step_key == "brief" && binding.inputs["request.md"] == [first.clone()]
            })
            .unwrap()
            .clone();
        let check = workers
            .iter()
            .find(|id| {
                let binding = &f.state.executions[*id].candidate;
                binding.step_key == "check" && binding.inputs["request.md"] == [second.clone()]
            })
            .unwrap()
            .clone();
        f.finish(&brief, &[("brief.md", "first branch")]);
        f.finish(&check, &[("check.md", "second branch")]);
        assert!(f.tick().is_empty(), "two individually unambiguous companions still cannot cross request branches");
    }

    #[test]
    fn shared_exact_carried_copublished_brief_remains_usable() {
        use InputMode::Single;
        for looped in [true, false] {
            let mut f = Fixture::new(vec![
                step("initial", &[("ticket.md", Single)], &["request.md", "brief.md"]),
                step("designer", &[("request.md", Single), ("brief.md", Single)], &["design.md"]),
                step(
                    "repeat",
                    if looped {
                        &[("design.md", Single), ("brief.md", Single)]
                    } else {
                        &[("brief.md", Single)]
                    },
                    &["request.md", "stop.md"],
                ),
            ]);
            let roots = f.tick();
            f.finish(&roots[0], &[("request.md", "first"), ("brief.md", "unchanged governing brief")]);
            let brief = f.output(&roots[0], "brief.md");
            let ready = f.tick();
            let first = f.named(&ready, "designer");
            f.finish(&first, &[("design.md", "first design")]);
            let repeat = if looped {
                let ready = f.tick();
                f.named(&ready, "repeat")
            } else {
                f.named(&ready, "repeat")
            };
            f.finish(&repeat, &[("request.md", "next")]);
            let ready = f.tick();
            assert_eq!(
                ready.iter().map(|id| f.state.executions[id].candidate.inputs.clone()).collect::<Vec<_>>(),
                vec![BTreeMap::from([
                    ("request.md".into(), vec![f.output(&repeat, "request.md")]),
                    ("brief.md".into(), vec![brief]),
                ])],
                "looped={looped}: a fresh request retains its unchanged co-published governing brief"
            );
            f.restart();
            assert!(f.tick().is_empty(), "carrying the same brief does not replay either request");
        }
    }

    #[test]
    fn shared_exact_partial_sibling_pools_do_not_hide_complete_join() {
        use InputMode::Single;
        let mut f = Fixture::new(vec![
            step("request-one", &[("ticket.md", Single)], &["request.md"]),
            step("request-two", &[("ticket.md", Single)], &["request.md"]),
            step("request-three", &[("ticket.md", Single)], &["request.md"]),
            step("anchor-one", &[("ticket.md", Single)], &["anchor.md"]),
            step("anchor-two", &[("ticket.md", Single)], &["anchor.md"]),
            step("anchor-three", &[("ticket.md", Single)], &["anchor.md"]),
            step("brief", &[("request.md", Single)], &["brief.md"]),
            step("check", &[("request.md", Single)], &["check.md"]),
            step("join", &[("anchor.md", Single), ("brief.md", Single), ("check.md", Single)], &["answer.md"]),
        ]);
        let roots = f.tick();
        for id in &roots {
            let role = f.state.executions[id].outputs[0].selector.clone();
            f.finish(id, &[(&role, "independent")]);
        }
        let requests: Vec<_> = ["request-one", "request-two", "request-three"]
            .iter()
            .map(|key| f.output(&f.named(&roots, key), "request.md"))
            .collect();
        let workers = f.tick();
        let worker = |key: &str, request: &str| {
            workers
                .iter()
                .find(|id| {
                    let binding = &f.state.executions[*id].candidate;
                    binding.step_key == key && binding.inputs["request.md"] == [request]
                })
                .unwrap()
                .clone()
        };
        let brief_one = worker("brief", &requests[0]);
        let brief_two = worker("brief", &requests[1]);
        let check_one = worker("check", &requests[0]);
        let check_three = worker("check", &requests[2]);
        for (id, role) in [(&brief_one, "brief.md"), (&brief_two, "brief.md"), (&check_one, "check.md"), (&check_three, "check.md")] {
            f.finish(id, &[(role, "own branch")]);
        }
        let ready = f.tick();
        let expected: BTreeSet<_> = ["anchor-one", "anchor-two", "anchor-three"]
            .iter()
            .map(|key| {
                BTreeMap::from([
                    ("anchor.md".into(), vec![f.output(&f.named(&roots, key), "anchor.md")]),
                    ("brief.md".into(), vec![f.output(&brief_one, "brief.md")]),
                    ("check.md".into(), vec![f.output(&check_one, "check.md")]),
                ])
            })
            .collect();
        assert_eq!(ready.iter().map(|id| f.state.executions[id].candidate.inputs.clone()).collect::<BTreeSet<_>>(), expected);
        f.restart();
        assert!(f.tick().is_empty());
    }

    #[test]
    fn shared_exact_prechange_state_keeps_bindings() {
        let frozen: serde_json::Value = serde_json::from_str(include_str!("../tests/fixtures/shared-role-compat.json")).unwrap();
        for snapshot in frozen["snapshots"].as_array().unwrap() {
            let mut f = Fixture {
                repo: std::env::temp_dir().join(format!("alinery-compat-{}", uuid::Uuid::new_v4())),
                definition: parse_playbook_md(snapshot["source"].as_str().unwrap()).unwrap(),
                state: serde_json::from_value(snapshot["state"].clone()).unwrap(),
            };
            for (relative, contents) in snapshot["artifacts"].as_object().unwrap() {
                let path = crate::artifacts_dir(&f.repo, "task").join(relative);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, contents.as_str().unwrap()).unwrap();
            }
            let records = f.state.executions.clone();
            assert!(f.tick().is_empty(), "old handled and queued bindings must not replay");
            f.restart();
            assert!(f.tick().is_empty());
            assert_eq!(f.state.executions, records, "queued owners, bindings and assignments are immutable");
            let queued = snapshot["queued_execution"].as_str().unwrap();
            f.finish(queued, &[(snapshot["queued_output"].as_str().unwrap(), "queued result")]);
            let next = f.tick();
            assert_eq!(next.len(), 1, "{}", snapshot["name"]);
            let record = &f.state.executions[&next[0]];
            assert_eq!(record.candidate.step_key, snapshot["next_step"].as_str().unwrap());
            let expected: BTreeMap<String, Vec<String>> = snapshot["expected_input_producers"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(role, producers)| {
                    let selector = ArtifactSelector::parse(role).unwrap();
                    let ids = f
                        .state
                        .occurrences
                        .values()
                        .filter(|o| selector.matches(&o.logical_path) && producers.as_array().unwrap().iter().any(|p| p.as_str() == o.producer_execution_id.as_deref()))
                        .map(|o| o.id.clone())
                        .collect();
                    (role.clone(), ids)
                })
                .collect();
            assert_eq!(record.candidate.inputs, expected, "next work must consume this branch's outputs");
            assert!(record.outputs.iter().all(|output| records
                .values()
                .all(|old| old.outputs.iter().all(|old_output| old_output.relative_path != output.relative_path))));
            for (id, old) in &records {
                let current = &f.state.executions[id];
                assert_eq!(current.binding_key, old.binding_key);
                assert_eq!(current.outputs, old.outputs);
                assert_eq!(current.owner_session_id, old.owner_session_id);
                if id != queued {
                    assert_eq!(current, old);
                }
            }
            f.restart();
            assert!(f.tick().is_empty());
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
        assert_eq!(
            f.state.executions[&sum].candidate.inputs["numbers.md"].iter().cloned().collect::<BTreeSet<_>>(),
            f.output_ids(&seed)
        );
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
        let family = f
            .state
            .collections
            .values()
            .find(|c| c.selector == "result-*.md" && c.source_collection_id.is_some())
            .unwrap();
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
        assert_eq!(
            f.state.executions[&collect].candidate.inputs["result-*.md"].iter().cloned().collect::<BTreeSet<_>>(),
            workers.iter().flat_map(|id| f.output_ids(id)).collect()
        );
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
        for id in &workers {
            assert_eq!(f.state.executions[id].candidate.inputs["policy.md"].as_slice(), std::slice::from_ref(&policy));
        }
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
        assert_eq!(
            f.state.executions[&next_local].candidate.inputs["inner-result-*.md"]
                .iter()
                .cloned()
                .collect::<BTreeSet<_>>(),
            f.output_ids(&next_worker)
        );
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
        assert_eq!(
            f.state.executions[&a2].candidate.inputs["ticket.md"].iter().cloned().collect::<BTreeSet<_>>(),
            f.output_ids(&d)
        );
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
        assert_eq!(
            f.state.executions[&join2].candidate.inputs.values().flatten().cloned().collect::<BTreeSet<_>>(),
            f.output_ids(&sum2).union(&f.output_ids(&product2)).cloned().collect()
        );
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
        f.write(&continuation, &[("ticket.md", "next"), ("request.md", "next")]);
        assert!(matches!(f.accept(&continuation), CompletionOutcome::Accepted { .. }));
        assert!(f.ready().is_empty());
        f.exit(&continuation);
        let ids = f.tick();
        assert_eq!(ids.len(), 1);
        let next = f.named(&ids, "entry");
        assert_eq!(
            f.state.executions[&next].candidate.inputs.values().flatten().cloned().collect::<BTreeSet<_>>(),
            f.output_ids(&continuation)
        );
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
        assert_eq!(
            ids.iter().map(|id| f.state.executions[id].candidate.step_key.as_str()).collect::<BTreeSet<_>>(),
            BTreeSet::from(["first", "root", "second"])
        );
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
        assert_eq!(
            f.state.executions[&collect].candidate.inputs["result-*.md"].iter().cloned().collect::<BTreeSet<_>>(),
            f.output_ids(&first).union(&f.output_ids(&second)).cloned().collect()
        );
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
        assert_eq!(selected.inputs["request-a.md"].as_slice(), std::slice::from_ref(&expected.id));
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
        assert_eq!(
            ready[0].inputs["result-*.md"].iter().cloned().collect::<BTreeSet<_>>(),
            f.output_ids(&first).union(&f.output_ids(&second)).cloned().collect()
        );
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

    #[test]
    fn possible_output_routes_only_satisfied_exact_dependencies() {
        use InputMode::Single;
        for outputs in [vec![("a.md", "A")], vec![("b.md", "B")], vec![("a.md", "A"), ("b.md", "B")]] {
            let mut f = Fixture::new(vec![
                step("source", &[("ticket.md", Single)], &["a.md", "b.md"]),
                step("a", &[("a.md", Single)], &["a-result.md"]),
                step("b", &[("b.md", Single)], &["b-result.md"]),
                step("join", &[("a.md", Single), ("b.md", Single)], &["joined.md"]),
            ]);
            let ids = f.tick();
            let source = f.named(&ids, "source");
            f.start(&source);
            f.write(&source, &outputs);
            let receipt = f.accept(&source);
            assert!(matches!(receipt, CompletionOutcome::Accepted { .. }));
            assert!(f.ready().is_empty());
            f.exit(&source);
            let ids = f.tick();
            let mut expected = BTreeSet::new();
            if outputs.iter().any(|(path, _)| *path == "a.md") {
                expected.insert("a");
            }
            if outputs.iter().any(|(path, _)| *path == "b.md") {
                expected.insert("b");
            }
            if outputs.len() == 2 {
                expected.insert("join");
            }
            assert_eq!(ids.iter().map(|id| f.state.executions[id].candidate.step_key.as_str()).collect::<BTreeSet<_>>(), expected);
            for id in &ids {
                for (path, bound) in &f.state.executions[id].candidate.inputs {
                    let occurrence = f
                        .state
                        .occurrences
                        .values()
                        .find(|o| o.producer_execution_id.as_deref() == Some(&source) && &o.logical_path == path)
                        .unwrap();
                    assert_eq!(bound, std::slice::from_ref(&occurrence.id));
                }
            }
            let accepted = f.output_ids(&source);
            assert_eq!(accepted.len(), outputs.len());
            f.restart();
            assert_eq!(f.accept(&source), receipt);
            assert!(f.tick().is_empty());
            assert_eq!(f.output_ids(&source), accepted);
        }
    }

    #[test]
    fn summary_only_closes_empty_family_after_exit_without_consumers() {
        use InputMode::{Complete, Each, Single};
        let mut f = Fixture::new(vec![
            step("source", &[("ticket.md", Single)], &["summary.md", "papers/*.md"]),
            step("worker", &[("papers/*.md", Each)], &["results/*.md"]),
            step("collect", &[("papers/*.md", Complete)], &["collection.md"]),
        ]);
        let ids = f.tick();
        let source = f.named(&ids, "source");
        let collection_id = f.state.collections.values().find(|c| c.selector == "papers/*.md").unwrap().id.clone();
        f.start(&source);
        f.write(&source, &[("summary.md", "Search concluded without any papers.")]);
        let receipt = f.accept(&source);
        assert!(matches!(receipt, CompletionOutcome::Accepted { .. }));
        let accepted = f.output_ids(&source);
        assert!(f.ready().is_empty());
        assert!(!f.state.collections[&collection_id].membership_closed);
        f.exit(&source);
        assert!(f.tick().is_empty());
        let collection = &f.state.collections[&collection_id];
        assert!(collection.membership_closed);
        assert!(collection.member_occurrence_ids.is_empty());
        assert_eq!(collection.expected_execution_ids, BTreeSet::from([source.clone()]));
        assert_eq!(f.state.executions.len(), 1);
        assert_eq!(f.state.collections.len(), 1, "no worker exists to own a result family");
        f.write(&source, &[("papers/late.md", "Not part of the accepted handoff.")]);
        f.restart();
        assert_eq!(f.accept(&source), receipt);
        assert!(f.tick().is_empty());
        assert_eq!(f.output_ids(&source), accepted);
        assert!(f.state.collections[&collection_id].membership_closed);
        assert!(f.state.collections[&collection_id].member_occurrence_ids.is_empty());
    }

    #[test]
    fn direct_worker_dispositions_close_empty_or_mixed_result_families() {
        use InputMode::{Complete, Each, Single};
        for mixed in [false, true] {
            let mut f = Fixture::new(vec![
                step("source", &[("ticket.md", Single)], &["request-*.md"]),
                step("worker", &[("request-*.md", Each)], &["result-*.md", "worker-disposition.md"]),
                step("collect", &[("result-*.md", Complete)], &["answer.md"]),
            ]);
            let ids = f.tick();
            let source = f.named(&ids, "source");
            f.finish(&source, &[("request-a.md", "2"), ("request-b.md", "3")]);
            let workers = f.tick();
            assert_eq!(workers.len(), 2);
            let first = &workers[0];
            let last = &workers[1];
            f.finish(
                first,
                if mixed {
                    &[("result-value.md", "4")]
                } else {
                    &[("worker-disposition.md", "No result warranted.")]
                },
            );
            f.start(last);
            f.write(last, &[("worker-disposition.md", "No result warranted.")]);
            assert!(matches!(f.accept(last), CompletionOutcome::Accepted { .. }));
            assert!(f.ready().is_empty());
            let family_id = f
                .state
                .collections
                .values()
                .find(|c| c.selector == "result-*.md" && c.source_collection_id.is_some())
                .unwrap()
                .id
                .clone();
            let family = &f.state.collections[&family_id];
            assert_eq!(family.expected_execution_ids, workers.iter().cloned().collect());
            assert!(!family.membership_closed);
            assert!(f.state.collections[family.source_collection_id.as_ref().unwrap()].membership_closed);
            let locals: Vec<_> = f
                .state
                .collections
                .values()
                .filter(|c| c.selector == "result-*.md" && c.source_collection_id.is_none())
                .collect();
            assert_eq!(locals.len(), 2);
            for local in locals {
                assert_eq!(local.expected_execution_ids.len(), 1);
                assert_eq!(local.membership_closed, local.expected_execution_ids.contains(first));
            }
            f.exit(last);
            let ids = f.tick();
            let result_ids = if mixed { f.output_ids(first) } else { BTreeSet::new() };
            let family = &f.state.collections[&family_id];
            assert!(family.membership_closed);
            assert_eq!(family.member_occurrence_ids, result_ids);
            assert!(f.state.collections.values().filter(|c| c.selector == "result-*.md").all(|c| c.membership_closed));
            if mixed {
                assert_eq!(ids.len(), 1);
                let collect = f.named(&ids, "collect");
                assert_eq!(
                    f.state.executions[&collect].candidate.inputs["result-*.md"].iter().cloned().collect::<BTreeSet<_>>(),
                    result_ids
                );
                assert!(f.output_ids(last).is_disjoint(&result_ids));
            } else {
                assert!(ids.is_empty());
            }
            let collections = f.state.collections.clone();
            f.restart();
            assert!(f.tick().is_empty());
            assert_eq!(f.state.collections, collections);
        }
    }

    #[test]
    fn narrowed_empty_selectors_do_not_manufacture_consumers() {
        use InputMode::{Complete, Each, Single};
        let mut f = Fixture::new(vec![
            step("source", &[("ticket.md", Single)], &["papers/*.md"]),
            step("worker", &[("papers/selected-*.md", Each)], &["results/*.md"]),
            step("collect", &[("papers/selected-*.md", Complete)], &["answer.md"]),
        ]);
        let ids = f.tick();
        let source = f.named(&ids, "source");
        f.finish(&source, &[("papers/unselected.md", "A real but out-of-scope paper.")]);
        assert!(f.tick().is_empty());
        assert_eq!(f.state.executions.len(), 1);
        assert_eq!(f.state.collections.len(), 1);
        let collection = f.state.collections.values().next().unwrap();
        assert!(collection.membership_closed);
        assert_eq!(collection.member_occurrence_ids, f.output_ids(&source));
        f.restart();
        assert!(f.tick().is_empty());
    }

    #[test]
    fn interrupted_disposition_worker_does_not_close_its_family() {
        use InputMode::{Complete, Each, Single};
        let mut f = Fixture::new(vec![
            step("source", &[("ticket.md", Single)], &["request-*.md"]),
            step("worker", &[("request-*.md", Each)], &["result-*.md", "worker-disposition.md"]),
            step("collect", &[("result-*.md", Complete)], &["answer.md"]),
        ]);
        let ids = f.tick();
        let source = f.named(&ids, "source");
        f.start(&source);
        f.write(&source, &[("request-a.md", "2"), ("request-b.md", "3")]);
        assert!(matches!(f.accept(&source), CompletionOutcome::Accepted { .. }));
        assert!(f.tick().is_empty(), "an open source cannot release workers");
        f.exit(&source);
        let workers = f.tick();
        let first = &workers[0];
        let last = &workers[1];
        f.finish(first, &[("result-value.md", "4")]);
        assert!(f.ready().is_empty(), "queued worker remains an obligation");
        f.start(last);
        f.write(last, &[("worker-disposition.md", "Concluded without a result.")]);
        assert!(f.ready().is_empty(), "Running includes a session awaiting human input");
        crate::execution::interrupt_unproven_owners(&mut f.state, &BTreeSet::new());
        assert_eq!(f.state.executions[last].lifecycle, ExecutionLifecycle::Interrupted);
        f.restart();
        assert!(f.ready().is_empty());
        assert!(f
            .state
            .collections
            .values()
            .filter(|c| c.expected_execution_ids.contains(last))
            .all(|c| !c.membership_closed));
        assert!(f.output_ids(last).is_empty(), "unaccepted on-disk disposition is not evidence");
        f.exit(last);
        assert_eq!(f.state.executions[last].lifecycle, ExecutionLifecycle::Failed);
        assert!(f.ready().is_empty());
        let owner = recover_execution_owner(&mut f.state, last).unwrap();
        request_execution_start(&mut f.state, last).unwrap();
        f.start(last);
        grant_execution_completion(&mut f.state, last, &owner).unwrap();
        assert!(matches!(f.accept(last), CompletionOutcome::Accepted { .. }));
        assert!(f.ready().is_empty());
        f.exit(last);
        let ids = f.tick();
        let collect = f.named(&ids, "collect");
        assert_eq!(
            f.state.executions[&collect].candidate.inputs["result-*.md"].iter().cloned().collect::<BTreeSet<_>>(),
            f.output_ids(first)
        );
    }

    #[test]
    fn chained_omission_preserves_unrepresented_source_obligation() {
        use InputMode::{Complete, Each, Single};
        let mut f = Fixture::new(vec![
            step("source", &[("ticket.md", Single)], &["request-*.md"]),
            step("worker", &[("request-a*.md", Each)], &["work.md", "worker-disposition.md"]),
            step("publish", &[("work.md", Single)], &["result-*.md"]),
            step("collect", &[("result-*.md", Complete)], &["answer.md"]),
        ]);
        let ids = f.tick();
        let source = f.named(&ids, "source");
        f.finish(&source, &[("request-a1.md", "2"), ("request-a2.md", "3"), ("request-b.md", "999")]);
        let workers = f.tick();
        assert_eq!(workers.len(), 2);
        f.finish(&workers[0], &[("worker-disposition.md", "No downstream work warranted.")]);
        f.finish(&workers[1], &[("work.md", "3")]);
        let ids = f.tick();
        assert_eq!(ids.len(), 1);
        let publisher = f.named(&ids, "publish");
        assert_eq!(
            f.state.executions[&publisher].candidate.inputs["work.md"].iter().cloned().collect::<BTreeSet<_>>(),
            f.output_ids(&workers[1])
        );
        f.finish(&publisher, &[("result-value.md", "9")]);
        assert!(f.tick().is_empty());
        let family = f
            .state
            .collections
            .values()
            .find(|c| c.selector == "result-*.md" && c.source_collection_id.is_some())
            .unwrap();
        assert!(!family.membership_closed);
        assert_eq!(family.expected_execution_ids, BTreeSet::from([publisher.clone()]));
        assert_eq!(family.member_occurrence_ids, f.output_ids(&publisher));
        assert!(f.state.collections[family.source_collection_id.as_ref().unwrap()].membership_closed);
        let collections = f.state.collections.clone();
        f.restart();
        assert!(f.tick().is_empty());
        assert_eq!(f.state.collections, collections);
        assert_eq!(f.state.executions.values().filter(|e| e.candidate.step_key == "publish").count(), 1);
        assert!(!f.state.executions.values().any(|e| e.candidate.step_key == "collect"));
    }

    #[test]
    fn nested_empty_expansion_preserves_outer_obligations_after_restart() {
        use InputMode::{Complete, Each, Single};
        let mut f = Fixture::new(vec![
            step("source", &[("ticket.md", Single)], &["outer-*.md"]),
            step("expand", &[("outer-*.md", Each)], &["inner-request-*.md", "expansion-summary.md"]),
            step("worker", &[("inner-request-*.md", Each)], &["inner-result-*.md"]),
            step("local", &[("inner-result-*.md", Complete)], &["local-*.md"]),
            step("parent", &[("local-*.md", Complete)], &["answer.md"]),
        ]);
        let ids = f.tick();
        let source = f.named(&ids, "source");
        f.finish(&source, &[("outer-a.md", "2"), ("outer-b.md", "3")]);
        let expanders = f.tick();
        assert_eq!(expanders.len(), 2);
        let empty = &expanders[0];
        let populated = &expanders[1];
        f.start(empty);
        f.write(empty, &[("expansion-summary.md", "No child requests warranted.")]);
        assert!(matches!(f.accept(empty), CompletionOutcome::Accepted { .. }));
        let empty_id = f
            .state
            .collections
            .values()
            .find(|c| c.selector == "inner-request-*.md" && c.source_collection_id.is_none() && c.expected_execution_ids.contains(empty))
            .unwrap()
            .id
            .clone();
        assert!(f.ready().is_empty());
        assert!(!f.state.collections[&empty_id].membership_closed);
        f.finish(populated, &[("inner-request-child.md", "7")]);
        let ids = f.tick();
        assert_eq!(ids.len(), 1);
        let worker = f.named(&ids, "worker");
        assert_eq!(
            f.state.executions[&worker].candidate.inputs["inner-request-*.md"].iter().cloned().collect::<BTreeSet<_>>(),
            f.output_ids(populated)
        );
        f.finish(&worker, &[("inner-result-value.md", "49")]);
        let ids = f.tick();
        let local = f.named(&ids, "local");
        assert_eq!(
            f.state.executions[&local].candidate.inputs["inner-result-*.md"].iter().cloned().collect::<BTreeSet<_>>(),
            f.output_ids(&worker)
        );
        f.finish(&local, &[("local-total.md", "49")]);
        assert!(f.tick().is_empty(), "the still-live empty expander has not discharged any obligation");
        let requests = f
            .state
            .collections
            .values()
            .find(|c| c.selector == "inner-request-*.md" && c.source_collection_id.is_some())
            .unwrap();
        assert!(!requests.membership_closed, "all visible child workers finished, but the request source is still open");
        assert_eq!(requests.expected_execution_ids, expanders.iter().cloned().collect());
        assert_eq!(requests.member_occurrence_ids, f.output_ids(populated));
        f.exit(empty);
        assert!(f.tick().is_empty(), "empty expansion does not fabricate a missing local merge");
        assert!(f.state.collections[&empty_id].membership_closed);
        assert!(f.state.collections[&empty_id].member_occurrence_ids.is_empty());
        let outer = f
            .state
            .collections
            .values()
            .find(|c| c.selector == "local-*.md" && c.source_collection_id.is_some())
            .unwrap();
        assert!(!outer.membership_closed);
        assert_eq!(outer.expected_execution_ids, BTreeSet::from([local.clone()]));
        assert_eq!(outer.member_occurrence_ids, f.output_ids(&local));
        assert_eq!(
            f.state.collections[outer.source_collection_id.as_ref().unwrap()].member_occurrence_ids,
            f.output_ids(&source)
        );
        assert_eq!(f.state.executions.values().filter(|e| e.candidate.step_key == "worker").count(), 1);
        assert_eq!(f.state.executions.values().filter(|e| e.candidate.step_key == "local").count(), 1);
        let collections = f.state.collections.clone();
        f.restart();
        assert!(f.tick().is_empty());
        assert_eq!(f.state.collections, collections);
    }

    #[test]
    fn partial_and_entry_accepts_without_loop_activation() {
        use InputMode::Single;
        let mut f = Fixture::new(vec![
            step("entry", &[("ticket.md", Single), ("request.md", Single)], &["result.md"]),
            step("continue", &[("result.md", Single)], &["ticket.md", "request.md"]),
        ]);
        let initial_request = f.seed("request.md", "request.md", "initial");
        let ids = f.tick();
        let entry = f.named(&ids, "entry");
        f.finish(&entry, &[("result.md", "done")]);
        let ids = f.tick();
        let continuation = f.named(&ids, "continue");
        f.start(&continuation);
        f.write(&continuation, &[("ticket.md", "new direction")]);
        let receipt = f.accept(&continuation);
        assert!(matches!(receipt, CompletionOutcome::Accepted { .. }));
        let accepted = f.output_ids(&continuation);
        assert_eq!(accepted.len(), 1);
        assert!(f.tick().is_empty());
        f.exit(&continuation);
        assert!(f.tick().is_empty());
        f.write(&continuation, &[("request.md", "too late")]);
        f.restart();
        assert_eq!(f.accept(&continuation), receipt);
        assert!(f.tick().is_empty());
        assert_eq!(f.output_ids(&continuation), accepted);
        assert_eq!(f.state.executions[&entry].candidate.inputs["request.md"], [initial_request]);
        assert_eq!(f.state.contexts.values().filter(|c| matches!(c.cause, ContextCause::Loop { .. })).count(), 0);
        assert_eq!(f.state.executions.values().filter(|e| e.candidate.step_key == "entry").count(), 1);
    }

    #[test]
    fn multiple_fresh_continuations_then_report_stop() {
        use InputMode::Single;
        // Both changing siblings are inside the repeated dependency component.
        for omit_final_analysis in [false, true] {
            let mut f = Fixture::new(vec![
                step("design", &[("ticket.md", Single), ("policy.md", Single)], &["design.md"]),
                step("analysis", &[("design.md", Single)], &["analysis.md", "analysis-disposition.md"]),
                step("plan", &[("design.md", Single)], &["plan.md"]),
                step("check", &[("design.md", Single), ("analysis.md", Single), ("plan.md", Single)], &["check.md"]),
                step("compare", &[("check.md", Single)], &["ticket.md", "comparison.md"]),
            ]);
            let policy = f.seed("policy.md", "policy.md", "Governing policy");
            let mut trigger = f.state.occurrences.values().find(|o| o.logical_path == "ticket.md").unwrap().id.clone();
            let mut previous_inputs = BTreeSet::new();
            for pass in 0..3 {
                let ids = f.tick();
                assert_eq!(ids.len(), 1);
                let design = f.named(&ids, "design");
                assert_eq!(f.state.executions[&design].candidate.inputs["ticket.md"], [trigger.clone()]);
                assert_eq!(f.state.executions[&design].candidate.inputs["policy.md"], std::slice::from_ref(&policy));
                f.finish(&design, &[("design.md", &format!("Design for pass {pass}"))]);
                let branches = f.tick();
                assert_eq!(branches.len(), 2);
                let analysis = f.named(&branches, "analysis");
                let plan = f.named(&branches, "plan");
                for id in &branches {
                    assert_eq!(
                        f.state.executions[id].candidate.inputs["design.md"].iter().cloned().collect::<BTreeSet<_>>(),
                        f.output_ids(&design)
                    );
                }
                f.finish(&plan, &[("plan.md", &format!("Plan for pass {pass}"))]);
                assert!(f.ready().is_empty(), "a previous analysis cannot satisfy the fresh join");
                if pass == 2 && omit_final_analysis {
                    f.finish(&analysis, &[("analysis-disposition.md", "Analysis deliberately concluded without a usable result.")]);
                    f.restart();
                    assert!(f.tick().is_empty());
                    assert_eq!(f.state.executions.values().filter(|e| e.candidate.step_key == "check").count(), 2);
                    break;
                }
                f.finish(&analysis, &[("analysis.md", &format!("Analysis for pass {pass}"))]);
                let ids = f.tick();
                assert_eq!(ids.len(), 1);
                let check = f.named(&ids, "check");
                let expected: BTreeSet<_> = [&design, &analysis, &plan].into_iter().flat_map(|id| f.output_ids(id)).collect();
                let bound = f.state.executions[&check].candidate.inputs.values().flatten().cloned().collect::<BTreeSet<_>>();
                assert_eq!(bound, expected);
                assert!(bound.is_disjoint(&previous_inputs));
                previous_inputs = bound;
                f.finish(&check, &[("check.md", &format!("Checked pass {pass}"))]);
                let ids = f.tick();
                let compare = f.named(&ids, "compare");
                f.start(&compare);
                if pass < 2 {
                    f.write(&compare, &[("ticket.md", &format!("Fresh direction for pass {}", pass + 1))]);
                } else {
                    f.write(&compare, &[("comparison.md", "Concluded comparison; no further pass warranted.")]);
                }
                let receipt = f.accept(&compare);
                assert!(matches!(receipt, CompletionOutcome::Accepted { .. }));
                assert!(f.ready().is_empty());
                f.exit(&compare);
                f.restart();
                assert_eq!(f.accept(&compare), receipt);
                if pass < 2 {
                    trigger = f.output_ids(&compare).into_iter().next().unwrap();
                    let ready = f.ready();
                    assert_eq!(ready.len(), 1);
                    assert_eq!(ready[0].step_key, "design");
                    assert_eq!(ready[0].inputs["ticket.md"], [trigger.clone()]);
                } else {
                    assert!(f.tick().is_empty());
                    assert_eq!(f.state.executions.values().filter(|e| e.candidate.step_key == "design").count(), 3);
                    assert!(f.output_ids(&compare).iter().all(|id| f.state.occurrences[id].logical_path == "comparison.md"));
                }
            }
            assert_eq!(f.state.contexts.values().filter(|c| matches!(c.cause, ContextCause::Loop { .. })).count(), 2);
        }
    }

    #[test]
    fn changed_direction_binds_fresh_trigger_and_explicit_prior_evidence() {
        use InputMode::Single;
        let mut f = Fixture::new(vec![
            step("design", &[("ticket.md", Single), ("prior-evidence.md", Single)], &["design.md"]),
            step("compare", &[("design.md", Single), ("prior-evidence.md", Single)], &["ticket.md", "comparison.md"]),
        ]);
        let evidence = f.seed("prior-evidence.md", "prior-evidence.md", "Prior evidence, retained unchanged.");
        let original_ticket = f.state.occurrences.values().find(|o| o.logical_path == "ticket.md").unwrap().clone();
        let evidence_occurrence = f.state.occurrences[&evidence].clone();
        let ids = f.tick();
        let design = f.named(&ids, "design");
        f.finish(&design, &[("design.md", "Original design.")]);
        let original_design = f.state.occurrences[&f.output_ids(&design).into_iter().next().unwrap()].clone();
        let ids = f.tick();
        let compare = f.named(&ids, "compare");
        assert_eq!(f.state.executions[&compare].candidate.inputs["prior-evidence.md"], std::slice::from_ref(&evidence));
        f.start(&compare);
        f.write(&compare, &[("ticket.md", "Human changes direction: prioritize accessibility, retain prior evidence.")]);
        assert!(matches!(f.accept(&compare), CompletionOutcome::Accepted { .. }));
        assert!(f.ready().is_empty());
        let fresh = f.output_ids(&compare).into_iter().next().unwrap();
        f.exit(&compare);
        let ids = f.tick();
        assert_eq!(ids.len(), 1);
        let next = f.named(&ids, "design");
        assert_eq!(
            f.state.executions[&next].candidate.inputs,
            BTreeMap::from([("ticket.md".into(), vec![fresh.clone()]), ("prior-evidence.md".into(), vec![evidence.clone()]),])
        );
        assert_ne!(fresh, original_ticket.id);
        assert_eq!(
            std::fs::read_to_string(crate::artifacts_dir(&f.repo, "task").join(&f.state.occurrences[&fresh].relative_path)).unwrap(),
            "Human changes direction: prioritize accessibility, retain prior evidence."
        );
        f.finish(&next, &[("design.md", "Revised accessible design using explicitly bound prior evidence.")]);
        let ids = f.tick();
        let comparison = f.named(&ids, "compare");
        assert_eq!(
            f.state.executions[&comparison].candidate.inputs["design.md"].iter().cloned().collect::<BTreeSet<_>>(),
            f.output_ids(&next)
        );
        assert_eq!(f.state.executions[&comparison].candidate.inputs["prior-evidence.md"], [evidence]);
        f.finish(&comparison, &[("comparison.md", "Human concludes the revised design.")]);
        f.restart();
        assert!(f.tick().is_empty());
        for (occurrence, bytes) in [
            (original_ticket, "2 3 5"),
            (evidence_occurrence, "Prior evidence, retained unchanged."),
            (original_design, "Original design."),
        ] {
            assert_eq!(f.state.occurrences[&occurrence.id], occurrence);
            assert_eq!(
                std::fs::read_to_string(crate::artifacts_dir(&f.repo, "task").join(&occurrence.relative_path)).unwrap(),
                bytes
            );
        }
    }

    #[test]
    fn no_results_member_routes_one_worker_and_exact_disposition_routes_handler() {
        use InputMode::{Each, Single};
        for (output, expected_step) in [("summary.md", None), ("papers/no-results.md", Some("worker")), ("no-results.md", Some("handler"))] {
            let mut f = Fixture::new(vec![
                step("source", &[("ticket.md", Single)], &["summary.md", "papers/*.md", "no-results.md"]),
                step("worker", &[("papers/*.md", Each)], &["worker-report.md"]),
                step("handler", &[("no-results.md", Single)], &["handled.md"]),
            ]);
            let ids = f.tick();
            let source = f.named(&ids, "source");
            f.start(&source);
            f.write(&source, &[(output, "No results found; this is a truthful disposition, not a paper.")]);
            assert!(matches!(f.accept(&source), CompletionOutcome::Accepted { .. }));
            assert!(f.ready().is_empty());
            f.exit(&source);
            let ids = f.tick();
            if let Some(key) = expected_step {
                assert_eq!(ids.len(), 1);
                let id = f.named(&ids, key);
                assert_eq!(
                    f.state.executions[&id].candidate.inputs.values().flatten().cloned().collect::<BTreeSet<_>>(),
                    f.output_ids(&source)
                );
            } else {
                assert!(ids.is_empty());
                assert_eq!(f.state.executions.len(), 1);
            }
            f.restart();
            assert!(f.tick().is_empty());
        }
    }
}
