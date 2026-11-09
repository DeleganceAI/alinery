// The task operations the UI still sends as daemon ops. Replies match the Rust structs the app decodes.
// Creating a task is TaskService (rpc/tasks.ts) and a sub-task's life is SubtaskService (rpc/subtasks.ts); the helper is not asked.
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { writeAtomic } from "./platform/fs.ts";
import { withTaskMutation } from "./platform/lock.ts";
import { engineExecutions, resumeFailedSession, runTask } from "./graph.ts";
import { parsePlaybookMd } from "playbook-engine/src/playbook-md.ts";
import type { Playbook, Step } from "playbook-engine/src/playbook.ts";
import { projectExecution, projectionContext, taskAutoApproveAll } from "./domain/executionProjection.ts";
import { EMPTY_ENGINE, executionPath, loadEngineState, mergedRecords } from "./domain/executionStore.ts";
import { createManagerSession } from "./domain/subtasks.ts";

type Request = Record<string, unknown>;

function definitionOf(playbook: Playbook): Record<string, unknown> {
  const step = (item: Step) => ({
    key: item.key,
    title: item.title,
    short: item.short,
    is_coding_step: item.isCodingStep,
    auto_advance_default: item.autoAdvanceDefault,
    inputs: item.inputs.map((input) => ({ path: input.path, mode: input.mode })),
    outputs: item.outputs.map((output) => (output.required ? { path: output.path, required: true } : { path: output.path })),
    model: item.model,
    harness: item.harness,
    prompt: item.prompt,
  });
  return {
    version: 2,
    key: playbook.key,
    title: playbook.title,
    description: playbook.description,
    default_model: playbook.defaultModel,
    default_harness: playbook.defaultHarness,
    step: playbook.steps.map(step),
    preamble: "",
    section_order: playbook.steps.map((item) => item.key),
  };
}

function executionState(repo: string, slug: string, lane: string, appIdentity: string): Record<string, unknown> | undefined {
  const path = executionPath(repo, slug);
  if (!existsSync(path)) return undefined;
  const state = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  // The file holds the engine's state (or an old log is folded for it); its records are projected again here, so the
  // permission follows `auto_approve_all` as it is now, which a Rust writer can change without a save.
  const stored = loadEngineState(repo, slug);
  if ((stored.kind === "stored" || stored.kind === "converted") && (stored.state.seeds.length > 0 || stored.state.executions.size > 0)) {
    Object.assign(state, mergedRecords(state, stored.state, repo, slug));
  }
  // O21: records the old runner wrote are history. The views offer no approve or resume for them.
  if (stored.kind === "history_only") state.history_only = true;
  state.owning_lane = typeof state.owning_lane === "string" ? state.owning_lane : lane;
  state.owning_app_config_identity = typeof state.owning_app_config_identity === "string" ? state.owning_app_config_identity : appIdentity;
  return state;
}

function readMeta(repo: string, slug: string, id: string): Record<string, unknown> | undefined {
  const path = slug ? join(repo, ".alinery", "tasks", slug, "sessions", `${id}.meta.json`) : join(repo, ".alinery", "sessions", `${id}.meta.json`);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function sessionReply(meta: Record<string, unknown>, worktree: string): Record<string, unknown> {
  return { worktree, created: Math.floor(Date.now() / 1000), model: "", ...meta, harness: recordedHarness(meta.harness) };
}

export function getTaskExecution(repo: string, slug: string, lane: string, appIdentity: string): Record<string, unknown> {
  const sourcePath = join(repo, ".alinery", "tasks", slug, "playbook.md");
  const state = executionState(repo, slug, lane, appIdentity);
  if (!state || !existsSync(sourcePath)) return { error: "task execution state unavailable" };
  const parsed = parsePlaybookMd(readFileSync(sourcePath, "utf8"));
  if (!parsed.playbook) return { error: parsed.diagnostics.map((item) => item.message).join("; ") };
  return { state, definition: definitionOf(parsed.playbook) };
}

export async function overlayStart(repo: string, reply: Request, requested: boolean): Promise<Request> {
  const task = reply.task as { slug?: string; worktree?: string } | undefined;
  const slug = task?.slug ?? "";
  if (!requested || reply.creation !== "ready" || !slug) return reply;
  try {
    await runTask(slug);
  } catch (error) {
    return {
      ...(await materializeSessions(repo, reply)),
      start: "failed",
      errors: [{ stage: "launch", code: "launch_failed", message: String(error) }],
    };
  }
  const project = projectionContext(repo, slug);
  const executions = engineExecutions(slug).map((execution) => projectExecution(execution, false, project));
  const worktree = String(task?.worktree ?? repo);
  const sessions = executions
    .map((execution) => readMeta(repo, slug, String(execution.owner_session_id ?? "")))
    .filter((meta): meta is Record<string, unknown> => Boolean(meta))
    .map((meta) => sessionReply(meta, worktree));
  const failed = executions.filter((execution) => execution.lifecycle === "failed");
  return {
    ...reply,
    sessions,
    executions,
    start: failed.length ? "failed" : "started",
    errors: failed.map((execution) => ({ stage: "launch", code: "launch_failed", message: String(execution.error ?? "launch failed") })),
  };
}

function rejectHandoff(repo: string, slug: string, name: string): string | undefined {
  if (!name) return undefined;
  if (name.includes("\\") || name.includes("\0") || name.includes(":") || name.split("/").some((part) => part === "" || part === "." || part === "..")) {
    return `invalid artifact path: ${name}`;
  }
  const path = join(repo, ".alinery", "tasks", slug, "artifacts", name);
  try {
    if (lstatSync(path).isSymbolicLink()) return `symlink rejected: ${path}`;
  } catch {
    /* a missing file is not a symlink */
  }
  return undefined;
}

export function taskWorktree(repo: string, slug: string): string {
  try {
    const text = readFileSync(join(repo, ".alinery", "tasks", slug, "task.md"), "utf8");
    const match = text.match(/^worktree\s*=\s*["']([^"']+)["']/m);
    if (match?.[1] && existsSync(match[1])) return match[1];
  } catch {
    /* the repo is the worktree until create finishes */
  }
  return repo;
}

// SessionMeta requires worktree and created. A patch keeps values already on the file.
// A file that does not have them, including one this daemon is creating, gets them now.
/** Session meta records the Vinculum agent as `vinculum`. `omp` is the old key and the registry key. */
export function recordedHarness(key: unknown): string {
  const value = typeof key === "string" ? key.trim() : "";
  if (!value || value === "omp") return "vinculum";
  return value;
}

export function completeSessionMeta(current: Record<string, unknown>, patch: Record<string, unknown>, id: string, worktree: string, now: number): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current, ...patch, id };
  // Reopening a stopped session clears the exit. Null is the clear; a later stamp sets the number again.
  if ("ended_at" in patch && patch.ended_at == null) delete next.ended_at;
  if ("exit_code" in patch && patch.exit_code == null) delete next.exit_code;
  if (typeof next.worktree !== "string" || next.worktree === "") next.worktree = worktree;
  if (typeof next.created !== "number" || !Number.isFinite(next.created)) next.created = now;
  if (next.harness === "omp") next.harness = "vinculum";
  return next;
}

function reservedExecution(id: string, step: string, sessionId: string, harness: string, model: string, startRequested: boolean) {
  return {
    id,
    binding_key: id,
    candidate: {
      step_key: step,
      context_id: "root",
      inputs: {},
      complete_collection_id: null,
      each_collection_id: null,
      each_member_id: null,
      manual: false,
    },
    outputs: [],
    parent_execution_ids: [],
    depth: 0,
    owner_session_id: sessionId,
    previous_session_ids: [],
    launch: { harness, model },
    is_coding_step: false,
    start_requested: startRequested,
    lifecycle: "queued",
    permission: { kind: "automatic" },
    receipt_id: null,
    exit_code: null,
    shutdown_confirmed: false,
    error: null,
  };
}

// Read, append and write under the task-mutation flock, so a concurrent writer (another call here, or Rust) is not lost.
export function addExecution(repo: string, slug: string, execution: Record<string, unknown>): Promise<void> {
  return withTaskMutation(repo, "add_execution", () => {
    const path = executionPath(repo, slug);
    const state = JSON.parse(readFileSync(path, "utf8")) as { executions?: Record<string, unknown>; engine?: unknown; revision?: number };
    state.revision = (typeof state.revision === "number" ? state.revision : 0) + 1;
    state.executions = { ...(state.executions ?? {}), [String(execution.id)]: execution };
    // Marks the task as this daemon's, so the records are not taken for the old runner's (O21). An old log has its own mark.
    if (!state.engine && !existsSync(join(dirname(path), "engine.jsonl"))) state.engine = EMPTY_ENGINE;
    writeAtomic(path, JSON.stringify(state));
  });
}

export async function materializeSessions(repo: string, reply: Request): Promise<Request> {
  if (reply.creation !== "ready") return reply;
  const task = reply.task as { slug?: string; worktree?: string } | undefined;
  const slug = task?.slug ?? "";
  if (!slug) return reply;
  const source = join(repo, ".alinery", "tasks", slug, "playbook.md");
  if (!existsSync(source)) return reply;
  const parsed = parsePlaybookMd(readFileSync(source, "utf8"));
  if (!parsed.playbook) return reply;
  const worktree = String(task?.worktree || taskWorktree(repo, slug));
  const dir = join(repo, ".alinery", "tasks", slug, "sessions");
  mkdirSync(dir, { recursive: true });
  const sessions: Record<string, unknown>[] = [];
  for (const step of parsed.playbook.steps) {
    const id = randomUUID();
    const executionId = randomUUID();
    const harness = step.harness || parsed.playbook?.defaultHarness || "omp";
    const model = step.model || "";
    const meta = {
      id,
      worktree,
      created: Math.floor(Date.now() / 1000),
      phase: step.key,
      harness: recordedHarness(harness),
      model,
      execution_id: executionId,
    };
    writeAtomic(join(dir, `${id}.meta.json`), JSON.stringify(meta));
    await addExecution(repo, slug, reservedExecution(executionId, step.key, id, harness, model, false));
    sessions.push(meta);
  }
  return { ...reply, sessions };
}

export async function createExecutionSession(
  repo: string,
  request: Request,
  openSession: (id: string, taskSlug: string, model: string, prompt: string) => Promise<void>,
): Promise<Record<string, unknown>> {
  const slug = String(request.task_slug ?? "");
  const target = request.target as { kind?: string; step_key?: string; harness?: string; model?: string; prompt?: string } | undefined;
  if (!target?.kind) return { error: "missing session target" };
  const handoff = String(request.handoff_artifact ?? "");
  const rejected = rejectHandoff(repo, slug, handoff);
  if (rejected) return { error: rejected };
  if (target.kind === "subtask_manager") {
    const t = request.target as { subtask_slug?: string | null; recover?: boolean; harness?: string; model?: string | null };
    return createManagerSession(repo, { slug, subtaskSlug: t.subtask_slug, recover: t.recover === true, harness: recordedHarness(t.harness), model: t.model, start: request.start === true }, openSession);
  }
  if (target.kind === "primary" && !request.start) {
    const id = randomUUID();
    const executionId = randomUUID();
    const override = request.launch_override as { harness?: string; model?: string } | undefined;
    const harness = override?.harness || "omp";
    const model = override?.model || "";
    const meta = {
      id,
      worktree: taskWorktree(repo, slug),
      created: Math.floor(Date.now() / 1000),
      phase: target.step_key ?? "",
      harness: recordedHarness(harness),
      model,
      execution_id: executionId,
      prompt_extra: String(request.prompt_extra ?? ""),
      handoff_artifact: String(request.handoff_artifact ?? ""),
    };
    const dir = join(repo, ".alinery", "tasks", slug, "sessions");
    mkdirSync(dir, { recursive: true });
    writeAtomic(join(dir, `${id}.meta.json`), JSON.stringify(meta));
    const execution = reservedExecution(executionId, String(target.step_key ?? ""), id, harness, model, false);
    await addExecution(repo, slug, execution);
    return { session: meta, execution, start: "not_requested", errors: [] };
  }
  if (target.kind === "primary") {
    await runTask(slug);
    const match = engineExecutions(slug).find((execution) => execution.step === target.step_key && execution.sessionId);
    if (!match?.sessionId) return { error: "that step is not reserved yet" };
    const session = readMeta(repo, slug, match.sessionId);
    if (!session) return { error: "missing session" };
    return { session: sessionReply(session, String(session.worktree ?? repo)), execution: projectExecution(match, taskAutoApproveAll(repo, slug), projectionContext(repo, slug)), start: "started", errors: [] };
  }
  const id = randomUUID();
  const model = target.model ?? "";
  const prompt = target.prompt ?? "";
  const meta = { id, worktree: repo, created: Math.floor(Date.now() / 1000), harness: recordedHarness(target.harness), model, generic: true, prompt };
  const dir = slug ? join(repo, ".alinery", "tasks", slug, "sessions") : join(repo, ".alinery", "sessions");
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, `${id}.meta.json`), JSON.stringify(meta));
  if (request.start) await openSession(id, slug, model, prompt);
  return { session: meta, execution: null, start: request.start ? "started" : "not_requested", errors: [] };
}

export async function startSession(
  repo: string,
  request: Request,
  openSession: (id: string, taskSlug: string, model: string, prompt: string) => Promise<void>,
): Promise<Record<string, unknown>> {
  const slug = String(request.task_slug ?? "");
  const id = String(request.session_id ?? "");
  const session = readMeta(repo, slug, id);
  if (!session) return { error: "missing session" };
  if (slug) {
    let resumed = false;
    try {
      resumed = await resumeFailedSession(slug, id);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    if (!resumed) {
      const existing = engineExecutions(slug).find((item) => item.sessionId === id);
      if (existing && (existing.status === "done" || existing.status === "finishing")) return { error: "this execution already completed" };
      // An auxiliary session belongs to no execution, so starting it must not release a held graph.
      if (existing) {
        try {
          await runTask(slug);
        } catch {
          /* a terminal still starts when the playbook has no model */
        }
      }
    }
  }
  const execution = engineExecutions(slug).find((item) => item.sessionId === id);
  if (!execution) await openSession(id, slug, String(session.model ?? ""), String(session.prompt ?? ""));
  return {
    session: sessionReply(session, String(session.worktree ?? repo)),
    execution: execution ? projectExecution(execution, taskAutoApproveAll(repo, slug), projectionContext(repo, slug)) : null,
    start: "started",
    errors: [],
  };
}
