import { afterEach, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainError } from "../platform/lock.ts";
import { clearSessionNotifications, markExitNotificationRead, markNotificationRead, namePathOf, metaPathOf, setSessionName, stampSessionArchived, validateSessionName } from "./sessionOps.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function rig() {
  const repo = mkdtempSync(join(tmpdir(), "session-ops-"));
  dirs.push(repo);
  const task = join(repo, ".alinery", "tasks", "t");
  mkdirSync(join(task, "sessions"), { recursive: true });
  writeFileSync(join(task, "task.md"), 'name = "T"\nslug = "t"\nbranch = "t"\nworktree = "/x"\ncreated = 1\n');
  mkdirSync(join(repo, ".alinery", "sessions"), { recursive: true });
  const meta = (slug: string, id: string, extra: Record<string, unknown> = {}) => {
    writeFileSync(metaPathOf(repo, slug, id), JSON.stringify({ id, worktree: repo, created: 1, ...extra }));
  };
  const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return { repo, meta, read };
}

const refusal = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    if (e instanceof DomainError) return `${e.code}: ${e.message}`;
    throw e;
  }
  return "no refusal";
};

test("a name is trimmed, one line, and at most 40 characters", () => {
  expect(validateSessionName("  Fix login  ")).toBe("Fix login");
  // 40 characters, not 40 bytes: Rust counted chars.
  expect([...validateSessionName("é".repeat(40))]).toHaveLength(40);
  expect(() => validateSessionName("   ")).toThrow("must not be empty");
  expect(() => validateSessionName("a\nb")).toThrow("single-line");
  expect(() => validateSessionName("a b")).toThrow("single-line");
  expect(() => validateSessionName("x".repeat(41))).toThrow("at most 40");
});

test("an automatic name on a task session is kept for good, and a person's rename replaces it", async () => {
  const { repo, meta, read } = rig();
  meta("t", "s1");
  expect(await setSessionName(repo, "t", "s1", "First", "auto")).toEqual({ status: "saved", value: { name: "First", source: "auto" } });
  expect(await setSessionName(repo, "t", "s1", "Second", "auto")).toEqual({ status: "unchanged", value: { name: "First", source: "auto" } });
  expect((await setSessionName(repo, "t", "s1", "Mine", "user")).status).toBe("saved");
  expect(read(namePathOf(repo, "t", "s1"))).toEqual({ name: "Mine", source: "user" });
  expect((await setSessionName(repo, "t", "s1", "Late", "auto")).value).toEqual({ name: "Mine", source: "user" });
});

test("a chat title follows the conversation until a person names the thread", async () => {
  const { repo, meta } = rig();
  meta("", "c1", { harness: "vinculum", generic: true });
  expect((await setSessionName(repo, "", "c1", "Fix login bug", "auto")).status).toBe("saved");
  expect((await setSessionName(repo, "", "c1", "Cookie scope", "auto")).value).toEqual({ name: "Cookie scope", source: "auto" });
  await setSessionName(repo, "", "c1", "My title", "user");
  expect(await setSessionName(repo, "", "c1", "Late auto", "auto")).toEqual({ status: "unchanged", value: { name: "My title", source: "user" } });
});

test("a name is refused for a session that is not there, a root session that is not a chat, and a bad id", async () => {
  const { repo, meta } = rig();
  meta("", "plain", { harness: "no-harness" });
  expect(await refusal(setSessionName(repo, "", "missing", "x", "auto"))).toStartWith("failed_precondition");
  expect(await refusal(setSessionName(repo, "", "plain", "x", "user"))).toBe("invalid_argument: invalid task slug or session id");
  expect(await refusal(setSessionName(repo, "t", "../x", "x", "user"))).toBe("invalid_argument: invalid task slug or session id");
  expect(await refusal(setSessionName(repo, "", "plain", "", "user"))).toBe("invalid_argument: session name must not be empty");
});

test("an automatic name is only taken from the session that owns the execution", async () => {
  const { repo, meta } = rig();
  meta("t", "s1", { execution_id: "e1" });
  // No execution record at all: ownership is unavailable.
  expect(await refusal(setSessionName(repo, "t", "s1", "x", "auto"))).toBe("failed_precondition: session execution ownership is unavailable");
  writeFileSync(join(repo, ".alinery", "tasks", "t", "execution.json"), JSON.stringify({ executions: { e1: { owner_session_id: "other" } } }));
  expect(await refusal(setSessionName(repo, "t", "s1", "x", "auto"))).toBe("failed_precondition: stale session execution owner");
  writeFileSync(join(repo, ".alinery", "tasks", "t", "execution.json"), JSON.stringify({ executions: { e1: { owner_session_id: "s1" } } }));
  expect((await setSessionName(repo, "t", "s1", "ok", "auto")).status).toBe("saved");
});

test("a name file that is a symlink or has a second hard link is refused, and a corrupt one is replaced only by a person", async () => {
  const { repo, meta } = rig();
  meta("t", "s1");
  const path = namePathOf(repo, "t", "s1");
  writeFileSync(join(repo, "outside"), "{}");
  symlinkSync(join(repo, "outside"), path);
  expect(await refusal(setSessionName(repo, "t", "s1", "x", "user"))).toStartWith("failed_precondition");
  rmSync(path);
  writeFileSync(path, "not json");
  expect(await refusal(setSessionName(repo, "t", "s1", "x", "auto"))).toBe("failed_precondition: invalid session name data");
  expect((await setSessionName(repo, "t", "s1", "fresh", "user")).status).toBe("saved");
  linkSync(path, join(repo, "second-link"));
  expect(await refusal(setSessionName(repo, "t", "s1", "x", "user"))).toStartWith("failed_precondition");
});

test("marking a notification read advances only the checkpoints that moved, and never lowers one", () => {
  const { repo, meta, read } = rig();
  meta("t", "s1", { semantic: { phase_completed_at: 50 }, exit_code: 2, ended_at: 70, unrelated: "kept" });
  expect(markNotificationRead(repo, "t", "s1")).toBe(true);
  expect(read(metaPathOf(repo, "t", "s1"))).toMatchObject({ notification_read_at: 50, exit_notification_read_at: 70, unrelated: "kept" });
  expect(markNotificationRead(repo, "t", "s1")).toBe(false);
  meta("t", "s2", { semantic: { phase_completed_at: 50 }, exit_code: 2, ended_at: 70, notification_read_at: 90 });
  expect(markExitNotificationRead(repo, "t", "s2")).toBe(true);
  expect(read(metaPathOf(repo, "t", "s2"))).toMatchObject({ notification_read_at: 90, exit_notification_read_at: 70 });
  meta("t", "s3", { exit_code: 0, ended_at: 70 });
  expect(markExitNotificationRead(repo, "t", "s3")).toBe(false);
  expect(refusalSync(() => markNotificationRead(repo, "", "s1"))).toBe("invalid_argument: invalid task slug");
});

const refusalSync = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof DomainError ? `${e.code}: ${e.message}` : String(e);
  }
  return "no refusal";
};

test("clearing notifications keeps the suppression a person chose, and exit-only leaves the completion alone", () => {
  const { repo, meta, read } = rig();
  meta("t", "s1", { semantic: { phase_completed_at: 5 }, exit_code: 1, ended_at: 9 });
  clearSessionNotifications(repo, [{ slug: "t", id: "s1", suppression: { notice: "n", occurrence: "o" } }], true);
  expect(read(metaPathOf(repo, "t", "s1"))).toMatchObject({ exit_notification_read_at: 9, notification_suppression: { notice: "n", occurrence: "o" } });
  expect(read(metaPathOf(repo, "t", "s1")).notification_read_at).toBeUndefined();
});

test("archiving stamps archived and leaves every other field as the runner wrote it", () => {
  const { repo, meta, read } = rig();
  meta("t", "s1", { phase: "build", ended_at: 4 });
  stampSessionArchived(repo, "t", "s1");
  expect(read(metaPathOf(repo, "t", "s1"))).toMatchObject({ archived: true, phase: "build", ended_at: 4 });
});
