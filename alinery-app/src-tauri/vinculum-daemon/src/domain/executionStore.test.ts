// S4.2: where the engine's State lives, and what a restart, an old log, the old runner's records, another lane's task and
// the Rust writers do to it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fold, readLog, type State } from "playbook-engine/src/state.ts";
import { completeSession, engineExecutions, forgetTask, type SessionHooks, prepareGraphs, resetGraphs, tickGraphs } from "../graph.ts";
import { holdFromRust, holderBinary } from "../platform/rustHolder.ts";
import { stepObjectBlob } from "./blobs.ts";
import { setSessionName } from "./sessionOps.ts";
import { addExecution, getTaskExecution } from "../tasks.ts";
import { provisionTask } from "./tasks.ts";
import { executionPath, historyDir, loadEngineState, saveEngineState } from "./executionStore.ts";

// A four-step fork and join: seed, then sum and product, then combine.
const OUTPUT: Record<string, string> = { seed: "numbers.md", sum: "sum.md", product: "product.md", combine: "final.md" };
const INPUTS: Record<string, string[]> = { seed: ["ticket.md"], sum: ["numbers.md"], product: ["numbers.md"], combine: ["sum.md", "product.md"] };
const step = (key: string) =>
  `[[step]]\nkey = "${key}"\ntitle = "${key}"\nshort = ""\ninputs = [${INPUTS[key].map((p) => `{ path = "${p}", mode = "single" }`).join(", ")}]\noutputs = [{ path = "${OUTPUT[key]}" }]\nmodel = ""\nharness = ""\nis_coding_step = false\nauto_advance_default = true`;
const KEYS = Object.keys(OUTPUT);

function forkJoin(repo: string, slug: string, extra: Record<string, unknown> = {}) {
  const dir = join(repo, ".alinery", "tasks", slug);
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(join(dir, "artifacts", "ticket.md"), "the task");
  const sections = KEYS.map((k) => `<!-- alinery:step ${k} -->\nDo ${k}.\n`).join("\n");
  writeFileSync(join(dir, "playbook.md"), `+++\nversion = 2\nkey = "fork-join"\ntitle = "Fork join"\ndescription = ""\ndefault_model = ""\ndefault_harness = "omp"\n\n${KEYS.map(step).join("\n")}\n+++\n${sections}\n`);
  writeFileSync(join(dir, "task.md"), `name = "Fork join"\nworktree = ${JSON.stringify(repo)}\nhas_worktree = true\n`);
  writeFileSync(join(dir, "execution.json"), JSON.stringify({ creation: "ready", initial_start_requested: true, max_live_sessions: 10, enabled_steps: KEYS, auto_approve_all: false, ...extra }));
  return dir;
}

/** The agent: writes the step's output and asks the engine to complete, a moment after its session opened. */
function agentHooks(slug: string): SessionHooks & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    async open(id) {
      opened.push(id);
      setTimeout(async () => {
        const execution = engineExecutions(slug).find((e) => e.sessionId === id);
        if (!execution) return;
        writeFileSync(join(execution.outDir, OUTPUT[execution.step]), `${execution.step} output`);
        await completeSession(id);
      }, 5);
    },
    async status() {
      return { kind: "idle" };
    },
    async send() {},
    async stop() {},
    bind() {},
  };
}

const shape = (state: State) => [...state.executions.values()].map((e) => ({ id: e.id, step: e.step, status: e.status, inputs: e.inputs, receipt: e.receipt?.map((o) => o.id) }));
const done = (slug: string) => engineExecutions(slug).length === 4 && engineExecutions(slug).every((e) => e.status === "done");

async function runUntil(condition: () => boolean, limit = 400) {
  for (let i = 0; i < limit && !condition(); i++) {
    await tickGraphs();
    await Bun.sleep(3);
  }
  if (!condition()) throw new Error("the run did not reach the expected point");
}

describe("recovery from execution.json alone", () => {
  test("a daemon killed between two steps finishes the run with the same receipts, session ids and no agent session of its own", async () => {
    // The reference: an uninterrupted run.
    const refRepo = mkdtempSync(join(tmpdir(), "vinculum-ref-"));
    forkJoin(refRepo, "fj");
    resetGraphs();
    prepareGraphs(refRepo, agentHooks("fj"));
    await runUntil(() => done("fj"));
    const reference = shape(loadStored(refRepo, "fj"));
    // The lineage a view draws from: which occurrence each execution produced and consumed.
    const lineageOf = (repo: string) => {
      const file = JSON.parse(readFileSync(executionPath(repo, "fj"), "utf8"));
      return { occurrences: file.occurrences, inputs: Object.fromEntries(Object.entries(file.executions as Record<string, { candidate: { inputs: unknown } }>).map(([id, e]) => [id, e.candidate.inputs])) };
    };
    const referenceLineage = lineageOf(refRepo);

    const repo = mkdtempSync(join(tmpdir(), "vinculum-kill-"));
    const dir = forkJoin(repo, "fj");
    resetGraphs();
    const before = agentHooks("fj");
    prepareGraphs(repo, before);
    // Run until the seed step is done and the next steps have not finished: between two steps.
    await runUntil(() => engineExecutions("fj").some((e) => e.step === "seed" && e.status === "done"));
    const beforeKill = engineExecutions("fj");
    const idsBefore = Object.fromEntries(beforeKill.map((e) => [e.id, e.sessionId]));
    expect(done("fj")).toBe(false);

    // The daemon dies: nothing but execution.json survives. The agent sessions are the harness's, and this fake one keeps them.
    resetGraphs();
    expect(existsSync(join(dir, "engine.jsonl"))).toBe(false);
    const after = agentHooks("fj");
    prepareGraphs(repo, after);
    await runUntil(() => done("fj"));
    const finished = shape(loadStored(repo, "fj"));
    expect(finished).toEqual(reference);
    expect(lineageOf(repo)).toEqual(referenceLineage);
    // Every execution that existed before the kill kept its session id, and the restart opened none of those again.
    const idsAfter = Object.fromEntries(engineExecutions("fj").map((e) => [e.id, e.sessionId]));
    for (const [id, session] of Object.entries(idsBefore)) {
      expect(idsAfter[id]).toBe(session);
      expect(after.opened).not.toContain(session as string);
    }
  });

  test("a step's manifest keeps the bytes it consumed after the live file changes and the daemon restarts", async () => {
    const repo = mkdtempSync(join(tmpdir(), "vinculum-history-"));
    const dir = forkJoin(repo, "fj");
    resetGraphs();
    prepareGraphs(repo, agentHooks("fj"));
    await runUntil(() => done("fj"));
    const stored = JSON.parse(readFileSync(join(dir, "execution.json"), "utf8"));
    const sum = stored.engine.executions.find((e: { step: string }) => e.step === "sum");
    const original = sum.manifest.consumed[0];
    expect(original.role).toBe("numbers.md");
    // The file path is kept inside the task directory as a relative path.
    expect(original.path.startsWith("/")).toBe(false);

    const seedOut = engineExecutions("fj").find((e) => e.step === "seed")!.outDir;
    writeFileSync(join(seedOut, "numbers.md"), "changed afterwards");
    resetGraphs();
    prepareGraphs(repo, agentHooks("fj"));
    await tickGraphs();
    const again = JSON.parse(readFileSync(join(dir, "execution.json"), "utf8"));
    expect(again.engine.executions.find((e: { step: string }) => e.step === "sum").manifest.consumed[0].sha256).toBe(original.sha256);
    expect(readFileSync(join(historyDir(repo, "fj"), sum.id, "objects", original.sha256), "utf8")).toBe("seed output");
    // BlobService's reader (S4.5) finds what the engine really wrote: the bytes the step saw, not the edited live file.
    const blob = stepObjectBlob(repo, "fj", sum.id, original.sha256);
    expect(blob.read(0, blob.total).toString()).toBe("seed output");
    // The executions directory is not an artifact: nothing under artifacts/ was added for it.
    expect(existsSync(join(dir, "artifacts", "executions"))).toBe(false);
  });
});

function loadStored(repo: string, slug: string): State {
  const loaded = loadEngineState(repo, slug);
  if (loaded.kind !== "stored") throw new Error(`expected a stored state, got ${loaded.kind}`);
  return loaded.state;
}

describe("a task from before this change", () => {
  test("an engine.jsonl folds to the state the old fold gave, once, and the log's bytes stay", async () => {
    const repo = mkdtempSync(join(tmpdir(), "vinculum-convert-"));
    const dir = forkJoin(repo, "old");
    const artifacts = join(dir, "artifacts");
    const log = [
      { t: "seeded", occurrences: [{ id: "seed/ticket.md", role: "ticket.md", path: join(artifacts, "ticket.md"), producer: null }] },
      { t: "reserved", execution: { id: "e1", step: "seed", depth: 1, inputs: { "ticket.md": ["seed/ticket.md"] }, outDir: join(artifacts, "1-seed-1"), origin: null, automatic: true } },
      { t: "started", execId: "e1", sessionId: "old-session" },
      { t: "accepted", execId: "e1", published: [{ id: "e1/numbers.md", role: "numbers.md", path: join(artifacts, "1-seed-1", "numbers.md"), producer: "e1" }] },
      { t: "exited", execId: "e1" },
    ];
    const text = `${log.map((line) => JSON.stringify(line)).join("\n")}\n`;
    writeFileSync(join(dir, "engine.jsonl"), text);
    const folded = fold(readLog(join(dir, "engine.jsonl")));

    const loaded = loadEngineState(repo, "old");
    expect(loaded.kind).toBe("converted");
    if (loaded.kind !== "converted") return;
    expect([...loaded.state.executions.values()]).toEqual([...folded.executions.values()]);
    expect(loaded.state.seeds).toEqual(folded.seeds);

    await saveEngineState(repo, "old", loaded.state);
    expect(loadEngineState(repo, "old").kind).toBe("stored");
    expect(readFileSync(join(dir, "engine.jsonl"), "utf8")).toBe(text);
    // The stored copy now wins even if the log is changed: it is never read again.
    writeFileSync(join(dir, "engine.jsonl"), "this is not json\n");
    expect(shape(loadStored(repo, "old"))).toEqual(shape(folded));
  });

  test("O21: the old runner's records and no engine state start no session, even after a restart, and the entity equals the records", async () => {
    const repo = mkdtempSync(join(tmpdir(), "vinculum-o21-"));
    const records = {
      "11111111-1111-4111-8111-111111111111": { id: "11111111-1111-4111-8111-111111111111", binding_key: "k", candidate: { step_key: "seed", context_id: "root", inputs: {} }, outputs: [], lifecycle: "completed", owner_session_id: "old-s", permission: { kind: "automatic" }, receipt_id: "r1" },
    };
    const dir = forkJoin(repo, "retired", { executions: records, occurrences: {} });
    // The task is waiting for work the old runner never did: every step is enabled and a ticket exists.
    const bytes = readFileSync(join(dir, "execution.json"), "utf8");
    for (let restart = 0; restart < 2; restart++) {
      resetGraphs();
      const hooks = agentHooks("retired");
      prepareGraphs(repo, hooks);
      await tickGraphs();
      await tickGraphs();
      expect(hooks.opened).toEqual([]);
      expect(engineExecutions("retired")).toEqual([]);
    }
    expect(readFileSync(join(dir, "execution.json"), "utf8")).toBe(bytes);
    const reply = getTaskExecution(repo, "retired", "lane", "identity") as { state: { executions: unknown; history_only?: boolean } };
    expect(reply.state.executions).toEqual(records);
    expect(reply.state.history_only).toBe(true);
  });

  test("a task another lane owns is not opened, and one this lane owns is", async () => {
    const repo = mkdtempSync(join(tmpdir(), "vinculum-lane-"));
    forkJoin(repo, "theirs", { owning_lane: "other-lane", owning_app_config_identity: "id" });
    forkJoin(repo, "mine", { owning_lane: "my-lane", owning_app_config_identity: "id" });
    resetGraphs();
    const hooks = agentHooks("mine");
    prepareGraphs(repo, hooks, "", { lane: "my-lane", identity: "id" });
    await tickGraphs();
    expect(engineExecutions("theirs")).toEqual([]);
    expect(engineExecutions("mine").length).toBeGreaterThan(0);
  });
});

describe("writers and the file's revision", () => {
  test("a manual record bumps revision like an engine save", async () => {
    const repo = mkdtempSync(join(tmpdir(), "vinculum-revision-"));
    forkJoin(repo, "t", { revision: 7 });
    await addExecution(repo, "t", { id: "manual-1" });
    expect(JSON.parse(readFileSync(executionPath(repo, "t"), "utf8")).revision).toBe(8);
    await saveEngineState(repo, "t", { seeds: [], executions: new Map(), ambiguities: [] });
    expect(JSON.parse(readFileSync(executionPath(repo, "t"), "utf8")).revision).toBe(9);
  });

  test("a state that changes while the save waits for the lock does not split the write", async () => {
    const repo = mkdtempSync(join(tmpdir(), "vinculum-frozen-"));
    forkJoin(repo, "t");
    const dir = join(repo, ".alinery", "tasks", "t");
    const state: State = { seeds: [], executions: new Map(), ambiguities: [] };
    const execution = { id: "e1", step: "seed", depth: 1, inputs: {}, outDir: join(dir, "artifacts", "1-seed-1"), origin: null, automatic: true, status: "reserved" } as unknown as State["executions"] extends Map<string, infer E> ? E : never;
    state.executions.set("e1", execution);
    const holder = await holdFromRust(join(repo, ".alinery", ".task-mutation.lock"));
    const saving = saveEngineState(repo, "t", state);
    await Bun.sleep(50);
    // The engine moves on while the save is still queued: the saved file must show one state, not two.
    state.executions.set("e2", { ...execution, id: "e2" });
    (execution as { status: string }).status = "failed";
    await holder.release();
    await saving;
    const file = JSON.parse(readFileSync(executionPath(repo, "t"), "utf8"));
    expect(file.engine.executions.map((row: { id: string; status: string }) => [row.id, row.status])).toEqual([["e1", "reserved"]]);
    expect(Object.keys(file.executions)).toEqual(["e1"]);
    expect(file.executions.e1.status).not.toBe("failed");
  }, 30_000);
});

describe("the task-mutation lock", () => {
  beforeAll(() => void holderBinary(), 120_000);
  test("addExecution waits for a Rust holder and returns within 100 ms of its release", async () => {
    const repo = mkdtempSync(join(tmpdir(), "vinculum-lockwait-"));
    forkJoin(repo, "t");
    const holder = await holdFromRust(join(repo, ".alinery", ".task-mutation.lock"));
    let finished = 0;
    const call = addExecution(repo, "t", { id: "manual-1" }).then(() => void (finished = Date.now()));
    await Bun.sleep(400);
    expect(finished).toBe(0);
    const released = Date.now();
    await holder.release();
    await call;
    expect(finished - released).toBeLessThan(100);
    expect(Object.keys(JSON.parse(readFileSync(executionPath(repo, "t"), "utf8")).executions)).toEqual(["manual-1"]);
  }, 30_000);
});

describe("the task-mutation lock around an engine save", () => {
  beforeAll(() => void holderBinary(), 120_000);
  test("saveEngineState writes nothing while a Rust process holds the lock, and lands within 100 ms of its release", async () => {
    const repo = mkdtempSync(join(tmpdir(), "vinculum-savewait-"));
    forkJoin(repo, "t", { revision: 4 });
    const before = readFileSync(executionPath(repo, "t"), "utf8");
    const holder = await holdFromRust(join(repo, ".alinery", ".task-mutation.lock"));
    let finished = 0;
    const call = saveEngineState(repo, "t", { seeds: [], executions: new Map(), ambiguities: [] }).then(() => void (finished = Date.now()));
    await Bun.sleep(400);
    expect(finished).toBe(0);
    expect(readFileSync(executionPath(repo, "t"), "utf8")).toBe(before);
    const released = Date.now();
    await holder.release();
    await call;
    expect(finished - released).toBeLessThan(100);
    expect(JSON.parse(readFileSync(executionPath(repo, "t"), "utf8")).revision).toBe(5);
  }, 30_000);
});

describe("Rust and TypeScript writers on one repository", () => {
  const tauri = new URL("../../../", import.meta.url).pathname;
  /** A repository with one commit. Fixture setup only: the product spawns git through alinery_core::git_cmd. */
  function gitRepo() {
    const repo = mkdtempSync(join(tmpdir(), "vinculum-interop-"));
    const env = { PATH: process.env.PATH ?? "", HOME: repo, GIT_CONFIG_NOSYSTEM: "1" };
    for (const args of [["init", "-q", "-b", "main"], ["config", "user.name", "t"], ["config", "user.email", "t@t"], ["-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "initial"]]) {
      const result = Bun.spawnSync(["git", ...args], { cwd: repo, env });
      if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    }
    return repo;
  }
  /** Task creation is TypeScript now (S4.3); Rust still reads every file it writes, which the probe rounds below check. */
  const provision = (repo: string, name: string) =>
    provisionTask(
      { repo, lane: "lane", identity: "identity" },
      { name, branchName: name, playbook: { reference: { scope: "bundled", key: "one-shot" }, source: readFileSync(join(tauri, "playbooks", "one-shot", "playbook.md"), "utf8") }, start: false },
    );
  const rustRecord = (id: string) => ({
    id,
    binding_key: id,
    candidate: { step_key: "x", context_id: "root", inputs: {}, complete_collection_id: null, each_collection_id: null, each_member_id: null, manual: false },
    outputs: [],
    parent_execution_ids: [],
    depth: 0,
    owner_session_id: "",
    previous_session_ids: [],
    launch: { harness: "omp", model: "" },
    is_coding_step: false,
    start_requested: false,
    lifecycle: "queued",
    permission: { kind: "automatic" },
    receipt_id: null,
    exit_code: null,
    shutdown_confirmed: false,
    error: null,
  });
  function rng(seed: number) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  test("100 interleaved rounds of TypeScript saves, manual records, Rust reads and TypeScript provisioning of other tasks end in a state both sides accept", async () => {
    const repo = gitRepo();
    const created = await provision(repo, "interop");
    expect(created.creation).toBe("ready");
    const slug = created.task!.slug;
    const dir = join(repo, ".alinery", "tasks", slug);

    // An engine execution that owns session S, so Rust can resolve `execution_id` from the session's own file.
    const artifacts = join(dir, "artifacts");
    const state: State = {
      seeds: [{ id: "seed/ticket.md", role: "ticket.md", path: join(artifacts, "ticket.md"), producer: null }],
      executions: new Map([["e1", { id: "e1", step: "work", depth: 1, inputs: {}, outDir: join(artifacts, "1-work-1"), origin: null, status: "live" as const, sessionId: "S", automatic: true, permitted: false, receipt: null, failure: null }]]),
      ambiguities: [],
    };
    await saveEngineState(repo, slug, state);

    const random = rng(20261105);
    let saves = 0;
    let manual = 0;
    let probes = 0;
    let provisioned = 0;
    for (let round = 0; round < 100; round++) {
      const pick = random();
      if (pick < 0.4) {
        state.ambiguities.push({ step: "x", slot: `slot-${round}`, trigger: `t-${round}`, candidates: [] });
        await saveEngineState(repo, slug, state);
        saves++;
      } else if (pick < 0.65) {
        await addExecution(repo, slug, rustRecord(`manual-${round}`));
        manual++;
      } else if (pick < 0.9) {
        const session = `probe-${round}`;
        writeFileSync(join(dir, "sessions", `${session}.meta.json`), JSON.stringify({ id: session, worktree: repo, created: 1, harness: "vinculum", execution_id: `m-${round}` }));
        // Rust reads execution.json through the typed struct: a record it cannot parse would fail here.
        await addExecution(repo, slug, { ...rustRecord(`m-${round}`), owner_session_id: session });
        manual++;
        expect((await setSessionName(repo, slug, session, `Probe ${round}`, "auto")).status).toBe("saved");
        probes++;
      } else {
        const other = await provision(repo, `other-${round}`);
        expect(other.creation).toBe("ready");
        provisioned++;
      }
      // After every round the file is one JSON document, the engine block loads, and nothing was lost.
      const file = JSON.parse(readFileSync(executionPath(repo, slug), "utf8"));
      const loaded = loadStored(repo, slug);
      expect(loaded.ambiguities).toHaveLength(saves);
      expect(Object.keys(file.executions).filter((id) => id.startsWith("manual-") || id.startsWith("m-"))).toHaveLength(manual);
      expect(file.executions.e1.owner_session_id).toBe("S");
    }
    // The run exercised every kind of round.
    expect([saves, manual, probes, provisioned].every((n) => n > 5)).toBe(true);
    // The engine's execution is readable by Rust under its own id.
    writeFileSync(join(dir, "sessions", "S.meta.json"), JSON.stringify({ id: "S", worktree: repo, created: 1, harness: "vinculum", execution_id: "e1" }));
    expect((await setSessionName(repo, slug, "S", "Engine session", "auto")).status).toBe("saved");
    expect(statSync(executionPath(repo, slug)).size).toBeGreaterThan(0);
  }, 300_000);
});
