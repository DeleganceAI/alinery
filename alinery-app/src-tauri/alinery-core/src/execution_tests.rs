use super::*;
use crate::playbook::PlaybookScope;

struct Fixture {
    repo: PathBuf,
    source: String,
    state: TaskExecutionState,
}
impl Fixture {
    fn new(outputs: &str, coding: bool, automatic: bool, cap: u32) -> Self {
        let repo = PathBuf::from("/tmp").join(format!("alinery-v2-execution-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(crate::artifacts_dir(&repo, "task")).unwrap();
        let source = format!("+++\nversion = 2\nkey = \"fixture\"\ntitle = \"Fixture\"\ndescription = \"\"\ndefault_model = \"\"\ndefault_harness = \"omp\"\n[[step]]\nkey = \"work\"\ntitle = \"Work\"\nshort = \"\"\ninputs = []\noutputs = [{outputs}]\nmodel = \"\"\nharness = \"\"\nis_coding_step = {coding}\nauto_advance_default = {automatic}\n+++\n<!-- alinery:step work -->\nWrite the assigned outputs.\n");
        let enabled = if automatic { BTreeSet::from(["work".into()]) } else { BTreeSet::new() };
        let mut state = new_execution_state(
            PlaybookRef {
                scope: PlaybookScope::Repo,
                key: "fixture".into(),
            },
            &source,
            "lane".into(),
            cap,
            enabled,
            LaunchChoices::default(),
            BTreeMap::new(),
        )
        .unwrap();
        state.creation = "ready".into();
        Self { repo, source, state }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.repo);
    }
}

fn persist_owner_fixture(f: &mut Fixture) {
    let task = crate::Task {
        name: "Task".into(),
        slug: "task".into(),
        engine_version: 2,
        ..Default::default()
    };
    fs::write(crate::task_dir(&f.repo, "task").join("task.md"), toml::to_string(&task).unwrap()).unwrap();
    fs::write(task_playbook_path(&f.repo, "task").unwrap(), &f.source).unwrap();
    write_execution_state_unlocked(&f.repo, "task", &mut f.state).unwrap();
}

// Taking ownership and adopting tasks is the daemon's now (`vinculum-daemon/src/domain/ownership.test.ts` holds those cases).
// What stays in Rust is the shell's read-only fence, which names the same evidence.
#[test]
fn check_available_blocks_on_a_held_owner_unknown_socket_and_malformed_evidence_and_writes_nothing() {
    let mut f = Fixture::new("{path=\"result.md\"}", false, false, 1);
    persist_owner_fixture(&mut f);
    let before = fs::read(execution_state_path(&f.repo, "task").unwrap()).unwrap();
    crate::repo_ownership::check_available(&f.repo).unwrap();
    let lease = crate::lockfile::try_lock_exclusive(&crate::alineryd_lock_path(&f.repo, Some("lane"))).unwrap().unwrap();
    assert!(crate::repo_ownership::check_available(&f.repo).is_err());
    drop(lease);
    crate::repo_ownership::check_available(&f.repo).unwrap();
    let socket = crate::alineryd_socket_path(&f.repo, Some("unknown"));
    let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    assert!(crate::repo_ownership::check_available(&f.repo).is_err());
    drop(listener);
    fs::remove_file(&socket).unwrap();
    fs::write(&socket, "not a socket").unwrap();
    assert!(crate::repo_ownership::check_available(&f.repo).is_err());
    fs::remove_file(socket).unwrap();
    fs::write(crate::task_dir(&f.repo, "task").join("task.md"), "malformed").unwrap();
    assert!(crate::repo_ownership::check_available(&f.repo).is_err());
    assert_eq!(fs::read(execution_state_path(&f.repo, "task").unwrap()).unwrap(), before);
}

#[test]
fn auto_approve_all_missing_from_saved_files_stays_off() {
    let mut f = Fixture::new("{path=\"result.md\"}", false, false, 1);
    persist_owner_fixture(&mut f);
    let execution_path = execution_state_path(&f.repo, "task").unwrap();
    let mut execution: serde_json::Value = serde_json::from_slice(&fs::read(&execution_path).unwrap()).unwrap();
    execution.as_object_mut().unwrap().remove("auto_approve_all");
    fs::write(&execution_path, serde_json::to_vec_pretty(&execution).unwrap()).unwrap();
    assert!(!read_execution_state(&f.repo, "task").unwrap().auto_approve_all);

    let task_path = crate::task_dir(&f.repo, "task").join("task.md");
    let saved = fs::read_to_string(&task_path).unwrap();
    assert!(saved.contains("auto_approve_all = false"), "saved task should record the default before it is stripped");
    let task = saved.replace("auto_approve_all = false\n", "");
    assert!(!task.contains("auto_approve_all"));
    fs::write(&task_path, task).unwrap();
    assert!(!crate::read_task(&f.repo, "task").unwrap().auto_approve_all);
}

#[test]
fn retained_definition_is_independent_of_library_and_fails_closed_on_corruption() {
    let mut f = Fixture::new("{path=\"result.md\"}", false, true, 1);
    let path = task_playbook_path(&f.repo, "task").unwrap();
    crate::fs_atomic::write_bytes_durable(&path, f.source.as_bytes()).unwrap();
    let library = f.repo.join("library.md");
    fs::write(&library, "invalid library").unwrap();
    fs::remove_file(library).unwrap();
    assert_eq!(read_task_playbook(&f.repo, "task", &f.state).unwrap().key, "fixture");
    write_execution_state_unlocked(&f.repo, "task", &mut f.state).unwrap();
    fs::write(path, f.source.replace("Fixture", "Changed")).unwrap();
    assert!(mutate_execution_state(&f.repo, "task", "lane", "", "corrupt read", |_, _| Ok(())).is_err());
    assert_eq!(read_execution_state(&f.repo, "task").unwrap().revision, f.state.revision);
}

#[test]
fn task_rejects_unsupported_graph_harness_before_provisioning() {
    let f = Fixture::new("{path=\"result.md\"}", false, true, 1);
    let source = f.source.replace("default_harness = \"omp\"", "default_harness = \"no-harness\"");
    assert!(new_execution_state(
        PlaybookRef {
            scope: PlaybookScope::Repo,
            key: "fixture".into()
        },
        &source,
        "lane".into(),
        1,
        BTreeSet::new(),
        LaunchChoices::default(),
        BTreeMap::new(),
    )
    .is_err());
}

#[test]
fn step_model_missing_field_parses_as_empty_map() {
    let f = Fixture::new("{path=\"result.md\"}", false, true, 1);
    let mut value = serde_json::to_value(&f.state).unwrap();
    value.as_object_mut().unwrap().remove("step_models");
    let state: TaskExecutionState = serde_json::from_value(value).unwrap();
    assert_eq!(state.version, 1);
    assert!(state.step_models.is_empty());
}

#[test]
fn a_state_the_daemon_wrote_reads_in_rust_and_a_rust_write_keeps_the_engine_block() {
    // `ts-engine-state.json` holds the `engine`, `executions` and `occurrences` keys the daemon wrote after a
    // real fork-join run (seed, then sum and product, then combine).
    let fixture: serde_json::Value = serde_json::from_str(include_str!("../tests/fixtures/ts-engine-state.json")).unwrap();
    let f = Fixture::new("{path=\"result.md\"}", false, true, 10);
    let mut value = serde_json::to_value(&f.state).unwrap();
    for key in ["engine", "executions", "occurrences"] {
        value[key] = fixture[key].clone();
    }
    fs::write(execution_state_path(&f.repo, "task").unwrap(), serde_json::to_vec(&value).unwrap()).unwrap();

    let mut state = read_execution_state(&f.repo, "task").unwrap();
    assert_eq!(state.executions.keys().map(String::as_str).collect::<Vec<_>>(), ["e1", "e2", "e3", "e4"]);
    assert!(state
        .executions
        .values()
        .all(|e| e.lifecycle == ExecutionLifecycle::Completed && e.shutdown_confirmed && e.receipt_id.is_some()));
    assert_eq!(state.executions["e2"].candidate.step_key, "sum");
    assert_eq!(state.executions["e2"].candidate.inputs["numbers.md"], ["e1/numbers.md"]);
    assert_eq!(state.executions["e4"].depth, 3);
    assert_eq!(state.occurrences["e1/numbers.md"].producer_execution_id.as_deref(), Some("e1"));
    assert_eq!(state.occurrences["e1/numbers.md"].relative_path, "1-seed-1/numbers.md");
    assert_eq!(state.occurrences["seed/ticket.md"].producer_execution_id, None);
    // Rust does not read the engine block, only carries it.
    assert_eq!(state.engine.as_ref(), Some(&fixture["engine"]));

    state.owning_lane = "next".into();
    state.auto_approve_all = true;
    write_execution_state_unlocked(&f.repo, "task", &mut state).unwrap();
    let after: serde_json::Value = serde_json::from_slice(&fs::read(execution_state_path(&f.repo, "task").unwrap()).unwrap()).unwrap();
    assert_eq!(after["engine"], fixture["engine"], "a Rust writer must not erase or alter the engine block");
    assert_eq!(after["executions"], fixture["executions"]);
    assert_eq!(after["owning_lane"], "next");
}
