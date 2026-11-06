import { afterEach, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainError } from "../platform/lock.ts";
import { HISTORY_WINDOW_MAX, newestOmpJsonl, readHistory, readOmpWindow, sessionArtifactReady } from "./history.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function rig() {
  const repo = mkdtempSync(join(tmpdir(), "history-"));
  dirs.push(repo);
  const alinery = join(repo, ".alinery");
  mkdirSync(join(alinery, "sessions"), { recursive: true });
  const root = join(alinery, "sessions");
  const meta = (id: string, extra: Record<string, unknown> = {}) => writeFileSync(join(root, `${id}.meta.json`), JSON.stringify({ id, ...extra }));
  return { repo, alinery, root, meta };
}

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof DomainError ? `${e.code}: ${e.message}` : String(e);
  }
  return "no refusal";
};

test("a window of the scrollback comes back with where to read next, and at most 1 MiB", () => {
  const { repo, root, meta } = rig();
  meta("s1");
  writeFileSync(join(root, "s1.scrollback"), "0123456789");
  const first = readHistory(repo, "", "s1", 0, 4);
  expect([first.data.toString(), first.length, first.nextOffset, first.eof]).toEqual(["0123", 10, 4, false]);
  const last = readHistory(repo, "", "s1", 8, 100);
  expect([last.data.toString(), last.nextOffset, last.eof]).toEqual(["89", 10, true]);
  writeFileSync(join(root, "s1.scrollback"), Buffer.alloc(HISTORY_WINDOW_MAX + 10, 0x61));
  expect(readHistory(repo, "", "s1", 0, HISTORY_WINDOW_MAX * 4).data.length).toBe(HISTORY_WINDOW_MAX);
  expect(refusal(() => readHistory(repo, "", "s1", 0))).toBe("invalid_argument: offset and limit must be provided together");
});

test("a scrollback kept as numbered chunks reads as one stream in chunk order", () => {
  const { repo, root, meta } = rig();
  meta("s1");
  const dir = join(root, "s1.scrollback");
  mkdirSync(dir);
  writeFileSync(join(dir, "10"), "ccc");
  writeFileSync(join(dir, "2"), "bb");
  writeFileSync(join(dir, "1"), "a");
  writeFileSync(join(dir, "notes.txt"), "ignored");
  const all = readHistory(repo, "", "s1", 0, 100);
  expect([all.data.toString(), all.length]).toEqual(["abbccc", 6]);
  expect(readHistory(repo, "", "s1", 2, 3).data.toString()).toBe("bcc");
});

test("the tail replay leaves terminal queries out and a missing scrollback is empty, not an error", () => {
  const { repo, root, meta } = rig();
  meta("s1");
  expect(readHistory(repo, "", "s1").data.length).toBe(0);
  writeFileSync(join(root, "s1.scrollback"), "before\x1b[cafter\x1b[6nend");
  expect(readHistory(repo, "", "s1").data.toString()).toBe("beforeafterend");
});

test("a history that is a symlink, or a session id that is not that session, is refused", () => {
  const { repo, root, meta } = rig();
  meta("s1");
  writeFileSync(join(repo, "secret"), "do not read");
  symlinkSync(join(repo, "secret"), join(root, "s1.scrollback"));
  expect(refusal(() => readHistory(repo, "", "s1", 0, 10))).toStartWith("failed_precondition: session history escapes the repo");
  // A link that stays inside `.alinery` is still no scrollback we wrote.
  rmSync(join(root, "s1.scrollback"));
  writeFileSync(join(root, "real"), "x");
  symlinkSync(join(root, "real"), join(root, "s1.scrollback"));
  expect(refusal(() => readHistory(repo, "", "s1", 0, 10))).toStartWith("failed_precondition: history path is a symlink");
  expect(refusal(() => readHistory(repo, "", "../s1", 0, 10))).toStartWith("invalid_argument");
  meta("s2", {});
  writeFileSync(join(root, "s3.meta.json"), JSON.stringify({ id: "other" }));
  expect(refusal(() => readHistory(repo, "", "s3", 0, 10))).toStartWith("failed_precondition: session metadata id");
  expect(refusal(() => readHistory(repo, "", "nope", 0, 10))).toStartWith("not_found");
});

test("the newest journal is chosen by name, and a link or a file with two links is no journal", () => {
  const { root } = rig();
  const dir = join(root, "s1.omp");
  mkdirSync(dir);
  writeFileSync(join(dir, "2026-01-01_a.jsonl"), "old\n");
  writeFileSync(join(dir, "2026-02-01_b.jsonl"), "new\n");
  writeFileSync(join(dir, "2026-03-01_c.jsonl"), "shared\n");
  linkSync(join(dir, "2026-03-01_c.jsonl"), join(root, "elsewhere"));
  symlinkSync(join(dir, "2026-01-01_a.jsonl"), join(dir, "2026-04-01_d.jsonl"));
  expect(newestOmpJsonl(dir)).toBe(join(dir, "2026-02-01_b.jsonl"));
  expect(newestOmpJsonl(join(root, "missing"))).toBeUndefined();
});

test("a journal window opens on a row boundary and reports where it ends", () => {
  const { repo, root, meta } = rig();
  meta("s1");
  const dir = join(root, "s1.omp");
  mkdirSync(dir);
  const rows = ["row-one", "row-two", "row-three"].map((r) => `${r}\n`).join("");
  writeFileSync(join(dir, "2026-01-01_a.jsonl"), rows);
  const whole = readOmpWindow(repo, "", "s1");
  expect([whole.data.toString(), whole.start, whole.end, whole.length]).toEqual([rows, 0, rows.length, rows.length]);
  // 12 bytes back from the end lands inside "row-two": the window starts at "row-three".
  const tail = readOmpWindow(repo, "", "s1", undefined, 12);
  expect(tail.data.toString()).toBe("row-three\n");
  expect(tail.start).toBe(rows.length - "row-three\n".length);
  const earlier = readOmpWindow(repo, "", "s1", tail.start, 100);
  expect(earlier.data.toString()).toBe("row-one\nrow-two\n");
  expect(readOmpWindow(repo, "", "s1", 0, 100).data.length).toBe(0);
});

test("a session with no journal yet has an empty window", () => {
  const { repo, meta } = rig();
  meta("s1");
  expect(readOmpWindow(repo, "", "s1")).toEqual({ data: Buffer.alloc(0), start: 0, end: 0, length: 0 });
});

test("a phase artifact is ready when it is a non-empty file inside the task's artifacts", () => {
  const repo = mkdtempSync(join(tmpdir(), "history-art-"));
  dirs.push(repo);
  const task = join(repo, ".alinery", "tasks", "t");
  mkdirSync(join(task, "sessions"), { recursive: true });
  mkdirSync(join(task, "artifacts"), { recursive: true });
  const meta = (id: string, artifact: string) => writeFileSync(join(task, "sessions", `${id}.meta.json`), JSON.stringify({ id, artifact }));
  meta("s1", "01-plan.md");
  expect(sessionArtifactReady(repo, "t", "s1")).toBe(false);
  writeFileSync(join(task, "artifacts", "01-plan.md"), "");
  expect(sessionArtifactReady(repo, "t", "s1")).toBe(false);
  writeFileSync(join(task, "artifacts", "01-plan.md"), "# plan");
  expect(sessionArtifactReady(repo, "t", "s1")).toBe(true);
  meta("s2", "../task.md");
  expect(sessionArtifactReady(repo, "t", "s2")).toBe(false);
  expect(sessionArtifactReady(repo, "", "s1")).toBe(false);
});
