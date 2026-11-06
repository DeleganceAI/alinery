// One repository owner (plan S4.11), ported from alinery-core `repo_ownership.rs` onto platform/lock.ts. Lock markers are
// permanent: a lease is held until the daemon exits and its file is never unlinked. Under the task-mutation lock, every
// previous owner and every retained task record is checked before anything is written; a live owner, a lock or socket that
// cannot be inspected, or evidence that cannot be read blocks the whole project. When all owners are stopped, the project's
// tasks (archived ones too) are adopted: history, artifacts and completed work stay, and execution ownership that was in
// flight is marked interrupted, because adoption is not proof that any child stopped.
//
// The shell keeps the read-only half in Rust (`inspect_owners`, `check_available`: the conflict banner and the takeover
// preflight), which names the same evidence; the two must agree on what a lane, a lease and a retained record are.
import { lstatSync, mkdirSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { parsePlaybookMd } from "playbook-engine/src/playbook-md.ts";
import { writeDurable } from "../platform/fs.ts";
import { DomainError, type LockHandle, tryLockExclusive, withTaskMutation } from "../platform/lock.ts";
import { parseTask } from "../sync/parsers/task.ts";
import { alineryDir, definitionIdentity, safeComponent, tasksDir, taskDir } from "./taskFiles.ts";

type Json = Record<string, unknown>;

const LIFECYCLES = new Set(["queued", "starting", "running", "finishing", "completed", "launch_failed", "failed", "interrupted"]);
/** execution.rs `ExecutionLifecycle::holds_capacity`. */
const HOLDS_CAPACITY = new Set(["starting", "running", "finishing", "interrupted"]);
const PROBE_TIMEOUT_MS = 1_000;

/** repo_ownership.rs `validate_lane`. */
export function validateLane(lane: string): void {
  if (lane === "reconciler" || lane.length > 48 || !/^[A-Za-z0-9_-]*$/.test(lane)) throw new DomainError("failed_precondition", `invalid daemon ownership lane ${JSON.stringify(lane)}`);
}

const stem = (lane: string) => (lane === "" ? "alineryd" : `alineryd-${lane}`);
export const laneLockPath = (repo: string, lane: string) => join(alineryDir(repo), `.${stem(lane)}.lock`);
export const laneSocketPath = (repo: string, lane: string) => join(alineryDir(repo), `${stem(lane)}.sock`);
const repoLockPath = (repo: string) => join(alineryDir(repo), ".repo-owner.lock");

const notFound = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const problem = (message: string) => new DomainError("failed_precondition", message);

function lstat(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (notFound(error)) return undefined;
    throw error;
  }
}

/** A lease on one owner marker. A held marker is `repo_busy`; a marker that is not a plain file, or cannot be inspected, blocks. */
function lease(path: string): LockHandle {
  let stat: ReturnType<typeof lstatSync> | undefined;
  try {
    stat = lstat(path);
  } catch (error) {
    throw problem(`inspect project owner lock ${path}: ${error}`);
  }
  if (stat && !stat.isFile()) throw problem(`invalid project owner lock ${path}`);
  let held: LockHandle | null;
  try {
    held = tryLockExclusive(path);
  } catch (error) {
    throw problem(`cannot establish project owner stopped (${path}): ${error}`);
  }
  if (!held) throw new DomainError("repo_busy", `project owner is still running (${path}); stop it before opening this project here`);
  return held;
}

/** `connect_for_ownership_probe`: a connection is a candidate owner, not a verified process. Nothing is sent. */
export function socketReachable(path: string): Promise<boolean> {
  let stat: ReturnType<typeof lstatSync> | undefined;
  try {
    stat = lstat(path);
  } catch (error) {
    throw problem(`inspect owner socket ${path}: ${error}`);
  }
  if (!stat) return Promise.resolve(false);
  if (!stat.isSocket()) throw problem(`invalid owner socket ${path}`);
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(problem(`cannot establish owner socket stopped (${path}): no answer in ${PROBE_TIMEOUT_MS} ms`));
    }, PROBE_TIMEOUT_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
      else reject(problem(`cannot establish owner socket stopped (${path}): ${error}`));
    });
  });
}

function entries(path: string, issues: string[]): Dirent[] {
  let stat: ReturnType<typeof lstatSync> | undefined;
  try {
    stat = lstat(path);
    if (!stat) return [];
    if (!stat.isDirectory()) throw new Error(`invalid ownership directory ${path}`);
    return readdirSync(path, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch (error) {
    issues.push(error instanceof Error && error.message.startsWith("invalid") ? error.message : `read ${path}: ${error}`);
    return [];
  }
}

function regularFile(path: string, what: string) {
  let stat: ReturnType<typeof lstatSync> | undefined;
  try {
    stat = lstat(path);
  } catch (error) {
    throw new Error(`missing or unreadable ${what} ${path}: ${error}`);
  }
  if (!stat) throw new Error(`missing or unreadable ${what} ${path}: not found`);
  if (!stat.isFile()) throw new Error(`invalid ${what} ${path}`);
}

type Retained = { slug: string; path: string; file: Json };

/** execution.rs `read_execution_state` and what `repo_ownership` then uses of it. The fields the daemon reads are checked; the rest is carried as the file has it. */
function readExecutionState(repo: string, slug: string): Json {
  const path = join(taskDir(repo, slug), "execution.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`task execution state unavailable (pre-v2 tasks cannot launch): ${path}: ${error}`);
  }
  let f: Json;
  try {
    f = JSON.parse(text) as Json;
  } catch {
    throw new Error("invalid task execution state");
  }
  const plain = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
  const records = f?.executions;
  if (
    !plain(f) ||
    typeof f.revision !== "number" ||
    !Number.isSafeInteger(f.revision + 1) ||
    typeof f.owning_lane !== "string" ||
    (f.owning_app_config_identity !== undefined && typeof f.owning_app_config_identity !== "string") ||
    typeof f.definition_identity !== "string" ||
    !plain(records) ||
    !Object.values(records).every((r) => plain(r) && typeof r.lifecycle === "string" && LIFECYCLES.has(r.lifecycle) && typeof r.owner_session_id === "string")
  ) {
    throw new Error("invalid task execution state");
  }
  if (f.version !== 1 || !Number.isInteger(f.max_live_sessions) || (f.max_live_sessions as number) <= 0) throw new Error("unsupported or invalid task execution state");
  return f;
}

/** execution.rs `read_task_playbook`: the retained definition must match its recorded identity and parse. */
function checkRetainedPlaybook(repo: string, slug: string, state: Json) {
  const path = join(taskDir(repo, slug), "playbook.md");
  regularFile(path, "task owner file");
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`read retained task definition: ${error}`);
  }
  if (definitionIdentity(source) !== state.definition_identity) throw new Error("retained task definition integrity mismatch");
  const parsed = parsePlaybookMd(source);
  if (!parsed.playbook) throw new Error(`invalid retained task definition: ${JSON.stringify(parsed.diagnostics)}`);
}

/** Independent evidence is collected even when a different record is corrupt; acquisition rejects any issue before it writes. */
function enumerate(repo: string): { lanes: Set<string>; retained: Retained[]; issues: string[] } {
  const lanes = new Set<string>([""]);
  const retained: Retained[] = [];
  const issues: string[] = [];
  for (const entry of entries(alineryDir(repo), issues)) {
    const name = entry.name;
    if (name === ".alineryd-reconciler.lock") continue;
    const lock = /^\.(.*)\.lock$/.exec(name);
    const sock = /\.sock$/.exec(name) ? name.slice(0, -".sock".length) : undefined;
    const candidateStem = lock ? lock[1] : sock;
    if (candidateStem === undefined) continue;
    let lane: string;
    if (candidateStem === "alineryd") lane = "";
    else if (candidateStem.startsWith("alineryd-")) lane = candidateStem.slice("alineryd-".length);
    else continue;
    try {
      validateLane(lane);
      if (candidateStem !== "alineryd" && lane === "") throw problem(`invalid daemon ownership file ${name}`);
      lanes.add(lane);
    } catch (error) {
      issues.push((error as Error).message);
    }
  }
  // Archived tasks live in the same directory and are intentionally included.
  for (const entry of entries(tasksDir(repo), issues)) {
    const slug = entry.name;
    if (safeComponent(slug) !== slug || !entry.isDirectory()) {
      issues.push(`invalid task ownership evidence: ${join(tasksDir(repo), slug)}`);
      continue;
    }
    const taskPath = join(taskDir(repo, slug), "task.md");
    let engineVersion = 0;
    let legacy = false;
    try {
      regularFile(taskPath, "task owner");
      const parsed = parseTask(readFileSync(taskPath, "utf8"), slug);
      if (!parsed || parsed.value.case !== "task") throw new Error(`invalid ${taskPath}: not a task`);
      engineVersion = parsed.value.value.engineVersion;
      legacy = engineVersion < 2;
    } catch (error) {
      issues.push((error as Error).message);
    }
    const statePath = join(taskDir(repo, slug), "execution.json");
    try {
      if (legacy && !lstat(statePath)) continue;
    } catch {
      /* read below reports it */
    }
    try {
      regularFile(statePath, "task owner file");
      const file = readExecutionState(repo, slug);
      try {
        validateLane(file.owning_lane as string);
        lanes.add(file.owning_lane as string);
      } catch (error) {
        issues.push((error as Error).message);
      }
      try {
        checkRetainedPlaybook(repo, slug, file);
      } catch (error) {
        issues.push((error as Error).message);
      }
      retained.push({ slug, path: statePath, file });
    } catch (error) {
      issues.push((error as Error).message);
    }
  }
  return { lanes, retained, issues };
}

export type OwnershipOptions = {
  /** The durable write of one task's execution.json. A test replaces it to fail part-way through a batch. */
  write?: (path: string, text: string) => Promise<void>;
};

const held: LockHandle[] = [];

/**
 * The authoritative startup fence (repo_ownership.rs `acquire`): hold `.repo-owner.lock` and every lane lock the project
 * has ever had, refuse while any owner still answers its socket, then adopt the retained tasks for `lane` and
 * `appConfigIdentity`. Throws `repo_busy` for a live owner and `failed_precondition` for anything that cannot be proven
 * stopped. Every lease taken by a failed attempt is released again. The leases of a successful one stay until the process exits;
 * the returned function ends them early and is for tests.
 */
export function acquireRepoOwnership(repo: string, lane: string, appConfigIdentity: string, options: OwnershipOptions = {}): Promise<() => void> {
  const write = options.write ?? ((path: string, text: string) => writeDurable(path, text));
  // A new repository has no `.alinery` yet, and the task-mutation lock lives in it.
  mkdirSync(alineryDir(repo), { recursive: true });
  return withTaskMutation(repo, "acquire project ownership", async () => {
    const leases: LockHandle[] = [];
    try {
      validateLane(lane);
      leases.push(lease(repoLockPath(repo)));
      const evidence = enumerate(repo);
      if (evidence.issues.length) throw problem(evidence.issues[0]);
      evidence.lanes.add(lane);
      for (const name of [...evidence.lanes].sort()) {
        leases.push(lease(laneLockPath(repo, name)));
        if (await socketReachable(laneSocketPath(repo, name))) {
          throw new DomainError("repo_busy", `project owner is still answering ${laneSocketPath(repo, name)}; stop it before opening this project here`);
        }
      }
      for (const { path, file } of evidence.retained) {
        // Always interrupt uncertain work, including retries after a partial durable batch.
        const records = Object.values(file.executions as Record<string, Json>);
        const interrupted = records.some((r) => HOLDS_CAPACITY.has(r.lifecycle as string));
        for (const record of records) {
          if (HOLDS_CAPACITY.has(record.lifecycle as string)) {
            record.lifecycle = "interrupted";
            record.error = "previous process disposition is unknown; ownership retained";
          }
        }
        if (file.owning_lane !== lane || (file.owning_app_config_identity ?? "") !== appConfigIdentity || interrupted) {
          file.owning_lane = lane;
          file.owning_app_config_identity = appConfigIdentity;
          file.revision = (file.revision as number) + 1;
          await write(path, JSON.stringify(file));
        }
      }
    } catch (error) {
      for (const handle of leases) handle.release();
      throw error;
    }
    held.push(...leases);
    // The daemon never calls this; a test does, so one process can take the fence again.
    return () => {
      for (const handle of leases) handle.release();
    };
  });
}
