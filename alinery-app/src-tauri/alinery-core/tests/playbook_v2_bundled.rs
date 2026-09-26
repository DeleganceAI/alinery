//! Boundary workers write real assigned files; all readiness, ownership, collection,
//! permission and exit transitions below use the production execution engine.
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;

use alinery_core::execution::{
    accept_execution_completion, claim_execution_launch, confirm_execution_exit, grant_execution_completion, install_seed, new_execution_state, read_execution_state,
    read_task_playbook, record_execution_spawn, reserve_execution, task_playbook_path, CompletionOutcome, CompletionPermission, ExecutionLifecycle, LaunchChoices,
    TaskExecutionState,
};
use alinery_core::playbook::{ArtifactSelector, NormalizedPlaybook, PlaybookRef, PlaybookScope};
use alinery_core::playbook_library::{load_playbook_catalog, resolve_playbook, PlaybookRoots, BUNDLED_PLAYBOOKS};
use alinery_core::playbook_scheduler::reconcile_graph;

const SLUG: &str = "trace";

struct Trace {
    repo: PathBuf,
    roots: PlaybookRoots,
    definition: NormalizedPlaybook,
    state: TaskExecutionState,
    seed: String,
}

impl Drop for Trace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.repo);
    }
}

impl Trace {
    fn new(key: &str) -> Self {
        let roots = PlaybookRoots {
            global_config_dir: PathBuf::new(),
            repo_dir: PathBuf::new(),
        };
        let reference = PlaybookRef {
            scope: PlaybookScope::Bundled,
            key: key.into(),
        };
        Self::from_source(&resolve_playbook(&roots, &reference).unwrap().source_text)
    }

    fn from_source(source: &str) -> Self {
        let definition = alinery_core::playbook::parse_playbook_md(source).unwrap();
        let repo = std::env::temp_dir().join(format!("alinery-bundled-{}", uuid::Uuid::new_v4()));
        let roots = PlaybookRoots {
            global_config_dir: repo.join("config"),
            repo_dir: repo.clone(),
        };
        let reference = PlaybookRef {
            scope: PlaybookScope::Bundled,
            key: definition.key.clone(),
        };
        let enabled = definition.step.iter().filter(|s| s.auto_advance_default).map(|s| s.key.clone()).collect();
        let state = new_execution_state(reference, source, "trace-lane".into(), 10, enabled, LaunchChoices::default()).unwrap();
        let mut trace = Self {
            repo,
            roots,
            definition,
            state,
            seed: String::new(),
        };
        fs::create_dir_all(trace.artifacts()).unwrap();
        fs::write(task_playbook_path(&trace.repo, SLUG).unwrap(), source).unwrap();
        trace.state.creation = "ready".into();
        trace.put("00-ticket.md", "2 3 5\n");
        trace.seed = install_seed(&mut trace.state, "ticket.md", "00-ticket.md").unwrap();
        trace
    }

    fn artifacts(&self) -> PathBuf {
        alinery_core::artifacts_dir(&self.repo, SLUG)
    }

    fn put(&self, relative: &str, text: &str) {
        let path = self.artifacts().join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn tick(&mut self) {
        // Resolve every stage from the immutable retained source, not the library.
        let definition = read_task_playbook(&self.repo, SLUG, &self.state).unwrap();
        assert_eq!(definition, self.definition);
        let candidates = reconcile_graph(&definition, &mut self.state).unwrap();
        for candidate in candidates {
            reserve_execution(&self.repo, SLUG, &definition, &mut self.state, candidate, &LaunchChoices::default(), None, true).unwrap();
        }
        // Record all expectations before any worker starts, including queued workers.
        assert!(reconcile_graph(&definition, &mut self.state).unwrap().is_empty());
    }

    fn queued(&mut self, step: &str) -> Vec<String> {
        self.tick();
        self.state
            .executions
            .values()
            .filter(|e| e.candidate.step_key == step && e.lifecycle == ExecutionLifecycle::Queued)
            .map(|e| e.id.clone())
            .collect()
    }

    fn one(&mut self, step: &str) -> String {
        let ids = self.queued(step);
        assert_eq!(ids.len(), 1, "expected one eligible {step}, got {ids:?}");
        ids[0].clone()
    }

    fn blocked(&mut self, step: &str) {
        assert!(self.queued(step).is_empty(), "{step} ran early");
    }

    fn start(&mut self, id: &str) {
        assert!(claim_execution_launch(&mut self.state, id).unwrap());
        let owner = self.state.executions[id].owner_session_id.clone();
        record_execution_spawn(&mut self.state, id, &owner, Ok(())).unwrap();
    }

    fn accept(&mut self, id: &str) -> CompletionOutcome {
        let owner = self.state.executions[id].owner_session_id.clone();
        accept_execution_completion(&self.repo, SLUG, &mut self.state, id, &owner).unwrap()
    }

    fn authorize(&mut self, id: &str) {
        if self.state.executions[id].permission == CompletionPermission::Locked {
            assert_eq!(self.accept(id), CompletionOutcome::HumanAuthorizationRequired);
            assert_eq!(self.state.executions[id].lifecycle, ExecutionLifecycle::Running);
            let owner = self.state.executions[id].owner_session_id.clone();
            grant_execution_completion(&mut self.state, id, &owner).unwrap();
        }
    }

    fn accepted(&mut self, id: &str) {
        self.authorize(id);
        assert!(matches!(self.accept(id), CompletionOutcome::Accepted { .. }));
        assert_eq!(self.state.executions[id].lifecycle, ExecutionLifecycle::Finishing);
        assert!(!self.state.executions[id].shutdown_confirmed);
        assert!(self.state.executions[id].lifecycle.holds_capacity());
    }

    fn exit(&mut self, id: &str) {
        let owner = self.state.executions[id].owner_session_id.clone();
        confirm_execution_exit(&mut self.state, id, &owner, Some(0)).unwrap();
        assert_eq!(self.state.executions[id].lifecycle, ExecutionLifecycle::Completed);
    }

    fn write(&self, id: &str, logical: &str, text: &str) {
        let assignment = self.state.executions[id]
            .outputs
            .iter()
            .find(|a| ArtifactSelector::parse(&a.selector).unwrap().matches(logical))
            .unwrap();
        let physical = if let Some((prefix, suffix)) = assignment.selector.split_once('*') {
            assignment.relative_path.replace('*', &logical[prefix.len()..logical.len() - suffix.len()])
        } else {
            assignment.relative_path.clone()
        };
        self.put(&physical, text);
    }

    fn input_text(&self, id: &str, selector: &str) -> Vec<String> {
        self.state.executions[id].candidate.inputs[selector]
            .iter()
            .map(|occurrence| fs::read_to_string(self.artifacts().join(&self.state.occurrences[occurrence].relative_path)).unwrap())
            .collect()
    }

    fn numbers(&self, id: &str, selector: &str) -> Vec<i64> {
        self.input_text(id, selector)
            .iter()
            .flat_map(|s| s.split_whitespace().map(|n| n.parse::<i64>().unwrap()))
            .collect()
    }

    fn outputs(&self, id: &str) -> BTreeSet<String> {
        self.state
            .occurrences
            .values()
            .filter(|o| o.producer_execution_id.as_deref() == Some(id))
            .map(|o| o.id.clone())
            .collect()
    }

    fn output(&self, id: &str, path: &str) -> String {
        self.outputs(id).into_iter().find(|oid| self.state.occurrences[oid].logical_path == path).unwrap()
    }

    fn bound(&self, id: &str, selector: &str, expected: BTreeSet<String>) {
        let actual: BTreeSet<String> = self.state.executions[id].candidate.inputs[selector].iter().cloned().collect();
        assert_eq!(expected, actual, "incorrect {selector} binding for {id}");
        for oid in expected {
            let occurrence = &self.state.occurrences[&oid];
            assert!(self.artifacts().join(&occurrence.relative_path).is_file());
            assert!(alinery_core::execution::occurrence_deliverable(&self.state, occurrence));
        }
    }

    // Deterministic semantic boundary: retain input occurrence identities and input
    // evidence, assigning distinct requested members. This does not simulate readiness.
    fn write_handoff(&self, id: &str, members: usize) {
        let execution = &self.state.executions[id];
        let mut evidence = BTreeSet::new();
        for (selector, ids) in &execution.candidate.inputs {
            for oid in ids {
                evidence.insert(format!("input:{oid}"));
            }
            for text in self.input_text(id, selector) {
                evidence.extend(text.lines().map(str::to_owned));
            }
        }
        evidence.insert(format!("role:{}", execution.candidate.step_key));
        if execution.candidate.step_key == "analyze-name-batch" {
            for oid in &execution.candidate.inputs["raw-name-batch.md"] {
                evidence.insert(format!("raw-id:{oid}"));
                evidence.insert(format!("rejected:{oid}:ambiguous-candidate"));
            }
        }
        let body = evidence.into_iter().collect::<Vec<_>>().join("\n");
        for output in &execution.outputs {
            if output.selector.contains('*') {
                for n in 0..members {
                    let logical = output.selector.replace('*', &format!("member-{n}"));
                    self.write(id, &logical, &format!("{body}\nmember:{n}\n"));
                }
            } else {
                self.write(id, &output.selector, &body);
            }
        }
    }

    fn finish_handoff(&mut self, id: &str, members: usize) {
        self.start(id);
        self.write_handoff(id, members);
        self.accepted(id);
        self.exit(id);
    }

    fn step(&mut self, step: &str, members: usize) -> String {
        let id = self.one(step);
        self.finish_handoff(&id, members);
        id
    }

    fn collection_binding(&self, consumer: &str, selector: &str, producers: &[String]) {
        let expected = producers.iter().flat_map(|id| self.outputs(id)).collect::<BTreeSet<_>>();
        self.bound(consumer, selector, expected.clone());
        let collection_id = self.state.executions[consumer].candidate.complete_collection_id.as_ref().unwrap();
        let collection = &self.state.collections[collection_id];
        assert!(collection.membership_closed);
        assert_eq!(collection.member_occurrence_ids, expected);
        assert_eq!(collection.expected_execution_ids, producers.iter().cloned().collect());
    }

    fn batch(&mut self, worker: &str, count: usize, join: &str, selector: &str) -> (Vec<String>, String) {
        let workers = self.queued(worker);
        assert_eq!(workers.len(), count, "wrong {worker} fan-out");
        let member_ids = workers
            .iter()
            .map(|id| self.state.executions[id].candidate.each_member_id.clone().unwrap())
            .collect::<BTreeSet<_>>();
        assert_eq!(member_ids.len(), count);
        for id in &workers[..count - 1] {
            self.finish_handoff(id, 2);
        }
        self.blocked(join);
        let last = &workers[count - 1];
        self.start(last);
        self.write_handoff(last, 2);
        self.accepted(last);
        self.blocked(join);
        self.exit(last);
        let joined = self.one(join);
        self.collection_binding(&joined, selector, &workers);
        (workers, joined)
    }

    fn pause_continuation(&mut self, step: &str, entry: &str) -> String {
        let id = self.one(step);
        assert_eq!(self.state.executions[&id].permission, CompletionPermission::Locked);
        self.start(&id);
        self.blocked(entry);
        self.authorize(&id);
        assert!(matches!(self.accept(&id), CompletionOutcome::InvalidOutputs { .. }));
        self.blocked(entry);
        self.write_handoff(&id, 1);
        self.accepted(&id);
        self.blocked(entry);
        self.exit(&id);
        let next = self.one(entry);
        self.bound(&next, "ticket.md", BTreeSet::from([self.output(&id, "ticket.md")]));
        assert_ne!(self.state.executions[&next].candidate.context_id, "root");
        assert!(!self.state.executions[&next].candidate.inputs["ticket.md"].contains(&self.seed));
        next
    }
}

fn linear_trace(key: &str, stages: &[(&str, &[&str], &[&str])], human: &[&str]) {
    let mut trace = Trace::new(key);
    let mut occurrences = BTreeMap::from([("ticket.md".to_owned(), trace.seed.clone())]);
    for (index, (step, inputs, outputs)) in stages.iter().enumerate() {
        let id = trace.one(step);
        assert_eq!(
            trace.state.executions[&id].candidate.inputs.keys().map(String::as_str).collect::<BTreeSet<_>>(),
            inputs.iter().copied().collect()
        );
        for path in *inputs {
            trace.bound(&id, path, BTreeSet::from([occurrences[*path].clone()]));
        }
        assert_eq!(trace.state.executions[&id].permission == CompletionPermission::Locked, human.contains(step));
        trace.start(&id);
        trace.write_handoff(&id, 1);
        trace.accepted(&id);
        if let Some((next, _, _)) = stages.get(index + 1) {
            trace.blocked(next);
        }
        trace.exit(&id);
        assert_eq!(
            trace
                .outputs(&id)
                .iter()
                .map(|oid| trace.state.occurrences[oid].logical_path.as_str())
                .collect::<BTreeSet<_>>(),
            outputs.iter().copied().collect()
        );
        for path in *outputs {
            occurrences.insert((*path).into(), trace.output(&id, path));
        }
    }
    trace.tick();
    assert!(trace.state.executions.values().all(|e| e.lifecycle == ExecutionLifecycle::Completed));
}

#[test]
fn bundled_superdevelop_trace() {
    let defaults = alinery_core::HarnessChoice::default();
    assert_eq!(
        defaults.playbook,
        PlaybookRef {
            scope: PlaybookScope::Bundled,
            key: "superdevelop".into()
        }
    );
    linear_trace(
        "superdevelop",
        &[
            ("research-questions", &["ticket.md"], &["clarify.md"]),
            ("research", &["ticket.md", "clarify.md"], &["investigate.md"]),
            ("design", &["ticket.md", "clarify.md", "investigate.md"], &["decide.md"]),
            ("structure", &["ticket.md", "clarify.md", "investigate.md", "decide.md"], &["plan.md"]),
            ("tdd", &["ticket.md", "clarify.md", "investigate.md", "decide.md", "plan.md"], &["test-contract.md"]),
            (
                "implementation",
                &["ticket.md", "clarify.md", "investigate.md", "decide.md", "plan.md", "test-contract.md"],
                &["build-report.md"],
            ),
            (
                "pr",
                &["ticket.md", "clarify.md", "investigate.md", "decide.md", "plan.md", "test-contract.md", "build-report.md"],
                &["review-package.md"],
            ),
        ],
        &["design", "pr"],
    );
}

#[test]
fn bundled_one_shot_trace() {
    linear_trace(
        "one-shot",
        &[
            ("implementation", &["ticket.md"], &["implementation-report.md"]),
            ("pr", &["ticket.md", "implementation-report.md"], &["pr-note.md"]),
        ],
        &["implementation", "pr"],
    );
}

#[test]
fn bundled_build_playbook_is_discoverable_and_runs() {
    let trace = Trace::new("superdevelop");
    let reference = PlaybookRef {
        scope: PlaybookScope::Bundled,
        key: "build-playbook".into(),
    };
    let catalog = load_playbook_catalog(&trace.roots);
    let candidate = catalog
        .candidates
        .iter()
        .find(|candidate| candidate.source.reference == reference)
        .expect("Build a New Playbook must appear in the bundled catalog");
    assert!(candidate.diagnostics.is_empty(), "{:?}", candidate.diagnostics);
    linear_trace(
        "build-playbook",
        &[
            ("define", &["ticket.md"], &["playbook-spec.md"]),
            ("draft-refine", &["ticket.md", "playbook-spec.md"], &["candidate-playbook.md", "save-handoff.md"]),
        ],
        &["define", "draft-refine"],
    );
}

#[test]
fn numeric_demos_are_not_bundled() {
    let trace = Trace::new("superdevelop");
    let catalog = load_playbook_catalog(&trace.roots);
    for key in ["parallel-numbers", "parallel-squares"] {
        let reference = PlaybookRef {
            scope: PlaybookScope::Bundled,
            key: key.into(),
        };
        assert!(!catalog.candidates.iter().any(|candidate| candidate.source.reference == reference));
        assert!(matches!(
            resolve_playbook(&trace.roots, &reference),
            Err(alinery_core::playbook_library::PlaybookLoadError::Unknown { .. })
        ));
    }
}

#[test]
fn bundled_review_trace() {
    let mut trace = Trace::new("review");
    trace.step("review-context", 1);
    let checks = trace.one("review-checks");
    trace.put("review-findings.md", "Unowned findings cannot bypass checks");
    trace.blocked("review-findings");
    trace.start(&checks);
    trace.write_handoff(&checks, 1);
    trace.accepted(&checks);
    trace.blocked("review-findings");
    trace.exit(&checks);
    let findings = trace.one("review-findings");
    trace.bound(&findings, "review-checks.md", trace.outputs(&checks));
    trace.finish_handoff(&findings, 1);
    let response = trace.one("review-response");
    trace.bound(&response, "review-checks.md", trace.outputs(&checks));
    trace.bound(&response, "review-findings.md", trace.outputs(&findings));
    trace.bound(&response, "ticket.md", BTreeSet::from([trace.seed.clone()]));
    trace.finish_handoff(&response, 1);
    trace.tick();
    assert!(trace.state.executions.values().all(|e| e.lifecycle == ExecutionLifecycle::Completed));
}

#[test]
fn bundled_bug_hunting_trace() {
    let mut trace = Trace::new("bug-hunting");
    let rca = trace.step("rca", 1);
    let solutions = trace.one("solutions");
    trace.bound(&solutions, "root-cause-analysis.md", trace.outputs(&rca));
    trace.start(&solutions);
    trace.write(&solutions, "resolution-options.md", "Two evidenced repair options; awaiting selection");
    assert_eq!(trace.accept(&solutions), CompletionOutcome::HumanAuthorizationRequired);
    trace.blocked("design");
    trace.authorize(&solutions);
    assert!(matches!(trace.accept(&solutions), CompletionOutcome::InvalidOutputs { .. }));
    trace.blocked("design");
    trace.write(&solutions, "selected-fix.md", "Human selects the bounded correction");
    trace.accepted(&solutions);
    trace.blocked("design");
    trace.exit(&solutions);
    let design = trace.one("design");
    trace.bound(&design, "selected-fix.md", BTreeSet::from([trace.output(&solutions, "selected-fix.md")]));
    trace.finish_handoff(&design, 1);
    let implementation = trace.one("implementation");
    assert!(trace.state.executions[&implementation].is_coding_step);
    trace.bound(&implementation, "fix-design.md", trace.outputs(&design));
    trace.start(&implementation);
    trace.write_handoff(&implementation, 1);
    trace.accepted(&implementation);
    assert!(trace.state.executions[&implementation].lifecycle.holds_capacity());
    trace.blocked("pr");
    trace.exit(&implementation);
    let pr = trace.one("pr");
    trace.bound(&pr, "bug-fix-report.md", trace.outputs(&implementation));
    trace.finish_handoff(&pr, 1);
    trace.tick();
    assert!(trace.state.executions.values().all(|e| e.lifecycle == ExecutionLifecycle::Completed));
}

fn single_result_trace(key: &str, step: &str, output: &str) {
    let mut trace = Trace::new(key);
    let id = trace.one(step);
    trace.bound(&id, "ticket.md", BTreeSet::from([trace.seed.clone()]));
    // An unrelated auxiliary report has no accepted occurrence and is not this assignment.
    trace.put("terminal-result.md", "Auxiliary terminal result");
    trace.start(&id);
    trace.authorize(&id);
    assert!(matches!(trace.accept(&id), CompletionOutcome::InvalidOutputs { .. }));
    trace.write(&id, output, "Completed the assigned request with evidence");
    trace.accepted(&id);
    trace.exit(&id);
    trace.tick();
    assert_eq!(trace.state.executions.len(), 1);
}

#[test]
fn bundled_free_form_trace() {
    single_result_trace("free-form", "session", "session-result.md");
}

#[test]
fn bundled_generic_session_trace() {
    single_result_trace("generic-session", "complete-the-request", "result.md");
    let generic = Trace::new("generic-session");
    let free = resolve_playbook(
        &generic.roots,
        &PlaybookRef {
            scope: PlaybookScope::Bundled,
            key: "free-form".into(),
        },
    )
    .unwrap();
    assert_ne!(generic.state.reference, free.source.reference);
    assert_ne!(generic.definition, free.definition);
}

#[test]
fn bundled_primed_feature_development_trace() {
    linear_trace(
        "primed-feature-development",
        &[
            ("probe-the-question", &["ticket.md"], &["question-map.md"]),
            ("research-the-problem", &["ticket.md", "question-map.md"], &["research-findings.md"]),
            ("identify-the-direction", &["ticket.md", "question-map.md", "research-findings.md"], &["direction.md"]),
            (
                "map-the-plan",
                &["ticket.md", "question-map.md", "research-findings.md", "direction.md"],
                &["implementation-plan.md"],
            ),
            (
                "establish-the-test-contract",
                &["ticket.md", "question-map.md", "research-findings.md", "direction.md", "implementation-plan.md"],
                &["test-contract.md"],
            ),
            (
                "develop-the-change",
                &[
                    "ticket.md",
                    "question-map.md",
                    "research-findings.md",
                    "direction.md",
                    "implementation-plan.md",
                    "test-contract.md",
                ],
                &["development-report.md"],
            ),
        ],
        &["identify-the-direction", "develop-the-change"],
    );
}

#[test]
fn parallel_numbers_fixture_trace() {
    let mut trace = Trace::from_source(include_str!("fixtures/parallel-numbers.md"));
    let seed = trace.one("seed");
    trace.start(&seed);
    let numbers = trace.input_text(&seed, "ticket.md").join(" ");
    trace.write(&seed, "numbers.md", &numbers);
    trace.accepted(&seed);
    trace.blocked("sum");
    trace.blocked("product");
    trace.exit(&seed);
    let sum = trace.one("sum");
    let product = trace.one("product");
    trace.bound(&sum, "numbers.md", trace.outputs(&seed));
    trace.bound(&product, "numbers.md", trace.outputs(&seed));
    trace.start(&sum);
    trace.start(&product);
    trace.write(&sum, "sum.md", &trace.numbers(&sum, "numbers.md").iter().sum::<i64>().to_string());
    trace.write(&product, "product.md", &trace.numbers(&product, "numbers.md").iter().product::<i64>().to_string());
    trace.accepted(&sum);
    trace.exit(&sum);
    trace.blocked("combine");
    trace.accepted(&product);
    trace.blocked("combine");
    trace.exit(&product);
    let combine = trace.one("combine");
    trace.bound(&combine, "sum.md", trace.outputs(&sum));
    trace.bound(&combine, "product.md", trace.outputs(&product));
    let total = trace.numbers(&combine, "sum.md").iter().chain(trace.numbers(&combine, "product.md").iter()).sum::<i64>();
    trace.start(&combine);
    trace.write(&combine, "final.md", &total.to_string());
    trace.accepted(&combine);
    trace.exit(&combine);
    let result = trace.output(&combine, "final.md");
    assert_eq!(fs::read_to_string(trace.artifacts().join(&trace.state.occurrences[&result].relative_path)).unwrap(), "40");
}

#[test]
fn parallel_squares_fixture_trace() {
    let mut trace = Trace::from_source(include_str!("fixtures/parallel-squares.md"));
    let seed = trace.one("seed");
    trace.start(&seed);
    let values = trace.numbers(&seed, "ticket.md");
    for (name, value) in ["violet", "copper", "cloud"].iter().zip(values) {
        trace.write(&seed, &format!("request-{name}.md"), &value.to_string());
    }
    trace.accepted(&seed);
    trace.exit(&seed);
    let workers = trace.queued("square");
    assert_eq!(workers.len(), 3);
    let held = workers.iter().find(|id| trace.numbers(id, "request-*.md") == [3]).unwrap().clone();
    for id in &workers {
        trace.start(id);
        let number = trace.numbers(id, "request-*.md")[0];
        trace.write(id, "result-square.md", &(number * number).to_string());
        if *id != held {
            trace.accepted(id);
            trace.exit(id);
        }
    }
    trace.put("result-unowned.md", "900");
    trace.blocked("collect");
    trace.accepted(&held);
    trace.blocked("collect");
    trace.exit(&held);
    let collect = trace.one("collect");
    trace.collection_binding(&collect, "result-*.md", &workers);
    let total = trace.numbers(&collect, "result-*.md").iter().sum::<i64>();
    trace.start(&collect);
    trace.write(&collect, "final.md", &total.to_string());
    trace.accepted(&collect);
    trace.exit(&collect);
    let result = trace.output(&collect, "final.md");
    assert_eq!(fs::read_to_string(trace.artifacts().join(&trace.state.occurrences[&result].relative_path)).unwrap(), "38");
}

fn brainstorm_pass(trace: &mut Trace, frame: &str, count: usize) -> BTreeSet<String> {
    trace.finish_handoff(frame, count);
    let (blind, wall) = trace.batch("generate-possibilities", count, "harvest-the-idea-wall", "blind-idea-*.md");
    trace.bound(&wall, "brainstorm-brief.md", BTreeSet::from([trace.output(frame, "brainstorm-brief.md")]));
    trace.finish_handoff(&wall, 3);
    let (shared, harvest) = trace.batch("cross-pollinate-possibilities", 3, "harvest-shared-wall", "shared-idea-*.md");
    trace.bound(&harvest, "first-idea-wall.md", BTreeSet::from([trace.output(&wall, "first-idea-wall.md")]));
    trace.finish_handoff(&harvest, 1);
    let shape = trace.one("shape-the-options");
    trace.bound(&shape, "cumulative-idea-wall.md", trace.outputs(&harvest));
    trace.finish_handoff(&shape, 1);
    let next = trace.one("define-next-actions");
    assert_eq!(trace.state.executions[&next].permission, CompletionPermission::Locked);
    trace.bound(&next, "organized-options.md", trace.outputs(&shape));
    trace.start(&next);
    trace.write_handoff(&next, 1);
    trace.accepted(&next);
    trace.blocked("continue-brainstorm");
    trace.exit(&next);
    blind.iter().chain(&shared).flat_map(|id| trace.outputs(id)).collect()
}

#[test]
fn bundled_natural_planning_brainstorm_trace() {
    let mut trace = Trace::new("natural-planning-brainstorm");
    let frame = trace.one("frame-the-challenge");
    let first = brainstorm_pass(&mut trace, &frame, 7);
    let fresh = trace.pause_continuation("continue-brainstorm", "frame-the-challenge");
    let second = brainstorm_pass(&mut trace, &fresh, 2);
    assert!(first.is_disjoint(&second));
    let second_context = &trace.state.executions[&fresh].candidate.context_id;
    for execution in trace.state.executions.values().filter(|e| &e.candidate.context_id == second_context) {
        assert!(execution.candidate.inputs.values().flatten().all(|id| !first.contains(id)));
    }
}

fn naming_pass(trace: &mut Trace, frame: &str) -> BTreeSet<String> {
    trace.finish_handoff(frame, 1);
    let plan = trace.step("plan-generation-wave", 4);
    let generators = trace.queued("generate-name-batch");
    assert_eq!(generators.len(), 4);
    let requests = trace.outputs(&plan);
    assert_eq!(
        generators
            .iter()
            .map(|id| trace.state.executions[id].candidate.each_member_id.clone().unwrap())
            .collect::<BTreeSet<_>>(),
        requests
    );
    for id in &generators {
        trace.finish_handoff(id, 1);
    }
    let analyses = trace.queued("analyze-name-batch");
    assert_eq!(analyses.len(), 4);
    let raw = generators.iter().flat_map(|id| trace.outputs(id)).collect::<BTreeSet<_>>();
    assert_eq!(
        analyses
            .iter()
            .flat_map(|id| trace.state.executions[id].candidate.inputs["raw-name-batch.md"].clone())
            .collect::<BTreeSet<_>>(),
        raw
    );
    for id in &analyses[..3] {
        trace.finish_handoff(id, 1);
    }
    trace.blocked("assemble-candidate-universe");
    let delayed = &analyses[3];
    trace.start(delayed);
    trace.write_handoff(delayed, 1);
    trace.accepted(delayed);
    trace.blocked("assemble-candidate-universe");
    trace.exit(delayed);
    let universe = trace.one("assemble-candidate-universe");
    trace.collection_binding(&universe, "analyzed-name-*.md", &analyses);
    let evidence = trace.input_text(&universe, "analyzed-name-*.md").join("\n");
    for id in &raw {
        assert!(evidence.lines().any(|line| line == format!("raw-id:{id}")));
        assert!(evidence.lines().any(|line| line == format!("rejected:{id}:ambiguous-candidate")));
    }
    trace.finish_handoff(&universe, 2);
    let (rankers, summary) = trace.batch("rank-name-group", 2, "resolve-ranking-wave", "group-ranking-*.md");
    trace.bound(&summary, "candidate-universe.md", BTreeSet::from([trace.output(&universe, "candidate-universe.md")]));
    trace.finish_handoff(&summary, 1);
    let shortlist = trace.one("review-finalists-with-human");
    assert_eq!(trace.state.executions[&shortlist].permission, CompletionPermission::Locked);
    trace.bound(&shortlist, "ranking-wave-summary.md", trace.outputs(&summary));
    trace.start(&shortlist);
    trace.write_handoff(&shortlist, 2);
    assert_eq!(trace.accept(&shortlist), CompletionOutcome::HumanAuthorizationRequired);
    trace.blocked("research-one-finalist");
    trace.accepted(&shortlist);
    trace.blocked("research-one-finalist");
    trace.exit(&shortlist);
    let (diligence, decision) = trace.batch("research-one-finalist", 2, "decide-name-with-human", "diligence-results/*.md");
    trace.bound(&decision, "approved-shortlist.md", BTreeSet::from([trace.output(&shortlist, "approved-shortlist.md")]));
    assert_eq!(trace.state.executions[&decision].permission, CompletionPermission::Locked);
    trace.finish_handoff(&decision, 1);
    generators
        .iter()
        .chain(&analyses)
        .chain(&rankers)
        .chain(&diligence)
        .flat_map(|id| trace.outputs(id))
        .collect()
}

#[test]
fn bundled_systematic_naming_trace() {
    let mut trace = Trace::new("systematic-naming");
    let frame = trace.one("frame-naming-brief");
    let old = naming_pass(&mut trace, &frame);
    let fresh = trace.pause_continuation("continue-naming", "frame-naming-brief");
    let before = trace.state.executions.keys().cloned().collect::<BTreeSet<_>>();
    let new = naming_pass(&mut trace, &fresh);
    assert!(old.is_disjoint(&new));
    for execution in trace.state.executions.values().filter(|e| !before.contains(&e.id)) {
        assert!(execution.candidate.inputs.values().flatten().all(|id| !old.contains(id)));
    }
}

// A and B consume one source collection independently. Each local aggregate
// consumes exactly one result family; the outer AND join receives only the two
// aggregate occurrences, never the raw screening/extraction descendants.
fn independent_lanes(
    trace: &mut Trace,
    workers: [&str; 2],
    aggregates: [&str; 2],
    selectors: [&str; 2],
    aggregate_outputs: [&str; 2],
    resolver: &str,
) -> (String, BTreeSet<String>) {
    let a = trace.queued(workers[0]);
    let b = trace.queued(workers[1]);
    assert_eq!(a.len(), 2);
    assert_eq!(b.len(), 2);
    let members = |ids: &[String]| {
        ids.iter()
            .map(|id| trace.state.executions[id].candidate.each_member_id.clone().unwrap())
            .collect::<BTreeSet<_>>()
    };
    assert_eq!(members(&a), members(&b));
    let (a, merge_a) = trace.batch(workers[0], 2, aggregates[0], selectors[0]);
    trace.finish_handoff(&merge_a, 1);
    trace.blocked(resolver);
    let (b, merge_b) = trace.batch(workers[1], 2, aggregates[1], selectors[1]);
    trace.start(&merge_b);
    trace.write_handoff(&merge_b, 1);
    trace.accepted(&merge_b);
    trace.blocked(resolver);
    trace.exit(&merge_b);
    let join = trace.one(resolver);
    trace.bound(&join, aggregate_outputs[0], trace.outputs(&merge_a));
    trace.bound(&join, aggregate_outputs[1], trace.outputs(&merge_b));
    assert!(trace.state.executions[&join].candidate.complete_collection_id.is_none());
    let raw = a.iter().chain(&b).flat_map(|id| trace.outputs(id)).collect::<BTreeSet<_>>();
    assert!(trace.state.executions[&join].candidate.inputs.values().flatten().all(|id| !raw.contains(id)));
    (join, raw)
}

fn evidence_pass(trace: &mut Trace, method: &str) -> BTreeSet<String> {
    trace.finish_handoff(method, 1);
    trace.step("develop-protocol", 1);
    let validation = trace.one("validate-and-approve-search");
    assert_eq!(trace.state.executions[&validation].permission, CompletionPermission::Locked);
    trace.start(&validation);
    // Empty search request families cannot become successful empty merges.
    trace.write_handoff(&validation, 0);
    trace.authorize(&validation);
    assert!(matches!(trace.accept(&validation), CompletionOutcome::InvalidOutputs { .. }));
    trace.blocked("run-one-search");
    trace.write_handoff(&validation, 2);
    trace.accepted(&validation);
    trace.blocked("run-one-search");
    trace.exit(&validation);
    let (searches, merge) = trace.batch("run-one-search", 2, "merge-search-wave", "search-results/*.md");
    trace.finish_handoff(&merge, 1);
    let screening = trace.step("prepare-screening-wave", 2);
    let (title, mut raw) = independent_lanes(
        trace,
        ["screen-title-abstract-a", "screen-title-abstract-b"],
        ["aggregate-title-a", "aggregate-title-b"],
        ["title-screen-a/*.md", "title-screen-b/*.md"],
        ["title-a-complete.md", "title-b-complete.md"],
        "resolve-title-abstract-wave",
    );
    assert_eq!(trace.state.executions[&title].permission, CompletionPermission::Locked);
    trace.finish_handoff(&title, 1);
    trace.step("retrieve-full-text", 2);
    let (full_text, full_raw) = independent_lanes(
        trace,
        ["screen-full-text-a", "screen-full-text-b"],
        ["aggregate-full-text-a", "aggregate-full-text-b"],
        ["full-text-a/*.md", "full-text-b/*.md"],
        ["full-text-a-complete.md", "full-text-b-complete.md"],
        "resolve-full-text-wave",
    );
    trace.bound(&full_text, "candidate-ledger.md", BTreeSet::from([trace.output(&screening, "candidate-ledger.md")]));
    trace.finish_handoff(&full_text, 1);
    let audit = trace.one("audit-and-freeze-corpus");
    assert_eq!(trace.state.executions[&audit].permission, CompletionPermission::Locked);
    trace.bound(&audit, "eligibility-ledger.md", BTreeSet::from([trace.output(&full_text, "eligibility-ledger.md")]));
    trace.finish_handoff(&audit, 1);
    let extraction = trace.one("prepare-and-pilot-extraction");
    trace.bound(&extraction, "frozen-corpus.md", BTreeSet::from([trace.output(&audit, "frozen-corpus.md")]));
    trace.start(&extraction);
    // A no-included-study disposition must stay at a human boundary; it cannot
    // silently accept an empty required extraction collection.
    trace.write_handoff(&extraction, 0);
    trace.authorize(&extraction);
    assert!(matches!(trace.accept(&extraction), CompletionOutcome::InvalidOutputs { .. }));
    trace.blocked("extract-and-code-a");
    trace.blocked("extract-and-code-b");
    trace.write_handoff(&extraction, 2);
    trace.accepted(&extraction);
    trace.exit(&extraction);
    let (reconcile, extracted) = independent_lanes(
        trace,
        ["extract-and-code-a", "extract-and-code-b"],
        ["aggregate-extraction-a", "aggregate-extraction-b"],
        ["extraction-a/*.md", "extraction-b/*.md"],
        ["extraction-a-complete.md", "extraction-b-complete.md"],
        "reconcile-study-evidence",
    );
    trace.bound(&reconcile, "extraction-plan.md", BTreeSet::from([trace.output(&extraction, "extraction-plan.md")]));
    trace.finish_handoff(&reconcile, 2);
    trace.step("plan-synthesis", 2);
    let (synthesis, draft) = trace.batch("synthesize-unit", 2, "draft-review", "synthesis-results/*.md");
    trace.bound(&draft, "audited-corpus-ledger.md", BTreeSet::from([trace.output(&audit, "audited-corpus-ledger.md")]));
    trace.bound(
        &draft,
        "approved-review-protocol.md",
        BTreeSet::from([trace.output(&validation, "approved-review-protocol.md")]),
    );
    trace.start(&draft);
    trace.write_handoff(&draft, 1);
    trace.accepted(&draft);
    trace.blocked("publication-audit");
    trace.exit(&draft);
    let publication = trace.one("publication-audit");
    assert_eq!(trace.state.executions[&publication].permission, CompletionPermission::Locked);
    for output in &trace.state.executions[&draft].outputs {
        trace.bound(&publication, &output.selector, BTreeSet::from([trace.output(&draft, &output.selector)]));
    }
    trace.finish_handoff(&publication, 1);
    raw.extend(full_raw);
    raw.extend(extracted);
    raw.extend(searches.iter().chain(&synthesis).flat_map(|id| trace.outputs(id)));
    raw
}

#[test]
fn bundled_systematic_evidence_review_trace() {
    let mut trace = Trace::new("systematic-evidence-review");
    let method = trace.one("select-review-method");
    let old = evidence_pass(&mut trace, &method);
    let fresh = trace.pause_continuation("continue-evidence-review", "select-review-method");
    let before = trace.state.executions.keys().cloned().collect::<BTreeSet<_>>();
    let new = evidence_pass(&mut trace, &fresh);
    assert!(old.is_disjoint(&new));
    for execution in trace.state.executions.values().filter(|e| !before.contains(&e.id)) {
        assert!(execution.candidate.inputs.values().flatten().all(|id| !old.contains(id)));
    }
}

#[test]
fn bundled_codebase_research_trace() {
    let trace = Trace::new("codebase-research");
    assert!(trace.definition.step.iter().all(|step| !step.is_coding_step));
    linear_trace(
        "codebase-research",
        &[
            ("frame", &["ticket.md"], &["research-brief.md"]),
            ("discover", &["research-brief.md"], &["candidate-ledger.md"]),
            ("inspect", &["research-brief.md", "candidate-ledger.md"], &["implementation-evidence.md"]),
            (
                "compare",
                &["research-brief.md", "candidate-ledger.md", "implementation-evidence.md"],
                &["approach-comparison.md"],
            ),
            (
                "recommend",
                &["research-brief.md", "candidate-ledger.md", "implementation-evidence.md", "approach-comparison.md"],
                &["recommendation.md"],
            ),
        ],
        &["recommend"],
    );
}

#[test]
fn bundled_catalog_ignores_legacy_without_rewriting_bytes() {
    let trace = Trace::new("superdevelop");
    let registry = trace.repo.join(".alinery/playbooks.toml");
    let prompt = trace.repo.join(".alinery/playbooks/custom-prompt.md");
    fs::create_dir_all(prompt.parent().unwrap()).unwrap();
    let registry_bytes = b"legacy registry bytes\n[playbook.custom]\ntitle = 'Old'\n";
    let prompt_bytes = b"# Legacy custom prompt\nDo not convert or overwrite.\n";
    fs::write(&registry, registry_bytes).unwrap();
    fs::write(&prompt, prompt_bytes).unwrap();
    let catalog = load_playbook_catalog(&trace.roots);
    assert_eq!(catalog.candidates.len(), BUNDLED_PLAYBOOKS.len());
    assert!(catalog.candidates.iter().all(|candidate| candidate.source.reference.scope == PlaybookScope::Bundled));
    assert!(resolve_playbook(
        &trace.roots,
        &PlaybookRef {
            scope: PlaybookScope::Repo,
            key: "custom".into()
        }
    )
    .is_err());
    assert!(read_execution_state(&trace.repo, "pre-v2-task").is_err());
    assert_eq!(fs::read(&registry).unwrap(), registry_bytes);
    assert_eq!(fs::read(&prompt).unwrap(), prompt_bytes);
}
