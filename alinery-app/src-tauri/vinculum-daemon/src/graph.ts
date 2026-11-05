// One playbook engine per task. Vinculum is the harness: tick launches sessions
// in this process, and completion never crosses to the Rust helper.
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { Engine } from "playbook-engine/src/engine.ts";
import type { CompletionReply, Harness, Launch, SessionStatus } from "playbook-engine/src/harness.ts";
import { parsePlaybookMd } from "playbook-engine/src/playbook-md.ts";
import { type Execution, fold, readLog, type State } from "playbook-engine/src/state.ts";
import { readLaunchModel } from "./sessionControls.ts";

export type SessionHooks = {
  open(id: string, taskSlug: string, model: string, prompt: string): Promise<void>;
  status(id: string): Promise<SessionStatus>;
  send(id: string, text: string): Promise<void>;
  stop(id: string): Promise<void>;
  bind(id: string, executionId: string): void;
};

export type PlaybookView = { state: string; reason?: string };

type Running = { slug: string; engine: Engine };

const running = new Map<string, Running>();
const bound = new Map<string, { slug: string; execId: string }>();
const rejected = new Set<string>();
const held = new Set<string>();
let hooks: SessionHooks | null = null;
let repoRoot = "";
let appConfigPath = "";

/** Reported when a live row already failed for a reason the engine did not request. */
export const SESSION_FAILED = "session failed";
let markReady: () => void = () => {};
const engineReady = new Promise<void>((resolve) => {
  markReady = resolve;
});

function playbookView(execution: Execution): PlaybookView {
  if (execution.status === "done") return { state: "completed" };
  if (execution.status === "finishing") return { state: "ready_to_advance" };
  if (execution.status === "failed") return { state: "failed", reason: execution.failure ?? "failed" };
  return { state: "in_progress" };
}

export function enginePlaybook(sessionId: string): PlaybookView | undefined {
  const link = bound.get(sessionId);
  if (!link) return undefined;
  const execution = running.get(link.slug)?.engine.state.executions.get(link.execId);
  return execution ? playbookView(execution) : { state: "in_progress" };
}

export function engineAxis(): Array<{ id: string; playbook: PlaybookView }> {
  const sessions: Array<{ id: string; playbook: PlaybookView }> = [];
  for (const { engine } of running.values()) {
    for (const execution of engine.state.executions.values()) {
      if (!execution.sessionId) continue;
      sessions.push({ id: execution.sessionId, playbook: playbookView(execution) });
    }
  }
  return sessions;
}

function phaseReply(reply: CompletionReply, execId: string): Record<string, unknown> {
  if (reply.kind === "accepted") return { ok: true, outcome: "accepted", published: reply.published, playbook: "ready_to_advance" };
  if (reply.kind === "permission-required") return { ok: true, outcome: "waiting_for_approval", correlation_id: `completion-permission:${execId}` };
  return { ok: true, outcome: "waiting_for_input", diagnostics: reply.problems, correlation_id: `completion-outputs:${execId}` };
}

export async function completeSession(sessionId: string): Promise<Record<string, unknown> | undefined> {
  const link = bound.get(sessionId);
  const engine = link ? running.get(link.slug)?.engine : undefined;
  if (!link || !engine) return undefined;
  return phaseReply(await engine.requestCompletion(link.execId), link.execId);
}

export async function permitSession(sessionId: string): Promise<boolean> {
  const link = bound.get(sessionId);
  const engine = link ? running.get(link.slug)?.engine : undefined;
  if (!link || !engine) return false;
  await engine.permit(link.execId);
  return true;
}

/** Step override, then the playbook, then the task default, then Settings. A blank is not the hosted fallback. */
export function executionModel(playbookModel: string, step: string, taskModel: string, stepModels: Record<string, string>, settingsModel = ""): string {
  const override = stepModels[step]?.trim() ?? "";
  if (override) return override;
  const fromPlaybook = playbookModel.trim();
  if (fromPlaybook) return fromPlaybook;
  const fromTask = taskModel.trim();
  if (fromTask) return fromTask;
  return settingsModel.trim();
}

/** `0` and anything that is not a positive integer do not launch. */
export function liveSessionCap(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

/** Create-without-starting holds until the log shows the task was actually started. */
export function taskShouldHold(initialStartRequested: boolean, logHasStart: boolean): boolean {
  return !initialStartRequested && !logHasStart;
}

export function logHasStart(logPath: string): boolean {
  let text = "";
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return false;
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const event = JSON.parse(line) as { t?: string };
      if (event.t === "started" || event.t === "resumed") return true;
    } catch {
      /* a torn last line is not a start */
    }
  }
  return false;
}

function safeArtifactName(name: string): boolean {
  return name.length > 0 && !name.includes("\\") && !name.includes("\0") && !name.includes(":") && !name.split("/").some((part) => part === "" || part === "." || part === "..");
}

/** The handoff file under the task artifacts directory. An unsafe name or a symlink is no path. */
export function handoffFile(artifactsDir: string, name: string): string {
  if (!safeArtifactName(name)) return "";
  const path = join(artifactsDir, name);
  try {
    if (lstatSync(path).isSymbolicLink()) return "";
  } catch {
    /* missing is still the path the prompt names */
  }
  return path;
}

/** A not-yet-started session for this step. Another step, or a session that already started, contributes nothing. */
export function handoffForStep(sessionsDir: string, artifactsDir: string, step: string): { PROMPT_EXTRA: string; REVIEW_HANDOFF_FILE: string } {
  const empty = { PROMPT_EXTRA: "", REVIEW_HANDOFF_FILE: "" };
  if (!existsSync(sessionsDir)) return empty;
  for (const name of readdirSync(sessionsDir)) {
    if (!name.endsWith(".meta.json")) continue;
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(readFileSync(join(sessionsDir, name), "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (meta.phase !== step || typeof meta.started_at === "number") continue;
    const extra = typeof meta.prompt_extra === "string" ? meta.prompt_extra : "";
    const handoff = typeof meta.handoff_artifact === "string" ? meta.handoff_artifact : "";
    if (!extra && !handoff) continue;
    return { PROMPT_EXTRA: extra, REVIEW_HANDOFF_FILE: handoff ? handoffFile(artifactsDir, handoff) : "" };
  }
  return empty;
}

export function sessionHarnessStatus(row: { process: "starting" | "alive" | "exited"; playbook: { state: string }; agent: { state: string }; liveRun: boolean } | undefined): SessionStatus {
  if (!row) return { kind: "unknown" };
  if (row.playbook.state === "failed") return { kind: "failed", reason: SESSION_FAILED };
  if (row.process === "exited") return { kind: "exited", exitCode: null };
  if (row.process === "starting") return { kind: "starting" };
  if (row.agent.state === "busy" || row.liveRun) return { kind: "running" };
  return { kind: "idle" };
}

/** A session file that already ended confirms the exit. A missing file stays unknown. */
export function confirmEndedExecutions(engine: Engine, meta: (sessionId: string) => { ended_at?: unknown } | undefined) {
  for (const execution of [...engine.state.executions.values()]) {
    if ((execution.status !== "live" && execution.status !== "finishing") || !execution.sessionId) continue;
    const row = meta(execution.sessionId);
    if (!row || typeof row.ended_at !== "number") continue;
    engine.confirmExited(execution.id);
  }
}

function readTaskModels(taskDir: string): { name: string; cwd: string; model: string; stepModels: Record<string, string> } {
  const stepModels: Record<string, string> = {};
  let name = "";
  let cwd = "";
  let model = "";
  try {
    const task = parse(readFileSync(join(taskDir, "task.md"), "utf8")) as {
      name?: string;
      worktree?: string;
      has_worktree?: boolean;
      launch_defaults?: { model?: unknown };
      step_models?: Record<string, unknown>;
    };
    if (typeof task.name === "string") name = task.name;
    if (task.has_worktree !== false && task.worktree && existsSync(task.worktree)) cwd = task.worktree;
    if (typeof task.launch_defaults?.model === "string") model = task.launch_defaults.model;
    for (const [step, value] of Object.entries(task.step_models ?? {})) {
      if (typeof value === "string" && value.trim()) stepModels[step] = value;
    }
  } catch {
    /* task.md is optional until create finishes */
  }
  return { name, cwd, model, stepModels };
}

function readExecutionFile(taskDir: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(join(taskDir, "execution.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function readSessionMeta(taskDir: string, id: string): { ended_at?: unknown } | undefined {
  try {
    return JSON.parse(readFileSync(join(taskDir, "sessions", `${id}.meta.json`), "utf8")) as { ended_at?: unknown };
  } catch {
    return undefined;
  }
}

function harnessFor(slug: string, hooks: SessionHooks, taskDir: string): Harness {
  const modelFor = (launch: Launch) => {
    const task = readTaskModels(taskDir);
    return executionModel(launch.model, launch.step, task.model, task.stepModels, readLaunchModel(repoRoot, appConfigPath));
  };
  return {
    async start(launch: Launch) {
      const id = randomUUID();
      bound.set(id, { slug, execId: launch.executionId });
      await hooks.open(id, slug, modelFor(launch), launch.prompt);
      hooks.bind(id, launch.executionId);
      return id;
    },
    async resume(id: string, launch: Launch) {
      bound.set(id, { slug, execId: launch.executionId });
      await hooks.open(id, slug, modelFor(launch), launch.prompt);
      hooks.bind(id, launch.executionId);
      return id;
    },
    status(id: string) {
      return hooks.status(id);
    },
    send(id: string, text: string) {
      return hooks.send(id, text);
    },
    stop(id: string) {
      return hooks.stop(id);
    },
  };
}

function ticketPath(taskDir: string): string | undefined {
  for (const name of ["00-ticket.md", "ticket.md"]) {
    const path = join(taskDir, "artifacts", name);
    if (existsSync(path)) return path;
  }
  return undefined;
}

function openTask(repo: string, slug: string, hooks: SessionHooks, release = false) {
  if (running.has(slug) || rejected.has(slug)) return;
  const taskDir = join(repo, ".alinery", "tasks", slug);
  const sourcePath = join(taskDir, "playbook.md");
  if (!existsSync(sourcePath)) return;
  const execution = readExecutionFile(taskDir);
  if (!execution || execution.creation !== "ready") return;
  const parsed = parsePlaybookMd(readFileSync(sourcePath, "utf8"));
  if (!parsed.playbook) {
    rejected.add(slug);
    console.error(`vinculum: ${slug} playbook: ${parsed.diagnostics.map((d) => d.message).join("; ")}`);
    return;
  }
  const task = readTaskModels(taskDir);
  const cwd = task.cwd || repo;
  const logPath = join(taskDir, "engine.jsonl");
  const engine = Engine.open({
    playbook: parsed.playbook,
    harness: harnessFor(slug, hooks, taskDir),
    logPath,
    artifactsDir: join(taskDir, "artifacts"),
    cwd,
    maxLiveSessions: () => liveSessionCap(readExecutionFile(taskDir)?.max_live_sessions),
    enabledSteps: () => {
      const steps = readExecutionFile(taskDir)?.enabled_steps;
      return Array.isArray(steps) ? steps.filter((step): step is string => typeof step === "string") : [];
    },
    autoApproveAll: () => readExecutionFile(taskDir)?.auto_approve_all === true,
    tokens: {
      TICKET_FILE: ticketPath(taskDir) ?? "",
      TASK_SLUG: slug,
      TASK_NAME: task.name || parsed.playbook.title,
      WORKTREE: cwd,
      SESSION_HISTORY_DIR: join(taskDir, "sessions"),
    },
    stepTokens: (step) => handoffForStep(join(taskDir, "sessions"), join(taskDir, "artifacts"), step),
  });
  const ticket = ticketPath(taskDir);
  if (ticket && engine.state.seeds.length === 0) engine.seed([{ role: "ticket.md", path: ticket }]);
  confirmEndedExecutions(engine, (id) => readSessionMeta(taskDir, id));
  for (const row of engine.state.executions.values()) {
    if (row.sessionId) bound.set(row.sessionId, { slug, execId: row.id });
  }
  running.set(slug, { slug, engine });
  if (release || !taskShouldHold(execution.initial_start_requested === true, logHasStart(logPath))) held.delete(slug);
  else held.add(slug);
}

function discover(repo: string, hooks: SessionHooks) {
  const root = join(repo, ".alinery", "tasks");
  if (!existsSync(root)) return;
  for (const slug of readdirSync(root)) {
    const dir = join(root, slug);
    if (!statSync(dir).isDirectory()) continue;
    openTask(repo, slug, hooks);
  }
}

export function holdTask(slug: string) {
  held.add(slug);
}

export function engineExecutions(slug: string): Execution[] {
  return [...(running.get(slug)?.engine.state.executions.values() ?? [])];
}

/** Live engine when this process has the task open. Otherwise the log, so a restart still has the bindings. Undefined when there is no log. */
export function engineSnapshot(repo: string, slug: string): State | undefined {
  const live = running.get(slug)?.engine.state;
  if (live) return live;
  const logPath = join(repo, ".alinery", "tasks", slug, "engine.jsonl");
  if (!existsSync(logPath)) return undefined;
  return fold(readLog(logPath));
}

export async function runTask(slug: string) {
  await engineReady;
  if (!hooks) return;
  held.delete(slug);
  openTask(repoRoot, slug, hooks, true);
  const task = running.get(slug);
  if (task) await task.engine.tick();
}

/** Continue the failed execution that already owns this session. Does not tick, so it cannot reserve a second one. */
export async function resumeFailedSession(slug: string, sessionId: string): Promise<boolean> {
  await engineReady;
  if (!hooks || !sessionId) return false;
  held.delete(slug);
  openTask(repoRoot, slug, hooks, true);
  const engine = running.get(slug)?.engine;
  const execution = [...(engine?.state.executions.values() ?? [])].find((item) => item.sessionId === sessionId && item.status === "failed");
  if (!engine || !execution) return false;
  await engine.resume(execution.id);
  return true;
}

/** Drop the in-memory engine so the next tick opens the log again. Tests use this as a restart. */
export function forgetTask(slug: string) {
  running.delete(slug);
  rejected.delete(slug);
  held.delete(slug);
}

/** Tests start from an empty process. A daemon process never calls this. */
export function resetGraphs() {
  running.clear();
  bound.clear();
  rejected.clear();
  held.clear();
}

export function prepareGraphs(repo: string, sessionHooks: SessionHooks, configPath = "") {
  hooks = sessionHooks;
  repoRoot = repo;
  appConfigPath = configPath;
  markReady();
}

let ticking = false;

export async function tickGraphs() {
  if (!hooks || ticking) return;
  ticking = true;
  try {
    discover(repoRoot, hooks);
    for (const task of running.values()) {
      if (!held.has(task.slug)) await task.engine.tick();
    }
  } catch (error) {
    console.error(`vinculum playbook tick: ${error}`);
  } finally {
    ticking = false;
  }
}

export function startGraphs(repo: string, sessionHooks: SessionHooks, configPath = "") {
  prepareGraphs(repo, sessionHooks, configPath);
  void tickGraphs();
  setInterval(() => void tickGraphs(), 2000);
}
