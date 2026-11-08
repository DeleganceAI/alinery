// Where the playbook engine's State lives: the `engine` block of a task's `execution.json` (O14 b).
// The file is the only truth. `engine.jsonl`, the log of earlier builds, is read once to convert a task
// that has no engine block yet, and is never written or read again after that.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fold, readLog, type State, type StateJson, stateFromJson, stateToJson } from "playbook-engine/src/state.ts";
import { writeDurable } from "../platform/fs.ts";
import { withTaskMutation } from "../platform/lock.ts";
import { projectExecution, projectionContext, projectOccurrences } from "./executionProjection.ts";

export const executionPath = (repo: string, slug: string) => join(repo, ".alinery", "tasks", slug, "execution.json");
const taskDir = (repo: string, slug: string) => join(repo, ".alinery", "tasks", slug);
export const historyDir = (repo: string, slug: string) => join(taskDir(repo, slug), "executions");
const logPath = (repo: string, slug: string) => join(taskDir(repo, slug), "engine.jsonl");

/** The engine's ids: `e1`, `e2`, ... for executions, `seed/<role>` and `e1/<role>` for occurrences. Rust's are UUIDs. */
const isEngineExecution = (id: string) => /^e\d+$/.test(id);
const isEngineOccurrence = (id: string) => id.startsWith("seed/") || /^e\d+\//.test(id);

/** An empty block, the mark that this daemon (and not the old runner) wrote the task's records. */
export const EMPTY_ENGINE: StateJson = { seeds: [], executions: [], ambiguities: [] };

export type EngineLoad =
  /** The engine block of the file. */
  | { kind: "stored"; state: State }
  /** Folded from `engine.jsonl`; the caller saves it once so the log is not read again. */
  | { kind: "converted"; state: State }
  /** O21: records the old Rust runner wrote and no engine state. Shown as history; never opened, seeded or launched. */
  | { kind: "history_only" }
  /** A task the engine has not touched. */
  | { kind: "fresh" };

type Json = Record<string, unknown>;

/** Paths inside the task directory are kept relative, so a repository moved on disk still resolves. */
function mapPaths(json: StateJson, fn: (path: string) => string): StateJson {
  const file = <T extends { path: string }>(f: T): T => ({ ...f, path: fn(f.path) });
  return {
    seeds: json.seeds.map(file),
    ambiguities: json.ambiguities,
    executions: json.executions.map((e) => ({
      ...e,
      outDir: fn(e.outDir),
      receipt: e.receipt ? e.receipt.map(file) : e.receipt,
      ...(e.manifest ? { manifest: { ...e.manifest, consumed: e.manifest.consumed.map(file), published: e.manifest.published.map(file) } } : {}),
    })),
  };
}
const relativeTo = (dir: string) => (p: string) => (p.startsWith(`${dir}/`) ? p.slice(dir.length + 1) : p);
const absoluteIn = (dir: string) => (p: string) => (isAbsolute(p) ? p : join(dir, p));

function readFile(repo: string, slug: string): Json | undefined {
  try {
    return JSON.parse(readFileSync(executionPath(repo, slug), "utf8")) as Json;
  } catch {
    return undefined;
  }
}

/** The state a task has on disk. Reads only; a converted state is the caller's to save. */
export function loadEngineState(repo: string, slug: string): EngineLoad {
  const file = readFile(repo, slug);
  if (file?.engine && typeof file.engine === "object") return { kind: "stored", state: stateFromJson(mapPaths(file.engine as StateJson, absoluteIn(taskDir(repo, slug)))) };
  if (existsSync(logPath(repo, slug))) return { kind: "converted", state: fold(readLog(logPath(repo, slug))) };
  const records = file?.executions;
  if (records && typeof records === "object" && Object.keys(records).length > 0) return { kind: "history_only" };
  return { kind: "fresh" };
}

/** A task that has ever started a session. A task created without starting holds until then. */
export const stateHasStart = (state: State | undefined): boolean => [...(state?.executions.values() ?? [])].some((e) => e.sessionId !== null);

/** The Rust-shaped records the engine's executions and occurrences stand for; the old runner's and manual ones stay. */
export function mergedRecords(file: Json, state: State, repo: string, slug: string): { executions: Json; occurrences: Json } {
  const project = projectionContext(repo, slug);
  const autoApproveAll = file.auto_approve_all === true;
  const keep = (map: unknown, isEngine: (id: string) => boolean): Json =>
    Object.fromEntries(Object.entries((map && typeof map === "object" ? map : {}) as Json).filter(([id]) => !isEngine(id)));
  const executions: Json = keep(file.executions, isEngineExecution);
  for (const execution of state.executions.values()) executions[execution.id] = projectExecution(execution, autoApproveAll, project);
  return { executions, occurrences: { ...keep(file.occurrences, isEngineOccurrence), ...(projectOccurrences(state, project.artifactsDir) as Json) } };
}

/**
 * Store the whole engine State in `execution.json`, under the task-mutation lock and with a durable write
 * (2.3.2). The Rust-shaped `executions` and `occurrences` maps are rewritten from it, so a Rust reader sees
 * the engine's executions under their own ids. Both halves of the write come from one deep copy of `state`
 * taken before the first wait, so a state that moves on while the lock is awaited cannot split them.
 */
export function saveEngineState(repo: string, slug: string, state: State): Promise<void> {
  const dir = taskDir(repo, slug);
  const frozen = stateFromJson(JSON.parse(JSON.stringify(stateToJson(state))) as StateJson);
  const engine = mapPaths(stateToJson(frozen), relativeTo(dir));
  return withTaskMutation(repo, "engine_save", async () => {
    const file = JSON.parse(readFileSync(executionPath(repo, slug), "utf8")) as Json;
    file.engine = engine;
    Object.assign(file, mergedRecords(file, frozen, repo, slug));
    file.revision = (typeof file.revision === "number" ? file.revision : 0) + 1;
    await writeDurable(executionPath(repo, slug), JSON.stringify(file));
  });
}
