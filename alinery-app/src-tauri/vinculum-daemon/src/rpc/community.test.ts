// The community import calls (plan S4.10): a package the shell downloaded and staged is written into the repository the daemon owns, the
// registry beside the playbooks records it, and `playbook/_/community` says what the local files look like now. The cases are the ones the
// app's `community_playbooks.rs` tests held for import, update and the registry (the HTTP half stays in the shell and keeps its own).
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { CommunityImportOutcome, PlaybookService } from "alinery-proto/alinery/v1/playbooks_pb";
import { parsePlaybookDocument, renderPlaybookMd } from "playbook-engine/src/playbook-md.ts";
import { BlobStore } from "../domain/blobs.ts";
import { COMMUNITY_KEY, PlaybookProjector } from "../domain/playbookProjector.ts";
import { JobRunner } from "../jobs/runner.ts";
import { Store } from "../sync/store.ts";
import { serveRpc } from "./server.ts";

const SECRET = "ab".repeat(32);
const ID = "11111111-2222-3333-4444-555555555555";
const ID2 = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const HAND = (key: string, title: string) =>
  `+++\nversion = 2\nkey = "${key}"\ntitle = "${title}"\ndescription = ""\ndefault_model = ""\ndefault_harness = ""\n[[step]]\nkey = "run"\ntitle = "Run"\nshort = ""\nis_coding_step = false\nauto_advance_default = false\ninputs = [{path = "ticket.md", mode = "single"}]\noutputs = [{path = "result.md"}]\nmodel = ""\nharness = ""\n+++\nPreamble\n<!-- alinery:step run -->\nRead {{TICKET_FILE}}.\n`;
const PLAYBOOK = (key: string, title = "Mine") => renderPlaybookMd(parsePlaybookDocument(HAND(key, title)).document!);
const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

async function start() {
  const dir = mkdtempSync("/tmp/rpc-community-");
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".alinery"), { recursive: true });
  const appConfig = join(dir, "app.toml");
  writeFileSync(appConfig, "");
  const store = new Store({ coalesceMs: 1 });
  const projector = new PlaybookProjector(store, { globalConfigDir: dir, repoDir: repo }, () => {}, 5);
  projector.refresh();
  const blobs = new BlobStore(repo);
  const socketPath = join(dir, "rpc.sock");
  const net = await serveRpc({
    socketPath,
    secret: Buffer.from(SECRET),
    hostExecutable: process.execPath,
    info: { protocol: 35, buildId: "b", repoRoot: repo, appConfigIdentity: "i" },
    lifecycle: { stop: () => 0, exit: () => {} },
    store,
    jobs: new JobRunner(store),
    storageScan: { mode: "error" } as never,
    transcripts: async () => undefined,
    playbooks: { repo, appConfig, projector, blobs },
  });
  cleanup.push(() => {
    net.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const transport = createGrpcTransport({ baseUrl: "http://daemon", nodeOptions: { createConnection: () => connect(socketPath) } as never, interceptors: [(next) => (req) => (req.header.set("authorization", `Bearer ${SECRET}`), next(req))] });
  const svc = createClient(PlaybookService, transport);
  let n = 0;
  const meta = () => ({ clientId: "c1", mutationId: `m${++n}` });
  /** What the shell does: stage the document as a `staged` upload and name it. */
  const stage = async (document: string, version = 1, label = "demo") => {
    const bytes = new TextEncoder().encode(document);
    const begun = blobs.begin({ kind: "staged", name: "package.md" }, bytes.length, sha(bytes));
    blobs.chunk(begun.uploadId, 0, bytes);
    await blobs.commit(begun.uploadId);
    return { uploadId: begun.uploadId, version: BigInt(version), label, playbookKey: "mine" };
  };
  const importIt = async (id: string, document: string, overwrite = false, version = 1) => (await svc.importCommunityPlaybook({ meta: meta(), id, package: await stage(document, version), overwrite })).result!;
  const updateIt = async (id: string, document: string, overwriteEdited = false, version = 2) => (await svc.updateCommunityImport({ meta: meta(), id, package: await stage(document, version), overwriteEdited })).result!;
  const file = (key: string) => join(repo, ".alinery/playbooks", key, "playbook.md");
  const registry = () => readFileSync(join(repo, ".alinery/playbooks/community-imports.toml"), "utf8");
  const row = () => {
    projector.refresh();
    const e = store.get(COMMUNITY_KEY);
    return e?.value.case === "playbookCommunity" ? e.value.value : undefined;
  };
  return { dir, repo, store, blobs, svc, meta, stage, importIt, updateIt, file, registry, row };
}

const O = CommunityImportOutcome;

test("an import saves the playbook, records it, and the row says it is intact", async () => {
  const t = await start();
  const doc = PLAYBOOK("mine");
  const r = await t.importIt(ID, doc);
  expect(r.outcome).toBe(O.SAVED);
  expect(r.reference).toMatchObject({ scope: "repo", key: "mine" });
  expect(r.importedVersion).toBe(1n);
  expect(readFileSync(t.file("mine"), "utf8")).toBe(doc);
  expect(r.localSha256).toBe(sha(doc));
  // The registry file is the format the Rust writer used: an array of tables, the eight fields in order.
  expect(t.registry()).toMatch(/^\[\[import\]\]\nid = "1111[^"]*"\nlabel = "demo"\nplaybook_key = "mine"\nlocal_scope = "repo"\nlocal_key = "mine"\nimported_version = 1\nlocal_sha256 = "[0-9a-f]{64}"\nimported_at = "\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ"\n$/);
  const row = t.row()!;
  expect(row.error).toBe("");
  expect(row.imports.map((i) => [i.id, i.localKey, i.importedVersion, i.localMissing, i.locallyEdited])).toEqual([[ID, "mine", 1n, false, false]]);
});

test("the staged upload is released whatever the outcome", async () => {
  const t = await start();
  const pkg = await t.stage(PLAYBOOK("mine"));
  await t.svc.importCommunityPlaybook({ meta: t.meta(), id: ID, package: pkg, overwrite: false });
  expect(t.blobs.staged(pkg.uploadId)).toBeUndefined();
  const bad = await t.stage("not a playbook");
  expect((await t.svc.importCommunityPlaybook({ meta: t.meta(), id: ID2, package: bad, overwrite: false })).result!.outcome).toBe(O.INVALID);
  expect(t.blobs.staged(bad.uploadId)).toBeUndefined();
});

test("a body that is not a playbook is invalid and writes nothing; an id that is not a publication id is not found", async () => {
  const t = await start();
  const r = await t.importIt(ID, "# not a playbook\n");
  expect(r.outcome).toBe(O.INVALID);
  expect(r.diagnostics.length).toBeGreaterThan(0);
  expect(existsSync(join(t.repo, ".alinery/playbooks/community-imports.toml"))).toBe(false);
  const bad = await t.importIt("not-an-id", PLAYBOOK("mine"));
  expect([bad.outcome, bad.message]).toEqual([O.FAILED, "Playbook not found."]);
  expect(existsSync(t.file("mine"))).toBe(false);
});

test("a second import of the same publication is already downloaded", async () => {
  const t = await start();
  await t.importIt(ID, PLAYBOOK("mine"));
  expect((await t.importIt(ID, PLAYBOOK("mine", "Other"))).outcome).toBe(O.ALREADY_DOWNLOADED);
  expect(readFileSync(t.file("mine"), "utf8")).toBe(PLAYBOOK("mine"));
});

test("a playbook of that key already there is a conflict that writes nothing; overwrite replaces it and its record", async () => {
  const t = await start();
  mkdirSync(join(t.repo, ".alinery/playbooks/mine"), { recursive: true });
  writeFileSync(t.file("mine"), PLAYBOOK("mine", "Local"));
  const refused = await t.importIt(ID, PLAYBOOK("mine", "Remote"));
  expect([refused.outcome, refused.localKey]).toEqual([O.CONFLICT, "mine"]);
  expect(readFileSync(t.file("mine"), "utf8")).toBe(PLAYBOOK("mine", "Local"));
  expect(t.row()!.imports).toEqual([]);
  expect((await t.importIt(ID, PLAYBOOK("mine", "Remote"), true)).outcome).toBe(O.SAVED);
  expect(readFileSync(t.file("mine"), "utf8")).toBe(PLAYBOOK("mine", "Remote"));
  expect(t.row()!.imports.map((i) => i.id)).toEqual([ID]);
});

test("a second publication with the same key replaces the first record", async () => {
  const t = await start();
  await t.importIt(ID, PLAYBOOK("mine"));
  expect((await t.importIt(ID2, PLAYBOOK("mine", "Second"), true)).outcome).toBe(O.SAVED);
  expect(t.row()!.imports.map((i) => i.id)).toEqual([ID2]);
});

test("an update replaces an intact copy and bumps the version", async () => {
  const t = await start();
  await t.importIt(ID, PLAYBOOK("mine"));
  const r = await t.updateIt(ID, PLAYBOOK("mine", "Newer"), false, 5);
  expect([r.outcome, r.importedVersion]).toEqual([O.SAVED, 5n]);
  expect(readFileSync(t.file("mine"), "utf8")).toBe(PLAYBOOK("mine", "Newer"));
  expect(t.row()!.imports[0]).toMatchObject({ importedVersion: 5n, locallyEdited: false });
});

test("an edited copy is not replaced without the person's say; with it, it is", async () => {
  const t = await start();
  await t.importIt(ID, PLAYBOOK("mine"));
  writeFileSync(t.file("mine"), PLAYBOOK("mine", "My edit"));
  expect(t.row()!.imports[0]!.locallyEdited).toBe(true);
  expect((await t.updateIt(ID, PLAYBOOK("mine", "Newer"))).outcome).toBe(O.EDITED);
  expect(readFileSync(t.file("mine"), "utf8")).toBe(PLAYBOOK("mine", "My edit"));
  expect(t.row()!.imports[0]!.importedVersion).toBe(1n);
  expect((await t.updateIt(ID, PLAYBOOK("mine", "Newer"), true)).outcome).toBe(O.SAVED);
  expect(readFileSync(t.file("mine"), "utf8")).toBe(PLAYBOOK("mine", "Newer"));
});

test("a copy the person deleted is missing, not edited, and an update puts it back", async () => {
  const t = await start();
  await t.importIt(ID, PLAYBOOK("mine"));
  rmSync(t.file("mine"));
  expect(t.row()!.imports[0]).toMatchObject({ localMissing: true, locallyEdited: false });
  expect((await t.updateIt(ID, PLAYBOOK("mine", "Back"))).outcome).toBe(O.SAVED);
  expect(readFileSync(t.file("mine"), "utf8")).toBe(PLAYBOOK("mine", "Back"));
});

test("an invalid update keeps the version and the file; an update of a publication never imported is not found", async () => {
  const t = await start();
  await t.importIt(ID, PLAYBOOK("mine"));
  expect((await t.updateIt(ID, "nope", false, 9)).outcome).toBe(O.INVALID);
  expect(t.row()!.imports[0]!.importedVersion).toBe(1n);
  expect(readFileSync(t.file("mine"), "utf8")).toBe(PLAYBOOK("mine"));
  const none = await t.updateIt(ID2, PLAYBOOK("mine"));
  expect([none.outcome, none.message]).toEqual([O.FAILED, "Playbook not found."]);
});

test("a package named by an upload that was never made is refused", async () => {
  const t = await start();
  const err = ConnectError.from(await t.svc.importCommunityPlaybook({ meta: t.meta(), id: ID, package: { uploadId: "nope", version: 1n, label: "", playbookKey: "" }, overwrite: false }).then(() => null, (e) => e));
  expect(err.code).toBe(Code.InvalidArgument);
});

test("a retried import is answered once", async () => {
  const t = await start();
  const package_ = await t.stage(PLAYBOOK("mine"));
  const m = t.meta();
  const first = await t.svc.importCommunityPlaybook({ meta: m, id: ID, package: package_, overwrite: false });
  const again = await t.svc.importCommunityPlaybook({ meta: m, id: ID, package: package_, overwrite: false });
  expect(first.result!.outcome).toBe(O.SAVED);
  expect(again.result!.outcome).toBe(O.SAVED);
  expect(t.row()!.imports.length).toBe(1);
});

test("deleting a repo playbook forgets its import first; a registry that cannot be read stops the delete", async () => {
  const t = await start();
  await t.importIt(ID, PLAYBOOK("mine"));
  await t.svc.deletePlaybook({ meta: t.meta(), reference: { scope: "repo", key: "mine" }, expectedRevision: 0n });
  expect(existsSync(t.file("mine"))).toBe(false);
  expect(t.row()!.imports).toEqual([]);

  await t.importIt(ID2, PLAYBOOK("mine"));
  writeFileSync(join(t.repo, ".alinery/playbooks/community-imports.toml"), "not = [toml");
  const err = ConnectError.from(await t.svc.deletePlaybook({ meta: t.meta(), reference: { scope: "repo", key: "mine" }, expectedRevision: 0n }).then(() => null, (e) => e));
  expect(err.code).toBe(Code.Internal);
  expect(existsSync(t.file("mine"))).toBe(true);
  expect(t.row()!.error).toContain("invalid");
  expect(t.row()!.imports).toEqual([]);
});

test("a registry with a field it does not know is refused, not read past", async () => {
  const t = await start();
  mkdirSync(join(t.repo, ".alinery/playbooks"), { recursive: true });
  writeFileSync(join(t.repo, ".alinery/playbooks/community-imports.toml"), `[[import]]\nid = "${ID}"\nlabel = ""\nplaybook_key = "k"\nlocal_scope = "repo"\nlocal_key = "k"\nimported_version = 1\nlocal_sha256 = "x"\nimported_at = "t"\nextra = 1\n`);
  expect(t.row()!.error).toContain("invalid");
  const r = await t.importIt(ID2, PLAYBOOK("mine"));
  expect(r.outcome).toBe(O.FAILED);
  expect(existsSync(t.file("mine"))).toBe(false);
});

test("a save that expects the file as it was is a conflict when it changed meanwhile", async () => {
  const t = await start();
  const { savePlaybook } = await import("../domain/playbookLibrary.ts");
  const roots = { globalConfigDir: t.dir, repoDir: t.repo };
  const ref = { scope: "repo", key: "mine" } as const;
  await savePlaybook(roots, ref, PLAYBOOK("mine"), true, null);
  await expect(savePlaybook(roots, ref, PLAYBOOK("mine", "B"), true, null)).rejects.toMatchObject({ error: { kind: "conflict" } });
  writeFileSync(t.file("mine"), PLAYBOOK("mine", "Edited"));
  await expect(savePlaybook(roots, ref, PLAYBOOK("mine", "B"), true, Buffer.from(PLAYBOOK("mine")))).rejects.toMatchObject({ error: { kind: "conflict" } });
  await savePlaybook(roots, ref, PLAYBOOK("mine", "B"), true, Buffer.from(PLAYBOOK("mine", "Edited")));
  expect(readFileSync(t.file("mine"), "utf8")).toBe(PLAYBOOK("mine", "B"));
});
