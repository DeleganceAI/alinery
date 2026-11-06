// The board, task lists and session lists from the daemon's entities (plan S3.5): what
// `list_board_tasks`, `list_tasks`, `get_task`, `list_task_activity`, `list_sessions`,
// `list_session_items` and `get_session_display` answered, read from subscriptions. Task rows come from
// each repo's repo scope; session rows from a task scope, opened only for tasks that have sessions.

import { create } from "@bufbuild/protobuf";
import type { Entity, Session, Task } from "alinery-proto/alinery/v1/entities_pb";
import { ScopeSchema } from "alinery-proto/alinery/v1/sync_pb";
import { useEffect, useMemo, useState } from "react";
import type {
  BoardTask,
  SessionDisplayMeta,
  SessionListItem,
  SessionMeta,
  SessionNameSource,
  TaskActivityMap,
  TaskActivityRef,
  TaskActivityStatus,
  TaskActivitySummary,
} from "../types";
import { acquireScope, REPO_SCOPE } from "./hooks";
import { usePendingVersion, withPendingTasks } from "./pendingTasks";
import type { Replica } from "./replica";

export const taskEntityKey = (slug: string) => `task/${slug}/${slug}`;
const num = (v: bigint | undefined) => (v === undefined ? null : Number(v));

/** The `BoardTask` a Task entity stands for; `repoPath` is the repo key the board addresses it by. */
export function boardTaskOf(e: Entity, repoPath: string): BoardTask | undefined {
  return e.value.case === "task" ? boardTaskFromProto(e.value.value, repoPath) : undefined;
}

/** The same row from a `Task` message that did not come from the stream (a write's reply). */
export function boardTaskFromProto(t: Task, repoPath: string): BoardTask {
  const b = t.board;
  return {
    name: t.name,
    slug: t.slug,
    requested_slug: t.requestedSlug || undefined,
    parent_task: t.parentTask || undefined,
    active_subtask: t.activeSubtask || undefined,
    subtask_outcome: (t.subtaskOutcome || "") as BoardTask["subtask_outcome"],
    branch: t.branch,
    worktree: t.worktree,
    has_worktree: t.hasWorktree,
    created: Number(t.created),
    archived: t.archived,
    pr_url: t.prUrl,
    linear_id: t.linearId,
    github_issue: t.githubIssue,
    playbook: t.playbook,
    engine_version: t.engineVersion,
    playbook_ref: t.playbookRef ? { scope: t.playbookRef.scope as "bundled" | "global" | "repo", key: t.playbookRef.key } : undefined,
    max_live_sessions: t.maxLiveSessions,
    launch_defaults: t.launchDefaults ? { harness: t.launchDefaults.harness, model: t.launchDefaults.model } : undefined,
    auto_advance: t.autoAdvance,
    auto_approve_all: t.autoApproveAll,
    step_models: { ...t.stepModels },
    draft: t.draft,
    draft_base_ref: t.draftBaseRef ?? null,
    related_tasks: t.relatedTasks.map((r) => ({ repo_path: r.repoPath, slug: r.slug, name: r.name })),
    repo_path: repoPath,
    session_count: Number(b?.sessionCount ?? 0n),
    playbook_title: b?.playbookTitle ?? t.playbook,
    playbook_steps: (b?.playbookSteps ?? []).map((s) => ({ key: s.key, title: s.title })),
    updated: Number(b?.updated ?? 0n),
    current_phase: b?.currentPhase ?? "",
    current_step_title: b?.currentStepTitle ?? "",
    latest_session_title: b?.latestSessionTitle ?? "",
    // The columns are the board's own to assign; the Rust board left these empty too.
    latest_session_column_key: "",
    current_column_key: "",
    current_column_title: "",
  };
}

export function activityOf(e: Entity | undefined): TaskActivitySummary {
  const a = e?.value.case === "task" ? e.value.value.activity : undefined;
  const s = a?.activeSession;
  return {
    status: (a?.status || null) as TaskActivityStatus | null,
    active_session: s
      ? { id: s.id, worktree: s.worktree, phase: s.phase, harness: s.harness, model: s.model, playbook: s.playbook, generic: s.generic, step_title: s.stepTitle }
      : null,
  };
}

/** The meta and display name a Session entity stands for. */
export function sessionDisplayOf(e: Entity): SessionDisplayMeta | undefined {
  if (e.value.case !== "session") return undefined;
  const s: Session = e.value.value;
  const sem = s.semantic;
  const meta: SessionMeta = {
    id: s.id,
    worktree: s.worktree,
    created: Number(s.created),
    archived: s.archived,
    pinned: s.pinned,
    phase: s.phase,
    harness: s.harness,
    model: s.model,
    playbook: s.playbook,
    execution_id: s.executionId,
    execution_revision: Number(s.executionRevision),
    generic: s.generic,
    subtask_manager: s.subtaskManager,
    subtask_slug: s.subtaskSlug,
    artifact: s.artifact,
    handoff_artifact: s.handoffArtifact,
    prompt_extra: s.promptExtra,
    prompt: s.prompt ?? null,
    started_at: num(s.startedAt),
    status_changed_at: num(s.statusChangedAt),
    activity_at: num(s.activityAt),
    status_revision: Number(s.statusRevision),
    ended_at: num(s.endedAt),
    exit_code: s.exitCode ?? null,
    harness_resume_token: s.harnessResumeToken,
    resume_of: s.resumeOf ?? null,
    notification_read_at: num(s.notificationReadAt),
    exit_notification_read_at: num(s.exitNotificationReadAt),
    notification_suppression: s.notificationSuppression ? { notice: s.notificationSuppression.notice as never, occurrence: s.notificationSuppression.occurrence } : null,
    semantic: sem ? { phase_completed_at: num(sem.phaseCompletedAt), omp_session_id: sem.ompSessionId ?? null, omp_turn_id: num(sem.ompTurnId) } : null,
  };
  return { ...meta, name: s.name ?? null, name_source: (s.nameSource || null) as SessionNameSource | null, name_error: s.nameError ?? null };
}

const sessionsOf = (replica: Replica, slug: string): SessionDisplayMeta[] =>
  replica
    .all()
    .filter((e) => e.key.startsWith(`session/${slug}/`))
    .flatMap((e) => sessionDisplayOf(e) ?? [])
    .sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** Re-render when any of these replicas changes. The array must keep its identity between renders (state or `useMemo`). */
function useChanges(replicas: Replica[]): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const offs = replicas.map((r) => r.listen(() => setVersion((v) => v + 1)));
    setVersion((v) => v + 1);
    return () => {
      for (const off of offs) off();
    };
  }, [replicas]);
  return version;
}

/** The replicas for these repos' scopes, opened while the component is mounted. */
function useRepoReplicas(repos: string[], enabled: boolean): Replica[] {
  const [replicas, setReplicas] = useState<Replica[]>([]);
  const key = JSON.stringify(enabled ? repos : []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: key stands for repos
  useEffect(() => {
    const wanted: string[] = JSON.parse(key);
    const mine = wanted.map((repo) => acquireScope(repo, REPO_SCOPE));
    setReplicas(mine.map((m) => m.replica));
    return () => {
      for (const m of mine) m.release();
      setReplicas([]);
    };
  }, [key]);
  return replicas;
}

export type RepoBoardState = { loaded: boolean; reachable: boolean; stale: boolean };
export type RepoBoard = {
  tasks: BoardTask[];
  /** Per repo key: a repo whose daemon is down is `stale` (last known rows) or never `loaded`; the others stay live. */
  repos: Record<string, RepoBoardState>;
  /** At least one wanted repo has a snapshot (or none is wanted). */
  loaded: boolean;
};

/** Task rows of these repos, oldest first, each repo from its own stream (a down repo does not blank the others). */
export function useRepoBoard(repos: string[], enabled = true): RepoBoard {
  const replicas = useRepoReplicas(repos, enabled);
  const version = useChanges(replicas) + usePendingVersion();
  // biome-ignore lint/correctness/useExhaustiveDependencies: version stands for the replicas' contents
  return useMemo(() => {
    const out: BoardTask[] = [];
    const states: Record<string, RepoBoardState> = {};
    const wanted = enabled ? repos : [];
    replicas.forEach((replica, i) => {
      const repo = wanted[i];
      if (repo === undefined) return;
      states[repo] = { loaded: replica.ready, reachable: replica.reachable, stale: replica.stale };
      const rows: BoardTask[] = [];
      for (const e of replica.all()) {
        const t = boardTaskOf(e, repo);
        if (t) rows.push(t);
      }
      out.push(...withPendingTasks(repo, rows, replica.cursor));
    });
    out.sort((a, b) => a.created - b.created);
    // One repo's snapshot is enough to draw a board; a repo that has not answered (down, or a daemon this app cannot use) shows its banner and no tasks.
    const loaded = replicas.length === wanted.length && (wanted.length === 0 || Object.values(states).some((s) => s.loaded));
    return { tasks: out, repos: states, loaded };
  }, [replicas, version, enabled, JSON.stringify(repos)]);
}

/** One repo's tasks as `list_tasks` answered, or null before its first snapshot. */
export function useRepoTasks(repo: string | undefined): BoardTask[] | null {
  const replicas = useRepoReplicas(repo ? [repo] : [], !!repo);
  const version = useChanges(replicas) + usePendingVersion();
  // biome-ignore lint/correctness/useExhaustiveDependencies: version stands for the replicas' contents
  return useMemo(() => {
    const replica = replicas[0];
    if (!replica?.ready || !repo) return null;
    const rows = replica
      .all()
      .flatMap((e) => [boardTaskOf(e, repo)])
      .filter((t): t is BoardTask => !!t)
      .sort((a, b) => a.created - b.created);
    return withPendingTasks(repo, rows, replica.cursor);
  }, [replicas, version, repo]);
}

/** A task as `get_task` answered: undefined before the first snapshot, null once the repo is loaded and has no such task. */
export function useBoardTask(repo: string | undefined, slug: string): BoardTask | null | undefined {
  const replicas = useRepoReplicas(repo ? [repo] : [], !!repo);
  const version = useChanges(replicas) + usePendingVersion();
  // biome-ignore lint/correctness/useExhaustiveDependencies: version stands for the replicas' contents
  return useMemo(() => {
    const replica = replicas[0];
    if (!repo || !replica?.ready) return undefined;
    const e = replica.get(taskEntityKey(slug));
    const row = e && boardTaskOf(e, repo);
    if (row) return row;
    // The row of a task just created is not in the replica yet: its pending card stands in for it.
    return withPendingTasks(repo, [], replica.cursor).find((t) => t.slug === slug) ?? null;
  }, [replicas, version, slug, repo]);
}

/** Link state of one repo's repo scope, for a view that shows a stale banner. */
export function useRepoLink(repo: string | undefined): RepoBoardState {
  const replicas = useRepoReplicas(repo ? [repo] : [], !!repo);
  useChanges(replicas);
  const r = replicas[0];
  return { loaded: !!r?.ready, reachable: !!r?.reachable, stale: !!r?.stale };
}

/** Task activity for these tasks, as `list_task_activity` keyed it (`<repo>:<slug>`). */
export function useTaskActivityMap(refs: TaskActivityRef[], enabled = true): TaskActivityMap {
  const repos = useMemo(() => [...new Set(refs.map((r) => r.repoPath))], [JSON.stringify(refs.map((r) => r.repoPath))]);
  const replicas = useRepoReplicas(repos, enabled);
  const version = useChanges(replicas);
  const refsKey = JSON.stringify(refs.map((r) => [r.repoPath, r.taskSlug]));
  // biome-ignore lint/correctness/useExhaustiveDependencies: version stands for the replicas' contents; refsKey for refs
  return useMemo(() => {
    const out: TaskActivityMap = {};
    if (!enabled) return out;
    for (const r of refs) {
      const replica = replicas[repos.indexOf(r.repoPath)];
      out[`${r.repoPath}:${r.taskSlug}`] = activityOf(replica?.get(taskEntityKey(r.taskSlug)));
    }
    return out;
  }, [replicas, version, refsKey, enabled]);
}

const taskScope = (slug: string) => create(ScopeSchema, { kind: { case: "task", value: { slug } } });

/** A task's session rows as `list_sessions` answered, oldest first; null before the stream's first snapshot. */
export function useTaskSessions(repo: string | undefined, slug: string): SessionDisplayMeta[] | null {
  const [state, setState] = useState<{ replica: Replica } | null>(null);
  useEffect(() => {
    if (!repo || !slug) return setState(null);
    const mine = acquireScope(repo, taskScope(slug));
    setState({ replica: mine.replica });
    return () => {
      mine.release();
      setState(null);
    };
  }, [repo, slug]);
  const replicas = useMemo(() => (state ? [state.replica] : []), [state]);
  const version = useChanges(replicas);
  // biome-ignore lint/correctness/useExhaustiveDependencies: version stands for the replica's contents
  return useMemo(() => (state?.replica.ready ? sessionsOf(state.replica, slug) : null), [state, version, slug]);
}

/** One session as `get_session_display` answered: the row plus its task's and subtask's names; null until both streams have a snapshot, undefined-free. */
export function useSessionDisplay(
  repo: string | undefined,
  taskSlug: string,
  id: string,
): { session: SessionDisplayMeta | null; taskName: string; subtaskName: string | null; loaded: boolean } {
  const sessions = useTaskSessions(repo, taskSlug);
  const task = useBoardTask(repo, taskSlug);
  const session = sessions?.find((s) => s.id === id) ?? null;
  const subtask = useBoardTask(repo, session?.subtask_slug ?? "");
  return { session, taskName: task?.name ?? "", subtaskName: session?.subtask_slug ? (subtask?.name ?? null) : null, loaded: sessions !== null && task !== undefined };
}

/**
 * Session rows of these repos' unarchived tasks, newest first, as `list_session_items` answered. Task
 * rows come from the repo scopes; sessions from one task scope per task that has any.
 */
export function useSessionItems(repos: string[], includeArchived: boolean, enabled = true): { items: SessionListItem[]; loaded: boolean } {
  const board = useRepoBoard(repos, enabled);
  const withSessions = useMemo(() => board.tasks.filter((t) => !t.archived), [board.tasks]);
  // A task's total counts archived sessions, which the rows need only when they are shown.
  const sessionTasks = useMemo(() => withSessions.filter((t) => t.session_count > 0 || includeArchived), [withSessions, includeArchived]);
  const key = JSON.stringify(sessionTasks.map((t) => [t.repo_path, t.slug]));
  const [held, setHeld] = useState<{ repo: string; slug: string; replica: Replica }[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: key stands for sessionTasks
  useEffect(() => {
    const mine = (JSON.parse(key) as [string, string][]).map(([repo, slug]) => ({ repo, slug, ...acquireScope(repo, taskScope(slug)) }));
    setHeld(mine.map(({ repo, slug, replica }) => ({ repo, slug, replica })));
    return () => {
      for (const m of mine) m.release();
      setHeld([]);
    };
  }, [key]);
  const version = useChanges(useMemo(() => held.map((h) => h.replica), [held]));
  // biome-ignore lint/correctness/useExhaustiveDependencies: version stands for the replicas' contents
  return useMemo(() => {
    const items: SessionListItem[] = [];
    for (const h of held) {
      const task = sessionTasks.find((t) => t.repo_path === h.repo && t.slug === h.slug);
      if (!task) continue;
      const steps = task.playbook_steps;
      const all = sessionsOf(h.replica, h.slug);
      for (const s of all) {
        if (!includeArchived && s.archived) continue;
        const step = steps.find((x) => x.key === s.phase);
        const subtask = s.subtask_slug ? withSessions.find((t) => t.repo_path === h.repo && t.slug === s.subtask_slug) : undefined;
        items.push({
          ...s,
          task_slug: h.slug,
          task_name: task.name,
          subtask_name: subtask?.name ?? null,
          task_worktree: task.worktree,
          repo_path: h.repo,
          playbook_title: task.playbook_title,
          step_title: s.generic ? "Generic" : (step?.title ?? s.phase),
          is_playbook_step: !s.generic && !!s.execution_id && !!step,
        });
      }
    }
    items.sort(
      (a, b) =>
        b.created - a.created ||
        (a.repo_path < b.repo_path ? -1 : a.repo_path > b.repo_path ? 1 : 0) ||
        (a.task_slug < b.task_slug ? -1 : a.task_slug > b.task_slug ? 1 : 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    return { items, loaded: board.loaded && held.length === sessionTasks.length && held.every((h) => h.replica.ready) };
  }, [held, version, sessionTasks, withSessions, includeArchived, board.loaded]);
}
