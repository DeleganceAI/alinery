import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANVAS_INSTRUCTION, canvasTools } from "./canvasTools.ts";
import { enableCanvas, readCanvas } from "./domain/canvas.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A repository with chat thread `t1`; conversation `c1` belongs to it, `c-task` to a task session, anything else to nothing. */
function rig() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "canvas-tools-")));
  dirs.push(repo);
  mkdirSync(join(repo, ".alinery", "sessions"), { recursive: true });
  writeFileSync(join(repo, ".alinery", "sessions", "t1.meta.json"), JSON.stringify({ id: "t1", harness: "vinculum", generic: true, worktree: repo, created: 1 }));
  const refreshed: string[] = [];
  const { tools, extension } = canvasTools({ repo, threadOf: (_env, conversationId) => (String(conversationId) === "c1" ? "t1" : undefined), refresh: async (rel) => void refreshed.push(rel) });
  const tool = (name: string) => tools.find((t) => t.name === name) as { execute(args: unknown, api: unknown, ctx?: unknown): Promise<{ output: { text: string }[]; isError?: boolean }> };
  const call = (name: string, args: unknown, conversationId = "c1") => tool(name).execute(args, { conversationId, env: undefined });
  return { repo, refreshed, call, extension };
}

test("a session that is not a chat thread, or a thread without the canvas, is refused and nothing is written", async () => {
  const { call, refreshed, repo } = rig();
  const task = await call("alinery_canvas_put_markdown", { markdown: "x" }, "c-task");
  expect([task.isError, task.output[0]?.text]).toEqual([true, "The canvas belongs to chat threads; this session has none."]);
  const off = await call("alinery_canvas_put_markdown", { markdown: "x" });
  expect(off.isError).toBe(true);
  expect(off.output[0]?.text).toContain("Only the user can turn it on");
  expect(refreshed).toEqual([]);
  expect(readCanvas(repo, "t1")).toBeUndefined();
});

test("on an enabled thread each kind lands in a panel, the row is refreshed, and get reads a body back", async () => {
  const { call, refreshed, repo } = rig();
  await enableCanvas(repo, "t1");
  expect((await call("alinery_canvas_put_markdown", { title: "Notes", markdown: "# hi" })).output[0]?.text).toBe("Wrote p1 (markdown, rev 1).");
  expect((await call("alinery_canvas_put_table", { columns: ["a", "b"], rows: [[1, "x"]] })).output[0]?.text).toBe("Wrote p2 (table, rev 1).");
  expect((await call("alinery_canvas_put_chart", { spec: { mark: "bar", data: { values: [{ a: 1 }] } } })).output[0]?.text).toBe("Wrote p3 (chart, rev 1).");
  expect((await call("alinery_canvas_put_html", { panel: "p3", html: "<b>hi</b>" })).output[0]?.text).toBe("Wrote p3 (html, rev 2).");
  expect((await call("alinery_canvas_layout", { order: ["p3", "p1", "p2"], focus: "p3" })).output[0]?.text).toBe("Canvas: p3, p1, p2; focused p3.");
  expect(refreshed).toEqual(Array(5).fill("sessions/t1.canvas.json"));
  const got = await call("alinery_canvas_get", { panel: "p2" });
  expect(got.output[0]?.text).toContain('{"columns":["a","b"],"rows":[[1,"x"]]}');
  expect(refreshed).toHaveLength(5);
  const bad = await call("alinery_canvas_put_chart", { spec: { data: { url: "https://x" } } });
  expect([bad.isError, refreshed.length]).toEqual([true, 5]);
});

test("show_file and show_files put repository files on the canvas and refuse one outside it", async () => {
  const { call, repo } = rig();
  await enableCanvas(repo, "t1");
  mkdirSync(join(repo, "out"));
  writeFileSync(join(repo, "out", "a.xlsx"), "x");
  expect((await call("alinery_canvas_show_file", { path: "out/a.xlsx" })).output[0]?.text).toBe("Showing out/a.xlsx in p1 (rev 1).");
  expect((await call("alinery_canvas_show_files", { dir: "out" })).output[0]?.text).toBe("Listed 1 file in p2 (rev 1).");
  expect((await call("alinery_canvas_show_file", { path: "/etc/hosts" })).isError).toBe(true);
});

test("the canvas instruction is in a thread's prompt only once its canvas is on", async () => {
  const { extension, repo } = rig();
  const render = (conversationId: string) => (extension.sections?.[0] as { render(input: unknown): unknown }).render({ env: undefined, conversationId });
  expect(render("c1")).toBeUndefined();
  await enableCanvas(repo, "t1");
  expect(render("c1")).toBe(CANVAS_INSTRUCTION);
  expect(render("c-task")).toBeUndefined();
});
