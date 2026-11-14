// The writes to a session's meta and name files (plan S4.4): the name, the read marks of its notifications, the
// archived stamp. Ports session_name.rs and session_actions.rs; the shared conformance cases pin the bytes.
// Every write is a read-modify-write of the fields it names, so it cannot clobber the ones the runner writes at the
// same time (it runs in the same process, in one tick, with no await between the read and the write).
import { closeSync, lstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../platform/fs.ts";
import { DomainError, withTaskMutation } from "../platform/lock.ts";
import { loadEngineState } from "./executionStore.ts";
import { alineryDir, readTask, safeComponent, sessionsDir, taskMdPath, validateRetainedFile } from "./taskFiles.ts";

export type Json = Record<string, unknown>;
export type NameSource = "auto" | "user";
export type SessionName = { name: string; source: NameSource };

export const isVinculumSession = (harness: unknown) => harness === "vinculum";

const MAX_NAME_BYTES = 4096;
const MAX_META_BYTES = 1024 * 1024;

export const rootSessionsDir = (repo: string) => join(alineryDir(repo), "sessions");
export const metaPathOf = (repo: string, slug: string, id: string) => join(slug ? sessionsDir(repo, slug) : rootSessionsDir(repo), `${id}.meta.json`);
export const namePathOf = (repo: string, slug: string, id: string) => join(slug ? sessionsDir(repo, slug) : rootSessionsDir(repo), `${id}.name.json`);

/** `validate_session_name`: the trimmed name, or Rust's refusal. */
export function validateSessionName(input: string): string {
  const name = input.trim();
  if (!name) throw new DomainError("invalid_argument", "session name must not be empty");
  if (/[\p{Cc}\u2028\u2029]/u.test(name)) throw new DomainError("invalid_argument", "session name must be single-line text without control characters");
  if ([...name].length > 40) throw new DomainError("invalid_argument", "session name must be at most 40 characters");
  return name;
}

function boundedRead(path: string, limit: number, what: string): Buffer {
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(limit + 1);
      const n = readSync(fd, buf, 0, buf.length, 0);
      if (n > limit) throw new DomainError("failed_precondition", `${what} exceeds its size limit`);
      return buf.subarray(0, n);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    if (e instanceof DomainError) throw e;
    throw new DomainError("failed_precondition", `${what} is unreadable`);
  }
}

/** The meta of the session a name or a notification mark may touch: Rust's `validate_target`. */
function targetMeta(repo: string, slug: string, id: string): Json {
  if (safeComponent(id) !== id) throw new DomainError("invalid_argument", "invalid task slug or session id");
  const path = metaPathOf(repo, slug, id);
  if (slug) {
    if (safeComponent(slug) !== slug) throw new DomainError("invalid_argument", "invalid task slug or session id");
    validateRetainedFile(repo, taskMdPath(repo, slug));
    const task = readTask(repo, slug);
    if (!task) throw new DomainError("failed_precondition", "task record is unavailable");
    if (task.slug !== slug) throw new DomainError("failed_precondition", "task slug does not match retained target");
  }
  validateRetainedFile(repo, path);
  let meta: Json;
  try {
    meta = JSON.parse(boundedRead(path, MAX_META_BYTES, "session metadata").toString("utf8")) as Json;
  } catch (e) {
    if (e instanceof DomainError) throw e;
    throw new DomainError("failed_precondition", "invalid session metadata");
  }
  if (meta.id !== id) throw new DomainError("failed_precondition", slug ? "session metadata id does not match retained target" : "invalid task slug or session id");
  if (!slug && (!isVinculumSession(meta.harness) || meta.generic !== true)) throw new DomainError("invalid_argument", "invalid task slug or session id");
  return meta;
}

function parseName(bytes: Buffer): SessionName {
  let v: unknown;
  try {
    v = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new DomainError("failed_precondition", "invalid session name data");
  }
  const o = v as Json | null;
  if (!o || typeof o !== "object" || Array.isArray(o) || typeof o.name !== "string" || (o.source !== "auto" && o.source !== "user") || Object.keys(o).some((k) => k !== "name" && k !== "source")) {
    throw new DomainError("failed_precondition", "invalid session name data");
  }
  if (validateSessionName(o.name) !== o.name) throw new DomainError("failed_precondition", "stored session name must be trimmed");
  return { name: o.name, source: o.source };
}

function readNameBytes(repo: string, slug: string, id: string): Buffer | undefined {
  const path = namePathOf(repo, slug, id);
  try {
    lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new DomainError("failed_precondition", "session naming data is unreadable");
  }
  validateRetainedFile(repo, path);
  return boundedRead(path, MAX_NAME_BYTES, "session naming data");
}

/** The session that owns an execution: the engine's own record, else the record Rust-era writers kept in `execution.json`. */
function ownerOf(repo: string, slug: string, executionId: string): string | undefined {
  const load = loadEngineState(repo, slug);
  const engine = load.kind === "stored" || load.kind === "converted" ? (load.state.executions.get(executionId)?.sessionId ?? undefined) : undefined;
  if (engine) return engine;
  try {
    const file = JSON.parse(readFileSync(join(alineryDir(repo), "tasks", slug, "execution.json"), "utf8")) as { executions?: Record<string, { owner_session_id?: string }> };
    return file.executions?.[executionId]?.owner_session_id;
  } catch {
    return undefined;
  }
}

export type NameOutcome = { status: "saved" | "unchanged"; value: SessionName };

/**
 * `set_session_name`. A person's rename always lands. An automatic name never replaces any name on a task session (it
 * keeps its first), and on a chat thread only a person's name stops it, since the title follows the conversation.
 */
export async function setSessionName(repo: string, slug: string, id: string, input: string, source: NameSource): Promise<NameOutcome> {
  const name = validateSessionName(input);
  targetMeta(repo, slug, id);
  return await withTaskMutation(repo, "rename session", () => {
    const meta = targetMeta(repo, slug, id);
    if (source === "auto" && typeof meta.execution_id === "string" && meta.execution_id !== "") {
      if (!existsExecution(repo, slug)) throw new DomainError("failed_precondition", "session execution ownership is unavailable");
      if (ownerOf(repo, slug, meta.execution_id) !== id) throw new DomainError("failed_precondition", "stale session execution owner");
    }
    const path = namePathOf(repo, slug, id);
    if (source === "auto") {
      const bytes = readNameBytes(repo, slug, id);
      if (bytes) {
        const existing = parseName(bytes);
        if (!(slug === "" && existing.source === "auto")) return { status: "unchanged" as const, value: existing };
      }
    } else if (lstatOk(path)) {
      validateRetainedFile(repo, path);
      // A rename may replace invalid or oversized data, but not a file that cannot be read and written.
      try {
        closeSync(openSync(path, "r+"));
      } catch {
        throw new DomainError("failed_precondition", "session naming data is not readable and writable");
      }
    }
    const value: SessionName = { name, source };
    try {
      writeAtomic(path, JSON.stringify(value));
    } catch {
      throw new DomainError("internal", "could not save session name; previous name retained");
    }
    return { status: "saved" as const, value };
  });
}

function existsExecution(repo: string, slug: string): boolean {
  try {
    validateRetainedFile(repo, join(alineryDir(repo), "tasks", slug, "execution.json"));
    return true;
  } catch {
    return false;
  }
}

function lstatOk(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// ---- notifications and the archived stamp ----------------------------------------------------------------------------

/** Rewrites only the fields `mutate` touches, from the file as it is now. */
export function stampMeta(repo: string, slug: string, id: string, mutate: (meta: Json) => void): void {
  const path = metaPathOf(repo, slug, id);
  const meta = JSON.parse(readFileSync(path, "utf8")) as Json;
  mutate(meta);
  writeAtomic(path, JSON.stringify(meta));
}

const u64 = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
const completionCheckpoint = (m: Json) => u64((m.semantic as Json | undefined)?.phase_completed_at);
const exitCheckpoint = (m: Json) => (typeof m.exit_code === "number" && m.exit_code !== 0 ? u64(m.ended_at) : undefined);
const advances = (m: Json, field: string, checkpoint: number | undefined) => checkpoint !== undefined && (u64(m[field]) === undefined || checkpoint > (u64(m[field]) as number));
const stamp = (m: Json, field: string, checkpoint: number | undefined) => {
  if (checkpoint !== undefined) m[field] = Math.max(u64(m[field]) ?? 0, checkpoint);
};

function notificationMeta(repo: string, slug: string, id: string): Json {
  if (safeComponent(slug) !== slug || safeComponent(id) !== id) throw new DomainError("invalid_argument", slug === "" || safeComponent(slug) !== slug ? "invalid task slug" : "invalid session id");
  try {
    statSync(metaPathOf(repo, slug, id));
    return JSON.parse(readFileSync(metaPathOf(repo, slug, id), "utf8")) as Json;
  } catch (e) {
    throw new DomainError("not_found", (e as Error).message);
  }
}

/** `mark_notification_read`: the completion and the failed-exit notification of a session, both. Returns true when the file changed. */
export function markNotificationRead(repo: string, slug: string, id: string): boolean {
  const persisted = notificationMeta(repo, slug, id);
  const completion = completionCheckpoint(persisted);
  const exit = exitCheckpoint(persisted);
  if (!advances(persisted, "notification_read_at", completion) && !advances(persisted, "exit_notification_read_at", exit)) return false;
  stampMeta(repo, slug, id, (m) => {
    stamp(m, "notification_read_at", completion);
    stamp(m, "exit_notification_read_at", exit);
  });
  return true;
}

/** `mark_exit_notification_read`: only the failed-exit one. */
export function markExitNotificationRead(repo: string, slug: string, id: string): boolean {
  const persisted = notificationMeta(repo, slug, id);
  const exit = exitCheckpoint(persisted);
  if (!advances(persisted, "exit_notification_read_at", exit)) return false;
  stampMeta(repo, slug, id, (m) => stamp(m, "exit_notification_read_at", exit));
  return true;
}

/** `clear_session_notifications_in`: mark each session read, and keep the suppression the person chose. */
export function clearSessionNotifications(repo: string, refs: { slug: string; id: string; suppression?: { notice: string; occurrence: string } }[], exitOnly = false): void {
  for (const ref of refs) {
    if (exitOnly) markExitNotificationRead(repo, ref.slug, ref.id);
    else markNotificationRead(repo, ref.slug, ref.id);
    if (ref.suppression) {
      notificationMeta(repo, ref.slug, ref.id);
      stampMeta(repo, ref.slug, ref.id, (m) => {
        m.notification_suppression = { notice: ref.suppression?.notice, occurrence: ref.suppression?.occurrence };
      });
    }
  }
}

/** `stamp_session_archived`: `archived` only. */
export function stampSessionArchived(repo: string, slug: string, id: string): void {
  stampMeta(repo, slug, id, (m) => {
    m.archived = true;
  });
}
