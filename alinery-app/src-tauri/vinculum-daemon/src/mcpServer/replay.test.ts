// The fixture replay (plan S5.1 Tests): the calls `alinery-mcp` (Rust) answered on a fixture repository, made again against a real daemon
// through this module. Each reply must equal the recorded one once the values that differ by construction (ids, times, the temp
// directory) are normalised, except the calls in EXCEPTIONS, which are the changes the plan names, each with what it checks instead.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { daemonProtocol, type RunningDaemon, startDaemon } from "./daemonFixture.testutil.ts";
import { Endpoints } from "./endpoints.ts";
import { callTool } from "./handlers.ts";

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
    when: (c) => c.name === "alinery_get_task",
    why: "get_task answers Bun.TOML.stringify of the task entity, not the file's text (plan S5.1): the same fields, normalised",
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

test("every recorded call gets its recorded reply, except the changes the plan names", async () => {
  const { root, repo } = daemon.fixture;
  const endpointsFile = join(daemon.fixture.root, "endpoints.json");
  writeFileSync(endpointsFile, JSON.stringify({ version: 1, repos: { [repo]: { socket: daemon.socket, token: daemon.token } } }));
  // The shell's managed MCP, the only one `alinery_send_review_handoff` is offered to (O22 a): one token per daemon, in a file.
  const ctx = daemon.context({ endpoints: new Endpoints(undefined, endpointsFile) });
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
  const endpointsFile = join(daemon.fixture.root, "endpoints.json");
  const ctx = daemon.context({ endpoints: new Endpoints(undefined, endpointsFile) });
  const list = async () => JSON.parse((await callTool(ctx, "alinery_list_tasks", { repo })).content[0].text) as string[];
  const made = await callTool(ctx, "alinery_create_task", { repo, name: "Third task", description: "to archive", playbook: { scope: "bundled", key: "one-shot" } });
  expect(made.content[0].text.startsWith("{")).toBe(true);
  expect(await list()).toContain("third-task");
  expect((await callTool(ctx, "alinery_archive_task", { repo, slug: "third-task" })).content[0].text).toBe("archived");
  const after = await list();
  expect(after).not.toContain("third-task");
  expect(after).toContain("first-task");
});
