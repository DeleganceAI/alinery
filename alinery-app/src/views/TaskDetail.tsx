import { ArrowLeft, ChevronDown, ChevronUp, List, Network, Pencil, Square } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { ArtifactCommentAnchor } from "../ArtifactMarkdown";
import { ArtifactMarkdown, formatArtifactCommentTarget } from "../ArtifactMarkdown";
import { ArtifactTree, isDirectOwnedArtifactNode, treeArtifactImages } from "../ArtifactTree";
import { AttachmentPreview } from "../AttachmentPreview";
import { type ArchiveTaskPhase, archiveBoardTask } from "../archiveTask";
import type { ArtifactPaneTab } from "../artifactClassification";
import { artifactPaneItems, artifactPaneTreeNodes } from "../artifactClassification";
import { CodeView } from "../CodeView";
import { classifyAttachment } from "../chat/attachments";
import { CopyArtifactButton, CopyTextButton, copyTextToClipboard } from "../chat/CopyMessage";
import { confirmDanger } from "../confirm";
import { GitDiffView, GitPanel, gitDiffTab } from "../GitPanel";
import { MainTabs, useOpenTabs } from "../MainTabs";
import { awaitingSessionName, NameEditor, PendingSessionName, restoreNameFocus } from "../NameEditor";
import { PaneResizer } from "../PaneResizer";
import { PlaybookGraph } from "../PlaybookGraph";
import { PullRequestIndicator } from "../PullRequestIndicator";
import { RepoFileTree } from "../RepoFileTree";
import { relatedRepoKey, relatedStoredPath, sameMachine } from "../remoteRepo";
import { revealPath } from "../revealPath";
import {
  classifySessionNotice,
  DEFAULT_TASK_SESSION_SORT,
  hasAcknowledgedExit,
  hasUnacknowledgedExit,
  orderTaskPanelRows,
  PRIORITY_SESSION_SORT,
  type SessionSort,
  selectSessionSort,
  sessionSortArrow,
  sessionStartedAt,
  sessionUpdatedAt,
} from "../sessionAttention";
import { canAbortChatSession } from "../sessionMessage";
import {
  ArchiveTaskModal,
  ArtifactProvenanceBadges,
  Checkbox,
  EMPTY_TASK_ACTIVITY,
  EmptyState,
  ExecutionAvailabilityNotice,
  ExecutionOutputs,
  finalizedSubtaskNotice,
  findOwnedArtifactNode,
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
import {
  addComment,
  attachmentFilePath,
  clearReviewPending,
  FileNotShown,
  openFilePath,
  readArtifactText,
  readNodeText,
  readWorktreeText,
  useTaskArtifacts,
} from "../sync/artifacts";
import { useBoardTask, useRepoBoard, useRepoTasks, useTaskActivityMap, useTaskSessions } from "../sync/board";
import { allowExecutionCompletion, useTaskExecution } from "../sync/execution";
import { type GitDiffTarget, pushAndCompareUrlForRepo } from "../sync/git";
import { sessionObservationKey, useSessionObservations } from "../sync/sessionObservation";
import { abortSession, archiveSession, markSessionNotificationRead, renameSession } from "../sync/sessions";
import { discardSubtask as discardSubtaskForRepo, subtaskState as fetchSubtaskState, startSubtaskManager } from "../sync/subtasks";
import { renameTask, restoreTaskForRepo, setAutoApproveAllForRepo, setRelatedTasksForRepo, worktreeExists } from "../sync/tasks";
import { TaskRunGraph } from "../TaskRunGraph";
import { toast } from "../toast";
import type {
  AppearancePrefs,
  ArtifactListItem,
  ArtifactTreeNode,
  BoardNav,
  NameCommit,
  RelatedTaskRef,
  SessionDisplayMeta,
  SessionMeta,
  SubtaskManagerState,
  Task,
  TaskActivitySummary,
  TaskExecutionReply,
  TaskPanelRow,
} from "../types";
import { useArtifactCommentDrafts } from "../useArtifactCommentDrafts";
import { useArtifactPaneWidth } from "../useArtifactPaneWidth";
import { useSessionSort } from "../useSessionSort";
import { useTaskPullRequests } from "../useTaskPullRequests";
import { isVinculumHarness, sessionTerminalLabel } from "../vinculumHarness";

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
type ErrState = { msg: string; detail: string; tone?: "info" } | null;

const TASK_SESSION_VIEW_KEY = "alinery.taskSessionView";

function readStoredTaskSessionView(): "graph" | "list" {
  try {
    return localStorage.getItem(TASK_SESSION_VIEW_KEY) === "list" ? "list" : "graph";
  } catch {
    return "graph";
  }
}

// ---- task detail --------------------------------------------------------------
/** An open tab of the main pane: a task artifact, or a file of the task's worktree (`repo`). */
/** `diff`: a commit or the staged or unstaged changes, opened from the Git side tab; it reads its own patch. */
/** A session opened from this task: its conversation shows as a tab here. The session view proper opens from the session list only. */
export type TaskSessionTarget = {
  taskSlug: string;
  id: string;
  cwd: string;
  phase: string;
  harness: string;
  model: string;
  playbook: string;
  generic: boolean;
  intent?: "attach" | "spawn" | "resume" | "history";
};
type OpenArtifactTab = {
  key: string;
  kind: "artifact" | "repo" | "diff" | "session";
  name: string;
  label?: string;
  node: ArtifactTreeNode | null;
  mode: "preview" | "raw";
  diff?: GitDiffTarget;
  session?: TaskSessionTarget;
};

/** One choice for every task: the header opens compact until the user expands it. */
const HEADER_OPEN_KEY = "alinery.taskHeaderOpen";
function readHeaderOpen(): boolean {
  try {
    return localStorage.getItem(HEADER_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** The compact header shows a worktree from `.alinery/` down; the full path stays in the tooltip and the copy button. */
export function shortWorktreePath(path: string): string {
  const at = path.indexOf("/.alinery/");
  return at < 0 ? path : path.slice(at + 1);
}

export function TaskDetail({
  slug,
  repoPath,
  initialTask,
  onBack,
  renderSession,
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
  onNameCommitted,
  onSessionSortChange,
}: {
  slug: string;
  repoPath: string;
  initialTask?: Task;
  onBack: () => void;
  /** The conversation of a session opened here, for its tab. `onClose` closes the tab (the session was archived); `onOpenPath`
   * opens a path from the conversation (`artifact:<name>` or `repo:<path>`) in this task's tabs. */
  renderSession: (target: TaskSessionTarget, actions: { onClose: () => void; onOpenPath: (target: string, keep?: boolean) => void }) => ReactNode;
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
  onNameCommitted?: (change: NameCommit) => void;
  onSessionSortChange?: (sort: SessionSort) => void;
}) {
  const [task, setTask] = useState<Task | null>(initialTask ?? null);
  const pullRequests = useTaskPullRequests(task && task.slug === slug && !task.draft ? [{ repoPath, taskSlug: slug }] : []);
  const pullRequest = pullRequests[`${repoPath}:${slug}`];
  const taskMutationEpoch = useRef(0);
  const nameReadRequest = useRef(0);
  const scopeRef = useRef({ repoPath, slug, alive: true });
  if (scopeRef.current.repoPath !== repoPath || scopeRef.current.slug !== slug) {
    scopeRef.current.alive = false;
    scopeRef.current = { repoPath, slug, alive: true };
    taskMutationEpoch.current += 1;
    nameReadRequest.current += 1;
  }
  const scope = scopeRef.current;
  const beginNameRead = () => {
    const epoch = taskMutationEpoch.current;
    const request = ++nameReadRequest.current;
    return () => scope.alive && scopeRef.current === scope && epoch === taskMutationEpoch.current && request === nameReadRequest.current;
  };
  const [repoTasks, setRepoTasks] = useState<Task[]>([]);
  const [executionView, setExecutionView] = useState<TaskExecutionReply | null>(null);
  const [executionError, setExecutionError] = useState("");
  const feed = useTaskExecution(repoPath, slug);
  const steps = executionView?.definition.step ?? [];
  const executions = Object.values(executionView?.state.executions ?? {});
  const executionForSession = (session: SessionMeta) =>
    executions.find((execution) => execution.owner_session_id === session.id || execution.previous_session_ids.includes(session.id));
  const activeExecutions = executions.filter((execution) => ["starting", "running", "finishing", "interrupted"].includes(execution.lifecycle));
  const queuedExecutionCount = executions.filter((execution) => execution.lifecycle === "queued" && execution.start_requested).length;
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [sessions, setSessions] = useState<SessionDisplayMeta[]>([]);
  // Status is read from the task's session stream, by session id.
  const statusRefs = useMemo(() => sessions.map((session) => ({ repo_path: repoPath, task_slug: slug, id: session.id })), [sessions, repoPath, slug]);
  const observed = useSessionObservations(statusRefs);
  const observationsById = useMemo(
    () =>
      Object.fromEntries(
        sessions.flatMap((session) =>
          observed[sessionObservationKey(repoPath, slug, session.id)] ? [[session.id, observed[sessionObservationKey(repoPath, slug, session.id)]]] : [],
        ),
      ),
    [sessions, observed, repoPath, slug],
  );
  const [subtaskState, setSubtaskState] = useState<SubtaskManagerState | null>(null);
  const [err, setErr] = useState<ErrState>(null);
  const [busy, setBusy] = useState("");
  const sessionArchivePending = useRef(false);
  const sessionStopPending = useRef(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const nameTrigger = useRef<HTMLButtonElement | null>(null);
  const editorVersion = useRef(0);
  // The task, its siblings and its sessions arrive on streams; the state above mirrors them so a local edit can show before the stream catches up.
  const boardRepos = useMemo(() => [...new Set([repoPath, ...(knownRepos ?? []).filter((repo) => sameMachine(repo, repoPath))])], [repoPath, knownRepos]);
  const boardTasks = useRepoBoard(boardRepos).tasks;
  const liveTask = useBoardTask(repoPath, slug);
  const liveRepoTasks = useRepoTasks(repoPath);
  const liveSessions = useTaskSessions(repoPath, slug);
  const liveArtifacts = useTaskArtifacts(repoPath, slug);
  const childSlug = subtaskState?.active_subtask?.slug ?? "";
  const childRefs = useMemo(() => (childSlug ? [{ repoPath, taskSlug: childSlug }] : []), [repoPath, childSlug]);
  const childActivity = useTaskActivityMap(childRefs)[`${repoPath}:${childSlug}`] ?? EMPTY_TASK_ACTIVITY;
  const childTask = boardTasks.find((candidate) => candidate.repo_path === repoPath && candidate.slug === childSlug);
  const childPlaybookStep = childSlug
    ? childTask
      ? [childTask.playbook_title, childTask.current_step_title].filter(Boolean).join(" · ")
      : (subtaskState?.active_subtask?.playbook ?? "")
    : "";
  const [showArchived, setShowArchived] = useState(false);
  const [sessionView, setSessionView] = useState(readStoredTaskSessionView);
  const [sessionSort, setSessionSort] = useSessionSort(
    controlledSessionSort !== undefined && onSessionSortChange !== undefined ? { sort: controlledSessionSort, onChange: onSessionSortChange } : undefined,
    DEFAULT_TASK_SESSION_SORT,
  );
  const sessionNow = useMinuteNow();
  const [artifactItems, setArtifactItems] = useState<ArtifactListItem[]>([]);
  const [artifactTree, setArtifactTree] = useState<ArtifactTreeNode[]>([]);
  const artifactNames = artifactItems.map((a) => a.name);
  const filteredSessions = showArchived ? sessions : sessions.filter((session) => !session.archived);
  const hasExpectedArtifact = (session: SessionMeta) => Boolean(executionForSession(session)?.receipt_id);
  const unacknowledgedExitedSessions = sessions.filter((session) => !session.archived && hasUnacknowledgedExit(session));
  const prioritySessions = orderTaskPanelRows(
    filteredSessions.map<TaskPanelRow>((session) => ({ kind: "session", session })),
    observationsById,
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
        session: sessions.find((session) => session.id === subtaskState.manager_session?.id) ?? subtaskState.manager_session,
        owner_task_slug: subtaskState.manager_owner_task_slug,
        child: subtaskState.active_subtask ?? undefined,
        active_child: subtaskState.active_subtask !== null,
      }
    : null;
  const projectedRows = filteredSessions.flatMap<TaskPanelRow>((session) => {
    if (currentManagerRow?.session.id === session.id) return [currentManagerRow];
    const finishedRow = finishedRowByManagerId.get(session.id);
    if (finishedRow) return [finishedRow];
    return session.subtask_manager
      ? [{ kind: "subtask_manager", session, owner_task_slug: slug, child: repoTasks.find((candidate) => candidate.slug === session.subtask_slug), active_child: false }]
      : [{ kind: "session", session }];
  });
  if (currentManagerRow && !projectedRows.some((row) => row.kind === "subtask_manager" && row.session.id === currentManagerRow.session.id)) {
    projectedRows.push(currentManagerRow);
  }
  projectedRows.push(...managerlessFinishedRows);
  const taskPanelRows = orderTaskPanelRows(projectedRows, observationsById, hasExpectedArtifact, sessionSort);
  // The main pane's tabs: Sessions is always first, then each opened artifact; a different task (or the same slug in
  // another repo) starts on Sessions.
  const fileTabs = useOpenTabs<OpenArtifactTab>(`${repoPath}\0${slug}`);
  const activeArtifactTab = fileTabs.current?.kind === "session" ? undefined : fileTabs.current;
  const selectedArtifact = activeArtifactTab?.name ?? "";
  const selectedArtifactNode = activeArtifactTab?.node ?? null;
  const artifactMode = activeArtifactTab?.mode ?? "preview";
  const setArtifactMode = fileTabs.setMode;
  // Lists open a file temporarily on a click and keep it on a double click (the second click's `detail` is 2).
  const openArtifactTab = (name: string, node: ArtifactTreeNode | null, kind: OpenArtifactTab["kind"] = "artifact", keep = true) => {
    fileTabs.open({ key: kind === "repo" ? `repo:${name}` : (node?.id ?? name), kind, name, node, mode: "preview" }, keep);
    setArtifactErr(null);
  };
  const selectedArtifactImages = useMemo(() => treeArtifactImages(artifactTree, selectedArtifactNode), [artifactTree, selectedArtifactNode]);
  const selectedIsRepo = activeArtifactTab?.kind === "repo";
  const selectedDiff = activeArtifactTab?.kind === "diff" ? activeArtifactTab.diff : undefined;
  // Only markdown previews; any other worktree file shows as text.
  const selectedPreviewable = !selectedIsRepo || /\.(md|markdown)$/i.test(selectedArtifact);
  const selectedArtifactIsDirect = activeArtifactTab?.kind === "artifact" && (selectedArtifactNode ? isDirectOwnedArtifactNode(selectedArtifactNode) : Boolean(selectedArtifact));
  const selectedArtifactItem = artifactItems.find((item) => item.name === selectedArtifact);
  const [artifactText, setArtifactText] = useState("");
  const [artifactErr, setArtifactErr] = useState<ErrState>(null);
  const [headerOpen, setHeaderOpen] = useState(readHeaderOpen);
  const toggleHeader = (open: boolean) => {
    setHeaderOpen(open);
    try {
      localStorage.setItem(HEADER_OPEN_KEY, open ? "1" : "0");
    } catch {
      // Storage can be blocked; the toggle still works for this view.
    }
  };
  const [sideTab, setSideTab] = useState<"playbook" | "artifacts" | "history" | "git">("artifacts");
  const [playbookView, setPlaybookView] = useState<"list" | "graph">("list");
  const [artifactTab, setArtifactTab] = useState<ArtifactPaneTab>("playbook");
  const selectedArtifactTreeId = selectedArtifactNode?.id;
  // A worktree file's comments target `repo:<path>`; the daemon keeps them under the task, never in the worktree.
  const commentTarget = selectedIsRepo ? `repo:${selectedArtifact}` : selectedArtifact;
  const canComment = selectedIsRepo ? selectedPreviewable : selectedArtifactIsDirect && !selectedArtifact.endsWith(".comments.md");
  const commentsEnabled = canComment && Boolean(selectedArtifact);
  // Comments and the waiting-for-review mark of the open artifact are rows of the task's stream: another window's change shows here with no poll.
  const artifactComments = useMemo(
    () => (commentsEnabled ? liveArtifacts.comments.filter((comment) => comment.artifact === commentTarget) : []),
    [commentsEnabled, liveArtifacts.comments, commentTarget],
  );
  const reviewPending = (commentsEnabled && liveArtifacts.pending.find((pending) => pending.artifact === commentTarget)) || null;
  const [commentAnchor, setCommentAnchor] = useState<ArtifactCommentAnchor | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [commentBusy, setCommentBusy] = useState(false);
  const [artifactWidth, artifactResizerProps, artifactCollapse] = useArtifactPaneWidth(appearance, onAppearanceChange, "left");
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
  const selectedArtifactDrafts = commentsEnabled ? artifactCommentDrafts.filter((draft) => draft.artifact === commentTarget) : [];
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

  const commitFetchedSubtaskState = async (fetched: SubtaskManagerState, isCurrent: () => boolean) => {
    if (!isCurrent()) return;
    setSubtaskState(fetched);
  };

  const commitFetchedTask = (fetched: Task | null) => {
    setTask((current) => (current && fetched && sameTask(current, fetched) ? current : fetched));
  };
  const allowCompletion = async (executionId: string) => {
    if (executionView?.live?.status !== "available" || executionView.state.history_only || executionError || busy) return;
    setBusy(`allow:${executionId}`);
    try {
      await allowExecutionCompletion(repoPath, slug, executionId, executionView.revision);
    } catch (error) {
      setExecutionError(String(error));
    } finally {
      setBusy("");
    }
  };

  const load = async () => {
    const isCurrent = beginNameRead();
    const managerResult = await fetchSubtaskState(repoPath, slug).then(
      (value) => ({ ok: true, value }) as const,
      () => ({ ok: false }) as const,
    );
    if (!scope.alive || scopeRef.current !== scope) return;
    if (!isCurrent()) return;

    if (managerResult.ok) await commitFetchedSubtaskState(managerResult.value, isCurrent);
  };

  const refreshLiveTaskState = async () => {
    const isCurrent = beginNameRead();
    const managerResult = await fetchSubtaskState(repoPath, slug).then(
      (value) => ({ ok: true, value }) as const,
      () => ({ ok: false }) as const,
    );
    if (!scope.alive || scopeRef.current !== scope) return;
    if (!isCurrent()) return;
    if (managerResult.ok) await commitFetchedSubtaskState(managerResult.value, isCurrent);
  };

  useEffect(() => {
    let alive = true;
    let timer = 0;
    scope.alive = true;
    setEditingName(null);
    editorVersion.current += 1;
    nameTrigger.current = null;
    setTask(initialTask ?? null);
    setRepoTasks([]);
    setSessions([]);
    setSessionsLoaded(false);
    setSubtaskState(null);
    setErr(null);
    setExecutionView(null);
    setExecutionError("");
    // Every read inside load() is individually wrapped, so this only fires on an unexpected
    // throw — but without it that throw would be a silent unhandled rejection, which is what
    // the old whole-body try/catch prevented.
    const loadEpoch = taskMutationEpoch.current;
    load().catch((e) => {
      if (scope.alive && scopeRef.current === scope && loadEpoch === taskMutationEpoch.current) setErr({ msg: "Couldn't load the task.", detail: String(e) });
    });
    // alineryd owns auto-advance creation; Task Detail only polls the sub-task state for display.
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
      scope.alive = false;
      taskMutationEpoch.current += 1;
      nameReadRequest.current += 1;
      window.clearTimeout(timer);
    };
  }, [repoPath, slug]);

  // The execution row arrives as a delta; an approval or a conflict is shown as it lands.
  useEffect(() => {
    if (feed.reply) setExecutionView(feed.reply);
    setExecutionError(feed.error);
  }, [feed, repoPath, slug]);

  // Declared after the scope reset below so that on a scope change the streams' rows land last.
  useEffect(() => {
    if (liveTask !== undefined) commitFetchedTask(liveTask);
  }, [liveTask, repoPath, slug]);
  useEffect(() => {
    if (liveRepoTasks) setRepoTasks(liveRepoTasks);
  }, [liveRepoTasks, repoPath, slug]);
  useEffect(() => {
    if (!liveSessions) return;
    setSessions((current) => (sameSessionMetas(current, liveSessions) ? current : liveSessions));
    setSessionsLoaded(true);
  }, [liveSessions, repoPath, slug]);
  useEffect(() => {
    if (!liveArtifacts.ready) return;
    setArtifactItems((current) => (sameArtifactListItems(current, liveArtifacts.items) ? current : liveArtifacts.items));
    setArtifactTree(liveArtifacts.tree);
  }, [liveArtifacts.ready, liveArtifacts.items, liveArtifacts.tree, repoPath, slug]);
  // Whether the recorded worktree still exists is a file question, asked when the task is first seen.
  const worktreePath = task?.worktree ?? "";
  useEffect(() => {
    if (!worktreePath) return setWorktreeMissing(false);
    let alive = true;
    worktreeExists(repoPath, slug)
      .then((ok) => alive && setWorktreeMissing(!ok))
      .catch(() => alive && setWorktreeMissing(false));
    return () => {
      alive = false;
    };
  }, [slug, worktreePath]);

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
    setArtifactText("");
    setCommentAnchor(null);
    setCommentDraft("");
    if (!selectedArtifact || (!selectedIsRepo && !selectedArtifactIsDirect && !selectedArtifactTreeId)) {
      return () => {
        alive = false;
      };
    }
    setArtifactErr(null);
    const read = selectedIsRepo
      ? readWorktreeText(repoPath, slug, selectedArtifact)
      : selectedArtifactTreeId && !selectedArtifactIsDirect
        ? readNodeText(repoPath, slug, selectedArtifactTreeId)
        : readArtifactText(repoPath, slug, selectedArtifact);
    read
      .then((text) => {
        if (alive) setArtifactText(text);
      })
      .catch((e) => {
        if (!alive) return;
        if (e instanceof FileNotShown) setArtifactErr({ msg: e.message, detail: "", tone: "info" });
        else setArtifactErr({ msg: selectedIsRepo ? "Couldn't show the file." : "Couldn't load the artifact.", detail: String(e) });
      });
    return () => {
      alive = false;
    };
  }, [repoPath, slug, selectedArtifact, selectedArtifactTreeId, selectedArtifactIsDirect, selectedIsRepo]);

  const trimmedCommentDraft = commentDraft.trim();
  const canSaveArtifactComment = Boolean(commentAnchor && selectedArtifact && trimmedCommentDraft && !commentBusy);

  const handleCommentDraftChange = (body: string) => {
    setCommentDraft(body);
    if (commentAnchor && selectedArtifact) persistCommentDraft(commentTarget, commentAnchor, body);
  };

  const saveArtifactComment = () => {
    if (!canSaveArtifactComment || !commentAnchor || !selectedArtifact) return;
    setCommentBusy(true);
    addComment({
      repoPath,
      taskSlug: slug,
      artifact: commentTarget,
      anchorId: commentAnchor.anchor_id,
      anchorKind: commentAnchor.anchor_kind,
      anchorLabel: commentAnchor.anchor_label,
      anchorExcerpt: commentAnchor.anchor_excerpt,
      lineStart: commentAnchor.line_start,
      lineEnd: commentAnchor.line_end,
      body: trimmedCommentDraft,
    })
      .then(() => {
        void discardCommentDraft(commentTarget, commentAnchor.anchor_id).catch(() => {});
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
      const storedDraft = getCommentDraft(commentTarget, anchor.anchor_id);
      flushSync(() => {
        setCommentAnchor(anchor);
        setCommentDraft(storedDraft?.body ?? "");
      });
      commentInputRef.current?.focus();
    },
    [getCommentDraft, commentTarget],
  );

  const discardOpenCommentDraft = () => {
    if (commentAnchor && selectedArtifact) {
      void discardCommentDraft(commentTarget, commentAnchor.anchor_id).catch(() => {});
    }
    setCommentAnchor(null);
    setCommentDraft("");
  };

  const clearPendingReview = () => {
    if (!selectedArtifact) return;
    clearReviewPending(repoPath, slug, commentTarget).catch((e) => setArtifactErr({ msg: "Couldn't clear the waiting state.", detail: String(e) }));
  };

  const restoreTask = async () => {
    setErr(null);
    setBusy("restore");
    try {
      await restoreTaskForRepo(repoPath, slug);
      if (!scope.alive || scopeRef.current !== scope) return;
      taskMutationEpoch.current += 1;
      const isCurrent = beginNameRead();
      setTask((current) => (current ? { ...current, archived: false } : current));
      setSubtaskState(null);
      void fetchSubtaskState(repoPath, slug)
        .then((value) => commitFetchedSubtaskState(value, isCurrent))
        .catch(() => {});
      toast("Task restored", "success");
    } catch (error) {
      if (scope.alive && scopeRef.current === scope) setErr({ msg: "Couldn't restore the task.", detail: String(error) });
    } finally {
      if (scope.alive && scopeRef.current === scope) setBusy("");
    }
  };

  const confirmArchive = async (removeWt: boolean, onPhase: (phase: ArchiveTaskPhase) => void) => {
    const failure = await archiveBoardTask({ repo_path: repoPath, slug }, removeWt, onPhase);
    setPendingArchive(null);
    if (failure) {
      setErr(failure);
      return;
    }
    onBack();
  };

  const archiveSessionRow = async (id: string) => {
    if (busy || sessionArchivePending.current) return;
    sessionArchivePending.current = true;
    setBusy(`archive-session:${id}`);
    setErr(null);
    try {
      await archiveSession(repoPath, slug, id);
      await load();
    } catch (error) {
      setErr({ msg: "Couldn't archive the session.", detail: String(error) });
    } finally {
      sessionArchivePending.current = false;
      setBusy("");
    }
  };

  const openSession = (ownerTaskSlug: string, s: SessionMeta & { name?: string | null }, intent?: TaskSessionTarget["intent"]) => {
    if (!s.worktree) return;
    const session = { taskSlug: ownerTaskSlug, id: s.id, cwd: s.worktree, phase: s.phase, harness: s.harness, model: s.model, playbook: s.playbook, generic: s.generic, intent };
    fileTabs.open({ key: `session:${ownerTaskSlug}:${s.id}`, kind: "session", name: s.id, label: s.name || s.phase || "Session", node: null, mode: "preview", session });
    markSessionNotificationRead(repoPath, ownerTaskSlug, s.id).catch(() => {});
  };
  const openSessionPath = (target: string, keep?: boolean) => {
    const name = target.slice(target.indexOf(":") + 1);
    if (target.startsWith("artifact:")) openArtifactTab(name, findOwnedArtifactNode(artifactTree, name) ?? null, "artifact", keep);
    else openArtifactTab(name, null, "repo", keep);
  };
  const openManagerSession = (ownerTaskSlug: string, manager: SessionMeta) => openSession(ownerTaskSlug, manager, "attach");

  const startManager = () => {
    setBusy("subtask-manager");
    setErr(null);
    startSubtaskManager(repoPath, slug)
      .then((reply) => openManagerSession(slug, reply.session))
      .catch((error) => setErr({ msg: "Couldn't start the sub-task manager.", detail: String(error) }))
      .finally(() => setBusy(""));
  };

  const recoverManager = () => {
    setBusy("subtask-recovery");
    setErr(null);
    startSubtaskManager(repoPath, slug, true)
      .then((reply) => openManagerSession(slug, reply.session))
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
      await discardSubtaskForRepo(repoPath, slug, manager?.id || "");
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
      await Promise.all(unacknowledgedExitedSessions.map((session) => markSessionNotificationRead(repoPath, slug, session.id)));
      await load();
    } catch (error) {
      setErr({ msg: "Couldn't acknowledge exited sessions.", detail: String(error) });
    } finally {
      setBusy("");
    }
  };

  const closeNameEditor = () => {
    editorVersion.current += 1;
    flushSync(() => setEditingName(null));
    restoreNameFocus(nameTrigger.current);
  };
  const renameControl = (kind: "session" | "task", owner: string, value: string, sessionId?: string, awaiting = false) => {
    const key = `${repoPath}:${slug}:${kind}:${owner}:${sessionId ?? ""}`;
    return (
      <>
        <span
          className={kind === "session" ? "editable-name-display" : undefined}
          role={kind === "session" ? "group" : undefined}
          aria-label={kind === "session" ? "Session name" : undefined}
          tabIndex={kind === "session" ? -1 : undefined}
          hidden={editingName === key}
        >
          {kind === "session" && (
            <span className="editable-name-text" title={value || (awaiting ? "Waiting for session name" : undefined)}>
              {value || (awaiting ? <PendingSessionName /> : "—")}
            </span>
          )}
          <button
            type="button"
            className={kind === "session" ? "name-edit-button" : "btn ghost small"}
            aria-label={`Rename ${kind}`}
            title={`Rename ${kind}`}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
              if (editingName === key) return;
              nameTrigger.current = event.currentTarget;
              editorVersion.current += 1;
              setEditingName(key);
            }}
          >
            {kind === "session" ? <Pencil size={14} aria-hidden="true" /> : `Rename ${kind}`}
          </button>
        </span>
        {editingName === key && (
          <NameEditor
            key={key}
            kind={kind}
            value={value}
            label={kind === "session" ? "Session name" : "Task name"}
            onCancel={closeNameEditor}
            onSave={async (name) => {
              const capturedScope = scope;
              const editor = editorVersion.current;
              if (kind === "session" && sessionId) {
                const committed = await renameSession({ repoPath, taskSlug: owner, sessionId, name });
                onNameCommitted?.({ kind: "session", repo_path: repoPath, task_slug: owner, session_id: sessionId, value: committed });
                if (!capturedScope.alive || scopeRef.current !== capturedScope) return;
                taskMutationEpoch.current += 1;
                setSessions((current) =>
                  current.map((item) => (item.id === sessionId ? { ...item, name: committed.name, name_source: committed.source, name_error: null } : item)),
                );
                setSubtaskState((current) =>
                  current?.manager_session?.id === sessionId
                    ? { ...current, manager_session: { ...current.manager_session, ...{ name: committed.name, name_source: committed.source, name_error: null } } }
                    : current,
                );
              } else {
                const updated = await renameTask(repoPath, owner, name);
                onNameCommitted?.({ kind: "task", repo_path: repoPath, task_slug: owner, task: updated });
                if (!capturedScope.alive || scopeRef.current !== capturedScope) return;
                taskMutationEpoch.current += 1;
                setTask((current) => (current?.slug === owner ? updated : current));
                setRepoTasks((current) => current.map((item) => (item.slug === owner ? updated : item)));
                setSubtaskState((current) =>
                  current
                    ? {
                        ...current,
                        task: current.task.slug === owner ? updated : current.task,
                        parent_task: current.parent_task?.slug === owner ? updated : current.parent_task,
                        active_subtask: current.active_subtask?.slug === owner ? updated : current.active_subtask,
                      }
                    : current,
                );
              }
              if (editorVersion.current === editor) closeNameEditor();
              void load();
            }}
          />
        )}
      </>
    );
  };

  const autoApproveAll = task?.auto_approve_all === true;
  const setAutoApproveAll = (enabled: boolean) => {
    if (!task || task.archived || task.draft || (task.engine_version ?? 2) < 2 || busy === "auto-approve") return;
    setBusy("auto-approve");
    setErr(null);
    const epoch = taskMutationEpoch.current;
    setAutoApproveAllForRepo(repoPath, slug, enabled)
      .then((updated) => {
        if (!scope.alive || scopeRef.current !== scope) return;
        if (epoch === taskMutationEpoch.current) {
          taskMutationEpoch.current += 1;
          setTask(updated);
          setExecutionView((current) => (current ? { ...current, state: { ...current.state, auto_approve_all: updated.auto_approve_all === true } } : current));
        } else {
          void load();
        }
      })
      .catch((e) => {
        if (scope.alive && scopeRef.current === scope && epoch === taskMutationEpoch.current) setErr({ msg: "Couldn't update Auto Approval All.", detail: String(e) });
      })
      .finally(() => {
        if (scope.alive && scopeRef.current === scope) setBusy("");
      });
  };

  const relatedTags = task?.related_tasks ?? [];
  // Related tasks are linked, not copied, so only tasks on this task's machine can be tagged.
  const relatedCandidates = boardTasks.filter((candidate) => {
    if (candidate.archived || candidate.draft) return false;
    if (!sameMachine(candidate.repo_path, repoPath)) return false;
    if (candidate.repo_path === repoPath && candidate.slug === slug) return false;
    return !relatedTags.some((tag) => relatedRepoKey(repoPath, tag.repo_path) === candidate.repo_path && tag.slug === candidate.slug);
  });
  const saveRelated = (next: RelatedTaskRef[]) => {
    setBusy("related");
    setErr(null);
    const epoch = taskMutationEpoch.current;
    setRelatedTasksForRepo(repoPath, slug, next)
      .then((updated) => {
        if (!scope.alive || scopeRef.current !== scope) return;
        if (epoch === taskMutationEpoch.current) {
          taskMutationEpoch.current += 1;
          setTask(updated);
        } else {
          void load();
        }
      })
      .catch((e) => {
        if (scope.alive && scopeRef.current === scope && epoch === taskMutationEpoch.current) setErr({ msg: "Couldn't update related tasks.", detail: String(e) });
      })
      .finally(() => {
        if (scope.alive && scopeRef.current === scope) setBusy("");
      });
  };

  const finalizedNotice = task ? finalizedSubtaskNotice(task, subtaskState?.parent_task) : "";
  const worktreeValue = (path: string) =>
    !task?.has_worktree ? (
      <span className="dim">none — using main repo</span>
    ) : !task?.worktree ? (
      <span className="danger-text">removed</span>
    ) : worktreeMissing ? (
      <span className="danger-text">{path} — missing on disk</span>
    ) : (
      path
    );

  return (
    <div className="detail taskdetail" style={{ ["--artifact-width" as string]: `${artifactWidth}px` }}>
      <section className={`task-panel task-info-panel${headerOpen ? "" : " compact"}`} aria-label="Task information">
        <div className="task-panel-head task-info-head">
          <div className="task-info-title">
            {headerOpen && <div className="task-panel-label">Task</div>}
            {task?.parent_task && renameControl("task", task.slug, task.name)}
            <h2 title={task?.name ?? slug}>{task?.name ?? slug}</h2>
          </div>
          {!headerOpen && (
            <div className="task-info-compact">
              <div className="kv">
                <span className="k">Branch</span>
                <span className="v mono" title={task?.branch || undefined}>
                  {task?.branch}
                </span>
                <CopyTextButton text={task?.branch ?? ""} label="branch" />
              </div>
              <div className="kv">
                <span className="k">Worktree</span>
                <span className="v mono" title={task?.worktree || undefined}>
                  {worktreeValue(shortWorktreePath(task?.worktree ?? ""))}
                </span>
                {task?.worktree && <CopyTextButton text={task.worktree} label="worktree path" />}
              </div>
            </div>
          )}
          <div className="task-info-head-actions btn-group">
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
            <button
              type="button"
              className="btn ghost small"
              aria-expanded={headerOpen}
              aria-label={headerOpen ? "Hide task details" : "Show task details"}
              onClick={() => toggleHeader(!headerOpen)}
            >
              {headerOpen ? <ChevronUp size={16} strokeWidth={1.5} aria-hidden="true" /> : <ChevronDown size={16} strokeWidth={1.5} aria-hidden="true" />} Details
            </button>
            <button type="button" className="btn ghost small" onClick={onBack}>
              <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" /> Back
            </button>
          </div>
        </div>

        {subtaskState?.parent_task && (
          <button type="button" className="task-parent-breadcrumb" onClick={() => onOpenRelatedTask(subtaskState.parent_task?.slug ?? "")}>
            ← Parent task · {subtaskState.parent_task.name}
          </button>
        )}

        {finalizedNotice && <InlineStatus tone="warning">{finalizedNotice}</InlineStatus>}

        {executionView && !executionError && <ExecutionAvailabilityNotice live={executionView.live} controls />}

        {executionError && (
          <InlineStatus tone="error" detail={executionError}>
            Execution request failed. {executionView ? "The last successful read is shown, not current live state. " : ""}Completion grants are disabled.
          </InlineStatus>
        )}

        {headerOpen && (
          <>
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
                <span className="v mono">{worktreeValue(task?.worktree ?? "")}</span>
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
                    pushAndCompareUrlForRepo(repoPath, slug)
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
                    saveRelated([
                      ...relatedTags,
                      { repo_path: relatedStoredPath(repoPath, candidate.repo_path) ?? candidate.repo_path, slug: candidate.slug, name: candidate.name },
                    ]);
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
                    const tagRepo = relatedRepoKey(repoPath, tag.repo_path);
                    const open = !knownRepos || knownRepos.includes(tagRepo);
                    const label = boardTasks.find((candidate) => candidate.repo_path === tagRepo && candidate.slug === tag.slug)?.name || tag.name || tag.slug;
                    return (
                      <span key={`${tag.repo_path}:${tag.slug}`} className={`task-related-tag${open ? "" : " closed"}`}>
                        <button
                          type="button"
                          className="task-related-tag-open"
                          aria-label={open ? `Open ${label}` : `${label} (repository closed)`}
                          disabled={!open}
                          title={open ? `Open ${label}` : "Repository is closed"}
                          onClick={() => open && onOpenRelatedTask(tag.slug, tagRepo)}
                        >
                          {label}
                          {tagRepo !== repoPath ? <span className="dim"> · {repoName(tagRepo)}</span> : null}
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
                {duplicating ? "Duplicating…" : "Duplicate Task · ⌘D"}
              </button>
              <button
                type="button"
                className={`btn ghost small auto-approve${autoApproveAll ? " on" : ""}`}
                aria-pressed={autoApproveAll}
                disabled={!task || task.archived || task.draft || (task.engine_version ?? 2) < 2 || busy === "auto-approve"}
                title={
                  autoApproveAll
                    ? "Auto Approval All is on. Every playbook step may complete without an approval card. Turn off to restore the steps chosen at creation."
                    : "Auto Approval All is off. This task keeps the automatic-completion steps chosen at creation."
                }
                onClick={() => setAutoApproveAll(!autoApproveAll)}
              >
                Auto Approval All
              </button>
            </div>
          </>
        )}
      </section>
      <div className={`taskdetail-body${artifactCollapse.collapsed ? " pane-collapsed" : ""}`}>
        <aside className="artifactpane">
          <div className="artifacthead">
            <div className="artifacttabs" role="group" aria-label="Task side panel">
              <button type="button" aria-pressed={sideTab === "playbook"} className={`artifacttab${sideTab === "playbook" ? " on" : ""}`} onClick={() => setSideTab("playbook")}>
                Playbook
              </button>
              <button type="button" aria-pressed={sideTab === "history"} className={`artifacttab${sideTab === "history" ? " on" : ""}`} onClick={() => setSideTab("history")}>
                History
              </button>
              <button type="button" aria-pressed={sideTab === "artifacts"} className={`artifacttab${sideTab === "artifacts" ? " on" : ""}`} onClick={() => setSideTab("artifacts")}>
                Files
              </button>
              <button type="button" aria-pressed={sideTab === "git"} className={`artifacttab${sideTab === "git" ? " on" : ""}`} onClick={() => setSideTab("git")}>
                Git
              </button>
            </div>
            {sideTab === "artifacts" && <span className="pill">{artifactNames.length}</span>}
          </div>
          {sideTab === "playbook" ? (
            <div className={`playbook-side-scroll${playbookView === "graph" ? " playbook-side-graph" : ""}`}>
              <div className="task-playbook-toolbar">
                <div className="artifacttabs" role="group" aria-label="Task playbook view">
                  <button
                    type="button"
                    className={`artifacttab${playbookView === "list" ? " on" : ""}`}
                    aria-pressed={playbookView === "list"}
                    onClick={() => setPlaybookView("list")}
                  >
                    List
                  </button>
                  <button
                    type="button"
                    className={`artifacttab${playbookView === "graph" ? " on" : ""}`}
                    aria-pressed={playbookView === "graph"}
                    onClick={() => setPlaybookView("graph")}
                  >
                    Graph
                  </button>
                </div>
                {playbookView === "graph" && <p>Retained task definition · See List for active counts and automatic completion.</p>}
              </div>
              <PlaybookGraph
                variant={playbookView === "graph" ? "definition" : "execution"}
                showInspector={false}
                title={executionView?.definition.title ?? "Retained task playbook"}
                steps={steps}
                countsByStep={Object.fromEntries(steps.map((step) => [step.key, activeExecutions.filter((execution) => execution.candidate.step_key === step.key).length]))}
                selectedAutoAdvance={autoApproveAll ? steps.map((step) => step.key) : executionView?.state.enabled_steps}
              />
            </div>
          ) : sideTab === "git" ? (
            <GitPanel
              repoPath={repoPath}
              taskSlug={slug}
              onOpen={(diff, subject, keep) => fileTabs.open({ ...gitDiffTab(diff, subject), kind: "diff", node: null, mode: "preview", diff }, keep)}
            />
          ) : sideTab === "history" ? (
            <div className="task-history-pane">
              {executionView && (
                <section aria-label="Task executions">
                  <h3 className="task-history-title">{executionView.definition.title}</h3>
                  <p className="task-history-summary">
                    {activeExecutions.length} active executions / {executionView.state.max_live_sessions} slots · Creation: {executionView.state.creation}
                  </p>
                  {executionView.state.creation_error && <InlineStatus tone="error">{executionView.state.creation_error}</InlineStatus>}
                  {executions.map((execution) => (
                    <article className="task-history-entry" key={execution.id} aria-label={`Execution ${execution.id}`}>
                      <div className="task-history-entry-heading">
                        <h4>{steps.find((step) => step.key === execution.candidate.step_key)?.title ?? execution.candidate.step_key}</h4>
                        <span className="pill">{execution.lifecycle}</span>
                      </div>
                      <dl className="task-history-metadata">
                        <dt>Execution</dt>
                        <dd>
                          <code>{execution.id}</code>
                        </dd>
                        <dt>Owner</dt>
                        <dd>
                          <code>{execution.owner_session_id}</code>
                        </dd>
                      </dl>
                      {execution.lifecycle === "queued" && <p>{execution.start_requested ? "Waiting for capacity or coding ownership" : "Held until explicitly started"}</p>}
                      {execution.lifecycle === "finishing" && <p>Outputs accepted; waiting for confirmed session shutdown.</p>}
                      {execution.lifecycle === "interrupted" && <p>Process ownership is uncertain; capacity remains reserved.</p>}
                      {execution.error && <InlineStatus tone="error">{execution.error}</InlineStatus>}
                      <details>
                        <summary>Inputs and outputs</summary>
                        <ul aria-label="Execution inputs">
                          {Object.entries(execution.candidate.inputs).flatMap(([selector, ids]) =>
                            ids.map((occurrenceId) => {
                              const occurrence = executionView.state.occurrences?.[occurrenceId];
                              return (
                                <li key={`${selector}:${occurrenceId}`}>
                                  <code>{selector}</code> ← <code>{occurrence?.relative_path ?? occurrenceId}</code> · occurrence {occurrenceId} · producer{" "}
                                  {occurrence?.producer_execution_id ?? "seed"}
                                </li>
                              );
                            }),
                          )}
                        </ul>
                        <ExecutionOutputs execution={execution} occurrences={executionView.state.occurrences} />
                      </details>
                      <p className="task-history-permission">
                        Completion permission: {execution.permission.kind}
                        {execution.permission.kind === "human_granted" ? ` · ${execution.permission.session_id}` : ""}
                      </p>
                      {execution.permission.kind === "locked" && execution.lifecycle === "running" && !executionView.state.history_only && (
                        <button
                          type="button"
                          className="btn small"
                          disabled={!!busy || !!executionError || executionView.live?.status !== "available"}
                          onClick={() => void allowCompletion(execution.id)}
                        >
                          Allow this session to complete · {execution.owner_session_id}
                        </button>
                      )}
                    </article>
                  ))}
                </section>
              )}
            </div>
          ) : (
            <>
              {artifactErr && !artifactErr.tone && (
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
                {displayedArtifactItems.map((item) => {
                  if (item.attachment && classifyAttachment(item) === "image") {
                    return (
                      <AttachmentPreview key={item.name} taskSlug={slug} name={item.name} repoPath={repoPath}>
                        <ArtifactProvenanceBadges handoffs={item.handoffs} onOpenRelatedTask={onOpenRelatedTask} />
                      </AttachmentPreview>
                    );
                  }
                  const node = findOwnedArtifactNode(artifactTree, item.name);
                  const available = Boolean(item.attachment || node);
                  return (
                    // div, not <button>: the provenance badges inside are buttons themselves,
                    // and button-in-button is invalid HTML (same pattern as SessionView).
                    <div
                      key={item.name}
                      className={`artifactitem${item.attachment ? " attachment" : ""}`}
                      title={item.name}
                      role="button"
                      tabIndex={available ? 0 : -1}
                      aria-disabled={!available}
                      onKeyDown={(e) => {
                        if ((e.key !== "Enter" && e.key !== " ") || e.target !== e.currentTarget) return;
                        e.preventDefault();
                        e.currentTarget.click();
                      }}
                      onClick={(e) => {
                        if (item.attachment) {
                          revealPath(attachmentFilePath(repoPath, slug, item.name)).catch((e) => setArtifactErr({ msg: "Couldn't reveal the attachment.", detail: String(e) }));
                          return;
                        }
                        if (!node) return;
                        openArtifactTab(item.name, node, "artifact", e.detail >= 2);
                      }}
                    >
                      <span className="artifactitem-name">{item.name}</span>
                      {item.attachment && <CopyTextButton text={attachmentFilePath(repoPath, slug, item.name)} label="path" />}
                      {!available && <span className="pill">Not yet readable</span>}
                      <ArtifactProvenanceBadges handoffs={item.handoffs} onOpenRelatedTask={onOpenRelatedTask} />
                    </div>
                  );
                })}
                {contextualArtifactTree.length > 0 && (
                  <ArtifactTree
                    taskSlug={slug}
                    repoPath={repoPath}
                    nodes={contextualArtifactTree}
                    selectedId={selectedArtifactTreeId}
                    onSelect={(node, keep) => {
                      openArtifactTab(node.label, node, "artifact", keep);
                    }}
                    onError={(detail) => setArtifactErr({ msg: "Couldn't open the artifact.", detail })}
                  />
                )}
                <RepoFileTree
                  repoPath={repoPath}
                  taskSlug={slug}
                  selected={selectedIsRepo ? selectedArtifact : ""}
                  onOpen={(path, keep) => openArtifactTab(path, null, "repo", keep)}
                />
              </div>
            </>
          )}
        </aside>
        <PaneResizer props={artifactResizerProps} collapse={artifactCollapse} />
        <main className="detailmain">
          <MainTabs
            pinned="Sessions"
            tabs={fileTabs.tabs.map((tab) => (tab.session ? { ...tab, label: sessions.find((s) => s.id === tab.session?.id)?.name || tab.label } : tab))}
            active={fileTabs.active}
            onSelect={fileTabs.select}
            onClose={fileTabs.close}
          />
          {selectedDiff ? (
            <div className="artifactpane task-artifact-view">
              <div className="artifacthead">
                <div className="artifacttitle mono" title={selectedArtifact}>
                  {selectedArtifact}
                </div>
              </div>
              <div className="artifactviewer">
                <GitDiffView repoPath={repoPath} taskSlug={slug} target={selectedDiff} />
              </div>
            </div>
          ) : (
            activeArtifactTab && (
              <div className="artifactpane task-artifact-view">
                <div className="artifacthead">
                  <div className="artifacttitle mono" title={selectedArtifact}>
                    {selectedArtifact}
                  </div>
                  <ArtifactProvenanceBadges handoffs={selectedArtifactItem?.handoffs} onOpenRelatedTask={onOpenRelatedTask} />
                  <div className="btn-group">
                    <CopyTextButton text={openFilePath(repoPath, slug, selectedArtifact, selectedArtifactNode, selectedIsRepo ? (task?.worktree ?? "") : undefined)} label="path" />
                    <CopyArtifactButton text={artifactText} />
                    {selectedPreviewable && (
                      <>
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
                      </>
                    )}
                  </div>
                </div>
                {artifactErr && (
                  <InlineStatus tone={artifactErr.tone ?? "error"} detail={artifactErr.detail || undefined}>
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
                  {!selectedPreviewable ? (
                    <CodeView path={selectedArtifact} text={artifactText} />
                  ) : artifactMode === "raw" ? (
                    <pre className="artifactraw">{artifactText}</pre>
                  ) : (
                    <article className="md artifactmd">
                      <ArtifactMarkdown
                        text={artifactText}
                        repoPath={repoPath}
                        taskSlug={slug}
                        artifactPath={selectedArtifactImages?.artifactPath ?? selectedArtifact}
                        attachmentNodeIds={selectedArtifactImages?.attachmentNodeIds}
                        comments={artifactComments}
                        draftAnchorIds={recoverableArtifactDraftAnchorIds}
                        onAddComment={canComment ? openArtifactComment : undefined}
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
                        <button type="button" className="btn ghost small" onClick={() => void discardCommentDraft(commentTarget, draft.anchor_id).catch(() => {})}>
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
              </div>
            )
          )}
          {fileTabs.tabs.map(
            (tab) =>
              tab.session && (
                <div key={tab.key} className="task-session-view" hidden={tab.key !== fileTabs.active}>
                  {renderSession(tab.session, { onClose: () => fileTabs.close(tab.key), onOpenPath: openSessionPath })}
                </div>
              ),
          )}
          <div className="task-sessions-tab" hidden={!!fileTabs.current}>
            <section className="task-panel task-sessions-panel">
              <div className="task-panel-head">
                <div className="task-sessions-heading">
                  <h3 className="task-panel-title">Sessions</h3>
                  <button
                    type="button"
                    className="btn ghost small"
                    aria-label={sessionView === "graph" ? "Show list view" : "Show graph view"}
                    title={sessionView === "graph" ? "Switch to list view" : "Switch to graph view"}
                    onClick={() => {
                      const next = sessionView === "graph" ? "list" : "graph";
                      setSessionView(next);
                      try {
                        localStorage.setItem(TASK_SESSION_VIEW_KEY, next);
                      } catch {
                        // Keep switching usable when preference storage is unavailable.
                      }
                    }}
                  >
                    {sessionView === "graph" ? <List size={14} aria-hidden="true" /> : <Network size={14} aria-hidden="true" />}
                    {sessionView === "graph" ? "List" : "Graph"}
                  </button>
                </div>
                <div className="task-session-controls">
                  {executionView && (
                    <span
                      className="dim task-session-queue"
                      role="status"
                      aria-label="Queued sessions"
                      title="Start requested; waiting for capacity or coding ownership. Held sessions are not counted."
                    >
                      {queuedExecutionCount} queued
                    </span>
                  )}
                  {sessionView === "list" && (
                    <button
                      type="button"
                      className={`btn ghost small session-sort-control${sessionSort.field === "priority" ? " active" : ""}`}
                      aria-pressed={sessionSort.field === "priority"}
                      onClick={() => setSessionSort(PRIORITY_SESSION_SORT)}
                    >
                      Priority
                    </button>
                  )}
                  <Checkbox checked={showArchived} onChange={setShowArchived} label="Show archived" />
                  {unacknowledgedExitedSessions.length > 0 && (
                    <button type="button" className="btn ghost small" disabled={!!busy} onClick={() => void acknowledgeExitedSessions()}>
                      {busy === "acknowledge-exits" ? "Acknowledging…" : "Acknowledge exited sessions"}
                    </button>
                  )}
                  <div className="btn-group">
                    <button
                      type="button"
                      className="btn ghost small"
                      disabled={!subtaskState?.can_start || !!busy}
                      title={subtaskState?.disabled_reason || undefined}
                      aria-describedby={subtaskState && !subtaskState.can_start ? "task-session-disabled" : undefined}
                      onClick={startManager}
                    >
                      {busy === "subtask-manager" ? "Starting…" : "Start sub-task"}
                    </button>
                    {!(task && (task.archived || !task.worktree || worktreeMissing)) && (
                      <button type="button" className="btn small" disabled={!!busy} onClick={onNewSession}>
                        New session
                      </button>
                    )}
                  </div>
                  {task && (task.archived || !task.worktree || worktreeMissing) && (
                    <span id="task-session-disabled" className="dim task-session-disabled">
                      {task.archived
                        ? task.worktree
                          ? "task archived — new sessions disabled; names remain editable"
                          : "Task archived; worktree removed. Restoring keeps it available for history and related-task links, but new sessions remain disabled."
                        : worktreeMissing
                          ? "worktree missing on disk"
                          : "Worktree removed — new sessions are disabled. Create a new task, tag this one as related, and continue the work there."}
                    </span>
                  )}
                </div>
              </div>
              {subtaskState && !subtaskState.can_start && !(task && (task.archived || !task.worktree || worktreeMissing)) && (
                <p id="task-session-disabled" className="dim task-session-disabled">
                  {subtaskState.disabled_reason}
                </p>
              )}
              {err && (
                <InlineStatus tone="error" detail={err.detail}>
                  {err.msg}
                </InlineStatus>
              )}
              {sessionView === "graph" ? (
                <>
                  {!sessionsLoaded && <p className="dim">Loading sessions…</p>}
                  {sessionsLoaded && (
                    <TaskRunGraph
                      sessions={taskPanelRows.flatMap((row) => (row.kind === "subtask_history" ? [] : [row.session]))}
                      state={executionView?.state ?? null}
                      observations={observationsById}
                      onOpenSession={(session) => {
                        const row = taskPanelRows.find((row) => row.kind !== "subtask_history" && row.session.id === session.id);
                        const owner = row?.kind === "subtask_manager" ? row.owner_task_slug : slug;
                        openSession(owner, session, session.archived || !task?.worktree || worktreeMissing ? "history" : "attach");
                      }}
                      onOpenArtifact={(path) => {
                        openArtifactTab(path, findOwnedArtifactNode(artifactTree, path) ?? null);
                      }}
                    />
                  )}
                </>
              ) : (
                <div className="task-session-table-wrap">
                  <table className="task-table task-session-table">
                    <thead>
                      <tr>
                        <th className="status-col">Status</th>
                        <th className="session-name-col">Name</th>
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
                          <td colSpan={5}>
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
                              <td className="session-name-cell">
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
                              <td className="session-time-col">
                                <span className="dim">—</span>
                              </td>
                              <td className="session-time-col">
                                <span className="dim">—</span>
                              </td>
                              <td className="session-actions">
                                <div className="session-actions-inner">
                                  {renameControl("task", row.child.slug, row.child.name)}
                                  <button type="button" className="btn ghost small" onClick={() => onOpenRelatedTask(row.child.slug)}>
                                    Open task
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        }
                        const s = row.session;
                        const obs = observationsById[s.id] ?? null;
                        const isLive = obs ? obs.lifecycle.state === "live" : false;
                        if (row.kind === "subtask_manager") {
                          const label = row.child ? row.child.name : s.subtask_slug || "Sub-task setup";
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
                                  observation={obs ?? undefined}
                                  exitCode={s.exit_code}
                                  exitAcknowledged={hasAcknowledgedExit(s)}
                                />
                              </td>
                              <td className="session-name-cell editable-name">
                                {renameControl("session", row.owner_task_slug, s.name ?? "", s.id, awaitingSessionName(s, obs))}
                                {s.name_error && <span className="name-error">{s.name_error}</span>}
                                <button type="button" className="manager-row-primary session-metadata" onClick={activate}>
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
                                <div className="dim session-metadata" title={harnessLabel}>
                                  {harnessLabel}
                                </div>
                              </td>
                              <td className="session-time-col">
                                <SessionTimestamp kind="started" value={sessionStartedAt(s)} now={sessionNow} />
                              </td>
                              <td className="session-time-col">
                                <SessionTimestamp kind="updated" value={sessionUpdatedAt(s)} now={sessionNow} />
                              </td>
                              <td className="session-actions">
                                <div className="session-actions-inner">
                                  {row.child && renameControl("task", row.child.slug, row.child.name, s.id)}
                                  {!s.archived && !row.child?.archived && (!s.subtask_slug || row.child) && (
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
                                </div>
                              </td>
                            </tr>
                          );
                        }

                        const resumedBy = sessions.find((other) => other.resume_of === s.id);
                        const execution = executionForSession(s);
                        const superseded = Boolean(execution && execution.owner_session_id !== s.id);
                        const stepTitle = steps.find((step) => step.key === execution?.candidate.step_key)?.title ?? execution?.candidate.step_key;
                        const sessionType = s.subtask_manager
                          ? "Sub-task manager"
                          : execution
                            ? `${executionView?.definition.title} · ${stepTitle}`
                            : s.generic
                              ? "Auxiliary"
                              : [s.playbook, s.phase].filter(Boolean).join(" · ") || "Historical session";
                        const harnessLabel = `${harnessDisplayName(s.harness)}${s.model ? ` · ${s.model}` : ""}`;
                        const unreadCompletion = classifySessionNotice(s, obs ?? undefined) === "unread_completion";
                        const openable = Boolean(task?.worktree) && !s.archived;
                        const canStop =
                          !s.archived &&
                          isVinculumHarness(s.harness) &&
                          obs?.transport === "rpc" &&
                          obs.state?.agent.state !== "waiting_for_approval" &&
                          canAbortChatSession({
                            connection: "open",
                            lifecycle: obs.lifecycle,
                            process: obs.state?.process ?? null,
                            agent: obs.state?.agent ?? null,
                            messageAdapter: obs.state?.message_adapter ?? "unsupported",
                            body: "",
                            composing: false,
                            sending: false,
                            interrupting: !!busy,
                          });
                        return (
                          <tr
                            key={s.id}
                            className={s.archived ? "row-archived" : openable ? "session-row-openable" : undefined}
                            tabIndex={openable ? 0 : undefined}
                            aria-label={openable ? `Open session ${sessionType}` : undefined}
                            onClick={(event) => {
                              if (!openable || (event.target as HTMLElement).closest("button")) return;
                              openSession(slug, s);
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
                                observation={obs}
                                superseded={superseded}
                                unreadCompletion={unreadCompletion}
                                exitCode={s.exit_code}
                                exitAcknowledged={hasAcknowledgedExit(s)}
                                terminalLabel={superseded ? null : sessionTerminalLabel(s.harness, s.id, execution, s.ended_at != null || obs?.lifecycle.state === "exited")}
                              />
                            </td>
                            <td className="session-name-cell editable-name">
                              {renameControl("session", slug, s.name ?? "", s.id, awaitingSessionName(s, obs))}
                              {s.name_error && <span className="name-error">{s.name_error}</span>}
                              <div className="session-step-cell session-metadata">
                                <span className="dim" title={sessionType}>
                                  {sessionType}
                                </span>
                                {execution && (
                                  <span className="pill">
                                    {sessionTerminalLabel(s.harness, s.id, superseded ? undefined : execution, s.ended_at != null || obs?.lifecycle.state === "exited") ??
                                      execution.lifecycle}
                                  </span>
                                )}
                                {s.archived && <span className="pill session-archived">Archived</span>}
                                {resumedBy && <span className="pill dim">Resumed</span>}
                              </div>
                              <div className="dim session-metadata" title={harnessLabel}>
                                {harnessLabel}
                              </div>
                            </td>
                            <td className="session-time-col">
                              <SessionTimestamp kind="started" value={sessionStartedAt(s)} now={sessionNow} />
                            </td>
                            <td className="session-time-col">
                              <SessionTimestamp kind="updated" value={sessionUpdatedAt(s)} now={sessionNow} />
                            </td>
                            <td className="session-actions">
                              <div className="session-actions-inner">
                                <button
                                  type="button"
                                  className="btn ghost small chat-composer-abort"
                                  disabled={!canStop}
                                  aria-label={busy === `stop-session:${s.id}` ? "Stopping…" : "Stop"}
                                  title="Interrupt the current turn without killing the session"
                                  onClick={async () => {
                                    if (!canStop || sessionStopPending.current) return;
                                    sessionStopPending.current = true;
                                    setBusy(`stop-session:${s.id}`);
                                    setErr(null);
                                    try {
                                      await abortSession(repoPath, s.id);
                                      await load();
                                    } catch (error) {
                                      setErr({ msg: "Couldn't interrupt the session.", detail: String(error) });
                                    } finally {
                                      sessionStopPending.current = false;
                                      setBusy("");
                                    }
                                  }}
                                >
                                  <Square className="chat-composer-icon" fill="currentColor" />
                                </button>
                                <KillButton id={s.id} slug={slug} repoPath={repoPath} live={isLive} onKilled={load} />
                                <button type="button" className="btn ghost small" disabled={s.archived || !!busy} onClick={() => void archiveSessionRow(s.id)}>
                                  {busy === `archive-session:${s.id}` ? "Archiving session…" : "Archive"}
                                </button>
                                {s.archived && (
                                  <button
                                    type="button"
                                    className="btn ghost small"
                                    title="Replay this archived session's recorded activity (read-only)"
                                    onClick={() => openSession(slug, s, "history")}
                                  >
                                    View history
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                      {subtaskState?.can_recover && subtaskState.active_subtask && !currentManagerRow && (
                        <tr className="subtask-manager-row">
                          <td className="status-col">
                            <span className="statusdot unknown" />
                          </td>
                          <td className="session-name-cell">
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
                          <td className="session-time-col">
                            <span className="dim">—</span>
                          </td>
                          <td className="session-time-col">
                            <span className="dim">—</span>
                          </td>
                          <td className="session-actions">
                            <div className="session-actions-inner">
                              {renameControl("task", subtaskState.active_subtask.slug, subtaskState.active_subtask.name)}
                              <button
                                type="button"
                                className="btn danger small"
                                disabled={!!busy}
                                onClick={() => void discardSubtask(null, subtaskState.active_subtask ?? undefined)}
                              >
                                {busy === "discard-subtask:active-child" ? "Killing…" : "Kill sub-task"}
                              </button>
                              <button type="button" className="btn ghost small" disabled={!!busy} onClick={recoverManager}>
                                {busy === "subtask-recovery" ? "Recovering…" : "Replace manager session"}
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        </main>
      </div>
      <ArchiveTaskModal task={pendingArchive} onCancel={() => setPendingArchive(null)} onConfirm={confirmArchive} />
    </div>
  );
}
