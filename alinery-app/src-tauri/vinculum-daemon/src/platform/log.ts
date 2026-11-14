// The process log next to `app.toml` (`logs/alinery.log`), ported from alinery-core/src/log.rs: the same
// line format, the same flock on `alinery.log.lock`, the same 1 MB x 5 rotation. The app, the daemon
// and alinery-mcp append to one file, so the lock and the format are shared, not similar. Appending
// never throws: a log that cannot be written is dropped.
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { tryLockExclusive } from "./lock.ts";

const ROTATE_BYTES = 1_000_000;
const LINE_CAP = 4096;
const TRUNCATED = " …truncated";
const LOCK_ATTEMPTS = 10;
const LOCK_SLEEP_MS = 50;
const PROC_LABEL = "alinery-vinculum-daemon";

export const logsDir = (appConfig: string) => join(dirname(appConfig), "logs");
export const logPath = (appConfig: string) => join(logsDir(appConfig), "alinery.log");
const logLockPath = (appConfig: string) => join(logsDir(appConfig), "alinery.log.lock");

const isControl = (n: number) => n <= 0x1f || n === 0x7f || (n >= 0x80 && n <= 0x9f);

function escape(text: string, inQuotes: boolean): string {
  let out = "";
  for (const c of text) {
    const n = c.codePointAt(0) as number;
    if (c === "\\" && inQuotes) out += "\\\\";
    else if (c === '"' && inQuotes) out += '\\"';
    else if (c === "\n") out += "\\n";
    else if (c === "\r") out += "\\r";
    else if (c === "\t") out += "\\t";
    else if (isControl(n)) out += `\\x${n.toString(16).padStart(2, "0")}`;
    else out += c;
  }
  return out;
}

/** log.rs quote_log_value: a value that may hold spaces or control characters, on one line. */
export const quoteLogValue = (value: string) => `"${escape(value, true)}"`;

/** log.rs format_rfc3339_utc. */
export const rfc3339Utc = (at: Date) => `${at.toISOString().slice(0, 19)}Z`;

function capLine(line: string): string {
  if (Buffer.byteLength(line) <= LINE_CAP) return line;
  let cut = LINE_CAP - Buffer.byteLength(TRUNCATED);
  // Back off to a character boundary, as Rust's is_char_boundary loop does.
  const bytes = Buffer.from(line);
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--;
  return bytes.subarray(0, cut).toString("utf8") + TRUNCATED;
}

function rotate(log: string) {
  const n = (i: number) => `${log}.${i}`;
  rmSync(n(4), { force: true });
  for (const i of [3, 2, 1]) renameIfPresent(n(i), n(i + 1));
  renameIfPresent(log, n(1));
}

function renameIfPresent(from: string, to: string) {
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

function append(appConfig: string, level: string, message: string) {
  try {
    const line = capLine(escape(`${rfc3339Utc(new Date())} ${level.padEnd(9)} pid=${process.pid} proc=${PROC_LABEL} ${message}`, false));
    mkdirSync(logsDir(appConfig), { recursive: true });
    let lock = null;
    for (let i = 0; i < LOCK_ATTEMPTS && !lock; i++) {
      lock = tryLockExclusive(logLockPath(appConfig));
      if (!lock) Bun.sleepSync(LOCK_SLEEP_MS);
    }
    if (!lock) return;
    try {
      const path = logPath(appConfig);
      const size = statSync(path, { throwIfNoEntry: false })?.size;
      if (size !== undefined && size + Buffer.byteLength(line) + 1 > ROTATE_BYTES) rotate(path);
      appendFileSync(path, `${line}\n`);
    } finally {
      lock.release();
    }
  } catch {
    /* a log that cannot be written is dropped */
  }
}

export const appendInfo = (appConfig: string, message: string) => append(appConfig, "info", message);
export const appendException = (appConfig: string, message: string) => append(appConfig, "exception", message);
