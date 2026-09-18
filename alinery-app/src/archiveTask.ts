import * as ipc from "./ipc";
import { toast } from "./toast";
import type { BoardTask } from "./types";

export type ArchiveTaskFailure = { msg: string; detail: string };
export type ArchiveTaskPhase = "archiving" | "removing-worktree";

export async function archiveBoardTask(
  task: Pick<BoardTask, "repo_path" | "slug">,
  removeWorktree: boolean,
  onPhase: (phase: ArchiveTaskPhase) => void,
): Promise<ArchiveTaskFailure | null> {
  try {
    onPhase("archiving");
    await ipc.archiveTaskForRepo(task.repo_path, task.slug);
    if (removeWorktree) {
      onPhase("removing-worktree");
      await ipc.removeWorktreeForRepo(task.repo_path, task.slug);
    }
    toast("Task archived", "success");
    return null;
  } catch (error) {
    return { msg: "Couldn't archive the task.", detail: String(error) };
  }
}
