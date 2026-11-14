import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { type Job, JobState } from "alinery-proto/alinery/v1/entities_pb";
import { JobService } from "alinery-proto/alinery/v1/jobs_pb";
import { SyncService } from "alinery-proto/alinery/v1/sync_pb";
import { jobKey, JobRunner } from "../jobs/runner.ts";
import { Store } from "../sync/store.ts";
import { repoScope } from "../sync/testkit.ts";
import { serveRpc } from "./server.ts";

const SECRET = "ef".repeat(32);
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const FAKE = join(import.meta.dir, "..", "jobs", "fake-child.ts");

async function start(hostExecutable: string | undefined = process.execPath) {
  const dir = mkdtempSync("/tmp/rpc-j-");
  const socketPath = join(dir, "rpc.sock");
  const store = new Store({ coalesceMs: 1 });
  const jobs = new JobRunner(store, { command: () => [process.execPath, FAKE] });
  const info = { protocol: 25, buildId: "b", repoRoot: "/repo", appConfigIdentity: "i" };
  // The fake child answers {mode} from the params, which the RPC does not carry: a silent child is
  // enough to show the job was started and ended.
  const net = await serveRpc({ socketPath, secret: Buffer.from(SECRET), hostExecutable, info, lifecycle: { stop: () => 0, exit: () => {} }, store, jobs, storageScan: { mode: "error" } as never, transcripts: async () => undefined });
  cleanup.push(() => {
    net.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const transport = (header?: string) =>
    createGrpcTransport({
      baseUrl: "http://daemon",
      nodeOptions: { createConnection: () => connect(socketPath) } as never,
      interceptors: [(next) => (req) => (header ? (req.header.set("authorization", header), next(req)) : next(req))],
    });
  const auth = `Bearer ${SECRET}`;
  return { store, jobs: (header: string | null = auth) => createClient(JobService, transport(header)), sync: () => createClient(SyncService, transport(auth)) };
}

const meta = (id: string) => ({ clientId: "c1", mutationId: id });
const code = async (call: Promise<unknown>) => ConnectError.from(await call.then(() => null, (e) => e)).code;

test("StartStorageScan returns a job id, and a repo-scope subscriber sees the job end", async () => {
  const { jobs, sync, store } = await start();
  const ac = new AbortController();
  cleanup.push(() => ac.abort());
  const frames = sync().subscribe({ scope: repoScope }, { signal: ac.signal })[Symbol.asyncIterator]();
  expect((await frames.next()).value!.frame.case).toBe("snapshot");
  const res = await jobs().startStorageScan({ meta: meta("m1") });
  expect(res.jobId).toBeString();
  expect(res.applied?.cursor?.epoch).toBe(store.epoch);
  // The fake child reports an error, which is the Job's end: the subscriber gets it as a delta.
  let ended: Job | undefined;
  for (let i = 0; i < 20 && !ended; i++) {
    const frame = (await frames.next()).value!.frame;
    if (frame.case !== "delta") continue;
    for (const c of frame.value.changes) {
      const job = c.op.case === "put" && c.op.value.value.case === "job" ? c.op.value.value.value : undefined;
      if (job && job.state === JobState.FAILED) ended = job;
    }
  }
  expect(ended).toMatchObject({ id: res.jobId, error: "it broke" });
  expect(store.get(jobKey(res.jobId))).toBeDefined();
});

test("a repeated mutation id starts one job; a missing one is refused", async () => {
  const { jobs, store } = await start();
  const a = await jobs().startStorageScan({ meta: meta("same") });
  const b = await jobs().startStorageScan({ meta: meta("same") });
  expect(b.jobId).toBe(a.jobId);
  const other = await jobs().startStorageScan({ meta: meta("other") });
  expect(other.jobId).not.toBe(a.jobId);
  expect([...store.rowsMatching(repoScope)].filter((e) => e.key.startsWith("job/")).length).toBe(2);
  expect(await code(jobs().startStorageScan({}))).toBe(Code.InvalidArgument);
});

test("cancel of an unknown job is NOT_FOUND; start and cancel need ACT", async () => {
  const { jobs } = await start();
  expect(await code(jobs().cancelJob({ meta: meta("c1"), jobId: "no-such-job" }))).toBe(Code.NotFound);
  // No token is refused.
  expect(await code(jobs(null).startStorageScan({ meta: meta("a1") }))).toBe(Code.Unauthenticated);
  expect(await code(jobs(null).cancelJob({ meta: meta("a2"), jobId: "x" }))).toBe(Code.Unauthenticated);
  expect(await code(jobs("Bearer " + "00".repeat(32)).startStorageScan({ meta: meta("a3") }))).toBe(Code.Unauthenticated);
});
