import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "bun:test";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { EntitySchema } from "alinery-proto/alinery/v1/entities_pb";
import { Engine } from "playbook-engine/src/engine.ts";
import { parsePlaybookMd } from "playbook-engine/src/playbook-md.ts";
import { fold } from "playbook-engine/src/state.ts";
import { settle } from "playbook-engine/test/helpers.ts";
import { complete, FakeHarness } from "playbook-engine/test/fake-harness.ts";
import { completeSession, continueReviewed, engineExecutions, forgetTask, prepareGraphs, resetGraphs, submitSessionWork, tickGraphs } from "../graph.ts";
import { Replica, taskScope } from "../sync/testkit.ts";
import { Store } from "../sync/store.ts";
import { getTaskExecution } from "../tasks.ts";
import { commitExecution, executionEntity, executionKey, executionParser } from "./executions.ts";
import { loadEngineState, saveEngineState } from "./executionStore.ts";
import { Feed } from "../sync/feed.ts";
import { parsers } from "../sync/parsers/index.ts";
import { BoardProjector } from "./board.ts";

// A four-step fork and join, the shape of the retired parallel-numbers playbook: seed, then sum and
// product side by side, then combine.
const step = (key: string, inputs: string[], output: string) =>
  `[[step]]\nkey = "${key}"\ntitle = "${key}"\nshort = ""\ninputs = [${inputs.map((p) => `{ path = "${p}", mode = "single" }`).join(", ")}]\noutputs = [{ path = "${output}" }]\nmodel = ""\nharness = ""\nis_coding_step = false\nauto_advance_default = true`;
const STEPS = [step("seed", ["ticket.md"], "numbers.md"), step("sum", ["numbers.md"], "sum.md"), step("product", ["numbers.md"], "product.md"), step("combine", ["sum.md", "product.md"], "final.md")];
const KEYS = ["seed", "sum", "product", "combine"];

function fixture(slug: string, enabledSteps = KEYS) {
  const repo = mkdtempSync(join(tmpdir(), "vinculum-exec-"));
  const dir = join(repo, ".alinery", "tasks", slug);
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(join(dir, "artifacts", "ticket.md"), "the task");
  const sections = KEYS.map((k) => `<!-- alinery:step ${k} -->\nDo ${k}.\n`).join("\n");
  writeFileSync(join(dir, "playbook.md"), `+++\nversion = 2\nkey = "fork-join"\ntitle = "Fork join"\ndescription = ""\ndefault_model = ""\ndefault_harness = "vinculum"\n\n${STEPS.join("\n")}\n+++\n${sections}\n`);
  writeFileSync(join(dir, "task.md"), `name = "Fork join"\nslug = "${slug}"\nbranch = "fixture"\ncreated = 1\nengine_version = 2\nworktree = ${JSON.stringify(repo)}\nhas_worktree = true\n`);
  writeFileSync(join(dir, "execution.json"), JSON.stringify({ creation: "ready", initial_start_requested: true, max_live_sessions: 10, enabled_steps: enabledSteps, auto_approve_all: false }));
  return { repo, dir };
}

test("every engine save commits the execution, and the last one is getTaskExecution", async () => {
  const { repo, dir } = fixture("fj");
  const store = new Store();
  const replica = new Replica();
  const ac = new AbortController();
  const stream = (async () => {
    for await (const f of store.open(taskScope("fj"), undefined, ac.signal)) replica.apply(f);
  })();

  const harness = new FakeHarness(async (launch, session) => {
    for (const path of Object.values(launch.outputs)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${launch.step} output`);
    }
    await complete(launch, session);
  });
  let events = 0;
  const seqs: bigint[] = [];
  const engine = Engine.open({
    playbook: parsePlaybookMd(readFileSync(join(dir, "playbook.md"), "utf8")).playbook!,
    harness,
    load: () => undefined,
    save: (state) => saveEngineState(repo, "fj", state),
    artifactsDir: join(dir, "artifacts"),
    cwd: repo,
    enabledSteps: () => KEYS,
    onSaved: () => {
      events++;
      commitExecution(store, repo, "fj", "lane", "identity");
      seqs.push(store.seq);
    },
  });
  engine.seed([{ role: "ticket.md", path: join(dir, "artifacts", "ticket.md") }]);
  await settle(engine);
  expect(engine.state.executions.size).toBe(4);
  expect([...engine.state.executions.values()].every((e) => e.status === "done")).toBe(true);

  // One delta per save: each save moved the store's seq by exactly one.
  expect(events).toBeGreaterThan(4);
  expect(seqs.map((s, i) => s - (seqs[i - 1] ?? 0n))).toEqual(seqs.map(() => 1n));

  // The subscriber ends up with exactly what the RPC read returns.
  for (let i = 0; i < 100 && replica.cursor?.seq !== store.seq; i++) await Bun.sleep(1);
  const row = replica.rows.get(executionKey("fj"));
  expect(row).toBeDefined();
  if (row!.value.case !== "execution") throw new Error("not an execution row");
  const exec = row!.value.value;
  const body = { execution: { slug: exec.slug, state: exec.state!, definition: exec.definition! } };
  const read = JSON.parse(JSON.stringify(getTaskExecution(repo, "fj", "lane", "identity")));
  expect(body.execution).toEqual({ slug: "fj", state: read.state, definition: read.definition });
  expect(Object.keys(read.state.executions)).toHaveLength(4);
  ac.abort();
  await stream;

  // The stored state, loaded again, is the live state. No log was written.
  const loaded = loadEngineState(repo, "fj");
  if (loaded.kind !== "stored") throw new Error(`expected a stored state, got ${loaded.kind}`);
  expect([...loaded.state.executions.values()]).toEqual([...engine.state.executions.values()]);
  expect(loaded.state.seeds).toEqual(engine.state.seeds);
  expect(existsSync(join(dir, "engine.jsonl"))).toBe(false);
});

test("a throwing onSaved never fails the engine", async () => {
  const { repo, dir } = fixture("boom");
  const engine = Engine.open({
    playbook: parsePlaybookMd(readFileSync(join(dir, "playbook.md"), "utf8")).playbook!,
    harness: new FakeHarness(async () => {}),
    load: () => undefined,
    save: () => {},
    artifactsDir: join(dir, "artifacts"),
    cwd: repo,
    onSaved: () => {
      throw new Error("subscriber broke");
    },
  });
  engine.seed([{ role: "ticket.md", path: join(dir, "artifacts", "ticket.md") }]);
  await engine.flush();
  expect(engine.state.seeds).toHaveLength(1);
});

test("the daemon's task engine reports its events through the hook", async () => {
  const { repo } = fixture("hooked");
  const store = new Store();
  resetGraphs();
  prepareGraphs(repo, {
    async open() {},
    async status() {
      return { kind: "idle" };
    },
    async send() {},
    async stop() {},
    bind() {},
    executionChanged: (slug) => commitExecution(store, repo, slug, "lane", "identity"),
  });
  const before = store.seq;
  await tickGraphs();
  forgetTask("hooked");
  // The seed and the first reservation and start are events; the row exists and shows the execution.
  expect(store.seq).toBeGreaterThan(before);
  const row = [...store.rowsMatching(taskScope("hooked"))].find((e) => e.key === executionKey("hooked"));
  expect(row?.value.case).toBe("execution");
});

test("a task with no execution state has no row", () => {
  const store = new Store();
  const repo = mkdtempSync(join(tmpdir(), "vinculum-exec-none-"));
  commitExecution(store, repo, "ghost", "lane", "identity");
  expect(store.seq).toBe(0n);
});

test("a scan puts the execution row of a task no engine event has touched, and a rewrite of execution.json updates it", async () => {
  const { repo, dir } = fixture("cold");
  const parser = executionParser(repo, "lane", "id");
  parsers.push(parser);
  try {
    const store = new Store();
    const feed = new Feed(store, join(repo, ".alinery"));
    await feed.scan();
    const row = () => {
      const e = store.get(executionKey("cold"));
      return e?.value.case === "execution" ? e.value.value.state! : undefined;
    };
    expect(row()).toMatchObject({ auto_approve_all: false, owning_lane: "lane" });
    writeFileSync(join(dir, "execution.json"), JSON.stringify({ creation: "ready", initial_start_requested: true, max_live_sessions: 10, enabled_steps: KEYS, auto_approve_all: true }));
    await feed.refresh("tasks/cold/execution.json");
    expect(row()).toMatchObject({ auto_approve_all: true });
  } finally {
    parsers.splice(parsers.indexOf(parser), 1);
  }
});

test("the execution row reaches a client as plain JSON, not a Struct message encoded as JSON", () => {
  const { repo } = fixture("wire");
  const entity = executionEntity(repo, "wire", "lane", "identity");
  if (!entity) throw new Error("no execution entity");
  const row = fromBinary(EntitySchema, toBinary(EntitySchema, entity)).value;
  if (row.case !== "execution") throw new Error(`unexpected case ${row.case}`);
  expect(row.value.state?.creation).toBe("ready");
  expect(row.value.definition?.key).toBe("fork-join");
});

test("only a persistent refusal disables a readable task's engine controls", () => {
  const { repo, dir } = fixture("owner");
  const path = join(dir, "execution.json");
  const initial = JSON.parse(readFileSync(path, "utf8"));
  for (const [change, reason] of [
    [{}, undefined],
    [{ creation: "creating" }, "Task creation has not finished."],
    [{ owning_lane: "foreign" }, "Another Alinery daemon owns this task."],
    [{ owning_lane: "lane", owning_app_config_identity: "foreign" }, "Another Alinery daemon owns this task."],
  ] as const) {
    writeFileSync(path, JSON.stringify({ ...initial, ...change }));
    const row = executionEntity(repo, "owner", "lane", "id")!.value;
    if (row.case !== "execution") throw new Error("expected execution");
    expect(row.value.state?.engine_unavailable).toBe(reason);
  }
});

test("an open engine can offer review and advance from its loaded playbook after the file disappears", async () => {
  const { repo, dir } = fixture("live-review");
  const file = join(dir, "execution.json");
  const readFile = () => JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...readFile(), enabled_steps: [], owning_lane: "lane", owning_app_config_identity: "id" }));
  resetGraphs();
  prepareGraphs(repo, { open: async () => {}, status: async () => ({ kind: "idle" }), send: async () => {}, stop: async () => {}, bind() {} }, "", { lane: "lane", identity: "id" });
  try {
    await tickGraphs();
    const [seed] = engineExecutions("live-review");
    unlinkSync(join(dir, "playbook.md"));
    writeFileSync(join(seed.outDir, "numbers.md"), "42");
    const review = await completeSession(seed.sessionId!);
    expect(review).toMatchObject({ outcome: "ready_for_review", endpoint: false, destinations: ["product", "sum"] });
    const row = () => {
      const value = executionEntity(repo, "live-review", "lane", "id")!.value;
      if (value.case !== "execution") throw new Error("expected execution");
      return value.value;
    };
    expect(row().definition?.key).toBe("fork-join");
    expect(row().state?.engine_unavailable).toBeUndefined();
    expect(row().state?.executions).toMatchObject({ e1: { ready: { revision: review!.work_revision, endpoint: false } } });
    // Direct clients requiring a readable retained playbook still fail closed.
    expect(getTaskExecution(repo, "live-review", "lane", "id").error).toMatch(/playbook\.md/);
    const other = fixture("live-review");
    unlinkSync(join(other.dir, "playbook.md"));
    const unrelated = executionEntity(other.repo, "live-review", "lane", "id")!.value;
    expect(unrelated).toMatchObject({ case: "execution", value: { state: { engine_unavailable: expect.stringMatching(/playbook\.md/) } } });
    const original = readFile();
    writeFileSync(file, JSON.stringify({ ...original, owning_lane: "foreign" }));
    expect(row().definition).toBeUndefined();
    expect(row().state?.engine_unavailable).toContain("Another Alinery daemon owns this task.");
    writeFileSync(file, JSON.stringify(original));
    await continueReviewed("live-review", seed.id, seed.sessionId!, Number(review!.work_revision));
    await tickGraphs();
    await tickGraphs();
    expect(engineExecutions("live-review").map((e) => [e.step, e.status])).toEqual([["seed", "done"], ["sum", "live"], ["product", "live"]]);
    expect(readFile().executions.e2.outputs).toMatchObject([{ selector: "sum.md" }]);
    forgetTask("live-review");
    expect(row().definition).toBeUndefined();
    expect(row().state?.engine_unavailable).toMatch(/playbook\.md/);
  } finally {
    resetGraphs();
  }
});

test.each(["unchanged", "revised"])("an answered review follow-up restores Continue with %s output until the reviewer accepts", async (output) => {
  const slug = "review-question";
  const { repo } = fixture(slug, []);
  const answered = new Set<string>();
  const open = () => prepareGraphs(repo, {
    open: async () => {}, status: async () => ({ kind: "idle" }), send: async () => {}, stop: async () => {}, bind() {},
    reviewFollowUpFinished: async (id, requestId) => answered.has(`${id}/${requestId}`),
  });
  resetGraphs();
  open();
  try {
    await tickGraphs();
    const [seed] = engineExecutions(slug);
    const session = seed.sessionId!;
    const artifact = join(seed.outDir, "numbers.md");
    writeFileSync(artifact, "42");
    const first = await completeSession(session);
    expect(first).toMatchObject({ outcome: "ready_for_review", endpoint: false });
    const before = Number(first!.work_revision);

    await submitSessionWork(slug, session, async () => {}, undefined, "list-files");
    await tickGraphs();
    expect(seed.ready).toBeUndefined();
    await expect(continueReviewed(slug, seed.id, session, before)).rejects.toThrow("This revision is no longer ready.");
    if (output === "revised") {
      writeFileSync(artifact, "43");
      resetGraphs();
      open();
    }
    answered.add(`${session}/list-files`);
    await tickGraphs();
    const [reviewed] = engineExecutions(slug);
    const after = Number(reviewed.ready?.revision);
    expect(after).toBeGreaterThan(before);
    expect(executionEntity(repo, slug, "lane", "identity")!.value).toMatchObject({
      case: "execution", value: { state: { executions: { e1: { ready: { revision: after, endpoint: false, destinations: ["product", "sum"] } } } } },
    });
    expect(reviewed.receipt).toBeNull();
    expect(engineExecutions(slug)).toHaveLength(1);
    await expect(continueReviewed(slug, seed.id, session, before)).rejects.toThrow("This revision is no longer ready.");
    await continueReviewed(slug, seed.id, session, after);
    await tickGraphs();
    await tickGraphs();
    expect(engineExecutions(slug).map((e) => [e.step, e.status])).toEqual([["seed", "done"], ["sum", "live"], ["product", "live"]]);
  } finally {
    resetGraphs();
  }
});

test("an idle reply cannot revive a superseded review or mark missing output ready", async () => {
  const slug = "queued-review";
  const { repo } = fixture(slug, []);
  let answered = "";
  resetGraphs();
  prepareGraphs(repo, {
    open: async () => {}, status: async () => ({ kind: "idle" }), send: async () => {}, stop: async () => {}, bind() {},
    reviewFollowUpFinished: async (_id, requestId) => answered === requestId,
  });
  try {
    await tickGraphs();
    const [seed] = engineExecutions(slug);
    const session = seed.sessionId!;
    const artifact = join(seed.outDir, "numbers.md");
    writeFileSync(artifact, "42");
    answered = "before-first-review";
    await submitSessionWork(slug, session, async () => {}, undefined, answered);
    await tickGraphs();
    expect(seed.ready).toBeUndefined();
    expect((await completeSession(session))?.outcome).toBe("ready_for_review");

    await submitSessionWork(slug, session, async () => {}, undefined, "first");
    await submitSessionWork(slug, session, async () => {}, undefined, "second");
    answered = "first";
    await tickGraphs();
    expect(seed.ready).toBeUndefined();
    unlinkSync(artifact);
    answered = "second";
    await tickGraphs();
    expect(seed.ready).toBeUndefined();
    expect(seed.receipt).toBeNull();
    expect(engineExecutions(slug)).toHaveLength(1);
  } finally {
    resetGraphs();
  }
});

test("the feed retains the execution and refreshes its refusal when the task playbook changes", async () => {
  const { repo, dir } = fixture("repair");
  const path = join(dir, "playbook.md");
  const source = readFileSync(path, "utf8");
  const state = fold([
    { t: "reserved", execution: { id: "e1", step: "seed", depth: 1, inputs: {}, outDir: join(dir, "artifacts", "1-seed-1"), origin: null, automatic: true } },
    { t: "started", execId: "e1", sessionId: "working" },
  ]);
  await saveEngineState(repo, "repair", state);
  const outputs = [{ selector: "numbers.md", relative_path: "1-seed-1/numbers.md", discriminator: 0 }];
  const saved = () => JSON.parse(readFileSync(join(dir, "execution.json"), "utf8")).executions.e1.outputs;
  expect(saved()).toEqual(outputs);
  const parser = executionParser(repo, "lane", "id");
  parsers.push(parser);
  try {
    const store = new Store();
    const alinery = join(repo, ".alinery");
    const feed = new Feed(store, alinery, undefined, new BoardProjector(store, alinery).dependents);
    const row = () => {
      const e = store.get(executionKey("repair"))!;
      const result = fromBinary(EntitySchema, toBinary(EntitySchema, e)).value;
      if (result.case !== "execution") throw new Error("expected execution");
      return result.value;
    };
    await feed.scan();
    expect(row().definition?.key).toBe("fork-join");
    for (const [change, expected] of [
      [() => unlinkSync(path), /playbook\.md could not be read/],
      [() => writeFileSync(path, "invalid source"), /Invalid task playbook\.md: .+/],
    ] as const) {
      change();
      await feed.refresh("tasks/repair/playbook.md");
      expect(row().definition).toBeUndefined();
      expect(row().state?.enabled_steps).toEqual(KEYS);
      expect(row().state?.executions).toMatchObject({ e1: { outputs } });
      expect(row().state?.engine_unavailable).toMatch(expected);
      expect(getTaskExecution(repo, "repair", "lane", "id").error).toMatch(expected);
      await saveEngineState(repo, "repair", state);
      expect(saved()).toEqual(outputs);
    }
    writeFileSync(path, source);
    await feed.refresh("tasks/repair/playbook.md");
    expect(row().state?.engine_unavailable).toBeUndefined();
    expect(row().definition?.key).toBe("fork-join");
  } finally {
    parsers.splice(parsers.indexOf(parser), 1);
  }
});
