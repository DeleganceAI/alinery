import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { JobKind, JobState } from "alinery-proto/alinery/v1/entities_pb";
import { BackupService } from "alinery-proto/alinery/v1/backups_pb";
import { JobService } from "alinery-proto/alinery/v1/jobs_pb";
import { TaskService } from "alinery-proto/alinery/v1/tasks_pb";
import { kindName } from "../jobs/kinds.ts";
import { BackupHost } from "../jobs/backupHost.ts";
import { JobRunner } from "../jobs/runner.ts";
import type { TelemetryEvent } from "../platform/telemetry.ts";
import { Feed } from "../sync/feed.ts";
import { taskKey } from "../sync/parsers/task.ts";
import { Store } from "../sync/store.ts";
import { serveRpc } from "./server.ts";

const SECRET = "cd".repeat(32);
const REAL = join(import.meta.dir, "..", "jobs", "real-child.ts");
const PLAYBOOK = readFileSync(join(import.meta.dir, "../../../playbooks/one-shot/playbook.md"), "utf8");
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

function git(dir: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

async function start(config: (dest: string) => string) {
  const dir = realpathSync(mkdtempSync("/tmp/rpc-b-"));
  const repo = join(dir, "repo");
  const dest = join(dir, "dest");
  mkdirSync(repo, { recursive: true });
  mkdirSync(dest);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  const alinery = join(repo, ".alinery");
  mkdirSync(alinery, { recursive: true });
  writeFileSync(join(alinery, "config.toml"), config(dest));
  const store = new Store({ coalesceMs: 1 });
  const feed = new Feed(store, alinery, (e) => e, () => [], {});
  const events: TelemetryEvent[] = [];
  const telemetry = { record: (build: () => TelemetryEvent) => void events.push(build()) };
  const appConfig = join(dir, "app.toml");
  let host: BackupHost;
  const jobs = new JobRunner(store, { command: (kind) => [process.execPath, REAL, kindName(kind)], onEnd: (j, p) => host.ended(j, p) });
  host = new BackupHost(jobs, { repo, appConfig, version: "9.9.9", telemetry, sessions: { isRunning: () => false, stop: () => undefined }, afterPurge: async () => {}, debounceMs: 20 });
  const tasks = { repo, lane: "test", identity: "id", refresh: (rel: string) => feed.refresh(rel), telemetry, backups: host };
  const socketPath = join(dir, "rpc.sock");
  const info = { protocol: 34, buildId: "b", repoRoot: repo, appConfigIdentity: "i" };
  const net = await serveRpc({ socketPath, secret: Buffer.from(SECRET), hostExecutable: process.execPath, info, lifecycle: { stop: () => 0, exit: () => {} }, store, jobs, storageScan: { mode: "error" } as never, transcripts: async () => undefined, tasks, backups: host, backupReads: { repo, appConfig } });
  cleanup.push(() => {
    net.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const transport = (header: string | null) =>
    createGrpcTransport({
      baseUrl: "http://daemon",
      nodeOptions: { createConnection: () => connect(socketPath) } as never,
      interceptors: [(next) => (req) => (header ? (req.header.set("authorization", header), next(req)) : next(req))],
    });
  const auth = `Bearer ${SECRET}`;
  await feed.scan();
  return {
    repo,
    dest,
    alinery,
    store,
    jobs,
    events,
    jobsApi: (h: string | null = auth) => createClient(JobService, transport(h)),
    backups: (h: string | null = auth) => createClient(BackupService, transport(h)),
    tasks: createClient(TaskService, transport(auth)),
  };
}

let n = 0;
const meta = () => ({ clientId: "c1", mutationId: `m${++n}` });
const code = async (call: Promise<unknown>) => ConnectError.from(await call.then(() => null, (e) => e)).code;
const ON = (dest: string) => `[backup]\ndestination = "${dest}"\nenabled = true\nretention = 5\ntrigger_pre_archive = true\n`;
const createRequest = (name: string) => ({
  meta: meta(),
  name,
  description: "d",
  playbookRef: { scope: "bundled", key: "one-shot" },
  playbookSource: PLAYBOOK,
  launchDefaults: { harness: "vinculum", model: "" },
  start: false,
});

test("StartBackup runs a job to DONE; ListBackups and VerifyBackup then see the archive", async () => {
  const c = await start(ON);
  const { jobId } = await c.jobsApi().startBackup({ meta: meta() });
  const done = await c.jobs.finished(jobId);
  expect(done.state).toBe(JobState.DONE);
  expect(done.kind).toBe(JobKind.BACKUP);
  expect(done.result).toMatchObject({ case: "backup", value: { trigger: "manual", alineryVersion: "9.9.9" } });
  const listed = await c.backups().listBackups({});
  expect(listed.items).toHaveLength(1);
  expect(listed.items[0]).toMatchObject({ trigger: "manual", alineryVersion: "9.9.9" });
  expect(Number(listed.items[0]?.sizeBytes)).toBeGreaterThan(0);
  const verified = await c.backups().verifyBackup({ path: listed.items[0]?.path ?? "" });
  expect(verified.meta).toMatchObject({ repoPath: c.repo, trigger: "manual" });
  expect(c.events).toEqual([{ event: "backup.create", source: "alineryd", trigger: "manual" }]);
});

test("a repeated mutation id starts one backup; a disabled feature or an unusable destination is FAILED_PRECONDITION", async () => {
  const c = await start(ON);
  const m = meta();
  const a = await c.jobsApi().startBackup({ meta: m });
  const b = await c.jobsApi().startBackup({ meta: m });
  expect(b.jobId).toBe(a.jobId);
  await c.jobs.finished(a.jobId);
  expect(readdirSync(c.dest).filter((f) => f.endsWith(".zip"))).toHaveLength(1);

  const off = await start((d) => ON(d).replace("enabled = true", "enabled = false"));
  expect(await code(off.jobsApi().startBackup({ meta: meta() }))).toBe(Code.FailedPrecondition);
  expect(await code(off.backups().checkBackupDestination({ destination: "/no/such/dir" }))).toBe(Code.FailedPrecondition);
  expect((await off.backups().checkBackupDestination({ destination: off.dest })).resolved).toBe(off.dest);
});

test("VerifyBackup refuses a file outside the destination and a backup of another repository", async () => {
  const c = await start(ON);
  await c.jobs.finished((await c.jobsApi().startBackup({ meta: meta() })).jobId);
  const outside = join(c.repo, "..", "x.zip");
  writeFileSync(outside, "not a zip");
  expect(await code(c.backups().verifyBackup({ path: outside }))).toBe(Code.FailedPrecondition);
  const inside = join(c.dest, "junk-v1.zip");
  writeFileSync(inside, "not a zip");
  expect(await code(c.backups().verifyBackup({ path: inside }))).toBe(Code.FailedPrecondition);
  expect(await code(c.backups().verifyBackup({ path: join(c.dest, "missing.zip") }))).toBe(Code.FailedPrecondition);
});

test("StartPurge needs ADMIN and the reads need VIEW; a caller with no token gets neither", async () => {
  const c = await start(ON);
  expect(await code(c.jobsApi(null).startPurge({ meta: meta() }))).toBe(Code.Unauthenticated);
  expect(await code(c.jobsApi(null).startBackup({ meta: meta() }))).toBe(Code.Unauthenticated);
  expect(await code(c.backups(null).checkBackupDestination({ destination: c.dest }))).toBe(Code.Unauthenticated);
  const { jobId } = await c.jobsApi().startPurge({ meta: meta() });
  const done = await c.jobs.finished(jobId);
  expect(done.kind).toBe(JobKind.PURGE);
  expect(done.state).toBe(JobState.DONE);
  expect(done.result).toMatchObject({ case: "purge", value: { deletedTasks: 0 } });
});

test("an archive whose backup fails leaves the task unarchived and names the reason; with the backup working it archives", async () => {
  const c = await start(ON);
  const slug = (await c.tasks.createTask(createRequest("Keep"))).created?.task?.slug ?? "";
  // The destination turns into a plain file: the pre-archive backup job fails.
  rmSync(c.dest, { recursive: true });
  writeFileSync(c.dest, "");
  const err = ConnectError.from(await c.tasks.archiveTask({ meta: meta(), slug }).then(() => null, (e) => e));
  expect(err.code).toBe(Code.FailedPrecondition);
  expect(err.message).toMatch(/the task was not archived/);
  expect(readFileSync(join(c.alinery, "tasks", slug, "task.md"), "utf8")).toContain("archived = false");
  expect(c.store.get(taskKey(slug))).toBeDefined();

  rmSync(c.dest);
  mkdirSync(c.dest);
  await c.tasks.archiveTask({ meta: meta(), slug });
  expect(readFileSync(join(c.alinery, "tasks", slug, "task.md"), "utf8")).toContain("archived = true");
  expect(readdirSync(c.dest).filter((f) => f.endsWith(".zip"))).toHaveLength(1);
});
