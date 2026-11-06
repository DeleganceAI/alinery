use std::fs;
use std::path::Path;

use crate::lockfile::with_task_mutation_lock_waiting;
use crate::paths::tasks_dir;
use crate::types::Task;
use crate::write_bytes_atomic;

pub fn task_dir(repo: &Path, slug: &str) -> std::path::PathBuf {
    tasks_dir(repo).join(slug)
}

pub fn read_task(repo: &Path, slug: &str) -> Option<Task> {
    let p = task_dir(repo, slug).join("task.md");
    fs::read_to_string(p).ok().and_then(|s| toml::from_str::<Task>(&s).ok())
}

pub fn write_task(repo: &Path, task: &Task) -> Result<(), String> {
    with_task_mutation_lock_waiting(repo, "write task", crate::TASK_MUTATION_CONTENTION_WAIT, || write_task_unlocked(repo, task))
}

/// Caller holds the task mutation lock.
pub fn write_task_unlocked(repo: &Path, task: &Task) -> Result<(), String> {
    if read_task(repo, &task.slug).as_ref() == Some(task) {
        return Ok(());
    }
    let path = task_dir(repo, &task.slug).join("task.md");
    let serialized = toml::to_string(task).map_err(|e| e.to_string())?;
    write_bytes_atomic(&path, serialized.as_bytes()).map_err(|e| format!("write {}: {e}", path.display()))
}
