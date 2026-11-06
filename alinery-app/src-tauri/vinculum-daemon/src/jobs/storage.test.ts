import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scanStorage } from "./storage.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const taskMd = (slug: string, archived: boolean) => `name = "${slug}"\nslug = "${slug}"\nbranch = "${slug}"\nworktree = "/w"\ncreated = 1\narchived = ${archived}\n`;
const meta = (id: string, archived: boolean) => JSON.stringify({ id, worktree: "/w", created: 1, archived });

/** Writes `bytes` bytes at `path` and returns the count, so a test adds up what it wrote. */
function put(path: string, content: string | number): number {
  mkdirSync(dirname(path), { recursive: true });
  const text = typeof content === "number" ? "x".repeat(content) : content;
  writeFileSync(path, text);
  return Buffer.byteLength(text);
}

test("one walk splits archived from active exactly as storage.rs does", () => {
  const repo = mkdtempSync("/tmp/storage-t-");
  dirs.push(repo);
  const a = join(repo, ".alinery");
  let active = 0;
  let archived = 0;

  active += put(join(a, "config.toml"), 11);
  active += put(join(a, "sessions", "chat.meta.json"), 7); // taskless chat: not under tasks/

  // A live task: its archived session's files move to the archived bucket, by exact name.
  const live = join(a, "tasks", "live");
  active += put(join(live, "task.md"), taskMd("live", false));
  active += put(join(live, "artifacts", "01-a.md"), 100);
  const s = join(live, "sessions");
  active += put(join(s, "s2.meta.json"), meta("s2", false));
  active += put(join(s, "s2.scrollback"), 50);
  active += put(join(s, "s1b.meta.json"), meta("s1b", false)); // `s1.` must not claim `s1b.*`
  active += put(join(s, "s1b.scrollback"), 9);
  for (const [name, n] of [["s1.scrollback", 30], ["s1.name.json", 5], ["s1.meta.json.tmp.1", 0], ["s1.x.tmp.9.9.9", 4]] as const) archived += put(join(s, name), n);
  archived += put(join(s, "s1.meta.json"), meta("s1", true));
  active += put(join(s, "s1.other"), 6); // not one of the session's files: stays

  // An archived task, with its worktree.
  const old = join(a, "tasks", "old");
  archived += put(join(old, "task.md"), taskMd("old", true));
  archived += put(join(old, "sessions", "o1.meta.json"), meta("o1", false));
  archived += put(join(old, "sessions", "o2.meta.json"), "not json");
  archived += put(join(old, "artifacts", "01-x.md"), 70);
  archived += put(join(a, "worktrees", "old", "src.rs"), 200);

  // Cannot be classified, or is not a task: active.
  active += put(join(a, "tasks", "bad", "task.md"), "name = ");
  active += put(join(a, "tasks", "nofields", "task.md"), 'name = "n"\nslug = "nofields"\n');
  active += put(join(a, "tasks", "wrongtype", "task.md"), taskMd("wrongtype", false).replace("archived = false", 'archived = "yes"'));
  active += put(join(a, "tasks", "stray.txt"), 3);
  active += put(join(a, "worktrees", "live", "f"), 40); // a live task's worktree
  active += put(join(a, "worktrees", "orphan", "f"), 60); // no task at all

  // A symlink is never followed out of .alinery.
  const outside = mkdtempSync("/tmp/storage-out-");
  dirs.push(outside);
  put(join(outside, "huge"), 5000);
  symlinkSync(outside, join(a, "worktrees", "live", "link"));

  const info = scanStorage({ repo, appConfig: "/app", namespace: "" });
  expect(info).toMatchObject({
    archived_task_count: 1,
    archived_session_count: 2 + 1, // o1 and o2 under the archived task, s1 under the live one
    archived_bytes: archived,
    active_bytes: active,
  });
});

test("a missing .alinery is all zeros, and the paths follow the lane naming", () => {
  const repo = mkdtempSync("/tmp/storage-t-");
  dirs.push(repo);
  const none = scanStorage({ repo, appConfig: "/app/config", namespace: "" });
  expect(none).toEqual({
    app_config_path: "/app/config",
    repo_path: repo,
    alinery_dir: `${repo}/.alinery`,
    repo_config_path: `${repo}/.alinery/config.toml`,
    harnesses_path: `${repo}/.alinery/harnesses.toml`,
    tasks_dir: `${repo}/.alinery/tasks`,
    worktrees_dir: `${repo}/.alinery/worktrees`,
    alineryd_socket_path: `${repo}/.alinery/alineryd.sock`,
    alineryd_lock_path: `${repo}/.alinery/.alineryd.lock`,
    mcp_socket_path: `${repo}/.alinery/mcp.sock`,
    mcp_status_path: `${repo}/.alinery/mcp.status.json`,
    archived_task_count: 0,
    archived_session_count: 0,
    archived_bytes: 0,
    active_bytes: 0,
  });
  // Characters outside [A-Za-z0-9_-] drop out and the stem stops at 48, as paths.rs does.
  const lane = scanStorage({ repo, appConfig: "/a", namespace: `d1/2.3${"z".repeat(60)}` });
  expect(lane.alineryd_socket_path).toBe(`${repo}/.alinery/alineryd-d123${"z".repeat(44)}.sock`);
  expect(lane.mcp_status_path).toBe(`${repo}/.alinery/mcp-d123${"z".repeat(44)}.status.json`);
});
