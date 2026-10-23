// One playbook engine per task. Vinculum is the harness: tick launches sessions
// in this process, and completion never crosses to the Rust helper.
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { Engine } from "playbook-engine/src/engine.ts";
import type { CompletionReply, Harness, Launch, SessionStatus } from "playbook-engine/src/harness.ts";
import { parsePlaybookMd } from "playbook-engine/src/playbook-md.ts";
import type { Execution } from "playbook-engine/src/state.ts";

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

/** Same order as `resolve_execution_launch`: a step override, then the playbook, then the task default. */
export function executionModel(playbookModel: string, step: string, taskModel: string, stepModels: Record<string, string>): string {
  const override = stepModels[step]?.trim() ?? "";
  if (override) return override;
  const fromPlaybook = playbookModel.trim();
  if (fromPlaybook) return fromPlaybook;
  return taskModel.trim();
}

function harnessFor(slug: string, hooks: SessionHooks, taskModel: string, stepModels: Record<string, string>): Harness {
  const modelFor = (launch: Launch) => executionModel(launch.model, launch.step, taskModel, stepModels);
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

function openTask(repo: string, slug: string, hooks: SessionHooks) {
  if (running.has(slug) || rejected.has(slug)) return;
  const taskDir = join(repo, ".alinery", "tasks", slug);
  const sourcePath = join(taskDir, "playbook.md");
  if (!existsSync(sourcePath)) return;
  try {
    const execution = JSON.parse(readFileSync(join(taskDir, "execution.json"), "utf8")) as { creation?: string };
    if (execution.creation !== "ready") return;
  } catch {
    return;
  }
  const parsed = parsePlaybookMd(readFileSync(sourcePath, "utf8"));
  if (!parsed.playbook) {
    rejected.add(slug);
    console.error(`vinculum: ${slug} playbook: ${parsed.diagnostics.map((d) => d.message).join("; ")}`);
    return;
  }
  let cwd = repo;
  let taskName = parsed.playbook.title;
  let taskModel = "";
  const stepModels: Record<string, string> = {};
  try {
    const task = parse(readFileSync(join(taskDir, "task.md"), "utf8")) as {
      name?: string;
      worktree?: string;
      has_worktree?: boolean;
      launch_defaults?: { model?: unknown };
      step_models?: Record<string, unknown>;
    };
    if (typeof task.name === "string" && task.name) taskName = task.name;
    if (task.has_worktree !== false && task.worktree && existsSync(task.worktree)) cwd = task.worktree;
    if (typeof task.launch_defaults?.model === "string") taskModel = task.launch_defaults.model;
    for (const [step, model] of Object.entries(task.step_models ?? {})) {
      if (typeof model === "string" && model.trim()) stepModels[step] = model;
    }
  } catch {
    /* task.md is optional until create finishes */
  }
  const engine = Engine.open({
    playbook: parsed.playbook,
    harness: harnessFor(slug, hooks, taskModel, stepModels),
    logPath: join(taskDir, "engine.jsonl"),
    artifactsDir: join(taskDir, "artifacts"),
    cwd,
    tokens: {
      TICKET_FILE: ticketPath(taskDir) ?? "",
      TASK_SLUG: slug,
      TASK_NAME: taskName,
      WORKTREE: cwd,
    },
  });
  const ticket = ticketPath(taskDir);
  if (ticket && engine.state.seeds.length === 0) engine.seed([{ role: "ticket.md", path: ticket }]);
  for (const execution of engine.state.executions.values()) {
    if (execution.sessionId) bound.set(execution.sessionId, { slug, execId: execution.id });
  }
  running.set(slug, { slug, engine });
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

export async function runTask(slug: string) {
  await engineReady;
  if (!hooks) return;
  held.delete(slug);
  openTask(repoRoot, slug, hooks);
  const task = running.get(slug);
  if (task) await task.engine.tick();
}

export function startGraphs(repo: string, sessionHooks: SessionHooks) {
  hooks = sessionHooks;
  repoRoot = repo;
  markReady();
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      discover(repo, sessionHooks);
      for (const task of running.values()) {
        if (!held.has(task.slug)) await task.engine.tick();
      }
    } catch (error) {
      console.error(`vinculum playbook tick: ${error}`);
    } finally {
      ticking = false;
    }
  };
  void tick();
  setInterval(() => void tick(), 2000);
}
