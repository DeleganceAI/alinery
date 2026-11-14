// What a session wrote, read back (plan S4.4): the scrollback beside its meta, and the Vinculum journal. Ports history.rs.
// The path checks are the point: `.alinery/` lives inside the repository, so a clone can carry
// a scrollback, a chunk or a journal as a git symlink aimed anywhere this process can read.
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { replayRanges } from "../terminal.ts";
import { DomainError } from "../platform/lock.ts";
import { type Json, metaPathOf } from "./sessionOps.ts";
import { alineryDir, artifactsDir, readTask, safeComponent, sessionsDir } from "./taskFiles.ts";

export const HISTORY_REPLAY_BYTES = 8 * 1024 * 1024;
export const HISTORY_WINDOW_MAX = 1024 * 1024;
export const VINCULUM_WINDOW_DEFAULT = 256 * 1024;
export const VINCULUM_WINDOW_MAX = 8 * 1024 * 1024;

const rootDir = (repo: string) => join(alineryDir(repo), "sessions");
const dirOf = (repo: string, slug: string) => (slug ? sessionsDir(repo, slug) : rootDir(repo));

const isRegular = (path: string) => lstatSync(path, { throwIfNoEntry: false })?.isFile() ?? false;

function readWindow(path: string, offset: number, limit: number): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(limit);
    const n = readSync(fd, buf, 0, limit, offset);
    return buf.subarray(0, n);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

type Part = { path: string; start: number; len: number };

/** The scrollback as parts: one file, or a directory of numbered chunks in order. */
function historyParts(path: string): { parts: Part[]; length: number } {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (st?.isSymbolicLink()) throw new DomainError("failed_precondition", `history path is a symlink: ${path}`);
  if (!st?.isDirectory()) {
    const len = st?.isFile() ? st.size : 0;
    return { parts: [{ path, start: 0, len }], length: len };
  }
  const chunks = readdirSync(path)
    .filter((name) => /^\d+$/.test(name) && isRegular(join(path, name)))
    .map((name) => ({ index: Number(name), path: join(path, name) }))
    .sort((a, b) => a.index - b.index);
  let start = 0;
  const parts = chunks.map((c) => {
    const len = statSync(c.path).size;
    const part = { path: c.path, start, len };
    start += len;
    return part;
  });
  return { parts, length: start };
}

function readParts(parts: Part[], offset: number, limit: number): Buffer {
  const out: Buffer[] = [];
  let remaining = limit;
  for (const part of parts) {
    if (remaining <= 0) break;
    const end = part.start + part.len;
    if (offset >= end) continue;
    const local = Math.max(0, offset - part.start);
    const bytes = readWindow(part.path, local, Math.min(remaining, part.len - local));
    remaining -= bytes.length;
    out.push(bytes);
  }
  return Buffer.concat(out);
}

function readMetaChecked(repo: string, slug: string, id: string): Json {
  let meta: Json;
  try {
    meta = JSON.parse(readFileSync(metaPathOf(repo, slug, id), "utf8")) as Json;
  } catch (e) {
    throw new DomainError("not_found", `read ${metaPathOf(repo, slug, id)}: ${(e as Error).message}`);
  }
  if (meta.id !== id) throw new DomainError("failed_precondition", `session metadata id '${String(meta.id)}' does not match '${id}'`);
  return meta;
}

/** The scrollback path of a session whose meta proves it exists, and which resolves inside `.alinery`. */
function ownedHistory(repo: string, slug: string, id: string): string {
  if (safeComponent(id) !== id) throw new DomainError("invalid_argument", `invalid session_id '${id}'`);
  if (slug) {
    if (safeComponent(slug) !== slug) throw new DomainError("invalid_argument", `invalid task_slug '${slug}'`);
    if (!readTask(repo, slug)) throw new DomainError("not_found", `read task ${slug}: missing task.md`);
  }
  readMetaChecked(repo, slug, id);
  const history = join(dirOf(repo, slug), `${id}.scrollback`);
  // A missing scrollback is the normal early state; one that resolves outside `.alinery` is not.
  try {
    if (!realpathSync(history).startsWith(`${realpathSync(alineryDir(repo))}/`)) throw new DomainError("failed_precondition", `session history escapes the repo: ${history}`);
  } catch (e) {
    if (e instanceof DomainError) throw e;
  }
  return history;
}

export type History = { data: Buffer; length: number; nextOffset: number; eof: boolean };

/**
 * With `offset` and `limit`: that window of raw bytes (at most 1 MiB). With neither: the tail of the scrollback, 8 MiB at
 * most, with terminal queries left out as an attach replay leaves them (S3.4). Rust drew the tail's final screen with a
 * vt100 emulator first; xterm draws these bytes the same way, so the screen is the same, and its scrollback is kept.
 */
export function readHistory(repo: string, slug: string, id: string, offset?: number, limit?: number): History {
  if ((offset === undefined) !== (limit === undefined)) throw new DomainError("invalid_argument", "offset and limit must be provided together");
  const { parts, length } = historyParts(ownedHistory(repo, slug, id));
  if (offset !== undefined && limit !== undefined) {
    const data = readParts(parts, offset, Math.min(limit, HISTORY_WINDOW_MAX));
    return { data, length, nextOffset: offset + data.length, eof: offset + data.length >= length };
  }
  const bytes = readParts(parts, Math.max(0, length - HISTORY_REPLAY_BYTES), HISTORY_REPLAY_BYTES);
  const data = Buffer.concat(replayRanges(bytes).map(([a, b]) => bytes.subarray(a, b)));
  return { data, length: 0, nextOffset: 0, eof: false };
}

// ---- the Vinculum journal ----------------------------------------------------------------------------------------------

/**
 * The newest journal of a session by filename (`<iso-timestamp>_<uuidv7>.jsonl`, both halves monotonic), never by mtime:
 * the title record is rewritten in place. A link, and a file with a second hard link, is no journal we wrote.
 */
export function newestVinculumJsonl(dir: string): string | undefined {
  let best: string | undefined;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const st = lstatSync(join(dir, name), { throwIfNoEntry: false });
    if (!st?.isFile() || st.nlink !== 1) continue;
    if (best === undefined || best < name) best = name;
  }
  return best === undefined ? undefined : join(dir, best);
}

function vinculumDir(repo: string, slug: string, id: string): string {
  if (slug && safeComponent(slug) !== slug) throw new DomainError("invalid_argument", `invalid task_slug '${slug}'`);
  if (safeComponent(id) !== id) throw new DomainError("invalid_argument", `invalid session_id '${id}'`);
  readMetaChecked(repo, slug, id);
  const dir = join(dirOf(repo, slug), `${id}.vinculum`);
  let resolved: string;
  try {
    resolved = realpathSync(dir);
  } catch {
    return dir; // Vinculum writes nothing until its first assistant message
  }
  if (!resolved.startsWith(`${realpathSync(alineryDir(repo))}/`)) throw new DomainError("failed_precondition", `session dir escapes the repo: ${resolved}`);
  return resolved;
}

export type VinculumWindow = { data: Buffer; start: number; end: number; length: number };

/** The rows ending at `end` (the tail when unset), about `want` bytes backward; `data` opens on a row boundary. */
export function readVinculumWindow(repo: string, slug: string, id: string, endAt?: number, wantBytes?: number): VinculumWindow {
  const path = newestVinculumJsonl(vinculumDir(repo, slug, id));
  if (!path) return { data: Buffer.alloc(0), start: 0, end: 0, length: 0 };
  // One handle for the size and every read: re-opening let the checked path become a link in between.
  const fd = openSync(path, "r");
  try {
    const length = statSync(path).size;
    const end = Math.min(endAt ?? length, length);
    let want = Math.min(Math.max(wantBytes ?? VINCULUM_WINDOW_DEFAULT, 1), VINCULUM_WINDOW_MAX);
    for (;;) {
      const from = Math.max(0, end - want);
      const buf = Buffer.alloc(end - from);
      const n = readSync(fd, buf, 0, buf.length, from);
      const data = buf.subarray(0, n);
      if (from === 0) return { data, start: 0, end, length };
      // The last byte is the newline ending its own final row; scanning it would return an empty page forever.
      const index = data.subarray(0, Math.max(0, data.length - 1)).indexOf(0x0a);
      if (index >= 0) return { data: data.subarray(index + 1), start: from + index + 1, end, length };
      if (want >= VINCULUM_WINDOW_MAX) return { data, start: from, end, length };
      want = Math.min(want * 2, VINCULUM_WINDOW_MAX);
    }
  } finally {
    closeSync(fd);
  }
}

/** True when the session's phase artifact exists and is not empty. A content feature, not a completion signal. */
export function sessionArtifactReady(repo: string, slug: string, id: string): boolean {
  try {
    const name = String(JSON.parse(readFileSync(metaPathOf(repo, slug, id), "utf8")).artifact ?? "");
    if (!slug || !name || name.startsWith("/") || name.split("/").some((p) => p === ".." || p === "")) return false;
    const st = statSync(join(artifactsDir(repo, slug), name));
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}
