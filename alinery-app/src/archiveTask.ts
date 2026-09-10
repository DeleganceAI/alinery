import * as ipc from "./ipc";
import { toast } from "./toast";
import type { BoardTask } from "./types";

export type ArchiveTaskFailure = { msg: string; detail: string };

export async function archiveBoardTask(task: Pick<BoardTask, "repo_path" | "slug">, removeWorktree: boolean): Promise<ArchiveTaskFailure | null> {
  try {
    await ipc.archiveTaskForRepo(task.repo_path, task.slug);
    if (removeWorktree) await ipc.removeWorktreeForRepo(task.repo_path, task.slug);
    toast("Task archived", "success");
    return null;
  } catch (error) {
    return { msg: "Couldn't archive the task.", detail: String(error) };
  }
}
