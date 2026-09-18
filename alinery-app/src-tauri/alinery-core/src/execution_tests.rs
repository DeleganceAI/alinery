use super::*;
use crate::playbook::PlaybookScope;

struct Fixture { repo: PathBuf, source: String, definition: NormalizedPlaybook, state: TaskExecutionState }
impl Fixture {
    fn new(outputs: &str, coding: bool, automatic: bool, cap: u32) -> Self {
        let repo = std::env::temp_dir().join(format!("alinery-v2-execution-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(crate::artifacts_dir(&repo, "task")).unwrap();
        let source = format!("+++\nversion = 2\nkey = \"fixture\"\ntitle = \"Fixture\"\ndescription = \"\"\ndefault_model = \"\"\ndefault_harness = \"omp\"\n[[step]]\nkey = \"work\"\ntitle = \"Work\"\nshort = \"\"\ninputs = []\noutputs = [{outputs}]\nmodel = \"\"\nharness = \"\"\nis_coding_step = {coding}\nauto_advance_default = {automatic}\n+++\n<!-- alinery:step work -->\nWrite the assigned outputs.\n");
        let definition = parse_playbook_md(&source).unwrap();
        let enabled = if automatic { BTreeSet::from(["work".into()]) } else { BTreeSet::new() };
        let mut state = new_execution_state(PlaybookRef { scope: PlaybookScope::Repo, key: "fixture".into() }, &source, "lane".into(), cap, enabled, LaunchChoices::default()).unwrap();
        state.creation = "ready".into();
        Self { repo, source, definition, state }
    }
    fn reserve(&mut self, manual: bool) -> String {
        reserve_execution(&self.repo, "task", &self.definition, &mut self.state, ExecutionCandidate {
            step_key: "work".into(), context_id: "root".into(), inputs: BTreeMap::new(),
            complete_collection_id: None, each_collection_id: None, each_member_id: None, manual,
        }, &LaunchChoices::default(), None, true).unwrap()
    }
    fn run(&mut self, id: &str) -> String {
        let session = self.state.executions[id].owner_session_id.clone();
        assert!(claim_execution_launch(&mut self.state, id).unwrap());
        record_execution_spawn(&mut self.state, id, &session, Ok(())).unwrap();
        session
    }
    fn write_output(&self, id: &str, index: usize, slot: Option<&str>) {
        let assignment = &self.state.executions[id].outputs[index];
        let relative = match slot { Some(slot) => assignment.relative_path.replace('*', slot), None => assignment.relative_path.clone() };
        let path = crate::artifacts_dir(&self.repo, "task").join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "real output").unwrap();
    }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.repo); } }

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
fn allocation_has_no_999_collision_limit() {
    let mut f = Fixture::new("{path=\"result.md\"}", false, true, 10);
    for i in 1..=1001 { fs::write(crate::artifacts_dir(&f.repo, "task").join(format!("1-result-{i}.md")), "existing").unwrap(); }
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
    assert!(matches!(accept_execution_completion(&f.repo, "task", &mut f.state, &a, &owner).unwrap(), CompletionOutcome::Accepted { .. }));
    let logical: BTreeSet<_> = f.state.occurrences.values().map(|o| o.logical_path.as_str()).collect();
    assert_eq!(logical, BTreeSet::from(["request-a-10.md", "request-b.md"]));
    assert!(f.state.occurrences.values().all(|o| !occurrence_deliverable(&f.state, o)));
    confirm_execution_exit(&mut f.state, &a, &owner, Some(0)).unwrap();
    assert!(f.state.occurrences.values().all(|o| occurrence_deliverable(&f.state, o)));
}

#[test]
fn invalid_output_preserves_human_grant_and_acceptance_replays_receipt() {
    let mut f = Fixture::new("{path=\"result.md\"}", true, false, 2);
    let id = f.reserve(false);
    let owner = f.run(&id);
    assert_eq!(accept_execution_completion(&f.repo, "task", &mut f.state, &id, &owner).unwrap(), CompletionOutcome::HumanAuthorizationRequired);
    grant_execution_completion(&mut f.state, &id, &owner).unwrap();
    assert!(matches!(accept_execution_completion(&f.repo, "task", &mut f.state, &id, &owner).unwrap(), CompletionOutcome::InvalidOutputs { .. }));
    assert!(matches!(f.state.executions[&id].permission, CompletionPermission::HumanGranted { .. }));
    assert!(f.state.occurrences.is_empty());
    f.write_output(&id, 0, None);
    let accepted = accept_execution_completion(&f.repo, "task", &mut f.state, &id, &owner).unwrap();
    assert!(matches!(accepted, CompletionOutcome::Accepted { .. }));
    assert_eq!(accept_execution_completion(&f.repo, "task", &mut f.state, &id, &owner).unwrap(), accepted);
    assert_eq!(f.state.occurrences.len(), 1);
    assert!(recover_execution_owner(&mut f.state, &id).is_err());
}

#[test]
fn capacity_and_coding_ownership_survive_review_and_finishing() {
    let mut f = Fixture::new("{path=\"result.md\"}", true, false, 2);
    let a = f.reserve(true);
    let b = f.reserve(true);
    let owner = f.run(&a);
    assert!(!claim_execution_launch(&mut f.state, &b).unwrap());
    grant_execution_completion(&mut f.state, &a, &owner).unwrap();
    f.write_output(&a, 0, None);
    accept_execution_completion(&f.repo, "task", &mut f.state, &a, &owner).unwrap();
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
fn stopped_owner_recovery_retires_old_permission_without_retrying() {
    let mut f = Fixture::new("{path=\"result.md\"}", true, false, 1);
    let id = f.reserve(false);
    let old = f.run(&id);
    grant_execution_completion(&mut f.state, &id, &old).unwrap();
    assert!(recover_execution_owner(&mut f.state, &id).is_err());
    confirm_execution_exit(&mut f.state, &id, &old, Some(1)).unwrap();
    assert!(!claim_execution_launch(&mut f.state, &id).unwrap());
    let replacement = recover_execution_owner(&mut f.state, &id).unwrap();
    assert_ne!(old, replacement);
    assert!(accept_execution_completion(&f.repo, "task", &mut f.state, &id, &old).is_err());
    assert!(!claim_execution_launch(&mut f.state, &id).unwrap());
    request_execution_start(&mut f.state, &id).unwrap();
    f.run(&id);
    f.write_output(&id, 0, None);
    assert_eq!(accept_execution_completion(&f.repo, "task", &mut f.state, &id, &replacement).unwrap(), CompletionOutcome::HumanAuthorizationRequired);
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
fn manual_reservation_cannot_smuggle_unrequired_input_bindings() {
    let mut f = Fixture::new("{path=\"result.md\"}", false, true, 1);
    let seed = install_seed(&mut f.state, "ticket.md", "00-ticket.md").unwrap();
    let candidate = ExecutionCandidate {
        step_key: "work".into(), context_id: "root".into(), inputs: BTreeMap::from([("ticket.md".into(), vec![seed])]),
        complete_collection_id: None, each_collection_id: None, each_member_id: None, manual: true,
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
        step_key: "work".into(), context_id: "root".into(), inputs: BTreeMap::new(), complete_collection_id: None,
        each_collection_id: None, each_member_id: None, manual: false,
    };
    assert!(reserve_execution(&f.repo, "task", &f.definition, &mut f.state, candidate, &LaunchChoices::default(), None, true).is_err());
    assert!(fs::read_dir(outside).unwrap().next().is_none());
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
        destination: destination.display().to_string(), enabled: true, ..Default::default()
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
    let output = pending.iter().find(|item| item.name == "1-result-1.md").expect("reserved output is visible before it is written");
    assert_eq!(output.execution_id.as_deref(), Some(id.as_str()));
    assert_eq!(output.logical_path.as_deref(), Some("result.md"));
    assert_eq!(output.accepted, Some(false));
    assert_eq!(output.depth, Some(1));
    let owner = f.run(&id);
    f.write_output(&id, 0, None);
    accept_execution_completion(&f.repo, "task", &mut f.state, &id, &owner).unwrap();
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
        PlaybookRef { scope: PlaybookScope::Repo, key: "fixture".into() },
        &source, "lane".into(), 1, BTreeSet::new(), LaunchChoices::default(),
    ).is_err());
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
        accept_execution_completion(&f.repo, "task", &mut f.state, &id, &owner).unwrap(),
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
        ].into_iter().map(|(key, inputs, output)| {
            let mut step = template.clone();
            step.key = key.into();
            step.inputs = inputs.into_iter().map(|path| InputSelector { path: path.into(), mode: InputMode::Single }).collect();
            step.outputs = vec![OutputSelector { path: output.into() }];
            step
        }).collect();
        f.definition.section_order = f.definition.step.iter().map(|step| step.key.clone()).collect();
        f.source = crate::render_playbook_md(&f.definition);
        f.definition = parse_playbook_md(&f.source).unwrap();
        f.state = new_execution_state(f.state.reference.clone(), &f.source, "lane".into(), 10, f.definition.step.iter().map(|step| step.key.clone()).collect(), LaunchChoices::default()).unwrap();
        f.state.creation = "ready".into();
        let reserve = |f: &mut Fixture, key: &str| {
            let step = f.definition.step.iter().find(|step| step.key == key).unwrap();
            let inputs = step.inputs.iter().map(|input| {
                let occurrence = f.state.occurrences.values().find(|o| o.logical_path == input.path).unwrap();
                (input.path.clone(), vec![occurrence.id.clone()])
            }).collect();
            reserve_execution(&f.repo, "task", &f.definition, &mut f.state, ExecutionCandidate {
                step_key: key.into(), context_id: "root".into(), inputs, complete_collection_id: None,
                each_collection_id: None, each_member_id: None, manual: false,
            }, &LaunchChoices::default(), None, true).unwrap()
        };
        let finish = |f: &mut Fixture, id: &str| {
            let owner = f.run(id);
            f.write_output(id, 0, None);
            accept_execution_completion(&f.repo, "task", &mut f.state, id, &owner).unwrap();
            confirm_execution_exit(&mut f.state, id, &owner, Some(0)).unwrap();
        };
        let root = reserve(&mut f, "root");
        finish(&mut f, &root);
        let short = reserve(&mut f, "short");
        if short_first { finish(&mut f, &short); }
        for key in ["long2", "long3", "long4", "long5"] {
            let id = reserve(&mut f, key);
            finish(&mut f, &id);
        }
        if !short_first { finish(&mut f, &short); }
        let join = reserve(&mut f, "join");
        assert_eq!(f.state.executions[&join].depth, 6);
        assert_eq!(f.state.executions[&join].outputs[0].relative_path, "6-joined-1.md");
        let depths: BTreeSet<_> = f.state.executions[&join].parent_execution_ids.iter().map(|id| f.state.executions[id].depth).collect();
        assert_eq!(depths, BTreeSet::from([2, 5]));
    }
}
