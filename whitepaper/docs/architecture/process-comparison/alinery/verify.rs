//! The production parser, scheduler and completion functions execute the process.
//! Only agent results and process-start/exit boundaries are fixture supplied.
use alinery_core::execution::*;
use alinery_core::playbook::{ArtifactSelector, NormalizedPlaybook, PlaybookRef, PlaybookScope};
use alinery_core::playbook_scheduler::reconcile_graph;
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, path::PathBuf};

struct Run {
    root: PathBuf,
    definition: NormalizedPlaybook,
    state: TaskExecutionState,
    fixtures: Value,
    scenario: String,
    events: Vec<Value>,
    ready_batches: Vec<Vec<String>>,
}
impl Drop for Run {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
impl Run {
    fn new(bundle: &PathBuf, scenario: &str) -> Self {
        let source = fs::read_to_string(bundle.join("alinery/playbook.md")).unwrap();
        let definition = alinery_core::playbook::parse_playbook_md(&source).unwrap();
        let root = std::env::temp_dir().join(format!("fam-core-{}-{scenario}", std::process::id()));
        assert!(
            !root.exists(),
            "refusing to replace an existing test directory"
        );
        let reference = PlaybookRef {
            scope: PlaybookScope::Repo,
            key: definition.key.clone(),
        };
        let enabled = definition.step.iter().map(|s| s.key.clone()).collect();
        let mut state = new_execution_state(
            reference,
            &source,
            "fixture".into(),
            10,
            enabled,
            LaunchChoices::default(),
        )
        .unwrap();
        fs::create_dir_all(alinery_core::artifacts_dir(&root, "review")).unwrap();
        fs::write(task_playbook_path(&root, "review").unwrap(), source).unwrap();
        state.creation = "ready".into();
        let mut fixtures: Value =
            serde_json::from_str(&fs::read_to_string(bundle.join("shared/fixtures.json")).unwrap())
                .unwrap();
        if scenario == "duplicate_urls" {
            let a = fixtures["responses"]["discover"]["1"]["sources"][0].clone();
            let mut padded = a.clone();
            padded["url"] = json!(format!("  {}  ", a["url"].as_str().unwrap()));
            let mut blank = a.clone();
            blank["url"] = json!("   ");
            fixtures["responses"]["discover"]["1"]["sources"]
                .as_array_mut()
                .unwrap()
                .extend([padded, blank]);
            fixtures["responses"]["discover"]["2"]["sources"]
                .as_array_mut()
                .unwrap()
                .push(a);
        }
        fs::write(
            alinery_core::artifacts_dir(&root, "review").join("00-ticket.md"),
            fixtures["question"].as_str().unwrap(),
        )
        .unwrap();
        install_seed(&mut state, "ticket.md", "00-ticket.md").unwrap();
        Self {
            root,
            definition,
            state,
            fixtures,
            scenario: scenario.into(),
            events: vec![],
            ready_batches: vec![],
        }
    }
    fn tick(&mut self) {
        let candidates = reconcile_graph(&self.definition, &mut self.state).unwrap();
        for c in candidates {
            reserve_execution(
                &self.root,
                "review",
                &self.definition,
                &mut self.state,
                c,
                &LaunchChoices::default(),
                None,
                true,
            )
            .unwrap();
        }
        assert!(
            reconcile_graph(&self.definition, &mut self.state)
                .unwrap()
                .is_empty(),
            "duplicate reservation"
        );
    }
    fn inputs(&self, id: &str, selector: &str) -> Vec<Value> {
        self.state.executions[id].candidate.inputs[selector]
            .iter()
            .map(|oid| {
                let file = &self.state.occurrences[oid].relative_path;
                serde_json::from_str(
                    &fs::read_to_string(
                        alinery_core::artifacts_dir(&self.root, "review").join(file),
                    )
                    .unwrap(),
                )
                .unwrap()
            })
            .collect()
    }
    fn write(&self, id: &str, logical: &str, value: &Value) {
        let out = self.state.executions[id]
            .outputs
            .iter()
            .find(|o| {
                ArtifactSelector::parse(&o.selector)
                    .unwrap()
                    .matches(logical)
            })
            .unwrap();
        let file = if let Some((pre, suf)) = out.selector.split_once('*') {
            out.relative_path
                .replace('*', &logical[pre.len()..logical.len() - suf.len()])
        } else {
            out.relative_path.clone()
        };
        let path = alinery_core::artifacts_dir(&self.root, "review").join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let text = if logical == "review.md" {
            value.as_str().unwrap().to_string()
        } else {
            serde_json::to_string_pretty(value).unwrap()
        };
        fs::write(path, text).unwrap();
    }
    fn response(&self, phase: &str, key: &str) -> Value {
        if phase == "frame" {
            return self.fixtures["responses"][phase].clone();
        }
        let override_value = &self.fixtures["scenarios"][&self.scenario][phase][key];
        let value = if override_value.is_null() {
            &self.fixtures["responses"][phase][key]
        } else {
            override_value
        };
        assert!(!value.is_null(), "missing fixture {phase}/{key}");
        value.clone()
    }
    fn agent(&mut self, phase: &str, input: &Value) -> Value {
        let key = if phase == "read" {
            input["source"]["id"].as_str().unwrap().to_string()
        } else {
            input["state"]["round"].as_u64().unwrap_or(1).to_string()
        };
        self.events.push(json!({"phase":phase,"round":input["state"]["round"].as_u64().unwrap_or(1),"source":input["source"]["id"],"input":input}));
        self.response(phase, &key)
    }
    fn execute(&mut self, id: &str) {
        let phase = self.state.executions[id].candidate.step_key.clone();
        assert!(claim_execution_launch(&mut self.state, id).unwrap());
        let owner = self.state.executions[id].owner_session_id.clone();
        record_execution_spawn(&mut self.state, id, &owner, Ok(())).unwrap();
        match phase.as_str() {
            "frame" => {
                let v = self.agent("frame", &json!({"question":self.fixtures["question"]}));
                self.write(id, "round-request.md", &v);
            }
            "discover" => {
                let s = self.inputs(id, "round-request.md")[0].clone();
                let mut d = self.agent("discover", &json!({"state":s}));
                let mut seen = s["seen"].as_array().unwrap().clone();
                d["sources"].as_array_mut().unwrap().retain_mut(|src| {
                    src["url"] = json!(src["url"].as_str().unwrap().trim());
                    if src["url"].as_str().unwrap().is_empty() || seen.contains(&src["url"]) {
                        false
                    } else {
                        seen.push(src["url"].clone());
                        true
                    }
                });
                if d["sources"].as_array().unwrap().is_empty() {
                    self.write(id, "empty.md", &json!({"state":s,"notes":d["notes"]}));
                } else {
                    self.write(id, "batch.md", &json!({"state":s,"discovery":d}));
                    for (n, src) in d["sources"].as_array().unwrap().iter().enumerate() {
                        self.write(
                            id,
                            &format!("source-request-{:03}.md", n + 1),
                            &json!({"state":s,"source":src}),
                        );
                    }
                }
            }
            "read" => {
                let input = self.inputs(id, "source-request-*.md")[0].clone();
                let v = self.agent("read", &input);
                if v.get("__error__").is_some() {
                    confirm_execution_exit(&mut self.state, id, &owner, Some(1)).unwrap();
                    return;
                }
                self.write(id, "assessment.md", &v);
            }
            "synthesize" => {
                let b = self.inputs(id, "batch.md")[0].clone();
                let mut assessments = self.inputs(id, "assessment*.md");
                assessments.sort_by_key(|a| a["id"].as_str().unwrap().to_owned());
                let mut expected: Vec<_> = b["discovery"]["sources"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|s| s["id"].as_str().unwrap().to_owned())
                    .collect();
                expected.sort();
                assert_eq!(
                    assessments
                        .iter()
                        .map(|a| a["id"].as_str().unwrap().to_owned())
                        .collect::<Vec<_>>(),
                    expected,
                    "wrong or partial batch"
                );
                let v=self.agent("synthesize",&json!({"state":b["state"],"discovery":b["discovery"],"assessments":assessments}));
                let mut s = b["state"].clone();
                for source in b["discovery"]["sources"].as_array().unwrap() {
                    s["seen"]
                        .as_array_mut()
                        .unwrap()
                        .push(source["url"].clone());
                }
                s["assessments"].as_array_mut().unwrap().extend(assessments);
                s["synthesis"] = v["text"].clone();
                self.write(id, "synthesis.md", &json!({"state":s,"synthesis":v}));
            }
            "decide" => {
                let input = self.inputs(id, "synthesis.md")[0].clone();
                let v = self.agent("decide", &input);
                if v["continue"] == true {
                    assert!(!v["queries"].as_array().unwrap().is_empty());
                    let mut s = input["state"].clone();
                    s["round"] = json!(s["round"].as_u64().unwrap() + 1);
                    s["queries"] = v["queries"].clone();
                    self.write(id, "round-request.md", &s);
                } else {
                    self.write(id, "review.md", &v["report"]);
                }
            }
            "finish-empty" => {
                let input = self.inputs(id, "empty.md")[0].clone();
                let v = self.agent("finish_empty", &input);
                self.write(id, "review.md", &v["report"]);
            }
            _ => panic!("unknown phase"),
        }
        if self.state.executions[id].permission == CompletionPermission::Locked {
            grant_execution_completion(&mut self.state, id, &owner).unwrap();
        }
        assert!(matches!(
            accept_execution_completion(&self.root, "review", &mut self.state, id, &owner).unwrap(),
            CompletionOutcome::Accepted { .. }
        ));
        assert_eq!(
            self.state.executions[id].lifecycle,
            ExecutionLifecycle::Finishing
        );
        self.tick();
        // Acceptance alone must not release consumers while the producer is live.
        assert!(!self.state.executions.values().any(|e| e
            .candidate
            .inputs
            .values()
            .flatten()
            .any(|oid| self.state.occurrences[oid].producer_execution_id.as_deref() == Some(id))));
        confirm_execution_exit(&mut self.state, id, &owner, Some(0)).unwrap();
    }
    fn run(&mut self) -> Value {
        for _ in 0..100 {
            self.tick();
            let queued: Vec<_> = self
                .state
                .executions
                .values()
                .filter(|e| e.lifecycle == ExecutionLifecycle::Queued)
                .map(|e| e.id.clone())
                .collect();
            if queued.is_empty() {
                break;
            }
            self.ready_batches.push(
                queued
                    .iter()
                    .map(|id| self.state.executions[id].candidate.step_key.clone())
                    .collect(),
            );
            for id in queued {
                self.execute(&id);
            }
        }
        let counts = self
            .events
            .iter()
            .fold(BTreeMap::<String, usize>::new(), |mut counts, e| {
                *counts
                    .entry(e["phase"].as_str().unwrap().into())
                    .or_default() += 1;
                counts
            });
        let reports: Vec<_> = self
            .state
            .occurrences
            .values()
            .filter(|o| o.logical_path == "review.md")
            .collect();
        let expected = match self.scenario.as_str() {
            "normal" | "duplicate_urls" => [1, 2, 3, 2, 2, 0],
            "empty_first" => [1, 1, 0, 0, 0, 1],
            "empty_second" => [1, 2, 2, 1, 1, 1],
            "failed_reader" => [1, 1, 2, 0, 0, 0],
            "one_reader" => [1, 1, 1, 1, 1, 0],
            _ => panic!(),
        };
        for (phase, n) in [
            "frame",
            "discover",
            "read",
            "synthesize",
            "decide",
            "finish_empty",
        ]
        .iter()
        .zip(expected)
        {
            assert_eq!(
                counts.get(*phase).copied().unwrap_or(0),
                n,
                "{}: {phase}",
                self.scenario
            );
        }
        assert_eq!(
            reports.len(),
            if self.scenario == "failed_reader" {
                0
            } else {
                1
            }
        );
        let widths: Vec<_> = self
            .ready_batches
            .iter()
            .map(|b| b.iter().filter(|s| s.as_str() == "read").count())
            .filter(|n| *n > 0)
            .collect();
        let expected_widths = match self.scenario.as_str() {
            "normal" | "duplicate_urls" => vec![2, 1],
            "empty_first" => vec![],
            "empty_second" | "failed_reader" => vec![2],
            "one_reader" => vec![1],
            _ => panic!(),
        };
        assert_eq!(widths, expected_widths, "readers must be jointly eligible");
        json!({"scenario":self.scenario,"passed":true,"counts":counts,"events":self.events,"concurrently_eligible_reader_counts":widths,"final_reports":reports.len(),"runtime":"production alinery-core parser/scheduler/completion; simulated agents and lifecycle signals"})
    }
}
fn main() {
    let bundle = PathBuf::from(std::env::args().nth(1).expect("bundle path"));
    let mut cases = vec![];
    for scenario in [
        "normal",
        "empty_first",
        "empty_second",
        "failed_reader",
        "one_reader",
        "duplicate_urls",
    ] {
        cases.push(Run::new(&bundle, scenario).run());
    }
    let report = json!({"system":"Alinery","live_agents":false,"cases":cases});
    fs::create_dir_all(bundle.join("validation")).unwrap();
    fs::write(
        bundle.join("validation/alinery.json"),
        serde_json::to_string_pretty(&report).unwrap(),
    )
    .unwrap();
    println!("Alinery: six native core fixture cases passed");
}
