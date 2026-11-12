// The daemons on this machine, readable by anyone on it. The RPC socket is owner-only and every call needs a token, so an app
// that holds no token (a coworker's, on a shared box) cannot ask a daemon who started it; it reads that daemon's record here.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../platform/fs.ts";

/** World-writable with the sticky bit, as /tmp is: each daemon replaces or removes only its own record. */
export const BOX_DIR = "/var/tmp/alinery-daemons";

export type BoxRecord = {
  repo: string;
  lane: string;
  pid: number;
  /** The login the daemon runs as. */
  osUser: string;
  /** How the starting app described the person and machine that started it, e.g. "nyx on MacBook". */
  startedBy: string;
  startedAtMs: number;
  version: string;
  protocol: number;
};

const recordPath = (dir: string, repo: string, lane: string) => join(dir, `${createHash("sha256").update(`${repo}\0${lane}`).digest("hex").slice(0, 16)}.json`);

/** Best effort: a box where the directory cannot be made only loses the display, never the daemon. */
export function writeBoxRecord(record: BoxRecord, dir = BOX_DIR): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o1777 });
    try {
      chmodSync(dir, 0o1777); // the umask cut the mode; only the directory's owner can fix it, so another's refusal is fine
    } catch {
      /* not ours */
    }
    writeAtomic(recordPath(dir, record.repo, record.lane), JSON.stringify(record), 0o644);
  } catch (error) {
    console.error(`box record not written: ${(error as Error).message}`);
  }
}

export function removeBoxRecord(repo: string, lane: string, dir = BOX_DIR): void {
  rmSync(recordPath(dir, repo, lane), { force: true });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"; // another user's live process
  }
}

/** Every record whose process is still running. A daemon that crashed leaves its record; the pid check hides it. */
export function listBoxRecords(dir = BOX_DIR): BoxRecord[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const records: BoxRecord[] = [];
  for (const name of names) {
    try {
      const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as BoxRecord;
      if (typeof record.repo === "string" && Number.isInteger(record.pid) && alive(record.pid)) records.push(record);
    } catch {
      /* torn or foreign file */
    }
  }
  return records.sort((a, b) => a.repo.localeCompare(b.repo));
}
