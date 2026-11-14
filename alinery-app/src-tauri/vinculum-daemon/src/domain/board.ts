// The board's derived fields (plan S3.5, rule R3): what `board_task` and `resolve_task_activity_for_repo`
// computed from files and the app's polled session states, now computed here from the store's Session
// rows and recomputed whenever one of the task's inputs commits. `decorate` fills `Task.board` and
// `Task.activity` on a task row; `dependents` says which task.md to re-read when another file changes,
// which is how a session, a playbook or an artifact reaches its task's row.
import { clone, create } from "@bufbuild/protobuf";
import { type Entity, EntitySchema, type Session, type Task, TaskActivitySchema } from "alinery-proto/alinery/v1/entities_pb";
import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parsePlaybookMd } from "playbook-engine/src/playbook-md.ts";
import type { Store } from "../sync/store.ts";
import { ScopeSchema } from "alinery-proto/alinery/v1/sync_pb";

type Definition = { title: string; steps: { key: string; title: string }[] };
type Tier = [tier: number, status: string];

const RELATED_TASKS_MARKDOWN = "related-tasks.md";
const mtimeSecs = (path: string): number | undefined => {
  try {
    return Math.floor(statSync(path).mtimeMs / 1000);
  } catch {
    return undefined;
  }
};

/** `visible_artifact_names`: every file under artifacts/ except attachments, subtasks, comments and handoff sidecars. */
function visibleArtifacts(dir: string, prefix = ""): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(join(dir, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!prefix && (entry.name === "attachments" || entry.name === "subtasks")) continue;
    if (entry.isDirectory()) out.push(...visibleArtifacts(dir, name));
    else if (name !== RELATED_TASKS_MARKDOWN && !name.endsWith(".comments.json") && !((name.endsWith(".handoff.json") || (name.includes(".handoff-") && name.endsWith(".json"))))) out.push(name);
  }
  return out;
}

const isPrimary = (task: Task, s: Session) => !s.generic && (task.engineVersion >= 2 ? s.executionId !== "" : s.playbook === task.playbook);
const unackedFailure = (s: Session) => s.exitCode !== undefined && s.exitCode !== 0 && (s.endedAt === undefined || s.exitNotificationReadAt === undefined || s.endedAt > s.exitNotificationReadAt);

/** `project_task_session_activity`: the durable status, then the live state laid over it. */
export function sessionActivity(task: Task, s: Session): { status?: Tier; activeTier?: number } {
  const done = s.semantic?.phaseCompletedAt;
  const durable: Tier | undefined = unackedFailure(s)
    ? [2, "failed"]
    : isPrimary(task, s) && done !== undefined && (s.notificationReadAt === undefined || done > s.notificationReadAt)
      ? [2, "completed"]
      : undefined;
  const state = s.status;
  if (!state) return { status: durable };
  const supported = state.adapter === "vinculum";
  if (supported && state.playbook === "failed") {
    const acknowledged = state.process === "exited" && s.exitCode !== undefined && s.exitCode !== 0 && !unackedFailure(s);
    return { status: state.playbookReason === "StaleSource" || acknowledged ? durable : [2, "failed"] };
  }
  const live = state.process === "starting" || state.process === "alive";
  const input = supported && live && state.agent === "waiting_for_input";
  const approval = supported && live && state.agent === "waiting_for_approval";
  const busy = state.process === "starting" || (supported && live && state.agent === "busy");
  return {
    status: input ? [0, "waiting_for_input"] : approval ? [0, "waiting_for_approval"] : busy ? [1, "running"] : durable,
    activeTier: busy ? 0 : input || approval ? 1 : undefined,
  };
}

export class BoardProjector {
  private readonly definitions = new Map<string, { mtimeMs: number; definition: Definition | undefined }>();

  constructor(
    private readonly store: Store,
    private readonly alinery: string,
  ) {}

  private sessionsOf(slug: string): Session[] {
    const out: Session[] = [];
    for (const e of this.store.rowsMatching(create(ScopeSchema, { kind: { case: "task", value: { slug } } }))) if (e.value.case === "session" && e.key.startsWith("session/")) out.push(e.value.value);
    return out.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  private taskOf(slug: string): Task | undefined {
    const e = this.store.get(`task/${slug}/${slug}`);
    return e?.value.case === "task" ? e.value.value : undefined;
  }

  /** The task-owned playbook snapshot; undefined for drafts, old-engine tasks and a snapshot that does not parse. */
  private definitionOf(task: Task, slug: string): Definition | undefined {
    if (task.draft || task.engineVersion < 2) return undefined;
    const path = join(this.alinery, "tasks", slug, "playbook.md");
    const mtimeMs = statSync(path, { throwIfNoEntry: false })?.mtimeMs;
    if (mtimeMs === undefined) return undefined;
    const cached = this.definitions.get(slug);
    if (cached?.mtimeMs === mtimeMs) return cached.definition;
    let definition: Definition | undefined;
    try {
      const playbook = parsePlaybookMd(readFileSync(path, "utf8")).playbook;
      if (playbook) definition = { title: playbook.title, steps: playbook.steps.map((s) => ({ key: s.key, title: s.title })) };
    } catch {
      /* unreadable: the row falls back to phase keys */
    }
    this.definitions.set(slug, { mtimeMs, definition });
    return definition;
  }

  /** A task row with `board` and `activity` filled in; any other row is returned as it is. */
  decorate = (entity: Entity): Entity => {
    if (entity.value.case !== "task") return entity;
    const out = clone(EntitySchema, entity);
    if (out.value.case !== "task") return out;
    const task = out.value.value;
    const slug = entity.key.split("/")[1];
    const sessions = this.sessionsOf(slug);
    const live = sessions.filter((s) => !s.archived);
    const definition = this.definitionOf(task, slug);
    const title = (phase: string) => definition?.steps.find((s) => s.key === phase)?.title ?? phase;
    const currentPhase = [...live].reverse().find((s) => isPrimary(task, s))?.phase ?? "";
    const last = live[live.length - 1];
    const dir = join(this.alinery, "tasks", slug);
    let updated = Number(task.created);
    const seen = (secs: number | bigint | undefined) => {
      if (secs !== undefined && Number(secs) > updated) updated = Number(secs);
    };
    seen(mtimeSecs(join(dir, "task.md")));
    for (const name of visibleArtifacts(join(dir, "artifacts"))) if (!name.endsWith(".review-pending.json")) seen(mtimeSecs(join(dir, "artifacts", name)));
    // Session files are projections that polling and replay rewrite; only durable timestamps count as activity.
    for (const s of sessions) for (const t of [s.created, s.startedAt, s.endedAt, s.statusChangedAt, s.semantic?.phaseCompletedAt, s.activityAt]) seen(t);
    task.board = {
      $typeName: "alinery.v1.BoardProjection",
      sessionCount: BigInt(live.length),
      totalSessions: BigInt(sessions.length),
      playbookTitle: definition?.title ?? task.playbook,
      playbookSteps: (definition?.steps ?? []).map((s) => ({ $typeName: "alinery.v1.BoardStep" as const, key: s.key, title: s.title })),
      updated: BigInt(updated),
      currentPhase,
      currentStepTitle: title(currentPhase),
      latestSessionTitle: task.draft ? "Draft" : last ? (last.generic ? "Generic" : title(last.phase)) : "No sessions",
    };
    task.activity = this.activityOf(task);
    return out;
  };

  /** `resolve_task_activity_for_repo` for one task: follow the active subtask while the task itself has nothing actionable. */
  private activityOf(start: Task) {
    let task = start;
    let sessions = this.sessionsOf(task.slug);
    const visited = new Set([task.slug]);
    while (task.activeSubtask && !sessions.some((s) => !s.archived && sessionActivity(task, s).activeTier !== undefined)) {
      if (visited.has(task.activeSubtask)) break;
      visited.add(task.activeSubtask);
      const child = this.taskOf(task.activeSubtask);
      if (!child) break;
      task = child;
      sessions = this.sessionsOf(child.slug);
    }
    let status: { tier: number; s: Session; value: string } | undefined;
    let active: { tier: number; s: Session } | undefined;
    // Lower tier wins, then the newest session, then the greater id.
    const newer = (a: Session, b: Session) => a.created > b.created || (a.created === b.created && a.id > b.id);
    for (const s of sessions) {
      if (s.archived) continue;
      const p = sessionActivity(task, s);
      if (p.status && (!status || p.status[0] < status.tier || (p.status[0] === status.tier && newer(s, status.s)))) status = { tier: p.status[0], s, value: p.status[1] };
      if (p.activeTier !== undefined && (!active || p.activeTier < active.tier || (p.activeTier === active.tier && newer(s, active.s)))) active = { tier: p.activeTier, s };
    }
    const definition = this.definitionOf(task, task.slug);
    return create(TaskActivitySchema, {
      status: status?.value ?? "",
      activeSession: active && {
        id: active.s.id,
        worktree: active.s.worktree,
        phase: active.s.phase,
        harness: active.s.harness,
        model: active.s.model,
        playbook: task.playbookRef?.key ?? active.s.playbook,
        generic: active.s.generic,
        stepTitle: active.s.generic ? "Generic" : (definition?.steps.find((x) => x.key === active.s.phase)?.title ?? active.s.phase),
      },
    });
  }

  /**
   * The paths to re-read after `rel` changed. A name file moves its session. A file a task row is derived
   * from moves that task, and so every task above it (a parent's activity follows its active subtask); a
   * task.md moves the tasks above it.
   */
  private sessionMetas(slug: string): string[] {
    try {
      return readdirSync(join(this.alinery, "tasks", slug, "sessions"))
        .filter((name) => name.endsWith(".meta.json"))
        .map((name) => `tasks/${slug}/sessions/${name}`);
    } catch {
      return [];
    }
  }

  dependents = (rel: string): string[] => {
    const root = rel.match(/^sessions\/([^/]+)\.name\.json$/);
    if (root) return [`sessions/${root[1]}.meta.json`];
    const m = rel.match(/^tasks\/([^/]+)\/(.+)$/);
    if (!m) return [];
    const name = m[2].match(/^sessions\/([^/]+)\.name\.json$/);
    if (name) return [`tasks/${m[1]}/sessions/${name[1]}.meta.json`];
    const input = TASK_INPUT.test(m[2]);
    if (!input && m[2] !== "task.md") return [];
    const out = input ? [`tasks/${m[1]}/task.md`] : [];
    // A task's name is what its sessions' attention notifications call them.
    if (m[2] === "task.md") out.push(...this.sessionMetas(m[1]));
    const seen = new Set([m[1]]);
    for (let parent = this.taskOf(m[1])?.parentTask; parent && !seen.has(parent); parent = this.taskOf(parent)?.parentTask) {
      seen.add(parent);
      out.push(`tasks/${parent}/task.md`);
    }
    return out;
  };
}

/** What a task row is derived from, besides task.md: its sessions, playbook snapshot, execution file and artifacts. */
const TASK_INPUT = /^(?:sessions\/[^/]+\.meta\.json|playbook\.md|execution\.json|artifacts\/(?!attachments\/|subtasks\/).+)$/;
