import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobKind, JobState } from "alinery-proto/alinery/v1/entities_pb";
import type { TelemetryEvent } from "../platform/telemetry.ts";
import { Store } from "../sync/store.ts";
import { BackupHost } from "./backupHost.ts";
import { JobRunner } from "./runner.ts";

const REAL = join(import.meta.dir, "real-child.ts");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function rig(config: (dest: string) => string) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "alinery-host-")));
  dirs.push(base);
  const repo = join(base, "repo");
  const dest = join(base, "dest");
  mkdirSync(join(repo, ".alinery/tasks/t"), { recursive: true });
  writeFileSync(join(repo, ".alinery/tasks/t/task.md"), "x");
  mkdirSync(dest);
  writeFileSync(join(repo, ".alinery/config.toml"), config(dest));
  const events: TelemetryEvent[] = [];
  let host: BackupHost;
  const runner = new JobRunner(new Store(), { command: () => [process.execPath, REAL, "backup"], onEnd: (j, p) => host.ended(j, p) });
  host = new BackupHost(runner, {
    repo,
    appConfig: join(base, "app.toml"),
    version: "7.7.7",
    telemetry: { record: (build) => void events.push(build()) },
    sessions: { isRunning: () => false, stop: () => undefined },
    afterPurge: async () => {},
    debounceMs: 20,
  });
  return { base, repo, dest, runner, host, events };
}

const ON = (dest: string) => `[backup]\ndestination = "${dest}"\nenabled = true\nretention = 5\ntrigger_pre_archive = true\n`;

test("a backup before an archive runs as a job and the archive may go ahead", async () => {
  const { host, dest, events } = rig(ON);
  await host.beforeArchive();
  expect(readdirSync(dest).filter((n) => n.endsWith("-v7.7.7.zip"))).toHaveLength(1);
  expect(events).toEqual([{ event: "backup.create", source: "alineryd", trigger: "pre_archive" }]);
});

test("with the trigger off, or no destination, an archive does not wait for a backup", async () => {
  for (const config of [(d: string) => ON(d).replace("trigger_pre_archive = true", "trigger_pre_archive = false"), () => "[backup]\nenabled = true\ntrigger_pre_archive = true\n", () => ""]) {
    const { host, runner } = rig(config);
    await host.beforeArchive();
    expect(runner.busy(JobKind.BACKUP)).toBe(false);
  }
});

test("a destination that is a plain file fails the backup, so the archive is refused with the reason", async () => {
  const { host, base, events } = rig((dest) => ON(dest));
  const plain = join(base, "plain");
  writeFileSync(plain, "");
  writeFileSync(join(base, "repo/.alinery/config.toml"), ON(plain));
  await expect(host.beforeArchive()).rejects.toThrow(/the backup before the archive failed: .*not a directory.*the task was not archived/);
  expect(events).toEqual([]);
});

test("manual backup is refused up front when off or unusable, and runs when ready", async () => {
  const off = rig((d) => ON(d).replace("enabled = true", "enabled = false"));
  expect(() => off.host.startManual()).toThrow(/disabled/);
  const bad = rig(() => '[backup]\nenabled = true\ndestination = "/no/such/folder"\n');
  expect(() => bad.host.startManual()).toThrow();
  const ok = rig(ON);
  const done = await ok.runner.finished(ok.host.startManual());
  expect(done.state).toBe(JobState.DONE);
  expect(done.result).toMatchObject({ case: "backup", value: { trigger: "manual", alineryVersion: "7.7.7" } });
  expect(existsSync((done.result.value as { path: string }).path)).toBe(true);
});

test("an automatic trigger becomes one backup job after the debounce", async () => {
  const { host, runner, dest } = rig((d) => ON(d).replace("trigger_pre_archive = true", "trigger_post_artifact_change = true"));
  for (let i = 0; i < 5; i++) host.publish("post_artifact_change");
  for (let i = 0; i < 200 && !runner.busy(JobKind.BACKUP); i++) await Bun.sleep(10);
  expect(runner.busy(JobKind.BACKUP)).toBe(true);
  for (let i = 0; i < 300 && runner.busy(JobKind.BACKUP); i++) await Bun.sleep(10);
  expect(readdirSync(dest).filter((n) => n.endsWith(".zip"))).toHaveLength(1);
});
