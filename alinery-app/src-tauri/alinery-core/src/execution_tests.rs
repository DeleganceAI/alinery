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
    /// An execution record as the daemon's projection of an engine execution leaves it. The ownership and
    /// projection tests need records in a given lifecycle, not the transitions that lead there.
    fn record(&mut self, lifecycle: ExecutionLifecycle, receipt: bool, shutdown_confirmed: bool) -> String {
        let n = self.state.executions.len() as u64 + 1;
        let id = format!("e{n}");
        let relative_path = format!("{n}-result-1.md");
        if receipt {
            let path = crate::artifacts_dir(&self.repo, "task").join(&relative_path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "real output").unwrap();
        }
        self.state.executions.insert(
            id.clone(),
            ExecutionRecord {
                id: id.clone(),
                binding_key: format!("binding-{n}"),
                candidate: ExecutionCandidate {
                    step_key: "work".into(),
                    context_id: "root".into(),
                    inputs: BTreeMap::new(),
                    complete_collection_id: None,
                    each_collection_id: None,
                    each_member_id: None,
                    manual: true,
                },
                outputs: vec![OutputAssignment {
                    selector: "result.md".into(),
                    relative_path,
                    discriminator: n,
                    required: false,
                }],
                parent_execution_ids: BTreeSet::new(),
                depth: 1,
                owner_session_id: format!("s{n}"),
                previous_session_ids: vec![],
                launch: LaunchChoices::default(),
                is_coding_step: false,
                start_requested: lifecycle != ExecutionLifecycle::Queued,
                lifecycle,
                permission: if receipt { CompletionPermission::Consumed } else { CompletionPermission::Automatic },
                receipt_id: receipt.then(|| format!("r{n}")),
                exit_code: shutdown_confirmed.then_some(0),
                shutdown_confirmed,
                error: None,
            },
        );
        id
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

#[test]
fn repo_partial_write_failure_is_retryable_without_ownership_guard() {
    let mut f = Fixture::new("{path=\"result.md\"}", false, true, 10);
    let completed = f.record(ExecutionLifecycle::Completed, true, true);
    let uncertain = f.record(ExecutionLifecycle::Running, false, false);
    let queued = f.record(ExecutionLifecycle::Queued, false, false);
    persist_owner_fixture(&mut f);
    let archived = crate::task_dir(&f.repo, "archived");
    fs::create_dir_all(&archived).unwrap();
    let task = crate::Task {
        name: "Archived".into(),
        slug: "archived".into(),
        archived: true,
        engine_version: 2,
        ..Default::default()
    };
    fs::write(archived.join("task.md"), toml::to_string(&task).unwrap()).unwrap();
    fs::write(archived.join("playbook.md"), &f.source).unwrap();
    write_execution_state_unlocked(&f.repo, "archived", &mut f.state.clone()).unwrap();
    let artifact = crate::artifacts_dir(&f.repo, "task").join(&f.state.executions[&completed].outputs[0].relative_path);
    let output = fs::read(&artifact).unwrap();
    let result = crate::repo_ownership::with_adoption_write_failure(1, || crate::repo_ownership::acquire(&f.repo, "next", "next-config"));
    assert!(result.is_err(), "partial adoption must not return a usable guard");
    let adopted = ["archived", "task"]
        .into_iter()
        .filter(|slug| read_execution_state(&f.repo, slug).unwrap().owning_lane == "next")
        .count();
    assert_eq!(adopted, 1, "fixture must exercise a real partial durable batch");
    for path in [
        crate::alinery_dir(&f.repo).join(".repo-owner.lock"),
        crate::alineryd_lock_path(&f.repo, Some("lane")),
        crate::alineryd_lock_path(&f.repo, Some("next")),
    ] {
        let lease = crate::lockfile::try_lock_exclusive(&path).unwrap().expect("failed acquire must release every lease");
        drop(lease);
    }
    let _guard = crate::repo_ownership::acquire(&f.repo, "next", "next-config").unwrap();
    for slug in ["archived", "task"] {
        let state = read_execution_state(&f.repo, slug).unwrap();
        assert_eq!(state.owning_lane, "next");
        assert_eq!(state.owning_app_config_identity, "next-config");
        assert_eq!(state.executions[&completed], f.state.executions[&completed]);
        assert_eq!(state.executions[&queued], f.state.executions[&queued]);
        assert_eq!(state.occurrences, f.state.occurrences);
        assert_eq!(state.executions[&uncertain].lifecycle, ExecutionLifecycle::Interrupted);
        assert!(!state.executions[&uncertain].shutdown_confirmed);
        assert_eq!(state.executions[&uncertain].owner_session_id, f.state.executions[&uncertain].owner_session_id);
    }
    assert_eq!(fs::read(artifact).unwrap(), output);
}

#[test]
fn repo_round_trip_adopts_active_and_archived_tasks_preserving_evidence() {
    let mut f = Fixture::new("{path=\"result.md\"}", false, true, 10);
    let completed = f.record(ExecutionLifecycle::Completed, true, true);
    let uncertain = f.record(ExecutionLifecycle::Running, false, false);
    let queued = f.record(ExecutionLifecycle::Queued, false, false);
    persist_owner_fixture(&mut f);
    let archived = crate::task_dir(&f.repo, "archived");
    fs::create_dir_all(&archived).unwrap();
    let task = crate::Task {
        name: "Archived".into(),
        slug: "archived".into(),
        archived: true,
        engine_version: 2,
        ..Default::default()
    };
    fs::write(archived.join("task.md"), toml::to_string(&task).unwrap()).unwrap();
    fs::write(archived.join("playbook.md"), &f.source).unwrap();
    write_execution_state_unlocked(&f.repo, "archived", &mut f.state.clone()).unwrap();
    let metadata = fs::read(archived.join("task.md")).unwrap();
    let artifact = crate::artifacts_dir(&f.repo, "task").join(&f.state.executions[&completed].outputs[0].relative_path);
    let output = fs::read(&artifact).unwrap();
    for (lane, config) in [("dev", "dev-config"), ("", "production-config"), ("dev", "second-dev-config")] {
        let guard = crate::repo_ownership::acquire(&f.repo, lane, config).unwrap();
        for slug in ["task", "archived"] {
            let state = read_execution_state(&f.repo, slug).unwrap();
            assert_eq!((state.owning_lane.as_str(), state.owning_app_config_identity.as_str()), (lane, config));
            assert_eq!(state.executions[&completed], f.state.executions[&completed]);
            assert_eq!(state.executions[&queued], f.state.executions[&queued]);
            assert_eq!(state.occurrences, f.state.occurrences);
            assert_eq!(state.contexts, f.state.contexts);
            assert_eq!(state.collections, f.state.collections);
            let record = &state.executions[&uncertain];
            assert_eq!(record.lifecycle, ExecutionLifecycle::Interrupted);
            assert_eq!(record.owner_session_id, f.state.executions[&uncertain].owner_session_id);
            assert!(!record.shutdown_confirmed);
        }
        assert_eq!(fs::read(&artifact).unwrap(), output);
        assert_eq!(fs::read(archived.join("task.md")).unwrap(), metadata);
        drop(guard);
    }
}

#[test]
fn repo_failed_preflight_can_retry_without_retaining_leases() {
    let mut f = Fixture::new("{path=\"result.md\"}", false, false, 1);
    persist_owner_fixture(&mut f);
    let before = fs::read(execution_state_path(&f.repo, "task").unwrap()).unwrap();
    let path = crate::task_dir(&f.repo, "task").join("playbook.md");
    fs::write(&path, "invalid retained playbook").unwrap();
    assert!(crate::repo_ownership::acquire(&f.repo, "dev", "new-config").is_err());
    assert_eq!(fs::read(execution_state_path(&f.repo, "task").unwrap()).unwrap(), before);
    let lease = crate::lockfile::try_lock_exclusive(&crate::alinery_dir(&f.repo).join(".repo-owner.lock")).unwrap().unwrap();
    drop(lease);
    fs::write(path, &f.source).unwrap();
    let _guard = crate::repo_ownership::acquire(&f.repo, "dev", "new-config").unwrap();
    let state = read_execution_state(&f.repo, "task").unwrap();
    assert_eq!(state.owning_lane, "dev");
    assert_eq!(state.owning_app_config_identity, "new-config");
}

#[test]
fn repo_adoption_preserves_evidence_and_does_not_recover_execution_owners() {
    let mut f = Fixture::new("{path=\"result.md\"}", false, true, 10);
    let completed = f.record(ExecutionLifecycle::Completed, true, true);
    let uncertain = f.record(ExecutionLifecycle::Running, false, false);
    let finishing = f.record(ExecutionLifecycle::Finishing, true, false);
    let queued = f.record(ExecutionLifecycle::Queued, false, false);
    persist_owner_fixture(&mut f);
    let artifact = crate::artifacts_dir(&f.repo, "task").join(&f.state.executions[&completed].outputs[0].relative_path);
    let bytes = fs::read(&artifact).unwrap();
    let _ownership = crate::repo_ownership::acquire(&f.repo, "new-lane", "new-config").unwrap();
    let transferred = read_execution_state(&f.repo, "task").unwrap();
    assert_eq!(transferred.owning_lane, "new-lane");
    assert_eq!(transferred.owning_app_config_identity, "new-config");
    assert_eq!(transferred.executions[&completed], f.state.executions[&completed]);
    assert_eq!(transferred.executions[&queued], f.state.executions[&queued]);
    let mut expected = f.state.executions[&uncertain].clone();
    expected.lifecycle = ExecutionLifecycle::Interrupted;
    expected.error = transferred.executions[&uncertain].error.clone();
    assert_eq!(transferred.executions[&uncertain], expected);
    let mut expected_finishing = f.state.executions[&finishing].clone();
    assert!(expected_finishing.receipt_id.is_some());
    assert!(!expected_finishing.shutdown_confirmed);
    expected_finishing.lifecycle = ExecutionLifecycle::Interrupted;
    expected_finishing.error = transferred.executions[&finishing].error.clone();
    assert_eq!(transferred.executions[&finishing], expected_finishing);
    assert_eq!(transferred.occurrences, f.state.occurrences);
    assert_eq!(transferred.contexts, f.state.contexts);
    assert_eq!(transferred.collections, f.state.collections);
    assert_eq!(fs::read(&artifact).unwrap(), bytes);
    let persisted = fs::read(execution_state_path(&f.repo, "task").unwrap()).unwrap();
    assert!(crate::repo_ownership::acquire(&f.repo, "third-lane", "third-config").is_err());
    assert_eq!(fs::read(execution_state_path(&f.repo, "task").unwrap()).unwrap(), persisted);
}

#[test]
fn repo_adoption_refuses_live_lock_invalid_lane_and_lock_io_errors() {
    let mut f = Fixture::new("{path=\"result.md\"}", false, false, 1);
    persist_owner_fixture(&mut f);
    let lock_path = crate::alineryd_lock_path(&f.repo, Some("lane"));
    let lease = crate::lockfile::try_lock_exclusive(&lock_path).unwrap().unwrap();
    assert!(!crate::alineryd_socket_path(&f.repo, Some("lane")).exists());
    let before = fs::read(execution_state_path(&f.repo, "task").unwrap()).unwrap();
    assert!(crate::repo_ownership::acquire(&f.repo, "next", "config").is_err());
    assert_eq!(fs::read(execution_state_path(&f.repo, "task").unwrap()).unwrap(), before);
    drop(lease);
    fs::remove_file(&lock_path).unwrap();
    fs::create_dir(&lock_path).unwrap();
    assert!(crate::repo_ownership::acquire(&f.repo, "next", "config").is_err());
    assert_eq!(fs::read(execution_state_path(&f.repo, "task").unwrap()).unwrap(), before);
    fs::remove_dir(&lock_path).unwrap();
    for lane in ["../escape", "bad lane", "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz"] {
        f.state.owning_lane = lane.into();
        write_execution_state_unlocked(&f.repo, "task", &mut f.state).unwrap();
        assert!(crate::repo_ownership::acquire(&f.repo, "next", "config").is_err());
    }
}

#[test]
fn repo_preflight_checks_every_owner_before_writes_and_releases_leases() {
    let mut f = Fixture::new("{path=\"result.md\"}", false, false, 1);
    persist_owner_fixture(&mut f);
    let before = fs::read(execution_state_path(&f.repo, "task").unwrap()).unwrap();
    let second = crate::task_dir(&f.repo, "archived");
    fs::create_dir_all(&second).unwrap();
    let task = crate::Task {
        name: "Archived".into(),
        slug: "archived".into(),
        archived: true,
        engine_version: 2,
        ..Default::default()
    };
    fs::write(second.join("task.md"), toml::to_string(&task).unwrap()).unwrap();
    fs::write(second.join("playbook.md"), &f.source).unwrap();
    let mut state = f.state.clone();
    state.owning_lane = "another".into();
    write_execution_state_unlocked(&f.repo, "archived", &mut state).unwrap();
    let lease = crate::lockfile::try_lock_exclusive(&crate::alineryd_lock_path(&f.repo, Some("another"))).unwrap().unwrap();
    assert!(crate::repo_ownership::check_available(&f.repo).is_err());
    assert!(crate::repo_ownership::acquire(&f.repo, "next", "config").is_err());
    assert_eq!(fs::read(execution_state_path(&f.repo, "task").unwrap()).unwrap(), before);
    drop(lease);
    crate::repo_ownership::check_available(&f.repo).unwrap();
    assert_eq!(fs::read(execution_state_path(&f.repo, "task").unwrap()).unwrap(), before);
    let ownership = crate::repo_ownership::acquire(&f.repo, "next", "config").unwrap();
    assert_eq!(read_execution_state(&f.repo, "archived").unwrap().owning_lane, "next");
    assert!(crate::lockfile::try_lock_exclusive(&crate::alineryd_lock_path(&f.repo, Some("another"))).unwrap().is_none());
    drop(ownership);
    fs::write(second.join("execution.json"), "malformed").unwrap();
    assert!(crate::repo_ownership::acquire(&f.repo, "third", "config").is_err());
    fs::remove_file(second.join("execution.json")).unwrap();
    assert!(crate::repo_ownership::check_available(&f.repo).is_err());
}

#[test]
fn repo_unknown_socket_and_malformed_task_evidence_block_without_adoption() {
    let mut f = Fixture::new("{path=\"result.md\"}", false, false, 1);
    persist_owner_fixture(&mut f);
    let before = fs::read(execution_state_path(&f.repo, "task").unwrap()).unwrap();
    let socket = crate::alineryd_socket_path(&f.repo, Some("unknown"));
    let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    assert!(crate::repo_ownership::acquire(&f.repo, "next", "config").is_err());
    assert_eq!(fs::read(execution_state_path(&f.repo, "task").unwrap()).unwrap(), before);
    drop(listener);
    fs::remove_file(&socket).unwrap();
    fs::write(&socket, "not a socket").unwrap();
    assert!(crate::repo_ownership::check_available(&f.repo).is_err());
    fs::remove_file(socket).unwrap();
    fs::write(crate::task_dir(&f.repo, "task").join("task.md"), "malformed").unwrap();
    assert!(crate::repo_ownership::acquire(&f.repo, "next", "config").is_err());
    assert_eq!(fs::read(execution_state_path(&f.repo, "task").unwrap()).unwrap(), before);
}

#[test]
fn concurrent_repo_starts_have_exactly_one_owner() {
    let f = Fixture::new("{path=\"result.md\"}", false, false, 1);
    // This scenario has no task records; it exercises the startup race itself.
    fs::remove_dir_all(crate::tasks_dir(&f.repo)).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let workers: Vec<_> = ["prod", "dev"]
        .into_iter()
        .map(|lane| {
            let repo = f.repo.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                let result = crate::repo_ownership::acquire(&repo, lane, "config");
                barrier.wait();
                result.is_ok()
            })
        })
        .collect();
    assert_eq!(workers.into_iter().filter_map(|worker| worker.join().unwrap().then_some(())).count(), 1);
}

#[test]
fn legacy_task_without_execution_can_be_adopted_but_v2_cannot() {
    let f = Fixture::new("{path=\"result.md\"}", false, false, 1);
    let mut task = crate::Task {
        name: "Legacy".into(),
        slug: "task".into(),
        ..Default::default()
    };
    let path = crate::task_dir(&f.repo, "task").join("task.md");
    fs::write(&path, toml::to_string(&task).unwrap()).unwrap();
    drop(crate::repo_ownership::acquire(&f.repo, "next", "config").unwrap());
    task.engine_version = 2;
    fs::write(&path, toml::to_string(&task).unwrap()).unwrap();
    assert!(crate::repo_ownership::acquire(&f.repo, "next", "config").is_err());
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
fn backup_restore_retains_fixed_definition_execution_and_repo_library_only() {
    let mut f = Fixture::new("{path=\"result.md\"}", false, true, 2);
    let id = f.record(ExecutionLifecycle::Queued, false, false);
    crate::fs_atomic::write_bytes_durable(&task_playbook_path(&f.repo, "task").unwrap(), f.source.as_bytes()).unwrap();
    write_execution_state_unlocked(&f.repo, "task", &mut f.state).unwrap();
    let library = f.repo.join(".alinery/playbooks/fixture");
    fs::create_dir_all(&library).unwrap();
    fs::write(library.join("playbook.md"), &f.source).unwrap();
    let global = f.repo.join("global/playbooks/fixture");
    fs::create_dir_all(&global).unwrap();
    fs::write(global.join("playbook.md"), "global source is not repo data").unwrap();
    let destination = f.repo.join("backups");
    fs::create_dir_all(&destination).unwrap();
    let settings = crate::BackupDefaults {
        destination: destination.display().to_string(),
        enabled: true,
        ..Default::default()
    };
    crate::create_backup(&f.repo, &settings, crate::BackupTrigger::Manual, "test").unwrap();
    let archive = crate::list_backups(&f.repo, &settings).unwrap().remove(0);
    let restored = f.repo.join("restored");
    fs::create_dir_all(&restored).unwrap();
    crate::extract_backup_into(Path::new(&archive.path), &restored.join(".alinery"), Some(&f.repo)).unwrap();
    let state = read_execution_state(&restored, "task").unwrap();
    assert_eq!(state.executions[&id].outputs, f.state.executions[&id].outputs);
    assert_eq!(fs::read_to_string(task_playbook_path(&restored, "task").unwrap()).unwrap(), f.source);
    assert_eq!(read_task_playbook(&restored, "task", &state).unwrap().key, "fixture");
    assert_eq!(fs::read_to_string(restored.join(".alinery/playbooks/fixture/playbook.md")).unwrap(), f.source);
    assert!(!restored.join("global").exists());
    assert!(!restored.join(".alinery/global").exists());
}

#[test]
fn artifact_projection_shows_reserved_and_accepted_execution_ownership() {
    let mut f = Fixture::new("{path=\"result.md\"}", false, true, 2);
    let id = f.record(ExecutionLifecycle::Running, false, false);
    write_execution_state_unlocked(&f.repo, "task", &mut f.state).unwrap();
    let pending = crate::list_artifacts_with_execution_metadata(&f.repo, "task", &f.state).unwrap();
    let output = pending
        .iter()
        .find(|item| item.name == "1-result-1.md")
        .expect("reserved output is visible before it is written");
    assert_eq!(output.execution_id.as_deref(), Some(id.as_str()));
    assert_eq!(output.logical_path.as_deref(), Some("result.md"));
    assert_eq!(output.accepted, Some(false));
    assert_eq!(output.depth, Some(1));
    // The shape the daemon's projection writes once the engine accepts the step.
    let path = crate::artifacts_dir(&f.repo, "task").join("1-result-1.md");
    fs::write(path, "real output").unwrap();
    f.state.occurrences.insert(
        format!("{id}/result.md"),
        ArtifactOccurrence {
            id: format!("{id}/result.md"),
            producer_execution_id: Some(id.clone()),
            selector: "result.md".into(),
            logical_path: "result.md".into(),
            relative_path: "1-result-1.md".into(),
            depth: 1,
            discriminator: 1,
            context_id: "root".into(),
            collection_ids: BTreeSet::new(),
        },
    );
    let record = f.state.executions.get_mut(&id).unwrap();
    record.receipt_id = Some("r1".into());
    record.lifecycle = ExecutionLifecycle::Finishing;
    write_execution_state_unlocked(&f.repo, "task", &mut f.state).unwrap();
    let items = crate::list_artifacts_with_execution_metadata(&f.repo, "task", &f.state).unwrap();
    let output = items.iter().find(|item| item.name == "1-result-1.md").unwrap();
    assert_eq!(output.execution_id.as_deref(), Some(id.as_str()));
    assert_eq!(output.accepted, Some(true));
    assert_eq!(output.session_id, "s1");
    assert_eq!(output.discriminator, Some(1));
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
    assert!(state.executions.values().all(|e| e.lifecycle == ExecutionLifecycle::Completed && e.shutdown_confirmed && e.receipt_id.is_some()));
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
