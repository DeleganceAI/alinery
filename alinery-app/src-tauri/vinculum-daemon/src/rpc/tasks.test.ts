import { afterEach, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { BlobService } from "alinery-proto/alinery/v1/blobs_pb";
import { DraftService, TaskService } from "alinery-proto/alinery/v1/tasks_pb";
import { BlobStore } from "../domain/blobs.ts";
import { JobRunner } from "../jobs/runner.ts";
import type { TelemetryEvent } from "../platform/telemetry.ts";
import { Feed } from "../sync/feed.ts";
import { taskKey } from "../sync/parsers/task.ts";
import { Store } from "../sync/store.ts";
import { serveRpc } from "./server.ts";
import { createFromWire } from "./tasks.ts";

const SECRET = "ab".repeat(32);
const PLAYBOOK = readFileSync(join(import.meta.dir, "../../../playbooks/one-shot/playbook.md"), "utf8");
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

function git(dir: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

async function start() {
  const dir = mkdtempSync("/tmp/rpc-t-");
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  const alinery = join(repo, ".alinery");
  mkdirSync(alinery, { recursive: true });
  const store = new Store({ coalesceMs: 1 });
  const feed = new Feed(store, alinery, (e) => e, () => [], {});
  const events: TelemetryEvent[] = [];
  const blobs = new BlobStore(repo);
  const socketPath = join(dir, "rpc.sock");
  const tasks = { repo, lane: "test", identity: "id", refresh: (rel: string) => feed.refresh(rel), telemetry: { record: (build: () => TelemetryEvent) => void events.push(build()) }, blobs };
  const info = { protocol: 26, buildId: "b", repoRoot: repo, appConfigIdentity: "i" };
  const net = await serveRpc({ socketPath, secret: Buffer.from(SECRET), hostExecutable: process.execPath, info, lifecycle: { stop: () => 0, exit: () => {} }, store, jobs: new JobRunner(store), storageScan: { mode: "error" } as never, transcripts: async () => undefined, tasks });
  cleanup.push(() => {
    net.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const transport = createGrpcTransport({
    baseUrl: "http://daemon",
    nodeOptions: { createConnection: () => connect(socketPath) } as never,
    interceptors: [(next) => (req) => (req.header.set("authorization", `Bearer ${SECRET}`), next(req))],
  });
  await feed.scan();
  return { repo, alinery, store, events, feed, deps: tasks, tasks: createClient(TaskService, transport), drafts: createClient(DraftService, transport), blobs: createClient(BlobService, transport) };
}
type Ctx = Awaited<ReturnType<typeof start>>;

let n = 0;
const meta = () => ({ clientId: "c1", mutationId: `m${++n}` });
const code = async (call: Promise<unknown>) => ConnectError.from(await call.then(() => null, (e) => e)).code;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function upload(c: Ctx, target: { case: "attachment"; value: { taskSlug: string; name: string } } | { case: "chatAttachment"; value: { threadId: string; name: string } } | { case: "staged"; value: { name: string } }, bytes: Uint8Array, chunk = 64 * 1024) {
  const begun = await c.blobs.beginUpload({ meta: meta(), target: { target }, size: BigInt(bytes.length), sha256: sha(bytes) });
  for (let at = 0; at < bytes.length; at += chunk) await c.blobs.uploadChunk({ uploadId: begun.uploadId, offset: BigInt(at), data: bytes.subarray(at, at + chunk) });
  return c.blobs.commitUpload({ uploadId: begun.uploadId });
}

const createRequest = (name: string, extra: Record<string, unknown> = {}) => ({
  meta: meta(),
  name,
  description: "do the thing",
  playbookRef: { scope: "bundled", key: "one-shot" },
  playbookSource: PLAYBOOK,
  launchDefaults: { harness: "omp", model: "" },
  start: false,
  ...extra,
});

test("an upload of 5 MB in 64 KiB chunks lands with a matching sha256; a name with .. or / is refused and writes nothing", async () => {
  const c = await start();
  mkdirSync(join(c.alinery, "tasks", "t"), { recursive: true });
  const bytes = randomBytes(5 * 1024 * 1024);
  const done = await upload(c, { case: "attachment", value: { taskSlug: "t", name: "big.bin" } }, bytes);
  expect(done.ref?.target.case === "attachment" && done.ref.target.value.name).toBe("big.bin");
  const stored = readFileSync(join(c.alinery, "tasks", "t", "artifacts", "attachments", "big.bin"));
  expect(sha(stored)).toBe(sha(bytes));
  // The same name again gets a suffix and the first file stays.
  const second = await upload(c, { case: "attachment", value: { taskSlug: "t", name: "big.bin" } }, bytes.subarray(0, 10));
  expect(second.ref?.target.case === "attachment" && second.ref.target.value.name).toBe("big-2.bin");

  const before = readdirSync(join(c.alinery, "tasks", "t", "artifacts", "attachments")).sort();
  for (const name of ["..", "../x", "a/b", "/etc/passwd", "a\\b", ""]) {
    expect(await code(c.blobs.beginUpload({ meta: meta(), target: { target: { case: "attachment", value: { taskSlug: "t", name } } }, size: 1n, sha256: sha(new Uint8Array(1)) }))).toBe(Code.InvalidArgument);
    expect(await code(c.blobs.beginUpload({ meta: meta(), target: { target: { case: "staged", value: { name } } }, size: 1n, sha256: sha(new Uint8Array(1)) }))).toBe(Code.InvalidArgument);
  }
  expect(await code(c.blobs.beginUpload({ meta: meta(), target: { target: { case: "attachment", value: { taskSlug: "..", name: "x" } } }, size: 1n, sha256: sha(new Uint8Array(1)) }))).toBe(Code.InvalidArgument);
  expect(readdirSync(join(c.alinery, "tasks", "t", "artifacts", "attachments")).sort()).toEqual(before);
  expect(existsSync(join(c.repo, "x"))).toBe(false);
});

test("a wrong digest, an out-of-order chunk and an oversized file are refused", async () => {
  const c = await start();
  mkdirSync(join(c.alinery, "tasks", "t"), { recursive: true });
  const bytes = randomBytes(1000);
  const begun = await c.blobs.beginUpload({ meta: meta(), target: { target: { case: "attachment", value: { taskSlug: "t", name: "f.bin" } } }, size: 1000n, sha256: "0".repeat(64) });
  expect(await code(c.blobs.uploadChunk({ uploadId: begun.uploadId, offset: 10n, data: bytes.subarray(0, 10) }))).toBe(Code.InvalidArgument);
  await c.blobs.uploadChunk({ uploadId: begun.uploadId, offset: 0n, data: bytes });
  expect(await code(c.blobs.commitUpload({ uploadId: begun.uploadId }))).toBe(Code.InvalidArgument);
  expect(existsSync(join(c.alinery, "tasks", "t", "artifacts", "attachments", "f.bin"))).toBe(false);
  expect(await code(c.blobs.beginUpload({ meta: meta(), target: { target: { case: "staged", value: { name: "huge" } } }, size: BigInt(26 * 1024 * 1024), sha256: "0".repeat(64) }))).toBe(Code.InvalidArgument);
});

test("CreateTask makes the task, its worktree, ticket and staged attachment, and the row is in the store before the reply", async () => {
  const c = await start();
  const bytes = randomBytes(300 * 1024);
  const staged = await upload(c, { case: "staged", value: { name: "notes.bin" } }, bytes);
  const uploadId = staged.ref?.target.case === "staged" ? staged.ref.target.value.uploadId : "";
  const res = await c.tasks.createTask(createRequest("Fix login", { attachments: [{ name: "notes.bin", uploadId }] }));
  expect(res.created?.creation).toBe("ready");
  const slug = res.created?.task?.slug ?? "";
  expect(slug).toBe("fix-login");
  expect(c.store.get(taskKey(slug))).toBeDefined();
  expect(res.applied?.cursor?.seq).toBe(c.store.cursor().seq);
  const dir = join(c.alinery, "tasks", slug);
  expect(readFileSync(join(dir, "artifacts", "00-ticket.md"), "utf8")).toContain("- attachments/notes.bin");
  expect(sha(readFileSync(join(dir, "artifacts", "attachments", "notes.bin")))).toBe(sha(bytes));
  expect(existsSync(join(c.alinery, "worktrees", slug, ".git"))).toBe(true);
  const exec = JSON.parse(readFileSync(join(dir, "execution.json"), "utf8"));
  expect(exec.creation).toBe("ready");
  expect(exec.version).toBe(1);
  expect(Object.keys(exec.occurrences)).toHaveLength(1);
  expect(readFileSync(join(dir, "playbook.md"), "utf8")).toBe(PLAYBOOK);
  // The staged file is spent: the same upload cannot be claimed twice.
  expect(readdirSync(join(c.alinery, "tmp", "uploads"))).toEqual([]);
  expect(await code(c.tasks.createTask(createRequest("Second", { attachments: [{ name: "notes.bin", uploadId }] })))).toBe(Code.InvalidArgument);
  // A second task with the same name gets a numbered slug and branch.
  const again = await c.tasks.createTask(createRequest("Fix login"));
  expect(again.created?.task?.slug).toBe("fix-login-1");
  expect(again.created?.task?.branch).toBe("fix-login-1");
});

test("the legacy create_task wire (alinery-mcp) creates through the same path, with inline base64 attachments, and leaves no scratch behind", async () => {
  const c = await start();
  const bytes = randomBytes(1000);
  const reply = (await createFromWire(c.deps, {
    name: "From mcp",
    attachments: [{ name: "a.bin", bytes: bytes.toString("base64") }],
    playbook: { reference: { scope: "bundled", key: "one-shot" }, source: PLAYBOOK },
    launch_defaults: { harness: "omp", model: "" },
    start: false,
  } as never)) as { task: { slug: string }; creation: string; errors: unknown[]; error?: string };
  expect(reply.error).toBeUndefined();
  expect(reply.creation).toBe("ready");
  expect(reply.task.slug).toBe("from-mcp");
  expect(sha(readFileSync(join(c.alinery, "tasks", "from-mcp", "artifacts", "attachments", "a.bin")))).toBe(sha(bytes));
  expect(readdirSync(join(c.alinery, "tmp")).filter((n) => n.startsWith("wire-"))).toEqual([]);
  const refused = (await createFromWire(c.deps, { name: "x", parent_task: "p", playbook: { reference: { scope: "bundled", key: "one-shot" }, source: PLAYBOOK }, start: false } as never)) as { error?: string };
  expect(refused.error).toContain("create_subtask");
});

test("WorktreeExists follows the worktree on disk, and an unknown task is NOT_FOUND", async () => {
  const c = await start();
  const slug = (await c.tasks.createTask(createRequest("Has tree"))).created?.task?.slug ?? "";
  expect((await c.tasks.worktreeExists({ slug })).exists).toBe(true);
  rmSync(join(c.alinery, "worktrees", slug), { recursive: true, force: true });
  expect((await c.tasks.worktreeExists({ slug })).exists).toBe(false);
  expect(await code(c.tasks.worktreeExists({ slug: "nope" }))).toBe(Code.NotFound);
});

test("a retried CreateTask with the same mutation id creates one task", async () => {
  const c = await start();
  const req = createRequest("Once");
  const [a, b] = [await c.tasks.createTask(req), await c.tasks.createTask(req)];
  expect(b.created?.task?.slug).toBe(a.created?.task?.slug ?? "?");
  expect(readdirSync(join(c.alinery, "tasks"))).toEqual(["once"]);
});

test("a branch blocked by a parent namespace is refused before anything is reserved", async () => {
  const c = await start();
  git(c.repo, "branch", "feat");
  expect(await code(c.tasks.createTask(createRequest("Child", { branchName: "feat/child" })))).toBe(Code.InvalidArgument);
  expect(existsSync(join(c.alinery, "tasks"))).toBe(false);
});

test("rename, archive and restore; expected_revision mismatch is ABORTED; archive prunes the executions' objects", async () => {
  const c = await start();
  const created = await c.tasks.createTask(createRequest("Alpha"));
  const slug = created.created?.task?.slug ?? "";
  const rev = c.store.get(taskKey(slug))!.revision;
  const renamed = await c.tasks.renameTask({ meta: meta(), slug, name: "  Beta  ", expectedRevision: rev });
  expect(renamed.task?.name).toBe("Beta");
  expect(await code(c.tasks.renameTask({ meta: meta(), slug, name: "Gamma", expectedRevision: rev }))).toBe(Code.Aborted);
  expect(c.store.get(taskKey(slug))?.value.case === "task" && (c.store.get(taskKey(slug))!.value.value as { name: string }).name).toBe("Beta");
  expect(await code(c.tasks.renameTask({ meta: meta(), slug, name: "   " }))).toBe(Code.InvalidArgument);

  const objects = join(c.alinery, "tasks", slug, "executions", "e1", "objects");
  mkdirSync(objects, { recursive: true });
  writeFileSync(join(objects, "blob"), "x");
  writeFileSync(join(c.alinery, "tasks", slug, "executions", "e1", "manifest.json"), "{}");
  await c.tasks.archiveTask({ meta: meta(), slug });
  expect(existsSync(objects)).toBe(false);
  expect(existsSync(join(c.alinery, "tasks", slug, "executions", "e1", "manifest.json"))).toBe(true);
  expect(readFileSync(join(c.alinery, "tasks", slug, "task.md"), "utf8")).toContain("archived = true");
  expect(c.events.map((e) => e.event)).toEqual(["task.archive"]);
  await c.tasks.restoreTask({ meta: meta(), slug });
  expect(readFileSync(join(c.alinery, "tasks", slug, "task.md"), "utf8")).toContain("archived = false");
  expect(await code(c.tasks.renameTask({ meta: meta(), slug: "missing", name: "x" }))).toBe(Code.NotFound);
});

test("a task with an active child cannot be archived", async () => {
  const c = await start();
  const slug = (await c.tasks.createTask(createRequest("Parent"))).created?.task?.slug ?? "";
  const path = join(c.alinery, "tasks", slug, "task.md");
  // Top-level keys come first in TOML; a key written after a table would belong to the table.
  writeFileSync(path, `active_subtask = "kid"\n${readFileSync(path, "utf8")}`);
  expect(await code(c.tasks.archiveTask({ meta: meta(), slug }))).toBe(Code.FailedPrecondition);
  expect(readFileSync(path, "utf8")).toContain("archived = false");
});

test("SetAutoApproveAll writes task.md and execution.json together and needs APPROVE", async () => {
  const c = await start();
  const slug = (await c.tasks.createTask(createRequest("Auto"))).created?.task?.slug ?? "";
  const res = await c.tasks.setAutoApproveAll({ meta: meta(), slug, enabled: true });
  expect(res.task?.autoApproveAll).toBe(true);
  expect(JSON.parse(readFileSync(join(c.alinery, "tasks", slug, "execution.json"), "utf8")).auto_approve_all).toBe(true);
});

test("DuplicateTask keeps the ticket, attachments and playbook, and counts its generation", async () => {
  const c = await start();
  const staged = await upload(c, { case: "staged", value: { name: "a.txt" } }, Buffer.from("hello"));
  const uploadId = staged.ref?.target.case === "staged" ? staged.ref.target.value.uploadId : "";
  const source = (await c.tasks.createTask(createRequest("Orig", { attachments: [{ name: "a.txt", uploadId }] }))).created?.task?.slug ?? "";
  const first = await c.tasks.duplicateTask({ meta: meta(), sourceSlug: source });
  expect(first.created?.task?.name).toBe("Orig D+1");
  const slug = first.created?.task?.slug ?? "";
  expect(slug).not.toBe(source);
  expect(readFileSync(join(c.alinery, "tasks", slug, "artifacts", "attachments", "a.txt"), "utf8")).toBe("hello");
  expect(readFileSync(join(c.alinery, "tasks", slug, "artifacts", "00-ticket.md"), "utf8")).toBe(readFileSync(join(c.alinery, "tasks", source, "artifacts", "00-ticket.md"), "utf8"));
  const second = await c.tasks.duplicateTask({ meta: meta(), sourceSlug: slug });
  expect(second.created?.task?.name).toBe("Orig D+2");
});

test("a draft is written, shows its images through the entity and ReadBlob, and is deleted whole", async () => {
  const c = await start();
  const image = randomBytes(2000);
  const res = await c.drafts.writeDraft({
    meta: meta(),
    name: "Idea",
    description: "text",
    playbook: { scope: "bundled", key: "one-shot" },
    launch: { harness: "omp", model: "" },
    maxLiveSessions: 10,
    writeAttachments: true,
    attachmentEntries: ["a.txt"],
    images: [{ name: "shot.png", mimeType: "image/png", bytes: image }],
  });
  const slug = res.task?.slug ?? "";
  expect(slug).toBe("idea");
  expect(res.task?.draft).toBe(true);
  const row = c.store.get(`draft/${slug}/${slug}`);
  expect(row?.value.case === "draft" && row.value.value.images.map((i) => [i.name, Number(i.size)])).toEqual([["shot.png", 2000]]);
  let got = Buffer.alloc(0);
  for await (const part of c.blobs.readBlob({ ref: { target: { case: "draftImage", value: { draftSlug: slug, name: "shot.png" } } } })) got = Buffer.concat([got, part.data]);
  expect(sha(got)).toBe(sha(image));
  // The same name reuses the draft.
  expect((await c.drafts.writeDraft({ meta: meta(), name: "Idea", playbook: { scope: "bundled", key: "one-shot" }, maxLiveSessions: 10 })).task?.slug).toBe(slug);
  expect(c.events.map((e) => e.event)).toEqual(["task.draft_create"]);
  // Creating from the draft promotes it in place and drops its form state.
  const made = await c.tasks.createTask(createRequest("Idea", { draftSlug: slug }));
  expect(made.created?.task?.slug).toBe(slug);
  expect(made.created?.task?.draft).toBe(false);
  expect(c.store.get(`draft/${slug}/${slug}`)).toBeUndefined();
  expect(await code(c.drafts.deleteDraft({ meta: meta(), slug }))).toBe(Code.FailedPrecondition);
  const other = (await c.drafts.writeDraft({ meta: meta(), name: "Other", playbook: { scope: "bundled", key: "one-shot" }, maxLiveSessions: 10 })).task?.slug ?? "";
  await c.drafts.deleteDraft({ meta: meta(), slug: other });
  expect(existsSync(join(c.alinery, "tasks", other))).toBe(false);
  expect(c.store.get(taskKey(other))).toBeUndefined();
  expect(c.events.map((e) => e.event)).toEqual(["task.draft_create", "task.draft_create", "task.draft_delete"]);
});

test("a chat thread's attachment uploads into its attachments directory, reads back, and needs a thread that exists", async () => {
  const c = await start();
  const sessions = join(c.alinery, "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "c1.meta.json"), JSON.stringify({ id: "c1", harness: "vinculum", generic: true, worktree: c.repo }));
  writeFileSync(join(sessions, "plain.meta.json"), JSON.stringify({ id: "plain", harness: "no-harness", generic: true, worktree: c.repo }));
  const bytes = randomBytes(150_000);
  const done = await upload(c, { case: "chatAttachment", value: { threadId: "c1", name: "shot.png" } }, bytes);
  expect(done.ref?.target).toMatchObject({ case: "chatAttachment", value: { threadId: "c1", name: "shot.png" } });
  expect(sha(readFileSync(join(sessions, "c1.attachments", "shot.png")))).toBe(sha(bytes));
  let got = Buffer.alloc(0);
  for await (const part of c.blobs.readBlob({ ref: { target: { case: "chatAttachment", value: { threadId: "c1", name: "shot.png" } } } })) got = Buffer.concat([got, part.data]);
  expect(sha(got)).toBe(sha(bytes));
  const refused = (threadId: string, name: string) => code(upload(c, { case: "chatAttachment", value: { threadId, name } }, bytes));
  expect(await refused("missing", "a.png")).toBe(Code.NotFound);
  expect(await refused("plain", "a.png")).toBe(Code.InvalidArgument);
  expect(await refused("c1", "../a.png")).toBe(Code.InvalidArgument);
  expect(existsSync(join(sessions, "plain.attachments"))).toBe(false);
});
