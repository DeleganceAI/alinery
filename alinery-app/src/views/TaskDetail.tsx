import { ArrowLeft } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { ArtifactComment, ArtifactCommentAnchor } from "../ArtifactMarkdown";
import { ArtifactMarkdown, formatArtifactCommentTarget } from "../ArtifactMarkdown";
import { ArtifactTree, isDirectOwnedArtifactNode } from "../ArtifactTree";
import { archiveBoardTask } from "../archiveTask";
import type { ArtifactPaneTab } from "../artifactClassification";
import { artifactPaneItems, artifactPaneTreeNodes } from "../artifactClassification";
import { CopyArtifactButton, CopyTextButton, copyTextToClipboard } from "../chat/CopyMessage";
import { confirmDanger } from "../confirm";
import * as ipc from "../ipc";
import { PlaybookGraph } from "../PlaybookGraph";
import { PullRequestIndicator } from "../PullRequestIndicator";
import {
  classifySessionNotice,
  hasAcknowledgedExit,
  hasUnacknowledgedExit,
  orderTaskPanelRows,
  PRIORITY_SESSION_SORT,
  type SessionSort,
  sameSessionObservationMaps,
  selectSessionSort,
  sessionSortArrow,
  sessionStartedAt,
  sessionUpdatedAt,
} from "../sessionAttention";
import {
  ArchiveTaskModal,
  ArtifactProvenanceBadges,
  Checkbox,
  EMPTY_TASK_ACTIVITY,
  EmptyState,
  finalizedSubtaskNotice,
  harnessDisplayName,
  InlineStatus,
  KillButton,
  repoName,
  SessionTimestamp,
  StatusDot,
  sameArtifactListItems,
  sameSessionMetas,
  sameTask,
  TaskActivityIndicators,
  taskKey,
  useMinuteNow,
} from "../shared";
import { toast } from "../toast";
import type {
  AppearancePrefs,
  ArtifactListItem,
  ArtifactTreeNode,
  AutoAdvanceSummary,
  BoardNav,
  BoardTask,
  PlaybookStepSummary,
  RelatedTaskRef,
  SessionMeta,
  SessionObservation,
  SubtaskManagerState,
  Task,
  TaskActivitySummary,
  TaskPanelRow,
} from "../types";
import { useArtifactCommentDrafts } from "../useArtifactCommentDrafts";
import { useArtifactPaneWidth } from "../useArtifactPaneWidth";
import { useSessionSort } from "../useSessionSort";
import { useTaskPullRequests } from "../useTaskPullRequests";

function taskActivityLabel(activity: TaskActivitySummary): string {
  switch (activity.status) {
    case "running":
      return "Running";
    case "waiting_for_input":
      return "Waiting for input";
    case "waiting_for_approval":
      return "Waiting for approval";
    case "failed":
      return "Failed";
    case "completed":
      return "Completed";
    default:
      return "No active session";
  }
}

function subtaskOutcomeLabel(task: Pick<Task, "archived" | "subtask_outcome">): string {
  if (task.subtask_outcome) return task.subtask_outcome.toUpperCase();
  return task.archived ? "ARCHIVED" : "";
}

function subtaskOutcomeClass(task: Pick<Task, "subtask_outcome">): string {
  return task.subtask_outcome ? `subtask-outcome-${task.subtask_outcome}` : "session-archived";
}
type ArtifactReviewPendingStatus = {
  artifact: string;
  review: string;
};

type ErrState = { msg: string; detail: string } | null;

// Sessions and artifacts fail (and recover) independently, so each keeps its own detail
// string and the warning bar is derived. A shared warning could not be cleared by whichever
// resource recovered first, leaving a stale "Couldn't load sessions." above healthy rows.
function combineLoadWarnings(sessions: string, artifacts: string): ErrState {
  const parts: string[] = [];
  const details: string[] = [];
  if (sessions) {
    parts.push("sessions");
    details.push(sessions);
  }
  if (artifacts) {
    parts.push("artifacts");
    details.push(artifacts);
  }
  return parts.length ? { msg: `Couldn't load ${parts.join(" and ")}.`, detail: details.join(" | ") } : null;
}

// ---- task detail --------------------------------------------------------------
export function TaskDetail({
  slug,
  repoPath,
  initialTask,
  onBack,
  onOpenSession,
  onOpenRelatedTask,
  onNewSession,
  onDuplicate,
  duplicating,
  registerNav,
  onDiagramZoomOpenChange,
  appearance,
  onAppearanceChange,
  knownRepos,
  sessionSort: controlledSessionSort,
  onSessionSortChange,
}: {
  slug: string;
  repoPath: string;
  initialTask?: Task;
  onBack: () => void;
  onOpenSession: (
    ownerTaskSlug: string,
    id: string,
    cwd: string,
    phase: string,
    harness: string,
    model: string,
    playbook: string,
    generic: boolean,
    intent?: "attach" | "spawn" | "resume" | "history",
  ) => void;
  onNewSession: () => void;
  onOpenRelatedTask: (slug: string, relatedRepoPath?: string) => void;
  knownRepos?: string[];
  onDuplicate: (task: Task) => void;
  duplicating: boolean;
  registerNav: (n: BoardNav | null) => void;
  appearance: AppearancePrefs;
  onAppearanceChange: (next: AppearancePrefs) => void;
  onDiagramZoomOpenChange?: (open: boolean) => void;
  sessionSort?: SessionSort;
  onSessionSortChange?: (sort: SessionSort) => void;
}) {
  const [task, setTask] = useState<Task | null>(initialTask ?? null);
  const pullRequests = useTaskPullRequests(task && task.slug === slug && !task.draft ? [{ repoPath, taskSlug: slug }] : []);
  const pullRequest = pullRequests[`${repoPath}:${slug}`];
  const taskMutationEpoch = useRef(0);
  const [repoTasks, setRepoTasks] = useState<Task[]>([]);
  const primaryPlaybook = task?.playbook || "superdevelop";
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [sessionStatuses, setSessionStatuses] = useState<Record<string, SessionObservation>>({});
  const [subtaskState, setSubtaskState] = useState<SubtaskManagerState | null>(null);
  const [childActivity, setChildActivity] = useState<TaskActivitySummary>(EMPTY_TASK_ACTIVITY);
  const [childPlaybookStep, setChildPlaybookStep] = useState("");
  const [steps, setSteps] = useState<PlaybookStepSummary[]>([]);
  const [playbookDetails, setPlaybookDetails] = useState<Record<string, { title: string; steps: PlaybookStepSummary[] }>>({});
  const [autoAdvanceEdges, setAutoAdvanceEdges] = useState<AutoAdvanceSummary[]>([]);
  const [err, setErr] = useState<ErrState>(null);
  const [sessionsError, setSessionsError] = useState("");
  const [artifactsError, setArtifactsError] = useState("");
  const loadWarning = combineLoadWarnings(sessionsError, artifactsError);
  const [busy, setBusy] = useState("");
  const [boardTasks, setBoardTasks] = useState<BoardTask[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [sessionSort, setSessionSort] = useSessionSort(
    controlledSessionSort !== undefined && onSessionSortChange !== undefined ? { sort: controlledSessionSort, onChange: onSessionSortChange } : undefined,
  );
  const sessionNow = useMinuteNow();
  const [artifactItems, setArtifactItems] = useState<ArtifactListItem[]>([]);
  const [artifactTree, setArtifactTree] = useState<ArtifactTreeNode[]>([]);
  const artifactNames = artifactItems.map((a) => a.name);
  // Attachments are excluded so one named e.g. 03-design.md can never tick a phase badge or
  // flip the session sort. artifactNames stays unfiltered — it backs the shown/total pills.
  const artifactNameSet = new Set(artifactItems.filter((artifact) => !artifact.attachment).map((artifact) => artifact.name));
  const isPrimarySession = (session: SessionMeta) => {
    if (!task || session.generic) return false;
    const playbook = session.playbook || primaryPlaybook;
    return playbook === primaryPlaybook && steps.some((step) => step.key === session.phase);
  };
  const expectedArtifactForSession = (session: SessionMeta, fallback = "") => {
    if (session.artifact) return session.artifact;
    if (fallback) return fallback;
    const playbook = session.playbook || primaryPlaybook;
    return playbookDetails[playbook]?.steps.find((step) => step.key === session.phase)?.artifact || "";
  };
  const filteredSessions = showArchived ? sessions : sessions.filter((session) => !session.archived);
  const hasExpectedArtifact = (session: SessionMeta) => {
    const expected = expectedArtifactForSession(session);
    return !!expected && artifactNameSet.has(expected);
  };
  const unacknowledgedExitedSessions = sessions.filter((session) => !session.archived && hasUnacknowledgedExit(session));
  const prioritySessions = orderTaskPanelRows(
    filteredSessions.map<TaskPanelRow>((session) => ({ kind: "session", session })),
    sessionStatuses,
    hasExpectedArtifact,
    PRIORITY_SESSION_SORT,
  ).flatMap((row) => (row.kind === "subtask_history" ? [] : [row.session]));
  const finishedChildren = new Map(
    repoTasks
      .filter((candidate) => candidate.archived && candidate.parent_task === slug)
      .sort((a, b) => b.created - a.created || b.slug.localeCompare(a.slug))
      .map((candidate) => [candidate.slug, candidate]),
  );
  const finishedManagerByChild = new Map<string, SessionMeta>();
  for (const session of prioritySessions) {
    if (session.subtask_manager && session.subtask_slug && finishedChildren.has(session.subtask_slug) && !finishedManagerByChild.has(session.subtask_slug)) {
      finishedManagerByChild.set(session.subtask_slug, session);
    }
  }
  const finishedRowByManagerId = new Map<string, TaskPanelRow>();
  const managerlessFinishedRows: TaskPanelRow[] = [];
  for (const child of finishedChildren.values()) {
    const session = finishedManagerByChild.get(child.slug);
    if (session) {
      finishedRowByManagerId.set(session.id, { kind: "subtask_manager", session, owner_task_slug: slug, child, active_child: false });
    } else {
      managerlessFinishedRows.push({ kind: "subtask_history", child });
    }
  }
  const currentManagerRow: TaskPanelRow | null = subtaskState?.manager_session
    ? {
        kind: "subtask_manager",
        session: subtaskState.manager_session,
        owner_task_slug: subtaskState.manager_owner_task_slug,
        child: subtaskState.active_subtask ?? undefined,
        active_child: subtaskState.active_subtask !== null,
      }
    : null;
  const projectedRows = filteredSessions.flatMap<TaskPanelRow>((session) => {
    if (currentManagerRow?.session.id === session.id) return [currentManagerRow];
    const finishedRow = finishedRowByManagerId.get(session.id);
    if (finishedRow) return [finishedRow];
    return session.subtask_manager ? [] : [{ kind: "session", session }];
  });
  if (currentManagerRow && !projectedRows.some((row) => row.kind === "subtask_manager" && row.session.id === currentManagerRow.session.id)) {
    projectedRows.push(currentManagerRow);
  }
  projectedRows.push(...managerlessFinishedRows);
  const taskPanelRows = orderTaskPanelRows(projectedRows, sessionStatuses, hasExpectedArtifact, sessionSort);
  const latestSessionByPlaybookPhase = sessions
    .filter((s) => !s.archived && s.phase)
    .reduce<Record<string, SessionMeta>>((latest, s) => {
      const scope = `${s.playbook}\u0000${s.phase}`;
      const current = latest[scope];
      if (!current || s.created > current.created || (s.created === current.created && s.id > current.id)) {
        latest[scope] = s;
      }
      return latest;
    }, {});
  const sessionCountsByPhase = sessions
    .filter((session) => !session.archived && isPrimarySession(session))
    .reduce<Record<string, number>>((counts, session) => {
      counts[session.phase] = (counts[session.phase] ?? 0) + 1;
      return counts;
    }, {});
  const [selectedArtifact, setSelectedArtifact] = useState("");
  const [selectedArtifactNode, setSelectedArtifactNode] = useState<ArtifactTreeNode | null>(null);
  const selectedArtifactIsDirect = selectedArtifactNode ? isDirectOwnedArtifactNode(selectedArtifactNode) : false;
  const selectedArtifactItem = artifactItems.find((item) => item.name === selectedArtifact);
  const [artifactText, setArtifactText] = useState("");
  const [artifactMode, setArtifactMode] = useState<"preview" | "raw">("preview");
  const [artifactErr, setArtifactErr] = useState<ErrState>(null);
  const [sideTab, setSideTab] = useState<"playbook" | "artifacts">("playbook");
  const [artifactTab, setArtifactTab] = useState<ArtifactPaneTab>("playbook");
  const selectedArtifactTreeId = selectedArtifactNode?.id;
  const [artifactComments, setArtifactComments] = useState<ArtifactComment[]>([]);
  const [commentAnchor, setCommentAnchor] = useState<ArtifactCommentAnchor | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [commentBusy, setCommentBusy] = useState(false);
  const [reviewPending, setReviewPending] = useState<ArtifactReviewPendingStatus | null>(null);
  const [artifactWidth, artifactResizerProps] = useArtifactPaneWidth(appearance, onAppearanceChange);
  const [worktreeMissing, setWorktreeMissing] = useState(false);
  const [pendingArchive, setPendingArchive] = useState<Task | null>(null);
  const taskRef = useRef<Task | null>(null);
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  const {
    drafts: artifactCommentDrafts,
    draftError: artifactCommentDraftError,
    updateDraft: persistCommentDraft,
    discardDraft: discardCommentDraft,
    getDraft: getCommentDraft,
  } = useArtifactCommentDrafts(repoPath, slug);
  const selectedArtifactDrafts = selectedArtifactIsDirect ? artifactCommentDrafts.filter((draft) => draft.artifact === selectedArtifact) : [];
  const recoverableArtifactDrafts = selectedArtifactDrafts.filter((draft) => draft.anchor_id !== commentAnchor?.anchor_id);
  const recoverableArtifactDraftAnchorIds = recoverableArtifactDrafts.map((draft) => draft.anchor_id);
  taskRef.current = task;
  const playbookArtifactItems = artifactPaneItems(artifactItems, "playbook");
  const attachmentItems = artifactPaneItems(artifactItems, "attachments");
  const displayedArtifactItems = artifactPaneItems(artifactItems, artifactTab);
  const contextualArtifactTree = artifactPaneTreeNodes(
    artifactTree.filter((node) => node.source !== "owned"),
    artifactTab,
  );

  const refreshChildActivity = async (managerState: SubtaskManagerState, epoch: number) => {
    const childSlug = managerState.active_subtask?.slug;
    if (!childSlug) {
      if (epoch !== taskMutationEpoch.current) return;
      setChildActivity(EMPTY_TASK_ACTIVITY);
      setChildPlaybookStep("");
      return;
    }
    const [activity, boardTasks] = await Promise.all([
      ipc.listTaskActivity([{ repoPath, taskSlug: childSlug }]).catch(() => ({}) as Record<string, TaskActivitySummary>),
      ipc.listBoardTasks(false).catch(() => []),
    ]);
    if (epoch !== taskMutationEpoch.current) return;
    const child = boardTasks.find((candidate) => candidate.repo_path === repoPath && candidate.slug === childSlug);
    setChildActivity(activity[`${repoPath}:${childSlug}`] ?? EMPTY_TASK_ACTIVITY);
    setChildPlaybookStep(child ? [child.playbook_title, child.current_step_title].filter(Boolean).join(" · ") : (managerState.active_subtask?.playbook ?? ""));
  };

  const commitFetchedSubtaskState = async (fetched: SubtaskManagerState, epoch: number) => {
    if (epoch !== taskMutationEpoch.current) return;
    setSubtaskState(fetched);
    await refreshChildActivity(fetched, epoch);
  };

  // Pipeline progress: current = highest primary-playbook phase reached by a live session.
  const curIdx = sessions
    .filter((session) => !session.archived && isPrimarySession(session))
    .reduce((max, session) => {
      const index = steps.findIndex((step) => step.key === session.phase);
      return index > max ? index : max;
    }, -1);

  const commitFetchedTask = (fetched: Task | null, epoch: number) => {
    if (epoch !== taskMutationEpoch.current) return;
    setTask((current) => (current && fetched && sameTask(current, fetched) ? current : fetched));
  };

  const load = async () => {
    const taskFetchEpoch = taskMutationEpoch.current;
    // Every optional read is pre-wrapped so one rejection can never fail the shared
    // Promise.all — a removed custom playbook or a transient artifact-scan error must not
    // discard whatever else in this wave succeeded.
    const [taskResult, managerResult, tasksResult, playbooks, primarySteps, sessionsResult, artifactsResult, artifactTreeResult] = await Promise.all([
      ipc.getTask(slug).then(
        (value) => ({ ok: true, value }) as const,
        (error) => ({ ok: false, error }) as const,
      ),
      ipc.subtaskState(slug).then(
        (value) => ({ ok: true, value }) as const,
        () => ({ ok: false }) as const,
      ),
      ipc.listTasks().then(
        (value) => ({ ok: true, value }) as const,
        () => ({ ok: false }) as const,
      ),
      ipc.listPlaybooks().catch(() => []),
      ipc.listPlaybookSteps(primaryPlaybook).catch(() => [] as PlaybookStepSummary[]),
      ipc.listSessions(slug).then(
        (value) => ({ ok: true, value }) as const,
        (error) => ({ ok: false, error }) as const,
      ),
      ipc.listArtifactsWithMetadata(slug).then(
        (value) => ({ ok: true, value }) as const,
        (error) => ({ ok: false, error }) as const,
      ),
      ipc.listTaskArtifactTree(slug).then(
        (value) => ({ ok: true, value }) as const,
        () => ({ ok: false }) as const,
      ),
    ]);

    // getTask's success is independent of every other request here: its failure is the only
    // one that belongs in the "Couldn't load the task." error bar, and it must never discard
    // an already-seeded header.
    const t = taskResult.ok ? taskResult.value : null;
    if (taskResult.ok) {
      commitFetchedTask(t, taskFetchEpoch);
      ipc
        .listBoardTasks(true)
        .then(setBoardTasks)
        .catch(() => setBoardTasks([]));
      if (tasksResult.ok) setRepoTasks(tasksResult.value);
      if (managerResult.ok) await commitFetchedSubtaskState(managerResult.value, taskFetchEpoch);
      if (artifactTreeResult.ok) setArtifactTree(artifactTreeResult.value);
      if (t?.worktree) {
        ipc
          .worktreeExists(slug)
          .then((ok) => setWorktreeMissing(!ok))
          .catch(() => setWorktreeMissing(false));
      } else {
        setWorktreeMissing(false);
      }
    } else {
      setErr({ msg: "Couldn't load the task.", detail: String(taskResult.error) });
    }

    // Sessions and artifacts commit independently — an artifact scan failure must still show
    // sessions, and vice versa. "No sessions yet." is gated on sessionsLoaded so it can never
    // appear when listSessions itself never completed.
    const ss = sessionsResult.ok ? sessionsResult.value : [];
    if (sessionsResult.ok) {
      setSessions((current) => (sameSessionMetas(current, ss) ? current : ss));
      setSessionsLoaded(true);
      setSessionsError("");
    } else {
      setSessionsError(String(sessionsResult.error));
    }
    if (artifactsResult.ok) {
      setArtifactItems((current) => (sameArtifactListItems(current, artifactsResult.value) ? current : artifactsResult.value));
      setArtifactsError("");
    } else {
      setArtifactsError(String(artifactsResult.error));
    }

    // Wave 1's listPlaybookSteps guess is for `primaryPlaybook` (the seed). Trust it only
    // when the freshly fetched task actually agrees; a stale/absent seed's guess is
    // discarded rather than mislabeled as the real task's steps.
    const taskPlaybook = t?.playbook || primaryPlaybook;
    const details: Record<string, { title: string; steps: PlaybookStepSummary[] }> = {};
    if (taskPlaybook === primaryPlaybook) {
      details[primaryPlaybook] = { title: playbooks.find((w) => w.key === primaryPlaybook)?.title || primaryPlaybook, steps: primarySteps };
    }
    // Dependent tail: the task's real playbook (if the wave-1 guess missed) plus every
    // distinct session playbook not already covered, de-duplicated.
    const tailKeys = new Set<string>();
    if (!details[taskPlaybook]) tailKeys.add(taskPlaybook);
    for (const session of ss) {
      const key = session.playbook || taskPlaybook;
      if (!details[key]) tailKeys.add(key);
    }
    const [statuses, tailEntries] = await Promise.all([
      ipc
        .sessionStatuses(
          ss.map((session) => session.id),
          slug,
        )
        .catch(() => ({}) as Record<string, SessionObservation>),
      Promise.all(
        [...tailKeys].map(
          async (key) =>
            [
              key,
              {
                // An unregistered playbook (removed custom playbook, historical session)
                // degrades to a label with no steps instead of rejecting the whole batch.
                title: playbooks.find((w) => w.key === key)?.title || key,
                steps: await ipc.listPlaybookSteps(key).catch(() => [] as PlaybookStepSummary[]),
              },
            ] as const,
        ),
      ),
    ]);
    for (const [key, value] of tailEntries) details[key] = value;

    setPlaybookDetails(details);
    setSteps(details[taskPlaybook]?.steps ?? []);
    setAutoAdvanceEdges(playbooks.find((playbook) => playbook.key === taskPlaybook)?.auto_advance ?? []);
    setSessionStatuses((current) => (sameSessionObservationMaps(current, statuses) ? current : statuses));
  };

  const refreshLiveTaskState = async () => {
    const taskFetchEpoch = taskMutationEpoch.current;
    // Same independence as load(): a failing artifact scan on a 3s poll must not discard a
    // good listSessions result, and vice versa.
    const [tasksResult, managerResult, sessionsResult, artifactsResult, artifactTreeResult] = await Promise.all([
      ipc.listTasks().then(
        (value) => ({ ok: true, value }) as const,
        () => ({ ok: false }) as const,
      ),
      ipc.subtaskState(slug).then(
        (value) => ({ ok: true, value }) as const,
        () => ({ ok: false }) as const,
      ),
      ipc.listSessions(slug).then(
        (value) => ({ ok: true, value }) as const,
        () => ({ ok: false }) as const,
      ),
      ipc.listArtifactsWithMetadata(slug).then(
        (value) => ({ ok: true, value }) as const,
        () => ({ ok: false }) as const,
      ),
      ipc.listTaskArtifactTree(slug).then(
        (value) => ({ ok: true, value }) as const,
        () => ({ ok: false }) as const,
      ),
    ]);
    if (tasksResult.ok) {
      const refreshedTask = tasksResult.value.find((candidate) => candidate.slug === slug) ?? null;
      commitFetchedTask(refreshedTask, taskFetchEpoch);
      setRepoTasks(tasksResult.value);
    }
    if (managerResult.ok) await commitFetchedSubtaskState(managerResult.value, taskFetchEpoch);
    if (artifactTreeResult.ok) setArtifactTree(artifactTreeResult.value);
    // A successful poll is a recovery: clear that resource's warning and, for sessions, let
    // the empty state through — otherwise a failed first load left "No sessions yet." hidden
    // and the stale warning up forever. Poll *failures* stay silent (3s cadence would flap).
    if (artifactsResult.ok) {
      setArtifactItems((current) => (sameArtifactListItems(current, artifactsResult.value) ? current : artifactsResult.value));
      setArtifactsError("");
    }
    if (!sessionsResult.ok) return;
    const ss = sessionsResult.value;
    setSessions((current) => (sameSessionMetas(current, ss) ? current : ss));
    setSessionsLoaded(true);
    setSessionsError("");
    const statuses = await ipc
      .sessionStatuses(
        ss.map((session) => session.id),
        slug,
      )
      .catch(() => ({}) as Record<string, SessionObservation>);
    setSessionStatuses((current) => (sameSessionObservationMaps(current, statuses) ? current : statuses));
  };

  useEffect(() => {
    let alive = true;
    let timer = 0;
    // Every read inside load() is individually wrapped, so this only fires on an unexpected
    // throw — but without it that throw would be a silent unhandled rejection, which is what
    // the old whole-body try/catch prevented.
    load().catch((e) => setErr({ msg: "Couldn't load the task.", detail: String(e) }));
    // alineryd owns auto-advance creation; Task Detail only polls sessions/artifacts for display.
    const poll = () => {
      refreshLiveTaskState()
        .catch(() => {})
        .finally(() => {
          if (alive) timer = window.setTimeout(poll, 3000);
        });
    };
    timer = window.setTimeout(poll, 3000);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [repoPath, slug]);

  useEffect(() => {
    registerNav({
      moveRow: () => {},
      moveCol: () => {},
      openSelected: () => {},
      duplicateSelected: () => {
        const currentTask = taskRef.current;
        if (currentTask) onDuplicate(currentTask);
      },
      archiveSelected: () => {
        const currentTask = taskRef.current;
        if (currentTask && !currentTask.archived) setPendingArchive(currentTask);
      },
    });
    return () => registerNav(null);
  });

  useEffect(() => {
    let alive = true;
    if (!selectedArtifact || !selectedArtifactTreeId) {
      setArtifactText("");
      setArtifactComments([]);
      setReviewPending(null);
      setCommentAnchor(null);
      setCommentDraft("");
      return () => {
        alive = false;
      };
    }
    const commentsDisabled = !selectedArtifactIsDirect || selectedArtifact.endsWith(".comments.md");
    setArtifactText("");
    setArtifactErr(null);
    setReviewPending(null);
    setCommentAnchor(null);
    setCommentDraft("");
    if (commentsDisabled) {
      setArtifactComments([]);
    } else {
      ipc
        .listArtifactComments(slug, selectedArtifact)
        .then((comments) => {
          if (alive) setArtifactComments(comments);
        })
        .catch((e) => {
          if (alive) setArtifactErr({ msg: "Couldn't load artifact comments.", detail: String(e) });
        });
      ipc
        .artifactReviewPendingStatus(slug, selectedArtifact)
        .then((pending) => {
          if (alive) setReviewPending(pending);
        })
        .catch((e) => {
          if (alive) setArtifactErr({ msg: "Couldn't check review status.", detail: String(e) });
        });
    }
    const read = selectedArtifactIsDirect ? ipc.readArtifact(slug, selectedArtifact) : ipc.readTaskArtifactNode(slug, selectedArtifactTreeId);
    read
      .then((text) => {
        if (alive) setArtifactText(text);
      })
      .catch((e) => {
        if (alive) setArtifactErr({ msg: "Couldn't load the artifact.", detail: String(e) });
      });
    return () => {
      alive = false;
    };
  }, [slug, selectedArtifact, selectedArtifactTreeId, selectedArtifactIsDirect]);

  const trimmedCommentDraft = commentDraft.trim();
  const canSaveArtifactComment = Boolean(commentAnchor && selectedArtifact && trimmedCommentDraft && !commentBusy);

  const handleCommentDraftChange = (body: string) => {
    setCommentDraft(body);
    if (commentAnchor && selectedArtifact) persistCommentDraft(selectedArtifact, commentAnchor, body);
  };

  const saveArtifactComment = () => {
    if (!canSaveArtifactComment || !commentAnchor || !selectedArtifact) return;
    setCommentBusy(true);
    ipc
      .addArtifactCommentForRepo({
        repoPath,
        taskSlug: slug,
        artifact: selectedArtifact,
        anchorId: commentAnchor.anchor_id,
        anchorKind: commentAnchor.anchor_kind,
        anchorLabel: commentAnchor.anchor_label,
        anchorExcerpt: commentAnchor.anchor_excerpt,
        lineStart: commentAnchor.line_start,
        lineEnd: commentAnchor.line_end,
        body: trimmedCommentDraft,
      })
      .then((comments) => {
        setArtifactComments(comments);
        void discardCommentDraft(selectedArtifact, commentAnchor.anchor_id).catch(() => {});
        setCommentAnchor(null);
        setCommentDraft("");
      })
      .catch((e) => {
        setArtifactErr({ msg: "Couldn't save the comment.", detail: String(e) });
      })
      .finally(() => {
        setCommentBusy(false);
      });
  };

  const handleCommentKeyDown = (ev: KeyboardEvent<HTMLTextAreaElement>) => {
    if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      saveArtifactComment();
    }
  };

  const openArtifactComment = useCallback(
    (anchor: ArtifactCommentAnchor) => {
      const storedDraft = getCommentDraft(selectedArtifact, anchor.anchor_id);
      flushSync(() => {
        setCommentAnchor(anchor);
        setCommentDraft(storedDraft?.body ?? "");
      });
      commentInputRef.current?.focus();
    },
    [getCommentDraft, selectedArtifact],
  );

  const discardOpenCommentDraft = () => {
    if (commentAnchor && selectedArtifact) {
      void discardCommentDraft(selectedArtifact, commentAnchor.anchor_id).catch(() => {});
    }
    setCommentAnchor(null);
    setCommentDraft("");
  };

  const clearPendingReview = () => {
    if (!selectedArtifact) return;
    ipc
      .clearArtifactReviewPendingForRepo(repoPath, slug, selectedArtifact)
      .then(() => setReviewPending(null))
      .catch((e) => setArtifactErr({ msg: "Couldn't clear the waiting state.", detail: String(e) }));
  };

  const restoreTask = async () => {
    setErr(null);
    setBusy("restore");
    try {
      await ipc.restoreTaskForRepo(repoPath, slug);
      taskMutationEpoch.current += 1;
      const restoreEpoch = taskMutationEpoch.current;
      setTask((current) => (current ? { ...current, archived: false } : current));
      setSubtaskState(null);
      void ipc
        .subtaskState(slug)
        .then((value) => commitFetchedSubtaskState(value, restoreEpoch))
        .catch(() => {});
      toast("Task restored", "success");
    } catch (error) {
      setErr({ msg: "Couldn't restore the task.", detail: String(error) });
    } finally {
      setBusy("");
    }
  };

  const confirmArchive = (removeWt: boolean) => {
    void archiveBoardTask({ repo_path: repoPath, slug }, removeWt).then((failure) => {
      setPendingArchive(null);
      if (failure) {
        setErr(failure);
        return;
      }
      onBack();
    });
  };

  const openManagerSession = (ownerTaskSlug: string, manager: SessionMeta, intent: "attach" | "spawn" = "attach") => {
    onOpenSession(ownerTaskSlug, manager.id, manager.worktree, manager.phase, manager.harness, manager.model, manager.playbook, manager.generic, intent);
  };

  const startManager = () => {
    setBusy("subtask-manager");
    setErr(null);
    ipc
      .startSubtaskManager(slug)
      .then((manager) => openManagerSession(slug, manager, "spawn"))
      .catch((error) => setErr({ msg: "Couldn't start the sub-task manager.", detail: String(error) }))
      .finally(() => setBusy(""));
  };

  const recoverManager = () => {
    setBusy("subtask-recovery");
    setErr(null);
    ipc
      .recoverSubtaskManager(slug)
      .then((manager) => openManagerSession(slug, manager, "spawn"))
      .catch((error) => setErr({ msg: "Couldn't recover the sub-task manager.", detail: String(error) }))
      .finally(() => setBusy(""));
  };

  const discardSubtask = async (manager: SessionMeta | null, child?: { name: string; slug: string }) => {
    const childSlug = child?.slug || manager?.subtask_slug || "";
    const childName = child?.name || childSlug;
    const setupOnly = !childSlug;
    const busyKey = manager?.id || "active-child";
    const accepted = await confirmDanger(
      setupOnly ? "Discard sub-task setup?" : `Kill ${childName}?`,
      setupOnly
        ? "This will kill and permanently delete the Sub-task setup manager session."
        : `This will stop every live session in ${childName} and its active nested sub-tasks. Their task records, sessions, artifacts, worktrees, and branches will remain available as killed history.`,
      setupOnly ? "Discard setup" : "Kill sub-task",
    );
    if (!accepted) return;
    setBusy(`discard-subtask:${busyKey}`);
    setErr(null);
    try {
      await ipc.discardSubtask(slug, manager?.id || "");
      await load();
    } catch (error) {
      setErr({ msg: setupOnly ? "Couldn't discard the sub-task setup." : "Couldn't kill the sub-task.", detail: String(error) });
    } finally {
      setBusy("");
    }
  };

  const acknowledgeExitedSessions = async () => {
    setBusy("acknowledge-exits");
    setErr(null);
    try {
      await Promise.all(unacknowledgedExitedSessions.map((session) => ipc.markSessionNotificationRead(repoPath, slug, session.id)));
      await load();
    } catch (error) {
      setErr({ msg: "Couldn't acknowledge exited sessions.", detail: String(error) });
    } finally {
      setBusy("");
    }
  };

  const relatedTags = task?.related_tasks ?? [];
  const relatedCandidates = boardTasks.filter((candidate) => {
    if (candidate.archived || candidate.draft) return false;
    if (candidate.repo_path === repoPath && candidate.slug === slug) return false;
    return !relatedTags.some((tag) => tag.repo_path === candidate.repo_path && tag.slug === candidate.slug);
  });
  const saveRelated = (next: RelatedTaskRef[]) => {
    setBusy("related");
    setErr(null);
    ipc
      .setRelatedTasksForRepo(repoPath, slug, next)
      .then((updated) => setTask(updated))
      .catch((e) => setErr({ msg: "Couldn't update related tasks.", detail: String(e) }))
      .finally(() => setBusy(""));
  };

  const finalizedNotice = task ? finalizedSubtaskNotice(task, subtaskState?.parent_task) : "";

  return (
    <div className="detail taskdetail" style={{ ["--artifact-width" as string]: `${artifactWidth}px` }}>
      <main className="detailmain">
        <section className="task-panel task-info-panel">
          <div className="task-panel-head task-info-head">
            <div>
              <div className="task-panel-label">Task</div>
              <h2>{task?.name ?? slug}</h2>
            </div>
            <button type="button" className="btn ghost small" onClick={onBack}>
              <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" /> Back
            </button>
          </div>

          {subtaskState?.parent_task && (
            <button type="button" className="task-parent-breadcrumb" onClick={() => onOpenRelatedTask(subtaskState.parent_task?.slug ?? "")}>
              ← Parent task · {subtaskState.parent_task.name}
            </button>
          )}

          {finalizedNotice && <InlineStatus tone="warning">{finalizedNotice}</InlineStatus>}

          {steps.length > 0 && (
            <div className="pipe">
              {steps.map((p, i) => (
                <div key={p.key} className={`phase${i < curIdx ? " done" : i === curIdx ? " cur" : ""}`} aria-current={i === curIdx ? "step" : undefined}>
                  {p.title}
                </div>
              ))}
            </div>
          )}

          <div className="task-info-grid">
            {task?.linear_id && (
              <div className="kv">
                <span className="k">Linear</span>
                <span className="v">{task.linear_id}</span>
              </div>
            )}
            {task?.github_issue && (
              <div className="kv">
                <span className="k">GitHub</span>
                <span className="v">{task.github_issue}</span>
                <CopyTextButton text={task.github_issue} label="GitHub issue" />
              </div>
            )}
            <div className="kv">
              <span className="k">Branch</span>
              <span className="v mono">{task?.branch}</span>
              <CopyTextButton text={task?.branch ?? ""} label="branch" />
            </div>
            <div className="kv">
              <span className="k">Worktree</span>
              <span className="v mono">
                {!task?.has_worktree ? (
                  <span className="dim">none — using main repo</span>
                ) : !task?.worktree ? (
                  <span className="danger-text">removed</span>
                ) : worktreeMissing ? (
                  <span className="danger-text">{task.worktree} — missing on disk</span>
                ) : (
                  task.worktree
                )}
              </span>
              {task?.worktree && <CopyTextButton text={task.worktree} label="worktree path" />}
            </div>
            <div className="kv">
              <span className="k">PR URL</span>
              <span className="v mono">
                <PullRequestIndicator snapshot={pullRequest} />
                {!pullRequest?.pr && (task?.pr_url ? task.pr_url : <span className="dim">not available</span>)}
              </span>
              <CopyTextButton text={pullRequest?.pr?.url ?? task?.pr_url ?? ""} label="PR URL" />
              <button
                type="button"
                className="btn ghost small"
                disabled={!task?.worktree || worktreeMissing || !!task?.archived || !!busy}
                title={
                  task?.archived
                    ? "Task is archived — read-only"
                    : !task?.worktree
                      ? "Worktree removed — action unavailable"
                      : worktreeMissing
                        ? "Worktree missing on disk"
                        : "Push the branch and copy the compare URL"
                }
                onClick={() => {
                  setBusy("push");
                  setErr(null);
                  ipc
                    .pushAndCompareUrlForRepo(repoPath, slug)
                    .then(async (url) => {
                      setTask((current) => (current ? { ...current, pr_url: url } : current));
                      await copyTextToClipboard(url).catch(() => undefined);
                    })
                    .catch((e) => setErr({ msg: "Push failed.", detail: String(e) }))
                    .finally(() => setBusy(""));
                }}
              >
                {busy === "push" ? "Pushing…" : "Push + copy compare URL"}
              </button>
            </div>
          </div>

          <div className="task-related">
            <div className="task-related-head">
              <span className="k">Related</span>
              <select
                className="field-input"
                aria-label="Tag a related task"
                value=""
                disabled={!!task?.archived || !!busy || relatedCandidates.length === 0}
                onChange={(event) => {
                  const key = event.target.value;
                  const candidate = relatedCandidates.find((item) => taskKey(item) === key);
                  if (!candidate) return;
                  saveRelated([...relatedTags, { repo_path: candidate.repo_path, slug: candidate.slug, name: candidate.name }]);
                }}
              >
                <option value="">{relatedCandidates.length ? "Tag a related task…" : "No other open tasks"}</option>
                {relatedCandidates.map((candidate) => (
                  <option key={taskKey(candidate)} value={taskKey(candidate)}>
                    {candidate.name}
                    {candidate.repo_path !== repoPath ? ` — ${repoName(candidate.repo_path)}` : ""}
                  </option>
                ))}
              </select>
            </div>
            {relatedTags.length > 0 && (
              <div className="task-related-tags">
                {relatedTags.map((tag) => {
                  const open = !knownRepos || knownRepos.includes(tag.repo_path);
                  const label = tag.name || tag.slug;
                  return (
                    <span key={`${tag.repo_path}:${tag.slug}`} className={`task-related-tag${open ? "" : " closed"}`}>
                      <button
                        type="button"
                        className="task-related-tag-open"
                        aria-label={open ? `Open ${label}` : `${label} (repository closed)`}
                        disabled={!open}
                        title={open ? `Open ${label}` : "Repository is closed"}
                        onClick={() => open && onOpenRelatedTask(tag.slug, tag.repo_path)}
                      >
                        {label}
                        {tag.repo_path !== repoPath ? <span className="dim"> · {repoName(tag.repo_path)}</span> : null}
                      </button>
                      <button
                        type="button"
                        className="task-related-tag-remove"
                        disabled={!!task?.archived || !!busy}
                        aria-label={`Remove related task ${label}`}
                        onClick={() => saveRelated(relatedTags.filter((item) => item.repo_path !== tag.repo_path || item.slug !== tag.slug))}
                      >
                        ×
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
          </div>
          <div className="crow task-actions-row">
            <button type="button" className="btn ghost small" disabled={!task || duplicating} title="Duplicate task (⌘D)" onClick={() => task && onDuplicate(task)}>
              Duplicate Task · ⌘D
            </button>
            {task?.archived ? (
              task.parent_task ? (
                <>
                  <button type="button" className="btn ghost small" disabled title="Sub-tasks cannot be restored.">
                    Restore task
                  </button>
                  <span className="dim">Sub-tasks cannot be restored.</span>
                </>
              ) : (
                <button type="button" className="btn ghost small" disabled={busy === "restore"} onClick={() => void restoreTask()}>
                  {busy === "restore" ? "Restoring…" : "Restore task"}
                </button>
              )
            ) : (
              <button type="button" className="btn ghost small" title="Archive task (⌘E)" onClick={() => task && setPendingArchive(task)}>
                Archive task
              </button>
            )}
          </div>
        </section>

        <section className="task-panel task-sessions-panel">
          <div className="task-panel-head">
            <h3 className="task-panel-title">Sessions</h3>
            <div className="task-session-controls">
              <button
                type="button"
                className={`btn ghost small session-sort-control${sessionSort.field === "priority" ? " active" : ""}`}
                aria-pressed={sessionSort.field === "priority"}
                onClick={() => setSessionSort(PRIORITY_SESSION_SORT)}
              >
                Priority
              </button>
              <Checkbox checked={showArchived} onChange={setShowArchived} label="Show archived" />
              {unacknowledgedExitedSessions.length > 0 && (
                <button type="button" className="btn ghost small" disabled={!!busy} onClick={() => void acknowledgeExitedSessions()}>
                  {busy === "acknowledge-exits" ? "Acknowledging…" : "Acknowledge exited sessions"}
                </button>
              )}
              <button
                type="button"
                className="btn ghost small"
                disabled={!subtaskState?.can_start || !!busy}
                title={subtaskState?.disabled_reason || undefined}
                onClick={startManager}
              >
                {busy === "subtask-manager" ? "Starting…" : "Start sub-task"}
              </button>
              {subtaskState && !subtaskState.can_start && !(task && (task.archived || !task.worktree || worktreeMissing)) && (
                <span className="dim task-session-disabled">{subtaskState.disabled_reason}</span>
              )}
              {task && (task.archived || !task.worktree || worktreeMissing) ? (
                <span className="dim task-session-disabled">
                  {task.archived
                    ? task.worktree
                      ? "task archived — read-only"
                      : "Task archived; worktree removed. Restoring keeps it available for history and related-task links, but new sessions remain disabled."
                    : worktreeMissing
                      ? "worktree missing on disk"
                      : "Worktree removed — new sessions are disabled. Create a new task, tag this one as related, and continue the work there."}
                </span>
              ) : (
                <button type="button" className="btn small" disabled={!!busy} onClick={onNewSession}>
                  New session
                </button>
              )}
            </div>
          </div>
          {err && (
            <InlineStatus tone="error" detail={err.detail}>
              {err.msg}
            </InlineStatus>
          )}
          {loadWarning && (
            <InlineStatus tone="warning" detail={loadWarning.detail}>
              {loadWarning.msg}
            </InlineStatus>
          )}
          <div className="task-session-table-wrap">
            <table className="task-table task-session-table">
              <thead>
                <tr>
                  <th className="status-col">Status</th>
                  <th>Step</th>
                  <th>Harness</th>
                  <th className="session-time-col" aria-sort={sessionSort.field === "started" ? (sessionSort.direction === "desc" ? "descending" : "ascending") : undefined}>
                    <button
                      type="button"
                      className={`session-sort-header${sessionSort.field === "started" ? " active" : ""}`}
                      aria-label={
                        sessionSort.field === "started"
                          ? `Started, sorted ${sessionSort.direction === "desc" ? "newest first" : "oldest first"}. Activate to sort ${sessionSort.direction === "desc" ? "oldest first" : "newest first"}`
                          : "Sort by Started, newest first"
                      }
                      onClick={() => setSessionSort(selectSessionSort(sessionSort, "started"))}
                    >
                      Started {sessionSortArrow(sessionSort, "started")}
                    </button>
                  </th>
                  <th className="session-time-col" aria-sort={sessionSort.field === "updated" ? (sessionSort.direction === "desc" ? "descending" : "ascending") : undefined}>
                    <button
                      type="button"
                      className={`session-sort-header${sessionSort.field === "updated" ? " active" : ""}`}
                      aria-label={
                        sessionSort.field === "updated"
                          ? `Updated, sorted ${sessionSort.direction === "desc" ? "newest first" : "oldest first"}. Activate to sort ${sessionSort.direction === "desc" ? "oldest first" : "newest first"}`
                          : "Sort by Updated, newest first"
                      }
                      onClick={() => setSessionSort(selectSessionSort(sessionSort, "updated"))}
                    >
                      Updated {sessionSortArrow(sessionSort, "updated")}
                    </button>
                  </th>
                  <th className="session-actions-col" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {sessionsLoaded && taskPanelRows.length === 0 && !subtaskState?.can_recover && (
                  <tr className="empty-row">
                    <td colSpan={6}>
                      <EmptyState title="No sessions yet." hint="Start a session to run a harness in this task's worktree." />
                    </td>
                  </tr>
                )}
                {taskPanelRows.map((row) => {
                  if (row.kind === "subtask_history") {
                    const outcome = subtaskOutcomeLabel(row.child);
                    return (
                      <tr key={`subtask-history:${row.child.slug}`} className="subtask-manager-row">
                        <td className="status-col">
                          <span className="statusdot unknown" title="No manager session record" />
                        </td>
                        <td>
                          <button type="button" className="manager-row-primary" onClick={() => onOpenRelatedTask(row.child.slug)}>
                            <span title={row.child.name}>{row.child.name}</span>
                            <span className="dim mono" title={row.child.slug}>
                              {row.child.slug}
                            </span>
                            {outcome && <span className={`pill ${subtaskOutcomeClass(row.child)}`}>{outcome}</span>}
                          </button>
                          <span className="badge todo" title="Sub-task history">
                            Sub-task history
                          </span>
                        </td>
                        <td>
                          <span className="dim">—</span>
                        </td>
                        <td className="session-time-col">
                          <span className="dim">—</span>
                        </td>
                        <td className="session-time-col">
                          <span className="dim">—</span>
                        </td>
                        <td className="session-actions">
                          <button type="button" className="btn ghost small" onClick={() => onOpenRelatedTask(row.child.slug)}>
                            Open task
                          </button>
                        </td>
                      </tr>
                    );
                  }
                  const s = row.session;
                  const obs = sessionStatuses[s.id] ?? null;
                  const isLive = obs ? obs.lifecycle.state === "live" : false;
                  if (row.kind === "subtask_manager") {
                    const label = row.child ? row.child.name : "Sub-task setup";
                    const detail = row.child?.slug;
                    const harnessLabel = `${harnessDisplayName(s.harness)}${s.model ? ` · ${s.model}` : ""}`;
                    const canReplaceThisManager = row.active_child && subtaskState?.can_recover === true && subtaskState.manager_session?.id === s.id;
                    const activate = () => {
                      if (row.child) onOpenRelatedTask(row.child.slug);
                      else openManagerSession(row.owner_task_slug, s);
                    };
                    return (
                      <tr key={`manager:${row.owner_task_slug}:${s.id}`} className="subtask-manager-row">
                        <td className="status-col">
                          <StatusDot
                            id={s.id}
                            slug={row.owner_task_slug}
                            repoPath={repoPath}
                            minimal
                            observation={obs ?? undefined}
                            exitCode={s.exit_code}
                            exitAcknowledged={hasAcknowledgedExit(s)}
                          />
                        </td>
                        <td>
                          <button type="button" className="manager-row-primary" onClick={activate}>
                            <span title={label}>{label}</span>
                            {detail && (
                              <span className="dim mono" title={detail}>
                                {detail}
                              </span>
                            )}
                            {row.child?.archived && <span className={`pill ${subtaskOutcomeClass(row.child)}`}>{subtaskOutcomeLabel(row.child)}</span>}
                            {row.child && row.active_child && (
                              <span
                                className="subtask-child-progress"
                                title={`Child playbook: ${childPlaybookStep || row.child.playbook}. Status: ${taskActivityLabel(childActivity)}`}
                              >
                                <span className="subtask-child-step">{childPlaybookStep || row.child.playbook}</span>
                                <span className="subtask-child-activity">
                                  <TaskActivityIndicators activity={childActivity} />
                                  <span>{taskActivityLabel(childActivity)}</span>
                                </span>
                              </span>
                            )}
                          </button>
                          <span className="badge todo" title={canReplaceThisManager ? "Manager unavailable" : "Sub-task manager"}>
                            {canReplaceThisManager ? "Manager unavailable" : "Sub-task manager"}
                          </span>
                        </td>
                        <td>
                          <span className="pill" title={harnessLabel}>
                            {harnessLabel}
                          </span>
                        </td>
                        <td className="session-time-col">
                          <SessionTimestamp kind="started" value={sessionStartedAt(s)} now={sessionNow} />
                        </td>
                        <td className="session-time-col">
                          <SessionTimestamp kind="updated" value={sessionUpdatedAt(s)} now={sessionNow} />
                        </td>
                        <td className="session-actions">
                          {!row.child?.archived && (
                            <button
                              type="button"
                              className="btn danger small"
                              disabled={!!busy}
                              onClick={(event) => {
                                event.stopPropagation();
                                void discardSubtask(s, row.child ?? undefined);
                              }}
                            >
                              {busy === `discard-subtask:${s.id}` ? (row.child ? "Killing…" : "Discarding…") : row.child ? "Kill sub-task" : "Discard setup"}
                            </button>
                          )}
                          {canReplaceThisManager && (
                            <button type="button" className="btn ghost small" disabled={!!busy} onClick={recoverManager}>
                              {busy === "subtask-recovery" ? "Recovering…" : "Replace manager session"}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn ghost small"
                            disabled={!!busy}
                            onClick={(event) => {
                              event.stopPropagation();
                              openManagerSession(row.owner_task_slug, s);
                            }}
                          >
                            Open manager session
                          </button>
                        </td>
                      </tr>
                    );
                  }

                  const resumedBy = sessions.find((other) => other.resume_of === s.id);
                  const scope = `${s.playbook}\u0000${s.phase}`;
                  const superseded = !s.archived && !!s.phase && latestSessionByPlaybookPhase[scope]?.id !== s.id;
                  const playbookKey = s.playbook || primaryPlaybook;
                  const playbook = playbookDetails[playbookKey];
                  const stepTitle = playbook?.steps.find((step) => step.key === s.phase)?.title || s.phase;
                  const sessionType = s.subtask_manager ? "Sub-task manager" : s.generic ? "Generic" : s.phase ? `${playbook?.title || playbookKey} · ${stepTitle}` : "—";
                  const harnessLabel = `${harnessDisplayName(s.harness)}${s.model ? ` · ${s.model}` : ""}`;
                  const unreadCompletion = classifySessionNotice(s, obs ?? undefined) === "unread_completion";
                  const openable = Boolean(task?.worktree) && !s.archived;
                  return (
                    <tr
                      key={s.id}
                      className={s.archived ? "row-archived" : openable ? "session-row-openable" : undefined}
                      tabIndex={openable ? 0 : undefined}
                      aria-label={openable ? `Open session ${sessionType}` : undefined}
                      onClick={(event) => {
                        if (!openable || (event.target as HTMLElement).closest("button")) return;
                        onOpenSession(slug, s.id, s.worktree, s.phase, s.harness, s.model, s.playbook, s.generic);
                      }}
                      onKeyDown={(event) => {
                        if (!openable || event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
                        event.preventDefault();
                        event.currentTarget.click();
                      }}
                    >
                      <td className="status-col">
                        <StatusDot
                          id={s.id}
                          slug={slug}
                          repoPath={repoPath}
                          minimal
                          observation={obs}
                          superseded={superseded}
                          unreadCompletion={unreadCompletion}
                          exitCode={s.exit_code}
                          exitAcknowledged={hasAcknowledgedExit(s)}
                        />
                      </td>
                      <td>
                        <div className="session-step-cell">
                          <span className="pill" title={sessionType}>
                            {sessionType}
                          </span>
                          {s.archived && <span className="pill session-archived">Archived</span>}
                          {resumedBy && <span className="pill dim">Resumed</span>}
                        </div>
                      </td>
                      <td>
                        <span className="pill" title={harnessLabel}>
                          {harnessLabel}
                        </span>
                      </td>
                      <td className="session-time-col">
                        <SessionTimestamp kind="started" value={sessionStartedAt(s)} now={sessionNow} />
                      </td>
                      <td className="session-time-col">
                        <SessionTimestamp kind="updated" value={sessionUpdatedAt(s)} now={sessionNow} />
                      </td>
                      <td className="session-actions">
                        <KillButton id={s.id} slug={slug} repoPath={repoPath} live={isLive} onKilled={load} />
                        <button type="button" className="btn ghost small" disabled={s.archived} onClick={() => ipc.archiveSessionForRepo(repoPath, slug, s.id).then(load)}>
                          Archive
                        </button>
                        {s.archived && (
                          <button
                            type="button"
                            className="btn ghost small"
                            title="Replay this archived session's recorded activity (read-only)"
                            onClick={() => onOpenSession(slug, s.id, s.worktree, s.phase, s.harness, s.model, s.playbook, s.generic, "history")}
                          >
                            View history
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {subtaskState?.can_recover && subtaskState.active_subtask && !currentManagerRow && (
                  <tr className="subtask-manager-row">
                    <td className="status-col">
                      <span className="statusdot unknown" />
                    </td>
                    <td>
                      <button type="button" className="manager-row-primary" onClick={() => onOpenRelatedTask(subtaskState.active_subtask?.slug ?? "")}>
                        <span title={subtaskState.active_subtask.name}>{subtaskState.active_subtask.name}</span>
                        <span className="dim mono" title={subtaskState.active_subtask.slug}>
                          {subtaskState.active_subtask.slug}
                        </span>
                      </button>
                      <span className="badge todo" title="Manager unavailable">
                        Manager unavailable
                      </span>
                    </td>
                    <td />
                    <td className="session-time-col">
                      <span className="dim">—</span>
                    </td>
                    <td className="session-time-col">
                      <span className="dim">—</span>
                    </td>
                    <td className="session-actions">
                      <button type="button" className="btn danger small" disabled={!!busy} onClick={() => void discardSubtask(null, subtaskState.active_subtask ?? undefined)}>
                        {busy === "discard-subtask:active-child" ? "Killing…" : "Kill sub-task"}
                      </button>
                      <button type="button" className="btn ghost small" disabled={!!busy} onClick={recoverManager}>
                        {busy === "subtask-recovery" ? "Recovering…" : "Replace manager session"}
                      </button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
      <div className="artifact-resizer" {...artifactResizerProps} />
      <aside className="artifactpane">
        {selectedArtifact ? (
          <>
            <div className="artifacthead">
              <button
                type="button"
                className="btn ghost small"
                aria-label="Back to artifact list"
                title="Back to artifact list"
                onClick={() => {
                  setSelectedArtifact("");
                  setSelectedArtifactNode(null);
                  setArtifactErr(null);
                }}
              >
                <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" />
              </button>
              <div className="artifacttitle mono" title={selectedArtifact}>
                {selectedArtifact}
              </div>
              <ArtifactProvenanceBadges handoffs={selectedArtifactItem?.handoffs} onOpenRelatedTask={onOpenRelatedTask} />
              <CopyArtifactButton text={artifactText} />
              <button
                type="button"
                className={`btn ghost small${artifactMode === "preview" ? " on" : ""}`}
                aria-pressed={artifactMode === "preview"}
                onClick={() => setArtifactMode("preview")}
              >
                Preview
              </button>
              <button
                type="button"
                className={`btn ghost small${artifactMode === "raw" ? " on" : ""}`}
                aria-pressed={artifactMode === "raw"}
                onClick={() => setArtifactMode("raw")}
              >
                Raw
              </button>
            </div>
            {artifactErr && (
              <InlineStatus tone="error" detail={artifactErr.detail}>
                {artifactErr.msg}
              </InlineStatus>
            )}
            {artifactCommentDraftError && (
              <InlineStatus tone="error" detail={artifactCommentDraftError}>
                Comment drafts aren't being saved.
              </InlineStatus>
            )}
            {reviewPending && (
              <div className="artifact-review-pending">
                <span>
                  {reviewPending.review} sent. {selectedArtifact} has not changed yet.
                </span>
                <button type="button" className="btn ghost small" onClick={clearPendingReview}>
                  Clear waiting
                </button>
              </div>
            )}
            <div className="artifactviewer">
              {artifactMode === "raw" ? (
                <pre className="artifactraw">{artifactText}</pre>
              ) : (
                <article className="md artifactmd">
                  <ArtifactMarkdown
                    text={artifactText}
                    comments={artifactComments}
                    draftAnchorIds={recoverableArtifactDraftAnchorIds}
                    onAddComment={selectedArtifactIsDirect && !selectedArtifact.endsWith(".comments.md") ? openArtifactComment : undefined}
                    onDiagramZoomOpenChange={onDiagramZoomOpenChange}
                  />
                </article>
              )}
            </div>
            {recoverableArtifactDrafts.length > 0 && (
              <div className="artifact-comment-drafts">
                <div className="artifact-comment-drafts-title">Unsaved drafts</div>
                {recoverableArtifactDrafts.map((draft) => (
                  <div className="artifact-comment-draft-row" key={draft.anchor_id}>
                    <button type="button" className="artifact-comment-draft-resume" title={draft.body} onClick={() => openArtifactComment(draft)}>
                      <span>{formatArtifactCommentTarget(draft)}</span>
                      {draft.stale && <span className="artifact-comment-draft-stale">Artifact changed</span>}
                    </button>
                    <button type="button" className="btn ghost small" onClick={() => void discardCommentDraft(selectedArtifact, draft.anchor_id).catch(() => {})}>
                      Discard
                    </button>
                  </div>
                ))}
              </div>
            )}
            {commentAnchor && (
              <div className="artifact-comment-composer">
                <div className="artifact-comment-title">{formatArtifactCommentTarget(commentAnchor)}</div>
                <textarea
                  ref={commentInputRef}
                  className="field-input artifact-comment-input"
                  value={commentDraft}
                  rows={2}
                  placeholder="Add a comment for the next phase..."
                  onChange={(ev) => handleCommentDraftChange(ev.target.value)}
                  onKeyDown={handleCommentKeyDown}
                />
                <div className="artifact-comment-actions">
                  <button type="button" className="btn small" disabled={!canSaveArtifactComment} onClick={saveArtifactComment}>
                    Save comment
                  </button>
                  <button type="button" className="btn ghost small" onClick={discardOpenCommentDraft}>
                    Discard draft
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="artifacthead">
              <div className="artifacttabs" role="group" aria-label="Task side panel">
                <button type="button" aria-pressed={sideTab === "playbook"} className={`artifacttab${sideTab === "playbook" ? " on" : ""}`} onClick={() => setSideTab("playbook")}>
                  Playbook
                </button>
                <button
                  type="button"
                  aria-pressed={sideTab === "artifacts"}
                  className={`artifacttab${sideTab === "artifacts" ? " on" : ""}`}
                  onClick={() => setSideTab("artifacts")}
                >
                  Artifacts
                </button>
              </div>
              {sideTab === "artifacts" && <span className="pill">{artifactNames.length}</span>}
            </div>
            {sideTab === "playbook" ? (
              <div className="playbook-side-scroll">
                <PlaybookGraph
                  title={playbookDetails[primaryPlaybook]?.title || primaryPlaybook}
                  steps={steps}
                  countsByStep={sessionCountsByPhase}
                  autoAdvanceEdges={autoAdvanceEdges}
                  selectedAutoAdvance={task?.auto_advance}
                />
              </div>
            ) : (
              <>
                {artifactErr && (
                  <InlineStatus tone="error" detail={artifactErr.detail}>
                    {artifactErr.msg}
                  </InlineStatus>
                )}
                <div className="artifacthead">
                  <div className="artifacttabs" role="group" aria-label="Artifact category">
                    <button
                      type="button"
                      aria-pressed={artifactTab === "playbook"}
                      className={`artifacttab${artifactTab === "playbook" ? " on" : ""}`}
                      onClick={() => setArtifactTab("playbook")}
                    >
                      Playbook
                    </button>
                    <button
                      type="button"
                      aria-pressed={artifactTab === "attachments"}
                      className={`artifacttab${artifactTab === "attachments" ? " on" : ""}`}
                      onClick={() => setArtifactTab("attachments")}
                    >
                      Attachments
                    </button>
                  </div>
                  <span className="pill">
                    {artifactTab === "attachments" ? attachmentItems.length : playbookArtifactItems.length}/{artifactNames.length}
                  </span>
                </div>
                <div className="artifactlist">
                  {!artifactErr && displayedArtifactItems.length === 0 && contextualArtifactTree.length === 0 && (
                    <div className="dim">{artifactTab === "attachments" ? "No attachments." : "No playbook artifacts yet."}</div>
                  )}
                  {displayedArtifactItems.map((item) => (
                    // div, not <button>: the provenance badges inside are buttons themselves,
                    // and button-in-button is invalid HTML (same pattern as SessionView).
                    <div
                      key={item.name}
                      className={`artifactitem${item.attachment ? " attachment" : ""}`}
                      title={item.name}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if ((e.key !== "Enter" && e.key !== " ") || e.target !== e.currentTarget) return;
                        e.preventDefault();
                        e.currentTarget.click();
                      }}
                      onClick={() => {
                        if (item.attachment) {
                          ipc
                            .attachmentPath(slug, item.name)
                            .then(ipc.revealItemInDir)
                            .catch((e) => setArtifactErr({ msg: "Couldn't reveal the attachment.", detail: String(e) }));
                          return;
                        }
                        setSelectedArtifactNode(artifactTree.find((node) => node.source === "owned" && node.kind === "owned" && node.label === item.name) ?? null);
                        setSelectedArtifact(item.name);
                        setArtifactMode("preview");
                        setArtifactErr(null);
                      }}
                    >
                      <span className="artifactitem-name">{item.name}</span>
                      <ArtifactProvenanceBadges handoffs={item.handoffs} onOpenRelatedTask={onOpenRelatedTask} />
                    </div>
                  ))}
                  {contextualArtifactTree.length > 0 && (
                    <ArtifactTree
                      taskSlug={slug}
                      nodes={contextualArtifactTree}
                      selectedId={selectedArtifactTreeId}
                      onSelect={(node) => {
                        setSelectedArtifactNode(node);
                        setSelectedArtifact(node.label);
                        setArtifactMode("preview");
                        setArtifactErr(null);
                      }}
                      onError={(detail) => setArtifactErr({ msg: "Couldn't open the artifact.", detail })}
                    />
                  )}
                </div>
              </>
            )}
          </>
        )}
      </aside>
      <ArchiveTaskModal task={pendingArchive} onCancel={() => setPendingArchive(null)} onConfirm={confirmArchive} />
    </div>
  );
}
