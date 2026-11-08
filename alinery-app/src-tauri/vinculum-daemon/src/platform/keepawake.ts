// Settings > General > Misc > "Keep this computer awake" (O9, decided (b)): block idle system sleep while a session is live.
// The daemon owns the hold, because quit-leave-running destroys the app and keeps the daemon. Idle-only by construction: the
// display can still sleep, closing the lid still sleeps, and an explicit sleep still works.
//
// The hold is a child process that ends with the daemon, with no cleanup code of ours running, so `kill -9` of the daemon
// cannot leave the machine awake:
//   macOS  `caffeinate -i -w <daemon pid>`: -i is PreventUserIdleSystemSleep; -w makes it exit when that pid does.
//   Linux  `systemd-inhibit --what=idle ... cat` with a stdin pipe the daemon holds; the daemon dying closes the pipe, which
//          ends `cat`, which ends `systemd-inhibit` and its logind lock. (`--what` is only `idle`: the default also blocks suspend.)
import { existsSync, readFileSync } from "node:fs";
import { appendException, appendInfo, quoteLogValue } from "./log.ts";
import { spawnDetached, signalChild } from "./process.ts";
import { parseGlobal } from "../domain/settings.ts";
import { tomlParse } from "../sync/parsers/serde.ts";

const POLL_MS = 1_000;
/** A hold that could not start (no logind, no tool) is not tried again for this long, so it is not a fork a second. */
const RETRY_MS = 30_000;
const SPAWN_CHECK_MS = 50;

/** The hold's command line for this platform; undefined where there is no tool for it. Absolute paths only, no PATH search. */
export function holdCommand(platform: NodeJS.Platform, daemonPid: number): string[] | undefined {
  if (platform === "darwin") return existsSync("/usr/bin/caffeinate") ? ["/usr/bin/caffeinate", "-i", "-w", String(daemonPid)] : undefined;
  if (platform !== "linux") return undefined;
  const inhibit = ["/usr/bin/systemd-inhibit", "/bin/systemd-inhibit"].find((p) => existsSync(p));
  const cat = ["/bin/cat", "/usr/bin/cat"].find((p) => existsSync(p));
  return inhibit && cat ? [inhibit, "--what=idle", "--who=Alinery", "--why=A session is running", "--mode=block", cat] : undefined;
}

/** The pref as `load_global_settings` reads it: a missing, unreadable, refused or half-written app.toml reads as off, so a corrupt file never keeps the machine awake. */
export function keepAwakeSetting(appConfig: string): boolean {
  try {
    const text = readFileSync(appConfig, "utf8");
    if (parseGlobal(text) === undefined) return false;
    const global = (tomlParse(text) as { global?: { power?: { keep_awake?: unknown } } }).global;
    return global?.power?.keep_awake === true;
  } catch {
    return false;
  }
}

export type KeepAwakeOptions = {
  appConfig: string;
  /** Sessions that are not exited, counted only while the pref is on. */
  liveSessions: () => number;
  /** Replaces `holdCommand`; a test passes a stand-in so it needs neither caffeinate nor logind. */
  command?: () => string[] | undefined;
  pollMs?: number;
  retryMs?: number;
};

export class KeepAwake {
  private child: ReturnType<typeof spawnDetached> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastError: string | undefined;
  private retryAt = 0;
  private stopped = false;

  constructor(private readonly o: KeepAwakeOptions) {}

  /** The hold's pid while it is held. */
  get holdPid(): number | undefined {
    return this.child?.pid;
  }

  /** Polls even when the pref is off, so a later toggle in Settings is seen. */
  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.o.pollMs ?? POLL_MS);
    this.timer.unref?.();
  }

  tick() {
    if (this.stopped) return;
    const want = keepAwakeSetting(this.o.appConfig) && this.o.liveSessions() > 0;
    if (want && !this.child) void this.acquire();
    else if (!want && this.child) this.drop(true);
  }

  private async acquire() {
    if (Date.now() < this.retryAt) return;
    const command = (this.o.command ?? (() => holdCommand(process.platform, process.pid)))();
    if (!command) return this.unavailable(`no inhibit tool on ${process.platform}`);
    let child: ReturnType<typeof spawnDetached>;
    try {
      child = spawnDetached(command, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    } catch (error) {
      return this.unavailable(`spawn ${command[0]}: ${error}`);
    }
    this.child = child;
    // A refused lock (no logind, bad bus) makes systemd-inhibit exit at once.
    void child.exited.then((code) => {
      if (this.child !== child) return;
      this.child = undefined;
      if (!this.stopped) this.unavailable(`${command[0]} exited with ${code}`);
    });
    await new Promise((resolve) => setTimeout(resolve, SPAWN_CHECK_MS));
    if (this.child === child) {
      this.lastError = undefined;
      appendInfo(this.o.appConfig, "power.idle-inhibit acquired");
    }
  }

  private unavailable(error: string) {
    this.retryAt = Date.now() + (this.o.retryMs ?? RETRY_MS);
    // Logged once per distinct error, so a tool that can never work does not write a line a poll.
    if (this.lastError === error) return;
    this.lastError = error;
    appendException(this.o.appConfig, `power.idle-inhibit unavailable err=${quoteLogValue(error)}`);
  }

  private drop(log: boolean) {
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    // Closing stdin ends the Linux hold's `cat` the ordinary way; the signal covers a tool that ignores it.
    try {
      void child.stdin?.end?.();
    } catch {
      /* already closed */
    }
    signalChild(child, "SIGKILL", "keepawake-release");
    if (log) appendInfo(this.o.appConfig, "power.idle-inhibit released");
  }

  /** Stop polling and end the hold. Call before every `process.exit` that can run after `start`. Idempotent. */
  release() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.drop(true);
  }
}
