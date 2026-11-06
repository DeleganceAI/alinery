import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import { renderHook, waitFor } from "@testing-library/react";
import { type Entity, EntitySchema, JobKind, JobState } from "alinery-proto/alinery/v1/entities_pb";
import { afterEach, expect, it, vi } from "vitest";
import { daemonTransport } from "../daemon/transport";
import { daemonHarness, put, scriptedSync, snapshot, untilAborted } from "../test/daemonHarness";
import { backupNow, checkBackupDestination, deleteAllArchivedStorage, listBackups, storageInfo, useBackupBusy, verifyBackup } from "./storage";

vi.mock("../daemon/transport", () => ({ daemonTransport: vi.fn() }));
afterEach(() => vi.resetAllMocks());

const job = (id: string, kind: JobKind, state: JobState, extra: Record<string, unknown> = {}): Entity =>
  create(EntitySchema, { key: `job/_/${id}`, value: { case: "job", value: { id, kind, state, ...extra } as never } });

type Jobs = { startStorageScan?: () => unknown; startBackup?: () => unknown; startPurge?: () => unknown };

/** A daemon whose job `j1` goes `states` in order, one row per step, after the Start call answered. */
function serve(
  states: Entity[],
  jobs: Jobs = { startStorageScan: () => ({ jobId: "j1" }), startBackup: () => ({ jobId: "j1" }), startPurge: () => ({ jobId: "j1" }) },
  backups: object = {},
) {
  let started: () => void = () => {};
  const go = new Promise<void>((r) => (started = r));
  const h = scriptedSync(async function* (_req, _call, signal) {
    yield snapshot([], 1);
    await go;
    for (const [i, row] of states.entries()) yield put(row, 2 + i);
    await untilAborted(signal);
  });
  const wrap = (f?: () => unknown) => f && (() => (queueMicrotask(started), f()));
  const transport = daemonHarness({
    sync: h.sync,
    jobs: { startStorageScan: wrap(jobs.startStorageScan), startBackup: wrap(jobs.startBackup), startPurge: wrap(jobs.startPurge) } as never,
    backups: backups as never,
  }).transport as Transport;
  vi.mocked(daemonTransport).mockReturnValue(transport);
}

const storage = {
  appConfigPath: "/app/app.toml",
  repoPath: "/r",
  alineryDir: "/r/.alinery",
  tasksDir: "/r/.alinery/tasks",
  archivedTaskCount: 2,
  archivedSessionCount: 5,
  archivedBytes: 4096n,
  activeBytes: 1024n,
};

it("a storage scan is a job: the numbers come from the job row when it is DONE", async () => {
  serve([job("j1", JobKind.STORAGE_SCAN, JobState.RUNNING), job("j1", JobKind.STORAGE_SCAN, JobState.DONE, { result: { case: "storage", value: storage } })]);
  const info = await storageInfo("/r");
  expect(info).toMatchObject({ repo_path: "/r", tasks_dir: "/r/.alinery/tasks", archived_task_count: 2, archived_session_count: 5, archived_bytes: 4096, active_bytes: 1024 });
});

it("a backup is a job: the meta comes from the row, and a failed job is the daemon's message", async () => {
  const result = {
    path: "/d/a.zip",
    repoName: "r",
    repoPath: "/r",
    createdAt: 1_700_000_000n,
    schemaVersion: 1,
    alineryVersion: "1.0.0",
    trigger: "manual",
    includedDirs: ["tasks"],
  };
  serve([job("j1", JobKind.BACKUP, JobState.DONE, { result: { case: "backup", value: result } })]);
  expect(await backupNow("/r")).toEqual({
    repo_name: "r",
    repo_path: "/r",
    created_at: 1_700_000_000,
    schema_version: 1,
    alinery_version: "1.0.0",
    trigger: "manual",
    included_dirs: ["tasks"],
  });

  serve([job("j1", JobKind.BACKUP, JobState.FAILED, { error: "backup destination is not a directory" })]);
  await expect(backupNow("/r")).rejects.toThrow("backup destination is not a directory");
  serve([job("j1", JobKind.BACKUP, JobState.CANCELLED)]);
  await expect(backupNow("/r")).rejects.toThrow("cancelled");
});

it("a refused start is the daemon's message, not the gRPC wrapper", async () => {
  serve([], {
    startBackup: () => {
      throw new ConnectError("backup is disabled for this repository", Code.FailedPrecondition);
    },
  });
  await expect(backupNow("/r")).rejects.toThrow("backup is disabled for this repository");
});

it("a purge job answers the counts and the failures", async () => {
  const result = { deletedTasks: 2, deletedSessions: 5, deletedWorktrees: 1, errors: [{ target: "task:old", error: "busy" }], deletedTaskSlugs: ["a", "b"] };
  serve([job("j1", JobKind.PURGE, JobState.DONE, { result: { case: "purge", value: result } })]);
  expect(await deleteAllArchivedStorage("/r")).toEqual({ deleted_tasks: 2, deleted_sessions: 5, deleted_worktrees: 1, errors: [{ target: "task:old", error: "busy" }] });
});

it("lists, checks and verifies through the backup service", async () => {
  serve([], undefined, {
    listBackups: () => ({ items: [{ id: "a.zip", path: "/d/a.zip", createdAt: 7n, trigger: "pre_archive", sizeBytes: 99n, alineryVersion: "1" }] }),
    checkBackupDestination: (req: { destination: string }) => ({ resolved: `/real${req.destination}` }),
    verifyBackup: () => ({
      meta: { path: "/d/a.zip", repoName: "r", repoPath: "/r", createdAt: 7n, schemaVersion: 1, alineryVersion: "1", trigger: "pre_archive", includedDirs: [] },
    }),
  });
  expect(await listBackups("/r")).toEqual([{ id: "a.zip", path: "/d/a.zip", created_at: 7, trigger: "pre_archive", size_bytes: 99, alinery_version: "1" }]);
  expect(await checkBackupDestination("/r", "/d")).toBe("/real/d");
  expect((await verifyBackup("/r", "/d/a.zip")).trigger).toBe("pre_archive");
});

it("a daemon that is not reachable says so", async () => {
  serve([], undefined, {
    listBackups: () => {
      throw new ConnectError("", Code.Unavailable);
    },
  });
  await expect(listBackups("/r")).rejects.toThrow("not reachable");
});

it("the busy flag follows a backup job from queued to done, whoever started it", async () => {
  const h = scriptedSync(async function* (_req, _call, signal) {
    yield snapshot([job("other", JobKind.STORAGE_SCAN, JobState.RUNNING)], 1);
    await new Promise((r) => setTimeout(r, 60));
    yield put(job("b1", JobKind.BACKUP, JobState.RUNNING), 2);
    await new Promise((r) => setTimeout(r, 60));
    yield put(job("b1", JobKind.BACKUP, JobState.DONE), 3);
    await untilAborted(signal);
  });
  vi.mocked(daemonTransport).mockReturnValue(daemonHarness({ sync: h.sync }).transport as Transport);
  const { result } = renderHook(() => useBackupBusy("/r"));
  expect(result.current).toBe(false);
  await waitFor(() => expect(result.current).toBe(true));
  await waitFor(() => expect(result.current).toBe(false));
});

it("no repository, no subscription", () => {
  const { result } = renderHook(() => useBackupBusy(""));
  expect(result.current).toBe(false);
  expect(daemonTransport).not.toHaveBeenCalled();
});
