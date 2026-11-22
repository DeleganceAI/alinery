// The fixture replay: the calls `alinery-mcp` (Rust) answered on a fixture repository, made again against a real daemon
// through this module. Each reply must equal the recorded one once the values that differ by construction (ids, times, the temp
// directory) are normalised, except the calls in EXCEPTIONS, which are the deliberate changes, each with what it checks instead.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { fromJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { daemonProtocol, type RunningDaemon, startDaemon } from "./daemonFixture.testutil.ts";
import { Endpoints } from "./endpoints.ts";
import { callTool, itemJson } from "./handlers.ts";

type Recorded = { name: string; arguments: Record<string, unknown>; reply: { content: { text: string }[] } };
const recorded = (JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "rust-replies.json"), "utf8")) as { calls: Recorded[] }).calls;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const VOLATILE = /^(created|created_at|modified_at_ms|started_at|ended_at|status_changed_at|owning_app_config_identity|.*_bytes)$/;

/** A reply with its volatile values replaced: text that parses as JSON is compared as JSON, anything else as text. */
export function normalise(text: string, root: string): unknown {
  const flat = text.split(root).join("<ROOT>").replace(UUID, "<UUID>");
  const walk = (value: unknown, key = ""): unknown => {
    if (Array.isArray(value)) return value.map((v) => walk(v));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
    return typeof value === "number" && VOLATILE.test(key) ? "<N>" : typeof value === "string" && VOLATILE.test(key) ? "<ID>" : value;
  };
  try {
    return walk(JSON.parse(flat));
  } catch {
    return flat.replace(/created = \d+/g, "created = <N>");
  }
}

/** The first few paths at which two normalised replies differ, for a failure a person can read. */
function paths(want: unknown, got: unknown, at = "$", out: string[] = []): string[] {
  if (out.length >= 6) return out;
  const objects = want && got && typeof want === "object" && typeof got === "object";
  if (!objects) {
    if (JSON.stringify(want) !== JSON.stringify(got)) out.push(`${at}: want ${JSON.stringify(want)?.slice(0, 100)} got ${JSON.stringify(got)?.slice(0, 100)}`);
    return out;
  }
  for (const key of new Set([...Object.keys(want as object), ...Object.keys(got as object)])) paths((want as Record<string, unknown>)[key], (got as Record<string, unknown>)[key], `${at}.${key}`, out);
  return out;
}

/** The recorded calls whose reply differs on purpose, each with the check that stands in for equality. */
const EXCEPTIONS: { when: (call: Recorded) => boolean; why: string; check: (actual: string, want: string, root: string) => void }[] = [
  {
    when: (c) => c.name === "alinery_read_config" && c.reply.content[0].text === "",
    why: "a repository with no settings answers a TOML comment saying the defaults apply, not an empty string",
    check: (actual) => {
      expect(actual.startsWith("# ")).toBe(true);
      expect(Bun.TOML.parse(actual)).toEqual({});
    },
  },
  {
    when: (c) => c.name === "alinery_get_task",
    why: "get_task answers Bun.TOML.stringify of the task entity, not the file's text: the same fields, normalised",
    check: (actual, want, root) => expect(normalise(Bun.TOML.parse(actual) ? JSON.stringify(Bun.TOML.parse(actual)) : "", root)).toEqual(normalise(JSON.stringify(Bun.TOML.parse(want)), root)),
  },
  {
    when: (c) => c.name === "alinery_write_config" && String(c.arguments.content).includes("[valid"),
    why: "the TOML parser's own message for the same bad text is a different string (Rust's toml crate against Bun's)",
    check: (actual, want) => {
      expect(actual.startsWith("error: not valid TOML (")).toBe(true);
      expect(actual.endsWith("; not written")).toBe(want.endsWith("; not written"));
    },
  },
  {
    when: (c) => c.name === "alinery_list_sessions",
    why: "the Rust listing was a sparse struct that dropped each empty field of its own accord; the daemon's entity lists them all, so the rows are compared on the fields both name",
    check: (actual, want) => {
      const key = (rows: Record<string, unknown>[]) => rows.map((r) => [r.id, r.harness, r.model, r.worktree, r.phase || undefined, r.execution_id || undefined, r.generic || undefined]);
      const normalised = (text: string) => key(JSON.parse(text.split(daemon.fixture.root).join("<ROOT>").replace(UUID, "<UUID>")) as Record<string, unknown>[]);
      expect(normalised(actual).map((k) => k.slice(1)).sort()).toEqual(normalised(want).map((k) => k.slice(1)).sort());
    },
  },
  {
    when: (c) => ["alinery_create_task", "alinery_create_session"].includes(c.name),
    why: "the session and execution objects these answer are the daemon's own JSON, which leaves out a field at its default (false, empty, zero) where the Rust struct wrote it; compared with the defaults dropped from both",
    check: (actual, want, root) => {
      const bare = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(bare);
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).flatMap(([k, v]) => (v === false || v === "" || v === 0 || v === null || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && Object.keys(bare(v) as object).length === 0) ? [] : [[k, bare(v)]])));
        return value;
      };
      if (!want.startsWith("{")) return expect(actual).toBe(want);
      expect(bare(normalise(actual, root))).toEqual(bare(normalise(want, root)));
    },
  },
];

let daemon: RunningDaemon;
beforeAll(async () => {
  daemon = await startDaemon(undefined, daemonProtocol());
}, 60_000);
afterAll(async () => {
  await daemon?.stop();
  if (daemon) rmSync(daemon.fixture.root, { recursive: true, force: true });
});

const registered = () => new Endpoints(undefined, () => ({ [daemon.fixture.repo]: { socket: daemon.socket, token: daemon.token } }));

test("every recorded call gets its recorded reply, except the deliberate changes", async () => {
  const { root, repo } = daemon.fixture;
  // The machine MCP, the only one `alinery_send_review_handoff` is offered to: the daemons that registered with it.
  const ctx = daemon.context({ endpoints: registered() });
  let sid = "";
  const differences: string[] = [];
  for (const [index, call] of recorded.entries()) {
    const fill = (value: unknown): unknown => (typeof value === "string" ? value.split("${ROOT}").join(root).split("${SID}").join(sid) : Array.isArray(value) ? value.map(fill) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)])) : value);
    const args = fill(call.arguments) as Record<string, unknown>;
    const reply = await callTool(ctx, call.name, args);
    const actual = reply.content[0].text;
    if (call.name === "alinery_create_session" && args.generic === true && actual.startsWith("{")) sid = (JSON.parse(actual) as { session: { id: string } }).session.id;
    const want = call.reply.content[0].text.split("${ROOT}").join(root);
    const exception = EXCEPTIONS.find((e) => e.when(call));
    try {
      if (exception) exception.check(actual, want, root);
      else {
        const wanted = normalise(want, root);
        const found = normalise(actual, root);
        if (JSON.stringify(wanted) !== JSON.stringify(found) && paths(wanted, found).length > 0) throw new Error(paths(wanted, found).join("\n  "));
      }
    } catch (e) {
      differences.push(`#${index} ${call.name} ${JSON.stringify(call.arguments).slice(0, 120)}\n  ${(e as Error).message}`);
    }
  }
  expect(repo).toBeTruthy();
  expect(differences.join("\n")).toBe("");
}, 120_000);

test("an archived task is left out of alinery_list_tasks while it still exists (the recorded list runs after the purge)", async () => {
  const { repo } = daemon.fixture;
  const ctx = daemon.context({ endpoints: registered() });
  const list = async () => JSON.parse((await callTool(ctx, "alinery_list_tasks", { repo })).content[0].text) as string[];
  const made = await callTool(ctx, "alinery_create_task", { repo, name: "Third task", description: "to archive", playbook: { scope: "bundled", key: "one-shot" } });
  expect(made.content[0].text.startsWith("{")).toBe(true);
  expect(await list()).toContain("third-task");
  expect((await callTool(ctx, "alinery_archive_task", { repo, slug: "third-task" })).content[0].text).toBe("archived");
  const after = await list();
  expect(after).not.toContain("third-task");
  expect(after).toContain("first-task");
});

test("a refused call is marked isError and content is not, even content that reads like an error (#169)", async () => {
  const { repo } = daemon.fixture;
  const ctx = daemon.context({ endpoints: registered() });
  const missing = await callTool(ctx, "alinery_get_task", { repo, slug: "no-such-task" });
  expect(missing).toEqual({ content: [{ type: "text", text: "error: missing task 'no-such-task'" }], isError: true });
  expect((await callTool(ctx, "alinery_get_task", { repo, slug: "bad/slug" })).isError).toBe(true);
  expect((await callTool(ctx, "alinery_list_tasks", {})).isError).toBe(true);
  expect((await callTool(ctx, "alinery_nope", { repo })).isError).toBe(true);
  const found = await callTool(ctx, "alinery_get_task", { repo, slug: "first-task" });
  expect(found.isError).toBeUndefined();
  expect(found.content[0].text).toContain("first-task");
});

test("task tools take task_slug or the older slug, session_status takes id, and a history window needs only offset or limit", async () => {
  const { repo } = daemon.fixture;
  const ctx = daemon.context({ endpoints: registered() });
  const bySlug = await callTool(ctx, "alinery_get_task", { repo, slug: "first-task" });
  expect((await callTool(ctx, "alinery_get_task", { repo, task_slug: "first-task" })).content[0].text).toBe(bySlug.content[0].text);
  expect((await callTool(ctx, "alinery_get_task_execution", { repo, slug: "first-task" })).isError).toBeUndefined();
  const sessions = JSON.parse((await callTool(ctx, "alinery_list_sessions", { repo, task_slug: "first-task" })).content[0].text) as { id: string; harness: string }[];
  // An agent session answers its live or retained conversation when available.
  const agent = sessions.find((s) => s.harness === "vinculum");
  if (agent) expect((await callTool(ctx, "alinery_read_session_history", { repo, task_slug: "first-task", session_id: agent.id })).content[0].text).toMatch(/"mode":"transcript"|no transcript available/);
  const sid = sessions.find((s) => s.harness === "no-harness")?.id ?? "";
  expect(JSON.parse((await callTool(ctx, "alinery_session_status", { repo, slug: "first-task", id: sid })).content[0].text).session_id).toBe(sid);
  const window = JSON.parse((await callTool(ctx, "alinery_read_session_history", { repo, task_slug: "first-task", session_id: sid, limit: 5 })).content[0].text);
  expect(window).toMatchObject({ mode: "raw", offset: 0, limit: 5 });
});

test("a transcript item reads as strings: text, thinking and tool calls, long text clipped, absent fields left out", () => {
  const item = {
    id: "1",
    role: "assistant",
    streaming: false,
    toolName: "",
    toolCallId: "",
    isError: false,
    runningToolIds: [],
    content: [
      { kind: { case: "text", value: "x".repeat(5000) } },
      { kind: { case: "toolCall", value: { name: "read", arguments: fromJson(ValueSchema, { path: "a.ts" }) } } },
    ],
  } as unknown as Parameters<typeof itemJson>[0];
  const out = itemJson(item);
  expect(out.role).toBe("assistant");
  expect(String(out.text).endsWith("… [1000 more characters]")).toBe(true);
  expect(out.tool_calls).toEqual([{ name: "read", arguments: '{"path":"a.ts"}' }]);
  expect(Object.keys(out).sort()).toEqual(["role", "text", "tool_calls"]);
});
