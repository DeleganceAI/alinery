//! The key a task's activity and pull-request rows are addressed by. The activity itself is derived in the daemon.

pub fn task_activity_key(repo_path: &str, slug: &str) -> String {
    format!("{repo_path}:{slug}")
}
