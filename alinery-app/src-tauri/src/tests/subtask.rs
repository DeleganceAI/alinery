use super::*;

#[test]
fn subtask_start_is_unique_and_recovery_is_explicitly_bound() {
    let repo = init_git_test_repo("subtask-manager");
    alinery_core::ensure_playbooks(&repo).unwrap();
    let parent = create_task_for_test(&repo, "Parent", true, "", "");
    let app_config = repo.join("app.toml");

    let initial = subtask_state_in(&repo, &parent.slug).unwrap();
    assert!(initial.can_start, "{}", initial.disabled_reason);
    assert!(initial.manager_session.is_none());

    let manager = start_subtask_manager_in(&app_config, &repo, &parent.slug).unwrap();
    assert!(manager.subtask_manager);
    assert!(manager.subtask_slug.is_empty());
    assert!(manager.generic);
    assert_eq!(manager.phase, "");
    assert_eq!(manager.harness, "omp");
    assert!(manager.model.is_empty());
    let duplicate_error = match start_subtask_manager_in(&app_config, &repo, &parent.slug) {
        Ok(_) => panic!("duplicate manager should be refused"),
        Err(error) => error,
    };
    assert!(duplicate_error.contains("already exists"));

    let setup = subtask_state_in(&repo, &parent.slug).unwrap();
    assert!(!setup.can_start);
    assert_eq!(setup.manager_session.as_ref().map(|meta| meta.id.as_str()), Some(manager.id.as_str()));

    let mut parent_record = read_task(&repo, &parent.slug).unwrap();
    let mut child = parent_record.clone();
    child.name = "Child".into();
    child.slug = "child".into();
    child.branch = "child".into();
    child.parent_task = parent.slug.clone();
    child.active_subtask.clear();
    parent_record.active_subtask = child.slug.clone();
    write_task(&repo, &child).unwrap();
    write_task(&repo, &parent_record).unwrap();

    let manager_path = session_meta_path(&repo, &parent.slug, &manager.id);
    let mut ended_manager = manager.clone();
    ended_manager.subtask_slug = child.slug.clone();
    ended_manager.started_at = Some(10);
    ended_manager.ended_at = Some(20);
    ended_manager.harness_resume_token.clear();
    alinery_core::write_meta_atomic(&manager_path, &serde_json::to_value(&ended_manager).unwrap()).unwrap();

    let recoverable = subtask_state_in(&repo, &parent.slug).unwrap();
    assert!(recoverable.can_recover);
    assert_eq!(recoverable.active_subtask.as_ref().map(|task| task.slug.as_str()), Some("child"));
    let replacement = recover_subtask_manager_in(&app_config, &repo, &parent.slug).unwrap();
    assert!(replacement.subtask_manager);
    assert_eq!(replacement.subtask_slug, "child");
    assert!(replacement.started_at.is_none(), "recovery must not auto-spawn");
    assert!(!subtask_state_in(&repo, &parent.slug).unwrap().can_recover);

    let child_state = subtask_state_in(&repo, "child").unwrap();
    assert_eq!(child_state.parent_task.as_ref().map(|task| task.slug.as_str()), Some(parent.slug.as_str()));
    assert_eq!(child_state.parent_manager_session.as_ref().map(|meta| meta.id.as_str()), Some(replacement.id.as_str()));
    assert_eq!(child_state.parent_manager_owner_task_slug, parent.slug);
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn subtask_manager_requires_omp_adapter_capability() {
    let repo = init_git_test_repo("subtask-manager-capability");
    alinery_core::ensure_playbooks(&repo).unwrap();
    let parent = create_task_for_test(&repo, "Parent", true, "", "");
    let app_config = repo.join("app.toml");
    fs::write(
        alinery_core::harnesses_toml_path(&repo),
        r#"[[harness]]
key = "omp"
name = "Broken OMP"
binary = "omp"
adapter = "unsupported"
"#,
    )
    .unwrap();

    let error = match start_subtask_manager_in(&app_config, &repo, &parent.slug) {
        Ok(_) => panic!("unsupported manager harness should be refused"),
        Err(error) => error,
    };
    assert_eq!(error, "Sub-task managers require the OMP harness with adapter = \"omp\"");
    assert!(subtask_state_in(&repo, &parent.slug).unwrap().manager_session.is_none());
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn dirty_parent_still_allows_subtask_manager_start() {
    let repo = init_git_test_repo("subtask-dirty-parent");
    alinery_core::ensure_playbooks(&repo).unwrap();
    let parent = create_task_for_test(&repo, "Parent", true, "", "");
    fs::write(Path::new(&parent.worktree).join("uncommitted-parent.txt"), b"parent-only").unwrap();

    let state = subtask_state_in(&repo, &parent.slug).unwrap();
    assert!(state.can_start, "{}", state.disabled_reason);

    let manager = start_subtask_manager_in(&repo.join("app.toml"), &repo, &parent.slug).unwrap();
    let launch = alinery_core::read_meta_launch_fields(&repo, &parent.slug, &manager.id).unwrap();
    let prompt = alinery_core::resolve_launch_prompt(&repo, &launch).unwrap().unwrap();
    assert!(prompt.contains("Parent worktree status: DIRTY"));
    assert!(prompt.contains("child starts from the parent's committed branch and excludes uncommitted parent files"));
    assert!(Path::new(&parent.worktree).join("uncommitted-parent.txt").is_file());
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn subtask_discard_stops_sessions_before_deleting_state() {
    let repo = init_git_test_repo("subtask-discard-order");
    alinery_core::ensure_playbooks(&repo).unwrap();
    let parent = create_task_for_test(&repo, "Parent", true, "", "");
    let manager = start_subtask_manager_in(&repo.join("app.toml"), &repo, &parent.slug).unwrap();

    let error = discard_subtask_with(&repo, &parent.slug, &manager.id, |_, _| Err("daemon refused kill".into())).unwrap_err();
    assert_eq!(error, "daemon refused kill");
    assert!(session_meta_path(&repo, &parent.slug, &manager.id).exists(), "failed kill must preserve manager data");

    let mut stopped = Vec::new();
    let removed = discard_subtask_with(&repo, &parent.slug, &manager.id, |owner_slug, session_id| {
        stopped.push((owner_slug.to_string(), session_id.to_string()));
        Ok(())
    })
    .unwrap();
    assert_eq!(stopped, vec![(parent.slug.clone(), manager.id.clone())]);
    assert_eq!(removed, vec![manager.id.clone()]);
    assert!(!session_meta_path(&repo, &parent.slug, &manager.id).exists());
    let _ = fs::remove_dir_all(repo);
}

#[test]
fn subtask_state_disabled_reason_uses_durable_precedence() {
    let repo = init_git_test_repo("subtask-state-precedence");
    alinery_core::ensure_playbooks(&repo).unwrap();
    let created = create_task_for_test(&repo, "Parent", true, "", "");
    let mut task = read_task(&repo, &created.slug).unwrap();

    task.draft = true;
    task.archived = true;
    task.worktree.clear();
    write_task(&repo, &task).unwrap();
    let state = subtask_state_in(&repo, &task.slug).unwrap();
    assert_eq!(state.disabled_reason, "Draft tasks cannot start sub-tasks");

    task.draft = false;
    write_task(&repo, &task).unwrap();
    let state = subtask_state_in(&repo, &task.slug).unwrap();
    assert_eq!(state.disabled_reason, "Archived tasks cannot start sub-tasks");

    task.archived = false;
    write_task(&repo, &task).unwrap();
    let state = subtask_state_in(&repo, &task.slug).unwrap();
    assert_eq!(state.disabled_reason, "A dedicated task worktree is required");
    let _ = fs::remove_dir_all(repo);
}
