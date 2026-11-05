import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { JobKind, JobState, type Job } from "alinery-proto/alinery/v1/entities_pb";
import { Store } from "../sync/store.ts";
import { kindName } from "./kinds.ts";
import { jobKey, JobRunner } from "./runner.ts";
import { scanStorage } from "./storage.ts";

const MAIN = join(import.meta.dir, "..", "main.ts");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function child(kind: string, stdin: string) {
  const p = Bun.spawn([process.execPath, MAIN, "--job", kind], { stdin: new Response(stdin), stdout: "pipe", stderr: "pipe" });
  return { out: await new Response(p.stdout).text(), code: await p.exited };
}

function repoWithData() {
  const repo = mkdtempSync("/tmp/job-child-");
  dirs.push(repo);
  mkdirSyncFile(join(repo, ".alinery", "config.toml"), "mode = 1\n");
  return repo;
}
function mkdirSyncFile(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

test("main.ts --job storage-scan answers one result line and nothing starts a daemon", async () => {
  const repo = repoWithData();
  const params = { repo, appConfig: "/app", namespace: "" };
  const { out, code } = await child("storage-scan", JSON.stringify(params));
  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({ result: scanStorage(params) });
});

test("an unknown kind, or params that are not JSON, is an error line and exit 1", async () => {
  const unknown = await child("nope", "{}");
  expect(unknown.code).toBe(1);
  expect(JSON.parse(unknown.out)).toEqual({ error: "unknown job kind nope" });
  const bad = await child("storage-scan", "{");
  expect(bad.code).toBe(1);
  expect(JSON.parse(bad.out).error).toBeString();
});

test("the runner starts the real child and the Job reaches DONE with the scan as its StorageInfo", async () => {
  const repo = repoWithData();
  const params = { repo, appConfig: "/app", namespace: "d1" };
  const store = new Store();
  const runner = new JobRunner(store, { command: (kind) => [process.execPath, MAIN, "--job", kindName(kind)] });
  const id = runner.start(JobKind.STORAGE_SCAN, params);
  let job: Job | undefined;
  for (let i = 0; i < 500 && job?.state !== JobState.DONE; i++) {
    await Bun.sleep(20);
    job = store.get(jobKey(id))?.value.value as Job | undefined;
  }
  expect(job?.state).toBe(JobState.DONE);
  expect(job?.result.case === "storage" && job.result.value).toMatchObject({
    repoPath: repo,
    activeBytes: 9n,
    alinerydSocketPath: `${repo}/.alinery/alineryd-d1.sock`,
  });
});
