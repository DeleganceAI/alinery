// One playbook engine per task. Vinculum is the harness: tick launches sessions
// in this process, and completion never crosses to the Rust helper.
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { Engine, StepContinuationRefusal } from "playbook-engine/src/engine.ts";
import type { CompletionReply, Harness, Launch, SessionStatus } from "playbook-engine/src/harness.ts";
import { parsePlaybookMd } from "playbook-engine/src/playbook-md.ts";
import type { Playbook } from "playbook-engine/src/playbook.ts";
import type { Execution } from "playbook-engine/src/state.ts";
import { historyDir, loadEngineState, saveEngineState, stateHasStart } from "./domain/executionStore.ts";
import { DomainError } from "./platform/lock.ts";
import { readLaunchModel } from "./sessionControls.ts";
import { recordWorktreeTree } from "./domain/gitActions.ts";
import { requirementsFor } from "./domain/repoSpecs.ts";
import { readTaskChecked } from "./domain/taskFiles.ts";

export type SessionHooks = {
  open(id: string, taskSlug: string, model: string, prompt: string): Promise<void>;
  status(id: string): Promise<SessionStatus>;
  reviewBlocker?(id: string, human: boolean): Promise<string | undefined>;
  reviewFollowUpFinished?(sessionId: string, requestId: string): Promise<boolean>;
  send(id: string, text: string, onlyIfIdle?: () => boolean): Promise<void>;
  nudge?(id: string, runId: string, deliveryId: string, checkOwner: (executionId: string) => void): Promise<void>;
  stop(id: string, taskSlug: string): Promise<void>;
  /** A session the engine launched: it stands for this execution of this step. */
  bind(id: string, executionId: string, step: string): void;
  /** A task's playbook engine saved its state to `execution.json`, so its execution entity may have changed. */
  executionChanged?(taskSlug: string): void;
};

export type PlaybookView = { state: string; reason?: string };

type Running = { repo: string; slug: string; engine: Engine; playbook: Playbook };

const running = new Map<string, Running>();
const bound = new Map<string, { slug: string; execId: string }>();
const rejected = new Map<string, string>();
const held = new Set<string>();
let hooks: SessionHooks | null = null;
let repoRoot = "";
let appConfigPath = "";
/** The lane and app identity this daemon owns tasks as. A task another lane owns is not opened. */
let owner: { lane: string; identity: string } | undefined;

/** Reported when a live row already failed for a reason the engine did not request. */
export const SESSION_FAILED = "session failed";
let markReady: () => void = () => {};
const engineReady = new Promise<void>((resolve) => {
  markReady = resolve;
});

function playbookView(execution: Execution): PlaybookView {
  if (execution.status === "done") return { state: "completed" };
  if (execution.ready || execution.status === "finishing") return { state: "ready_to_advance" };
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

function phaseReply(reply: CompletionReply): Record<string, unknown> {
  if (reply.kind === "accepted") return { ok: true, outcome: "accepted", published: reply.published, playbook: "ready_to_advance" };
  if (reply.kind === "ready") return { ok: true, outcome: "ready_for_review", work_revision: reply.revision, endpoint: reply.endpoint, destinations: reply.destinations };
  if (reply.kind === "stale") return { error: reply.reason };
  return { ok: true, outcome: "invalid_outputs", diagnostics: reply.problems };
}

export async function completeSession(sessionId: string, currentOwner = () => true, expectedExecution?: string): Promise<Record<string, unknown> | undefined> {
  const link = bound.get(sessionId);
  const engine = link ? running.get(link.slug)?.engine : undefined;
  const execution = link ? engine?.state.executions.get(link.execId) : undefined;
  if (!link || !engine || !execution) return undefined;
  const attempt = execution.attempt ?? 0;
  return withSessionAction(sessionId, async () => {
    if (!currentOwner() || bound.get(sessionId) !== link || (expectedExecution !== undefined && expectedExecution !== execution.id)) return { error: "The execution owner changed." };
    if (!execution.receipt) {
      const blocker = await hooks?.reviewBlocker?.(sessionId, false);
      if (blocker) return { ok: true, outcome: "pending_work", reason: blocker };
    }
    return phaseReply(await engine.requestCompletion(link.execId, sessionId, attempt));
  });
}

// A human's message and Continue can arrive from different clients. Keep Continue out
// until readiness is durably invalidated and Pi has admitted the new input.
const sessionActions = new Map<string, Promise<unknown>>();

async function withSessionAction<T>(id: string, run: () => Promise<T>): Promise<T> {
  const previous = sessionActions.get(id);
  const next = previous ? previous.then(run, run) : Promise.resolve().then(run);
  sessionActions.set(id, next);
  try {
    return await next;
  } finally {
    if (sessionActions.get(id) === next) sessionActions.delete(id);
  }
}

export async function submitSessionWork(slug: string, sessionId: string, submit: () => Promise<void>, check?: (boundExecution?: string) => Promise<boolean>, requestId?: string): Promise<void> {
  if (slug) {
    await engineReady;
    if (hooks) openTask(repoRoot, slug, hooks);
  }
  return withSessionAction(sessionId, async () => {
    const link = bound.get(sessionId);
    // A replay or stale Retry must not invalidate reviewed work.
    if (check && !(await check(link?.execId))) return;
    if (link) {
      const engine = running.get(slug)?.engine;
      if (link.slug !== slug || !engine) throw new DomainError("failed_precondition", "the owning execution is unavailable");
      await engine.invalidateReadiness(link.execId, sessionId, requestId);
    }
    await submit();
  });
}

export async function continueReviewed(slug: string, executionId: string, sessionId: string, revision: number): Promise<void> {
  return withSessionAction(sessionId, async () => {
    const engine = running.get(slug)?.engine;
    if (!engine?.state.executions.has(executionId)) throw new DomainError("not_found", `task ${slug} has no active execution ${executionId}`);
    const execution = engine.state.executions.get(executionId)!;
    if (execution.sessionId === sessionId && execution.ready?.revision === revision) {
      const task = readTaskChecked(repoRoot, slug);
      if (task.archived || task.draft || task.engine_version !== 2) throw new DomainError("failed_precondition", "only an active playbook task can continue");
      const blocker = await hooks?.reviewBlocker?.(sessionId, true);
      if (blocker) throw new DomainError("failed_precondition", blocker);
    }
    const reply = await engine.continueReviewed(executionId, sessionId, revision);
    if (reply.kind === "stale") throw new DomainError("aborted", reply.reason);
    if (reply.kind !== "accepted") throw new DomainError("failed_precondition", reply.kind === "rejected" ? reply.problems.join("\n") : "the execution is awaiting review");
  });
}

export async function nudgeExecution(slug: string, executionId: string, sessionId: string, runId: string, deliveryId: string): Promise<string> {
  return withSessionAction(sessionId, async () => {
    const execution = running.get(slug)?.engine.state.executions.get(executionId);
    if (!execution || execution.sessionId !== sessionId || !hooks?.nudge) throw new DomainError("failed_precondition", "The owning execution is unavailable.");
    await hooks.nudge(sessionId, runId, deliveryId, (sessionExecution) => {
      const owner = bound.get(sessionId);
      if (owner?.slug !== slug || owner.execId !== executionId || sessionExecution !== executionId || execution.status !== "live" || execution.receipt || execution.ready) {
        throw new DomainError("failed_precondition", "The step is no longer working toward review.");
      }
      const task = readTaskChecked(repoRoot, slug);
      if (task.archived || task.draft) throw new DomainError("failed_precondition", "Only an active playbook task can be nudged.");
    });
    return deliveryId;
  });
}

/** The person lets one live execution finish. Not found, or not live, is a precondition failure the caller reports. */
export async function permitExecution(slug: string, execId: string): Promise<void> {
  const engine = running.get(slug)?.engine;
  if (!engine) throw new DomainError("not_found", `task ${slug} has no running playbook engine in this daemon`);
  const execution = engine.state.executions.get(execId);
  if (!execution) throw new DomainError("not_found", `task ${slug} has no execution ${execId}`);
  if (execution.status !== "live" || !execution.sessionId) throw new DomainError("failed_precondition", `execution ${execId} is ${execution.status}; only a live execution can be permitted`);
  const sessionId = execution.sessionId;
  await withSessionAction(sessionId, async () => {
    await engine.invalidateReadiness(execId, sessionId);
    await engine.permit(execId);
  });
}

export async function setStepContinuation(slug: string, stepKey: string, automatic: boolean, checkRevision: () => void): Promise<void> {
  const task = readTaskChecked(repoRoot, slug);
  if (task.archived || task.draft) throw new DomainError("failed_precondition", "only an active task can change step continuation");
  const engine = running.get(slug)?.engine;
  if (!engine) throw new DomainError("failed_precondition", "this task has no active playbook engine");
  try {
    await engine.setStepContinuation(stepKey, automatic, checkRevision);
  } catch (error) {
    if (error instanceof StepContinuationRefusal) throw new DomainError(error.reason === "unknown-step" ? "not_found" : "failed_precondition", error.message);
    throw error;
  }
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

/** Create-without-starting holds until the stored state shows the task was actually started. */
export function taskShouldHold(initialStartRequested: boolean, hasStart: boolean): boolean {
  return !initialStartRequested && !hasStart;
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
  if (row.playbook.state === "failed") return row.process === "exited" ? { kind: "failed", reason: SESSION_FAILED } : { kind: "unknown" };
  if (row.process === "exited") return { kind: "exited", exitCode: null };
  if (row.process === "starting") return { kind: "starting" };
  if (row.agent.state === "busy" || row.liveRun) return { kind: "running" };
  return row.agent.state === "idle" ? { kind: "idle" } : { kind: "waiting" };
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
      hooks.bind(id, launch.executionId, launch.step);
      return id;
    },
    async resume(id: string, launch: Launch) {
      bound.set(id, { slug, execId: launch.executionId });
      await hooks.open(id, slug, modelFor(launch), launch.prompt);
      hooks.bind(id, launch.executionId, launch.step);
      return id;
    },
    async status(id: string) {
      const status = await hooks.status(id);
      if (status.kind === "unknown" && typeof readSessionMeta(taskDir, id)?.ended_at === "number") return { kind: "exited", exitCode: null };
      return status;
    },
    send(id, text, onlyIfIdle) {
      if (!onlyIfIdle) return hooks.send(id, text);
      const owner = running.get(slug);
      return withSessionAction(id, () => hooks.send(id, text, () => {
        const task = readTaskChecked(repoRoot, slug);
        return owner !== undefined && running.get(slug) === owner && bound.get(id)?.slug === slug &&
          !task.archived && !task.draft && task.engine_version === 2 && onlyIfIdle();
      }));
    },
    stop(id: string) {
      return hooks.stop(id, slug);
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

/** The disk preconditions shared by engine discovery and the execution entity. */
export function engineRefusal(execution: Record<string, unknown>, daemon: typeof owner): string | undefined {
  if (execution.creation !== "ready") return "Task creation has not finished.";
  if (daemon && ((typeof execution.owning_lane === "string" && execution.owning_lane !== daemon.lane) || (typeof execution.owning_app_config_identity === "string" && execution.owning_app_config_identity !== daemon.identity))) {
    return "Another Alinery daemon owns this task.";
  }
}

function openTask(repo: string, slug: string, hooks: SessionHooks, release = false) {
  if (running.has(slug)) return;
  const taskDir = join(repo, ".alinery", "tasks", slug);
  const sourcePath = join(taskDir, "playbook.md");
  const execution = readExecutionFile(taskDir);
  if (!execution || engineRefusal(execution, owner)) return;
  let source: string;
  try {
    source = readFileSync(sourcePath, "utf8");
  } catch {
    return;
  }
  if (rejected.get(slug) === source) return;
  const stored = loadEngineState(repo, slug);
  // Records the old Rust runner wrote. They stay as history; nothing is seeded, reserved or launched.
  if (stored.kind === "history_only") return;
  const { playbook, diagnostics } = parsePlaybookMd(source);
  if (!playbook) {
    rejected.set(slug, source);
    console.error(`vinculum: ${slug} playbook: ${diagnostics.map((d) => d.message).join("; ")}`);
    return;
  }
  rejected.delete(slug);
  const task = readTaskModels(taskDir);
  const cwd = task.cwd || repo;
  const engine = Engine.open({
    playbook,
    harness: harnessFor(slug, hooks, taskDir),
    load: () => (stored.kind === "stored" || stored.kind === "converted" ? stored.state : undefined),
    save: (state) => saveEngineState(repo, slug, state, playbook.steps),
    onSaved: () => hooks?.executionChanged?.(slug),
    historyDir: historyDir(repo, slug),
    // A failed record (git missing, a damaged repository) must not fail the acceptance it documents.
    recordWorktree: async (execution) => {
      try {
        return await recordWorktreeTree(cwd, slug, execution.id);
      } catch (error) {
        console.error(`vinculum: ${slug} ${execution.id} worktree not recorded: ${error}`);
        return undefined;
      }
    },
    artifactsDir: join(taskDir, "artifacts"),
    cwd,
    maxLiveSessions: () => liveSessionCap(readExecutionFile(taskDir)?.max_live_sessions),
    enabledSteps: () => {
      const steps = readExecutionFile(taskDir)?.enabled_steps;
      return Array.isArray(steps) ? steps.filter((step): step is string => typeof step === "string") : [];
    },
    autoApproveAll: () => readExecutionFile(taskDir)?.auto_approve_all === true,
    reviewFollowUpFinished: hooks.reviewFollowUpFinished,
    canAdvanceReviewed: async (sessionId) => {
      try {
        const current = readTaskChecked(repo, slug);
        return !current.archived && !current.draft && current.engine_version === 2 && !(await hooks.reviewBlocker?.(sessionId, true));
      } catch (error) {
        // Retry this owner's review on the next tick; the other repositories' tasks can still advance.
        console.error(`vinculum: ${slug} continuation check failed: ${error}`);
        return false;
      }
    },
    tokens: {
      TICKET_FILE: ticketPath(taskDir) ?? "",
      TASK_SLUG: slug,
      TASK_NAME: task.name || playbook.title,
      WORKTREE: cwd,
      SESSION_HISTORY_DIR: join(taskDir, "sessions"),
    },
    stepTokens: (step) => handoffForStep(join(taskDir, "sessions"), join(taskDir, "artifacts"), step),
    // The repository's committed specs/ at the commit this task is pinned to, read at each launch.
    requirements: () => requirementsFor(repo, taskDir),
  });
  // A task folded from an old log is saved once, so the log is not read again.
  if (stored.kind === "converted") engine.persist();
  const ticket = ticketPath(taskDir);
  if (ticket && engine.state.seeds.length === 0) engine.seed([{ role: "ticket.md", path: ticket }]);
  confirmEndedExecutions(engine, (id) => readSessionMeta(taskDir, id));
  for (const row of engine.state.executions.values()) {
    if (row.sessionId) bound.set(row.sessionId, { slug, execId: row.id });
  }
  running.set(slug, { repo, slug, engine, playbook });
  if (release || !taskShouldHold(execution.initial_start_requested === true, stateHasStart(engine.state))) held.delete(slug);
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

export function loadedPlaybook(repo: string, slug: string, lane: string, identity: string): Playbook | undefined {
  const task = running.get(slug);
  if (task?.repo !== repo || (owner && (owner.lane !== lane || owner.identity !== identity))) return undefined;
  return task.playbook;
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

/** Drop the in-memory engine so the next tick loads the stored state again. Tests use this as a restart. */
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

export function prepareGraphs(repo: string, sessionHooks: SessionHooks, configPath = "", taskOwner?: { lane: string; identity: string }) {
  hooks = sessionHooks;
  repoRoot = repo;
  appConfigPath = configPath;
  owner = taskOwner;
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

export function startGraphs(repo: string, sessionHooks: SessionHooks, configPath = "", taskOwner?: { lane: string; identity: string }) {
  prepareGraphs(repo, sessionHooks, configPath, taskOwner);
  void tickGraphs();
  setInterval(() => void tickGraphs(), 2000);
}
