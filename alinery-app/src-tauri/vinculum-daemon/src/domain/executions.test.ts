import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "bun:test";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { EntitySchema } from "alinery-proto/alinery/v1/entities_pb";
import { Engine } from "playbook-engine/src/engine.ts";
import { parsePlaybookMd } from "playbook-engine/src/playbook-md.ts";
import { complete, FakeHarness } from "playbook-engine/test/fake-harness.ts";
import { forgetTask, prepareGraphs, resetGraphs, tickGraphs } from "../graph.ts";
import { Replica, taskScope } from "../sync/testkit.ts";
import { Store } from "../sync/store.ts";
import { getTaskExecution } from "../tasks.ts";
import { commitExecution, executionEntity, executionKey, executionParser } from "./executions.ts";
import { loadEngineState, saveEngineState } from "./executionStore.ts";
import { Feed } from "../sync/feed.ts";
import { parsers } from "../sync/parsers/index.ts";

// A four-step fork and join, the shape of the retired parallel-numbers playbook: seed, then sum and
// product side by side, then combine.
const step = (key: string, inputs: string[], output: string) =>
  `[[step]]\nkey = "${key}"\ntitle = "${key}"\nshort = ""\ninputs = [${inputs.map((p) => `{ path = "${p}", mode = "single" }`).join(", ")}]\noutputs = [{ path = "${output}" }]\nmodel = ""\nharness = ""\nis_coding_step = false\nauto_advance_default = true`;
const STEPS = [step("seed", ["ticket.md"], "numbers.md"), step("sum", ["numbers.md"], "sum.md"), step("product", ["numbers.md"], "product.md"), step("combine", ["sum.md", "product.md"], "final.md")];
const KEYS = ["seed", "sum", "product", "combine"];

function fixture(slug: string) {
  const repo = mkdtempSync(join(tmpdir(), "vinculum-exec-"));
  const dir = join(repo, ".alinery", "tasks", slug);
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(join(dir, "artifacts", "ticket.md"), "the task");
  const sections = KEYS.map((k) => `<!-- alinery:step ${k} -->\nDo ${k}.\n`).join("\n");
  writeFileSync(join(dir, "playbook.md"), `+++\nversion = 2\nkey = "fork-join"\ntitle = "Fork join"\ndescription = ""\ndefault_model = ""\ndefault_harness = "omp"\n\n${STEPS.join("\n")}\n+++\n${sections}\n`);
  writeFileSync(join(dir, "task.md"), `name = "Fork join"\nworktree = ${JSON.stringify(repo)}\nhas_worktree = true\n`);
  writeFileSync(join(dir, "execution.json"), JSON.stringify({ creation: "ready", initial_start_requested: true, max_live_sessions: 10, enabled_steps: KEYS, auto_approve_all: false }));
  return { repo, dir };
}

async function settle(engine: Engine) {
  for (let quiet = 0, i = 0; quiet < 2; i++) {
    if (i > 200) throw new Error("did not settle");
    await engine.tick();
    await Bun.sleep(0);
    await Bun.sleep(0);
    const busy = [...engine.state.executions.values()].some((e) => ["reserved", "live", "finishing"].includes(e.status));
    quiet = busy ? 0 : quiet + 1;
  }
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
