use super::*;

#[test]
fn subtask_discard_stops_sessions_before_deleting_state() {
    let repo = init_git_test_repo("subtask-discard-order");
    let parent = create_task_for_test(&repo, "Parent", true, "", "");
    let manager = SessionMeta {
        id: "manager".into(), worktree: parent.worktree.clone(), harness: "omp".into(),
        generic: true, subtask_manager: true, ..Default::default()
    };
    fs::write(session_meta_path(&repo, &parent.slug, &manager.id), serde_json::to_vec(&manager).unwrap()).unwrap();
    assert!(discard_subtask_with(&repo, &parent.slug, &manager.id, |_, _| Err("daemon refused kill".into())).is_err());
    assert!(session_meta_path(&repo, &parent.slug, &manager.id).exists());
    let mut stopped = Vec::new();
    let removed = discard_subtask_with(&repo, &parent.slug, &manager.id, |owner, id| {
        stopped.push((owner.to_string(), id.to_string())); Ok(())
    }).unwrap();
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
