// The five task operations the UI still sends. Replies match the Rust structs
// the app decodes. Create and subtask call alinery-core. The helper is not asked.
import { dlopen, FFIType, ptr, CString } from "bun:ffi";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { engineExecutions, runTask } from "./graph.ts";
import { parsePlaybookMd } from "playbook-engine/src/playbook-md.ts";
import type { Execution } from "playbook-engine/src/state.ts";
import type { Playbook, Step } from "playbook-engine/src/playbook.ts";

type Request = Record<string, unknown>;

type CoreLib = {
  symbols: {
    alinery_provision_task: (repo: ReturnType<typeof ptr>, lane: ReturnType<typeof ptr>, identity: ReturnType<typeof ptr>, request: ReturnType<typeof ptr>) => number | null;
    alinery_create_subtask: (repo: ReturnType<typeof ptr>, lane: ReturnType<typeof ptr>, identity: ReturnType<typeof ptr>, request: ReturnType<typeof ptr>) => number | null;
    alinery_string_free: (reply: number | null) => void;
  };
};

let coreLib: CoreLib | undefined;

export function ownershipLibrary(): string {
  const fromEnv = process.env.ALINERY_OWNERSHIP_LIB;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const dir = dirname(process.execPath);
  for (const name of ["libalinery_core.dylib", "libalinery_core.so", "alinery_core.dll"]) {
    for (const candidate of [join(dir, name), join(dir, "..", "Resources", "ownership", name)]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error("libalinery_core was not found beside the daemon");
}

function core(): CoreLib {
  if (coreLib) return coreLib;
  const library = ownershipLibrary();
  coreLib = dlopen(library, {
    alinery_provision_task: { args: [FFIType.cstring, FFIType.cstring, FFIType.cstring, FFIType.cstring], returns: FFIType.ptr },
    alinery_create_subtask: { args: [FFIType.cstring, FFIType.cstring, FFIType.cstring, FFIType.cstring], returns: FFIType.ptr },
    alinery_string_free: { args: [FFIType.ptr], returns: FFIType.void },
  }) as CoreLib;
  return coreLib;
}

function cstr(value: string) {
  return ptr(Buffer.from(`${value}\0`));
}

function coreCall(op: "alinery_provision_task" | "alinery_create_subtask", repo: string, lane: string, identity: string, request: string): Request {
  const lib = core();
  const reply = lib.symbols[op](cstr(repo), cstr(lane), cstr(identity), cstr(request));
  const text = reply ? new CString(reply).toString() : "";
  if (reply) lib.symbols.alinery_string_free(reply);
  if (!text) return { error: "empty provisioning reply" };
  return JSON.parse(text) as Request;
}

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

function lifecycle(execution: Execution): string {
  if (execution.status === "reserved") return "queued";
  if (execution.status === "finishing") return "finishing";
  if (execution.status === "done") return "completed";
  if (execution.status === "failed") return "failed";
  return "running";
}

function projectExecution(execution: Execution): Record<string, unknown> {
  return {
    id: execution.id,
    binding_key: execution.id,
    candidate: {
      step_key: execution.step,
      context_id: "root",
      inputs: execution.inputs,
      complete_collection_id: null,
      each_collection_id: null,
      each_member_id: null,
      manual: false,
    },
    outputs: [],
    parent_execution_ids: [],
    depth: execution.depth,
    owner_session_id: execution.sessionId ?? "",
    previous_session_ids: [],
    launch: { harness: "omp", model: "" },
    is_coding_step: false,
    start_requested: true,
    lifecycle: lifecycle(execution),
    permission: execution.permitted ? { kind: "human_granted", execution_id: execution.id, session_id: execution.sessionId ?? "" } : { kind: "automatic" },
    receipt_id: execution.receipt ? execution.id : null,
    exit_code: null,
    shutdown_confirmed: execution.status === "done" || execution.status === "failed",
    error: execution.failure,
  };
}

function executionState(repo: string, slug: string, lane: string, appIdentity: string): Record<string, unknown> | undefined {
  const path = join(repo, ".alinery", "tasks", slug, "execution.json");
  if (!existsSync(path)) return undefined;
  const state = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const executions: Record<string, unknown> = {};
  for (const execution of engineExecutions(slug)) executions[execution.id] = projectExecution(execution);
  if (Object.keys(executions).length) state.executions = executions;
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
  return { worktree, created: Math.floor(Date.now() / 1000), harness: "omp", model: "", ...meta };
}

export function getTaskExecution(repo: string, slug: string, lane: string, appIdentity: string): Record<string, unknown> {
  const sourcePath = join(repo, ".alinery", "tasks", slug, "playbook.md");
  const state = executionState(repo, slug, lane, appIdentity);
  if (!state || !existsSync(sourcePath)) return { error: "task execution state unavailable" };
  const parsed = parsePlaybookMd(readFileSync(sourcePath, "utf8"));
  if (!parsed.playbook) return { error: parsed.diagnostics.map((item) => item.message).join("; ") };
  return { state, definition: definitionOf(parsed.playbook) };
}

async function overlayStart(repo: string, reply: Request, requested: boolean): Promise<Request> {
  const task = reply.task as { slug?: string; worktree?: string } | undefined;
  const slug = task?.slug ?? "";
  if (!requested || reply.creation !== "ready" || !slug) return reply;
  try {
    await runTask(slug);
  } catch (error) {
    return {
      ...materializeSessions(repo, reply),
      start: "failed",
      errors: [{ stage: "launch", code: "launch_failed", message: String(error) }],
    };
  }
  const executions = engineExecutions(slug).map(projectExecution);
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

function taskWorktree(repo: string, slug: string): string {
  try {
    const text = readFileSync(join(repo, ".alinery", "tasks", slug, "task.md"), "utf8");
    const match = text.match(/^worktree\s*=\s*["']([^"']+)["']/m);
    if (match?.[1] && existsSync(match[1])) return match[1];
  } catch {
    /* the repo is the worktree until create finishes */
  }
  return repo;
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

function addExecution(repo: string, slug: string, execution: Record<string, unknown>) {
  const path = join(repo, ".alinery", "tasks", slug, "execution.json");
  const state = JSON.parse(readFileSync(path, "utf8")) as { executions?: Record<string, unknown> };
  state.executions = { ...(state.executions ?? {}), [String(execution.id)]: execution };
  writeFileSync(path, JSON.stringify(state));
}

function materializeSessions(repo: string, reply: Request): Request {
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
  const sessions = parsed.playbook.steps.map((step) => {
    const id = randomUUID();
    const executionId = randomUUID();
    const harness = step.harness || parsed.playbook?.defaultHarness || "omp";
    const model = step.model || "";
    const meta = {
      id,
      worktree,
      created: Math.floor(Date.now() / 1000),
      phase: step.key,
      harness,
      model,
      execution_id: executionId,
    };
    writeFileSync(join(dir, `${id}.meta.json`), JSON.stringify(meta));
    addExecution(repo, slug, reservedExecution(executionId, step.key, id, harness, model, false));
    return meta;
  });
  return { ...reply, sessions };
}

export async function createTask(repo: string, lane: string, appIdentity: string, request: Request): Promise<Record<string, unknown>> {
  const reply = coreCall("alinery_provision_task", repo, lane, appIdentity, JSON.stringify(request));
  if (typeof reply.error === "string") return reply;
  if (request.start) return overlayStart(repo, reply, true);
  return materializeSessions(repo, reply);
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
    const id = randomUUID();
    const meta = {
      id,
      worktree: taskWorktree(repo, slug),
      created: Math.floor(Date.now() / 1000),
      harness: target.harness || "omp",
      model: target.model ?? "",
      subtask_manager: true,
    };
    const dir = join(repo, ".alinery", "tasks", slug, "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.meta.json`), JSON.stringify(meta));
    return { session: meta, execution: null, start: "not_requested", errors: [] };
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
      harness,
      model,
      execution_id: executionId,
      prompt_extra: String(request.prompt_extra ?? ""),
      handoff_artifact: String(request.handoff_artifact ?? ""),
    };
    const dir = join(repo, ".alinery", "tasks", slug, "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.meta.json`), JSON.stringify(meta));
    const execution = reservedExecution(executionId, String(target.step_key ?? ""), id, harness, model, false);
    addExecution(repo, slug, execution);
    return { session: meta, execution, start: "not_requested", errors: [] };
  }
  if (target.kind === "primary") {
    await runTask(slug);
    const match = engineExecutions(slug).find((execution) => execution.step === target.step_key && execution.sessionId);
    if (!match?.sessionId) return { error: "that step is not reserved yet" };
    const session = readMeta(repo, slug, match.sessionId);
    if (!session) return { error: "missing session" };
    return { session: sessionReply(session, String(session.worktree ?? repo)), execution: projectExecution(match), start: "started", errors: [] };
  }
  const id = randomUUID();
  const model = target.model ?? "";
  const prompt = target.prompt ?? "";
  const meta = { id, worktree: repo, created: Math.floor(Date.now() / 1000), harness: target.harness || "omp", model, generic: true, prompt };
  const dir = slug ? join(repo, ".alinery", "tasks", slug, "sessions") : join(repo, ".alinery", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.meta.json`), JSON.stringify(meta));
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
    try {
      await runTask(slug);
    } catch {
      /* a terminal still starts when the playbook has no model */
    }
  }
  const execution = engineExecutions(slug).find((item) => item.sessionId === id);
  if (!execution) await openSession(id, slug, String(session.model ?? ""), String(session.prompt ?? ""));
  return { session: sessionReply(session, String(session.worktree ?? repo)), execution: execution ? projectExecution(execution) : null, start: "started", errors: [] };
}

export async function createSubtask(repo: string, lane: string, appIdentity: string, request: Request): Promise<Record<string, unknown>> {
  const reply = coreCall("alinery_create_subtask", repo, lane, appIdentity, JSON.stringify(request));
  if (typeof reply.error === "string") return reply;
  const provisioning = reply.provisioning as Request | undefined;
  if (!provisioning) return reply;
  reply.provisioning = await overlayStart(repo, provisioning, Boolean(request.start));
  return reply;
}

export async function taskOp(
  repo: string,
  lane: string,
  appIdentity: string,
  op: string,
  header: Request,
  body: Buffer | null,
  openSession: (id: string, taskSlug: string, model: string, prompt: string) => Promise<void>,
): Promise<Record<string, unknown> | undefined> {
  if (op === "get_task_execution") {
    const request = (header.request ?? {}) as Request;
    return getTaskExecution(repo, String(request.task_slug ?? ""), lane, appIdentity);
  }
  if (op === "create_task") {
    const request = JSON.parse((body ?? Buffer.from(JSON.stringify(header.request ?? {}))).toString("utf8")) as Request;
    return createTask(repo, lane, appIdentity, request);
  }
  if (op === "create_execution_session") return createExecutionSession(repo, (header.request ?? {}) as Request, openSession);
  if (op === "start_session") return startSession(repo, (header.request ?? {}) as Request, openSession);
  if (op === "create_subtask") return createSubtask(repo, lane, appIdentity, (header.request ?? {}) as Request);
  return undefined;
}
