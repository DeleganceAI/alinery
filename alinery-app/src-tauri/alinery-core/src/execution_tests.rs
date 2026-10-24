use super::*;
use crate::playbook::PlaybookScope;

struct Fixture {
    repo: PathBuf,
    source: String,
    definition: NormalizedPlaybook,
    state: TaskExecutionState,
}
impl Fixture {
    fn new(outputs: &str, coding: bool, automatic: bool, cap: u32) -> Self {
        let repo = PathBuf::from("/tmp").join(format!("alinery-v2-execution-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(crate::artifacts_dir(&repo, "task")).unwrap();
        let source = format!("+++\nversion = 2\nkey = \"fixture\"\ntitle = \"Fixture\"\ndescription = \"\"\ndefault_model = \"\"\ndefault_harness = \"omp\"\n[[step]]\nkey = \"work\"\ntitle = \"Work\"\nshort = \"\"\ninputs = []\noutputs = [{outputs}]\nmodel = \"\"\nharness = \"\"\nis_coding_step = {coding}\nauto_advance_default = {automatic}\n+++\n<!-- alinery:step work -->\nWrite the assigned outputs.\n");
        let definition = parse_playbook_md(&source).unwrap();
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
        Self { repo, source, definition, state }
    }
    fn add_consumer(&mut self, selector: &str) {
        let step = format!("[[step]]\nkey = \"review\"\ntitle = \"Review\"\nshort = \"\"\ninputs = [{{path=\"{selector}\", mode=\"single\"}}]\noutputs = [{{path=\"review.md\"}}]\nmodel = \"\"\nharness = \"\"\nis_coding_step = false\nauto_advance_default = false\n");
        self.source = self.source.replacen("\n+++\n", &format!("\n{step}+++\n"), 1);
        self.source.push_str("\n<!-- alinery:step review -->\nReview the output.\n");
        self.definition = parse_playbook_md(&self.source).unwrap();
        self.state.definition_identity = definition_identity(self.source.as_bytes());
    }
    fn reserve(&mut self, manual: bool) -> String {
        reserve_execution(
            &self.repo,
            "task",
            &self.definition,
            &mut self.state,
            ExecutionCandidate {
                step_key: "work".into(),
                context_id: "root".into(),
                inputs: BTreeMap::new(),
                complete_collection_id: None,
                each_collection_id: None,
                each_member_id: None,
                manual,
            },
            &LaunchChoices::default(),
            None,
            true,
        )
        .unwrap()
    }
    fn run(&mut self, id: &str) -> String {
        let session = self.state.executions[id].owner_session_id.clone();
        assert!(claim_execution_launch(&mut self.state, id).unwrap());
        record_execution_spawn(&mut self.state, id, &session, Ok(())).unwrap();
        session
    }
    fn write_output(&self, id: &str, index: usize, slot: Option<&str>) {
        let assignment = &self.state.executions[id].outputs[index];
        let relative = match slot {
            Some(slot) => assignment.relative_path.replace('*', slot),
            None => assignment.relative_path.clone(),
        };
        let path = crate::artifacts_dir(&self.repo, "task").join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "real output").unwrap();
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
    let completed = f.reserve(true);
    let owner = f.run(&completed);
    f.write_output(&completed, 0, None);
    report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &completed, &owner, 0).unwrap();
    confirm_execution_exit(&mut f.state, &completed, &owner, Some(0)).unwrap();
    let uncertain = f.reserve(true);
    f.run(&uncertain);
    let queued = f.reserve(true);
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
        let mut state = read_execution_state(&f.repo, slug).unwrap();
        assert_eq!(state.owning_lane, "next");
        assert_eq!(state.owning_app_config_identity, "next-config");
        assert_eq!(state.executions[&completed], f.state.executions[&completed]);
        assert_eq!(state.executions[&queued], f.state.executions[&queued]);
        assert_eq!(state.occurrences, f.state.occurrences);
        assert_eq!(state.executions[&uncertain].lifecycle, ExecutionLifecycle::Interrupted);
        assert!(!state.executions[&uncertain].shutdown_confirmed);
        assert_eq!(state.executions[&uncertain].owner_session_id, f.state.executions[&uncertain].owner_session_id);
        assert!(recover_execution_owner(&mut state, &uncertain).is_err());
    }
    assert_eq!(fs::read(artifact).unwrap(), output);
}

#[test]
fn repo_round_trip_adopts_active_and_archived_tasks_preserving_evidence() {
    let mut f = Fixture::new("{path=\"result.md\"}", false, true, 10);
    let completed = f.reserve(true);
    let owner = f.run(&completed);
    f.write_output(&completed, 0, None);
    report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &completed, &owner, 0).unwrap();
    confirm_execution_exit(&mut f.state, &completed, &owner, Some(0)).unwrap();
    let uncertain = f.reserve(true);
    f.run(&uncertain);
    let queued = f.reserve(true);
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
            let mut state = read_execution_state(&f.repo, slug).unwrap();
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
            assert!(recover_execution_owner(&mut state, &uncertain).is_err());
            assert!(!claim_execution_launch(&mut state, &uncertain).unwrap());
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
    let completed = f.reserve(true);
    let owner = f.run(&completed);
    f.write_output(&completed, 0, None);
    report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &completed, &owner, 0).unwrap();
    confirm_execution_exit(&mut f.state, &completed, &owner, Some(0)).unwrap();
    let uncertain = f.reserve(true);
    f.run(&uncertain);
    let finishing = f.reserve(true);
    let finishing_owner = f.run(&finishing);
    f.write_output(&finishing, 0, None);
    report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &finishing, &finishing_owner, 0).unwrap();
    let queued = f.reserve(true);
    persist_owner_fixture(&mut f);
    let artifact = crate::artifacts_dir(&f.repo, "task").join(&f.state.executions[&completed].outputs[0].relative_path);
    let bytes = fs::read(&artifact).unwrap();
    let _ownership = crate::repo_ownership::acquire(&f.repo, "new-lane", "new-config").unwrap();
    let mut transferred = read_execution_state(&f.repo, "task").unwrap();
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
    assert!(recover_execution_owner(&mut transferred, &uncertain).is_err());
    assert!(recover_execution_owner(&mut transferred, &completed).is_err());
    assert!(recover_execution_owner(&mut transferred, &finishing).is_err());
    assert!(!claim_execution_launch(&mut transferred, &uncertain).unwrap());
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

fn assert_rejected_without_publication(f: &mut Fixture, id: &str, owner: &str) {
    let before = f.state.executions[id].clone();
    let outcome = report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, id, owner, 0).unwrap();
    assert!(matches!(outcome, CompletionOutcome::InvalidOutputs { .. }), "{outcome:?}");
    assert!(f.state.occurrences.is_empty());
    let after = &f.state.executions[id];
    assert_eq!(after.lifecycle, ExecutionLifecycle::Running);
    assert_eq!(after.receipt_id, None);
    assert_eq!(after.continuation_mode, before.continuation_mode);
    assert_eq!(after.outputs, before.outputs);
    assert_eq!(after.owner_session_id, before.owner_session_id);
}

#[test]
fn possible_outputs_zero_exact_publications_remain_interactive() {
    let mut f = Fixture::new("{path=\"continue.md\"}, {path=\"stop.md\"}", true, false, 2);
    let id = f.reserve(true);
    let waiting = f.reserve(true);
    let owner = f.run(&id);

    fs::write(crate::artifacts_dir(&f.repo, "task").join("auxiliary.md"), "not assigned").unwrap();
    assert_rejected_without_publication(&mut f, &id, &owner);
    assert!(!claim_execution_launch(&mut f.state, &waiting).unwrap());
    f.write_output(&id, 1, None);
    let outcome = report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap();
    assert!(matches!(outcome, CompletionOutcome::Accepted { .. }), "{outcome:?}");
    assert_eq!(f.state.occurrences.values().map(|o| o.logical_path.as_str()).collect::<Vec<_>>(), ["stop.md"]);
}

#[cfg(unix)]
#[test]
fn invalid_present_optional_outputs_reject_atomically() {
    use std::{
        ffi::CString,
        os::unix::{ffi::OsStrExt, fs::symlink},
    };
    for kind in ["empty", "directory", "fifo", "live-link", "dangling-link", "ancestor-link", "ancestor-file", "empty-slot"] {
        let output = if kind == "empty-slot" { "details/*.md" } else { "details/result.md" };
        let mut f = Fixture::new(&format!("{{path=\"summary.md\"}}, {{path=\"{output}\"}}"), false, false, 1);
        let id = f.reserve(false);
        let owner = f.run(&id);

        f.write_output(&id, 0, None);
        let root = crate::artifacts_dir(&f.repo, "task");
        let path = root.join(f.state.executions[&id].outputs[1].relative_path.replace('*', ""));
        let parent = path.parent().unwrap();
        let outside = f.repo.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("target.md"), "outside evidence").unwrap();
        match kind {
            "ancestor-link" => symlink(&outside, parent).unwrap(),
            "ancestor-file" => fs::write(parent, "not a directory").unwrap(),
            _ => {
                fs::create_dir_all(parent).unwrap();
                match kind {
                    "empty" => fs::write(&path, "").unwrap(),
                    "directory" => fs::create_dir(&path).unwrap(),
                    "fifo" => {
                        let name = CString::new(path.as_os_str().as_bytes()).unwrap();
                        // SAFETY: name is a NUL-terminated path retained for this call.
                        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
                    }
                    "live-link" => symlink(outside.join("target.md"), &path).unwrap(),
                    "dangling-link" => symlink(outside.join("absent.md"), &path).unwrap(),
                    "empty-slot" => fs::write(&path, "invalid wildcard slot").unwrap(),
                    _ => unreachable!(),
                }
            }
        }
        assert_rejected_without_publication(&mut f, &id, &owner);
        match kind {
            "ancestor-link" | "ancestor-file" => fs::remove_file(parent).unwrap(),
            "directory" => fs::remove_dir(&path).unwrap(),
            _ => fs::remove_file(&path).unwrap(),
        }
        f.write_output(&id, 1, (kind == "empty-slot").then_some("valid"));
        assert!(
            matches!(
                report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap(),
                CompletionOutcome::Accepted { .. }
            ),
            "{kind}"
        );
        assert_eq!(fs::read(outside.join("target.md")).unwrap(), b"outside evidence");
    }
}

#[cfg(unix)]
#[test]
fn inaccessible_optional_family_rejects_atomically() {
    use std::os::unix::fs::PermissionsExt;
    struct Restore(PathBuf, fs::Permissions);
    impl Drop for Restore {
        fn drop(&mut self) {
            fs::set_permissions(&self.0, self.1.clone()).unwrap();
        }
    }
    let mut f = Fixture::new("{path=\"summary.md\"}, {path=\"papers/*.md\"}", false, false, 1);
    let id = f.reserve(false);
    let owner = f.run(&id);

    f.write_output(&id, 0, None);
    let parent = crate::artifacts_dir(&f.repo, "task").join("papers");
    fs::create_dir(&parent).unwrap();
    let restore = Restore(parent.clone(), fs::metadata(&parent).unwrap().permissions());
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o000)).unwrap();
    assert_eq!(
        fs::read_dir(&parent).unwrap_err().kind(),
        std::io::ErrorKind::PermissionDenied,
        "must run as an unprivileged user"
    );
    assert_rejected_without_publication(&mut f, &id, &owner);
    drop(restore);
    f.write_output(&id, 1, Some("valid"));
    assert!(matches!(
        report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap(),
        CompletionOutcome::Accepted { .. }
    ));
}

// APFS rejects non-UTF-8 filenames at creation (EILSEQ); exercise enumeration on Linux.
#[cfg(target_os = "linux")]
#[test]
fn non_utf8_output_directory_entry_remains_an_error() {
    use std::{ffi::OsString, os::unix::ffi::OsStringExt};
    let mut f = Fixture::new("{path=\"summary.md\"}, {path=\"papers/*.md\"}", false, false, 1);
    let id = f.reserve(false);
    let owner = f.run(&id);

    f.write_output(&id, 0, None);
    f.write_output(&id, 1, Some("valid"));
    let invalid = crate::artifacts_dir(&f.repo, "task").join("papers").join(OsString::from_vec(vec![0xff]));
    fs::write(&invalid, "unrelated").unwrap();
    assert_rejected_without_publication(&mut f, &id, &owner);
    fs::remove_file(invalid).unwrap();
    assert!(matches!(
        report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap(),
        CompletionOutcome::Accepted { .. }
    ));
}

#[test]
fn observed_wildcard_member_disappearance_is_not_omission() {
    let mut f = Fixture::new("{path=\"papers/*.md\"}", false, true, 1);
    let id = f.reserve(false);
    f.write_output(&id, 0, Some("observed"));
    let assignment = &f.state.executions[&id].outputs[0];
    let physical = ArtifactSelector::parse(&assignment.relative_path).unwrap();
    let root = crate::artifacts_dir(&f.repo, "task");
    let observed: Vec<_> = fs::read_dir(root.join("papers"))
        .unwrap()
        .map(|entry| format!("papers/{}", entry.unwrap().file_name().to_str().unwrap()))
        .filter(|path| physical.matches(path))
        .collect();
    assert_eq!(observed, [assignment.relative_path.replace('*', "observed")]);
    fs::remove_file(root.join(&observed[0])).unwrap();
    assert!(validate_assigned_paths(&root, assignment, &physical, observed, &[]).is_err());
}

#[test]
fn unobserved_exact_path_is_omitted_at_validation_boundary() {
    let mut f = Fixture::new("{path=\"absent/result.md\"}", false, true, 1);
    let id = f.reserve(false);
    let assignment = &f.state.executions[&id].outputs[0];
    let physical = ArtifactSelector::parse(&assignment.relative_path).unwrap();
    assert_eq!(
        validate_assigned_paths(&crate::artifacts_dir(&f.repo, "task"), assignment, &physical, vec![assignment.relative_path.clone()], &[]),
        Ok(Vec::new())
    );
}

#[test]
fn reservations_are_disjoint_before_outputs_and_persist_unchanged() {
    let mut f = Fixture::new("{path=\"research/request-*.md\"}, {path=\"01-summary.md\"}", false, true, 10);
    let a = f.reserve(true);
    let b = f.reserve(true);
    assert_eq!(f.state.executions[&a].outputs[0].relative_path, "research/1-request-*-1.md");
    assert_eq!(f.state.executions[&b].outputs[0].relative_path, "research/1-request-*-2.md");
    assert_eq!(f.state.executions[&a].outputs[1].relative_path, "1-01-summary-1.md");
    let before = f.state.executions.clone();
    write_execution_state_unlocked(&f.repo, "task", &mut f.state).unwrap();
    assert_eq!(read_execution_state(&f.repo, "task").unwrap().executions, before);
}

#[test]
fn reservations_keep_case_distinct_roles_physically_disjoint() {
    let mut f = Fixture::new("{path=\"result.md\"}, {path=\"Result.md\"}", false, true, 10);
    let first = f.reserve(true);
    let second = f.reserve(true);
    let paths: BTreeSet<_> = [&first, &second]
        .into_iter()
        .flat_map(|id| &f.state.executions[id].outputs)
        .map(|output| output.relative_path.to_lowercase())
        .collect();
    assert_eq!(paths.len(), 4, "case-insensitive filesystems must not alias output reservations");
    let owner = f.run(&first);
    f.write_output(&first, 0, None);
    let accepted = report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &first, &owner, 0).unwrap();
    assert!(matches!(accepted, CompletionOutcome::Accepted { .. }), "{accepted:?}");
    assert_eq!(f.state.occurrences.values().map(|o| o.logical_path.as_str()).collect::<Vec<_>>(), ["result.md"]);
    let publications = f.state.occurrences.clone();
    let reservations = f.state.executions[&first].outputs.clone();
    f.write_output(&first, 1, None);
    write_execution_state_unlocked(&f.repo, "task", &mut f.state).unwrap();
    f.state = read_execution_state(&f.repo, "task").unwrap();
    assert_eq!(report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &first, &owner, 0).unwrap(), accepted);
    assert_eq!(f.state.occurrences, publications, "late files must not extend an accepted receipt");
    assert_eq!(f.state.executions[&first].outputs, reservations);
    assert_eq!(f.state.executions[&first].owner_session_id, owner);
}

#[test]
fn reserved_output_namespaces_reject_retained_definitions_without_overwriting_evidence() {
    let mut f = Fixture::new("{path=\"reports/result.md\"}", false, true, 10);
    let root = crate::artifacts_dir(&f.repo, "task");
    let original = b"user evidence\0must remain unchanged\n";
    for namespace in ["attachments", "subtasks"] {
        fs::create_dir_all(root.join(namespace)).unwrap();
        fs::write(root.join(namespace).join("1-result-1.md"), original).unwrap();
    }
    for namespace in ["Attachments", "Subtasks"] {
        let source = f.source.replace("reports/result.md", &format!("{namespace}/result.md"));
        // Model a task retained before the reserved-name validation was fixed.
        fs::write(task_playbook_path(&f.repo, "task").unwrap(), &source).unwrap();
        f.state.definition_identity = definition_identity(source.as_bytes());
        let loaded = read_task_playbook(&f.repo, "task", &f.state);
        if let Ok(definition) = &loaded {
            f.definition = definition.clone();
            let id = f.reserve(true);
            f.write_output(&id, 0, None);
        }
        for reserved in ["attachments", "subtasks"] {
            assert_eq!(fs::read(root.join(reserved).join("1-result-1.md")).unwrap(), original, "{namespace} overwrote {reserved}");
        }
        assert!(loaded.unwrap_err().contains("reserved_output_namespace"));
    }

    // Normal outputs still run without treating user evidence as generated artifacts.
    fs::write(task_playbook_path(&f.repo, "task").unwrap(), &f.source).unwrap();
    f.state.definition_identity = definition_identity(f.source.as_bytes());
    f.definition = read_task_playbook(&f.repo, "task", &f.state).unwrap();
    let id = f.reserve(false);
    let owner = f.run(&id);
    f.write_output(&id, 0, None);
    assert!(matches!(
        report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap(),
        CompletionOutcome::Accepted { .. }
    ));
    assert_eq!(f.state.occurrences.values().map(|o| o.logical_path.as_str()).collect::<Vec<_>>(), ["reports/result.md"]);
    for namespace in ["attachments", "subtasks"] {
        assert_eq!(fs::read(root.join(namespace).join("1-result-1.md")).unwrap(), original);
    }
}

#[test]
fn allocation_has_no_999_collision_limit() {
    let mut f = Fixture::new("{path=\"result.md\"}", false, true, 10);
    for i in 1..=1001 {
        fs::write(crate::artifacts_dir(&f.repo, "task").join(format!("1-result-{i}.md")), "existing").unwrap();
    }
    let id = f.reserve(false);
    assert_eq!(f.state.executions[&id].outputs[0].relative_path, "1-result-1002.md");
}

#[test]
fn wildcard_acceptance_attributes_all_and_only_reserved_members() {
    let mut f = Fixture::new("{path=\"request-*.md\"}", false, true, 10);
    let a = f.reserve(true);
    let b = f.reserve(true);
    let owner = f.run(&a);
    f.write_output(&a, 0, Some("a-10"));
    f.write_output(&a, 0, Some("b"));
    f.write_output(&b, 0, Some("c"));
    assert!(matches!(
        report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &a, &owner, 0).unwrap(),
        CompletionOutcome::Accepted { .. }
    ));
    let logical: BTreeSet<_> = f.state.occurrences.values().map(|o| o.logical_path.as_str()).collect();
    assert_eq!(logical, BTreeSet::from(["request-a-10.md", "request-b.md"]));
    assert!(f.state.occurrences.values().all(|o| !occurrence_deliverable(&f.state, o)));
    confirm_execution_exit(&mut f.state, &a, &owner, Some(0)).unwrap();
    assert!(f.state.occurrences.values().all(|o| occurrence_deliverable(&f.state, o)));
}

#[test]
fn invalid_output_stays_interactive_and_acceptance_replays_receipt() {
    let mut f = Fixture::new("{path=\"result.md\"}, {path=\"summary.md\"}", true, false, 2);
    let id = f.reserve(false);
    let owner = f.run(&id);
    f.write_output(&id, 1, None);
    fs::write(crate::artifacts_dir(&f.repo, "task").join(&f.state.executions[&id].outputs[0].relative_path), "").unwrap();
    let reservations = f.state.executions[&id].outputs.clone();
    assert!(matches!(
        report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap(),
        CompletionOutcome::InvalidOutputs { .. }
    ));
    assert!(f.state.occurrences.is_empty());
    assert_eq!(f.state.executions[&id].lifecycle, ExecutionLifecycle::Running);
    assert_eq!(f.state.executions[&id].receipt_id, None);
    assert_eq!(f.state.executions[&id].outputs, reservations);
    f.write_output(&id, 0, None);
    let accepted = report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap();
    assert!(matches!(accepted, CompletionOutcome::Accepted { .. }));
    assert_eq!(report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap(), accepted);
    assert_eq!(
        f.state.occurrences.values().map(|o| o.logical_path.as_str()).collect::<BTreeSet<_>>(),
        BTreeSet::from(["result.md", "summary.md"])
    );
    assert!(recover_execution_owner(&mut f.state, &id).is_err());
}

#[test]
fn capacity_and_coding_ownership_survive_review_and_finishing() {
    let mut f = Fixture::new("{path=\"result.md\"}", true, false, 2);
    let a = f.reserve(true);
    let b = f.reserve(true);
    let owner = f.run(&a);
    assert!(!claim_execution_launch(&mut f.state, &b).unwrap());

    f.write_output(&a, 0, None);
    report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &a, &owner, 0).unwrap();
    assert!(!claim_execution_launch(&mut f.state, &b).unwrap());
    confirm_execution_exit(&mut f.state, &a, &owner, Some(0)).unwrap();
    assert!(claim_execution_launch(&mut f.state, &b).unwrap());
    let mut g = Fixture::new("{path=\"result.md\"}", false, true, 1);
    let a = g.reserve(true);
    let b = g.reserve(true);
    let owner = g.run(&a);
    assert!(!claim_execution_launch(&mut g.state, &b).unwrap());
    confirm_execution_exit(&mut g.state, &a, &owner, Some(1)).unwrap();
    assert!(claim_execution_launch(&mut g.state, &b).unwrap());
}

#[test]
fn step_continuation_persists_current_and_future_policy_without_revoking_handoffs() {
    let mut f = Fixture::new("{path=\"result.md\"}", false, false, 10);
    f.add_consumer("result.md");
    let id = f.reserve(false);
    let owner = f.run(&id);
    f.write_output(&id, 0, None);
    assert_eq!(
        report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap(),
        CompletionOutcome::Ready { ready_revision: 0 }
    );
    set_step_continuation(&mut f.state, &f.definition, "work", true).unwrap();
    let queued = f.reserve(true);
    persist_owner_fixture(&mut f);
    f.state = read_execution_state(&f.repo, "task").unwrap();
    assert_eq!(f.state.executions[&queued].continuation_mode, ContinuationMode::Automatic);
    let requested = f.state.executions[&id].clone();
    set_step_continuation(&mut f.state, &f.definition, "work", false).unwrap();
    assert_eq!(f.state.executions[&id], requested);
    assert_eq!(f.state.executions[&queued].continuation_mode, ContinuationMode::Manual);
    let future = f.reserve(true);
    assert_eq!(f.state.executions[&future].continuation_mode, ContinuationMode::Manual);
    assert!(matches!(
        finalize_execution_continuation(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap(),
        CompletionOutcome::Accepted { .. }
    ));
    let accepted = f.state.executions[&id].clone();
    set_step_continuation(&mut f.state, &f.definition, "work", true).unwrap();
    set_step_continuation(&mut f.state, &f.definition, "work", false).unwrap();
    assert_eq!(f.state.executions[&id], accepted);
    assert!(!f.state.enabled_steps.contains("work"));
}

#[test]
fn step_continuation_requires_fresh_readiness_and_revalidates_outputs() {
    let mut f = Fixture::new("{path=\"result.md\", required=true}", false, false, 10);
    f.add_consumer("result.md");
    let id = f.reserve(false);
    let owner = f.run(&id);
    f.write_output(&id, 0, None);
    report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap();
    invalidate_execution_readiness(&mut f.state, &id, &owner, 1).unwrap();
    set_step_continuation(&mut f.state, &f.definition, "work", true).unwrap();
    assert_eq!(f.state.executions[&id].continuation_requested_revision, None);
    assert!(matches!(
        finalize_execution_continuation(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap(),
        CompletionOutcome::Stale { .. }
    ));
    set_step_continuation(&mut f.state, &f.definition, "work", false).unwrap();
    assert_eq!(
        report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 1).unwrap(),
        CompletionOutcome::Ready { ready_revision: 1 }
    );
    fs::remove_file(crate::artifacts_dir(&f.repo, "task").join(&f.state.executions[&id].outputs[0].relative_path)).unwrap();
    set_step_continuation(&mut f.state, &f.definition, "work", true).unwrap();
    assert!(matches!(
        finalize_execution_continuation(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 1).unwrap(),
        CompletionOutcome::InvalidOutputs { .. }
    ));
    assert!(f.state.occurrences.is_empty());
    assert!(f.state.executions[&id].receipt_id.is_none());
}

#[test]
fn step_continuation_rejects_unknown_steps_and_manual_override_without_mutation() {
    let mut f = Fixture::new("{path=\"result.md\"}", false, false, 10);
    let before = f.state.clone();
    assert!(set_step_continuation(&mut f.state, &f.definition, "missing", true).unwrap_err().contains("unknown step"));
    assert_eq!(f.state, before);
    set_execution_auto_approve_all(&mut f.state, true);
    let before = f.state.clone();
    assert!(set_step_continuation(&mut f.state, &f.definition, "work", false).unwrap_err().contains("Auto Approval All"));
    assert_eq!(f.state, before);
}

#[test]
fn auto_approve_all_advances_ready_work_without_another_report_and_off_restores_manual_gate() {
    let mut f = Fixture::new("{path=\"result.md\"}", false, false, 10);
    f.add_consumer("result.md");
    let devised = f.state.enabled_steps.clone();
    let id = f.reserve(false);
    let owner = f.run(&id);
    f.write_output(&id, 0, None);
    assert_eq!(
        report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap(),
        CompletionOutcome::Ready { ready_revision: 0 }
    );
    set_execution_auto_approve_all(&mut f.state, true);
    assert!(matches!(
        finalize_execution_continuation(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap(),
        CompletionOutcome::Accepted { .. }
    ));
    confirm_execution_exit(&mut f.state, &id, &owner, Some(0)).unwrap();
    let mut next_step = f.definition.step[0].clone();
    next_step.key = "next-work".into();
    f.definition.step.push(next_step);
    let again = reserve_execution(
        &f.repo,
        "task",
        &f.definition,
        &mut f.state,
        ExecutionCandidate {
            step_key: "next-work".into(),
            context_id: "root".into(),
            inputs: BTreeMap::new(),
            complete_collection_id: None,
            each_collection_id: None,
            each_member_id: None,
            manual: false,
        },
        &LaunchChoices::default(),
        None,
        true,
    )
    .unwrap();
    let owner = f.run(&again);
    f.write_output(&again, 0, None);
    set_execution_auto_approve_all(&mut f.state, false);
    assert_eq!(
        report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &again, &owner, 0).unwrap(),
        CompletionOutcome::Ready { ready_revision: 0 }
    );
    assert!(matches!(
        finalize_execution_continuation(&f.repo, "task", &f.definition, &mut f.state, &again, &owner, 0).unwrap(),
        CompletionOutcome::Stale { .. }
    ));
    assert_eq!(f.state.enabled_steps, devised);
    assert_eq!(f.state.executions[&again].continuation_mode, ContinuationMode::Manual);
}

#[test]
fn auto_approve_all_revalidates_ready_artifacts_and_rejects_stale_readiness() {
    let mut f = Fixture::new("{path=\"result.md\", required=true}", false, false, 10);
    f.add_consumer("result.md");
    let id = f.reserve(false);
    let owner = f.run(&id);
    f.write_output(&id, 0, None);
    assert_eq!(
        report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap(),
        CompletionOutcome::Ready { ready_revision: 0 }
    );
    fs::remove_file(crate::artifacts_dir(&f.repo, "task").join(&f.state.executions[&id].outputs[0].relative_path)).unwrap();
    set_execution_auto_approve_all(&mut f.state, true);
    assert!(matches!(
        finalize_execution_continuation(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap(),
        CompletionOutcome::InvalidOutputs { .. }
    ));
    f.write_output(&id, 0, None);
    assert!(matches!(
        finalize_execution_continuation(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap(),
        CompletionOutcome::Stale { .. }
    ));
    assert!(f.state.occurrences.is_empty());
    assert!(f.state.executions[&id].receipt_id.is_none());
}

#[test]
fn auto_approve_all_still_requires_outputs_and_shared_supplied_validation() {
    let mut f = Fixture::new("{path=\"result.md\", required=true}, {path=\"notes.md\"}", false, false, 1);
    f.add_consumer("result.md");
    set_execution_auto_approve_all(&mut f.state, true);
    let id = f.reserve(false);
    let owner = f.run(&id);
    f.write_output(&id, 1, None);
    assert!(matches!(
        report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap(),
        CompletionOutcome::InvalidOutputs { .. }
    ));
    let record = &f.state.executions[&id];
    let notes = crate::SuppliedExecutionArtifact {
        relative_path: record.outputs[1].relative_path.clone(),
        content: "notes alone are insufficient".into(),
    };
    assert!(inspect_supplied_execution_publications(&f.repo, "task", record, &[notes]).is_err());
    let result = crate::SuppliedExecutionArtifact {
        relative_path: record.outputs[0].relative_path.clone(),
        content: "required result".into(),
    };
    assert!(inspect_supplied_execution_publications(&f.repo, "task", record, &[result]).is_ok());
    f.write_output(&id, 0, None);
    assert!(matches!(
        report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap(),
        CompletionOutcome::Accepted { .. }
    ));
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
fn stopped_owner_recovery_retires_old_readiness_without_retrying() {
    let mut f = Fixture::new("{path=\"result.md\"}", true, false, 1);
    let id = f.reserve(false);
    let old = f.run(&id);

    assert!(recover_execution_owner(&mut f.state, &id).is_err());
    confirm_execution_exit(&mut f.state, &id, &old, Some(1)).unwrap();
    assert!(!claim_execution_launch(&mut f.state, &id).unwrap());
    let replacement = recover_execution_owner(&mut f.state, &id).unwrap();
    assert_ne!(old, replacement);
    assert!(report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &old, 0).is_err());
    assert!(!claim_execution_launch(&mut f.state, &id).unwrap());
    request_execution_start(&mut f.state, &id).unwrap();
    f.run(&id);
    f.write_output(&id, 0, None);
    assert!(matches!(
        report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &replacement, 0).unwrap(),
        CompletionOutcome::Accepted { .. }
    ));
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
fn accepted_completion_requires_successful_exit_and_exit_replay_is_immutable() {
    for exit_code in [Some(0), Some(1), None] {
        let mut f = Fixture::new("{path=\"result.md\"}", false, true, 1);
        let id = f.reserve(false);
        let owner = f.run(&id);
        f.write_output(&id, 0, None);
        let accepted = report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap();
        confirm_execution_exit(&mut f.state, &id, &owner, exit_code).unwrap();
        let successful = exit_code == Some(0);
        assert_eq!(
            f.state.executions[&id].lifecycle,
            if successful { ExecutionLifecycle::Completed } else { ExecutionLifecycle::Failed }
        );
        assert_eq!(f.state.executions[&id].error.is_none(), successful);
        assert!(f.state.occurrences.values().all(|o| occurrence_deliverable(&f.state, o) == successful));
        let confirmed = f.state.clone();
        confirm_execution_exit(&mut f.state, &id, &owner, exit_code).unwrap();
        assert_eq!(f.state, confirmed);
        let conflicting_code = if successful { Some(1) } else { Some(0) };
        assert!(confirm_execution_exit(&mut f.state, &id, &owner, conflicting_code).is_err());
        assert_eq!(f.state, confirmed);
        assert!(confirm_execution_exit(&mut f.state, &id, "stale-owner", exit_code).is_err());
        assert_eq!(f.state, confirmed);
        assert_eq!(report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap(), accepted);
        assert_eq!(f.state, confirmed);
    }
}

#[test]
fn capacity_noop_preserves_durable_state_and_real_mutations_commit() {
    use std::os::unix::fs::MetadataExt;
    let mut f = Fixture::new("{path=\"result.md\"}", false, true, 1);
    let running = f.reserve(true);
    let owner = f.run(&running);
    let waiting = f.reserve(true);
    persist_owner_fixture(&mut f);
    let path = execution_state_path(&f.repo, "task").unwrap();
    let before = fs::read(&path).unwrap();
    let inode = fs::metadata(&path).unwrap().ino();
    let revision = f.state.revision;

    assert!(!mutate_execution_state(&f.repo, "task", "lane", "", "full capacity", |_, state| { claim_execution_launch(state, &waiting) }).unwrap());
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(fs::metadata(&path).unwrap().ino(), inode, "full capacity must not replace the durable state file");
    assert_eq!(read_execution_state(&f.repo, "task").unwrap().revision, revision);

    mutate_execution_state(&f.repo, "task", "lane", "", "release capacity", |_, state| {
        confirm_execution_exit(state, &running, &owner, Some(1))
    })
    .unwrap();
    assert!(mutate_execution_state(&f.repo, "task", "lane", "", "claim capacity", |_, state| { claim_execution_launch(state, &waiting) }).unwrap());
    let committed = read_execution_state(&f.repo, "task").unwrap();
    assert_eq!(committed.revision, revision + 2);
    assert_eq!(committed.executions[&waiting].lifecycle, ExecutionLifecycle::Starting);
    assert_eq!(committed.executions[&running].lifecycle, ExecutionLifecycle::Failed);
}

#[test]
fn unchanged_reconcile_preserves_durable_state_and_checks_ownership() {
    let mut f = Fixture::new("{path=\"result.md\"}", false, true, 1);
    f.reserve(false);
    crate::playbook_scheduler::reconcile_graph(&f.definition, &mut f.state).unwrap();
    persist_owner_fixture(&mut f);
    let path = execution_state_path(&f.repo, "task").unwrap();
    let before = fs::read(&path).unwrap();

    let candidates = mutate_execution_state(&f.repo, "task", "lane", "", "unchanged reconcile", |definition, state| {
        crate::playbook_scheduler::reconcile_graph(definition, state)
    })
    .unwrap();
    assert!(candidates.is_empty());
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(read_execution_state(&f.repo, "task").unwrap().revision, f.state.revision);
    for (lane, config) in [("other-lane", ""), ("lane", "other-config")] {
        assert!(mutate_execution_state(&f.repo, "task", lane, config, "foreign no-op", |_, _| -> Result<(), String> {
            panic!("foreign ownership must be rejected before mutation")
        })
        .is_err());
    }
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[test]
fn accepted_receipt_replay_preserves_durable_state_and_checks_owner() {
    let mut f = Fixture::new("{path=\"result.md\"}", false, true, 1);
    let id = f.reserve(false);
    let owner = f.run(&id);
    f.write_output(&id, 0, None);
    persist_owner_fixture(&mut f);
    let accepted = mutate_execution_state(&f.repo, "task", "lane", "", "accept completion", |_, state| {
        report_execution_ready(&f.repo, "task", &f.definition, state, &id, &owner, 0)
    })
    .unwrap();
    assert!(matches!(accepted, CompletionOutcome::Accepted { .. }));
    let path = execution_state_path(&f.repo, "task").unwrap();
    let before = fs::read(&path).unwrap();
    let committed = read_execution_state(&f.repo, "task").unwrap();
    assert_eq!(committed.revision, f.state.revision + 1);
    fs::remove_file(crate::artifacts_dir(&f.repo, "task").join(&f.state.executions[&id].outputs[0].relative_path)).unwrap();

    let replayed = mutate_execution_state(&f.repo, "task", "lane", "", "replay completion", |_, state| {
        report_execution_ready(&f.repo, "task", &f.definition, state, &id, &owner, 0)
    })
    .unwrap();
    assert_eq!(replayed, accepted);
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(mutate_execution_state(&f.repo, "task", "lane", "", "stale replay", |_, state| {
        report_execution_ready(&f.repo, "task", &f.definition, state, &id, "stale-owner", 0)
    })
    .is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(read_execution_state(&f.repo, "task").unwrap().revision, committed.revision);
}

#[test]
fn manual_reservation_cannot_smuggle_unrequired_input_bindings() {
    let mut f = Fixture::new("{path=\"result.md\"}", false, true, 1);
    let seed = install_seed(&mut f.state, "ticket.md", "00-ticket.md").unwrap();
    let candidate = ExecutionCandidate {
        step_key: "work".into(),
        context_id: "root".into(),
        inputs: BTreeMap::from([("ticket.md".into(), vec![seed])]),
        complete_collection_id: None,
        each_collection_id: None,
        each_member_id: None,
        manual: true,
    };
    assert!(reserve_execution(&f.repo, "task", &f.definition, &mut f.state, candidate, &LaunchChoices::default(), None, true).is_err());
    assert!(f.state.executions.is_empty());
}

#[cfg(unix)]
#[test]
fn reservation_and_completion_reject_symlink_output_parent() {
    use std::os::unix::fs::symlink;
    let mut f = Fixture::new("{path=\"research/result.md\"}", false, true, 1);
    let outside = f.repo.join("outside");
    fs::create_dir_all(&outside).unwrap();
    symlink(&outside, crate::artifacts_dir(&f.repo, "task").join("research")).unwrap();
    let candidate = ExecutionCandidate {
        step_key: "work".into(),
        context_id: "root".into(),
        inputs: BTreeMap::new(),
        complete_collection_id: None,
        each_collection_id: None,
        each_member_id: None,
        manual: false,
    };
    assert!(reserve_execution(&f.repo, "task", &f.definition, &mut f.state, candidate, &LaunchChoices::default(), None, true).is_err());
    assert!(fs::read_dir(outside).unwrap().next().is_none());
}

#[test]
fn completion_rejects_a_replaced_task_directory_without_publishing() {
    let mut f = Fixture::new("{path=\"result.md\"}", true, false, 1);
    let id = f.reserve(false);
    let owner = f.run(&id);

    f.write_output(&id, 0, None);
    let task = crate::artifacts_dir(&f.repo, "task").parent().unwrap().to_path_buf();
    let moved = f.repo.join("moved-task");
    fs::rename(&task, &moved).unwrap();
    std::os::unix::fs::symlink(&moved, &task).unwrap();
    assert!(matches!(
        report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap(),
        CompletionOutcome::InvalidOutputs { .. }
    ));
    assert!(f.state.occurrences.is_empty());
    fs::remove_file(&task).unwrap();
    fs::rename(&moved, &task).unwrap();
    assert!(matches!(
        report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap(),
        CompletionOutcome::Accepted { .. }
    ));
}

#[test]
fn backup_restore_retains_fixed_definition_execution_and_repo_library_only() {
    let mut f = Fixture::new("{path=\"result.md\"}", false, true, 2);
    let id = f.reserve(false);
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
    let id = f.reserve(false);
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
    let owner = f.run(&id);
    f.write_output(&id, 0, None);
    report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap();
    write_execution_state_unlocked(&f.repo, "task", &mut f.state).unwrap();
    let items = crate::list_artifacts_with_execution_metadata(&f.repo, "task", &f.state).unwrap();
    let output = items.iter().find(|item| item.name == "1-result-1.md").unwrap();
    assert_eq!(output.execution_id.as_deref(), Some(id.as_str()));
    assert_eq!(output.accepted, Some(true));
    assert_eq!(output.session_id, owner);
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
fn reservations_do_not_claim_another_outputs_required_directory_as_a_file() {
    let mut f = Fixture::new("{path=\"report.md\"}, {path=\"1-report-1.md/notes.md\"}", false, true, 1);
    let id = f.reserve(false);
    f.write_output(&id, 0, None);
    f.write_output(&id, 1, None);
    assert_ne!(f.state.executions[&id].outputs[0].relative_path, "1-report-1.md");
    let owner = f.run(&id);
    assert!(matches!(
        report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap(),
        CompletionOutcome::Accepted { .. }
    ));
}

#[test]
fn an_existing_directory_occupies_an_exact_output_filename() {
    let mut f = Fixture::new("{path=\"result.md\"}", false, true, 1);
    fs::create_dir_all(crate::artifacts_dir(&f.repo, "task").join("1-result-1.md")).unwrap();
    let id = f.reserve(false);
    f.write_output(&id, 0, None);
    assert_eq!(f.state.executions[&id].outputs[0].relative_path, "1-result-2.md");
}

#[test]
fn join_depth_uses_all_actual_parents_independent_of_completion_order() {
    use crate::playbook::{InputMode, InputSelector, OutputSelector};
    for short_first in [true, false] {
        let mut f = Fixture::new("{path=\"root.md\"}", false, true, 10);
        let template = f.definition.step[0].clone();
        f.definition.step = [
            ("root", vec![], "root.md"),
            ("short", vec!["root.md"], "short.md"),
            ("long2", vec!["root.md"], "long2.md"),
            ("long3", vec!["long2.md"], "long3.md"),
            ("long4", vec!["long3.md"], "long4.md"),
            ("long5", vec!["long4.md"], "long5.md"),
            ("join", vec!["short.md", "long5.md"], "joined.md"),
        ]
        .into_iter()
        .map(|(key, inputs, output)| {
            let mut step = template.clone();
            step.key = key.into();
            step.inputs = inputs
                .into_iter()
                .map(|path| InputSelector {
                    path: path.into(),
                    mode: InputMode::Single,
                })
                .collect();
            step.outputs = vec![OutputSelector {
                path: output.into(),
                required: false,
            }];
            step
        })
        .collect();
        f.definition.section_order = f.definition.step.iter().map(|step| step.key.clone()).collect();
        f.source = crate::render_playbook_md(&f.definition);
        f.definition = parse_playbook_md(&f.source).unwrap();
        f.state = new_execution_state(
            f.state.reference.clone(),
            &f.source,
            "lane".into(),
            10,
            f.definition.step.iter().map(|step| step.key.clone()).collect(),
            LaunchChoices::default(),
            BTreeMap::new(),
        )
        .unwrap();
        f.state.creation = "ready".into();
        let reserve = |f: &mut Fixture, key: &str| {
            let step = f.definition.step.iter().find(|step| step.key == key).unwrap();
            let inputs = step
                .inputs
                .iter()
                .map(|input| {
                    let occurrence = f.state.occurrences.values().find(|o| o.logical_path == input.path).unwrap();
                    (input.path.clone(), vec![occurrence.id.clone()])
                })
                .collect();
            reserve_execution(
                &f.repo,
                "task",
                &f.definition,
                &mut f.state,
                ExecutionCandidate {
                    step_key: key.into(),
                    context_id: "root".into(),
                    inputs,
                    complete_collection_id: None,
                    each_collection_id: None,
                    each_member_id: None,
                    manual: false,
                },
                &LaunchChoices::default(),
                None,
                true,
            )
            .unwrap()
        };
        let finish = |f: &mut Fixture, id: &str| {
            let owner = f.run(id);
            f.write_output(id, 0, None);
            report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, id, &owner, 0).unwrap();
            confirm_execution_exit(&mut f.state, id, &owner, Some(0)).unwrap();
        };
        let root = reserve(&mut f, "root");
        finish(&mut f, &root);
        let short = reserve(&mut f, "short");
        if short_first {
            finish(&mut f, &short);
        }
        for key in ["long2", "long3", "long4", "long5"] {
            let id = reserve(&mut f, key);
            finish(&mut f, &id);
        }
        if !short_first {
            finish(&mut f, &short);
        }
        let join = reserve(&mut f, "join");
        assert_eq!(f.state.executions[&join].depth, 6);
        assert_eq!(f.state.executions[&join].outputs[0].relative_path, "6-joined-1.md");
        let depths: BTreeSet<_> = f.state.executions[&join].parent_execution_ids.iter().map(|id| f.state.executions[id].depth).collect();
        assert_eq!(depths, BTreeSet::from([2, 5]));
    }
}

#[test]
fn possible_outputs_accept_second_exact_outcome_without_first() {
    let mut f = Fixture::new("{path=\"continue.md\"}, {path=\"stop.md\"}", true, true, 2);
    let id = f.reserve(true);
    let waiting = f.reserve(true);
    let owner = f.run(&id);
    f.write_output(&id, 1, None);
    let accepted = report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap();
    assert!(matches!(accepted, CompletionOutcome::Accepted { .. }), "{accepted:?}");
    assert_eq!(f.state.occurrences.values().map(|o| o.logical_path.as_str()).collect::<Vec<_>>(), ["stop.md"]);
    assert_eq!(f.state.executions[&id].lifecycle, ExecutionLifecycle::Finishing);
    assert!(!claim_execution_launch(&mut f.state, &waiting).unwrap(), "coding ownership survives subset acceptance");
    assert!(f.state.occurrences.values().all(|o| !occurrence_deliverable(&f.state, o)));
    confirm_execution_exit(&mut f.state, &id, &owner, Some(0)).unwrap();
    assert!(f.state.occurrences.values().all(|o| occurrence_deliverable(&f.state, o)));
    assert!(claim_execution_launch(&mut f.state, &waiting).unwrap());
}

#[test]
fn possible_outputs_accept_both_exact_outcomes_without_exclusivity() {
    let mut f = Fixture::new("{path=\"continue.md\"}, {path=\"stop.md\"}", false, true, 1);
    let id = f.reserve(false);
    let owner = f.run(&id);
    f.write_output(&id, 0, None);
    f.write_output(&id, 1, None);
    let accepted = report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap();
    assert!(matches!(accepted, CompletionOutcome::Accepted { .. }), "{accepted:?}");
    assert_eq!(
        f.state.occurrences.values().map(|o| o.logical_path.as_str()).collect::<BTreeSet<_>>(),
        BTreeSet::from(["continue.md", "stop.md"])
    );
}

#[test]
fn possible_outputs_summary_accepts_absent_nested_assignments() {
    let mut f = Fixture::new("{path=\"summary.md\"}, {path=\"details/result.md\"}, {path=\"papers/*.md\"}", false, true, 1);
    let id = f.reserve(true);
    let waiting = f.reserve(true);
    let owner = f.run(&id);
    f.write_output(&id, 0, None);
    let accepted = report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap();
    assert!(matches!(accepted, CompletionOutcome::Accepted { .. }), "{accepted:?}");
    assert_eq!(f.state.occurrences.values().map(|o| o.logical_path.as_str()).collect::<Vec<_>>(), ["summary.md"]);
    let publications = f.state.occurrences.clone();
    assert!(!claim_execution_launch(&mut f.state, &waiting).unwrap(), "subset acceptance still holds capacity");
    f.write_output(&id, 1, None);
    f.write_output(&id, 2, Some("late"));
    write_execution_state_unlocked(&f.repo, "task", &mut f.state).unwrap();
    f.state = read_execution_state(&f.repo, "task").unwrap();
    assert_eq!(report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap(), accepted);
    assert_eq!(f.state.occurrences, publications);
    assert!(f.state.occurrences.values().all(|o| !occurrence_deliverable(&f.state, o)));
    confirm_execution_exit(&mut f.state, &id, &owner, Some(0)).unwrap();
    assert!(claim_execution_launch(&mut f.state, &waiting).unwrap());
}

#[test]
fn possible_outputs_summary_accepts_wildcard_directory_with_no_matches() {
    let mut f = Fixture::new("{path=\"summary.md\"}, {path=\"papers/*.md\"}", false, true, 1);
    let id = f.reserve(false);
    let owner = f.run(&id);
    f.write_output(&id, 0, None);
    let directory = crate::artifacts_dir(&f.repo, "task").join("papers");
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("auxiliary.txt"), "not an assigned publication").unwrap();
    let accepted = report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap();
    assert!(matches!(accepted, CompletionOutcome::Accepted { .. }), "{accepted:?}");
    assert_eq!(f.state.occurrences.values().map(|o| o.logical_path.as_str()).collect::<Vec<_>>(), ["summary.md"]);
}

#[test]
fn possible_outputs_minimum_rejects_auxiliary_only_then_accepts_one_wildcard_member() {
    let mut f = Fixture::new("{path=\"papers/*.md\"}", true, false, 1);
    let id = f.reserve(true);
    let waiting = f.reserve(true);
    let owner = f.run(&id);
    let root = crate::artifacts_dir(&f.repo, "task");
    fs::create_dir_all(root.join("papers")).unwrap();
    fs::write(root.join("auxiliary.md"), "not assigned evidence").unwrap();
    let reservations = f.state.executions[&id].outputs.clone();
    let outcome = report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap();
    assert!(matches!(outcome, CompletionOutcome::InvalidOutputs { .. }), "{outcome:?}");
    assert!(f.state.occurrences.is_empty());
    assert_eq!(f.state.executions[&id].receipt_id, None);
    assert_eq!(f.state.executions[&id].lifecycle, ExecutionLifecycle::Running);
    assert_eq!(f.state.executions[&id].outputs, reservations);
    assert!(!claim_execution_launch(&mut f.state, &waiting).unwrap());
    f.write_output(&id, 0, Some("found"));
    let accepted = report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap();
    assert!(matches!(accepted, CompletionOutcome::Accepted { .. }), "{accepted:?}");
    assert_eq!(f.state.occurrences.values().map(|o| o.logical_path.as_str()).collect::<Vec<_>>(), ["papers/found.md"]);
}

#[test]
fn manual_ready_review_and_fresh_intent_survive_reload() {
    let mut f = Fixture::new("{path=\"result.md\"}", true, false, 2);
    f.add_consumer("result.md");
    let id = f.reserve(false);
    let other = f.reserve(true);
    let owner = f.run(&id);
    f.write_output(&id, 0, None);
    let before = f.state.occurrences.clone();
    assert_eq!(
        report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap(),
        CompletionOutcome::Ready { ready_revision: 0 }
    );
    assert_eq!(f.state.occurrences, before);
    assert_eq!(f.state.executions[&id].lifecycle, ExecutionLifecycle::Running);
    assert!(f.state.executions[&id].receipt_id.is_none());
    assert!(!claim_execution_launch(&mut f.state, &other).unwrap());
    assert_eq!(invalidate_execution_readiness(&mut f.state, &id, &owner, 1).unwrap(), 1);
    persist_owner_fixture(&mut f);
    f.state = read_execution_state(&f.repo, "task").unwrap();
    assert_eq!(f.state.executions[&id].last_ready_revision, Some(0));
    assert_eq!(f.state.executions[&id].ready_revision, None);
    assert!(matches!(
        request_execution_continuation(&mut f.state, &id, &owner, 0).unwrap(),
        CompletionOutcome::Stale { .. }
    ));
    assert_eq!(
        report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 1).unwrap(),
        CompletionOutcome::Ready { ready_revision: 1 }
    );
    f.state.revision += 7;
    assert_eq!(
        request_execution_continuation(&mut f.state, &id, &owner, 1).unwrap(),
        CompletionOutcome::Requested { ready_revision: 1 }
    );
    let requested = f.state.clone();
    assert!(invalidate_execution_readiness(&mut f.state, &id, &owner, 2).is_err());
    assert_eq!(f.state, requested, "losing work must not erase intent");
    assert!(f.state.executions[&id].receipt_id.is_none());
    let accepted = finalize_execution_continuation(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 1).unwrap();
    assert!(matches!(accepted, CompletionOutcome::Accepted { .. }));
    assert!(!claim_execution_launch(&mut f.state, &other).unwrap());
    fs::remove_file(crate::artifacts_dir(&f.repo, "task").join(&f.state.executions[&id].outputs[0].relative_path)).unwrap();
    let committed = f.state.clone();
    assert_eq!(
        finalize_execution_continuation(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 1).unwrap(),
        accepted
    );
    assert_eq!(f.state, committed);
    confirm_execution_exit(&mut f.state, &id, &owner, Some(0)).unwrap();
    assert!(claim_execution_launch(&mut f.state, &other).unwrap());
}

#[test]
fn invalid_finalization_requires_new_ready_generation_and_click() {
    let mut f = Fixture::new("{path=\"result.md\"}", false, false, 1);
    f.add_consumer("result.md");
    let id = f.reserve(false);
    let owner = f.run(&id);
    f.write_output(&id, 0, None);
    report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap();
    request_execution_continuation(&mut f.state, &id, &owner, 0).unwrap();
    fs::write(crate::artifacts_dir(&f.repo, "task").join(&f.state.executions[&id].outputs[0].relative_path), "").unwrap();
    assert!(matches!(
        finalize_execution_continuation(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap(),
        CompletionOutcome::InvalidOutputs { .. }
    ));
    assert!(f.state.occurrences.is_empty());
    assert_eq!(f.state.executions[&id].work_revision, 1);
    assert_eq!(f.state.executions[&id].last_ready_revision, Some(0));
    assert_eq!(f.state.executions[&id].continuation_requested_revision, None);
    f.write_output(&id, 0, None);
    assert_eq!(
        report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 1).unwrap(),
        CompletionOutcome::Ready { ready_revision: 1 }
    );
    assert!(matches!(
        request_execution_continuation(&mut f.state, &id, &owner, 0).unwrap(),
        CompletionOutcome::Stale { .. }
    ));
    assert!(matches!(
        finalize_execution_continuation(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 1).unwrap(),
        CompletionOutcome::Stale { .. }
    ));
    assert!(f.state.executions[&id].receipt_id.is_none());
    request_execution_continuation(&mut f.state, &id, &owner, 1).unwrap();
    assert!(matches!(
        finalize_execution_continuation(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 1).unwrap(),
        CompletionOutcome::Accepted { .. }
    ));
}

#[test]
fn changed_destination_assessment_requires_renewed_intent() {
    let mut f = Fixture::new("{path=\"result.md\"}, {path=\"summary.md\"}", false, false, 1);
    f.add_consumer("result.md");
    let id = f.reserve(false);
    let owner = f.run(&id);
    f.write_output(&id, 0, None);
    f.write_output(&id, 1, None);
    assert_eq!(
        report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap(),
        CompletionOutcome::Ready { ready_revision: 0 }
    );
    request_execution_continuation(&mut f.state, &id, &owner, 0).unwrap();
    fs::remove_file(crate::artifacts_dir(&f.repo, "task").join(&f.state.executions[&id].outputs[0].relative_path)).unwrap();
    assert!(matches!(
        finalize_execution_continuation(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap(),
        CompletionOutcome::Stale { .. }
    ));
    assert!(f.state.occurrences.is_empty());
    assert_eq!(f.state.executions[&id].work_revision, 1);
    assert_eq!(f.state.executions[&id].continuation_requested_revision, None);
    assert!(
        matches!(
            report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 1).unwrap(),
            CompletionOutcome::Accepted { .. }
        ),
        "fresh terminal readiness needs no redundant click"
    );
}

#[test]
fn duplicate_operations_cannot_advance_a_newer_generation() {
    let mut f = Fixture::new("{path=\"result.md\"}", false, false, 1);
    f.add_consumer("result.md");
    let id = f.reserve(false);
    let owner = f.run(&id);
    assert_eq!(invalidate_execution_readiness(&mut f.state, &id, &owner, 2).unwrap(), 1);
    f.write_output(&id, 0, None);
    report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 1).unwrap();
    persist_owner_fixture(&mut f);
    f.state = read_execution_state(&f.repo, "task").unwrap();
    let ready = f.state.clone();
    assert_eq!(invalidate_execution_readiness(&mut f.state, &id, &owner, 2).unwrap(), 1);
    assert!(invalidate_execution_readiness(&mut f.state, &id, &owner, 1).is_err());
    assert!(invalidate_execution_readiness(&mut f.state, &id, "foreign", 3).is_err());
    assert!(matches!(
        report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &id, &owner, 0).unwrap(),
        CompletionOutcome::Stale { .. }
    ));
    assert_eq!(f.state, ready);
    assert_eq!(invalidate_execution_readiness(&mut f.state, &id, &owner, 3).unwrap(), 2);
    assert!(invalidate_execution_readiness(&mut f.state, &id, &owner, 2).is_err());
    f.state.executions.get_mut(&id).unwrap().work_revision = MAX_WORK_REVISION;
    let exhausted = f.state.clone();
    assert!(invalidate_execution_readiness(&mut f.state, &id, &owner, 4).is_err());
    assert_eq!(f.state, exhausted);
    confirm_execution_exit(&mut f.state, &id, &owner, Some(1)).unwrap();
    let replacement = recover_execution_owner(&mut f.state, &id).unwrap();
    assert_ne!(owner, replacement);
    let record = &f.state.executions[&id];
    assert_eq!(record.continuation_mode, ContinuationMode::Manual);
    assert_eq!(
        (record.ready_revision, record.last_ready_revision, record.continuation_requested_revision),
        (None, None, None)
    );
}

fn legacy_state_bytes(state: &TaskExecutionState) -> Vec<u8> {
    let mut value = serde_json::to_value(state).unwrap();
    value["version"] = 1.into();
    for record in value["executions"].as_object_mut().unwrap().values_mut() {
        let permission = if !record["receipt_id"].is_null() {
            "consumed"
        } else if record["continuation_mode"] == "automatic" {
            "automatic"
        } else {
            "locked"
        };
        record["permission"] = serde_json::json!({"kind": permission});
        let object = record.as_object_mut().unwrap();
        for field in [
            "continuation_mode",
            "work_revision",
            "last_admission_sequence",
            "last_ready_revision",
            "ready_revision",
            "continuation_requested_revision",
            "ready_assessment",
        ] {
            object.remove(field);
        }
    }
    serde_json::to_vec(&value).unwrap()
}

#[test]
fn legacy_conversion_preserves_history_without_minting_intent() {
    let mut f = Fixture::new("{path=\"result.md\"}", false, true, 3);
    let accepted = f.reserve(true);
    let owner = f.run(&accepted);
    f.write_output(&accepted, 0, None);
    report_execution_ready(&f.repo, "task", &f.definition, &mut f.state, &accepted, &owner, 0).unwrap();
    confirm_execution_exit(&mut f.state, &accepted, &owner, Some(0)).unwrap();
    let running = f.reserve(true);
    let running_owner = f.run(&running);
    let queued = f.reserve(true);
    let mut legacy: serde_json::Value = serde_json::from_slice(&legacy_state_bytes(&f.state)).unwrap();
    legacy["executions"][&running]["permission"] = serde_json::json!({"kind":"human_granted", "execution_id":running, "session_id":running_owner});
    let bytes = serde_json::to_vec(&legacy).unwrap();
    let (converted, needed) = decode_execution_state(&bytes).unwrap();
    assert!(needed);
    assert_eq!(converted.occurrences, f.state.occurrences);
    assert_eq!(converted.contexts, f.state.contexts);
    assert_eq!(converted.collections, f.state.collections);
    assert_eq!(converted.enabled_steps, f.state.enabled_steps);
    assert_eq!(converted.executions[&accepted].receipt_id, f.state.executions[&accepted].receipt_id);
    assert_eq!(converted.executions[&queued], f.state.executions[&queued]);
    assert_eq!(converted.executions[&running].continuation_mode, ContinuationMode::Manual);
    assert_eq!(converted.executions[&running].continuation_requested_revision, None);
    assert_eq!(converted.executions[&running].ready_revision, None);
    assert!(!decode_execution_state(&serde_json::to_vec(&converted).unwrap()).unwrap().1);
    for (lifecycle, stopped, exit_code) in [("failed", true, Some(1)), ("interrupted", false, None)] {
        let mut historical = legacy.clone();
        historical["executions"][&running]["lifecycle"] = lifecycle.into();
        historical["executions"][&running]["shutdown_confirmed"] = stopped.into();
        historical["executions"][&running]["exit_code"] = serde_json::json!(exit_code);
        let (history, needs_conversion) = decode_execution_state(&serde_json::to_vec(&historical).unwrap()).unwrap();
        assert!(needs_conversion);
        let owner = &history.executions[&running];
        assert_eq!(owner.owner_session_id, running_owner);
        assert_eq!(owner.shutdown_confirmed, stopped);
        assert_eq!(owner.exit_code, exit_code);
        assert_eq!(serde_json::to_value(&owner.lifecycle).unwrap(), historical["executions"][&running]["lifecycle"]);
        assert_eq!(owner.continuation_mode, ContinuationMode::Manual);
        assert!(owner.receipt_id.is_none());
        assert!(owner.ready_revision.is_none());
        assert!(owner.continuation_requested_revision.is_none());
        assert_eq!(history.occurrences, f.state.occurrences);
    }
    for permission in [
        serde_json::json!({"kind":"consumed"}),
        serde_json::json!({"kind":"human_granted", "execution_id":running, "session_id":"wrong-owner"}),
    ] {
        legacy["executions"][&running]["permission"] = permission;
        assert!(decode_execution_state(&serde_json::to_vec(&legacy).unwrap()).is_err());
    }
    legacy["executions"][&running]["permission"] = serde_json::json!({"kind":"locked"});
    legacy["executions"][&accepted]["permission"] = serde_json::json!({"kind":"automatic"});
    assert!(decode_execution_state(&serde_json::to_vec(&legacy).unwrap()).is_err());
}

#[test]
fn migration_preflights_all_records_and_converts_same_lane() {
    let mut f = Fixture::new("{path=\"result.md\"}", false, false, 2);
    let queued = f.reserve(false);
    persist_owner_fixture(&mut f);
    let path = execution_state_path(&f.repo, "task").unwrap();
    let legacy = legacy_state_bytes(&f.state);
    fs::write(&path, &legacy).unwrap();
    let archived = crate::task_dir(&f.repo, "archived");
    fs::create_dir_all(&archived).unwrap();
    fs::write(
        archived.join("task.md"),
        toml::to_string(&crate::Task {
            name: "Archived".into(),
            slug: "archived".into(),
            engine_version: 2,
            archived: true,
            ..Default::default()
        })
        .unwrap(),
    )
    .unwrap();
    fs::write(archived.join("playbook.md"), &f.source).unwrap();
    fs::write(archived.join("execution.json"), b"malformed").unwrap();
    assert!(crate::repo_ownership::acquire(&f.repo, "lane", "").is_err());
    assert_eq!(fs::read(&path).unwrap(), legacy);
    fs::write(archived.join("execution.json"), &legacy).unwrap();
    let lease = crate::lockfile::try_lock_exclusive(&crate::alineryd_lock_path(&f.repo, Some("lane"))).unwrap().unwrap();
    assert!(crate::repo_ownership::acquire(&f.repo, "lane", "").is_err());
    assert_eq!(fs::read(&path).unwrap(), legacy);
    drop(lease);
    crate::repo_ownership::check_available(&f.repo).unwrap();
    assert_eq!(fs::read(&path).unwrap(), legacy, "observation must not persist conversion");
    assert_eq!(read_execution_state(&f.repo, "task").unwrap().version, 2);
    assert_eq!(fs::read(&path).unwrap(), legacy);
    // Simulate a supported interrupted batch: one new-format task, one legacy archive.
    write_execution_state_unlocked(&f.repo, "task", &mut f.state).unwrap();
    let current = fs::read(&path).unwrap();
    let guard = crate::repo_ownership::acquire(&f.repo, "lane", "").unwrap();
    assert_eq!(fs::read(&path).unwrap(), current, "same-lane current state is a no-op");
    let bytes = fs::read(archived.join("execution.json")).unwrap();
    assert!(!decode_execution_state(&bytes).unwrap().1);
    let converted = read_execution_state(&f.repo, "archived").unwrap();
    assert_eq!(converted.executions[&queued], f.state.executions[&queued]);
    assert_eq!(converted.occurrences, f.state.occurrences);
    assert_eq!(fs::read(archived.join("playbook.md")).unwrap(), f.source.as_bytes());
    drop(guard);
    drop(crate::repo_ownership::acquire(&f.repo, "lane", "").unwrap());
    assert_eq!(fs::read(archived.join("execution.json")).unwrap(), bytes, "resumed conversion must be idempotent");
}

#[test]
fn supplied_wildcard_publications_merge_existing_members_without_writing() {
    let mut f = Fixture::new("{path=\"items/*.md\"}", false, false, 1);
    let id = f.reserve(true);
    f.write_output(&id, 0, Some("existing"));
    let record = &f.state.executions[&id];
    let supplied = crate::SuppliedExecutionArtifact {
        relative_path: record.outputs[0].relative_path.replace('*', "supplied"),
        content: "new evidence".into(),
    };
    let publications = inspect_supplied_execution_publications(&f.repo, "task", record, std::slice::from_ref(&supplied)).unwrap();
    let logical: BTreeSet<_> = publications.iter().map(|p| p.logical_path.as_str()).collect();
    assert_eq!(logical, BTreeSet::from(["items/existing.md", "items/supplied.md"]));
    assert!(!crate::artifacts_dir(&f.repo, "task").join(&supplied.relative_path).exists());
    assert_eq!(inspect_execution_publications(&f.repo, "task", record).unwrap().len(), 1);
}

#[test]
#[cfg(unix)]
fn supplied_artifacts_reject_symlink_parents_and_final_targets() {
    let mut f = Fixture::new("{path=\"nested/result.md\"}", false, false, 1);
    let id = f.reserve(true);
    let record = &f.state.executions[&id];
    let supplied = crate::SuppliedExecutionArtifact {
        relative_path: record.outputs[0].relative_path.clone(),
        content: "evidence".into(),
    };
    let root = crate::artifacts_dir(&f.repo, "task");
    let target = root.join(&supplied.relative_path);
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    let outside = f.repo.join("outside.md");
    fs::write(&outside, "untouched").unwrap();
    std::os::unix::fs::symlink(&outside, &target).unwrap();
    assert!(inspect_supplied_execution_publications(&f.repo, "task", record, std::slice::from_ref(&supplied)).is_err());
    fs::remove_file(&target).unwrap();
    fs::remove_dir(target.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&f.repo, target.parent().unwrap()).unwrap();
    assert!(inspect_supplied_execution_publications(&f.repo, "task", record, &[supplied]).is_err());
    assert_eq!(fs::read_to_string(outside).unwrap(), "untouched");
}

fn reserve_work(f: &mut Fixture, product_model: &str) -> String {
    reserve_execution(
        &f.repo,
        "task",
        &f.definition,
        &mut f.state,
        ExecutionCandidate {
            step_key: "work".into(),
            context_id: "root".into(),
            inputs: BTreeMap::new(),
            complete_collection_id: None,
            each_collection_id: None,
            each_member_id: None,
            manual: true,
        },
        &LaunchChoices {
            harness: "omp".into(),
            model: product_model.into(),
        },
        None,
        true,
    )
    .unwrap()
}

#[test]
fn reserved_launch_keeps_playbook_pin_when_execution_state_has_no_step_models() {
    let mut f = Fixture::new("{path=\"result.md\"}", false, true, 1);
    f.definition.step[0].model = "step-pin".into();
    f.state.launch_defaults = LaunchChoices {
        harness: "omp".into(),
        model: "task-model".into(),
    };
    let id = reserve_work(&mut f, "product-model");
    assert_eq!(f.state.executions[&id].launch.harness, "omp");
    assert_eq!(f.state.executions[&id].launch.model, "step-pin");
}

#[test]
fn reserved_launch_uses_persisted_step_model_ahead_of_playbook_pin() {
    let mut f = Fixture::new("{path=\"result.md\"}", false, true, 1);
    f.definition.step[0].model = "step-pin".into();
    f.state.launch_defaults = LaunchChoices {
        harness: "omp".into(),
        model: "task-model".into(),
    };
    let mut value = serde_json::to_value(&f.state).unwrap();
    value["step_models"] = serde_json::json!({ "work": "task-override" });
    let path = execution_state_path(&f.repo, "task").unwrap();
    fs::write(&path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    f.state = read_execution_state(&f.repo, "task").unwrap();
    let id = reserve_work(&mut f, "product-model");
    assert_eq!(f.state.executions[&id].launch.harness, "omp");
    assert_eq!(
        f.state.executions[&id].launch.model, "task-override",
        "persisted step_models must beat playbook pin step-pin, task-model, and product-model"
    );
}

fn chain_source(default_model: &str, plan_model: &str) -> String {
    format!(
        "+++\nversion = 2\nkey = \"fixture\"\ntitle = \"Fixture\"\ndescription = \"\"\ndefault_model = \"{default_model}\"\ndefault_harness = \"omp\"\n[[step]]\nkey = \"clarify\"\ntitle = \"Clarify\"\nshort = \"\"\ninputs = []\noutputs = [{{path=\"clarify.md\"}}]\nmodel = \"step-pin\"\nharness = \"\"\nis_coding_step = false\nauto_advance_default = false\n[[step]]\nkey = \"plan\"\ntitle = \"Plan\"\nshort = \"\"\ninputs = []\noutputs = [{{path=\"plan.md\"}}]\nmodel = \"{plan_model}\"\nharness = \"\"\nis_coding_step = false\nauto_advance_default = false\n+++\n<!-- alinery:step clarify -->\nClarify.\n<!-- alinery:step plan -->\nPlan.\n"
    )
}

fn launch_model(
    default_model: &str,
    plan_model: &str,
    step_key: &str,
    task_model: &str,
    product_model: &str,
    explicit: Option<&LaunchChoices>,
    step_models: &BTreeMap<String, String>,
) -> Result<LaunchChoices, String> {
    let definition = parse_playbook_md(&chain_source(default_model, plan_model)).unwrap();
    let step = definition.step.iter().find(|step| step.key == step_key).unwrap();
    let task = LaunchChoices {
        harness: "omp".into(),
        model: task_model.into(),
    };
    let product = LaunchChoices {
        harness: "omp".into(),
        model: product_model.into(),
    };
    resolve_execution_launch(&definition, step, &task, &product, explicit, step_models)
}

#[test]
fn step_model_override_beats_playbook_pin_and_task_model() {
    let mut map = BTreeMap::new();
    map.insert("clarify".into(), "task-override".into());
    let launch = launch_model("playbook-wide", "", "clarify", "task-model", "product-model", None, &map).unwrap();
    assert_eq!(launch.model, "task-override");
    assert_eq!(launch.harness, "omp");
}

#[test]
fn step_model_absent_keeps_playbook_pin_over_task_model() {
    let launch = launch_model("playbook-wide", "", "clarify", "task-model", "product-model", None, &BTreeMap::new()).unwrap();
    assert_eq!(launch.model, "step-pin");
}

#[test]
fn step_model_absent_empty_playbook_uses_task_model() {
    let launch = launch_model("", "", "plan", "task-model", "product-model", None, &BTreeMap::new()).unwrap();
    assert_eq!(launch.model, "task-model");
}

#[test]
fn step_model_absent_empty_chain_uses_product_model() {
    let launch = launch_model("", "", "plan", "", "product-model", None, &BTreeMap::new()).unwrap();
    assert_eq!(launch.model, "product-model");
}

#[test]
fn step_model_explicit_nonempty_beats_map() {
    let mut map = BTreeMap::new();
    map.insert("clarify".into(), "task-override".into());
    let once = LaunchChoices {
        harness: "omp".into(),
        model: "once".into(),
    };
    let launch = launch_model("playbook-wide", "", "clarify", "task-model", "product-model", Some(&once), &map).unwrap();
    assert_eq!(launch.model, "once");
    assert_eq!(launch.harness, "omp");
}

#[test]
fn step_model_empty_explicit_does_not_win() {
    let mut map = BTreeMap::new();
    map.insert("clarify".into(), "task-override".into());
    let empty = LaunchChoices {
        harness: "omp".into(),
        model: String::new(),
    };
    let launch = launch_model("playbook-wide", "", "clarify", "task-model", "product-model", Some(&empty), &map).unwrap();
    assert_eq!(launch.model, "task-override");
}

#[test]
fn step_model_explicit_none_does_not_win() {
    let mut map = BTreeMap::new();
    map.insert("plan".into(), "task-override".into());
    let launch = launch_model("", "", "plan", "task-model", "product-model", None, &map).unwrap();
    assert_eq!(launch.model, "task-override");
}

#[test]
fn step_model_whitespace_does_not_win() {
    let mut map = BTreeMap::new();
    map.insert("clarify".into(), "  ".into());
    let launch = launch_model("playbook-wide", "", "clarify", "task-model", "product-model", None, &map).unwrap();
    assert_eq!(launch.model, "step-pin");
}

#[test]
fn step_model_other_step_does_not_affect_this_step() {
    let mut map = BTreeMap::new();
    map.insert("plan".into(), "task-override".into());
    let launch = launch_model("playbook-wide", "", "clarify", "task-model", "product-model", None, &map).unwrap();
    assert_eq!(launch.model, "step-pin");
}

#[test]
fn step_model_non_omp_explicit_harness_still_errors() {
    let once = LaunchChoices {
        harness: "no-harness".into(),
        model: "once".into(),
    };
    let err = launch_model("playbook-wide", "", "clarify", "task-model", "product-model", Some(&once), &BTreeMap::new()).unwrap_err();
    assert!(err.contains("unsupported graph harness"), "{err}");
}

#[test]
fn step_model_missing_field_parses_as_empty_map() {
    let f = Fixture::new("{path=\"result.md\"}", false, true, 1);
    let mut value = serde_json::to_value(&f.state).unwrap();
    value.as_object_mut().unwrap().remove("step_models");
    let state: TaskExecutionState = serde_json::from_value(value).unwrap();
    assert!(state.step_models.is_empty());
}
