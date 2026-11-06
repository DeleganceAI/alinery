// PlaybookService (plan S4.6): the rows, the reads, the writes with `expected_revision` (a stale one is ABORTED and changes nothing), two
// saves racing for one revision, the tagged errors the frontend reads back, and the watcher making an outside edit visible.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { create } from "@bufbuild/protobuf";
import { ErrorDetailSchema } from "alinery-proto/alinery/v1/common_pb";
import { PlaybookService } from "alinery-proto/alinery/v1/playbooks_pb";
import { ScopeSchema } from "alinery-proto/alinery/v1/sync_pb";
import { parsePlaybookDocument, renderPlaybookMd } from "playbook-engine/src/playbook-md.ts";
import { BUNDLED_PLAYBOOKS } from "../domain/bundledPlaybooks.ts";
import { BlobStore } from "../domain/blobs.ts";
import { GLOBAL_PICKER_KEY, LIBRARY_KEY, PICKER_KEY, PlaybookProjector, playbookKey } from "../domain/playbookProjector.ts";
import { JobRunner } from "../jobs/runner.ts";
import { Store } from "../sync/store.ts";
import { Watcher } from "../sync/watcher.ts";
import { serveRpc } from "./server.ts";

const SECRET = "ab".repeat(32);
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

/** A playbook as `renderPlaybookMd` writes it (the library saves the canonical form). */
const PLAYBOOK = (key: string, title = "Mine") => renderPlaybookMd(parsePlaybookDocument(HAND(key, title)).document!);
const HAND = (key: string, title: string) =>
  `+++\nversion = 2\nkey = "${key}"\ntitle = "${title}"\ndescription = ""\ndefault_model = ""\ndefault_harness = ""\n[[step]]\nkey = "run"\ntitle = "Run"\nshort = ""\nis_coding_step = false\nauto_advance_default = false\ninputs = [{path = "ticket.md", mode = "single"}]\noutputs = [{path = "result.md"}]\nmodel = ""\nharness = ""\n+++\nPreamble\n<!-- alinery:step run -->\nRead {{TICKET_FILE}}.\n`;

async function start() {
  const dir = mkdtempSync("/tmp/rpc-pb-");
  const repo = join(dir, "repo");
  const alinery = join(repo, ".alinery");
  mkdirSync(alinery, { recursive: true });
  const appConfig = join(dir, "app.toml");
  writeFileSync(appConfig, "");
  const store = new Store({ coalesceMs: 1 });
  const projector = new PlaybookProjector(store, { globalConfigDir: dir, repoDir: repo }, () => {}, 5);
  projector.refresh();
  const socketPath = join(dir, "rpc.sock");
  const info = { protocol: 31, buildId: "b", repoRoot: repo, appConfigIdentity: "i" };
  const net = await serveRpc({
    socketPath,
    secret: Buffer.from(SECRET),
    hostExecutable: process.execPath,
    info,
    lifecycle: { stop: () => 0, exit: () => {} },
    store,
    jobs: new JobRunner(store),
    storageScan: { mode: "error" } as never,
    transcripts: async () => undefined,
    playbooks: { repo, appConfig, projector, blobs: new BlobStore(repo) },
  });
  cleanup.push(() => {
    net.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const transport = createGrpcTransport({ baseUrl: "http://daemon", nodeOptions: { createConnection: () => connect(socketPath) } as never, interceptors: [(next) => (req) => (req.header.set("authorization", `Bearer ${SECRET}`), next(req))] });
  return { dir, repo, store, projector, svc: createClient(PlaybookService, transport) };
}

let n = 0;
const meta = () => ({ clientId: "c1", mutationId: `m${++n}` });
const failure = async (call: Promise<unknown>) => ConnectError.from(await call.then(() => null, (e) => e));
const taggedError = (e: ConnectError) => JSON.parse(e.findDetails(ErrorDetailSchema)[0]!.fields.error!);
const revision = (store: Store, key: string) => store.get(key)?.revision;

test("the rows are the bundled set, the global and repo definitions, and the three library rows", async () => {
  const { store, dir, repo, projector } = await start();
  const keys = [...store.rowsMatching(create(ScopeSchema, { kind: { case: "repo", value: {} } }))].map((e) => e.key);
  expect(keys.filter((k) => k.startsWith("playbook/bundled/")).length).toBe(BUNDLED_PLAYBOOKS.length);
  expect(keys).toContain(PICKER_KEY);
  expect(keys).toContain(GLOBAL_PICKER_KEY);
  expect(keys).toContain(LIBRARY_KEY);
  mkdirSync(join(dir, "playbooks/mine"), { recursive: true });
  writeFileSync(join(dir, "playbooks/mine/playbook.md"), PLAYBOOK("mine"));
  mkdirSync(join(repo, ".alinery/playbooks/broken"), { recursive: true });
  writeFileSync(join(repo, ".alinery/playbooks/broken/playbook.md"), "nope");
  projector.refresh();
  const mine = store.get(playbookKey("global", "mine"))!;
  expect(mine.value.case === "playbook" && mine.value.value.title).toBe("Mine");
  const broken = store.get(playbookKey("repo", "broken"))!;
  expect(broken.value.case === "playbook" && broken.value.value.diagnostics.length).toBeGreaterThan(0);
});

test("ReadPlaybook returns the whole definition; unknown is NOT_FOUND with the tagged error", async () => {
  const { svc } = await start();
  const found = await svc.readPlaybook({ reference: { scope: "bundled", key: "superdevelop" } });
  expect(found.definition?.step.map((s) => s.key)).toContain("research");
  expect(found.sourceText).toContain("+++");
  const e = await failure(svc.readPlaybook({ reference: { scope: "global", key: "missing" } }));
  expect(e.code).toBe(Code.NotFound);
  expect(taggedError(e)).toMatchObject({ kind: "unknown", source: { reference: { scope: "global", key: "missing" } } });
  expect((await failure(svc.readPlaybook({ reference: { scope: "elsewhere", key: "x" } }))).code).toBe(Code.InvalidArgument);
});

test("Validate and Render are computed answers that agree with each other", async () => {
  const { svc } = await start();
  const ok = await svc.validatePlaybook({ source: PLAYBOOK("t") });
  expect(ok.diagnostics).toEqual([]);
  const bad = await svc.validatePlaybook({ source: PLAYBOOK("t").replace("version = 2", "version = 2\ntypo = 1") });
  expect(bad.definition).toBeUndefined();
  expect(bad.diagnostics[0]).toMatchObject({ code: "unknown_field", field: "typo" });
  const rendered = await svc.renderPlaybook({ definition: ok.definition });
  expect(rendered.source).toBe(PLAYBOOK("t"));
});

test("SavePlaybook writes the file and the row, and the reply's cursor covers it", async () => {
  const { svc, store, repo } = await start();
  const key = playbookKey("repo", "mine");
  const res = await svc.savePlaybook({ meta: meta(), target: { scope: "repo", key: "mine" }, source: PLAYBOOK("mine") });
  expect(readFileSync(join(repo, ".alinery/playbooks/mine/playbook.md"), "utf8")).toBe(PLAYBOOK("mine"));
  expect(store.get(key)).toBeDefined();
  expect(res.applied?.cursor?.seq).toBe(store.cursor().seq);
  expect(res.saved?.definition?.title).toBe("Mine");
});

test("a stale expected_revision is ABORTED and changes nothing; the current one and 0 go through", async () => {
  const { svc, store, repo } = await start();
  const key = playbookKey("repo", "mine");
  const file = join(repo, ".alinery/playbooks/mine/playbook.md");
  await svc.savePlaybook({ meta: meta(), target: { scope: "repo", key: "mine" }, source: PLAYBOOK("mine", "One") });
  const first = revision(store, key)!;
  await svc.savePlaybook({ meta: meta(), target: { scope: "repo", key: "mine" }, source: PLAYBOOK("mine", "Two"), overwrite: true, expectedRevision: first });
  const was = readFileSync(file, "utf8");
  const stale = await failure(svc.savePlaybook({ meta: meta(), target: { scope: "repo", key: "mine" }, source: PLAYBOOK("mine", "Three"), overwrite: true, expectedRevision: first }));
  expect(stale.code).toBe(Code.Aborted);
  expect(readFileSync(file, "utf8")).toBe(was);
  expect((await failure(svc.deletePlaybook({ meta: meta(), reference: { scope: "repo", key: "mine" }, expectedRevision: first }))).code).toBe(Code.Aborted);
  expect(existsSync(file)).toBe(true);
  await svc.savePlaybook({ meta: meta(), target: { scope: "repo", key: "mine" }, source: PLAYBOOK("mine", "Four"), overwrite: true, expectedRevision: 0n });
  expect(readFileSync(file, "utf8")).toContain("Four");
});

test("an edit made on disk is seen before the revision is compared", async () => {
  const { svc, store, repo } = await start();
  const key = playbookKey("repo", "mine");
  await svc.savePlaybook({ meta: meta(), target: { scope: "repo", key: "mine" }, source: PLAYBOOK("mine", "One") });
  const seen = revision(store, key)!;
  writeFileSync(join(repo, ".alinery/playbooks/mine/playbook.md"), PLAYBOOK("mine", "By hand")); // before the watcher has looked
  const e = await failure(svc.savePlaybook({ meta: meta(), target: { scope: "repo", key: "mine" }, source: PLAYBOOK("mine", "Mine"), overwrite: true, expectedRevision: seen }));
  expect(e.code).toBe(Code.Aborted);
  expect(readFileSync(join(repo, ".alinery/playbooks/mine/playbook.md"), "utf8")).toContain("By hand");
});

test("two saves of one revision: one wins, the other is ABORTED", async () => {
  const { svc, store, repo } = await start();
  const key = playbookKey("repo", "race");
  await svc.savePlaybook({ meta: meta(), target: { scope: "repo", key: "race" }, source: PLAYBOOK("race", "Start") });
  const seen = revision(store, key)!;
  const results = await Promise.allSettled(
    ["A", "B"].map((title) => svc.savePlaybook({ meta: meta(), target: { scope: "repo", key: "race" }, source: PLAYBOOK("race", title), overwrite: true, expectedRevision: seen })),
  );
  expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
  const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  expect(ConnectError.from(lost.reason).code).toBe(Code.Aborted);
  const text = readFileSync(join(repo, ".alinery/playbooks/race/playbook.md"), "utf8");
  expect(text.includes('title = "A"') !== text.includes('title = "B"')).toBe(true);
});

test("a retried mutation is answered once", async () => {
  const { svc, repo } = await start();
  const m = meta();
  const request = { meta: m, target: { scope: "repo", key: "again" }, source: PLAYBOOK("again") };
  const a = await svc.savePlaybook(request);
  rmSync(join(repo, ".alinery/playbooks/again"), { recursive: true });
  const b = await svc.savePlaybook(request);
  expect(b.applied?.cursor?.seq).toBe(a.applied?.cursor?.seq);
  expect(existsSync(join(repo, ".alinery/playbooks/again"))).toBe(false); // the retry was not run a second time
});

test("the tagged errors: bundled is read-only, a bad file is invalid with its diagnostics, a taken key is a conflict", async () => {
  const { svc } = await start();
  const readOnly = await failure(svc.savePlaybook({ meta: meta(), target: { scope: "bundled", key: "superdevelop" }, source: PLAYBOOK("superdevelop") }));
  expect(readOnly.code).toBe(Code.PermissionDenied);
  expect(taggedError(readOnly).kind).toBe("read_only");
  const invalid = await failure(svc.savePlaybook({ meta: meta(), target: { scope: "global", key: "x" }, source: PLAYBOOK("y") }));
  expect(invalid.code).toBe(Code.InvalidArgument);
  expect(taggedError(invalid)).toMatchObject({ kind: "invalid", diagnostics: [{ code: "storage_key_mismatch" }] });
  await svc.savePlaybook({ meta: meta(), target: { scope: "global", key: "x" }, source: PLAYBOOK("x") });
  const taken = await failure(svc.savePlaybook({ meta: meta(), target: { scope: "global", key: "x" }, source: PLAYBOOK("x") }));
  expect(taken.code).toBe(Code.AlreadyExists);
  expect(taggedError(taken).kind).toBe("conflict");
});

test("delete removes the file and the row; a bundled playbook is hidden by a tombstone", async () => {
  const { svc, store, repo, dir } = await start();
  await svc.savePlaybook({ meta: meta(), target: { scope: "repo", key: "gone" }, source: PLAYBOOK("gone") });
  await svc.deletePlaybook({ meta: meta(), reference: { scope: "repo", key: "gone" } });
  expect(existsSync(join(repo, ".alinery/playbooks/gone/playbook.md"))).toBe(false);
  expect(store.get(playbookKey("repo", "gone"))).toBeUndefined();
  await svc.deletePlaybook({ meta: meta(), reference: { scope: "bundled", key: "one-shot" } });
  expect(existsSync(join(dir, "playbooks/.deleted-bundled-one-shot"))).toBe(true);
  expect(store.get(playbookKey("bundled", "one-shot"))).toBeUndefined();
  expect((await failure(svc.readPlaybook({ reference: { scope: "bundled", key: "one-shot" } }))).code).toBe(Code.NotFound);
});

test("the picker is the repository's file, or the global one; a stale revision is ABORTED", async () => {
  const { svc, store, repo, dir } = await start();
  const entry = { reference: { scope: "bundled", key: "one-shot" }, preferred: true };
  await svc.savePicker({ meta: meta(), global: false, order: [{ scope: "bundled", key: "one-shot" }], entries: [entry] });
  expect(existsSync(join(repo, ".alinery/playbooks/picker.toml"))).toBe(true);
  expect(existsSync(join(dir, "playbooks/picker.toml"))).toBe(false);
  const row = store.get(PICKER_KEY)!;
  expect(row.value.case === "playbookPicker" && row.value.value.entries[0]?.preferred).toBe(true);
  await svc.savePicker({ meta: meta(), global: true, order: [], entries: [] });
  expect(existsSync(join(dir, "playbooks/picker.toml"))).toBe(true);
  const stale = revision(store, PICKER_KEY)! - 1n;
  expect((await failure(svc.savePicker({ meta: meta(), global: false, order: [], entries: [], expectedRevision: stale }))).code).toBe(Code.Aborted);
  const duplicate = await failure(svc.savePicker({ meta: meta(), global: false, order: [{ scope: "bundled", key: "a" }, { scope: "bundled", key: "a" }], entries: [] }));
  expect(taggedError(duplicate).kind).toBe("io");
});

test("the watcher makes an outside edit of any of the three directories a row change", async () => {
  const { store, projector, dir, repo } = await start();
  const seen: string[] = [];
  const watcher = new Watcher(
    join(repo, ".alinery"),
    (rel) => {
      seen.push(rel);
      projector.changed(rel);
    },
    { debounceMs: 5, globalPlaybooks: join(dir, "playbooks") },
  );
  mkdirSync(join(dir, "playbooks/outside"), { recursive: true });
  mkdirSync(join(repo, ".alinery/playbooks"), { recursive: true });
  mkdirSync(join(repo, "alinery/playbooks"), { recursive: true });
  watcher.start();
  cleanup.push(() => watcher.stop());
  writeFileSync(join(dir, "playbooks/outside/playbook.md"), PLAYBOOK("outside"));
  writeFileSync(join(repo, "alinery/playbooks/committed.md"), PLAYBOOK("committed"));
  const until = async (key: string) => {
    for (let i = 0; i < 100 && !store.get(key); i++) await new Promise((r) => setTimeout(r, 20));
    return store.get(key);
  };
  expect(await until(playbookKey("global", "outside"))).toBeDefined();
  expect(await until(playbookKey("repo", "committed"))).toBeDefined();
  expect(seen.some((r) => r.startsWith("global-playbooks/"))).toBe(true);
  expect(seen.some((r) => r.startsWith("committed-playbooks/"))).toBe(true);
});
