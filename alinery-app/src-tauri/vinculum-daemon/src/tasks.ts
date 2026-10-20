// The five task operations the UI still sends. Replies match the Rust structs
// the app decodes. The helper is not asked.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "smol-toml";
import { engineExecutions, holdTask, runTask } from "./graph.ts";
import { parsePlaybookMd } from "playbook-engine/src/playbook-md.ts";
import type { Execution } from "playbook-engine/src/state.ts";
import type { Playbook, Step } from "playbook-engine/src/playbook.ts";

const MAX_ATTACHMENT = 25 * 1024 * 1024;
const MAX_ATTACHMENT_SET = 100 * 1024 * 1024;

type Request = Record<string, unknown>;

function slugify(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug || "task";
}

function uniqueSlug(repo: string, base: string): string {
  let slug = base;
  let n = 2;
  while (existsSync(join(repo, ".alinery", "tasks", slug))) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

function identityOf(bytes: Buffer): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
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

function addWorktree(repo: string, branch: string, path: string, base: string): string | undefined {
  mkdirSync(join(repo, ".alinery", "worktrees"), { recursive: true });
  const result = spawnSync("git", ["worktree", "add", "-b", branch, path, base], { cwd: repo, encoding: "utf8" });
  if (result.status === 0) return undefined;
  return (result.stderr || result.stdout || "git worktree add failed").trim();
}

export async function createTask(repo: string, lane: string, appIdentity: string, request: Request): Promise<Record<string, unknown>> {
  const name = String(request.name ?? "").trim();
  if (!name) return { error: "task name is required" };
  const playbookPackage = request.playbook as { reference?: { scope?: string; key?: string }; source?: string } | undefined;
  const source = playbookPackage?.source ?? "";
  const parsed = parsePlaybookMd(source);
  if (!parsed.playbook) return { error: parsed.diagnostics.map((item) => item.message).join("; ") };
  const reference = playbookPackage?.reference;
  if (!reference?.key || reference.key !== parsed.playbook.key) return { error: "task playbook key does not match source" };
  const requested = String(request.requested_slug ?? "").trim() || slugify(name);
  if (slugify(requested) !== requested) return { error: "invalid requested task slug" };
  const slug = uniqueSlug(repo, requested);
  holdTask(slug);
  const branch = String(request.branch_name ?? "").trim() || slug;
  const worktree = join(repo, ".alinery", "worktrees", slug);
  const taskDir = join(repo, ".alinery", "tasks", slug);
  mkdirSync(join(taskDir, "sessions"), { recursive: true });
  mkdirSync(join(taskDir, "artifacts"), { recursive: true });
  const errors: Array<{ stage: string; code: string; message: string }> = [];
  const worktreeError = addWorktree(repo, branch, worktree, String(request.base_ref ?? "HEAD"));
  const hasWorktree = !worktreeError;
  if (worktreeError) errors.push({ stage: "worktree", code: "worktree_failed", message: worktreeError });
  let accepted = 0;
  const attachments = Array.isArray(request.attachments) ? request.attachments : [];
  if (attachments.length) mkdirSync(join(taskDir, "artifacts", "attachments"), { recursive: true });
  for (const attachment of attachments) {
    const record = attachment as { name?: string; bytes?: string };
    const fileName = String(record.name ?? "");
    if (!fileName || fileName.includes("/") || fileName.includes("..")) {
      errors.push({ stage: "attachments", code: "import_failed", message: `${fileName || "attachment"} — invalid name` });
      continue;
    }
    const bytes = Buffer.from(String(record.bytes ?? ""), "base64");
    if (bytes.length > MAX_ATTACHMENT || accepted + bytes.length > MAX_ATTACHMENT_SET) {
      errors.push({ stage: "attachments", code: "import_failed", message: `${fileName} — too large` });
      continue;
    }
    writeFileSync(join(taskDir, "artifacts", "attachments", fileName), bytes);
    accepted += bytes.length;
  }
  const ticket = typeof request.original_ticket === "string" && request.original_ticket
    ? request.original_ticket
    : `# ${name}\n\n${String(request.description ?? "")}\n\n${String(request.evidence ?? "")}\n`;
  writeFileSync(join(taskDir, "artifacts", "00-ticket.md"), ticket);
  writeFileSync(join(taskDir, "playbook.md"), source);
  const created = Math.floor(Date.now() / 1000);
  const task = {
    name,
    slug,
    branch,
    worktree: hasWorktree ? worktree : repo,
    has_worktree: hasWorktree,
    created,
    engine_version: 2,
    max_live_sessions: Number(request.max_live_sessions ?? 10) || 10,
    playbook_ref: { scope: reference.scope ?? "repo", key: reference.key },
    launch_defaults: (request.launch_defaults as { harness?: string; model?: string } | undefined) ?? { harness: "omp", model: "" },
  };
  writeFileSync(join(taskDir, "task.md"), stringify(task));
  const state = {
    version: 1,
    revision: 1,
    creation: worktreeError ? "partial" : "ready",
    creation_error: worktreeError ?? null,
    initial_start_requested: Boolean(request.start),
    owning_lane: lane,
    owning_app_config_identity: appIdentity,
    definition_identity: identityOf(Buffer.from(source)),
    reference: { scope: reference.scope ?? "repo", key: reference.key },
    max_live_sessions: task.max_live_sessions,
    enabled_steps: parsed.playbook.steps.filter((step) => step.autoAdvanceDefault).map((step) => step.key),
    auto_approve_all: false,
    launch_defaults: task.launch_defaults,
    step_models: {},
    contexts: { root: { id: "root", parent_id: null, cause: { kind: "root" }, bindings: { "ticket.md": ["seed-ticket"] } } },
    executions: {},
    occurrences: {
      "seed-ticket": {
        id: "seed-ticket",
        producer_execution_id: null,
        selector: "ticket.md",
        logical_path: "ticket.md",
        relative_path: "00-ticket.md",
        depth: 0,
        discriminator: 0,
        context_id: "root",
        collection_ids: [],
      },
    },
    collections: {},
  };
  writeFileSync(join(taskDir, "execution.json"), JSON.stringify(state));
  let sessions: Record<string, unknown>[] = [];
  let executions: Record<string, unknown>[] = [];
  if (request.start) {
    await runTask(slug);
    executions = engineExecutions(slug).map(projectExecution);
    sessions = executions
      .map((execution) => readMeta(repo, slug, String(execution.owner_session_id ?? "")))
      .filter((meta): meta is Record<string, unknown> => Boolean(meta))
      .map((meta) => sessionReply(meta, hasWorktree ? worktree : repo));
  }
  return {
    task: { ...task, playbook: reference.key },
    sessions,
    executions,
    creation: state.creation,
    start: request.start ? (executions.some((execution) => execution.lifecycle === "failed") ? "failed" : "started") : "not_requested",
    errors,
  };
}

export async function createExecutionSession(
  repo: string,
  request: Request,
  openSession: (id: string, taskSlug: string, model: string, prompt: string) => Promise<void>,
): Promise<Record<string, unknown>> {
  const slug = String(request.task_slug ?? "");
  const target = request.target as { kind?: string; step_key?: string; harness?: string; model?: string; prompt?: string } | undefined;
  if (!target?.kind) return { error: "missing session target" };
  if (target.kind === "subtask_manager") return { error: "Vinculum does not start a subtask manager" };
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
  if (slug) await runTask(slug);
  const execution = engineExecutions(slug).find((item) => item.sessionId === id);
  if (!execution) await openSession(id, slug, String(session.model ?? ""), String(session.prompt ?? ""));
  return { session: sessionReply(session, String(session.worktree ?? repo)), execution: execution ? projectExecution(execution) : null, start: "started", errors: [] };
}

export function createSubtask(): Record<string, unknown> {
  return { error: "Vinculum does not create subtasks yet" };
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
  if (op === "create_subtask") return createSubtask();
  return undefined;
}
