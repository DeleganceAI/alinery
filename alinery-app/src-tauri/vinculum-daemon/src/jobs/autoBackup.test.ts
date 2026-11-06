import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackupSettings, BackupTrigger } from "../domain/backup.ts";
import type { Timers } from "../sync/store.ts";
import { AutoBackup } from "./autoBackup.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A timer the test advances by hand, so the 2 s debounce is checked without waiting for it. */
function clock(): Timers & { advance(ms: number): void; pending(): number } {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    set: (fn, ms) => {
      timers.set(next, { at: now + ms, fn });
      return next++;
    },
    clear: (h) => void timers.delete(h as number),
    pending: () => timers.size,
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
  };
}

function rig(config: string, debounceMs = 2000) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "alinery-auto-")));
  dirs.push(base);
  const repo = join(base, "repo");
  const dest = join(base, "dest");
  mkdirSync(join(repo, ".alinery"), { recursive: true });
  mkdirSync(dest);
  const writeConfig = (text: string) => writeFileSync(join(repo, ".alinery", "config.toml"), text.replace("DEST", dest));
  writeConfig(config);
  const started: { settings: BackupSettings; trigger: BackupTrigger }[] = [];
  let busy = false;
  const timers = clock();
  const auto = new AutoBackup({ repo, appConfig: join(base, "app.toml"), start: (settings, trigger) => started.push({ settings, trigger }), busy: () => busy, debounceMs, timers });
  return { auto, started, timers, writeConfig, setBusy: (b: boolean) => (busy = b) };
}

const ALL = '[backup]\ndestination = "DEST"\nenabled = true\nretention = 4\ntrigger_pre_archive = true\ntrigger_post_artifact_change = true\ntrigger_post_push_commit = true\n';

test("a burst of publishes is one backup, taken after the burst's end", () => {
  const { auto, started, timers } = rig(ALL);
  for (let i = 0; i < 10; i++) {
    auto.publish("post_artifact_change");
    timers.advance(500); // each publish pushes the deadline out
  }
  expect(started).toHaveLength(0);
  timers.advance(1499);
  expect(started).toHaveLength(0);
  timers.advance(1);
  expect(started).toHaveLength(1);
  expect(started[0]?.trigger).toBe("post_artifact_change");
  expect(started[0]?.settings.retention).toBe(4);
  timers.advance(10_000);
  expect(started).toHaveLength(1);
});

test("the latest trigger of a burst is the one the backup records", () => {
  const { auto, started, timers } = rig(ALL);
  auto.publish("post_artifact_change");
  auto.publish("post_push_commit");
  timers.advance(2000);
  expect(started.map((s) => s.trigger)).toEqual(["post_push_commit"]);
});

test("a feature that is off, no destination, or a trigger whose flag is off starts nothing and arms nothing", () => {
  for (const config of [
    ALL.replace("enabled = true", "enabled = false"),
    ALL.replace('destination = "DEST"', 'destination = ""'),
    ALL.replace("trigger_post_push_commit = true", "trigger_post_push_commit = false"),
    "",
  ]) {
    const { auto, started, timers } = rig(config);
    auto.publish("post_push_commit");
    expect(timers.pending()).toBe(0);
    timers.advance(10_000);
    expect(started).toHaveLength(0);
  }
});

test("a run still going when the deadline passes waits another window, never a second queued behind it", () => {
  const { auto, started, timers, setBusy } = rig(ALL);
  setBusy(true);
  auto.publish("pre_archive");
  timers.advance(2000);
  timers.advance(2000);
  expect(started).toHaveLength(0);
  setBusy(false);
  timers.advance(2000);
  expect(started).toHaveLength(1);
});

test("the settings are read again when the deadline passes: a person who turned the feature off during the window gets no backup", () => {
  const { auto, started, timers, writeConfig } = rig(ALL);
  auto.publish("pre_archive");
  writeConfig(ALL.replace("enabled = true", "enabled = false"));
  timers.advance(2000);
  expect(started).toHaveLength(0);
});
