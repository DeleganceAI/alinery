//! Real isolated daemon/process tests. The shell is an external harness fixture,
//! not a substitute scheduler or completion implementation.
use alinery_core::{
    daemon_client::{DaemonClient, UiControlConnection},
    execution::{read_execution_state, CompletionOutcome, ExecutionLifecycle, ExecutionRecord, TaskExecutionState},
    task_creation::*,
    RUNNER_EVENT_PROTOCOL_VERSION,
};
use serde_json::{json, Value};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

struct Fixture {
    root: PathBuf,
    child: Child,
    client: DaemonClient,
}
impl Fixture {
    fn new() -> Self {
        let root = PathBuf::from(format!("/tmp/al-v2-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".alinery")).unwrap();
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "fixture@example.invalid"],
            vec!["config", "user.name", "Fixture"],
            vec!["commit", "--allow-empty", "-qm", "initial"],
        ] {
            assert!(alinery_core::git_cmd(&root).args(args).status().unwrap().success());
        }
        let runner = root.join("runner");
        fs::write(
            &runner,
            format!(
                "#!/bin/sh\nprintf '%s' \"$ALINERY_EVENT_TOKEN\" > '{}/token-'\"$ALINERY_SESSION_ID\"\nshift 4\nexec \"$@\"\n",
                root.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&runner, fs::Permissions::from_mode(0o755)).unwrap();
        let harness = root.join("harness");
        fs::write(&harness, format!("#!/bin/sh\npwd > '{0}/cwd-'\"$ALINERY_SESSION_ID\"\nprintf '{{\"type\":\"ready\"}}\\n'\nwhile [ ! -f '{0}/release-'\"$ALINERY_SESSION_ID\" ]; do sleep 0.02; done\nprintf '{{\"type\":\"fixture_final_output\"}}\\n'\n", root.display())).unwrap();
        fs::set_permissions(&harness, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(
            root.join(".alinery/harnesses.toml"),
            format!(
                "[[harness]]\nkey='omp'\nname='Fixture'\nbinary='{}'\nargs=[]\nmodel_arg=[]\nprompt_injection='arg'\nadapter='omp'\n",
                harness.display()
            ),
        )
        .unwrap();
        let child = Command::new(env!("CARGO_BIN_EXE_alineryd"))
            .args(["--repo", root.to_str().unwrap(), "--app-config", root.join("app.toml").to_str().unwrap()])
            .env("ALINERY_RUNNER_PATH", &runner)
            .env("ALINERY_HOST_EXECUTABLE", std::env::current_exe().unwrap())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let client = DaemonClient {
            socket_path: root.join(".alinery/alineryd.sock"),
        };
        wait(|| client.version_checked().is_ok());
        Self { root, child, client }
    }
    fn create(&self, start: bool, automatic: bool) -> CreateTaskReply {
        self.create_with(&definition(), 1, if automatic { &["first", "second", "join"] } else { &["second", "join"] }, start)
    }
    fn create_with(&self, source: &str, capacity: u32, enabled: &[&str], start: bool) -> CreateTaskReply {
        self.client.create_task(&serde_json::from_value(json!({"name":"Fixture","requested_slug":"fixture","description":"ticket","playbook":{"reference":{"scope":"bundled","key":"fixture"},"source":source},"max_live_sessions":capacity,"auto_advance_steps":enabled,"start":start})).unwrap()).unwrap()
    }
    fn state(&self) -> TaskExecutionReply {
        self.client.get_task_execution(&GetTaskExecutionRequest { task_slug: "fixture".into() }).unwrap()
    }
    fn event(&self, session: &str) -> Value {
        let token = fs::read_to_string(self.root.join(format!("token-{session}"))).unwrap();
        self.client.call(&json!({"op":"event","version":RUNNER_EVENT_PROTOCOL_VERSION,"session_id":session,"token":token,"event":{"type":"phase_completed","omp_session_id":"fixture","omp_turn_id":1}})).unwrap()
    }
    fn outputs(&self, record: &alinery_core::execution::ExecutionRecord) {
        for output in &record.outputs {
            fs::write(self.root.join(".alinery/tasks/fixture/artifacts").join(&output.relative_path), "accepted evidence").unwrap();
        }
    }
    fn release(&self, id: &str) {
        fs::write(self.root.join(format!("release-{id}")), "exit").unwrap();
    }
    fn persisted(&self) -> TaskExecutionState {
        read_execution_state(&self.root, "fixture").unwrap()
    }
    fn wait_state(&self, expected: &str, mut condition: impl FnMut(&TaskExecutionState) -> bool) {
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            let state = self.persisted();
            if condition(&state) {
                return;
            }
            assert!(Instant::now() < until, "{expected}; persisted state:\n{state:#?}");
            thread::sleep(Duration::from_millis(10));
        }
    }
    fn start(&self, record: &ExecutionRecord) -> CreateExecutionSessionReply {
        self.client
            .start_session(&StartSessionRequest {
                task_slug: "fixture".into(),
                session_id: record.owner_session_id.clone(),
            })
            .unwrap()
    }
    fn accept(&self, record: &ExecutionRecord) -> Value {
        self.wait_state(&format!("{} ({}) must be Running before acceptance", record.candidate.step_key, record.id), |state| {
            state.executions[&record.id].lifecycle == ExecutionLifecycle::Running
        });
        wait(|| self.root.join(format!("token-{}", record.owner_session_id)).exists());
        self.outputs(record);
        let mut outcome = self.event(&record.owner_session_id);
        if outcome["completion"]["status"] == "human_authorization_required" {
            let mut ui = UiControlConnection::connect(&self.client).unwrap();
            ui.allow_execution_completion(&AllowExecutionCompletionRequest {
                task_slug: "fixture".into(),
                execution_id: record.id.clone(),
                session_id: record.owner_session_id.clone(),
            })
            .unwrap();
            outcome = self.event(&record.owner_session_id);
        }
        assert_eq!(outcome["completion"]["status"], "accepted");
        assert_eq!(self.persisted().executions[&record.id].lifecycle, ExecutionLifecycle::Finishing);
        outcome
    }
    fn finish(&self, record: &ExecutionRecord) {
        self.accept(record);
        self.release(&record.owner_session_id);
        self.wait_state(&format!("{} ({}) must complete after fixture release", record.candidate.step_key, record.id), |state| {
            state.executions[&record.id].lifecycle == ExecutionLifecycle::Completed
        });
        assert!(self.persisted().executions[&record.id].shutdown_confirmed);
    }
    fn restart_quiescent(&mut self) {
        let state = self.persisted();
        assert!(state.executions.values().all(|record| {
            (record.lifecycle == ExecutionLifecycle::Queued && !record.start_requested) || (record.lifecycle == ExecutionLifecycle::Completed && record.shutdown_confirmed)
        }));
        self.client.call(&json!({"op":"shutdown"})).unwrap();
        assert!(self.child.wait().unwrap().success());
        self.child = Command::new(env!("CARGO_BIN_EXE_alineryd"))
            .args(["--repo", self.root.to_str().unwrap(), "--app-config", self.root.join("app.toml").to_str().unwrap()])
            .env("ALINERY_RUNNER_PATH", self.root.join("runner"))
            .env("ALINERY_HOST_EXECUTABLE", std::env::current_exe().unwrap())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        wait(|| self.client.version_checked().is_ok());
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.client.call(&json!({"op":"shutdown"}));
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn wait(mut condition: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(Instant::now() < until, "fixture condition timed out");
        thread::sleep(Duration::from_millis(10));
    }
}
fn definition() -> String {
    let mut source = "+++\nversion=2\nkey='fixture'\ntitle='Fixture'\ndescription=''\ndefault_model=''\ndefault_harness='omp'\n".to_string();
    for (key, inputs, output) in [
        ("first", "[]", "one.md"),
        ("second", "[]", "two.md"),
        ("join", "[{path='one.md',mode='single'},{path='two.md',mode='single'}]", "joined.md"),
    ] {
        source.push_str(&format!("[[step]]\nkey='{key}'\ntitle='{key}'\nshort=''\ninputs={inputs}\noutputs=[{{path='{output}'}}]\nmodel=''\nharness=''\nis_coding_step=true\nauto_advance_default=false\n"));
    }
    source.push_str("+++\n");
    for key in ["first", "second", "join"] {
        source.push_str(&format!("<!-- alinery:step {key} -->\nWrite your assigned outputs.\n"));
    }
    source
}

#[test]
fn auxiliary_sessions_inherit_current_settings_without_overriding_explicit_models_or_terminal() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("app.toml"), "[global.defaults]\nharness='omp'\nmodel='provider/global'\n").unwrap();
    fixture.create(false, true);
    let create = |harness: &str, model: Option<&str>| {
        fixture
            .client
            .create_execution_session(&CreateExecutionSessionRequest {
                task_slug: "fixture".into(),
                target: ExecutionSessionTarget::Auxiliary {
                    harness: harness.into(),
                    model: model.map(str::to_owned),
                    prompt: None,
                },
                launch_override: None,
                prompt_extra: None,
                handoff_artifact: None,
                start: false,
            })
            .unwrap()
            .session
    };
    assert_eq!(create("omp", None).model, "provider/global");
    assert_eq!(create("omp", Some("")).model, "provider/global");
    assert_eq!(create("omp", Some("provider/explicit")).model, "provider/explicit");
    assert_eq!(create("no-harness", None).model, "");

    fs::write(fixture.root.join(".alinery/config.toml"), "[defaults]\nmodel='provider/repository'\n").unwrap();
    let repository_session = create("omp", None);
    assert_eq!(repository_session.model, "provider/repository");
    fs::write(fixture.root.join(".alinery/config.toml"), "[defaults]\nmodel=''\n").unwrap();
    assert_eq!(create("omp", None).model, "");
    let saved = alinery_core::read_session_meta_full(&alinery_core::session_meta_path(&fixture.root, "fixture", &repository_session.id)).unwrap();
    assert_eq!(saved.model, "provider/repository", "settings changes must not rewrite existing sessions");
}

#[test]
fn subtask_manager_inherits_chat_default_instead_of_retained_task_model() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("app.toml"), "[global.defaults]\nharness='omp'\nmodel='provider/old'\n").unwrap();
    fixture.create(false, true);
    fs::write(fixture.root.join("app.toml"), "[global.defaults]\nharness='omp'\nmodel='provider/current'\n").unwrap();
    let manager = fixture
        .client
        .create_execution_session(&CreateExecutionSessionRequest {
            task_slug: "fixture".into(),
            target: ExecutionSessionTarget::SubtaskManager {
                subtask_slug: None,
                recover: false,
                harness: "omp".into(),
                model: None,
            },
            launch_override: None,
            prompt_extra: None,
            handoff_artifact: None,
            start: false,
        })
        .unwrap();
    assert_eq!(manager.session.model, "provider/current");
}

#[test]
fn held_roots_and_coding_capacity_are_durable_and_individual_start_isolated() {
    let fixture = Fixture::new();
    let created = fixture.create(false, true);
    assert_eq!(created.creation, "ready");
    assert_eq!(created.sessions.len(), 2);
    assert!(created.executions.iter().all(|r| !r.start_requested && r.lifecycle == ExecutionLifecycle::Queued));
    let first = created.executions.iter().find(|r| r.candidate.step_key == "first").unwrap();
    let second = created.executions.iter().find(|r| r.candidate.step_key == "second").unwrap();
    let started = fixture
        .client
        .start_session(&StartSessionRequest {
            task_slug: "fixture".into(),
            session_id: first.owner_session_id.clone(),
        })
        .unwrap();
    assert_eq!(started.start, "started");
    assert!(!fixture.state().state.executions[&second.id].start_requested);
    let queued = fixture
        .client
        .start_session(&StartSessionRequest {
            task_slug: "fixture".into(),
            session_id: second.owner_session_id.clone(),
        })
        .unwrap();
    assert_eq!(queued.start, "queued");
    wait(|| fixture.root.join(format!("token-{}", first.owner_session_id)).exists());
    fixture.outputs(first);
    let outcome = fixture.event(&first.owner_session_id);
    assert_eq!(outcome["completion"]["status"], "accepted");
    assert_eq!(fixture.event(&first.owner_session_id)["completion"]["receipt_id"], outcome["completion"]["receipt_id"]);
    let state = fixture.state().state;
    assert_eq!(state.executions[&first.id].lifecycle, ExecutionLifecycle::Finishing);
    assert_eq!(state.executions[&second.id].lifecycle, ExecutionLifecycle::Queued);
    assert!(!fixture.root.join(format!("token-{}", second.owner_session_id)).exists());
    fixture.release(&first.owner_session_id);
    wait(|| fixture.state().state.executions[&second.id].lifecycle == ExecutionLifecycle::Running);
    assert!(fixture.state().state.executions[&first.id].shutdown_confirmed);
    assert!(!fixture.state().state.executions.values().any(|r| r.candidate.step_key == "join"));
    fixture.outputs(second);
    wait(|| fixture.root.join(format!("token-{}", second.owner_session_id)).exists());
    assert_eq!(fixture.event(&second.owner_session_id)["completion"]["status"], "accepted");
    fixture.release(&second.owner_session_id);
    wait(|| {
        fixture
            .state()
            .state
            .executions
            .values()
            .any(|r| r.candidate.step_key == "join" && r.lifecycle == ExecutionLifecycle::Running)
    });
}

#[test]
fn only_retained_authenticated_ui_channel_grants_the_current_owner() {
    let fixture = Fixture::new();
    let source = definition().replace("outputs=[{path='one.md'}]", "outputs=[{path='one.md'},{path='summary.md'}]");
    let created = fixture.client.create_task(&serde_json::from_value(json!({"name":"Fixture","requested_slug":"fixture","description":"ticket","playbook":{"reference":{"scope":"bundled","key":"fixture"},"source":source},"max_live_sessions":1,"auto_advance_steps":["second","join"],"start":false})).unwrap()).unwrap();
    let first = created.executions.iter().find(|r| r.candidate.step_key == "first").unwrap();
    fixture
        .client
        .start_session(&StartSessionRequest {
            task_slug: "fixture".into(),
            session_id: first.owner_session_id.clone(),
        })
        .unwrap();
    wait(|| fixture.root.join(format!("token-{}", first.owner_session_id)).exists());
    fixture.outputs(first);
    let locked: CompletionOutcome = serde_json::from_value(fixture.event(&first.owner_session_id)["completion"].clone()).unwrap();
    assert_eq!(locked, CompletionOutcome::HumanAuthorizationRequired);
    assert_eq!(
        fixture.client.call(&json!({"op":"status","id":first.owner_session_id})).unwrap()["agent"]["state"],
        "waiting_for_approval"
    );
    let grant = AllowExecutionCompletionRequest {
        task_slug: "fixture".into(),
        execution_id: first.id.clone(),
        session_id: first.owner_session_id.clone(),
    };
    assert!(fixture.client.call(&json!({"op":"allow_execution_completion","caller":"ui","request":grant})).unwrap()["error"].is_string());
    let mut ui = UiControlConnection::connect(&fixture.client).unwrap();
    let mut stale = grant.clone();
    stale.session_id = "retired-owner".into();
    assert!(ui.allow_execution_completion(&stale).is_err());
    ui.allow_execution_completion(&grant).unwrap();
    let granted = fixture.state().state;
    // Invalid outputs do not consume the grant; the same source can repair and accept.
    fs::write(fixture.root.join(".alinery/tasks/fixture/artifacts").join(&first.outputs[0].relative_path), "").unwrap();
    assert_eq!(fixture.event(&first.owner_session_id)["completion"]["status"], "invalid_outputs");
    let invalid_status = fixture.client.call(&json!({"op":"status","id":first.owner_session_id})).unwrap();
    assert_eq!(invalid_status["agent"]["state"], "waiting_for_input");
    let invalid_state = fixture.state();
    assert_eq!(invalid_state.state.executions[&first.id].lifecycle, ExecutionLifecycle::Running);
    assert!(invalid_state.state.executions[&first.id].error.is_some());
    assert_eq!(invalid_state.state.executions[&first.id].permission, granted.executions[&first.id].permission);
    assert_eq!(invalid_state.state.executions[&first.id].outputs, first.outputs);
    assert!(invalid_state.state.executions[&first.id].receipt_id.is_none());
    assert_eq!(invalid_state.state.occurrences, granted.occurrences);
    assert_eq!(invalid_state.state.executions.len(), granted.executions.len());
    assert_eq!(fixture.event(&first.owner_session_id)["completion"]["status"], "invalid_outputs");
    assert_eq!(
        fixture.client.call(&json!({"op":"status","id":first.owner_session_id})).unwrap()["agent"],
        invalid_status["agent"]
    );
    fixture.outputs(first);
    let accepted: CompletionOutcome = serde_json::from_value(fixture.event(&first.owner_session_id)["completion"].clone()).unwrap();
    assert!(matches!(&accepted, CompletionOutcome::Accepted { receipt_id } if !receipt_id.is_empty()));
    let finishing = fixture.state().state;
    assert_eq!(finishing.executions[&first.id].lifecycle, ExecutionLifecycle::Finishing);
    assert!(!finishing.executions[&first.id].shutdown_confirmed);
    assert_eq!(finishing.executions.len(), granted.executions.len());
    assert_eq!(
        finishing
            .occurrences
            .values()
            .filter(|o| o.producer_execution_id.as_deref() == Some(first.id.as_str()))
            .count(),
        2
    );
    assert_eq!(
        serde_json::from_value::<CompletionOutcome>(fixture.event(&first.owner_session_id)["completion"].clone()).unwrap(),
        accepted
    );
    assert!(fixture.state().state.executions[&first.id].error.is_none());
    assert!(ui.allow_execution_completion(&grant).is_err());
    drop(ui);
    fixture.release(&first.owner_session_id);
    wait(|| fixture.state().state.executions[&first.id].lifecycle == ExecutionLifecycle::Completed);
    assert!(fixture.state().state.executions[&first.id].shutdown_confirmed);
    assert!(!fixture.state().state.executions.values().any(|record| record.candidate.step_key == "join"));
}

#[test]
fn failed_start_is_retained_and_requires_explicit_stopped_owner_recovery() {
    let fixture = Fixture::new();
    let created = fixture.create(false, true);
    fs::write(
        fixture.root.join(".alinery/harnesses.toml"),
        "[[harness]]\nkey='omp'\nname='Missing'\nbinary='/nonexistent/alinery-fixture'\nargs=[]\nmodel_arg=[]\nadapter='omp'\n",
    )
    .unwrap();
    let first = &created.executions[0];
    let failed = fixture
        .client
        .start_session(&StartSessionRequest {
            task_slug: "fixture".into(),
            session_id: first.owner_session_id.clone(),
        })
        .unwrap();
    assert_eq!(failed.start, "failed");
    assert!(failed.execution.as_ref().unwrap().shutdown_confirmed);
    assert!(fixture
        .client
        .start_session(&StartSessionRequest {
            task_slug: "fixture".into(),
            session_id: first.owner_session_id.clone()
        })
        .is_err());
    let recovered = fixture
        .client
        .create_execution_session(&CreateExecutionSessionRequest {
            task_slug: "fixture".into(),
            target: ExecutionSessionTarget::Primary {
                step_key: first.candidate.step_key.clone(),
                execution_id: Some(first.id.clone()),
                input_occurrence_ids: None,
            },
            launch_override: Some(alinery_core::LaunchChoices {
                harness: "omp".into(),
                model: "corrected-model".into(),
            }),
            prompt_extra: None,
            handoff_artifact: None,
            start: false,
        })
        .unwrap();
    assert_ne!(recovered.session.id, first.owner_session_id);
    assert_eq!(recovered.execution.as_ref().unwrap().outputs, first.outputs);
    assert_eq!(recovered.execution.as_ref().unwrap().launch.model, "corrected-model");
    assert_eq!(recovered.execution.unwrap().previous_session_ids, vec![first.owner_session_id.clone()]);
}

#[test]
fn repeated_explicit_manual_runs_are_independent_and_do_not_replace_the_ordinary_binding() {
    let fixture = Fixture::new();
    let created = fixture.create(false, true);
    let ordinary = created.executions.iter().find(|r| r.candidate.step_key == "first").unwrap();
    let request = CreateExecutionSessionRequest {
        task_slug: "fixture".into(),
        target: ExecutionSessionTarget::Primary {
            step_key: "first".into(),
            execution_id: None,
            input_occurrence_ids: Some(Vec::new()),
        },
        launch_override: None,
        prompt_extra: None,
        handoff_artifact: None,
        start: false,
    };
    let one = fixture.client.create_execution_session(&request).unwrap().execution.unwrap();
    let two = fixture.client.create_execution_session(&request).unwrap().execution.unwrap();
    let three = fixture.client.create_execution_session(&request).unwrap().execution.unwrap();
    let ids: std::collections::BTreeSet<_> = [&ordinary.id, &one.id, &two.id, &three.id].into_iter().collect();
    assert_eq!(ids.len(), 4);
    assert_ne!(one.outputs, two.outputs);
    assert_ne!(two.outputs, three.outputs);
    assert_eq!(fixture.state().state.executions[&ordinary.id].outputs, ordinary.outputs);
}

#[test]
fn crash_after_acceptance_never_turns_an_unproven_owner_into_a_handoff() {
    let mut fixture = Fixture::new();
    let created = fixture.create(false, true);
    let first = created.executions.iter().find(|r| r.candidate.step_key == "first").unwrap();
    fixture
        .client
        .start_session(&StartSessionRequest {
            task_slug: "fixture".into(),
            session_id: first.owner_session_id.clone(),
        })
        .unwrap();
    wait(|| fixture.root.join(format!("token-{}", first.owner_session_id)).exists());
    fixture.outputs(first);
    assert_eq!(fixture.event(&first.owner_session_id)["completion"]["status"], "accepted");
    fixture.child.kill().unwrap();
    fixture.child.wait().unwrap();
    // Let only this fixture's orphan child exit. The new daemon has no wait/drain
    // proof and must not infer a completed handoff from the accepted receipt.
    fixture.release(&first.owner_session_id);
    fixture.child = Command::new(env!("CARGO_BIN_EXE_alineryd"))
        .args(["--repo", fixture.root.to_str().unwrap(), "--app-config", fixture.root.join("app.toml").to_str().unwrap()])
        .env("ALINERY_RUNNER_PATH", fixture.root.join("runner"))
        .env("ALINERY_HOST_EXECUTABLE", std::env::current_exe().unwrap())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    wait(|| fixture.client.version_checked().is_ok());
    let recovered = fixture.state().state;
    assert_eq!(recovered.executions[&first.id].lifecycle, ExecutionLifecycle::Interrupted);
    assert!(recovered.executions[&first.id].receipt_id.is_some());
    assert!(!recovered.executions[&first.id].shutdown_confirmed);
    let result = fixture.client.create_execution_session(&CreateExecutionSessionRequest {
        task_slug: "fixture".into(),
        target: ExecutionSessionTarget::Primary {
            step_key: "first".into(),
            execution_id: Some(first.id.clone()),
            input_occurrence_ids: None,
        },
        launch_override: None,
        prompt_extra: None,
        handoff_artifact: None,
        start: false,
    });
    assert!(result.is_err(), "accepted uncertain work cannot be reopened");
    assert!(!fixture.state().state.executions.values().any(|r| r.candidate.step_key == "join"));
}

#[test]
fn malformed_defaults_reject_provisioning_but_legacy_defaults_allow_it() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("app.toml"), "[global.defaults]\nplaybook = 17\n").unwrap();
    let request: CreateTaskRequest = serde_json::from_value(json!({
        "name": "Invalid configuration", "requested_slug": "invalid-config",
        "playbook": { "reference": { "scope": "repo", "key": "fixture" }, "source": definition() },
        "start": false
    }))
    .unwrap();
    let result = fixture.client.create_task(&request);
    assert!(result.is_err(), "invalid settings must reject before creation, got {result:?}");
    assert!(!fixture.root.join(".alinery/tasks/invalid-config").exists());
    assert!(!fixture.root.join(".alinery/worktrees/invalid-config").exists());
    assert!(!alinery_core::git_cmd(&fixture.root)
        .args(["show-ref", "--verify", "--quiet", "refs/heads/invalid-config"])
        .status()
        .unwrap()
        .success());

    let legacy = "[global.defaults]\nplaybook = 'superdevelop'\n";
    fs::write(fixture.root.join("app.toml"), legacy).unwrap();
    let created = fixture.client.create_task(&request).unwrap();
    assert_eq!(created.creation, "ready");
    assert_eq!(
        created.task.unwrap().playbook_ref.unwrap(),
        alinery_core::playbook::PlaybookRef {
            scope: alinery_core::playbook::PlaybookScope::Repo,
            key: "fixture".into(),
        }
    );
    assert!(fixture.root.join(".alinery/tasks/invalid-config/task.md").is_file());
    assert_eq!(fs::read_to_string(fixture.root.join("app.toml")).unwrap(), legacy);
}

#[test]
fn foreign_lane_cannot_create_auxiliary_sessions_on_an_owned_v2_task() {
    struct Lane {
        child: Child,
        client: DaemonClient,
    }
    impl Drop for Lane {
        fn drop(&mut self) {
            let _ = self.client.call(&json!({"op": "shutdown"}));
            let _ = self.child.wait();
        }
    }
    let fixture = Fixture::new();
    fixture.create(false, true);
    let child = Command::new(env!("CARGO_BIN_EXE_alineryd"))
        .args([
            "--repo",
            fixture.root.to_str().unwrap(),
            "--app-config",
            fixture.root.join("app.toml").to_str().unwrap(),
            "--socket-namespace",
            "other",
        ])
        .env("ALINERY_RUNNER_PATH", fixture.root.join("runner"))
        .env("ALINERY_HOST_EXECUTABLE", std::env::current_exe().unwrap())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let other = Lane {
        child,
        client: DaemonClient {
            socket_path: alinery_core::alineryd_socket_path(&fixture.root, Some("other")),
        },
    };
    wait(|| other.client.version_checked().is_ok());
    let sessions = || {
        fs::read_dir(fixture.root.join(".alinery/tasks/fixture/sessions"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<std::collections::BTreeSet<_>>()
    };
    let before = sessions();
    let result = other.client.create_execution_session(&CreateExecutionSessionRequest {
        task_slug: "fixture".into(),
        target: ExecutionSessionTarget::Auxiliary {
            harness: "no-harness".into(),
            model: None,
            prompt: None,
        },
        launch_override: None,
        prompt_extra: None,
        handoff_artifact: None,
        start: false,
    });
    assert!(result.is_err(), "wrong lane created task-owned auxiliary state: {result:?}");
    assert_eq!(sessions(), before);
}

#[test]
fn replacement_configuration_cannot_start_an_existing_auxiliary_owner() {
    let mut fixture = Fixture::new();
    fixture.create(false, true);
    let auxiliary = fixture
        .client
        .create_execution_session(&CreateExecutionSessionRequest {
            task_slug: "fixture".into(),
            target: ExecutionSessionTarget::Auxiliary {
                harness: "no-harness".into(),
                model: None,
                prompt: None,
            },
            launch_override: None,
            prompt_extra: None,
            handoff_artifact: None,
            start: false,
        })
        .unwrap();
    fixture.client.call(&json!({"op": "shutdown"})).unwrap();
    fixture.child.wait().unwrap();
    fixture.child = Command::new(env!("CARGO_BIN_EXE_alineryd"))
        .args([
            "--repo",
            fixture.root.to_str().unwrap(),
            "--app-config",
            fixture.root.join("different-app.toml").to_str().unwrap(),
        ])
        .env("ALINERY_RUNNER_PATH", fixture.root.join("runner"))
        .env("ALINERY_HOST_EXECUTABLE", std::env::current_exe().unwrap())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    wait(|| fixture.client.version_checked().is_ok());
    assert!(fixture
        .client
        .start_session(&StartSessionRequest {
            task_slug: "fixture".into(),
            session_id: auxiliary.session.id.clone(),
        })
        .is_err());
    let metadata: alinery_core::SessionMeta = serde_json::from_slice(&fs::read(alinery_core::session_meta_path(&fixture.root, "fixture", &auxiliary.session.id)).unwrap()).unwrap();
    assert!(metadata.started_at.is_none());
}

#[test]
fn terminal_sentinel_launches_a_shell_without_claiming_graph_capacity() {
    let fixture = Fixture::new();
    fixture.create(false, true);
    let reply = fixture
        .client
        .create_execution_session(&CreateExecutionSessionRequest {
            task_slug: "fixture".into(),
            target: ExecutionSessionTarget::Auxiliary {
                harness: "no-harness".into(),
                model: None,
                prompt: None,
            },
            launch_override: None,
            prompt_extra: None,
            handoff_artifact: None,
            start: true,
        })
        .unwrap();
    assert_eq!(reply.start, "started", "{:?}", reply.errors);
    let proof = fixture.root.join("terminal-proof");
    fixture
        .client
        .call(&alinery_core::write_request(&reply.session.id, &format!("printf shell-live > '{}'\r", proof.display())))
        .unwrap();
    wait(|| fs::read_to_string(&proof).is_ok_and(|text| text == "shell-live"));
    assert!(fixture.state().state.executions.values().all(|record| !record.lifecycle.holds_capacity()));
}

#[test]
fn fanout_complete_waits_for_the_paused_worker_and_computes_assigned_results() {
    let fixture = Fixture::new();
    let mut source = "+++\nversion=2\nkey='squares'\ntitle='Squares'\ndescription=''\ndefault_model=''\ndefault_harness='omp'\n".to_string();
    for (key, inputs, output) in [
        ("seed", "[]", "request-*.md"),
        ("worker", "[{path='request-*.md',mode='each'}]", "result-*.md"),
        ("collect", "[{path='result-*.md',mode='complete'}]", "answer.md"),
    ] {
        source.push_str(&format!("[[step]]\nkey='{key}'\ntitle='{key}'\nshort=''\ninputs={inputs}\noutputs=[{{path='{output}'}}]\nmodel=''\nharness=''\nis_coding_step=false\nauto_advance_default=false\n"));
    }
    source.push_str("+++\n");
    for key in ["seed", "worker", "collect"] {
        source.push_str(&format!("<!-- alinery:step {key} -->\nUse only assigned inputs and outputs.\n"));
    }
    let request: CreateTaskRequest = serde_json::from_value(json!({
        "name": "Fixture", "requested_slug": "fixture", "description": "Squares",
        "playbook": {"reference": {"scope": "repo", "key": "squares"}, "source": source},
        "max_live_sessions": 3, "auto_advance_steps": ["seed", "collect"], "start": true
    }))
    .unwrap();
    let created = fixture.client.create_task(&request).unwrap();
    let worktree = PathBuf::from(&created.task.as_ref().unwrap().worktree).canonicalize().unwrap();
    let seed = created.executions.iter().find(|record| record.candidate.step_key == "seed").unwrap();
    wait(|| fixture.root.join(format!("token-{}", seed.owner_session_id)).exists());
    let artifacts = fixture.root.join(".alinery/tasks/fixture/artifacts");
    for (member, value) in [("alpha", 2), ("beta", 3), ("gamma", 5)] {
        fs::write(artifacts.join(seed.outputs[0].relative_path.replace('*', member)), value.to_string()).unwrap();
    }
    assert_eq!(fixture.event(&seed.owner_session_id)["completion"]["status"], "accepted");
    assert!(!fixture.state().state.executions.values().any(|record| record.candidate.step_key == "worker"));
    fixture.release(&seed.owner_session_id);
    wait(|| {
        fixture
            .state()
            .state
            .executions
            .values()
            .filter(|record| record.candidate.step_key == "worker" && record.lifecycle == ExecutionLifecycle::Running)
            .count()
            == 3
    });
    let snapshot = fixture.state();
    let workers: Vec<_> = snapshot.state.executions.values().filter(|record| record.candidate.step_key == "worker").cloned().collect();
    let mut ui = UiControlConnection::connect(&fixture.client).unwrap();
    let mut paused = None;
    for worker in &workers {
        wait(|| fixture.root.join(format!("cwd-{}", worker.owner_session_id)).exists());
        assert_eq!(
            PathBuf::from(fs::read_to_string(fixture.root.join(format!("cwd-{}", worker.owner_session_id))).unwrap().trim())
                .canonicalize()
                .unwrap(),
            worktree
        );
        let input = &snapshot.state.occurrences[&worker.candidate.inputs["request-*.md"][0]];
        let value: u64 = fs::read_to_string(artifacts.join(&input.relative_path)).unwrap().parse().unwrap();
        fs::write(artifacts.join(worker.outputs[0].relative_path.replace('*', "square")), (value * value).to_string()).unwrap();
        if value == 3 {
            assert_eq!(fixture.event(&worker.owner_session_id)["completion"]["status"], "human_authorization_required");
            paused = Some(worker.clone());
            continue;
        }
        ui.allow_execution_completion(&AllowExecutionCompletionRequest {
            task_slug: "fixture".into(),
            execution_id: worker.id.clone(),
            session_id: worker.owner_session_id.clone(),
        })
        .unwrap();
        assert_eq!(fixture.event(&worker.owner_session_id)["completion"]["status"], "accepted");
        fixture.release(&worker.owner_session_id);
        wait(|| fixture.state().state.executions[&worker.id].lifecycle == ExecutionLifecycle::Completed);
    }
    fs::write(artifacts.join("999-result-decoy.md"), "1000").unwrap();
    assert!(!fixture.state().state.executions.values().any(|record| record.candidate.step_key == "collect"));
    let paused = paused.unwrap();
    ui.allow_execution_completion(&AllowExecutionCompletionRequest {
        task_slug: "fixture".into(),
        execution_id: paused.id.clone(),
        session_id: paused.owner_session_id.clone(),
    })
    .unwrap();
    assert_eq!(fixture.event(&paused.owner_session_id)["completion"]["status"], "accepted");
    assert_eq!(fixture.state().state.executions[&paused.id].lifecycle, ExecutionLifecycle::Finishing);
    assert!(!fixture.state().state.executions.values().any(|record| record.candidate.step_key == "collect"));
    fixture.release(&paused.owner_session_id);
    wait(|| {
        fixture
            .state()
            .state
            .executions
            .values()
            .any(|record| record.candidate.step_key == "collect" && record.lifecycle == ExecutionLifecycle::Running)
    });
    let collected = fixture.state();
    let collector = collected.state.executions.values().find(|record| record.candidate.step_key == "collect").unwrap();
    let ids = &collector.candidate.inputs["result-*.md"];
    let producers: std::collections::BTreeSet<_> = ids.iter().map(|id| collected.state.occurrences[id].producer_execution_id.as_ref().unwrap()).collect();
    assert_eq!(producers, workers.iter().map(|worker| &worker.id).collect());
    let answer: u64 = ids
        .iter()
        .map(|id| {
            fs::read_to_string(artifacts.join(&collected.state.occurrences[id].relative_path))
                .unwrap()
                .parse::<u64>()
                .unwrap()
        })
        .sum();
    assert_eq!(answer, 38);
    fs::write(artifacts.join(&collector.outputs[0].relative_path), answer.to_string()).unwrap();
    wait(|| fixture.root.join(format!("token-{}", collector.owner_session_id)).exists());
    assert_eq!(fixture.event(&collector.owner_session_id)["completion"]["status"], "accepted");
    fixture.release(&collector.owner_session_id);
    wait(|| fixture.state().state.executions[&collector.id].lifecycle == ExecutionLifecycle::Completed);
}

#[test]
fn task_creation_preserves_existing_unicode_slug_normalization() {
    let fixture = Fixture::new();
    let request: CreateTaskRequest = serde_json::from_value(json!({
        "name": "Café  worker",
        "playbook": {"reference": {"scope": "repo", "key": "fixture"}, "source": definition()},
        "start": false
    }))
    .unwrap();
    let result = fixture.client.create_task(&request).unwrap();
    let task = result.task.unwrap();
    assert_eq!(task.slug, "café--worker");
    assert_eq!(task.branch, "café--worker");
    assert!(PathBuf::from(task.worktree).join(".git").is_file());
}

fn shared_exact_definition(coding: bool) -> String {
    let mut source = "+++\nversion=2\nkey='fixture'\ntitle='Fixture'\ndescription=''\ndefault_model=''\ndefault_harness='omp'\n".to_string();
    for (key, inputs, output) in [
        ("checker", "[]", "request.md"),
        ("synthesis", "[]", "request.md"),
        ("brief", "[]", "brief.md"),
        ("designer", "[{path='request.md',mode='single'},{path='brief.md',mode='single'}]", "design.md"),
    ] {
        let is_coding = coding && key == "designer";
        source.push_str(&format!("[[step]]\nkey='{key}'\ntitle='{key}'\nshort=''\ninputs={inputs}\noutputs=[{{path='{output}'}}]\nmodel=''\nharness=''\nis_coding_step={is_coding}\nauto_advance_default=false\n"));
    }
    source.push_str("+++\n");
    for key in ["checker", "synthesis", "brief", "designer"] {
        source.push_str(&format!("<!-- alinery:step {key} -->\nWrite assigned evidence, then wait for release.\n"));
    }
    source
}

// Hold the governing brief, not auto_advance_steps: that setting controls
// completion permission, whereas nonroot executions always request a start.
fn shared_exact_publish_requests(fixture: &Fixture, capacity: u32, coding: bool, enabled: &[&str]) -> ExecutionRecord {
    let created = fixture.create_with(&shared_exact_definition(coding), capacity, enabled, false);
    assert_eq!(created.creation, "ready");
    for key in ["checker", "synthesis"] {
        let publisher = created.executions.iter().find(|record| record.candidate.step_key == key).unwrap();
        assert_eq!(fixture.start(publisher).start, "started");
        fixture.finish(publisher);
    }
    let state = fixture.persisted();
    assert!(!state.executions.values().any(|record| record.candidate.step_key == "designer"));
    let requests: Vec<_> = state.occurrences.values().filter(|occurrence| occurrence.logical_path == "request.md").collect();
    assert_eq!(requests.len(), 2);
    assert_ne!(requests[0].id, requests[1].id);
    assert_ne!(requests[0].producer_execution_id, requests[1].producer_execution_id);
    let artifacts = fixture.root.join(".alinery/tasks/fixture/artifacts");
    assert_eq!(
        fs::read(artifacts.join(&requests[0].relative_path)).unwrap(),
        fs::read(artifacts.join(&requests[1].relative_path)).unwrap()
    );
    created.executions.iter().find(|record| record.candidate.step_key == "brief").unwrap().clone()
}

fn shared_exact_designers(fixture: &Fixture) -> Vec<ExecutionRecord> {
    fixture.wait_state("both request occurrences must have durable ordinary Designer reservations", |state| {
        state
            .executions
            .values()
            .filter(|record| record.candidate.step_key == "designer" && !record.candidate.manual)
            .count()
            == 2
    });
    let state = fixture.persisted();
    let designers: Vec<_> = state
        .executions
        .values()
        .filter(|record| record.candidate.step_key == "designer" && !record.candidate.manual)
        .cloned()
        .collect();
    let brief = state.occurrences.values().find(|occurrence| occurrence.logical_path == "brief.md").unwrap();
    let expected: std::collections::BTreeSet<_> = state
        .occurrences
        .values()
        .filter(|occurrence| occurrence.logical_path == "request.md")
        .map(|request| std::collections::BTreeMap::from([("request.md".to_string(), vec![request.id.clone()]), ("brief.md".to_string(), vec![brief.id.clone()])]))
        .collect();
    assert_eq!(
        designers.iter().map(|record| record.candidate.inputs.clone()).collect::<std::collections::BTreeSet<_>>(),
        expected
    );
    assert_ne!(designers[0].owner_session_id, designers[1].owner_session_id);
    assert_ne!(designers[0].binding_key, designers[1].binding_key);
    let paths: std::collections::BTreeSet<_> = designers.iter().flat_map(|record| record.outputs.iter().map(|output| &output.relative_path)).collect();
    assert_eq!(paths.len(), 2, "each binding owns a distinct physical design path");
    designers
}

fn shared_exact_manual_request(record: Option<&ExecutionRecord>) -> CreateExecutionSessionRequest {
    CreateExecutionSessionRequest {
        task_slug: "fixture".into(),
        target: ExecutionSessionTarget::Primary {
            step_key: "designer".into(),
            execution_id: None,
            input_occurrence_ids: record.map(|record| record.candidate.inputs.values().flatten().cloned().collect()),
        },
        launch_override: None,
        prompt_extra: None,
        handoff_artifact: None,
        start: false,
    }
}

#[test]
fn shared_exact_requests_are_reserved_before_capacity_launch() {
    let fixture = Fixture::new();
    let brief = shared_exact_publish_requests(&fixture, 1, false, &[]);
    assert_eq!(fixture.start(&brief).start, "started");
    fixture.accept(&brief);
    let finishing = fixture.persisted();
    assert!(finishing.executions[&brief.id].receipt_id.is_some());
    assert!(!finishing.executions[&brief.id].shutdown_confirmed);
    assert_eq!(finishing.executions.values().filter(|record| record.lifecycle.holds_capacity()).count(), 1);
    assert!(!finishing.executions.values().any(|record| record.candidate.step_key == "designer"));
    fixture.release(&brief.owner_session_id);
    let designers = shared_exact_designers(&fixture);
    fixture.wait_state("one ordinary Designer must launch at capacity one", |state| {
        state
            .executions
            .values()
            .any(|record| record.candidate.step_key == "designer" && record.lifecycle == ExecutionLifecycle::Running)
    });
    let state = fixture.persisted();
    let first = designers
        .iter()
        .find(|record| state.executions[&record.id].lifecycle == ExecutionLifecycle::Running)
        .unwrap();
    let second = designers.iter().find(|record| record.id != first.id).unwrap();
    assert!(state.executions[&brief.id].shutdown_confirmed);
    assert_eq!(state.executions[&second.id].lifecycle, ExecutionLifecycle::Queued);
    assert_eq!(fixture.start(second).start, "queued");
    let accepted = fixture.accept(first);
    let before_replay = fixture.persisted();
    assert_eq!(fixture.event(&first.owner_session_id)["completion"], accepted["completion"]);
    let replayed = fixture.persisted();
    assert_eq!(replayed.occurrences, before_replay.occurrences);
    assert_eq!(replayed.executions, before_replay.executions);
    assert_eq!(replayed.executions[&second.id].lifecycle, ExecutionLifecycle::Queued);
    assert!(!fixture.root.join(format!("token-{}", second.owner_session_id)).exists());
    fixture.release(&first.owner_session_id);
    fixture.wait_state("queued Designer must launch after first confirmed exit", |state| {
        state.executions[&second.id].lifecycle == ExecutionLifecycle::Running
    });
    assert!(fixture.persisted().executions[&first.id].shutdown_confirmed);
    fixture.finish(second);
    let completed = fixture.persisted();
    for record in &designers {
        assert_eq!(completed.executions[&record.id].lifecycle, ExecutionLifecycle::Completed);
        assert_eq!(completed.executions[&record.id].candidate, record.candidate);
        assert_eq!(completed.executions[&record.id].outputs, record.outputs);
        assert_eq!(
            completed
                .occurrences
                .values()
                .filter(|occurrence| occurrence.producer_execution_id.as_deref() == Some(&record.id))
                .count(),
            1
        );
    }
    assert_eq!(shared_exact_designers(&fixture).len(), 2);
}

#[test]
fn shared_exact_automatic_scheduling_waits_for_publisher_exit() {
    let fixture = Fixture::new();
    let created = fixture.create_with(&shared_exact_definition(false), 1, &["checker", "synthesis", "brief", "designer"], false);
    let brief = created.executions.iter().find(|record| record.candidate.step_key == "brief").unwrap();
    fixture.start(brief);
    fixture.finish(brief);
    let mut handled = std::collections::BTreeSet::new();
    for key in ["checker", "synthesis"] {
        let publisher = created.executions.iter().find(|record| record.candidate.step_key == key).unwrap();
        fixture.start(publisher);
        fixture.accept(publisher);
        let finishing = fixture.persisted();
        let request = finishing
            .occurrences
            .values()
            .find(|occurrence| occurrence.producer_execution_id.as_deref() == Some(&publisher.id))
            .unwrap();
        assert!(!finishing
            .executions
            .values()
            .any(|record| record.candidate.step_key == "designer" && record.candidate.inputs["request.md"].contains(&request.id)));
        fixture.release(&publisher.owner_session_id);
        fixture.wait_state(
            &format!(
                "request {} from {} must automatically launch its own Designer after publisher exit",
                request.id, publisher.id
            ),
            |state| {
                state.executions.values().any(|record| {
                    record.candidate.step_key == "designer" && record.candidate.inputs["request.md"] == vec![request.id.clone()] && record.lifecycle == ExecutionLifecycle::Running
                })
            },
        );
        let state = fixture.persisted();
        let designer = state
            .executions
            .values()
            .find(|record| record.candidate.step_key == "designer" && record.candidate.inputs["request.md"] == vec![request.id.clone()])
            .unwrap();
        assert!(state.executions[&publisher.id].shutdown_confirmed);
        assert!(handled.insert(designer.id.clone()));
        // No manual start or UI grant: automatic completion and exit drive delivery.
        wait(|| fixture.root.join(format!("token-{}", designer.owner_session_id)).exists());
        fixture.outputs(designer);
        assert_eq!(fixture.event(&designer.owner_session_id)["completion"]["status"], "accepted");
        fixture.release(&designer.owner_session_id);
        fixture.wait_state("automatic Designer must complete after release", |state| {
            state.executions[&designer.id].lifecycle == ExecutionLifecycle::Completed
        });
    }
    assert_eq!(
        shared_exact_designers(&fixture)
            .iter()
            .map(|record| record.id.clone())
            .collect::<std::collections::BTreeSet<_>>(),
        handled
    );
}

#[test]
fn shared_exact_coding_continuations_keep_exclusive_owner() {
    for coding in [true, false] {
        let fixture = Fixture::new();
        let brief = shared_exact_publish_requests(&fixture, 2, coding, &["checker", "synthesis", "brief", "designer"]);
        fixture.start(&brief);
        fixture.finish(&brief);
        let designers = shared_exact_designers(&fixture);
        let expected_running = if coding { 1 } else { 2 };
        fixture.wait_state(&format!("coding={coding}: expected {expected_running} Running Designers at capacity two"), |state| {
            state
                .executions
                .values()
                .filter(|record| record.candidate.step_key == "designer" && record.lifecycle == ExecutionLifecycle::Running)
                .count()
                == expected_running
        });
        let state = fixture.persisted();
        let first = designers
            .iter()
            .find(|record| state.executions[&record.id].lifecycle == ExecutionLifecycle::Running)
            .unwrap();
        let second = designers.iter().find(|record| record.id != first.id).unwrap();
        fixture.accept(first);
        let finishing = fixture.persisted();
        assert_eq!(
            finishing.executions[&second.id].lifecycle,
            if coding { ExecutionLifecycle::Queued } else { ExecutionLifecycle::Running }
        );
        assert_eq!(finishing.executions.values().filter(|record| record.lifecycle.holds_capacity()).count(), expected_running);
        if coding {
            assert_eq!(fixture.start(second).start, "queued");
            assert!(!fixture.root.join(format!("token-{}", second.owner_session_id)).exists());
        }
        fixture.release(&first.owner_session_id);
        fixture.wait_state("first Designer must confirm exit", |state| {
            state.executions[&first.id].lifecycle == ExecutionLifecycle::Completed
        });
        fixture.wait_state("second Designer must run with capacity available", |state| {
            state.executions[&second.id].lifecycle == ExecutionLifecycle::Running
        });
        fixture.finish(second);
    }
}

#[test]
fn shared_exact_manual_selection_requires_one_binding() {
    let fixture = Fixture::new();
    let brief = shared_exact_publish_requests(&fixture, 2, false, &["checker", "synthesis", "brief", "designer"]);
    fixture.start(&brief);
    fixture.finish(&brief);
    let designers = shared_exact_designers(&fixture);
    fixture.wait_state("both noncoding Designers must run before manual selection", |state| {
        designers.iter().all(|record| state.executions[&record.id].lifecycle == ExecutionLifecycle::Running)
    });
    let before = fixture.persisted();
    assert!(fixture.client.create_execution_session(&shared_exact_manual_request(None)).is_err());
    assert_eq!(fixture.persisted().executions, before.executions);
    let mut selected = Vec::new();
    for designer in &designers {
        let manual = fixture
            .client
            .create_execution_session(&shared_exact_manual_request(Some(designer)))
            .unwrap()
            .execution
            .unwrap();
        assert!(manual.candidate.manual);
        assert_eq!(manual.candidate.inputs, designer.candidate.inputs);
        assert_ne!(manual.id, designer.id);
        assert_ne!(manual.outputs, designer.outputs);
        assert_eq!(manual.lifecycle, ExecutionLifecycle::Queued);
        assert!(!manual.start_requested);
        selected.push(manual);
    }
    assert_ne!(selected[0].outputs, selected[1].outputs);
    for designer in &designers {
        fixture.finish(designer);
    }
    for manual in &selected {
        assert_eq!(fixture.start(manual).start, "started");
        fixture.finish(manual);
    }
    let completed = fixture.persisted();
    for designer in &designers {
        assert_eq!(completed.executions[&designer.id].candidate, designer.candidate);
        assert_eq!(completed.executions[&designer.id].outputs, designer.outputs);
    }
}

#[test]
fn shared_exact_queued_manual_bindings_survive_quiescent_restart() {
    let mut fixture = Fixture::new();
    let brief = shared_exact_publish_requests(&fixture, 2, false, &["checker", "synthesis", "brief", "designer"]);
    fixture.start(&brief);
    fixture.finish(&brief);
    let designers = shared_exact_designers(&fixture);
    for designer in &designers {
        fixture.finish(designer);
    }
    // There is no hold API for ordinary nonroot starts. Explicit Primary
    // start:false creates real durable shared bindings without changing policy.
    let queued: Vec<_> = designers
        .iter()
        .map(|designer| {
            fixture
                .client
                .create_execution_session(&shared_exact_manual_request(Some(designer)))
                .unwrap()
                .execution
                .unwrap()
        })
        .collect();
    let before = fixture.persisted();
    fixture.restart_quiescent();
    let reloaded = fixture.persisted();
    assert_eq!(reloaded.executions, before.executions);
    assert_eq!(reloaded.occurrences, before.occurrences);
    for record in &queued {
        assert_eq!(reloaded.executions[&record.id], *record);
        assert_eq!(fixture.start(record).start, "started");
        fixture.finish(record);
    }
    let completed = fixture.persisted();
    assert_eq!(completed.executions.len(), before.executions.len());
    for record in &queued {
        let current = &completed.executions[&record.id];
        assert_eq!(current.lifecycle, ExecutionLifecycle::Completed);
        assert!(current.shutdown_confirmed);
        assert_eq!(current.owner_session_id, record.owner_session_id);
        assert_eq!(current.binding_key, record.binding_key);
        assert_eq!(current.candidate.inputs, record.candidate.inputs);
        assert_eq!(current.outputs, record.outputs);
        assert_eq!(
            completed
                .occurrences
                .values()
                .filter(|occurrence| occurrence.producer_execution_id.as_deref() == Some(&record.id))
                .count(),
            1
        );
    }
}
