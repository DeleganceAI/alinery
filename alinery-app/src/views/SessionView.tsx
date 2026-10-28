import { ArrowLeft, ArrowRight, ChevronRight, Ellipsis, Eye, EyeOff, FastForward, FileUp, Hand, MessageSquare, Pencil, RotateCcw, Square, X } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { ArtifactComment, ArtifactCommentAnchor } from "../ArtifactMarkdown";
import { ArtifactMarkdown, formatArtifactCommentTarget } from "../ArtifactMarkdown";
import { ArtifactTree, isDirectOwnedArtifactNode } from "../ArtifactTree";
import { AttachmentPreview } from "../AttachmentPreview";
import type { ArtifactPaneTab } from "../artifactClassification";
import { artifactPaneItems, artifactPaneTreeNodes } from "../artifactClassification";
import { ChatComposer } from "../ChatComposer";
import { canStage, classifyAttachment, type DraftAttachment, draftToRowAttachments, isHttpUrl, revokeDraftPreviewUrls, taskAttachmentDir } from "../chat/attachments";
import { CopyArtifactButton, CopyTextButton } from "../chat/CopyMessage";
import { formatContextUsage } from "../chat/format";
import type { ModelRolesMap } from "../chat/modelRoles";
import { decodeOmpPage } from "../chat/ompFile";
import { settleOpenUrl as settleBrowserUrl } from "../chat/openUrl";
import { prepareChatAttachments } from "../chat/prepareAttachments";
import { isInteractivePromptLoginError, shouldOfferProviderSetup } from "../chat/providers";
import { latestQueuedFollowUp, type QueuedFollowUp } from "../chat/queue";
import { applySendPlan, commandOutputText, DispatchFailure, loginReply, planChatSend, requireWritten, setModelReply } from "../chat/send";
import { type McpServerRow, type ProvidersDialogTab, parseMcpListOutput } from "../chat/slash";
import type { SessionChatStatus } from "../chat/types";
import { chatVisibilityFromAppearance } from "../chat/visibility";
import {
  appendOptimisticAbort,
  appendOptimisticUser,
  applyFilePage,
  applyRpcLine,
  type ChatTranscriptState,
  carryOver,
  dismissPendingUi,
  emptyTranscript,
  isPresentationUi,
  needsUiReply,
  settleRefusedSend,
} from "../chatTranscript";
import { askConfirm, confirmDanger, confirmStopAndSwitch } from "../confirm";
import { RunningIndicator } from "../Indicators";
import * as ipc from "../ipc";
import { awaitingSessionName, NameEditor, PendingSessionName, restoreNameFocus } from "../NameEditor";
import {
  abortAndPromptCommand,
  abortCommand,
  cancelExtensionUi,
  compactCommand,
  extensionUiConfirm,
  extensionUiValue,
  followUpCommand,
  getAvailableCommandsCommand,
  getAvailableModelsCommand,
  getLoginProvidersCommand,
  getStateCommand,
  getSubagentsCommand,
  type ImageContent,
  loginCommand,
  negotiateProtocolCommand,
  promptCommand,
  setAutoCompactionCommand,
  setModelCommand,
  setSubagentSubscriptionCommand,
  setThinkingLevelCommand,
} from "../ompRpc";
import { SessionLineage } from "../SessionLineage";
import { SessionTerminal, type SessionTerminalConnectionState } from "../SessionTerminal";
import { observationDisplayKind } from "../sessionAttention";
import { appendGeneratedText, canAbortChatSession, isTurnActive, OMP_INTERRUPT_DATA, type SessionMessageDraft, shouldShowChatComposer } from "../sessionMessage";
import type { ContextAction } from "../shared";
import {
  ArtifactProvenanceBadges,
  ContextActionBar,
  Dialog,
  ExecutionAvailabilityNotice,
  ExecutionOutputs,
  finalizedSubtaskNotice,
  findOwnedArtifactNode,
  harnessDisplayName,
  InlineStatus,
  isAllowedLaunchHarness,
  LoadingState,
  StatusDot,
  sameArtifactListItems,
} from "../shared";
import { toast } from "../toast";
import type {
  AppearancePrefs,
  ArtifactListItem,
  ArtifactTreeNode,
  EndExecutionRequest,
  HostedCatalogView,
  LifecycleState,
  NameCommit,
  ReviewHandoffSource,
  SessionDisplayContext,
  SessionDisplayMeta,
  SessionMessageActionProvenance,
  SessionMeta,
  SessionObservation,
  SuppliedExecutionArtifact,
  Task,
  TaskExecutionReply,
} from "../types";
import { useArtifactCommentDrafts } from "../useArtifactCommentDrafts";
import { useArtifactPaneWidth } from "../useArtifactPaneWidth";
import { readTaskExecution } from "../useExecutionObservation";
import { ArtifactHandoffPage } from "./ArtifactHandoffPage";
import { ChatExtensionPrompt } from "./ChatExtensionPrompt";
import { ChatMcpDialog } from "./ChatMcpDialog";
import { ChatModelDialog } from "./ChatModelDialog";
import { ChatPane } from "./ChatPane";
import { ChatToolsDialog } from "./ChatToolsDialog";
import { readJournalThrough } from "./chatSession";
import { SessionActionPanel } from "./SessionActionPanel";
import { ThinkingSelect } from "./ThinkingSelect";

// ---- session view -------------------------------------------------------------

type ArtifactReviewPendingStatus = {
  artifact: string;
  review: string;
};

const WRAP_UP_MESSAGE =
  "Wrap up the current step, including my latest message requests. Preserve completed work; do not repeat completed actions unnecessarily. Verify the assigned artifacts. If the work is ready and no substantive approval or question remains, call `alinery_phase_complete` to report readiness again. Otherwise explain the blocker.";

export type SessionSendRecovery = {
  commandId: string;
  draft: string;
  caption: string;
  sourceDraft: SessionMessageDraft;
  actions: SessionMessageDraft["pendingActions"];
  entryId: string;
  attachments: DraftAttachment[];
  queued?: boolean;
  transferDispatchId?: string;
  origin?: "nudge";
  status: "pending" | "refused" | "acknowledged" | "consumed" | "settled" | "unknown";
  reason?: string;
};

function prepareChatSend(taskSlug: string, repoPath: string, caption: string, attachments: DraftAttachment[]) {
  return prepareChatAttachments(
    {
      stat: (path) => ipc.chatFileStat(path),
      copy: (paths) => ipc.copyChatAttachments(taskSlug, paths),
      writeBytes: (fileName, bytes) => ipc.writeChatAttachmentBytes(taskSlug, fileName, bytes),
      readImage: (name) => ipc.readChatImage(taskSlug, name),
      trailerDir: taskAttachmentDir(repoPath, taskSlug),
    },
    caption,
    attachments,
  );
}

async function confirmRecovery(title: string, body: ReactNode, acceptLabel: string): Promise<boolean> {
  return (
    (await askConfirm({
      title,
      body,
      choices: [
        { key: "cancel", label: "Cancel", tone: "ghost" },
        { key: "confirm", label: acceptLabel, tone: "danger" },
      ],
      defaultKey: "cancel",
    })) === "confirm"
  );
}

export function SessionView({
  id,
  cwd,
  taskSlug,
  repoPath,
  phase,
  harness,
  playbook,
  model,
  intent,
  resumeToken,
  appearance,
  messageDraft,
  onMessageDraftChange,
  queuedFollowUps = [],
  onQueuedFollowUpsChange,
  sendRecovery,
  onAppearanceChange,
  onBack,
  onStartFresh,
  onOpenReplacement,
  onOpenSession,
  onStartReviewHandoff,
  onOpenRelatedTask,
  onDiagramZoomOpenChange,
  onNameCommitted,
}: {
  id: string;
  cwd: string;
  taskSlug: string;
  repoPath: string;
  phase: string;
  harness: string;
  playbook?: string;
  model: string;
  // Explicit intent from a navigation (Start fresh -> spawn, Resume -> resume) bypasses the
  // lifecycle gate; undefined means "derive from the live classification" (issue #24).
  intent?: "attach" | "spawn" | "resume" | "history";
  resumeToken?: string;
  appearance: AppearancePrefs;
  messageDraft: SessionMessageDraft;
  onMessageDraftChange: (draft: SessionMessageDraft) => void;
  queuedFollowUps?: QueuedFollowUp[];
  onQueuedFollowUpsChange?: (items: QueuedFollowUp[]) => void;
  sendRecovery?: Map<string, SessionSendRecovery>;
  onAppearanceChange: (next: AppearancePrefs) => void;
  onBack: () => void;
  onStartFresh: () => void;
  onOpenReplacement?: (session: SessionMeta) => void;
  onOpenSession?: (session: SessionMeta) => void;
  onStartReviewHandoff: (source: ReviewHandoffSource) => void;
  onOpenRelatedTask: (slug: string, relatedRepoPath?: string) => void;
  onDiagramZoomOpenChange?: (open: boolean) => void;
  onNameCommitted?: (change: NameCommit) => void;
}) {
  const [artifactItems, setArtifactItems] = useState<ArtifactListItem[]>([]);
  const [artifactTree, setArtifactTree] = useState<ArtifactTreeNode[]>([]);
  const artifactNames = artifactItems.map((a) => a.name);
  const [selectedArtifact, setSelectedArtifact] = useState("");
  const [selectedArtifactNode, setSelectedArtifactNode] = useState<ArtifactTreeNode | null>(null);
  const selectedArtifactTreeId = selectedArtifactNode?.id;
  const selectedArtifactItem = artifactItems.find((item) => item.name === selectedArtifact);
  const selectedArtifactIsDirect = selectedArtifactNode ? isDirectOwnedArtifactNode(selectedArtifactNode) : Boolean(selectedArtifactItem && !selectedArtifactItem.attachment);
  const [artifactText, setArtifactText] = useState("");
  const [artifactMode, setArtifactMode] = useState<"preview" | "raw">("preview");
  const [artifactErr, setArtifactErr] = useState("");
  const [artifactTab, setArtifactTab] = useState<ArtifactPaneTab>("playbook");
  const [artifactComments, setArtifactComments] = useState<ArtifactComment[]>([]);
  const [artifactCommentCountByArtifact, setArtifactCommentCountByArtifact] = useState<Record<string, number>>({});
  const [commentAnchor, setCommentAnchor] = useState<ArtifactCommentAnchor | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [commentBusy, setCommentBusy] = useState(false);
  const [commentSendBusy, setCommentSendBusy] = useState(false);
  const [commentSendStatus, setCommentSendStatus] = useState("");
  const [reviewPending, setReviewPending] = useState<ArtifactReviewPendingStatus | null>(null);
  const [artifactWidth, artifactResizerProps] = useArtifactPaneWidth(appearance, onAppearanceChange);
  const termhostRef = useRef<HTMLDivElement>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const chatAutoCompaction = appearance.chat_auto_compaction !== false;
  const chatAutoCompactionRef = useRef(chatAutoCompaction);
  chatAutoCompactionRef.current = chatAutoCompaction;
  const compactionStateRequestRef = useRef<string | null>(null);
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  const commentOpenerRef = useRef<HTMLElement | null>(null);
  const {
    drafts: artifactCommentDrafts,
    draftError: artifactCommentDraftError,
    updateDraft: persistCommentDraft,
    discardDraft: discardCommentDraft,
    getDraft: getCommentDraft,
  } = useArtifactCommentDrafts(repoPath, taskSlug);
  const selectedArtifactDrafts = selectedArtifactIsDirect ? artifactCommentDrafts.filter((draft) => draft.artifact === selectedArtifact) : [];
  const recoverableArtifactDrafts = selectedArtifactDrafts.filter((draft) => draft.anchor_id !== commentAnchor?.anchor_id);
  const recoverableArtifactDraftAnchorIds = recoverableArtifactDrafts.map((draft) => draft.anchor_id);
  const [task, setTask] = useState<Task | null>(null);
  const [parentTask, setParentTask] = useState<Task | null>(null);
  const [display, setDisplay] = useState<SessionDisplayContext | null>(null);
  const [editingName, setEditingName] = useState(false);
  const nameTrigger = useRef<HTMLButtonElement | null>(null);
  const displayRequest = useRef(0);
  const displayEpoch = useRef(0);
  const displayScope = `${repoPath}\u0000${taskSlug}\u0000${id}`;
  const currentDisplayScope = useRef(displayScope);
  if (currentDisplayScope.current !== displayScope) {
    currentDisplayScope.current = displayScope;
    displayEpoch.current += 1;
    displayRequest.current += 1;
  }
  const refreshDisplay = async () => {
    const epoch = displayEpoch.current;
    const request = ++displayRequest.current;
    try {
      const next = await ipc.getSessionDisplay(repoPath, taskSlug, id);
      if (epoch === displayEpoch.current && request === displayRequest.current) setDisplay(next);
    } catch {
      // Naming is optional; history and Terminal stay usable when the read fails.
    }
  };
  const closeNameEditor = () => {
    flushSync(() => setEditingName(false));
    restoreNameFocus(nameTrigger.current);
  };
  const saveName = async (name: string) => {
    const epoch = displayEpoch.current;
    const value = await ipc.renameSession({ repoPath, taskSlug, sessionId: id, name });
    if (epoch === displayEpoch.current) {
      displayEpoch.current += 1;
      displayRequest.current += 1;
      setDisplay((current) =>
        current
          ? { ...current, session: { ...current.session, name: value.name, name_source: value.source, name_error: null } }
          : {
              session: {
                id,
                worktree: cwd,
                created: 0,
                archived: false,
                phase,
                harness,
                model,
                playbook: playbook || "",
                generic: false,
                harness_resume_token: "",
                name: value.name,
                name_source: value.source,
              },
              task_name: task?.name || taskSlug,
              subtask_name: null,
            },
      );
      closeNameEditor();
      void refreshDisplay();
    }
    onNameCommitted?.({ kind: "session", repo_path: repoPath, task_slug: taskSlug, session_id: id, value });
  };

  useEffect(() => {
    let alive = true;
    let timer = 0;
    setDisplay(null);
    setEditingName(false);
    if (taskSlug) {
      const poll = () => {
        void refreshDisplay().finally(() => {
          if (alive) timer = window.setTimeout(poll, 3000);
        });
      };
      poll();
    }
    return () => {
      alive = false;
      displayEpoch.current += 1;
      displayRequest.current += 1;
      window.clearTimeout(timer);
    };
  }, [repoPath, taskSlug, id]);
  const [executionView, setExecutionView] = useState<TaskExecutionReply | null>(null);
  const executionEpoch = useRef(0);
  const [followEnabled, setFollowEnabled] = useState(true);
  const followContinuation = useRef<string | null>(null);
  const followNavigation = useRef<string | null>(null);
  const [executionError, setExecutionError] = useState("");
  const [lineageSessions, setLineageSessions] = useState<SessionDisplayMeta[]>([]);
  const [lineageObservations, setLineageObservations] = useState<Record<string, SessionObservation>>({});
  const [lineageError, setLineageError] = useState("");
  const executionAvailable = executionView?.live?.status === "available" && !executionError;
  const [artifactEntryOpen, setArtifactEntryOpen] = useState(false);
  const [artifactEntryError, setArtifactEntryError] = useState("");
  const artifactAuthorization = useRef<EndExecutionRequest | null>(null);
  const [completionBusy, setCompletionBusy] = useState(false);
  const continuationInFlight = useRef(false);
  const [continuationMessage, setContinuationMessage] = useState("");
  const [modeChanging, setModeChanging] = useState(false);
  const modeChangingRef = useRef(false);
  const [endMessage, setEndMessage] = useState("");
  const [sessionActionsOpen, setSessionActionsOpen] = useState(false);
  const [continuationInfoOpen, setContinuationInfoOpen] = useState(false);
  const [endAccepted, setEndAccepted] = useState(false);
  const [requestedContinuation, setRequestedContinuation] = useState<{ id: string; revision: number } | null>(null);
  const [invalidatedReady, setInvalidatedReady] = useState<{ id: string; revision: number } | null>(null);
  const execution = Object.values(executionView?.state.executions ?? {}).find((record) => record.owner_session_id === id || record.previous_session_ids.includes(id));
  const automaticContinuation = executionView?.state.auto_approve_all === true || execution?.continuation_mode === "automatic";
  const executionStep = executionView?.definition.step.find((step) => step.key === execution?.candidate.step_key);
  const [reviewFindingsComments, setReviewFindingsComments] = useState<ArtifactComment[]>([]);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalStatus, setApprovalStatus] = useState("");
  const hasTask = Boolean(taskSlug);
  const [observation, setObservation] = useState<SessionObservation | null>(null);
  const [terminalConnection, setTerminalConnection] = useState<SessionTerminalConnectionState>("opening");
  const [messageComposing, setMessageComposing] = useState(false);
  const [messageSending, setMessageSending] = useState(false);
  const [messageInterrupting, setMessageInterrupting] = useState(false);
  const [messageError, setMessageError] = useState("");
  const [chat, setChat] = useState<ChatTranscriptState>(emptyTranscript);
  const [modelDialog, setModelDialog] = useState<{ tab: ProvidersDialogTab; preselect: string; setup?: boolean } | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelRoles, setModelRoles] = useState<ModelRolesMap>({});
  const [hosted, setHosted] = useState<HostedCatalogView | null>(null);
  const [hostedLoaded, setHostedLoaded] = useState(false);
  const [loginBusy, setLoginBusy] = useState<string | null>(null);
  const [livePromotedIds, setLivePromotedIds] = useState<string[]>([]);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [mcpDialog, setMcpDialog] = useState<{ rows: McpServerRow[]; empty: boolean } | null>(null);
  const [chatAttachEpoch, setChatAttachEpoch] = useState(0);
  const ompStartRef = useRef<string | null>(null);
  const ompSeedRef = useRef<{ id: string; done: Promise<unknown> } | null>(null);
  // The session the RPC stream last attached to: a later attach for the same id is a reattach.
  const rpcAttachedRef = useRef<string | null>(null);
  const preferredViewAppliedRef = useRef<string | null>(null);
  const handledUiRef = useRef(new Set<string>());
  const mcpListWaitRef = useRef(false);
  const modelApplyRef = useRef(false);
  const loginApplyRef = useRef<string | null>(null);
  // Armed by startChatLogin, consumed by the first `open_url` that follows. See the drain effect.
  const loginOpenUrlRef = useRef<string | null>(null);
  const setupOpenedRef = useRef(false);
  const [viewBusy, setViewBusy] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const archivePending = useRef(false);
  const [dropping, setDropping] = useState(false);
  const attachmentSeq = useRef(0);
  const localSendRecovery = useRef(new Map<string, SessionSendRecovery>());
  const pendingSends = sendRecovery ?? localSendRecovery.current;
  const pendingSendsRef = useRef(pendingSends);
  pendingSendsRef.current = pendingSends;
  const [, refreshSendRecovery] = useState(0);
  const invalidateReview = () => {
    if (execution?.ready_revision != null) setInvalidatedReady({ id: execution.id, revision: execution.ready_revision });
  };
  const writeRpc = async (payload: unknown) => requireWritten(await ipc.rpcWriteSession(id, payload));
  const writeRaw = async (data: string) => requireWritten(await ipc.writeSession(id, data, crypto.randomUUID()));
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const queuedFollowUpsRef = useRef(queuedFollowUps);
  const releaseUnusedPreviews = (attachments: DraftAttachment[]) => {
    const retained = new Set([
      ...messageDraftRef.current.attachments.map((attachment) => attachment.previewUrl),
      ...[...pendingSendsRef.current.values()].flatMap((item) => item.attachments.map((attachment) => attachment.previewUrl)),
      ...queuedFollowUpsRef.current.flatMap((item) => item.attachments.map((attachment) => attachment.previewUrl)),
    ]);
    revokeDraftPreviewUrls(attachments.filter((attachment) => !retained.has(attachment.previewUrl)));
  };
  queuedFollowUpsRef.current = queuedFollowUps;

  const handleTerminalConnectionState = useCallback((state: SessionTerminalConnectionState) => setTerminalConnection(state), []);
  const messageDraftRef = useRef(messageDraft);
  messageDraftRef.current = messageDraft;
  const updateMessageDraft = (draft: SessionMessageDraft) => {
    messageDraftRef.current = draft;
    onMessageDraftChange(draft);
  };
  const refuseSend = (pending: SessionSendRecovery, reason: string) => {
    pending.status = "refused";
    pending.reason = reason;
    const draft = messageDraftRef.current;
    const blank = draft.body === "" && draft.attachments.length === 0 && draft.pendingActions.length === 0;
    const transfer = pending.transferDispatchId !== undefined;
    const restore = blank || draft === pending.sourceDraft;
    const next = settleRefusedSend(chatRef.current, pending.entryId, pending.caption, pending.origin === "nudge" || transfer || restore);
    chatRef.current = next;
    setChat(next);
    if (pending.origin === "nudge" || transfer || restore) {
      if (!transfer && pending.origin !== "nudge") updateMessageDraft({ body: pending.draft, pendingActions: pending.actions, attachments: pending.attachments });
      pendingSendsRef.current.delete(pending.commandId);
    }
    const remaining = queuedFollowUpsRef.current.filter((item) => item.dispatchId !== pending.commandId);
    if (remaining.length !== queuedFollowUpsRef.current.length) {
      queuedFollowUpsRef.current = remaining;
      onQueuedFollowUpsChange?.(remaining);
    }
    if (transfer) {
      releaseUnusedPreviews(pending.attachments);
      const stillQueued = queuedFollowUpsRef.current.some((item) => item.dispatchId === pending.transferDispatchId);
      reason = `Couldn't send now.${stillQueued ? " The message remains queued." : ""} ${reason}`;
    }
    refreshSendRecovery((revision) => revision + 1);
    setMessageError(reason);
  };

  const nextAttachmentId = () => {
    attachmentSeq.current += 1;
    return `att-${attachmentSeq.current}`;
  };

  const refreshAttachmentArtifacts = () => {
    void ipc
      .listArtifactsWithMetadata(taskSlug)
      .then((items) => {
        setArtifactItems((current) => (sameArtifactListItems(current, items) ? current : items));
      })
      .catch(() => undefined);
    void ipc
      .listTaskArtifactTree(taskSlug)
      .then(setArtifactTree)
      .catch(() => undefined);
  };

  const stageIncoming = (accepted: DraftAttachment[]) => {
    if (accepted.length === 0) return;
    const current = messageDraftRef.current;
    updateMessageDraft({ ...current, attachments: [...current.attachments, ...accepted] });
  };

  const stagePaths = async (paths: string[]) => {
    const incomingPaths = paths.filter((path) => path.length > 0 && !isHttpUrl(path));
    if (incomingPaths.length === 0) return;
    const current = messageDraftRef.current.attachments;
    const accepted: DraftAttachment[] = [];
    const stagedForCaps = [...current];
    for (const path of incomingPaths) {
      try {
        const stat = await ipc.chatFileStat(path);
        const kind = classifyAttachment({ name: stat.name });
        const verdict = canStage(stagedForCaps, [{ name: stat.name, mimeType: kind === "image" ? "image/png" : "application/octet-stream", bytes: stat.bytes }])[0];
        if (!verdict || verdict.ok === false) {
          toast.error(verdict && verdict.ok === false ? verdict.reason : `${stat.name} — could not attach`);
          continue;
        }
        const item: DraftAttachment = {
          id: nextAttachmentId(),
          kind,
          name: stat.name,
          mimeType: kind === "image" ? "image/png" : "application/octet-stream",
          bytes: stat.bytes,
          sourcePath: path,
        };
        accepted.push(item);
        stagedForCaps.push(item);
      } catch (error) {
        toast.error(String(error));
      }
    }
    stageIncoming(accepted);
  };

  const stageBlobs = (files: File[]) => {
    const current = messageDraftRef.current.attachments;
    const accepted: DraftAttachment[] = [];
    const stagedForCaps = [...current];
    for (const file of files) {
      if (isHttpUrl(file.name)) continue;
      const kind = classifyAttachment({ mimeType: file.type, name: file.name });
      const mimeType = file.type || (kind === "image" ? "image/png" : "application/octet-stream");
      const verdict = canStage(stagedForCaps, [{ name: file.name, mimeType, bytes: file.size }])[0];
      if (!verdict || verdict.ok === false) {
        toast.error(verdict && verdict.ok === false ? verdict.reason : `${file.name} — could not attach`);
        continue;
      }
      const item: DraftAttachment = {
        id: nextAttachmentId(),
        kind,
        name: file.name,
        mimeType,
        bytes: file.size,
        previewUrl: URL.createObjectURL(file),
      };
      accepted.push(item);
      stagedForCaps.push(item);
    }
    stageIncoming(accepted);
  };

  useEffect(() => {
    const un = ipc.getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "enter" || event.payload.type === "over") {
        setDropping(true);
        return;
      }
      if (event.payload.type === "leave") {
        setDropping(false);
        return;
      }
      const { paths } = event.payload;
      setDropping(false);
      void stagePaths(paths);
    });
    return () => {
      un.then((f) => f());
    };
  }, [taskSlug]);

  // ---- session durability & resume gate (issue #24) ----
  // An explicit navigation intent (Start fresh -> spawn, Resume -> resume) skips the gate and
  // mounts the terminal directly; leftover non-OMP rows still classify so the refuse panel
  // can render instead of a permanent spinner. Otherwise we classify once and decide whether
  // to mount a live terminal or a read-only action panel (never a silent phase re-run).
  const leftover = !isAllowedLaunchHarness(harness);
  const explicitIntent = intent === "spawn" || intent === "resume";
  const [lifecycle, setLifecycle] = useState<LifecycleState | null>(null);
  const effectiveLifecycle = observation?.lifecycle ?? lifecycle;
  const effectiveLifecycleState = effectiveLifecycle?.state;
  const [artifactReady, setArtifactReady] = useState(false);
  const [reclassifyTick, setReclassifyTick] = useState(0);
  // View history: mount a read-only replay of the session's activity sidecar instead of a
  // live terminal. navHistory (intent) replaces the panel (archived rows); showHistory (panel
  // button) shows the replay BELOW the action panel (issue #24 P7).
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    // Fix (session switch): reset synchronously before the async classification lands, so a
    // session->session switch (same component instance) never briefly renders the previous
    // session's lifecycle/resume/artifact state during the await gap.
    setLifecycle(null);
    if ((explicitIntent && !leftover) || intent === "history") return;
    let alive = true;
    ipc
      .sessionStatus(id, taskSlug || null)
      .then((obs) => {
        if (!alive) return;
        setLifecycle(obs.lifecycle);
      })
      .catch(() => {
        if (alive) {
          setLifecycle({ state: "orphaned" });
        }
      });
    return () => {
      alive = false;
    };
  }, [explicitIntent, leftover, id, taskSlug, reclassifyTick, intent]);

  useEffect(() => {
    setArtifactReady(false);
    if (effectiveLifecycleState !== "orphaned" && effectiveLifecycleState !== "interrupted") return;
    let alive = true;
    // Refresh preserved-work copy when polling enters recovery, not just on navigation.
    ipc
      .sessionArtifactReady(id, taskSlug || "")
      .then((ready) => {
        if (alive) setArtifactReady(!!ready);
      })
      .catch(() => {
        if (alive) setArtifactReady(false);
      });
    return () => {
      alive = false;
    };
  }, [effectiveLifecycleState, id, taskSlug, reclassifyTick]);

  useEffect(() => {
    setObservation(null);
    setTerminalConnection("opening");
    setMessageComposing(false);
    setMessageSending(false);
    setMessageError("");
    setChat(emptyTranscript());
    setModelDialog(null);
    setModelError(null);
    setModelRoles({});
    setLoginBusy(null);
    setLivePromotedIds([]);
    setToolsOpen(false);
    setMcpDialog(null);
    ompStartRef.current = null;
    ompSeedRef.current = null;
    preferredViewAppliedRef.current = null;
    handledUiRef.current.clear();
    if (!sendRecovery) localSendRecovery.current.clear();
    mcpListWaitRef.current = false;
    modelApplyRef.current = false;
    loginApplyRef.current = null;
    loginOpenUrlRef.current = null;
    setupOpenedRef.current = false;
    setViewBusy(false);
    if (intent === "history") return;
    let alive = true;
    let pollFailures = 0;
    const observe = () => {
      ipc
        .sessionStatus(id, taskSlug || null)
        .then((next) => {
          if (!alive) return;
          const recovering = pollFailures > 0;
          pollFailures = 0;
          setObservation(next);
          if (recovering) setChatAttachEpoch((epoch) => epoch + 1);
        })
        .catch(() => {
          // Keep the last observation so a transient poll error cannot flip liveRpc
          // and wipe the transcript. Count the miss so a later success can re-attach
          // without clearing entries (dead socket / daemon restart).
          if (alive) pollFailures += 1;
        });
    };
    observe();
    const timer = window.setInterval(observe, 1500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [id, taskSlug, repoPath, intent]);

  useEffect(() => {
    let alive = true;
    executionEpoch.current += 1;
    followContinuation.current = null;
    if (followNavigation.current && followNavigation.current !== id) {
      followNavigation.current = null;
      setFollowEnabled(false);
    }
    continuationInFlight.current = false;
    modeChangingRef.current = false;
    setModeChanging(false);
    setCompletionBusy(false);
    setArtifactEntryOpen(false);
    setArtifactEntryError("");
    artifactAuthorization.current = null;
    setExecutionView(null);
    setExecutionError("");
    setLineageSessions([]);
    setLineageObservations({});
    setLineageError("");
    setEndMessage("");
    setContinuationMessage("");
    setRequestedContinuation(null);
    setInvalidatedReady(null);
    setSessionActionsOpen(false);
    setContinuationInfoOpen(false);
    setEndAccepted(false);
    if (!taskSlug) return;
    let timer = 0;
    const refresh = async () => {
      try {
        const [executionResult, sessionsResult] = await Promise.allSettled([readTaskExecution(repoPath, taskSlug), ipc.listSessions(taskSlug, repoPath)]);
        if (!alive) return;
        if (sessionsResult.status === "fulfilled") {
          setLineageSessions(sessionsResult.value);
          setLineageError("");
        } else {
          setLineageError(String(sessionsResult.reason));
        }
        if (executionResult.status === "rejected") throw executionResult.reason;
        const next = executionResult.value;
        if (alive) {
          setExecutionView(next);
          setExecutionError("");
        }
        const refs =
          sessionsResult.status === "fulfilled"
            ? sessionsResult.value
                .filter((session) => session.id !== id && !session.archived && !session.ended_at)
                .map((session) => ({ repo_path: repoPath, task_slug: taskSlug, id: session.id }))
            : [];
        const observed = refs.length ? await ipc.sessionListStatuses(refs).catch(() => ({}) as Record<string, SessionObservation>) : {};
        if (alive) {
          setLineageObservations(
            Object.fromEntries(
              refs.flatMap((ref) => {
                const value = observed[`${ref.repo_path}:${ref.task_slug}:${ref.id}`];
                return value ? [[ref.id, value]] : [];
              }),
            ),
          );
        }
      } catch (error) {
        if (alive) {
          setExecutionError(String(error));
          setLineageObservations({});
        }
      } finally {
        if (alive) timer = window.setTimeout(refresh, 1500);
      }
    };
    void refresh();
    return () => {
      alive = false;
      executionEpoch.current += 1;
      window.clearTimeout(timer);
    };
  }, [taskSlug, repoPath, id]);

  useEffect(() => {
    if (!followEnabled || !executionAvailable || !executionView || lineageError || !onOpenSession) return;
    if (followNavigation.current && followNavigation.current !== id) return;
    if (!execution || execution.owner_session_id !== id) return;
    if (!followContinuation.current) {
      // Opening history must not redirect; following an already-finished successor may continue the chain.
      if (execution.lifecycle === "completed" && followNavigation.current !== id) {
        setFollowEnabled(false);
        return;
      }
      if (!["running", "finishing", "completed"].includes(execution.lifecycle)) return;
      followContinuation.current = execution.id;
      followNavigation.current = null;
    }
    const source = executionView.state.executions[followContinuation.current];
    if (!source || source.owner_session_id !== id) return;
    if (!source.receipt_id || !source.shutdown_confirmed || source.lifecycle !== "completed") return;
    const successors = Object.values(executionView.state.executions).filter((record) => record.parent_execution_ids.includes(source.id));
    // Follow actual execution lineage, not prospective destinations that disappear after completion.
    // A fan-out has no single destination session. Leave selection to the navigator.
    if (successors.length !== 1) return;
    const successor = successors[0];
    if (!["running", "finishing", "completed"].includes(successor.lifecycle)) return;
    const session = lineageSessions.find((item) => item.id === successor.owner_session_id && item.execution_id === successor.id && !item.archived && item.started_at != null);
    if (!session) return;
    followNavigation.current = session.id;
    onOpenSession(session);
  }, [executionView, executionAvailable, execution, followEnabled, lineageSessions, lineageError, id, onOpenSession]);

  const handleArchive = async () => {
    if (archivePending.current) return;
    archivePending.current = true;
    try {
      // archive_session kills+reaps a live pty before archiving, so a live session
      // must state that consequence first (DESIGN.md: consequences before confirmation).
      const live = effectiveLifecycle?.state === "live";
      const label = harnessDisplayName(harness) + (model ? ` · ${model}` : "");
      const ok = await confirmDanger(
        "Archive session",
        live
          ? `Session ${id} (${label}) still has a running process. Archiving stops that process, then moves the session out of the active list. Scrollback is kept.`
          : `Session ${id} (${label}) will move out of the active list. Its scrollback and artifacts are kept.`,
        live ? "Stop and archive" : "Archive session",
      );
      if (!ok) return;
      setArchiveBusy(true);
      await ipc.archiveSession(taskSlug, id);
      toast("Session archived", "success");
      onBack();
    } catch (error) {
      toast(String(error), "error");
    } finally {
      archivePending.current = false;
      setArchiveBusy(false);
    }
  };
  // Manual resume-token entry. launch harnesses (claude/grok) already carry a minted token, so in
  // practice this modal only surfaces for omp (id_source = "manual"). ponytail: omp auto-resume
  useEffect(() => {
    let alive = true;
    let timer = 0;
    let request = 0;
    setTask(null);
    setParentTask(null);
    if (!hasTask) return;
    const poll = async () => {
      const epoch = displayEpoch.current;
      const sequence = ++request;
      try {
        const tasks = await ipc.listTasks(repoPath);
        if (!alive || epoch !== displayEpoch.current || sequence !== request) return;
        const currentTask = tasks.find((candidate) => candidate.slug === taskSlug) ?? null;
        setTask(currentTask);
        setParentTask(currentTask?.parent_task ? (tasks.find((candidate) => candidate.slug === currentTask.parent_task) ?? null) : null);
      } catch {
        // Retain the last known context through a transient read failure.
      } finally {
        if (alive && sequence === request) timer = window.setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => {
      alive = false;
      request += 1;
      window.clearTimeout(timer);
    };
  }, [hasTask, taskSlug, repoPath, id]);

  useEffect(() => {
    setArtifactTab("playbook");
    setSelectedArtifactNode(null);
    setArtifactCommentCountByArtifact({});
  }, [id, taskSlug]);

  useEffect(() => {
    let alive = true;
    if (!hasTask) {
      setArtifactItems([]);
      setArtifactTree([]);
      setSelectedArtifact("");
      setSelectedArtifactNode(null);
      setArtifactErr("");
      return;
    }
    let itemsError = "";
    let treeError = "";
    let itemsTimer = 0;
    let treeTimer = 0;
    const reportLoadError = () => {
      if (alive && !selectedArtifact) setArtifactErr([itemsError, treeError].filter(Boolean).join(" · "));
    };
    const pollItems = () => {
      ipc
        .listArtifactsWithMetadata(taskSlug)
        .then((items) => {
          if (!alive) return;
          setArtifactItems((current) => (sameArtifactListItems(current, items) ? current : items));
          itemsError = "";
          reportLoadError();
        })
        .catch((error) => {
          itemsError = String(error);
          reportLoadError();
        })
        .finally(() => {
          if (alive) itemsTimer = window.setTimeout(pollItems, 3000);
        });
    };
    const pollTree = () => {
      ipc
        .listTaskArtifactTree(taskSlug)
        .then((tree) => {
          if (!alive) return;
          setArtifactTree(tree);
          treeError = "";
          reportLoadError();
        })
        .catch((error) => {
          treeError = String(error);
          reportLoadError();
        })
        .finally(() => {
          if (alive) treeTimer = window.setTimeout(pollTree, 3000);
        });
    };
    pollItems();
    pollTree();
    return () => {
      alive = false;
      window.clearTimeout(itemsTimer);
      window.clearTimeout(treeTimer);
    };
  }, [hasTask, taskSlug, selectedArtifact]);

  useEffect(() => {
    let alive = true;
    if (!hasTask || !selectedArtifact || (!selectedArtifactIsDirect && !selectedArtifactTreeId)) {
      setArtifactText("");
      setArtifactComments([]);
      setReviewPending(null);
      setCommentAnchor(null);
      setCommentDraft("");
      setCommentSendStatus("");
      return () => {
        alive = false;
      };
    }
    const commentsDisabled = !selectedArtifactIsDirect || selectedArtifact.endsWith(".comments.md");
    setArtifactText("");
    setArtifactErr("");
    setReviewPending(null);
    setCommentAnchor(null);
    setCommentDraft("");
    setCommentSendStatus("");
    if (commentsDisabled) {
      setArtifactComments([]);
    } else {
      ipc
        .listArtifactComments(taskSlug, selectedArtifact)
        .then((comments) => {
          if (!alive) return;
          setArtifactComments(comments);
          setArtifactCommentCountByArtifact((current) => ({ ...current, [selectedArtifact]: comments.length }));
        })
        .catch((error) => {
          if (alive) setArtifactErr(String(error));
        });
      ipc
        .artifactReviewPendingStatus(taskSlug, selectedArtifact)
        .then((pending) => {
          if (alive) setReviewPending(pending);
        })
        .catch((error) => {
          if (alive) setArtifactErr(String(error));
        });
    }
    const read = (() => {
      if (selectedArtifactIsDirect) return ipc.readArtifact(taskSlug, selectedArtifact);
      if (selectedArtifactTreeId) return ipc.readTaskArtifactNode(taskSlug, selectedArtifactTreeId);
      return Promise.reject(new Error("Selected artifact has no tree identity"));
    })();
    read
      .then((text) => {
        if (alive) setArtifactText(text);
      })
      .catch((error) => {
        if (alive) setArtifactErr(String(error));
      });
    return () => {
      alive = false;
    };
  }, [hasTask, taskSlug, selectedArtifact, selectedArtifactTreeId, selectedArtifactIsDirect]);

  const trimmedCommentDraft = commentDraft.trim();
  const canSaveArtifactComment = Boolean(commentAnchor && selectedArtifact && trimmedCommentDraft && !commentBusy);

  const handleCommentDraftChange = (body: string) => {
    setCommentDraft(body);
    if (commentAnchor && selectedArtifact) persistCommentDraft(selectedArtifact, commentAnchor, body);
  };

  const latestReviewFindings = artifactItems
    // A just-copied attachment always carries the newest mtime, so an attachment named
    // 03-review-findings.md would otherwise win this modified_at_ms-descending sort.
    .filter((item) => !item.attachment && (item.playbook_step === "review-findings" || /^03-review-findings(?:-\d+)?\.md$/.test(item.name)))
    .sort((a, b) => (b.modified_at_ms ?? 0) - (a.modified_at_ms ?? 0))[0];
  const playbookArtifactItems = artifactPaneItems(artifactItems, "playbook");
  const attachmentItems = artifactPaneItems(artifactItems, "attachments");
  const displayedArtifactItems = artifactPaneItems(artifactItems, artifactTab);
  const contextualArtifactTree = artifactPaneTreeNodes(
    artifactTree.filter((node) => node.source !== "owned"),
    artifactTab,
  );
  const commentableArtifactNames = artifactItems.map((item) => item.name).filter((name) => !name.endsWith(".comments.md"));
  const commentableArtifactSignature = commentableArtifactNames.join("|");
  const effectivePlaybook = executionView?.definition.key ?? playbook ?? task?.playbook ?? "";
  const commentsNewerThanFindings = Boolean(
    latestReviewFindings?.modified_at_ms && reviewFindingsComments.some((comment) => comment.created_at_ms > (latestReviewFindings.modified_at_ms ?? 0)),
  );

  useEffect(() => {
    let alive = true;
    if (!hasTask || !latestReviewFindings) {
      setReviewFindingsComments([]);
      return () => {
        alive = false;
      };
    }
    ipc
      .listArtifactComments(taskSlug, latestReviewFindings.name)
      .then((comments) => {
        if (alive) setReviewFindingsComments(comments);
      })
      .catch(() => {
        if (alive) setReviewFindingsComments([]);
      });
    return () => {
      alive = false;
    };
  }, [hasTask, taskSlug, latestReviewFindings?.name]);

  useEffect(() => {
    let alive = true;
    if (!hasTask || commentableArtifactNames.length === 0) {
      setArtifactCommentCountByArtifact({});
      return () => {
        alive = false;
      };
    }
    Promise.all(
      commentableArtifactNames.map((artifact) =>
        ipc
          .listArtifactComments(taskSlug, artifact)
          .then((comments) => [artifact, comments.length] as const)
          .catch(() => [artifact, 0] as const),
      ),
    ).then((entries) => {
      if (!alive) return;
      setArtifactCommentCountByArtifact(Object.fromEntries(entries));
    });
    return () => {
      alive = false;
    };
  }, [hasTask, taskSlug, commentableArtifactSignature]);

  const saveArtifactComment = () => {
    if (!canSaveArtifactComment || !commentAnchor || !selectedArtifact) return;
    setCommentBusy(true);
    ipc
      .addArtifactCommentForRepo({
        repoPath,
        taskSlug,
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
        setArtifactCommentCountByArtifact((current) => ({ ...current, [selectedArtifact]: comments.length }));
        if (selectedArtifact === latestReviewFindings?.name) setReviewFindingsComments(comments);
        setCommentAnchor(null);
        setCommentDraft("");
        setCommentSendStatus("");
      })
      .catch((e) => {
        setArtifactErr(String(e));
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
    // Escape hands focus back to the block that opened the composer; the draft
    // stays (autosaved) so nothing is lost.
    if (ev.key === "Escape") {
      ev.preventDefault();
      commentOpenerRef.current?.focus();
    }
  };

  const openArtifactComment = useCallback(
    (anchor: ArtifactCommentAnchor) => {
      // Remember the block that opened the composer so Escape can return focus
      // there (keyboard comment path).
      commentOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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

  const appendPreparedAction = (text: string, provenance: SessionMessageActionProvenance) => {
    const current = messageDraftRef.current;
    updateMessageDraft({
      ...current,
      body: appendGeneratedText(current.body, text),
      pendingActions: [...current.pendingActions, provenance],
    });
    setMessageError("");
  };

  const addCommentsToDraft = () => {
    const targets = selectedArtifact && !selectedArtifact.endsWith(".comments.md") && artifactComments.length > 0 ? [selectedArtifact] : [];
    if (targets.length === 0 || messageSending) return;
    setCommentSendBusy(true);
    setCommentSendStatus("");
    ipc
      .prepareArtifactCommentsPrompt(taskSlug, targets)
      .then((prepared) => {
        appendPreparedAction(prepared.text, prepared.provenance);
        setCommentSendStatus(targets.length === 1 ? "Added review comments to draft." : `Added ${targets.length} review files to draft.`);
      })
      .catch((error) => setArtifactErr(String(error)))
      .finally(() => setCommentSendBusy(false));
  };

  const clearPendingReview = () => {
    if (!selectedArtifact) return;
    ipc
      .clearArtifactReviewPendingForRepo(repoPath, taskSlug, selectedArtifact)
      .then(() => setReviewPending(null))
      .catch((error) => setArtifactErr(String(error)));
  };

  const canSendCommentsToSession = selectedArtifact !== "" && !selectedArtifact.endsWith(".comments.md") && artifactComments.length > 0;
  const commentSendBadge = artifactComments.length;
  const commentSendTitle = commentSendStatus || "Add human comments to the message draft";

  const addApprovalPrompt = () => {
    if (!latestReviewFindings || messageSending) return;
    setApprovalBusy(true);
    setApprovalStatus("");
    ipc
      .prepareReviewApprovalPrompt(taskSlug, latestReviewFindings.name)
      .then((prepared) => {
        appendPreparedAction(prepared.text, prepared.provenance);
        setApprovalStatus("Added approval prompt to draft.");
      })
      .catch((error) => setArtifactErr(String(error)))
      .finally(() => setApprovalBusy(false));
  };

  const refreshFinalizedActions = async (actions: SessionMessageActionProvenance[]) => {
    const commentArtifacts = actions.flatMap((action) => (action.type === "artifact_comments" ? action.items.map((item) => item.artifact) : []));
    if (commentArtifacts.length > 0) {
      const refreshed = await Promise.all(
        commentArtifacts.map(async (artifact) => ({
          artifact,
          comments: await ipc.listArtifactComments(taskSlug, artifact),
        })),
      );
      setArtifactCommentCountByArtifact((current) => {
        const next = { ...current };
        for (const entry of refreshed) next[entry.artifact] = entry.comments.length;
        return next;
      });
      const selected = refreshed.find((entry) => entry.artifact === selectedArtifact);
      if (selected) {
        setArtifactComments(selected.comments);
        setReviewPending(await ipc.artifactReviewPendingStatus(taskSlug, selectedArtifact));
      }
    }
  };

  const dispatchChatPlan = async (
    plan: ReturnType<typeof planChatSend>,
    busy: boolean,
    extras?: { message?: string; images?: ImageContent[] },
    beforeWrite?: (commandId: string) => void,
  ): Promise<{ commandId: string } | null> => {
    const dispatch = plan.dispatch;
    switch (dispatch.kind) {
      case "open-providers":
        setModelError(null);
        setModelDialog({ tab: dispatch.tab, preselect: dispatch.args, setup: false });
        void ipc
          .readOmpModelRoles()
          .then(setModelRoles)
          .catch(() => undefined);
        void ipc
          .hostedCatalog()
          .then(setHosted)
          .catch(() => setHosted(null))
          .finally(() => setHostedLoaded(true));
        await writeRpc(getLoginProvidersCommand()).catch(() => undefined);
        await writeRpc(getAvailableModelsCommand()).catch(() => undefined);
        await writeRpc(getStateCommand()).catch(() => undefined);
        return null;
      case "hatch":
        toast(dispatch.reason, "info");
        return null;
      case "get-tools":
        await writeRpc(getStateCommand());
        setToolsOpen(true);
        return null;
      case "mcp-list": {
        invalidateReview();
        mcpListWaitRef.current = true;
        const command = promptCommand("/mcp list");
        beforeWrite?.(command.id);
        await writeRpc(command);
        return null;
      }
      case "compact": {
        invalidateReview();
        const command = compactCommand(dispatch.customInstructions);
        beforeWrite?.(command.id);
        await writeRpc(command);
        return null;
      }
      case "mcp-prompt":
      case "compact-mode":
      case "prompt":
      case "unknown-prompt":
      case "plain": {
        const message = extras?.message ?? dispatch.message;
        const images = extras?.images;
        const command = busy ? followUpCommand(message, undefined, images) : promptCommand(message, undefined, images);
        invalidateReview();
        beforeWrite?.(command.id);
        await writeRpc(command);
        return plan.invokesModel ? { commandId: command.id } : null;
      }
    }
  };

  const sendCurrentMessage = async (text?: string, origin?: "nudge") => {
    const sourceDraft = messageDraftRef.current;
    const original = text === undefined || text === sourceDraft.body.trim() ? sourceDraft.body : text;
    const caption = original.trim();
    const attachments = origin === "nudge" ? [] : (messageDraftRef.current.attachments ?? []);
    if (messageSending || (caption.length === 0 && attachments.length === 0)) return;
    if (origin === "nudge" && [...pendingSendsRef.current.values()].some((pending) => pending.origin === "nudge" && pending.status !== "refused" && pending.status !== "settled"))
      return;
    if (caption.startsWith("/") && attachments.length > 0) {
      toast.error("Remove attachments or clear the slash command");
      return;
    }
    const transport = observation?.transport;
    if (transport !== "rpc" && transport !== "pty") {
      setMessageError("The session is still connecting.");
      return;
    }
    const actions = origin === "nudge" ? [] : [...messageDraftRef.current.pendingActions];
    const busy = isTurnActive({
      pendingTurn: chatRef.current.pendingTurn,
      turnOpen: chatRef.current.turnOpen,
      observation,
    });
    if (origin === "nudge" && busy) return sendNow(true);
    setMessageSending(true);
    setMessageError("");
    try {
      if (transport === "rpc") {
        let extras: { message?: string; images?: ImageContent[] } | undefined;
        let queuedAttachments = attachments;
        if (attachments.length > 0) {
          const prepared = await prepareChatSend(taskSlug, repoPath, caption, attachments);
          extras = { message: prepared.message, images: prepared.images };
          queuedAttachments = prepared.copied;
          refreshAttachmentArtifacts();
        }
        const plan = planChatSend(caption, chatRef.current.commands, busy);
        let recovery: SessionSendRecovery | undefined;
        try {
          await dispatchChatPlan(plan, busy, extras, (commandId) => {
            const rowAttachments = draftToRowAttachments(attachments);
            const applied = applySendPlan(chatRef.current, caption, plan, rowAttachments.length > 0 ? rowAttachments : undefined);
            const entryId = `dispatch:${commandId}`;
            const next = { ...applied.state, entries: applied.state.entries.map((entry) => (entry.id === applied.entryId ? { ...entry, id: entryId } : entry)) };
            chatRef.current = next;
            setChat(next);
            recovery = {
              commandId,
              origin,
              draft: original,
              caption,
              sourceDraft,
              actions,
              entryId,
              attachments: queuedAttachments,
              queued: busy && plan.optimisticKind === "follow_up",
              status: "pending",
            };
            pendingSends.set(commandId, recovery);
          });
        } catch (error) {
          if (recovery) {
            if (error instanceof DispatchFailure && error.status === "not_sent") {
              refuseSend(recovery, error.reason);
              return;
            }
            recovery.status = "unknown";
            recovery.reason = String(error);
            refreshSendRecovery((revision) => revision + 1);
            const next = settleRefusedSend(chatRef.current, recovery.entryId, caption, true);
            chatRef.current = next;
            setChat(next);
          }
          throw error;
        }
        if (recovery?.status === "refused") return;
        if (busy && plan.optimisticKind === "follow_up" && recovery?.status !== "consumed" && recovery?.status !== "settled") {
          const nextQueue = [...queuedFollowUpsRef.current, { text: caption, attachments: queuedAttachments, dispatchId: recovery?.commandId, entryId: recovery?.entryId }];
          queuedFollowUpsRef.current = nextQueue;
          onQueuedFollowUpsChange?.(nextQueue);
        }
        if (origin !== "nudge" && messageDraftRef.current === sourceDraft) updateMessageDraft({ body: "", pendingActions: [], attachments: [] });
      }
    } catch (error) {
      toast.error(String(error));
      setMessageError(String(error));
    } finally {
      setMessageSending(false);
    }
  };

  const sendNow = async (nudge = false) => {
    const sourceDraft = messageDraftRef.current;
    const draftBody = sourceDraft.body.trim();
    const draftAttachments = messageDraftRef.current.attachments ?? [];
    const usingDraft = !nudge && (draftBody.length > 0 || draftAttachments.length > 0);
    const queued = nudge ? undefined : latestQueuedFollowUp(queuedFollowUpsRef.current);
    const caption = nudge ? WRAP_UP_MESSAGE : usingDraft ? draftBody : (queued?.text ?? "");
    const attachments = nudge ? [] : usingDraft ? draftAttachments : (queued?.attachments ?? []);
    if (messageSending || (caption.length === 0 && attachments.length === 0)) return;
    const transport = observation?.transport;
    if (transport !== "rpc") {
      setMessageError("The session is still connecting.");
      return;
    }
    setMessageSending(true);
    setMessageError("");
    try {
      let message = caption;
      let images: ImageContent[] | undefined;
      let pendingAttachments = attachments;
      if (attachments.length > 0) {
        const prepared = await prepareChatSend(taskSlug, repoPath, caption, attachments);
        message = prepared.message;
        images = prepared.images;
        pendingAttachments = prepared.copied;
        refreshAttachmentArtifacts();
      }
      if (!nudge && !usingDraft && !queued?.dispatchId) {
        setMessageError("This queued input has no dispatch identity. It remains queued; Send now cannot safely transfer it.");
        return;
      }
      const command = { ...abortAndPromptCommand(message, undefined, images), ...(!nudge && !usingDraft ? { transfer_dispatch_id: queued?.dispatchId } : {}) };
      invalidateReview();
      const rowAttachments = draftToRowAttachments(attachments);
      const next = appendOptimisticUser(chatRef.current, caption, "prompt", undefined, rowAttachments.length > 0 ? rowAttachments : undefined);
      const entryId = `dispatch:${command.id}`;
      const last = next.entries[next.entries.length - 1];
      if (last) last.id = entryId;
      chatRef.current = next;
      setChat(next);
      const recovery: SessionSendRecovery = {
        commandId: command.id,
        origin: nudge ? "nudge" : undefined,
        draft: usingDraft ? sourceDraft.body : caption,
        caption,
        sourceDraft,
        actions: usingDraft ? sourceDraft.pendingActions : [],
        entryId,
        attachments: pendingAttachments,
        status: "pending",
        transferDispatchId: usingDraft ? undefined : queued?.dispatchId,
      };
      pendingSends.set(command.id, recovery);
      try {
        await writeRpc(command);
      } catch (error) {
        if (error instanceof DispatchFailure && error.status === "not_sent") {
          refuseSend(recovery, error.reason);
          return;
        }
        recovery.status = "unknown";
        recovery.reason = String(error);
        refreshSendRecovery((revision) => revision + 1);
        const restored = settleRefusedSend(chatRef.current, recovery.entryId, caption, true);
        chatRef.current = restored;
        setChat(restored);
        throw error;
      }
      if (recovery.status === "refused") return;
      if (usingDraft) {
        if (messageDraftRef.current === sourceDraft) updateMessageDraft({ body: "", pendingActions: [], attachments: [] });
      }
    } catch (error) {
      toast.error(String(error));
      setMessageError(String(error));
    } finally {
      setMessageSending(false);
    }
  };

  const contextActions: ContextAction[] = [
    ...(canSendCommentsToSession
      ? [
          {
            key: "add-comments",
            label: commentSendStatus ? "Comments added" : "Add comments",
            title: commentSendTitle,
            disabled: messageSending,
            busy: commentSendBusy,
            tone: commentSendStatus ? ("ok" as const) : ("normal" as const),
            badge: commentSendBadge,
            onClick: addCommentsToDraft,
          },
        ]
      : []),

    ...(effectivePlaybook === "review" && latestReviewFindings
      ? [
          {
            key: "add-approve-pr",
            label: approvalStatus ? "Approval prompt added" : "Add approval prompt",
            title: approvalStatus || "Add an editable request for the harness to submit the GitHub approval/comment",
            disabled: messageSending,
            busy: approvalBusy,
            tone: approvalStatus ? ("ok" as const) : ("normal" as const),
            onClick: addApprovalPrompt,
          },
          {
            key: "send-findings",
            label: commentsNewerThanFindings ? "Send findings — pending comments" : "Send findings to task",
            title: commentsNewerThanFindings
              ? "Active comments were added after the findings artifact and may not be included in this handoff"
              : "Choose an existing task to receive these review findings",
            icon: commentsNewerThanFindings ? ("warning" as const) : undefined,
            tone: "normal" as const,
            onClick: () =>
              onStartReviewHandoff({
                source_repo_path: repoPath,
                source_slug: taskSlug,
                source_session: id,
                source_artifact: latestReviewFindings.name,
              }),
          },
        ]
      : []),
  ];

  // Pick the terminal intent from the classification (or the explicit navigation intent); a
  // null intent + non-null lifecycle means an orphaned/interrupted/exited row -> action panel.
  // explicitIntent is true only for spawn|resume (see above), so no non-null assert needed.
  const termIntent: "attach" | "spawn" | "resume" | null =
    leftover || intent === "history"
      ? null
      : explicitIntent
        ? intent === "spawn" || intent === "resume"
          ? intent
          : null
        : effectiveLifecycle === null
          ? null
          : effectiveLifecycle.state === "live" || effectiveLifecycle.state === "live_exited"
            ? "attach"
            : effectiveLifecycle.state === "never_started" && !hasTask
              ? "spawn"
              : null;
  const navHistory = intent === "history";
  const showPanel = leftover ? !navHistory && effectiveLifecycle !== null : !explicitIntent && effectiveLifecycle !== null && termIntent === null;
  const composerEligible = shouldShowChatComposer({
    hasWritableTerminal: Boolean(termIntent),
    history: navHistory,
    actionPanel: showPanel,
    utilityTerminal: !hasTask,
    harness,
  });
  const liveRpc = observation?.transport === "rpc";
  // Exited RPC sessions still support replay, but their processes cannot accept commands.
  const rpcProcessLive = liveRpc && observation?.lifecycle.state === "live" && observation.state?.process.state === "alive";
  const livePty = observation?.transport === "pty";
  const ompCoding = harness === "omp" && !leftover && !navHistory && !showPanel;
  const showChat = ompCoding && Boolean(termIntent) && !livePty;
  const showPtyTerminal = Boolean(termIntent) && !showChat;
  const showHatch = ompCoding && observation?.lifecycle.state === "live" && (liveRpc || livePty);
  const showChatComposer = showChat && composerEligible;
  useEffect(() => {
    if (!showChat || termIntent !== "spawn" || observation?.transport) return;
    if (ompStartRef.current === id) return;
    ompStartRef.current = id;
    void ipc
      .startSession(taskSlug, id, repoPath)
      .then(() => ipc.sessionStatus(id, taskSlug || null))
      .then((next) => setObservation(next))
      .catch((error) => {
        setTerminalConnection("failed");
        toast(String(error), "error");
      });
  }, [showChat, termIntent, observation?.transport, id, taskSlug, repoPath, cwd, resumeToken]);

  // Fresh OMP starts as RPC. If Settings prefers Terminal, restate once after the session is live.
  useEffect(() => {
    if (!ompCoding || observation?.lifecycle.state !== "live") return;
    if (termIntent !== "spawn" && termIntent !== "resume") return;
    if (!observation.transport || preferredViewAppliedRef.current === id) return;
    const want = appearance.session_default_view === "terminal" ? "pty" : "rpc";
    preferredViewAppliedRef.current = id;
    if (observation.transport === want) return;
    setViewBusy(true);
    void ipc
      .restateSession(id, want)
      .then(() => ipc.sessionStatus(id, taskSlug || null))
      .then((next) => {
        setObservation(next);
      })
      .catch((error) => toast(String(error), "error"))
      .finally(() => setViewBusy(false));
  }, [ompCoding, observation?.lifecycle.state, observation?.transport, termIntent, id, taskSlug, appearance.session_default_view]);

  // The journal owns committed history. It is read straight off disk, so it works for a dead
  // session with no daemon, it survives a busy OMP that refuses RPC history, and it still holds
  // the turns compaction dropped from OMP's context.
  const loadOmpPage = useCallback(
    async (position: "initial" | "older", end?: number) => {
      const buffer = await ipc.readSessionOmp({ id, taskSlug: taskSlug || null, end: end ?? null });
      const page = decodeOmpPage(buffer);
      setChat((current) => applyFilePage(current, page, position));
      return page;
    },
    [id, taskSlug],
  );

  // One seed per session, shared by both callers: the effect below (which covers a dead session,
  // where no attach ever happens) and the RPC attach, which must not open the socket until the
  // page has landed. Holding the promise rather than a boolean is what makes that ordering real —
  // a flag would let the attach skip ahead of a load that is still in flight.
  const seedOmpJournal = useCallback(() => {
    if (ompSeedRef.current?.id === id) return ompSeedRef.current.done;
    const done = loadOmpPage("initial").catch(() => undefined);
    ompSeedRef.current = { id, done };
    return done;
  }, [id, loadOmpPage]);

  useEffect(() => {
    if (harness !== "omp") return;
    void seedOmpJournal();
  }, [harness, seedOmpJournal]);

  const olderBusy = useRef(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadOlder = useCallback(() => {
    const from = chatRef.current.fileStart;
    if (olderBusy.current || from == null || from === 0) return;
    olderBusy.current = true;
    setLoadingOlder(true);
    void loadOmpPage("older", from)
      .catch(() => undefined)
      .finally(() => {
        olderBusy.current = false;
        setLoadingOlder(false);
      });
  }, [loadOmpPage]);

  useEffect(() => {
    if (!liveRpc) return;
    let cancelled = false;
    const attachId = ipc.nextAttachId();
    // Live stream closed mid-turn (see `ipc.onStreamClosed`): reattach while still live in RPC.
    const stopClosed = ipc.onStreamClosed(
      id,
      attachId,
      () => {
        ipc.sessionStatus(id, taskSlug || null).then(
          (next) => {
            if (!cancelled && next.transport === "rpc" && next.lifecycle.state === "live") setChatAttachEpoch((epoch) => epoch + 1);
          },
          // Unreadable status: reattach anyway; the attach itself reports a dead session.
          () => {
            if (!cancelled) setChatAttachEpoch((epoch) => epoch + 1);
          },
        );
      },
      () => {
        if (!cancelled) setTerminalConnection("failed");
      },
    );
    // The session-id effect already clears the transcript on a real session change. Do not
    // emptyTranscript() here: a liveRpc flap would wipe visible history. The poll catch above
    // keeps the last observation so a transient error does not re-enter; a later successful
    // poll after a failure bumps chatAttachEpoch to re-attach without clearing entries.

    setTerminalConnection("opening");
    const apply = (line: string) => {
      if (cancelled) return;
      try {
        const value: unknown = JSON.parse(line);
        if (
          value &&
          typeof value === "object" &&
          "id" in value &&
          typeof value.id === "string" &&
          value.id === compactionStateRequestRef.current &&
          "type" in value &&
          value.type === "response" &&
          "command" in value &&
          value.command === "get_state"
        ) {
          compactionStateRequestRef.current = null;
          if (
            "success" in value &&
            value.success === true &&
            "data" in value &&
            value.data &&
            typeof value.data === "object" &&
            "autoCompactionEnabled" in value.data &&
            typeof value.data.autoCompactionEnabled === "boolean" &&
            value.data.autoCompactionEnabled !== chatAutoCompactionRef.current
          ) {
            void writeRpc(setAutoCompactionCommand(chatAutoCompactionRef.current)).catch((error) => toast(String(error), "error"));
          }
        }
        const native =
          typeof value === "object" &&
          value !== null &&
          "type" in value &&
          value.type === "alinery_dispatch" &&
          "dispatch_id" in value &&
          typeof value.dispatch_id === "string" &&
          "status" in value
            ? value
            : undefined;
        const responseId = native?.dispatch_id ?? (typeof value === "object" && value !== null && "id" in value && typeof value.id === "string" ? value.id : undefined);
        const pending = typeof responseId === "string" ? pendingSendsRef.current.get(responseId) : undefined;
        if (native && (native.status === "consumed" || native.status === "settled")) {
          if (pending) pending.status = native.status;
          const transferId = native.status === "consumed" ? pending?.transferDispatchId : undefined;
          const consumed = queuedFollowUpsRef.current.filter((item) => item.dispatchId === native.dispatch_id || (transferId !== undefined && item.dispatchId === transferId));
          const rowIds = new Set(consumed.map((item) => item.entryId));
          if (pending) rowIds.add(pending.entryId);
          const remaining = queuedFollowUpsRef.current.filter((item) => !consumed.includes(item));
          queuedFollowUpsRef.current = remaining;
          onQueuedFollowUpsChange?.(remaining);
          setChat((current) => {
            const next = { ...current, entries: current.entries.filter((entry) => !rowIds.has(entry.id)) };
            chatRef.current = next;
            return next;
          });
          if (native.status === "settled" && pending) {
            const finish = async () => {
              if (pending.actions.length > 0) {
                await ipc.finalizeSessionMessageActions(id, taskSlug, pending.actions);
                await refreshFinalizedActions(pending.actions);
              }
              pendingSendsRef.current.delete(pending.commandId);
              releaseUnusedPreviews(pending.attachments);
              refreshSendRecovery((revision) => revision + 1);
            };
            void finish().catch((error) => {
              pending.reason = `Message settled, but its metadata could not be finalized: ${String(error)}`;
              setMessageError(pending.reason);
            });
          }
          return;
        }
        const response = typeof value === "object" && value !== null && "type" in value && value.type === "response" && "success" in value ? value : undefined;
        const consumed = pending?.status === "consumed" || pending?.status === "settled";
        const refused =
          pending && !consumed && native?.status === "rejected" ? ("reason" in native && typeof native.reason === "string" ? native.reason : "Send was refused.") : null;
        const uncertainFailure = Boolean(pending && !consumed && response?.success === false);
        if (refused !== null && pending) {
          refuseSend(pending, refused);
          toast.error(refused);
        } else {
          if (uncertainFailure && pending) {
            // A native command can fail after accepting its input. Only the
            // authenticated rejected disposition establishes that it was not sent.
            pending.status = "unknown";
            pending.reason = response && "error" in response && typeof response.error === "string" ? response.error : "Native command failed";
            refreshSendRecovery((revision) => revision + 1);
          }
          if (pending?.status === "pending" && response?.success === true) {
            // Stock RPC acknowledges scheduling before prompt completion; a later
            // error can carry this same ID. Keep recovery until actual settlement.
            pending.status = "acknowledged";
          }
          setChat((current) => {
            // Protected sends retire by dispatch ID; a native echo is never identified by its caption.
            const next = applyRpcLine(current, value, false);
            if (uncertainFailure && pending) next.entries = next.entries.filter((entry) => entry.id !== pending.entryId);
            chatRef.current = next;
            return next;
          });
          const rec = value as { type?: string; success?: boolean; command?: string };
          if (
            rpcProcessLive &&
            ((rec.type === "response" && rec.success === true && (rec.command === "follow_up" || rec.command === "abort_and_prompt")) ||
              rec.type === "turn_end" ||
              rec.type === "agent_end")
          ) {
            void writeRpc(getStateCommand()).catch(() => undefined);
          }
        }
        if (mcpListWaitRef.current) {
          const listed = commandOutputText(value);
          if (listed !== null) {
            mcpListWaitRef.current = false;
            const parsed = parseMcpListOutput(listed);
            setMcpDialog(parsed === "empty" ? { rows: [], empty: true } : { rows: parsed, empty: false });
          }
        }
        if (modelApplyRef.current) {
          const reply = setModelReply(value);
          if (reply) {
            modelApplyRef.current = false;
            if (reply.ok) {
              setModelDialog(null);
              setModelError(null);
            } else {
              setModelError(reply.error ?? "Could not set model.");
            }
          }
        }
        if (loginApplyRef.current) {
          const reply = loginReply(value);
          if (reply) {
            const providerId = loginApplyRef.current;
            loginApplyRef.current = null;
            loginOpenUrlRef.current = null;
            setLoginBusy(null);
            if (reply.ok) {
              setModelError(null);
              void writeRpc(getLoginProvidersCommand()).catch(() => undefined);
              void writeRpc(getAvailableModelsCommand()).catch(() => undefined);
            } else if (isInteractivePromptLoginError(reply.error)) {
              setLivePromotedIds((prev) => (prev.includes(providerId) ? prev : [...prev, providerId]));
              setModelError(reply.error ?? "This provider needs Terminal /login.");
            } else {
              setModelError(reply.error ?? "Login failed.");
            }
          }
        }
      } catch {
        /* ignore non-JSON */
      }
    };
    // A reattach (dropped stream, back from Terminal) rebuilds from a fresh journal read, as chat does.
    // The first seed is stale by then: turns that closed while detached are in neither it nor the
    // replay, and a turn left open in the old transcript reads Running forever.
    const reattach = rpcAttachedRef.current === id;
    rpcAttachedRef.current = id;
    const journal = reattach
      ? readJournalThrough((end, want) => ipc.readSessionOmp({ id, taskSlug: taskSlug || null, end: end ?? null, want }), chatRef.current.fileStart)
          .then((built) => {
            if (cancelled) return;
            setChat((current) => {
              const next = carryOver(current, built);
              chatRef.current = next;
              return next;
            });
          })
          .catch(() => undefined)
      : seedOmpJournal();
    void journal
      .then(() => {
        if (cancelled) return;
        const missing = queuedFollowUpsRef.current.filter((item) => !item.entryId || !chatRef.current.entries.some((entry) => entry.id === item.entryId));
        if (missing.length > 0) {
          let next = chatRef.current;
          const rebuilt = queuedFollowUpsRef.current.map((item) => {
            if (!missing.includes(item)) return item;
            next = appendOptimisticUser(next, item.text, "follow_up", undefined, draftToRowAttachments(item.attachments));
            const entryId = next.entries[next.entries.length - 1]?.id;
            const recovery = item.dispatchId ? pendingSendsRef.current.get(item.dispatchId) : undefined;
            if (recovery && entryId) recovery.entryId = entryId;
            return { ...item, entryId };
          });
          queuedFollowUpsRef.current = rebuilt;
          onQueuedFollowUpsChange?.(rebuilt);
          chatRef.current = next;
          setChat(next);
        }
        // A detach sent before this attach lands is lost, so detach again once it has, as chat does.
        return ipc.rpcAttachSession({ id, attachId, streamToken: attachId, onLine: apply }).then(() => {
          if (cancelled) void ipc.detachSession(id, attachId).catch(() => undefined);
        });
      })

      .then(async () => {
        if (cancelled) return;
        setTerminalConnection("open");
        if (!rpcProcessLive) return;
        // No wait for `ready`: OMP emits it once at spawn, so on any established session the old
        // 2s deadline always expired in full and told us nothing. History no longer depends on it
        // either — it was read from the journal before this attach began.
        await writeRpc(negotiateProtocolCommand());
        if (cancelled) return;
        await writeRpc(getAvailableCommandsCommand());
        if (cancelled) return;
        const stateRequest = getStateCommand();
        compactionStateRequestRef.current = stateRequest.id;
        await writeRpc(stateRequest);
        if (cancelled) return;
        await writeRpc(setSubagentSubscriptionCommand("events"));
        if (cancelled) return;
        await writeRpc(getSubagentsCommand());
        if (cancelled) return;
        await writeRpc(getLoginProvidersCommand());

        if (cancelled) return;
        await writeRpc(getAvailableModelsCommand());
        void ipc.readOmpModelRoles().then((roles) => {
          if (!cancelled) setModelRoles(roles);
        });
      })
      .catch(async (error) => {
        if (cancelled) return;
        try {
          const next = await ipc.sessionStatus(id, taskSlug || null);
          if (cancelled) return;
          setObservation(next);
          if (next.lifecycle.state === "live_exited" || next.lifecycle.state === "exited" || next.state?.process.state === "exited") return;
        } catch {
          // Without a confirmed exit, preserve the original connection error.
        }
        if (!cancelled) {
          setTerminalConnection("failed");
          toast(String(error), "error");
        }
      });
    return () => {
      cancelled = true;
      stopClosed();
      void ipc.detachSession(id, attachId);
    };
  }, [liveRpc, rpcProcessLive, id, taskSlug, seedOmpJournal, chatAttachEpoch]);
  useEffect(() => {
    if (!rpcProcessLive) return;
    // A viewer must not invalidate Ready merely by reapplying an unchanged preference.
    const stateRequest = getStateCommand();
    compactionStateRequestRef.current = stateRequest.id;
    void writeRpc(stateRequest).catch(() => undefined);
  }, [chatAutoCompaction, rpcProcessLive, id]);
  const settleOpenUrl = async (requestId: string, raw: string | undefined) => {
    try {
      await settleBrowserUrl(id, requestId, raw, (error) => toast(error, "error"));
      setChat((current) => dismissPendingUi(current, requestId));
    } catch (error) {
      toast(String(error), "error");
    }
  };
  useEffect(() => {
    if (!rpcProcessLive) return;
    for (const request of chat.pendingUi) {
      if (handledUiRef.current.has(request.id)) continue;
      if (isPresentationUi(request.method)) {
        handledUiRef.current.add(request.id);
        void writeRpc(cancelExtensionUi(request.id)).catch(() => undefined);
        continue;
      }
      // Clicking "Sign in" IS the consent for the link that click produces: OMP answers `login`
      // with the loopback `open_url`, and its approval row would render behind the accounts
      // dialog, which is `showModal()` — inert, so the button cannot be clicked and the login
      // dead-ends. Consuming the ref keeps that to the first link after a login the user started;
      // anything unsolicited still has to be approved.
      if (request.method === "open_url" && loginOpenUrlRef.current) {
        loginOpenUrlRef.current = null;
        handledUiRef.current.add(request.id);
        void settleOpenUrl(request.id, request.launchUrl || request.url);
      }
    }
  }, [rpcProcessLive, chat.pendingUi, id]);
  useEffect(() => {
    let cancelled = false;
    void ipc
      .hostedCatalog()
      .then((view) => {
        if (!cancelled) setHosted(view);
      })
      .catch(() => {
        if (!cancelled) setHosted(null);
      })
      .finally(() => {
        if (!cancelled) setHostedLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    // `get_login_providers` goes out on every attach, including a re-attach to a session that is
    // mid-turn, so `busy` is what keeps the dialog off a running agent. It returns without arming
    // the ref, so the effect re-runs when the turn closes and offers setup then.
    if (!hostedLoaded) return;
    const offer = shouldOfferProviderSetup({
      connected: rpcProcessLive,
      suppressed: setupOpenedRef.current || modelDialog !== null,
      busy: isTurnActive({
        pendingTurn: chat.pendingTurn,
        turnOpen: chat.turnOpen,
        observation,
      }),
      providers: chat.sessionMeta.loginProviders ?? [],
      models: chat.sessionMeta.models ?? [],
      currentModel: chat.sessionMeta.model,
      hostedReady: hosted?.ready === true,
    });
    if (!offer) return;
    setupOpenedRef.current = true;
    setModelError(null);
    setModelDialog({ tab: "accounts", preselect: "", setup: true });
  }, [
    rpcProcessLive,
    chat.sessionMeta.loginProviders,
    chat.sessionMeta.model,
    chat.sessionMeta.models,
    chat.pendingTurn,
    chat.turnOpen,
    observation,
    modelDialog,
    hosted,
    hostedLoaded,
  ]);
  const observedState = observation?.state;
  const messageReadiness = {
    connection: terminalConnection,
    lifecycle: effectiveLifecycle ?? { state: "orphaned" as const },
    process: observedState?.process ?? null,
    agent: observedState?.agent ?? null,
    messageAdapter: observedState?.message_adapter ?? ("unsupported" as const),
    body: messageDraft.body,
    composing: messageComposing,
    sending: messageSending,
    interrupting: messageInterrupting,
  };
  // Chat is the only surface that reaches this now, so it is RPC-only. A live PTY aborts through
  // switchTransport's OMP_INTERRUPT_DATA write instead.
  const interruptCurrentSession = async () => {
    if (!liveRpc || !canAbortChatSession(messageReadiness)) return;
    setMessageInterrupting(true);
    setMessageError("");
    try {
      setChat((current) => appendOptimisticAbort(current));
      await writeRpc(abortCommand());
    } catch (error) {
      setMessageError(`Couldn't interrupt the session: ${String(error)}`);
    } finally {
      setMessageInterrupting(false);
    }
  };
  const switchTransport = async (target: "pty" | "rpc"): Promise<boolean> => {
    if (observation?.transport === target) return true;
    if (viewBusy) return false;
    // Same predicate as send routing: a pending or open turn must warn even when the 1.5s
    // observation poll still reports idle.
    const active = isTurnActive({
      pendingTurn: chatRef.current.pendingTurn,
      turnOpen: chatRef.current.turnOpen,
      observation,
    });
    if (active) {
      if (!(await confirmStopAndSwitch(target))) return false;
      try {
        if (liveRpc) await writeRpc(abortCommand());
        else await writeRaw(OMP_INTERRUPT_DATA);
      } catch (error) {
        toast(String(error), "error");
        return false;
      }
    }
    setViewBusy(true);
    try {
      await ipc.restateSession(id, target);
      await ipc.sessionStatus(id, taskSlug || null).then((next) => setObservation(next));
      return true;
    } catch (error) {
      toast(String(error), "error");
      return false;
    } finally {
      setViewBusy(false);
    }
  };

  const pendingUiReply = chat.pendingUi.some((request) => needsUiReply(request.method));
  const chatVisibility = useMemo(() => chatVisibilityFromAppearance(appearance), [appearance]);
  const chatEntries = chat.entries;
  const capability = execution ? executionView?.continuation[execution.id] : undefined;
  const executionAssessment = execution ? executionView?.executions[execution.id] : undefined;
  const destinations = executionAssessment?.destinations ?? [];
  const continuationName = destinations.length === 1 ? `Continue to ${destinations[0].title}` : "Continue playbook";
  const playbookComplete = !executionError && executionView?.assessment.status === "complete";
  const requestedHere = requestedContinuation?.id === execution?.id && requestedContinuation?.revision === execution?.ready_revision;
  const invalidatedHere = invalidatedReady?.id === execution?.id && invalidatedReady?.revision === execution?.ready_revision;
  const continuationPending = requestedHere || execution?.continuation_requested_revision != null || !!execution?.receipt_id || endAccepted;
  const readinessBlocker =
    (executionError ? "Execution state is unavailable; see the warning above." : "") ||
    (!executionAvailable ? "Continuation unavailable: the execution owner cannot be queried." : "") ||
    (playbookComplete ? "The playbook is complete." : "") ||
    (execution?.owner_session_id !== id ? "This session is no longer the execution owner." : "") ||
    (endAccepted || execution?.receipt_id ? "Handoff accepted; waiting for the session to exit." : "") ||
    (!capability?.available ? `Continuation unavailable: ${capability?.reason ?? "the native continuation boundary is not available."}` : "") ||
    (capability?.reason ? "Waiting for native work or submitted input to settle." : "") ||
    (navHistory || !liveRpc || terminalConnection !== "open" ? "Reconnect to the live session to continue." : "") ||
    (execution?.lifecycle !== "running" ? "Waiting for the accepted handoff and session exit." : "") ||
    (pendingUiReply ? "Resolve the pending approval or question before continuing." : "") ||
    (continuationPending ? "Continuation requested; waiting for the handoff." : "") ||
    (completionBusy ? "A session action is in progress." : "") ||
    (invalidatedHere || messageSending || execution?.ready_revision == null ? "Waiting for renewed readiness after review." : "");
  const terminalReviewReady = !readinessBlocker && executionAssessment?.terminality === "terminal";
  const continuationReason =
    readinessBlocker ||
    (executionAssessment?.terminality === "terminal" ? "This endpoint stays open for review and follow-up messages." : "") ||
    (automaticContinuation ? "Automatic continuation is enabled; this step advances after validated readiness." : "") ||
    (executionAssessment?.terminality !== "nonterminal" ? "Waiting for an authoritative continuation assessment." : "");
  const controlsShown = Boolean(execution) && hasTask && harness === "omp";
  const controlBlocker =
    (playbookComplete ? "The playbook is complete." : "") ||
    (!executionAvailable ? "Execution state is unavailable." : "") ||
    (execution?.owner_session_id !== id ? "This session is no longer the execution owner." : "") ||
    (navHistory || execution?.lifecycle !== "running" ? "This session is not running." : "") ||
    (continuationPending ? "A handoff has already been requested." : "") ||
    (completionBusy ? "A session action is in progress." : "");
  const modeBlocker = controlBlocker || (modeChanging ? "Updating continuation mode." : "");
  const pendingSendItems = [...pendingSends.values()];
  const visibleSendRecovery = pendingSendItems.filter((item) => item.status === "refused" || item.status === "unknown");
  const pendingNudge = pendingSendItems.find((pending) => pending.origin === "nudge" && pending.status !== "refused" && pending.status !== "settled");
  const nudgeBlocker =
    controlBlocker ||
    (!liveRpc || terminalConnection !== "open" ? "Reconnect to the live chat session to nudge." : "") ||
    (pendingUiReply || observedState?.agent?.state === "waiting_for_approval" || observedState?.agent?.state === "waiting_for_input"
      ? "Resolve the pending approval or question first."
      : "") ||
    (pendingNudge ? (pendingNudge.status === "unknown" ? "Nudge delivery is unknown; check the session before resending." : "Waiting for the previous nudge to finish.") : "") ||
    (messageSending ? "A message is being sent." : "");
  const setContinuationMode = async (automatic: boolean) => {
    if (!execution || modeBlocker || modeChangingRef.current || automatic === automaticContinuation) return;
    if (!automatic && executionView?.state.auto_approve_all) return;
    const epoch = executionEpoch.current;
    modeChangingRef.current = true;
    setModeChanging(true);
    setContinuationMessage("");
    try {
      await ipc.setStepContinuationForRepo(repoPath, taskSlug, execution.candidate.step_key, automatic);
      if (epoch !== executionEpoch.current) return;
      const next = await readTaskExecution(repoPath, taskSlug);
      if (epoch === executionEpoch.current) {
        setExecutionView(next);
        setExecutionError("");
      }
    } catch (error) {
      if (epoch === executionEpoch.current) setContinuationMessage(`Could not update continuation mode: ${String(error)}`);
    } finally {
      if (epoch === executionEpoch.current) {
        modeChangingRef.current = false;
        setModeChanging(false);
      }
    }
  };
  const continueReadyExecution = async () => {
    if (continuationInFlight.current || continuationReason || !execution || !capability || execution.ready_revision == null) return;
    const epoch = executionEpoch.current;
    const request = {
      task_slug: taskSlug,
      execution_id: execution.id,
      session_id: id,
      process_incarnation: capability.process_incarnation,
      ready_revision: execution.ready_revision,
    };
    continuationInFlight.current = true;
    setCompletionBusy(true);
    setRequestedContinuation({ id: execution.id, revision: execution.ready_revision });
    setContinuationMessage("");
    try {
      try {
        const outcome = await ipc.continueExecution(request, repoPath);
        if (epoch !== executionEpoch.current) return;
        if (outcome.status !== "requested" && outcome.status !== "accepted") {
          setRequestedContinuation(null);
        }
        if (outcome.status === "invalid_outputs") setContinuationMessage(outcome.diagnostics.join("\n"));
        else if ("reason" in outcome) setContinuationMessage(outcome.reason);
        else if (outcome.status === "accepted") {
          setEndAccepted(true);
          setContinuationMessage("Handoff accepted; waiting for the session to exit.");
        } else if (outcome.status === "requested") setContinuationMessage("Continuation requested; waiting for the handoff.");
      } catch (error) {
        if (epoch !== executionEpoch.current) return;
        setContinuationMessage(`Continuation outcome unavailable: ${String(error)}. Refreshing does not resend the request.`);
        // Authoritative intent or failed observation still disables the action.
        // An unacknowledged local call must not strand a fresh manual retry.
        setRequestedContinuation(null);
      }
      try {
        const next = await readTaskExecution(repoPath, taskSlug);
        if (epoch !== executionEpoch.current) return;
        setExecutionView(next);
        setExecutionError("");
      } catch (refreshError) {
        if (epoch !== executionEpoch.current) return;
        setExecutionError(String(refreshError));
      }
    } finally {
      if (epoch === executionEpoch.current) {
        continuationInFlight.current = false;
        setCompletionBusy(false);
      }
    }
  };
  const unacceptedOwner = execution?.owner_session_id === id && execution.receipt_id == null && execution.lifecycle !== "queued" && !endAccepted;
  const canEnd = unacceptedOwner && executionAvailable && Boolean(continuationReason);
  const canRecover = unacceptedOwner && executionAvailable;
  const canRestart = canRecover && Boolean(onOpenReplacement || onOpenSession);
  const openArtifactEntry = () => {
    if (!canRecover || completionBusy) return;
    artifactAuthorization.current = null;
    setArtifactEntryError("");
    setSessionActionsOpen(false);
    setArtifactEntryOpen(true);
  };
  const refreshHandoff = async (epoch = executionEpoch.current) => {
    try {
      const next = await readTaskExecution(repoPath, taskSlug);
      if (epoch !== executionEpoch.current) return;
      setExecutionView(next);
      setExecutionError("");
      setReclassifyTick((tick) => tick + 1);
    } catch (error) {
      if (epoch === executionEpoch.current) setExecutionError(String(error));
    }
  };
  const endAndContinue = async () => {
    if (continuationInFlight.current || completionBusy || !execution || !canEnd) return;
    const epoch = executionEpoch.current;
    continuationInFlight.current = true;
    setCompletionBusy(true);
    let submitted = false;
    try {
      const prepared = await ipc.prepareEndExecution(taskSlug, execution.id, id, repoPath);
      if (epoch !== executionEpoch.current) return;
      if (prepared.diagnostics.length) {
        setSessionActionsOpen(false);
        setArtifactEntryError("There are no usable saved artifacts to continue with. Add or repair the output for this step.");
        artifactAuthorization.current = null;
        setArtifactEntryOpen(true);
        return;
      }
      if (
        !(await confirmRecovery(
          "End session and continue?",
          <div>
            <p>Stop the agent and use its saved artifacts to continue the playbook. Any work still in progress will be interrupted.</p>
            <h4>Saved artifacts</h4>
            <ul>
              {prepared.artifacts.map((path) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
            </ul>
            <p>The artifacts will be checked again after the session stops. If they cannot be used, the next step will not start.</p>
          </div>,
          "End & continue",
        ))
      )
        return;
      if (epoch !== executionEpoch.current) return;
      submitted = true;
      const outcome = await ipc.endExecution(prepared.request, repoPath);
      if (epoch !== executionEpoch.current) return;
      setSessionActionsOpen(true);
      if (outcome.status === "accepted") {
        setEndAccepted(true);
        setEndMessage("Handoff accepted. Refreshing the Playbook state.");
      } else if (outcome.status === "invalid_outputs") {
        setEndMessage(`Session stopped; handoff not accepted. ${outcome.diagnostics.join("\n")} Repair the assigned artifacts and retry, or replace the stopped session.`);
      } else if ("reason" in outcome) {
        setEndMessage(outcome.reason);
      } else {
        setEndMessage("End-session request acknowledged; refresh to inspect the handoff state.");
      }
    } catch (error) {
      if (epoch !== executionEpoch.current) return;
      setSessionActionsOpen(true);
      setEndMessage(
        submitted
          ? `End-session outcome unavailable: ${String(error)}. Refresh status before deciding whether to retry. Refreshing never resends the request.`
          : `Could not prepare end-session confirmation: ${String(error)}`,
      );
    } finally {
      if (epoch === executionEpoch.current) await refreshHandoff(epoch);
      if (epoch === executionEpoch.current) {
        continuationInFlight.current = false;
        setCompletionBusy(false);
      }
    }
  };
  const recoverSession = async (action: "restart" | "stop") => {
    if (continuationInFlight.current || completionBusy || !execution || !canRecover || (action === "restart" && !canRestart)) return;
    const epoch = executionEpoch.current;
    continuationInFlight.current = true;
    setCompletionBusy(true);
    try {
      const prepared = await ipc.prepareEndExecution(taskSlug, execution.id, id, repoPath);
      if (epoch !== executionEpoch.current) return;
      const restart = action === "restart";
      if (
        !(await confirmRecovery(
          restart ? "Restart this step?" : "End this session?",
          restart ? (
            <>
              <p>
                Stop this agent and start a fresh attempt at the same step with the same inputs. Session history is kept, and existing worktree changes are left in place.
                Restarting does not itself advance the playbook or undo code changes.
              </p>
              <p>
                <strong>Warning:</strong> The restarted agent may overwrite existing artifacts, including downstream artifacts, and worktree files. Previous artifact contents may
                not be recoverable.
              </p>
            </>
          ) : (
            "Stop this agent without starting another session or advancing the playbook. Saved files and session history are kept. Any work still in progress will be interrupted."
          ),
          restart ? "Restart step" : "End session",
        ))
      )
        return;
      if (epoch !== executionEpoch.current) return;
      followContinuation.current = null;
      if (restart) {
        const reply = await ipc.restartExecution(prepared.request, repoPath);
        if (epoch !== executionEpoch.current) return;
        if (reply.errors?.length) toast.error(reply.errors.map((error) => error.message).join("\n"));
        (onOpenReplacement ?? onOpenSession)?.(reply.session);
      } else {
        const result = await ipc.stopExecution(prepared.request, repoPath);
        if (epoch !== executionEpoch.current) return;
        setSessionActionsOpen(true);
        setEndMessage(
          result.shutdown_confirmed ? "Session ended. The playbook has not advanced." : "Waiting for the session to stop. Refresh status before trying another action.",
        );
      }
    } catch (error) {
      if (epoch !== executionEpoch.current) return;
      setSessionActionsOpen(true);
      setEndMessage(`Could not finish this action: ${String(error)}. Refresh status before retrying.`);
    } finally {
      if (epoch === executionEpoch.current) await refreshHandoff(epoch);
      if (epoch === executionEpoch.current) {
        continuationInFlight.current = false;
        setCompletionBusy(false);
      }
    }
  };
  const previewArtifacts = async (artifacts: SuppliedExecutionArtifact[]) => {
    if (!execution || !canRecover || completionBusy) throw new Error("This step is not available for an artifact handoff.");
    const epoch = executionEpoch.current;
    setCompletionBusy(true);
    setArtifactEntryError("");
    artifactAuthorization.current = null;
    try {
      const prepared = await ipc.prepareEndExecution(taskSlug, execution.id, id, repoPath);
      if (epoch !== executionEpoch.current) throw new Error("The selected session changed.");
      const preview = await ipc.previewExecutionArtifacts(prepared.request, artifacts, repoPath);
      if (epoch !== executionEpoch.current) throw new Error("The selected session changed.");
      artifactAuthorization.current = prepared.request;
      return preview;
    } finally {
      if (epoch === executionEpoch.current) setCompletionBusy(false);
    }
  };
  const submitArtifacts = async (artifacts: SuppliedExecutionArtifact[]) => {
    const request = artifactAuthorization.current;
    if (!request || !canRecover || completionBusy || continuationInFlight.current) throw new Error("Check the artifacts again before continuing.");
    const epoch = executionEpoch.current;
    continuationInFlight.current = true;
    setCompletionBusy(true);
    setArtifactEntryError("");
    try {
      if (
        !(await confirmRecovery(
          "Continue with these artifacts?",
          <div>
            <p>
              Stop this session and use the artifacts below to continue the playbook. Existing files at these paths will be replaced. Any work still in progress will be
              interrupted.
            </p>
            <ul>
              {artifacts.map((artifact) => (
                <li key={artifact.relative_path}>
                  <code>{artifact.relative_path}</code>
                </li>
              ))}
            </ul>
            <p>The artifacts will be checked again before the handoff. Session history and worktree changes are kept.</p>
          </div>,
          "End & continue",
        ))
      )
        return;
      if (epoch !== executionEpoch.current) return;
      const outcome = await ipc.submitExecutionArtifacts(request, artifacts, repoPath);
      if (epoch !== executionEpoch.current) return;
      if (outcome.status === "accepted") {
        setEndAccepted(true);
        setArtifactEntryOpen(false);
        setSessionActionsOpen(true);
        setEndMessage("Artifacts accepted. Continuing the playbook.");
      } else {
        throw new Error(
          outcome.status === "invalid_outputs"
            ? outcome.diagnostics.join("\n")
            : "reason" in outcome
              ? outcome.reason
              : "Handoff is not yet accepted. Check the session status before retrying.",
        );
      }
    } catch (error) {
      if (epoch !== executionEpoch.current) return;
      setArtifactEntryError(String(error));
      throw error;
    } finally {
      if (epoch === executionEpoch.current) await refreshHandoff(epoch);
      if (epoch === executionEpoch.current) {
        continuationInFlight.current = false;
        setCompletionBusy(false);
      }
    }
  };
  const continuationStatus = useMemo(
    () =>
      controlsShown && (playbookComplete || terminalReviewReady || continuationMessage) ? (
        <span id="continuation-message" aria-label={playbookComplete ? "Playbook status" : undefined}>
          {playbookComplete ? "Playbook complete" : terminalReviewReady ? "Ready for review" : continuationMessage}
        </span>
      ) : null,
    [controlsShown, playbookComplete, terminalReviewReady, continuationMessage],
  );
  const continuationStatusRunning = continuationStatus ? !playbookComplete && !terminalReviewReady && continuationPending : undefined;
  const continueInComposer = controlsShown && showChatComposer && !continuationReason && messageDraft.body.length === 0;
  const continuationControl =
    controlsShown && !terminalReviewReady ? (
      <span
        className="continuation-control"
        role="group"
        aria-label={continuationReason ? "Unavailable continuation" : undefined}
        aria-describedby={continuationMessage ? "continuation-message" : continuationReason ? "continuation-reason" : undefined}
        tabIndex={continuationReason ? 0 : undefined}
        onFocus={() => setContinuationInfoOpen(true)}
        onBlur={() => setContinuationInfoOpen(false)}
        onMouseEnter={() => setContinuationInfoOpen(true)}
        onMouseLeave={() => setContinuationInfoOpen(false)}
        onClick={() => setContinuationInfoOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setContinuationInfoOpen(false);
        }}
      >
        <button
          className="btn primary"
          type="button"
          aria-label={continuationPending ? "Continuing…" : continuationName}
          disabled={Boolean(continuationReason)}
          aria-describedby={continuationMessage ? "continuation-message" : continuationReason ? "continuation-reason" : undefined}
          onClick={() => void continueReadyExecution()}
        >
          <span className="continuation-label">{continuationPending ? "Continuing…" : continuationName}</span>
        </button>
        <span id="continuation-reason" role="tooltip" hidden={!continuationInfoOpen}>
          <span>{continuationName}</span>
          {continuationReason && continuationReason !== continuationMessage && <span>{continuationReason}</span>}
        </span>
      </span>
    ) : null;
  const continuationArea =
    controlsShown && !terminalReviewReady ? (
      <section className={`session-continuation${continueInComposer ? " continue-in-composer" : ""}`} aria-label="Playbook continuation">
        {!continueInComposer && continuationControl}
        <span title={nudgeBlocker || "Ask the agent to wrap up and report readiness. Sends now, interrupting the current turn if it is working."}>
          <button
            className="btn small"
            type="button"
            disabled={Boolean(nudgeBlocker)}
            onClick={() => {
              if (!nudgeBlocker) void sendCurrentMessage(WRAP_UP_MESSAGE, "nudge");
            }}
          >
            Nudge to wrap up
          </button>
        </span>
        <fieldset className="continuation-modes" aria-label="Session continuation controls">
          <button
            type="button"
            className="btn icon"
            aria-label="Wait for me"
            aria-pressed={!automaticContinuation}
            disabled={Boolean(modeBlocker) || executionView?.state.auto_approve_all === true}
            title={
              modeBlocker ||
              (executionView?.state.auto_approve_all
                ? "Auto Approval All is enabled for this task. Turn it off in Task Detail to wait for this step."
                : "Wait for me — this step in this task, including future iterations.")
            }
            onClick={() => void setContinuationMode(false)}
          >
            <Hand size={16} />
          </button>
          <button
            type="button"
            className="btn icon"
            aria-label="Continue automatically"
            aria-pressed={automaticContinuation}
            disabled={Boolean(modeBlocker)}
            title={modeBlocker || "Continue automatically — this step in this task, including future iterations. Advances after validation; a final step finishes the playbook."}
            onClick={() => void setContinuationMode(true)}
          >
            <FastForward size={16} />
          </button>
          <button
            type="button"
            className="btn icon"
            aria-label="Follow next session"
            aria-pressed={followEnabled}
            disabled={!onOpenSession}
            title={
              followEnabled
                ? "Follow next session: on. When this step finishes and a single successor starts, open it and keep following, in either continuation mode. Browsing another session pauses following. Click to stay here."
                : "Follow next session: off. Stay on this session while the playbook continues. Click to follow its single started successor and keep following. This does not change continuation permissions."
            }
            onClick={() => {
              followContinuation.current = !followEnabled && execution?.owner_session_id === id ? execution.id : null;
              followNavigation.current = null;
              setFollowEnabled(!followEnabled);
            }}
          >
            {followEnabled ? <Eye size={16} /> : <EyeOff size={16} />}
          </button>
        </fieldset>
        {showPtyTerminal && !navHistory && !showPanel && continuationStatus && <span role="status">{continuationStatus}</span>}
      </section>
    ) : null;
  const turnActive = isTurnActive({
    pendingTurn: chat.pendingTurn,
    turnOpen: chat.turnOpen,
    observation,
  });
  const chatStatus: SessionChatStatus = chat.sessionMeta.isCompacting || pendingUiReply ? "waiting_approval" : turnActive ? "running" : "idle";
  const agentState = observedState?.agent?.state;
  const composerCanAbort = canAbortChatSession(messageReadiness) && agentState !== "waiting_for_approval";
  const sendNowEnabled =
    turnActive &&
    agentState !== "waiting_for_input" &&
    agentState !== "waiting_for_approval" &&
    !chat.sessionMeta.isCompacting &&
    !pendingUiReply &&
    (messageDraft.body.trim().length > 0 || (messageDraft.attachments?.length ?? 0) > 0 || latestQueuedFollowUp(queuedFollowUps) !== undefined);
  const uiPrompt = chat.pendingUi.find((request) => request.method === "select" || request.method === "input" || request.method === "editor");
  const queuedMeta = chat.sessionMeta.queuedMessageCount ?? queuedFollowUps.length;
  const chatMetaHead = chat.sessionMeta.model || model;
  const chatMetaTail = [
    `${chat.entries.length} event${chat.entries.length === 1 ? "" : "s"}`,
    formatContextUsage(chat.sessionMeta.contextUsage?.tokens, chat.sessionMeta.contextUsage?.contextWindow),
    queuedMeta > 0 ? `${queuedMeta} queued` : "",
  ]
    .filter((part) => part && part.length > 0)
    .join(" · ");
  const pickThinking = (level: string) => {
    void writeRpc(setThinkingLevelCommand(level)).catch((error) => toast(String(error), "error"));
  };

  const replyExtensionValue = async (requestId: string, value: string) => {
    handledUiRef.current.add(requestId);
    invalidateReview();
    try {
      await writeRpc(extensionUiValue(requestId, value));
      setChat((current) => dismissPendingUi(current, requestId));
    } catch (error) {
      handledUiRef.current.delete(requestId);
      toast(String(error), "error");
    }
  };
  const cancelExtensionPrompt = async (requestId: string) => {
    handledUiRef.current.add(requestId);
    try {
      await writeRpc(cancelExtensionUi(requestId));
      setChat((current) => dismissPendingUi(current, requestId));
    } catch (error) {
      handledUiRef.current.delete(requestId);
      toast(String(error), "error");
    }
  };
  const approveChat = async (requestId: string, allow: boolean) => {
    // The row stays mounted across the await, so without this a double-click sends two responses.
    if (handledUiRef.current.has(requestId)) return;
    handledUiRef.current.add(requestId);
    const request = chatRef.current.pendingUi.find((pending) => pending.id === requestId);
    // Allowing an `open_url` means "did it open", not "was it permitted", so it goes through the
    // same settle path the login auto-open uses. Declining is a plain false — nothing is opened.
    if (allow && request?.method === "open_url") {
      await settleOpenUrl(requestId, request.launchUrl || request.url);
      return;
    }
    try {
      invalidateReview();
      await writeRpc(extensionUiConfirm(requestId, allow));
      setChat((current) => dismissPendingUi(current, requestId));
    } catch (error) {
      handledUiRef.current.delete(requestId);
      toast(String(error), "error");
    }
  };
  // approveChat is rebuilt every render, so a useCallback keyed on it would be no more stable
  // than the arrow it replaces. The ref keeps one identity for the life of the component while
  // always calling the current closure — which is what lets memo on ChatPane actually hold.
  const approveChatRef = useRef(approveChat);
  approveChatRef.current = approveChat;
  const onApproveChat = useCallback((requestId: string, allow: boolean) => void approveChatRef.current(requestId, allow), []);

  const applyChatModel = async (provider: string, modelId: string) => {
    setModelError(null);
    modelApplyRef.current = true;
    try {
      await writeRpc(setModelCommand(provider, modelId));
    } catch (error) {
      modelApplyRef.current = false;
      setModelError(String(error));
    }
  };
  const startChatLogin = async (providerId: string) => {
    setModelError(null);
    setLoginBusy(providerId);
    loginApplyRef.current = providerId;
    loginOpenUrlRef.current = providerId;
    try {
      await writeRpc(loginCommand(providerId));
    } catch (error) {
      loginApplyRef.current = null;
      loginOpenUrlRef.current = null;
      setLoginBusy(null);
      setModelError(String(error));
    }
  };
  const hatchTerminalLogin = async (_providerId?: string) => {
    setModelDialog(null);
    setModelError(null);
    setLoginBusy(null);
    loginApplyRef.current = null;
    loginOpenUrlRef.current = null;
    try {
      const switched = await switchTransport("pty");
      if (!switched) return;
      await writeRaw("/login\n");
      toast("Opened Terminal for /login. Finish provider setup there.", "info");
    } catch (error) {
      toast(String(error), "error");
    }
  };
  const assignModelRole = async (role: string, model: string | null) => {
    const next = { ...modelRoles };
    if (model) next[role] = model;
    else delete next[role];
    try {
      const saved = await ipc.writeOmpModelRoles(next);
      setModelRoles(saved);
    } catch (error) {
      setModelError(String(error));
    }
  };

  const finalizedNotice = task ? finalizedSubtaskNotice(task, parentTask) : "";
  const awaitingName = display != null && awaitingSessionName({ ...display.session, harness: display.session.harness || harness }, observation);
  const openStepArtifact = (path: string) => {
    setSelectedArtifactNode(findOwnedArtifactNode(artifactTree, path) ?? null);
    setSelectedArtifact(path);
    setArtifactMode("preview");
    setArtifactErr("");
    setSessionActionsOpen(false);
  };
  const stepArtifactLink = (label: string, path: string) => (
    <button type="button" className="session-action-file" title={path} disabled={!findOwnedArtifactNode(artifactTree, path)} onClick={() => openStepArtifact(path)}>
      {label}
    </button>
  );

  if (artifactEntryOpen && execution) {
    return (
      <ArtifactHandoffPage
        stepTitle={executionStep?.title ?? execution.candidate.step_key}
        outputs={execution.outputs}
        destinations={destinations}
        busy={completionBusy}
        error={artifactEntryError || (!canRecover ? "This step is no longer available for an artifact handoff." : "")}
        onPreview={previewArtifacts}
        onSubmit={submitArtifacts}
        onCancel={() => {
          if (!completionBusy) setArtifactEntryOpen(false);
        }}
      />
    );
  }
  const recoveryContent =
    visibleSendRecovery.length > 0 ? (
      <section className="session-input-recovery" aria-label="Recoverable session input">
        {visibleSendRecovery.map((item) => (
          <div key={item.commandId} role="status">
            <span>
              {item.status === "refused" ? "Not sent" : "Delivery unknown"}: {item.draft}
              {item.reason ? ` — ${item.reason}` : ""}
            </span>
            <CopyTextButton text={item.draft} label="original message" />
            <button
              type="button"
              disabled={!showChatComposer || item.status !== "refused" || messageDraft.body !== "" || messageDraft.attachments.length > 0 || messageDraft.pendingActions.length > 0}
              onClick={() => {
                updateMessageDraft({ body: item.draft, pendingActions: item.actions, attachments: item.attachments });
                pendingSends.delete(item.commandId);
                refreshSendRecovery((revision) => revision + 1);
              }}
            >
              Restore unsent message{item.attachments.length > 0 ? ` (${item.attachments.length} attachments)` : ""}
            </button>
          </div>
        ))}
      </section>
    ) : messageError ? (
      <InlineStatus tone="error">{messageError}</InlineStatus>
    ) : null;
  return (
    <div className="sessionview">
      <div className="sessionhd">
        <button ref={backButtonRef} type="button" className="btn ghost small" onClick={onBack}>
          <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" /> Back
        </button>
        {hasTask && (
          <div className="session-identity">
            <div className="editable-name">
              <span className="editable-name-display" role="group" aria-label="Session name" tabIndex={-1} hidden={editingName}>
                <strong className="editable-name-text" title={display?.session.name || (awaitingName ? "Waiting for session name" : "Unnamed session")}>
                  {display?.session.name || (awaitingName ? <PendingSessionName /> : "Unnamed session")}
                </strong>
                <button ref={nameTrigger} type="button" className="name-edit-button" aria-label="Rename session" title="Rename session" onClick={() => setEditingName(true)}>
                  <Pencil size={14} aria-hidden="true" />
                </button>
              </span>
              {editingName && <NameEditor key={displayScope} value={display?.session.name || ""} label="Session name" onSave={saveName} onCancel={closeNameEditor} />}
            </div>
            <div className="session-context">
              <span className="session-task" title={display?.task_name || task?.name || taskSlug}>
                <span className="session-task-label">Task:</span> {display?.task_name || task?.name || taskSlug}
              </span>
              {task?.parent_task && (
                <button type="button" className="btn ghost small" onClick={() => onOpenRelatedTask(task.parent_task || "", repoPath)}>
                  {parentTask?.name || task.parent_task}
                </button>
              )}
              {display?.session.subtask_manager &&
                (display.session.subtask_slug ? (
                  <button type="button" className="btn ghost small" onClick={() => onOpenRelatedTask(display.session.subtask_slug || "", repoPath)}>
                    {display.subtask_name || display.session.subtask_slug}
                  </button>
                ) : (
                  <span>Sub-task setup</span>
                ))}
            </div>
            {display?.session.name_error && (
              <InlineStatus tone="error" detail={display.session.name_error}>
                Could not read session name.
              </InlineStatus>
            )}
          </div>
        )}
        {(executionStep || phase) && <span className="pill">{executionStep?.title ?? phase}</span>}
        <span className="pill">{harnessDisplayName(harness) + (model ? ` · ${model}` : "")}</span>
        <StatusDot id={id} slug={taskSlug} repoPath={repoPath} observation={observation} />
        <span className="session-path dim mono">
          {id} · {cwd}
        </span>
        {showHatch && (
          <div className="chat-hatch session-view-hatch" role="group" aria-label="Session view">
            <button type="button" className={liveRpc ? "active" : ""} aria-pressed={liveRpc} disabled={viewBusy} onClick={() => void switchTransport("rpc")}>
              Chat
            </button>
            <button type="button" className={livePty ? "active" : ""} aria-pressed={livePty} disabled={viewBusy} onClick={() => void switchTransport("pty")}>
              Terminal
            </button>
          </div>
        )}
        <CopyTextButton text={cwd} label="worktree path" />
        {(execution || endMessage) && (
          <button type="button" className="btn ghost small icon-btn" aria-label="Session actions" title="Session actions" onClick={() => setSessionActionsOpen(true)}>
            <Ellipsis size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      {finalizedNotice && <InlineStatus tone="warning">{finalizedNotice}</InlineStatus>}
      {executionView && <ExecutionAvailabilityNotice live={executionView.live} controls />}
      {sessionActionsOpen && (
        <Dialog ariaLabel="Session actions" className="session-actions-dialog" onClose={() => setSessionActionsOpen(false)}>
          <header className="session-actions-heading">
            <div>
              <h3>Session actions</h3>
              {execution && (
                <p className="session-actions-subtitle">
                  {executionStep?.title ?? execution.candidate.step_key} · Attempt{" "}
                  {execution.owner_session_id === id ? execution.previous_session_ids.length + 1 : execution.previous_session_ids.indexOf(id) + 1}
                  {observation && observationDisplayKind(observation) === "busy" && (
                    <span className="session-actions-activity">
                      <RunningIndicator />
                      Working…
                    </span>
                  )}
                </p>
              )}
            </div>
            <button type="button" className="btn ghost small icon-btn" aria-label="Close session actions" data-autofocus onClick={() => setSessionActionsOpen(false)}>
              <X size={16} aria-hidden="true" />
            </button>
          </header>
          {(unacceptedOwner || endMessage) && (
            <section className="session-handoff-actions" aria-label="Session handoff">
              {endMessage && <span role="status">{endMessage}</span>}
              {canRestart && (
                <button
                  type="button"
                  className="session-action-row"
                  aria-label="Restart this step…"
                  aria-describedby="restart-step-description"
                  disabled={completionBusy}
                  onClick={() => void recoverSession("restart")}
                >
                  <RotateCcw size={18} aria-hidden="true" />
                  <span>
                    <strong>Restart this step…</strong>
                    <span id="restart-step-description">Start a fresh agent with the same inputs. Keep saved files and code changes.</span>
                  </span>
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              )}
              {canRecover && (
                <>
                  <button
                    type="button"
                    className="session-action-row"
                    aria-label="Continue with an artifact…"
                    aria-describedby="artifact-step-description"
                    disabled={completionBusy}
                    onClick={openArtifactEntry}
                  >
                    <FileUp size={18} aria-hidden="true" />
                    <span>
                      <strong>Continue with an artifact…</strong>
                      <span id="artifact-step-description">Upload or paste the output for this step.</span>
                    </span>
                    <ChevronRight size={16} aria-hidden="true" />
                  </button>
                </>
              )}
              {canEnd && (
                <button
                  type="button"
                  className="session-action-row"
                  aria-label="End & continue…"
                  aria-describedby="saved-step-description"
                  disabled={completionBusy}
                  onClick={() => void endAndContinue()}
                >
                  <ArrowRight size={18} aria-hidden="true" />
                  <span>
                    <strong>End &amp; continue…</strong>
                    <span id="saved-step-description">Stop the agent and hand off its saved artifacts.</span>
                  </span>
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              )}
              {canRecover && (
                <button
                  type="button"
                  className="session-action-row session-action-stop"
                  aria-label="End session…"
                  aria-describedby="end-step-description"
                  disabled={completionBusy}
                  onClick={() => void recoverSession("stop")}
                >
                  <Square size={18} aria-hidden="true" />
                  <span>
                    <strong>End session…</strong>
                    <span id="end-step-description">Stop here without advancing the playbook.</span>
                  </span>
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              )}
              {endMessage && (
                <button type="button" className="btn ghost small" disabled={completionBusy} onClick={() => void refreshHandoff()}>
                  Refresh handoff status
                </button>
              )}
            </section>
          )}
          {execution && executionView && (
            <div className="session-execution-bar">
              <dl className="session-action-context" aria-label="Step context">
                <div>
                  <dt>Inputs</dt>
                  <dd>
                    {Object.entries(execution.candidate.inputs).length
                      ? Object.entries(execution.candidate.inputs).flatMap(([selector, ids]) =>
                          ids.map((occurrenceId) => {
                            const occurrence = executionView.state.occurrences[occurrenceId];
                            return <div key={occurrenceId}>{occurrence ? stepArtifactLink(selector, occurrence.relative_path) : <span>{selector} · Unavailable</span>}</div>;
                          }),
                        )
                      : "No input artifacts"}
                  </dd>
                </div>
                <div>
                  <dt>Outputs</dt>
                  <dd>
                    {execution.owner_session_id !== id
                      ? "Belong to the current attempt"
                      : execution.outputs.map((output) => {
                          const published = Object.values(executionView.state.occurrences).filter(
                            (item) => item.producer_execution_id === execution.id && item.selector === output.selector,
                          );
                          return (
                            <div key={output.relative_path}>
                              {published.length ? (
                                published.map((item) => (
                                  <div key={item.id}>
                                    {stepArtifactLink(item.logical_path, item.relative_path)} <span className="dim">· Handed off</span>
                                  </div>
                                ))
                              ) : (
                                <>
                                  {stepArtifactLink(output.selector, output.relative_path)}{" "}
                                  <span className="dim">· {execution.receipt_id ? "Not produced" : "Not yet handed off"}</span>
                                </>
                              )}
                            </div>
                          );
                        })}
                    {execution.owner_session_id === id && !execution.outputs.length && "No output artifacts"}
                  </dd>
                </div>
                <div>
                  <dt>Next step</dt>
                  <dd>
                    {executionAssessment?.terminality === "terminal"
                      ? "No next step from here"
                      : execution.continuation_mode === "automatic"
                        ? "Continues automatically when ready"
                        : "Waits for you to continue"}
                  </dd>
                </div>
              </dl>
              <details className="session-execution" aria-label="Session execution">
                <summary>Technical details</summary>
                <p>
                  State: {execution.lifecycle} · Owner <span className="mono">{execution.owner_session_id}</span>
                </p>
                <p className="mono">Execution {execution.id}</p>
                {execution.owner_session_id !== id && <p>This is a previous owner. Current owner: {execution.owner_session_id}.</p>}
                {execution.lifecycle === "finishing" && <p>Outputs accepted; waiting for confirmed shutdown. The session remains interactive until it exits.</p>}
                {execution.lifecycle === "interrupted" && <p>Ownership is uncertain; no replacement can start until shutdown is confirmed.</p>}
                {execution.error && <InlineStatus tone="error">{execution.error}</InlineStatus>}
                <ul aria-label="Execution inputs">
                  {Object.entries(execution.candidate.inputs).flatMap(([selector, ids]) =>
                    ids.map((occurrenceId) => {
                      const occurrence = executionView.state.occurrences[occurrenceId];
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
                <p>Continuation: {execution.continuation_mode === "automatic" ? "Automatic" : "Wait for me"}</p>
              </details>
            </div>
          )}
        </Dialog>
      )}
      {hasTask && !navHistory && effectiveLifecycle?.state === "never_started" && (
        <div className="session-execution">
          <p>{execution?.start_requested ? "Start requested; waiting for the daemon to acquire capacity." : "This session is queued. Opening it does not start it."}</p>
          <button
            type="button"
            className="btn small"
            disabled={!executionAvailable || completionBusy || !!execution?.start_requested}
            onClick={async () => {
              if (!executionAvailable || completionBusy || execution?.start_requested) return;
              setCompletionBusy(true);
              try {
                await ipc.startSession(taskSlug, id, repoPath);
                setObservation(await ipc.sessionStatus(id, taskSlug));
                setReclassifyTick((tick) => tick + 1);
                setExecutionView(await readTaskExecution(repoPath, taskSlug));
                setExecutionError("");
              } catch (error) {
                setExecutionError(String(error));
              } finally {
                setCompletionBusy(false);
              }
            }}
          >
            Start this queued session
          </button>
        </div>
      )}
      {executionError && (
        <InlineStatus tone="warning" detail={executionError}>
          Execution state unavailable; queued starts and completion grants are disabled.
        </InlineStatus>
      )}
      <div className={`sessionbody${hasTask ? "" : " no-artifacts"}`} style={{ ["--artifact-width" as string]: `${artifactWidth}px` }}>
        <div className="termhost" ref={termhostRef}>
          {(viewBusy || (ompCoding && Boolean(termIntent) && !liveRpc && !livePty)) && (
            <div className="session-view-loading" role="status" aria-live="polite">
              <LoadingState label={viewBusy ? "Switching view…" : "Opening session…"} state="connecting" />
            </div>
          )}
          {navHistory && (
            <div className="terminal-frame">
              {/* `liveRpc` is false the moment the session dies, which used to drop a finished OMP
                  chat onto the PTY terminal and a `.scrollback` an RPC session never wrote. The
                  journal does not need the session to be alive. */}
              {liveRpc || harness === "omp" ? (
                <>
                  <ChatPane
                    recoveryContent={recoveryContent}
                    activityContent={continuationStatus}
                    activityRunning={continuationStatusRunning}
                    entries={chatEntries}
                    status={chatStatus}
                    visibility={chatVisibility}
                    onApprove={onApproveChat}
                    onLoadOlder={loadOlder}
                    loadingOlder={loadingOlder}
                    atStart={chat.fileStart === 0}
                  />
                  {/* The history view is the live pane with the input switched off, so a finished
                      session reads the same way as a running one. */}
                  <ChatComposer
                    actions={continuationArea}
                    body=""
                    status="idle"
                    catalog={[]}
                    showHints={false}
                    readOnly
                    onBodyChange={() => undefined}
                    onSend={() => undefined}
                    onAbort={() => undefined}
                  />
                </>
              ) : (
                <SessionTerminal
                  sessionId={id}
                  cwd={cwd}
                  taskSlug={taskSlug}
                  phase={phase}
                  harness={harness}
                  model={model}
                  intent="attach"
                  readOnly
                  terminalFontSize={appearance.terminal_font_size}
                />
              )}
            </div>
          )}
          {navHistory && harness !== "omp" && !liveRpc ? continuationArea : null}
          {!navHistory && termIntent && (
            <>
              {showChat ? (
                <>
                  {chatVisibility.showMeta ? (
                    <div className="chat-meta">
                      <p>
                        {chatMetaHead ? `${chatMetaHead} · ` : null}
                        {chat.sessionMeta.thinking ? (
                          <>
                            <ThinkingSelect
                              level={chat.sessionMeta.thinking}
                              levels={chat.sessionMeta.thinkingLevels}
                              disabledReason={rpcProcessLive ? null : "The session is not running, so its thinking level cannot change"}
                              onPick={pickThinking}
                            />
                            {" · "}
                          </>
                        ) : null}
                        {chatMetaTail}
                      </p>
                    </div>
                  ) : null}
                  <div className="terminal-frame">
                    <ChatPane
                      recoveryContent={recoveryContent}
                      activityContent={continuationStatus}
                      activityRunning={continuationStatusRunning}
                      entries={chatEntries}
                      status={chatStatus}
                      visibility={chatVisibility}
                      onApprove={onApproveChat}
                      onLoadOlder={loadOlder}
                      loadingOlder={loadingOlder}
                      atStart={chat.fileStart === 0}
                      floatingActivity
                    />
                  </div>
                  {showChatComposer ? (
                    <>
                      {uiPrompt ? (
                        <ChatExtensionPrompt
                          request={uiPrompt}
                          onSubmit={(value) => void replyExtensionValue(uiPrompt.id, value)}
                          onCancel={() => void cancelExtensionPrompt(uiPrompt.id)}
                        />
                      ) : null}
                      <ChatComposer
                        actions={continuationArea}
                        beforeSend={continueInComposer ? continuationControl : null}
                        body={messageDraft.body}
                        status={chatStatus}
                        catalog={chat.commands}
                        sending={messageSending}
                        showHints={chatVisibility.showComposerHints}
                        attachments={messageDraft.attachments ?? []}
                        dropping={dropping}
                        onAttach={() => {
                          void ipc
                            .pickAttachmentFilesDialog()
                            .then((paths) => void stagePaths(paths))
                            .catch((error) => toast.error(String(error)));
                        }}
                        onRemoveAttachment={(id) => {
                          const current = messageDraftRef.current;
                          const removed = current.attachments.find((item) => item.id === id);
                          updateMessageDraft({ ...current, attachments: current.attachments.filter((item) => item.id !== id) });
                          if (removed) releaseUnusedPreviews([removed]);
                        }}
                        onClear={() => {
                          const attachments = messageDraftRef.current.attachments;
                          updateMessageDraft({ body: "", pendingActions: messageDraftRef.current.pendingActions, attachments: [] });
                          releaseUnusedPreviews(attachments);
                        }}
                        onPasteFiles={stageBlobs}
                        onBodyChange={(next) => {
                          updateMessageDraft({ ...messageDraftRef.current, body: next });
                          setMessageError("");
                        }}
                        onCompositionChange={setMessageComposing}
                        onSend={(text) => void sendCurrentMessage(text)}
                        onAbort={() => void interruptCurrentSession()}
                        onSendNow={sendNowEnabled ? () => void sendNow() : undefined}
                        sendNowEnabled={sendNowEnabled}
                        canAbort={composerCanAbort}
                        queuedCount={queuedMeta}
                      />
                    </>
                  ) : continuationArea ? (
                    <ChatComposer
                      actions={continuationArea}
                      body=""
                      status={chatStatus}
                      catalog={[]}
                      showHints={false}
                      readOnly
                      onBodyChange={() => undefined}
                      onSend={() => undefined}
                      onAbort={() => undefined}
                    />
                  ) : null}
                </>
              ) : (
                showPtyTerminal && (
                  <>
                    <div className="terminal-frame">
                      <SessionTerminal
                        sessionId={id}
                        cwd={cwd}
                        taskSlug={taskSlug}
                        phase={phase}
                        harness={harness}
                        model={model}
                        intent={termIntent}
                        resumeToken={resumeToken}
                        terminalFontSize={appearance.terminal_font_size}
                        onConnectionStateChange={handleTerminalConnectionState}
                      />
                    </div>
                    {continuationArea && <div className="session-continuation-anchor">{continuationArea}</div>}
                  </>
                )
              )}
              {contextActions.length > 0 && <ContextActionBar actions={contextActions} />}
            </>
          )}
          {!navHistory && showPanel && effectiveLifecycle && (
            <>
              <SessionActionPanel
                id={id}
                phase={phase}
                harness={harness}
                model={model}
                state={effectiveLifecycle}
                artifactReady={artifactReady}
                repoPath={repoPath}
                taskSlug={taskSlug}
                onStartFresh={leftover || execution ? undefined : onStartFresh}
                onArchive={handleArchive}
                archiveBusy={archiveBusy}
                onViewHistory={() => setShowHistory(true)}
                onKilled={() => setReclassifyTick((n) => n + 1)}
              />
              {showHistory &&
                (harness === "omp" ? (
                  <div className="terminal-frame">
                    <ChatPane
                      recoveryContent={recoveryContent}
                      activityContent={continuationStatus}
                      activityRunning={continuationStatusRunning}
                      entries={chat.entries}
                      status="idle"
                      visibility={chatVisibility}
                      onLoadOlder={loadOlder}
                      loadingOlder={loadingOlder}
                      atStart={chat.fileStart === 0}
                    />
                    <ChatComposer
                      actions={continuationArea}
                      body=""
                      status="idle"
                      catalog={[]}
                      showHints={false}
                      readOnly
                      onBodyChange={() => undefined}
                      onSend={() => undefined}
                      onAbort={() => undefined}
                    />
                  </div>
                ) : (
                  <div className="terminal-frame">
                    <SessionTerminal
                      sessionId={id}
                      cwd={cwd}
                      taskSlug={taskSlug}
                      phase={phase}
                      harness={harness}
                      model={model}
                      intent="attach"
                      readOnly
                      terminalFontSize={appearance.terminal_font_size}
                    />
                  </div>
                ))}
            </>
          )}
          <SessionLineage
            key={displayScope}
            onOpenActions={() => setSessionActionsOpen(true)}
            id={id}
            name={display?.session.name || ""}
            phase={executionStep?.title ?? phase}
            sessions={lineageSessions}
            executionView={executionView}
            observations={{ ...lineageObservations, [id]: observation }}
            error={lineageError || executionError}
            artifactPaths={artifactNames}
            readableArtifactPaths={artifactNames.filter((path) => findOwnedArtifactNode(artifactTree, path))}
            onOpenSession={
              onOpenSession
                ? (session) => {
                    setFollowEnabled(false);
                    followContinuation.current = null;
                    followNavigation.current = null;
                    onOpenSession(session);
                  }
                : undefined
            }
            onOpenArtifact={openStepArtifact}
          />
          {modelDialog && (
            <ChatModelDialog
              tab={modelDialog.tab}
              setup={modelDialog.setup}
              models={chat.sessionMeta.models ?? []}
              current={chat.sessionMeta.model}
              preselect={modelDialog.preselect}
              loginProviders={chat.sessionMeta.loginProviders ?? []}
              livePromotedIds={livePromotedIds}
              modelRoles={modelRoles}
              hosted={hosted}
              error={modelError}
              loginBusy={loginBusy}
              onTabChange={(tab) => setModelDialog((current) => (current ? { ...current, tab, setup: false } : current))}
              onApplyModel={(provider, modelId) => void applyChatModel(provider, modelId)}
              onLogin={(providerId) => void startChatLogin(providerId)}
              onHatchTerminalLogin={(providerId) => void hatchTerminalLogin(providerId)}
              onAssignRole={(role, model) => void assignModelRole(role, model)}
              onSignIn={() => {
                void ipc
                  .accountSignIn()
                  .then(() => ipc.accountRefresh().catch(() => undefined))
                  .then(() =>
                    ipc
                      .hostedCatalog()
                      .then(setHosted)
                      .catch(() => setHosted(null)),
                  )
                  .catch((error) => setModelError(String(error)));
              }}
              onSubscribe={() => {
                void ipc.accountOpenPlans().catch((error) => setModelError(String(error)));
              }}
              onBuyCredits={() => {
                void ipc.accountOpen().catch((error) => setModelError(String(error)));
              }}
              onClose={() => {
                setModelDialog(null);
                setModelError(null);
                setLoginBusy(null);
                loginApplyRef.current = null;
                loginOpenUrlRef.current = null;
              }}
            />
          )}
          {toolsOpen && <ChatToolsDialog tools={chat.sessionMeta.dumpTools ?? []} onClose={() => setToolsOpen(false)} />}
          {mcpDialog && (
            <ChatMcpDialog
              rows={mcpDialog.rows}
              empty={mcpDialog.empty}
              onPrompt={(message) => {
                setMcpDialog(null);
                void sendCurrentMessage(message);
              }}
              onClose={() => setMcpDialog(null)}
            />
          )}
          {!navHistory && !termIntent && !showPanel && (
            <div className="sap-loading">
              <LoadingState label="Checking session" state="connecting" />
            </div>
          )}
        </div>
        {hasTask && (
          <>
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
                        setArtifactErr("");
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
                    <InlineStatus tone="error" detail={artifactErr}>
                      The last artifact action did not complete.
                    </InlineStatus>
                  )}
                  {artifactCommentDraftError && (
                    <InlineStatus tone="error" detail={artifactCommentDraftError}>
                      Saving the comment draft failed.
                    </InlineStatus>
                  )}
                  {reviewPending && (
                    <InlineStatus
                      tone="info"
                      action={
                        <button type="button" className="btn ghost small" onClick={clearPendingReview}>
                          Clear waiting
                        </button>
                      }
                    >
                      {reviewPending.review} sent. {selectedArtifact} has not changed yet.
                    </InlineStatus>
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
                  {artifactErr && (
                    <InlineStatus tone="error" detail={artifactErr}>
                      The last artifact action did not complete.
                    </InlineStatus>
                  )}
                  <div className="artifactlist">
                    {displayedArtifactItems.length === 0 && contextualArtifactTree.length === 0 && (
                      <div className="dim">{artifactTab === "attachments" ? "No attachments." : "No playbook artifacts yet."}</div>
                    )}
                    {displayedArtifactItems.map((item) => {
                      if (item.attachment && classifyAttachment(item) === "image") {
                        return (
                          <AttachmentPreview key={item.name} taskSlug={taskSlug} name={item.name}>
                            <ArtifactProvenanceBadges handoffs={item.handoffs} onOpenRelatedTask={onOpenRelatedTask} />
                          </AttachmentPreview>
                        );
                      }
                      const commentCount = artifactCommentCountByArtifact[item.name] ?? 0;
                      const node = findOwnedArtifactNode(artifactTree, item.name);
                      const available = Boolean(item.attachment || node);
                      return (
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
                          onClick={() => {
                            if (item.attachment) {
                              ipc
                                .attachmentPath(taskSlug, item.name)
                                .then(ipc.revealItemInDir)
                                .catch((error) => setArtifactErr(String(error)));
                              return;
                            }
                            if (!node) return;
                            setSelectedArtifactNode(node);
                            setSelectedArtifact(item.name);
                            setArtifactMode("preview");
                            setArtifactErr("");
                          }}
                        >
                          <span className="artifactitem-name">{item.name}</span>
                          {!available && <span className="pill">Not yet readable</span>}
                          {commentCount > 0 && (
                            <span
                              className="artifact-comment-count"
                              title={`${commentCount} active comment${commentCount === 1 ? "" : "s"}`}
                              aria-label={`${commentCount} active comment${commentCount === 1 ? "" : "s"}`}
                            >
                              <MessageSquare size={12} strokeWidth={2} aria-hidden="true" />
                              <span>{commentCount}</span>
                            </span>
                          )}
                          <ArtifactProvenanceBadges handoffs={item.handoffs} onOpenRelatedTask={onOpenRelatedTask} />
                        </div>
                      );
                    })}
                    {contextualArtifactTree.length > 0 && (
                      <ArtifactTree
                        taskSlug={taskSlug}
                        nodes={contextualArtifactTree}
                        selectedId={selectedArtifactTreeId}
                        onSelect={(node) => {
                          setSelectedArtifactNode(node);
                          setSelectedArtifact(node.label);
                          setArtifactMode("preview");
                          setArtifactErr("");
                        }}
                        onError={setArtifactErr}
                      />
                    )}
                  </div>
                </>
              )}
            </aside>
          </>
        )}
      </div>
    </div>
  );
}
