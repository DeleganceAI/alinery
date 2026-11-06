import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { firstLine } from "../firstLine.testutil.ts";
import { holdCommand, KeepAwake, keepAwakeSetting } from "./keepawake.ts";

const dir = mkdtempSync(join(tmpdir(), "daemon-keepawake-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const appToml = (name: string, text: string | undefined) => {
  const path = join(dir, name, "app.toml");
  mkdirSync(join(dir, name), { recursive: true });
  if (text !== undefined) writeFileSync(path, text);
  return path;
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (cond: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(20);
  return cond();
};

test("the pref reads as off for every file the Rust loader refuses, and on only for a true bool", () => {
  expect(keepAwakeSetting(appToml("missing", undefined))).toBe(false);
  expect(keepAwakeSetting(appToml("empty", ""))).toBe(false);
  expect(keepAwakeSetting(appToml("no-power", "[global]\n"))).toBe(false);
  expect(keepAwakeSetting(appToml("unparseable", "[global.power]\nkeep_awake = true\n[global.updates\n"))).toBe(false);
  expect(keepAwakeSetting(appToml("string", '[global.power]\nkeep_awake = "true"\n'))).toBe(false);
  expect(keepAwakeSetting(appToml("on", "[global.power]\nkeep_awake = true\n"))).toBe(true);
  expect(keepAwakeSetting(appToml("off", "[global.power]\nkeep_awake = false\n"))).toBe(false);
  expect(keepAwakeSetting(dir)).toBe(false); // a directory is unreadable
});

test("the hold command is idle-only on each platform", () => {
  const mac = holdCommand("darwin", 4242);
  expect(mac).toEqual(["/usr/bin/caffeinate", "-i", "-w", "4242"]);
  const linux = holdCommand("linux", 4242);
  // Where systemd-inhibit is installed; the sandbox that runs this may not have it.
  if (linux) {
    expect(linux).toContain("--what=idle");
    expect(linux.join(" ")).not.toContain("sleep");
  }
  expect(holdCommand("win32", 1)).toBeUndefined();
});

test("the hold follows the pref and the live-session count, one child at a time", async () => {
  const appConfig = appToml("follow", "[global.power]\nkeep_awake = true\n");
  let live = 0;
  const hold = new KeepAwake({ appConfig, liveSessions: () => live, command: () => ["/bin/cat"], pollMs: 20 });
  hold.start();
  await Bun.sleep(100);
  expect(hold.holdPid).toBeUndefined();
  live = 2;
  expect(await until(() => hold.holdPid !== undefined, 1000)).toBe(true);
  const first = hold.holdPid as number;
  expect(alive(first)).toBe(true);
  await Bun.sleep(100);
  expect(hold.holdPid).toBe(first);
  writeFileSync(appConfig, "[global.power]\nkeep_awake = false\n");
  expect(await until(() => hold.holdPid === undefined, 1000)).toBe(true);
  expect(await until(() => !alive(first), 1000)).toBe(true);
  writeFileSync(appConfig, "[global.power]\nkeep_awake = true\n");
  expect(await until(() => hold.holdPid !== undefined, 1000)).toBe(true);
  const second = hold.holdPid as number;
  hold.release();
  expect(hold.holdPid).toBeUndefined();
  expect(await until(() => !alive(second), 1000)).toBe(true);
}, 15_000);

test("a tool that exits at once is logged once and not respawned inside the retry window", async () => {
  const appConfig = appToml("refused", "[global.power]\nkeep_awake = true\n");
  let spawns = 0;
  const hold = new KeepAwake({
    appConfig,
    liveSessions: () => 1,
    command: () => {
      spawns += 1;
      return ["/usr/bin/false"];
    },
    pollMs: 10,
    retryMs: 60_000,
  });
  hold.start();
  await Bun.sleep(400);
  hold.release();
  expect(spawns).toBe(1);
  expect(hold.holdPid).toBeUndefined();
}, 15_000);

async function fixture(appConfig: string, mode: "cat" | "real") {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "keepawake.fixture.ts"), appConfig, mode], { stdout: "pipe", stderr: "inherit" });
  const line = await firstLine(child);
  return { child, ...(JSON.parse(line) as { pid: number; hold: number; command: string[] | null }) };
}

test("kill -9 of the daemon ends the hold within a second (a stdin pipe, with another child alive)", async () => {
  const appConfig = appToml("kill9", "[global.power]\nkeep_awake = true\n");
  const run = await fixture(appConfig, "cat");
  expect(alive(run.hold)).toBe(true);
  process.kill(run.pid, "SIGKILL");
  await run.child.exited;
  expect(await until(() => !alive(run.hold), 1000)).toBe(true);
}, 20_000);

test.skipIf(process.platform !== "darwin")("macOS: the real hold is caffeinate's idle-sleep assertion and kill -9 removes it", async () => {
  const appConfig = appToml("caffeinate", "[global.power]\nkeep_awake = true\n");
  const run = await fixture(appConfig, "real");
  expect(run.command).toEqual(["/usr/bin/caffeinate", "-i", "-w", String(run.pid)]);
  const assertions = Bun.spawnSync(["/usr/bin/pmset", "-g", "assertions"]).stdout.toString();
  expect(assertions).toMatch(new RegExp(`pid ${run.hold}\\(caffeinate\\).*PreventUserIdleSystemSleep`));
  expect(assertions).not.toMatch(new RegExp(`pid ${run.hold}\\(caffeinate\\).*PreventSystemSleep`));
  process.kill(run.pid, "SIGKILL");
  await run.child.exited;
  expect(await until(() => !alive(run.hold), 1000)).toBe(true);
  expect(Bun.spawnSync(["/usr/bin/pmset", "-g", "assertions"]).stdout.toString()).not.toContain(`pid ${run.hold}(`);
}, 20_000);

test.skipIf(process.platform !== "darwin")("macOS: turning the pref off, or the last session ending, ends the real hold, which ignores stdin", async () => {
  const appConfig = appToml("caffeinate-drop", "[global.power]\nkeep_awake = true\n");
  let live = 1;
  const hold = new KeepAwake({ appConfig, liveSessions: () => live, pollMs: 60_000 });
  try {
    hold.tick();
    expect(await until(() => hold.holdPid !== undefined, 2000)).toBe(true);
    const first = hold.holdPid as number;
    // caffeinate -w only watches the daemon's pid, so only the SIGKILL in drop() can end it here.
    expect(Bun.spawnSync(["/bin/ps", "-p", String(first), "-o", "comm="]).stdout.toString()).toContain("caffeinate");
    writeFileSync(appConfig, "[global.power]\nkeep_awake = false\n");
    hold.tick();
    expect(await until(() => !alive(first), 2000)).toBe(true);
    writeFileSync(appConfig, "[global.power]\nkeep_awake = true\n");
    hold.tick();
    expect(await until(() => hold.holdPid !== undefined, 2000)).toBe(true);
    const second = hold.holdPid as number;
    live = 0;
    hold.tick();
    expect(await until(() => !alive(second), 2000)).toBe(true);
  } finally {
    hold.release();
  }
}, 20_000);
