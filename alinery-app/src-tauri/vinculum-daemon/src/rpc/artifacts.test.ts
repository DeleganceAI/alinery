import { afterEach, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, copyFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { ArtifactService } from "alinery-proto/alinery/v1/artifacts_pb";
import { BlobService } from "alinery-proto/alinery/v1/blobs_pb";
import { SyncService } from "alinery-proto/alinery/v1/sync_pb";
import { TaskService } from "alinery-proto/alinery/v1/tasks_pb";
import { ArtifactProjector } from "../domain/artifactProjector.ts";
import { BlobStore } from "../domain/blobs.ts";
import { JobRunner } from "../jobs/runner.ts";
import type { TelemetryEvent } from "../platform/telemetry.ts";
import { Feed } from "../sync/feed.ts";
import { Store } from "../sync/store.ts";
import { Watcher } from "../sync/watcher.ts";
import { executionRecords } from "./artifacts.ts";
import { serveRpc } from "./server.ts";

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

type Created = { id: string; phase: string; harness: string };

async function start(options: { watch?: boolean } = {}) {
  const dir = mkdtempSync("/tmp/rpc-a-");
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  const alinery = join(repo, ".alinery");
  mkdirSync(join(alinery, "tasks"), { recursive: true });
  const store = new Store({ coalesceMs: 1 });
  const feed = new Feed(store, alinery, (e) => e, () => [], {});
  const events: TelemetryEvent[] = [];
  const created: Record<string, unknown>[] = [];
  const telemetry = { record: (build: () => TelemetryEvent) => void events.push(build()) };
  const taskExecution = (slug: string) => ({ state: { executions: {}, occurrences: {} }, definition: { step: [{ key: "build" }], slug } });
  const projector = new ArtifactProjector(store, repo, executionRecords(taskExecution), () => {}, 5);
  feed.onChanged = (rel) => projector.changed(rel);
  const tasks = { repo, lane: "test", identity: "id", refresh: (rel: string) => feed.refresh(rel), telemetry, blobs: new BlobStore(repo) };
  const artifacts = {
    repo,
    projector,
    refresh: (rel: string) => feed.refresh(rel),
    telemetry,
    taskExecution,
    createSession: async (request: Record<string, unknown>) => {
      created.push(request);
      const session: Created = { id: "s-new", phase: String((request.target as { step_key: string }).step_key), harness: "vinculum" };
      return { session, start: "reserved", errors: [] };
    },
  };
  const socketPath = join(dir, "rpc.sock");
  const info = { protocol: 30, buildId: "b", repoRoot: repo, appConfigIdentity: "i" };
  const net = await serveRpc({ socketPath, secret: Buffer.from(SECRET), hostExecutable: process.execPath, info, lifecycle: { stop: () => 0, exit: () => {} }, store, jobs: new JobRunner(store), storageScan: { mode: "error" } as never, transcripts: async () => undefined, tasks, artifacts });
  const watcher = options.watch ? new Watcher(alinery, (rel) => void feed.refresh(rel), { debounceMs: 10 }) : undefined;
  watcher?.start();
  cleanup.push(() => {
    watcher?.stop?.();
    net.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const transport = createGrpcTransport({
    baseUrl: "http://daemon",
    nodeOptions: { createConnection: () => connect(socketPath) } as never,
    interceptors: [(next) => (req) => (req.header.set("authorization", `Bearer ${SECRET}`), next(req))],
  });
  await feed.scan();
  return { dir, repo, alinery, store, events, created, feed, projector, tasks: createClient(TaskService, transport), artifacts: createClient(ArtifactService, transport), blobs: createClient(BlobService, transport), sync: createClient(SyncService, transport) };
}
type Ctx = Awaited<ReturnType<typeof start>>;

let n = 0;
const meta = () => ({ clientId: "c1", mutationId: `m${++n}` });
const code = async (call: Promise<unknown>) => ConnectError.from(await call.then(() => null, (e) => e)).code;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function makeTask(c: Ctx, name = "Review me"): Promise<string> {
  const res = await c.tasks.createTask({ meta: meta(), name, description: "d", playbookRef: { scope: "bundled", key: "one-shot" }, playbookSource: PLAYBOOK, launchDefaults: { harness: "vinculum", model: "" }, start: false });
  const slug = res.created?.task?.slug ?? "";
  c.projector.project(slug);
  return slug;
}
const artifactsOf = (c: Ctx, slug: string, ...parts: string[]) => join(c.alinery, "tasks", slug, "artifacts", ...parts);
const input = (body = "tighten this") => ({ anchorId: "p1", anchorKind: "paragraph", anchorLabel: "Intro", anchorExcerpt: "the intro", lineStart: 1, lineEnd: 2, body });

async function read(c: Ctx, ref: Record<string, unknown>) {
  const frames: Uint8Array[] = [];
  for await (const part of c.blobs.readBlob({ ref: { target: ref as never } })) frames.push(part.data);
  return frames;
}

test("a comment is in the task scope before AddComment replies, the review reaches pending, and the telemetry events fire", async () => {
  const c = await start();
  const slug = await makeTask(c);
  writeFileSync(artifactsOf(c, slug, "03-plan.md"), "# plan\n");
  const added = await c.artifacts.addComment({ meta: meta(), taskSlug: slug, artifact: "03-plan.md", comment: input() });
  expect(added.commentId).toMatch(/^c\d+$/);
  expect(c.store.get(`comment/${slug}/03-plan.md/${added.commentId}`)?.value.case).toBe("comment");
  expect(c.store.get(`artifact/${slug}/03-plan.md`)?.value.case).toBe("artifact");
  expect(c.store.get(`artifact_tree/${slug}/${slug}`)?.value.case).toBe("artifactTree");
  expect(added.applied?.cursor?.seq).toBe(c.store.cursor().seq);
  const sent = await c.artifacts.sendReview({ meta: meta(), taskSlug: slug, artifact: "03-plan.md" });
  expect(sent.review).toBe("03-plan.review-001.md");
  expect(existsSync(artifactsOf(c, slug, sent.review))).toBe(true);
  expect(c.store.get(`review_pending/${slug}/03-plan.md`)?.value).toMatchObject({ case: "reviewPending", value: { review: sent.review } });
  expect(c.store.get(`comment/${slug}/03-plan.md/${added.commentId}`)).toBeUndefined();
  await c.artifacts.clearReviewPending({ meta: meta(), taskSlug: slug, artifact: "03-plan.md" });
  expect(c.store.get(`review_pending/${slug}/03-plan.md`)).toBeUndefined();
  expect(c.events.map((e) => e.event)).toEqual(["artifact.comment_add", "artifact.review_send"]);
});

test("a comment on a worktree file reaches the task scope and its review goes pending under repo-comments/", async () => {
  const c = await start();
  const slug = await makeTask(c);
  const task = readFileSync(join(c.alinery, "tasks", slug, "task.md"), "utf8");
  const worktree = /worktree = "([^"]+)"/.exec(task)?.[1] ?? "";
  writeFileSync(join(worktree, "notes.md"), "# notes\n");
  const target = "repo:notes.md";
  const added = await c.artifacts.addComment({ meta: meta(), taskSlug: slug, artifact: target, comment: input() });
  expect(c.store.get(`comment/${slug}/${target}/${added.commentId}`)?.value.case).toBe("comment");
  expect(existsSync(join(worktree, "notes.comments.json"))).toBe(false);
  const sent = await c.artifacts.sendReview({ meta: meta(), taskSlug: slug, artifact: target });
  expect(sent.review).toBe("repo:notes.review-001.md");
  expect(existsSync(join(c.alinery, "tasks", slug, "repo-comments", "notes.review-001.md"))).toBe(true);
  expect(c.store.get(`review_pending/${slug}/${target}`)?.value).toMatchObject({ case: "reviewPending", value: { review: sent.review } });
  expect(await code(c.artifacts.addComment({ meta: meta(), taskSlug: slug, artifact: "repo:../x.md", comment: input() }))).toBe(Code.InvalidArgument);
});

test("a retried mutation id adds one comment; an empty body and a link are refused", async () => {
  const c = await start();
  const slug = await makeTask(c);
  writeFileSync(artifactsOf(c, slug, "03-plan.md"), "# plan\n");
  const m = meta();
  await c.artifacts.addComment({ meta: m, taskSlug: slug, artifact: "03-plan.md", comment: input("once") });
  await c.artifacts.addComment({ meta: m, taskSlug: slug, artifact: "03-plan.md", comment: input("once") });
  expect([...c.store.rowsMatching({ kind: { case: "task", value: { slug } } } as never)].filter((e) => e.key.startsWith("comment/"))).toHaveLength(1);
  expect(await code(c.artifacts.addComment({ meta: meta(), taskSlug: slug, artifact: "03-plan.md", comment: input("   ") }))).toBe(Code.InvalidArgument);
  symlinkSync("/etc/hosts", artifactsOf(c, slug, "linked.md"));
  expect(await code(c.artifacts.addComment({ meta: meta(), taskSlug: slug, artifact: "linked.md", comment: input() }))).toBe(Code.PermissionDenied);
  expect(await code(c.artifacts.addComment({ meta: meta(), taskSlug: slug, artifact: "../task.md", comment: input() }))).toBe(Code.InvalidArgument);
});

test("a draft write names the revision it saw; a stale revision is ABORTED and an empty body deletes", async () => {
  const c = await start();
  const slug = await makeTask(c);
  writeFileSync(artifactsOf(c, slug, "03-plan.md"), "# plan\n");
  await c.artifacts.saveCommentDraft({ meta: meta(), taskSlug: slug, artifact: "03-plan.md", comment: input("first") });
  const key = `comment_draft/${slug}/03-plan.md/p1`;
  const row = c.store.get(key);
  expect(row?.value).toMatchObject({ case: "commentDraft", value: { body: "first", stale: false } });
  const stale = (row?.revision ?? 0n) - 1n;
  expect(await code(c.artifacts.saveCommentDraft({ meta: meta(), taskSlug: slug, artifact: "03-plan.md", comment: input("second"), expectedRevision: stale === 0n ? 99n : stale }))).toBe(Code.Aborted);
  await c.artifacts.saveCommentDraft({ meta: meta(), taskSlug: slug, artifact: "03-plan.md", comment: input("second"), expectedRevision: row?.revision });
  expect(c.store.get(key)?.value).toMatchObject({ value: { body: "second" } });
  // The artifact changing marks the draft stale.
  writeFileSync(artifactsOf(c, slug, "03-plan.md"), "# plan v2\n");
  c.projector.project(slug);
  expect(c.store.get(key)?.value).toMatchObject({ value: { stale: true } });
  await c.artifacts.saveCommentDraft({ meta: meta(), taskSlug: slug, artifact: "03-plan.md", comment: input("") });
  expect(c.store.get(key)).toBeUndefined();
});

test("an agent-style cp into artifacts/ reaches a task-scope subscriber within 1 s", async () => {
  const c = await start({ watch: true });
  const slug = await makeTask(c);
  const ac = new AbortController();
  const seen = new Promise<number>((resolve) => {
    void (async () => {
      const t0 = Date.now();
      for await (const frame of c.sync.subscribe({ scope: { kind: { case: "task", value: { slug } } } }, { signal: ac.signal })) {
        if (frame.frame.case === "delta" && frame.frame.value.changes.some((ch) => ch.op.case === "put" && ch.op.value.key === `artifact/${slug}/03-plan.md`)) return resolve(Date.now() - t0);
      }
    })().catch(() => {});
  });
  await Bun.sleep(100);
  const source = join(c.dir, "from-agent.md");
  writeFileSync(source, "# plan from an agent\n");
  const wrote = Date.now();
  copyFileSync(source, artifactsOf(c, slug, "03-plan.md"));
  const elapsed = await Promise.race([seen, Bun.sleep(1000).then(() => -1)]);
  ac.abort();
  expect(elapsed).toBeGreaterThanOrEqual(0);
  expect(Date.now() - wrote).toBeLessThan(1500);
});

test("ReadBlob of a 20 MB artifact leaves in frames of at most 64 KiB with the same sha256; a planted link is PERMISSION_DENIED", async () => {
  const c = await start();
  const slug = await makeTask(c);
  const bytes = randomBytes(20 * 1024 * 1024);
  writeFileSync(artifactsOf(c, slug, "big.bin"), bytes);
  const frames = await read(c, { case: "artifact", value: { taskSlug: slug, name: "big.bin" } });
  expect(Math.max(...frames.map((f) => f.length))).toBeLessThanOrEqual(64 * 1024);
  expect(frames.length).toBeGreaterThanOrEqual(320);
  expect(sha(Buffer.concat(frames))).toBe(sha(bytes));
  const secret = join(c.dir, "secret.txt");
  writeFileSync(secret, "outside");
  symlinkSync(secret, artifactsOf(c, slug, "leak.md"));
  expect(await code(read(c, { case: "artifact", value: { taskSlug: slug, name: "leak.md" } }))).toBe(Code.PermissionDenied);
  mkdirSync(join(c.dir, "elsewhere"));
  writeFileSync(join(c.dir, "elsewhere", "x.md"), "outside");
  symlinkSync(join(c.dir, "elsewhere"), artifactsOf(c, slug, "dir"));
  expect(await code(read(c, { case: "artifact", value: { taskSlug: slug, name: "dir/x.md" } }))).toBe(Code.PermissionDenied);
  expect(await code(read(c, { case: "artifact", value: { taskSlug: slug, name: "../task.md" } }))).toBe(Code.InvalidArgument);
  expect(await code(read(c, { case: "artifact", value: { taskSlug: slug, name: "attachments/a.png" } }))).toBe(Code.InvalidArgument);
  expect(await code(read(c, { case: "artifact", value: { taskSlug: slug, name: "absent.md" } }))).toBe(Code.NotFound);
});

test("a tree node reads its file by id, an attachment too, and a link planted after the tree was built is refused", async () => {
  const c = await start();
  const slug = await makeTask(c);
  writeFileSync(artifactsOf(c, slug, "03-plan.md"), "# plan\n");
  mkdirSync(artifactsOf(c, slug, "attachments"), { recursive: true });
  writeFileSync(artifactsOf(c, slug, "attachments", "shot.png"), "png-bytes");
  c.projector.project(slug);
  const tree = c.store.get(`artifact_tree/${slug}/${slug}`);
  const nodes = tree?.value.case === "artifactTree" ? tree.value.value.nodes : [];
  const flat = (list: typeof nodes): typeof nodes => list.flatMap((nd) => [nd, ...flat(nd.children)]);
  const plan = flat(nodes).find((nd) => nd.label === "03-plan.md");
  const shot = flat(nodes).find((nd) => nd.label === "shot.png");
  expect(plan?.kind).toBe("owned");
  expect(shot?.kind).toBe("attachment");
  expect(shot?.revealPath).toBe(`tasks/${slug}/artifacts/attachments/shot.png`);
  expect(plan?.revealPath).toBe(`tasks/${slug}/artifacts/03-plan.md`);
  expect(Buffer.concat(await read(c, { case: "artifactNode", value: { taskSlug: slug, nodeId: plan?.id } })).toString()).toBe("# plan\n");
  expect(Buffer.concat(await read(c, { case: "artifactNode", value: { taskSlug: slug, nodeId: shot?.id } })).toString()).toBe("png-bytes");
  expect(await code(read(c, { case: "artifactNode", value: { taskSlug: slug, nodeId: "artifact-0000000000000000" } }))).toBe(Code.NotFound);
  rmSync(artifactsOf(c, slug, "03-plan.md"));
  symlinkSync(join(c.dir, "repo", ".git", "HEAD"), artifactsOf(c, slug, "03-plan.md"));
  expect([Code.PermissionDenied, Code.InvalidArgument]).toContain(await code(read(c, { case: "artifactNode", value: { taskSlug: slug, nodeId: plan?.id } })));
});

test("a step snapshot is readable after the live file changed and the daemon restarted; a link out of objects/ is PERMISSION_DENIED; a pruned one is NOT_FOUND", async () => {
  const c = await start();
  const slug = await makeTask(c);
  const original = Buffer.from("what step one saw");
  const digest = sha(original);
  const objects = join(c.alinery, "tasks", slug, "executions", "e1", "objects");
  mkdirSync(objects, { recursive: true });
  writeFileSync(join(objects, digest), original);
  writeFileSync(artifactsOf(c, slug, "01-in.md"), "edited later");
  expect(Buffer.concat(await read(c, { case: "stepObject", value: { taskSlug: slug, executionId: "e1", sha256: digest } })).toString()).toBe("what step one saw");
  // A second daemon on the same files (a restart) answers the same bytes.
  const again = await start();
  const moved = join(again.alinery, "tasks", "x", "executions", "e1", "objects");
  mkdirSync(moved, { recursive: true });
  writeFileSync(join(moved, digest), original);
  writeFileSync(join(again.alinery, "tasks", "x", "task.md"), readFileSync(join(c.alinery, "tasks", slug, "task.md")));
  expect(Buffer.concat(await read(again, { case: "stepObject", value: { taskSlug: "x", executionId: "e1", sha256: digest } })).toString()).toBe("what step one saw");
  const outside = join(c.dir, "outside.bin");
  writeFileSync(outside, "outside");
  const planted = sha(Buffer.from("planted"));
  symlinkSync(outside, join(objects, planted));
  expect(await code(read(c, { case: "stepObject", value: { taskSlug: slug, executionId: "e1", sha256: planted } }))).toBe(Code.PermissionDenied);
  mkdirSync(join(c.alinery, "tasks", slug, "executions", "e2"), { recursive: true });
  symlinkSync(join(c.dir, "elsewhere"), join(c.alinery, "tasks", slug, "executions", "e2", "objects"));
  expect(await code(read(c, { case: "stepObject", value: { taskSlug: slug, executionId: "e2", sha256: digest } }))).toBe(Code.PermissionDenied);
  expect(await code(read(c, { case: "stepObject", value: { taskSlug: slug, executionId: "e1", sha256: "../x" } }))).toBe(Code.InvalidArgument);
  rmSync(objects, { recursive: true, force: true });
  const pruned = ConnectError.from(await read(c, { case: "stepObject", value: { taskSlug: slug, executionId: "e1", sha256: digest } }).then(() => null, (e) => e));
  expect(pruned.code).toBe(Code.NotFound);
  expect(pruned.rawMessage).toContain("pruned");
});

test("prepare, finalize and the approval prompt keep their guards; a hash that does not match is refused", async () => {
  const c = await start();
  const slug = await makeTask(c);
  writeFileSync(artifactsOf(c, slug, "03-plan.md"), "# plan\n");
  await c.artifacts.addComment({ meta: meta(), taskSlug: slug, artifact: "03-plan.md", comment: input() });
  const prepared = await c.artifacts.prepareCommentsPrompt({ meta: meta(), taskSlug: slug, artifacts: ["03-plan.md"] });
  expect(prepared.action?.text).toContain("03-plan.review-001.md");
  const prov = prepared.action?.provenance;
  expect(prov?.kind.case).toBe("artifactComments");
  expect(await code(c.artifacts.prepareCommentsPrompt({ meta: meta(), taskSlug: slug, artifacts: [] }))).toBe(Code.InvalidArgument);
  expect(await code(c.artifacts.finalizeMessageActions({ meta: meta(), taskSlug: slug, sessionId: "absent", actions: [prov!] }))).toBe(Code.NotFound);
  const approval = await c.artifacts.prepareReviewApproval({ meta: meta(), taskSlug: slug, reviewArtifact: "03-plan.review-001.md" });
  expect(approval.action?.provenance?.kind.case).toBe("reviewApproval");
  expect(await code(c.artifacts.prepareReviewApproval({ meta: meta(), taskSlug: slug, reviewArtifact: "nope.md" }))).toBe(Code.NotFound);
});

test("a review handoff installs the evidence, a session and the inbound record on the target, and the outbound record on the source", async () => {
  const c = await start();
  const target = await makeTask(c, "Target one");
  const source = await makeTask(c, "Source one");
  writeFileSync(artifactsOf(c, source, "03-findings.md"), "# findings\n");
  const installed = await c.artifacts.installReviewHandoff({
    meta: meta(),
    sourceRepoPath: "/other/repo",
    sourceSlug: source,
    sourceSession: "s-src",
    sourceArtifact: "03-findings.md",
    sourceText: "# findings\n",
    targetRepoPath: c.repo,
    targetSlug: target,
    targetPhase: "build",
    harness: "vinculum",
    model: "",
    promptExtra: "Please act.",
    start: false,
  });
  expect(installed.targetArtifact).toBe("review-handoff-001.md");
  expect(readFileSync(artifactsOf(c, target, "review-handoff-001.md"), "utf8")).toBe(`# Review handoff\n\nSource repository: /other/repo\nSource task: ${source}\nSource artifact: 03-findings.md\n\n# findings\n`);
  const request = c.created[0] as { prompt_extra: string; handoff_artifact: string; target: { step_key: string } };
  expect(request.handoff_artifact).toBe("review-handoff-001.md");
  expect(request.target.step_key).toBe("build");
  expect(request.prompt_extra).toContain("review-handoff-001.md");
  expect(JSON.parse(readFileSync(artifactsOf(c, target, "review-handoff-001.handoff.json"), "utf8"))).toMatchObject({ direction: "inbound", target_session: "s-new", source_task: source, version: 2 });
  const row = c.store.get(`artifact/${target}/review-handoff-001.md`);
  expect(row?.value).toMatchObject({ case: "artifact", value: { handoffs: [{ direction: "inbound", targetPhase: "build" }] } });
  expect(installed.errors).toEqual([]);
  expect(c.events.at(-1)).toMatchObject({ event: "artifact.review_handoff", targetPhase: "build", harness: "vinculum" });
  // The source's daemon records its half.
  await c.artifacts.recordOutboundHandoff({ meta: meta(), sourceSlug: source, record: { ...installed.record!, direction: "outbound" } });
  expect(JSON.parse(readFileSync(artifactsOf(c, source, "03-findings.handoff-001.json"), "utf8"))).toMatchObject({ direction: "outbound", target_artifact: "review-handoff-001.md" });
  expect(c.store.get(`artifact/${source}/03-findings.md`)?.value).toMatchObject({ value: { handoffs: [{ direction: "outbound" }] } });
  // A second handoff takes the next names; a step the target's playbook does not have is refused; the same task is refused.
  const second = await c.artifacts.installReviewHandoff({ meta: meta(), sourceRepoPath: "/other/repo", sourceSlug: source, sourceSession: "s", sourceArtifact: "03-findings.md", sourceText: "x", targetRepoPath: c.repo, targetSlug: target, targetPhase: "build", harness: "vinculum", model: "", promptExtra: "", start: false });
  expect(second.targetArtifact).toBe("review-handoff-002.md");
  expect(await code(c.artifacts.installReviewHandoff({ meta: meta(), sourceRepoPath: "/other/repo", sourceSlug: source, sourceSession: "s", sourceArtifact: "03-findings.md", sourceText: "x", targetRepoPath: c.repo, targetSlug: target, targetPhase: "nonsense", harness: "vinculum", model: "", promptExtra: "", start: false }))).toBe(Code.FailedPrecondition);
  expect(await code(c.artifacts.installReviewHandoff({ meta: meta(), sourceRepoPath: c.repo, sourceSlug: target, sourceSession: "s", sourceArtifact: "03-findings.md", sourceText: "x", targetRepoPath: c.repo, targetSlug: target, targetPhase: "build", harness: "vinculum", model: "", promptExtra: "", start: false }))).toBe(Code.InvalidArgument);
});

test("a review handoff from an archived source is refused before anything is written, and so is its outbound record", async () => {
  const c = await start();
  const target = await makeTask(c, "Target two");
  const source = await makeTask(c, "Source two");
  writeFileSync(artifactsOf(c, source, "03-findings.md"), "# findings\n");
  await c.tasks.archiveTask({ meta: meta(), slug: source });
  const handoff = { meta: meta(), sourceRepoPath: c.repo, sourceSlug: source, sourceSession: "s", sourceArtifact: "03-findings.md", sourceText: "x", targetRepoPath: c.repo, targetSlug: target, targetPhase: "build", harness: "vinculum", model: "", promptExtra: "", start: false };
  expect(await code(c.artifacts.installReviewHandoff(handoff))).toBe(Code.FailedPrecondition);
  expect(existsSync(artifactsOf(c, target, "review-handoff-001.md"))).toBe(false);
  expect(c.created).toEqual([]);
  const record = { version: 2, direction: "outbound", sourceRepoPath: c.repo, targetRepoPath: c.repo, sourceTask: source, sourceSession: "s", sourceArtifact: "03-findings.md", targetTask: target, targetArtifact: "r.md", targetSession: "n", targetPhase: "build", createdAtMs: 1n };
  expect(await code(c.artifacts.recordOutboundHandoff({ meta: meta(), sourceSlug: source, record }))).toBe(Code.FailedPrecondition);
  expect(existsSync(artifactsOf(c, source, "03-findings.handoff-001.json"))).toBe(false);
});

test("a deleted task takes its artifact rows with it, and the 30 s pass finds a file written while no event came", async () => {
  const c = await start();
  const slug = await makeTask(c);
  writeFileSync(artifactsOf(c, slug, "quiet.md"), "no event for this one");
  expect(c.store.get(`artifact/${slug}/quiet.md`)).toBeUndefined();
  expect(await c.projector.pass()).toBeGreaterThanOrEqual(1);
  expect(c.store.get(`artifact/${slug}/quiet.md`)).toBeDefined();
  rmSync(join(c.alinery, "tasks", slug), { recursive: true, force: true });
  c.projector.project(slug);
  expect([...c.store.rowsMatching({ kind: { case: "task", value: { slug } } } as never)].filter((e) => e.key.startsWith("artifact"))).toEqual([]);
});
