// The checks `open_session` made in the shell before it asked the daemon to spawn or resume (S4.3, plan 2.3.4): which
// sessions a task may launch, and which harness a session's meta may name. They read the files the daemon owns, so a
// remote repository is checked by its own host with the same code. The hosted-inference refresh stays in the shell.
import { readTask } from "./taskFiles.ts";

const ALLOWED_HARNESSES = ["omp", "vinculum", "no-harness"];

/**
 * `metaHarness` is the harness the session's meta file records (undefined when the meta is missing or unreadable).
 * Returns the refusal text, or undefined when the open may go on.
 */
export function openPreflight(repo: string, taskSlug: string, metaHarness: string | undefined): string | undefined {
  if (taskSlug === "") {
    // A session outside any task is the drawer terminal; the harness on disk decides, never the caller's claim.
    return metaHarness === undefined || metaHarness === "no-harness" ? undefined : "root sessions are limited to no-harness drawer";
  }
  const task = readTask(repo, taskSlug);
  if (!task) return `no such task: ${taskSlug}`;
  if (Number(task.engine_version ?? 0) < 2) return "pre-v2 task data is read-only; create a new v2 task to launch sessions";
  if (task.draft === true || task.archived === true) return "draft or archived tasks cannot launch sessions";
  if (metaHarness !== undefined && !ALLOWED_HARNESSES.includes(metaHarness)) return `unknown harness '${metaHarness}'`;
  return undefined;
}
