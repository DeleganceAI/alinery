use super::*;

#[test]
fn subtask_discard_stops_sessions_before_deleting_state() {
    let repo = init_git_test_repo("subtask-discard-order");
    let parent = create_task_for_test(&repo, "Parent", true, "", "");
    let manager = SessionMeta {
        id: "manager".into(),
        worktree: parent.worktree.clone(),
        harness: "omp".into(),
        generic: true,
        subtask_manager: true,
        ..Default::default()
    };
    fs::write(session_meta_path(&repo, &parent.slug, &manager.id), serde_json::to_vec(&manager).unwrap()).unwrap();
    assert!(discard_subtask_with(&repo, &parent.slug, &manager.id, |_, _| Err("daemon refused kill".into())).is_err());
    assert!(session_meta_path(&repo, &parent.slug, &manager.id).exists());
    let mut stopped = Vec::new();
    let removed = discard_subtask_with(&repo, &parent.slug, &manager.id, |owner, id| {
        stopped.push((owner.to_string(), id.to_string()));
        Ok(())
    })
    .unwrap();
    assert_eq!(stopped, vec![(parent.slug.clone(), manager.id.clone())]);
    assert_eq!(removed, vec![manager.id.clone()]);
    assert!(!session_meta_path(&repo, &parent.slug, &manager.id).exists());
    fs::remove_dir_all(repo).unwrap();
}

#[test]
fn historical_tasks_cannot_offer_executable_managers() {
    let repo = init_git_test_repo("historical-manager");
    let mut task = create_task_for_test(&repo, "Parent", true, "", "");
    task.engine_version = 0;
    write_task(&repo, &task).unwrap();
    assert!(!subtask_state_in(&repo, &task.slug).unwrap().can_start);
    fs::remove_dir_all(repo).unwrap();
}

#[test]
fn subtask_manager_recovery_targets_the_reciprocal_active_child() {
    let repo = unique_attachment_temp("subtask-manager-recovery");
    let mut parent = create_task_for_test(&repo, "Parent", false, "", "");
    let mut child = create_task_for_test(&repo, "Child", false, "", "");
    parent.active_subtask = child.slug.clone();
    child.parent_task = parent.slug.clone();
    write_task(&repo, &parent).unwrap();
    write_task(&repo, &child).unwrap();

    let request = crate::subtask::subtask_manager_request_in(&repo, parent.slug.clone(), true).unwrap();
    assert!(matches!(
        request.target,
        alinery_core::task_creation::ExecutionSessionTarget::SubtaskManager {
            subtask_slug: Some(slug),
            recover: true,
            ..
        } if slug == child.slug
    ));
    let request = crate::subtask::subtask_manager_request_in(&repo, parent.slug.clone(), false).unwrap();
    assert!(matches!(
        request.target,
        alinery_core::task_creation::ExecutionSessionTarget::SubtaskManager {
            subtask_slug: None,
            recover: false,
            ..
        }
    ));
    fs::remove_dir_all(repo).unwrap();
}

#[test]
fn subtask_manager_recovery_rejects_absent_or_invalid_active_child() {
    let repo = unique_attachment_temp("subtask-manager-invalid-recovery");
    let mut parent = create_task_for_test(&repo, "Parent", false, "", "");
    assert!(crate::subtask::subtask_manager_request_in(&repo, parent.slug.clone(), true).is_err());

    parent.active_subtask = "missing-child".into();
    write_task(&repo, &parent).unwrap();
    assert!(crate::subtask::subtask_manager_request_in(&repo, parent.slug.clone(), true).is_err());

    let child = create_task_for_test(&repo, "Child", false, "", "");
    parent.active_subtask = child.slug.clone();
    write_task(&repo, &parent).unwrap();
    assert!(crate::subtask::subtask_manager_request_in(&repo, parent.slug.clone(), true).is_err());
    fs::remove_dir_all(repo).unwrap();
}
