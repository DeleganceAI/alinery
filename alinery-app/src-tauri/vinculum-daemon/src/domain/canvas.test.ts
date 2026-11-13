import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainError } from "../platform/lock.ts";
import { canvasDir, canvasEnabled, canvasFilePath, canvasPath, canvasReport, closePanelByUser, enableCanvas, fileBody, filesBody, layoutCanvas, MAX_PANEL_BYTES, panelFile, putPanel, readCanvas } from "./canvas.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A repository with one chat thread `t1` and one task session `s1` beside it. */
function rig() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "canvas-")));
  dirs.push(repo);
  const sessions = join(repo, ".alinery", "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "t1.meta.json"), JSON.stringify({ id: "t1", harness: "vinculum", generic: true, worktree: repo, created: 1 }));
  writeFileSync(join(sessions, "s1.meta.json"), JSON.stringify({ id: "s1", harness: "vinculum", generic: false, worktree: repo, created: 1 }));
  return repo;
}

const refusal = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
};

test("the canvas is off until the user enables it, and the agent's writes are refused until then", async () => {
  const repo = rig();
  expect(canvasEnabled(repo, "t1")).toBe(false);
  expect(await refusal(() => putPanel(repo, "t1", { kind: "markdown", body: "# hi" }))).toContain("not enabled");
  expect(await enableCanvas(repo, "t1", 5)).toBe(true);
  expect(await enableCanvas(repo, "t1", 9)).toBe(false);
  expect(readCanvas(repo, "t1")).toMatchObject({ thread_id: "t1", enabled_at_ms: 5, order: [] });
});

test("only a chat thread can have a canvas", async () => {
  const repo = rig();
  expect(await refusal(() => enableCanvas(repo, "s1"))).toBe("not a chat thread");
  expect(await refusal(() => enableCanvas(repo, "../t1"))).toBe("invalid session id");
});

test("puts fill free slots, bump the revision on rewrite, and a fifth panel is refused with the four named", async () => {
  const repo = rig();
  await enableCanvas(repo, "t1");
  expect(await putPanel(repo, "t1", { kind: "markdown", title: "Notes", body: "# a" })).toEqual({ panel: "p1", rev: 1 });
  expect(await putPanel(repo, "t1", { kind: "html", title: "Page", body: "<p>x</p>" })).toEqual({ panel: "p2", rev: 1 });
  expect(await putPanel(repo, "t1", { kind: "table", body: { columns: ["a"], rows: [[1], [null]] } })).toEqual({ panel: "p3", rev: 1 });
  expect(await putPanel(repo, "t1", { kind: "chart", body: { mark: "bar", data: { values: [{ a: 1 }] } } })).toEqual({ panel: "p4", rev: 1 });
  expect(await refusal(() => putPanel(repo, "t1", { kind: "markdown", body: "more" }))).toContain('p1 (markdown: Notes), p2 (html: Page)');
  expect(await putPanel(repo, "t1", { panel: "p1", kind: "markdown", body: "# b" })).toEqual({ panel: "p1", rev: 2 });
  const canvas = readCanvas(repo, "t1");
  expect(canvas?.order).toEqual(["p1", "p2", "p3", "p4"]);
  expect(canvas?.panels.p1?.title).toBe("Notes");
  expect(readFileSync(panelFile(repo, "t1", "p1").path, "utf8")).toBe("# b");
});

test("a slot that changes kind leaves no file of the old kind behind", async () => {
  const repo = rig();
  await enableCanvas(repo, "t1");
  await putPanel(repo, "t1", { panel: "p2", kind: "html", body: "<b>x</b>" });
  await putPanel(repo, "t1", { panel: "p2", kind: "markdown", body: "x" });
  expect(existsSync(join(canvasDir(repo, "t1"), "p2.html"))).toBe(false);
  expect(panelFile(repo, "t1", "p2")).toEqual({ path: join(canvasDir(repo, "t1"), "p2.md"), kind: "markdown" });
});

test("bodies are checked per kind, chart data must be inline, and size is capped", async () => {
  const repo = rig();
  await enableCanvas(repo, "t1");
  expect(await refusal(() => putPanel(repo, "t1", { kind: "html", body: { a: 1 } }))).toContain("is a string");
  expect(await refusal(() => putPanel(repo, "t1", { kind: "table", body: { columns: ["a"], rows: [[1, 2]] } }))).toContain("no longer than columns");
  expect(await refusal(() => putPanel(repo, "t1", { kind: "table", body: { columns: ["a"], rows: [[{}]] } }))).toContain("cells are");
  expect(await refusal(() => putPanel(repo, "t1", { kind: "chart", body: { data: { url: "https://x.example/d.json" } } }))).toContain("spec.data.url");
  expect(await refusal(() => putPanel(repo, "t1", { kind: "chart", body: { layer: [{ data: { url: "data/x.csv" } }] } }))).toContain("spec.layer[0].data.url");
  expect(await refusal(() => putPanel(repo, "t1", { panel: "p9", kind: "markdown", body: "x" }))).toContain("panel is one of");
  expect(await refusal(() => putPanel(repo, "t1", { kind: "markdown", body: "x".repeat(MAX_PANEL_BYTES + 1) }))).toContain("the limit is");
  expect(readCanvas(repo, "t1")?.order).toEqual([]);
});

test("layout reorders, focuses and closes; a stale id is refused", async () => {
  const repo = rig();
  await enableCanvas(repo, "t1");
  for (const body of ["a", "b", "c"]) await putPanel(repo, "t1", { kind: "markdown", body });
  await layoutCanvas(repo, "t1", { order: ["p3", "p1", "p2"], focus: "p1" });
  expect(readCanvas(repo, "t1")).toMatchObject({ order: ["p3", "p1", "p2"], focus: "p1" });
  await layoutCanvas(repo, "t1", { close: ["p1"] });
  expect(readCanvas(repo, "t1")).toMatchObject({ order: ["p3", "p2"], focus: "" });
  expect(existsSync(join(canvasDir(repo, "t1"), "p1.md"))).toBe(false);
  expect(await refusal(() => layoutCanvas(repo, "t1", { focus: "p1" }))).toContain("no panel p1");
  expect(await refusal(() => layoutCanvas(repo, "t1", { order: ["p2"] }))).toContain("every open panel once");
  expect(await putPanel(repo, "t1", { kind: "markdown", body: "d" })).toEqual({ panel: "p1", rev: 1 });
});

test("a user close is reported to the agent with the body gone", async () => {
  const repo = rig();
  await enableCanvas(repo, "t1");
  await putPanel(repo, "t1", { kind: "markdown", title: "Plan", body: "# plan" });
  await putPanel(repo, "t1", { kind: "html", title: "Demo", body: "<i>demo</i>" });
  await closePanelByUser(repo, "t1", "p1", 7);
  const report = canvasReport(repo, "t1", "p2");
  expect(report).toContain('The user closed: p1 "Plan".');
  expect(report).toContain("- p2: html \"Demo\" rev 1");
  expect(report.endsWith("<i>demo</i>")).toBe(true);
  expect(() => canvasReport(repo, "t1", "p1")).toThrow("no panel p1");
});

test("parallel puts of one turn do not lose each other", async () => {
  const repo = rig();
  await enableCanvas(repo, "t1");
  const results = await Promise.all(["a", "b", "c", "d"].map((body) => putPanel(repo, "t1", { kind: "markdown", body })));
  expect(results.map((r) => r.panel).sort()).toEqual(["p1", "p2", "p3", "p4"]);
  expect(readCanvas(repo, "t1")?.order.length).toBe(4);
});

test("a hand-edited file for another thread, or junk, reads as no canvas", () => {
  const repo = rig();
  writeFileSync(canvasPath(repo, "t1"), JSON.stringify({ v: 1, thread_id: "other", panels: {} }));
  expect(readCanvas(repo, "t1")).toBeUndefined();
  writeFileSync(canvasPath(repo, "t1"), "not json");
  expect(canvasEnabled(repo, "t1")).toBe(false);
});

test("file panels show files inside the repository only, and a client reads exactly what the agent showed", async () => {
  const repo = rig();
  await enableCanvas(repo, "t1");
  mkdirSync(join(repo, "out", "deep"), { recursive: true });
  writeFileSync(join(repo, "out", "deck.pdf"), "%PDF");
  writeFileSync(join(repo, "out", "data.csv"), "a,b\n1,2\n");
  writeFileSync(join(repo, "out", ".hidden"), "x");
  writeFileSync(join(repo, "out", "deep", "x.pdf"), "%PDF");
  writeFileSync(join(repo, "secret.txt"), "no");
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "outside-")));
  dirs.push(outside);
  writeFileSync(join(outside, "passwd"), "root");
  symlinkSync(join(outside, "passwd"), join(repo, "out", "escape.txt"));

  const file = fileBody(repo, "t1", "out/deck.pdf");
  expect(file).toMatchObject({ path: join(repo, "out", "deck.pdf"), size: 4 });
  expect(await refusal(async () => fileBody(repo, "t1", join(outside, "passwd")))).toContain("outside this repository");
  expect(await refusal(async () => fileBody(repo, "t1", "out/escape.txt"))).toContain("outside this repository");
  expect(await refusal(async () => fileBody(repo, "t1", "out"))).toContain("not a file");

  const list = filesBody(repo, "t1", "out");
  expect(list.entries.map((e) => e.path)).toEqual(["data.csv", "deck.pdf"]);
  expect(filesBody(repo, "t1", "out", "**/*.pdf").entries.map((e) => e.path)).toEqual(["deck.pdf", "deep/x.pdf"]);

  await putPanel(repo, "t1", { kind: "file", body: file });
  await putPanel(repo, "t1", { kind: "files", body: list });
  expect(canvasFilePath(repo, "t1", "p1", "ignored")).toBe(join(repo, "out", "deck.pdf"));
  expect(canvasFilePath(repo, "t1", "p2", "data.csv")).toBe(join(repo, "out", "data.csv"));
  expect(await refusal(async () => canvasFilePath(repo, "t1", "p2", "../secret.txt"))).toContain("not listed");
  // A listed file swapped for a link out of the repository is refused at read time.
  rmSync(join(repo, "out", "data.csv"));
  symlinkSync(join(outside, "passwd"), join(repo, "out", "data.csv"));
  expect(await refusal(async () => canvasFilePath(repo, "t1", "p2", "data.csv"))).toContain("outside this repository");
  await putPanel(repo, "t1", { kind: "markdown", body: "x" });
  expect(await refusal(async () => canvasFilePath(repo, "t1", "p3", "x"))).toContain("not a file panel");
});
