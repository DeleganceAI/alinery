// One playbook engine per task. Vinculum is the harness: tick launches sessions
// in this process, and completion never crosses to the Rust helper.
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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

function harnessFor(slug: string, hooks: SessionHooks): Harness {
  return {
    async start(launch: Launch) {
      const id = randomUUID();
      bound.set(id, { slug, execId: launch.executionId });
      await hooks.open(id, slug, launch.model, launch.prompt);
      hooks.bind(id, launch.executionId);
      return id;
    },
    async resume(id: string, launch: Launch) {
      bound.set(id, { slug, execId: launch.executionId });
      await hooks.open(id, slug, launch.model, launch.prompt);
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
  const parsed = parsePlaybookMd(readFileSync(sourcePath, "utf8"));
  if (!parsed.playbook) {
    rejected.add(slug);
    console.error(`vinculum: ${slug} playbook: ${parsed.diagnostics.map((d) => d.message).join("; ")}`);
    return;
  }
  const engine = Engine.open({
    playbook: parsed.playbook,
    harness: harnessFor(slug, hooks),
    logPath: join(taskDir, "engine.jsonl"),
    artifactsDir: join(taskDir, "artifacts"),
    cwd: repo,
    tokens: {
      TICKET_FILE: ticketPath(taskDir) ?? "",
      TASK_SLUG: slug,
      TASK_NAME: parsed.playbook.title,
      WORKTREE: repo,
    },
  });
  const ticket = ticketPath(taskDir);
  if (ticket && engine.state.seeds.length === 0) engine.seed([{ role: "ticket.md", path: ticket }]);
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

export function startGraphs(repo: string, hooks: SessionHooks) {
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      discover(repo, hooks);
      for (const task of running.values()) await task.engine.tick();
    } catch (error) {
      console.error(`vinculum playbook tick: ${error}`);
    } finally {
      ticking = false;
    }
  };
  void tick();
  setInterval(() => void tick(), 2000);
}
