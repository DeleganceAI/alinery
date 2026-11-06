import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { RepoService, SettingsService } from "alinery-proto/alinery/v1/settings_pb";
import { JobRunner } from "../jobs/runner.ts";
import type { TelemetryEvent } from "../platform/telemetry.ts";
import { Feed } from "../sync/feed.ts";
import { parsers } from "../sync/parsers/index.ts";
import { settingsParser } from "../sync/parsers/settings.ts";
import { Store } from "../sync/store.ts";
import { settingsKey } from "../domain/settings.ts";
import { readInference } from "../provider.ts";
import { serveRpc } from "./server.ts";

const SECRET = "ab".repeat(32);
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

async function start(hostExecutable: string | undefined = process.execPath) {
  const dir = mkdtempSync("/tmp/rpc-s-");
  const repo = join(dir, "repo");
  const alinery = join(repo, ".alinery");
  mkdirSync(alinery, { recursive: true });
  const appConfig = join(dir, "app.toml");
  const store = new Store({ coalesceMs: 1 });
  const parser = settingsParser(alinery, appConfig);
  parsers.push(parser);
  const feed = new Feed(store, alinery, (e) => e, () => [], { "app.toml": appConfig });
  const events: TelemetryEvent[] = [];
  const socketPath = join(dir, "rpc.sock");
  const info = { protocol: 26, buildId: "b", repoRoot: repo, appConfigIdentity: "i" };
  const settings = { repo, appConfig, refresh: (rel: string) => feed.refresh(rel), telemetry: { record: (build: () => TelemetryEvent) => void events.push(build()) } };
  const net = await serveRpc({ socketPath, secret: Buffer.from(SECRET), hostExecutable, info, lifecycle: { stop: () => 0, exit: () => {} }, store, jobs: new JobRunner(store), storageScan: { mode: "error" } as never, transcripts: async () => undefined, settings });
  cleanup.push(() => {
    net.close();
    parsers.splice(parsers.indexOf(parser), 1);
    rmSync(dir, { recursive: true, force: true });
  });
  const transport = (header?: string) =>
    createGrpcTransport({
      baseUrl: "http://daemon",
      nodeOptions: { createConnection: () => connect(socketPath) } as never,
      interceptors: [(next) => (req) => (header ? (req.header.set("authorization", header), next(req)) : next(req))],
    });
  const auth = `Bearer ${SECRET}`;
  await feed.scan();
  return {
    dir,
    repo,
    alinery,
    store,
    events,
    feed,
    settings: (header: string | null = auth) => createClient(SettingsService, transport(header ?? undefined)),
    repoSvc: (header: string | null = auth) => createClient(RepoService, transport(header ?? undefined)),
  };
}

const meta = (id: string) => ({ clientId: "c1", mutationId: id });
const code = async (call: Promise<unknown>) => ConnectError.from(await call.then(() => null, (e) => e)).code;
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const revision = (store: Store) => store.get(settingsKey)!.revision;
const model = (store: Store) => {
  const e = store.get(settingsKey)!;
  return e.value.case === "settings" ? e.value.value.overrides?.defaults?.model : undefined;
};

test("WriteOverrides writes the file, moves the row, and the reply cursor already covers it", async () => {
  const { settings, alinery, store, events } = await start();
  const before = revision(store);
  const res = await settings().writeOverrides({ meta: meta("m1"), overrides: { defaults: { model: "gpt-5" } } });
  expect(readFileSync(join(alinery, "config.toml"), "utf8")).toBe('[github]\n\n[defaults]\nmodel = "gpt-5"\n\n[backup]\n');
  expect(model(store)).toBe("gpt-5");
  expect(revision(store)).toBeGreaterThan(before);
  expect(res.applied?.cursor?.seq).toBe(store.cursor().seq);
  expect(events).toEqual([{ event: "settings.change", source: "alineryd", scope: "repo" }]);
});

test("a stale expected_revision is ABORTED and leaves the file byte for byte", async () => {
  const { settings, alinery, store, events } = await start();
  await settings().writeOverrides({ meta: meta("m1"), overrides: { defaults: { model: "a" } } });
  const file = join(alinery, "config.toml");
  const stale = revision(store) - 1n;
  const was = sha(file);
  expect(await code(settings().writeOverrides({ meta: meta("m2"), overrides: { defaults: { model: "b" } }, expectedRevision: stale }))).toBe(Code.Aborted);
  expect(await code(settings().clearOverride({ meta: meta("m3"), field: "defaults.model", expectedRevision: stale }))).toBe(Code.Aborted);
  expect(sha(file)).toBe(was);
  expect(events.length).toBe(1);
  // The current revision goes through, and 0 means no check.
  await settings().writeOverrides({ meta: meta("m4"), overrides: { defaults: { model: "c" } }, expectedRevision: revision(store) });
  await settings().writeOverrides({ meta: meta("m5"), overrides: { defaults: { model: "d" } }, expectedRevision: 0n });
  expect(model(store)).toBe("d");
});

test("an edit made on disk is seen before the revision is compared", async () => {
  const { settings, alinery, store } = await start();
  await settings().writeOverrides({ meta: meta("m1"), overrides: { defaults: { model: "a" } } });
  const seen = revision(store);
  writeFileSync(join(alinery, "config.toml"), '[defaults]\nmodel = "by hand"\n'); // before the watcher has looked
  expect(await code(settings().writeOverrides({ meta: meta("m2"), overrides: {}, expectedRevision: seen }))).toBe(Code.Aborted);
  expect(readFileSync(join(alinery, "config.toml"), "utf8")).toContain("by hand");
});

test("ClearOverride clears one field; an unknown field and a refused file are refused", async () => {
  const { settings, alinery, store } = await start();
  await settings().writeOverrides({ meta: meta("m1"), overrides: { defaults: { model: "m", harness: "omp", thinking: "high" } } });
  await settings().clearOverride({ meta: meta("m2"), field: "defaults.model" });
  const row = store.get(settingsKey)!;
  const overrides = row.value.case === "settings" ? row.value.value.overrides : undefined;
  expect(overrides?.defaults).toMatchObject({ thinking: "high" });
  expect(overrides?.defaults?.model).toBeUndefined();
  expect(overrides?.defaults?.harness).toBeUndefined();
  expect(await code(settings().clearOverride({ meta: meta("m3"), field: "defaults.nonsense" }))).toBe(Code.InvalidArgument);
  writeFileSync(join(alinery, "config.toml"), "[defaults]\nmodel = 1\n");
  expect(await code(settings().clearOverride({ meta: meta("m4"), field: "defaults.model" }))).toBe(Code.FailedPrecondition);
  expect(readFileSync(join(alinery, "config.toml"), "utf8")).toBe("[defaults]\nmodel = 1\n");
  // A whole-file write replaces a refused file.
  await settings().writeOverrides({ meta: meta("m5"), overrides: { defaults: { model: "ok" } } });
  expect(model(store)).toBe("ok");
});

test("capabilities: no token is refused, a local non-shell peer may write but not EnsureReady", async () => {
  const anon = await start();
  expect(await code(anon.settings(null).writeOverrides({ meta: meta("m1"), overrides: {} }))).toBe(Code.Unauthenticated);
  expect(await code(anon.repoSvc(null).ensureReady({ meta: meta("m1") }))).toBe(Code.Unauthenticated);
  const other = await start("/bin/not-the-shell");
  await other.settings().writeOverrides({ meta: meta("m1"), overrides: { defaults: { model: "x" } } });
  expect(await code(other.repoSvc().ensureReady({ meta: meta("m2") }))).toBe(Code.PermissionDenied);
});

test("a repeated mutation id writes once and answers the same; a missing one is refused", async () => {
  const { settings, store, events } = await start();
  await settings().writeOverrides({ meta: meta("same"), overrides: { defaults: { model: "first" } } });
  await settings().writeOverrides({ meta: meta("same"), overrides: { defaults: { model: "second" } } });
  expect(model(store)).toBe("first");
  expect(events.length).toBe(1);
  expect(await code(settings().writeOverrides({ overrides: {} }))).toBe(Code.InvalidArgument);
});

test("EnsureReady creates what is missing, and a second call changes nothing", async () => {
  const { repoSvc, repo, alinery, store } = await start();
  const res = await repoSvc().ensureReady({ meta: meta("e1") });
  for (const f of ["config.toml", "harnesses.toml"]) expect(existsSync(join(alinery, f))).toBe(true);
  expect(readFileSync(join(repo, ".gitignore"), "utf8")).toContain("/.alinery/");
  expect(res.applied?.cursor?.seq).toBe(store.cursor().seq);
  const mtimes = ["config.toml", "harnesses.toml"].map((f) => statSync(join(alinery, f)).mtimeMs);
  const ignore = statSync(join(repo, ".gitignore")).mtimeMs;
  const seq = store.cursor().seq;
  await Bun.sleep(20);
  await repoSvc().ensureReady({ meta: meta("e2") });
  expect(["config.toml", "harnesses.toml"].map((f) => statSync(join(alinery, f)).mtimeMs)).toEqual(mtimes);
  expect(statSync(join(repo, ".gitignore")).mtimeMs).toBe(ignore);
  expect(store.cursor().seq).toBe(seq);
});

const inference = (token: string) => JSON.stringify({ token, expires_at: 4102444800, session_id: "s", minted_at: 1, catalog: { provider: "alinery", default_model: "m", base_url: "https://x/v1", plans_url: "", models: [{ id: "m", name: "M", context_window: 1, max_tokens: 1, thinking: { levels: ["low"] } }] } });

test("WriteHostedInference writes inference.json owner-only beside the app config, byte for byte, and a later write replaces it", async () => {
  const { settings, dir } = await start();
  const file = join(dir, "inference.json");
  await settings().writeHostedInference({ meta: meta("h1"), inferenceJson: inference("inf_one") });
  expect(readFileSync(file, "utf8")).toBe(inference("inf_one"));
  expect(statSync(file).mode & 0o777).toBe(0o600);
  await settings().writeHostedInference({ meta: meta("h2"), inferenceJson: inference("inf_two") });
  expect(readFileSync(file, "utf8")).toBe(inference("inf_two"));
  // The daemon's own provider reads what was written.
  expect(readInference(join(dir, "app.toml"))?.token).toBe("inf_two");
});

test("WriteHostedInference refuses a body the provider could not use, and leaves the good file alone", async () => {
  const { settings, dir } = await start();
  const file = join(dir, "inference.json");
  await settings().writeHostedInference({ meta: meta("h1"), inferenceJson: inference("inf_good") });
  for (const [i, bad] of ["not json", "{}", JSON.stringify({ token: "", expires_at: 1, catalog: { base_url: "u", models: [] } }), JSON.stringify({ token: "t", expires_at: "1", catalog: { base_url: "u", models: [] } }), JSON.stringify({ token: "t", expires_at: 1, catalog: { base_url: "u" } })].entries())
    expect(await code(settings().writeHostedInference({ meta: meta(`b${i}`), inferenceJson: bad }))).toBe(Code.InvalidArgument);
  expect(readFileSync(file, "utf8")).toBe(inference("inf_good"));
});

test("WriteHostedInference is ADMIN: a token-less caller and a local non-shell peer (VIEW, ACT) are refused and nothing is written", async () => {
  const anon = await start();
  expect(await code(anon.settings(null).writeHostedInference({ meta: meta("h1"), inferenceJson: inference("t") }))).toBe(Code.Unauthenticated);
  const other = await start("/bin/not-the-shell");
  expect(await code(other.settings().writeHostedInference({ meta: meta("h2"), inferenceJson: inference("t") }))).toBe(Code.PermissionDenied);
  expect(existsSync(join(other.dir, "inference.json"))).toBe(false);
  expect(existsSync(join(anon.dir, "inference.json"))).toBe(false);
});
