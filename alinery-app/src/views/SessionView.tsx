import { ArrowLeft, MessageSquare } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { ArtifactComment, ArtifactCommentAnchor } from "../ArtifactMarkdown";
import { ArtifactMarkdown, formatArtifactCommentTarget } from "../ArtifactMarkdown";
import { ArtifactTree, isDirectOwnedArtifactNode } from "../ArtifactTree";
import type { ArtifactPaneTab } from "../artifactClassification";
import { artifactPaneItems, artifactPaneTreeNodes } from "../artifactClassification";
import { ChatComposer } from "../ChatComposer";
import { buildPromptMessage, canStage, classifyAttachment, type DraftAttachment, draftToRowAttachments, isHttpUrl, revokeDraftPreviewUrls } from "../chat/attachments";
import { CopyArtifactButton, CopyTextButton } from "../chat/CopyMessage";
import { formatContextUsage } from "../chat/format";
import type { ModelRolesMap } from "../chat/modelRoles";
import { decodeOmpPage } from "../chat/ompFile";
import { settleOpenUrl as settleBrowserUrl } from "../chat/openUrl";
import { isInteractivePromptLoginError, shouldOfferProviderSetup } from "../chat/providers";
import { latestQueuedFollowUp, type QueuedFollowUp, queuedCountFromGetState, queuedTextsNotInEntries, reconcileQueuedFollowUps } from "../chat/queue";
import { applySendPlan, commandOutputText, loginReply, planChatSend, setModelReply } from "../chat/send";
import { type McpServerRow, type ProvidersDialogTab, parseMcpListOutput } from "../chat/slash";
import type { SessionChatStatus } from "../chat/types";
import { chatVisibilityFromAppearance, lastApprovalNotice } from "../chat/visibility";
import {
  appendOptimisticAbort,
  appendOptimisticUser,
  applyFilePage,
  applyRpcLine,
  type ChatTranscriptState,
  dismissPendingUi,
  emptyTranscript,
  isPresentationUi,
  matchingSendFailure,
  matchingSendSuccess,
  needsUiReply,
  removeOptimisticSend,
} from "../chatTranscript";
import { confirmDanger } from "../confirm";
import * as ipc from "../ipc";

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
} from "../ompRpc";

import { SessionTerminal, type SessionTerminalConnectionState } from "../SessionTerminal";
import { appendGeneratedText, canAbortChatSession, isTurnActive, OMP_INTERRUPT_DATA, type SessionMessageDraft, shouldShowChatComposer } from "../sessionMessage";
import type { ContextAction } from "../shared";
import {
  ArtifactProvenanceBadges,
  ContextActionBar,
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
  HostedCatalogView,
  LifecycleState,
  ReviewHandoffSource,
  SessionMessageActionProvenance,
  SessionObservation,
  Task,
  TaskExecutionReply,
} from "../types";
import { useArtifactCommentDrafts } from "../useArtifactCommentDrafts";
import { useArtifactPaneWidth } from "../useArtifactPaneWidth";
import { ChatExtensionPrompt } from "./ChatExtensionPrompt";
import { ChatMcpDialog } from "./ChatMcpDialog";
import { ChatModelDialog } from "./ChatModelDialog";
import { ChatPane } from "./ChatPane";
import { ChatToolsDialog } from "./ChatToolsDialog";
import { SessionActionPanel } from "./SessionActionPanel";

// ---- session view -------------------------------------------------------------

type ArtifactReviewPendingStatus = {
  artifact: string;
  review: string;
};

type PreparedChatSend = {
  message: string;
  images: ImageContent[];
  copied: DraftAttachment[];
};

async function blobBytes(previewUrl: string): Promise<number[]> {
  const response = await fetch(previewUrl);
  return Array.from(new Uint8Array(await response.arrayBuffer()));
}

async function prepareChatSend(taskSlug: string, repoPath: string, caption: string, attachments: DraftAttachment[]): Promise<PreparedChatSend> {
  const restated: DraftAttachment[] = [];
  for (const item of attachments) {
    if (item.sourcePath) {
      const stat = await ipc.chatFileStat(item.sourcePath);
      restated.push({ ...item, name: stat.name, bytes: stat.bytes });
    } else {
      restated.push(item);
    }
  }
  const staged = canStage(
    [],
    restated.map((item) => ({ name: item.name, mimeType: item.mimeType, bytes: item.bytes })),
  );
  const failed = staged.find((item) => item.ok === false);
  if (failed && failed.ok === false) throw new Error(failed.reason);

  const copiedNames = new Map<string, string>();
  const pathItems = restated.filter((item) => item.sourcePath && !item.copiedName);
  const blobItems = restated.filter((item) => !item.sourcePath && item.previewUrl && !item.copiedName);
  for (const item of restated) {
    if (item.copiedName) copiedNames.set(item.id, item.copiedName);
  }
  if (pathItems.length > 0) {
    const result = await ipc.copyChatAttachments(
      taskSlug,
      pathItems.map((item) => item.sourcePath as string),
    );
    if (result.failures.length > 0 || result.copied.length !== pathItems.length) {
      throw new Error(result.failures[0] ?? "Could not copy attachments");
    }
    pathItems.forEach((item, index) => {
      const name = result.copied[index];
      if (name) copiedNames.set(item.id, name);
    });
  }
  for (const item of blobItems) {
    if (!item.previewUrl) continue;
    copiedNames.set(item.id, await ipc.writeChatAttachmentBytes(taskSlug, item.name, await blobBytes(item.previewUrl)));
  }

  const copied = restated.map((item) => ({ ...item, copiedName: copiedNames.get(item.id) ?? item.copiedName }));
  const files = copied.filter((item) => item.kind === "file").map((item) => ({ name: item.copiedName ?? item.name }));
  const images: ImageContent[] = [];
  for (const item of copied) {
    if (item.kind !== "image") continue;
    const name = item.copiedName ?? item.name;
    const image = await ipc.readChatImage(taskSlug, name);
    images.push({ type: "image", data: image.data, mimeType: image.mime_type });
  }
  return { message: buildPromptMessage(caption, files, repoPath, taskSlug), images, copied };
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
  onAppearanceChange,
  onBack,
  onStartFresh,
  onStartReviewHandoff,
  onOpenRelatedTask,
  onDiagramZoomOpenChange,
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
  onAppearanceChange: (next: AppearancePrefs) => void;
  onBack: () => void;
  onStartFresh: () => void;
  onStartReviewHandoff: (source: ReviewHandoffSource) => void;
  onOpenRelatedTask: (slug: string, relatedRepoPath?: string) => void;
  onDiagramZoomOpenChange?: (open: boolean) => void;
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
  const [executionView, setExecutionView] = useState<TaskExecutionReply | null>(null);
  const [executionError, setExecutionError] = useState("");
  const [completionBusy, setCompletionBusy] = useState(false);
  const execution = Object.values(executionView?.state.executions ?? {}).find((record) => record.owner_session_id === id || record.previous_session_ids.includes(id));
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
  const chatAttachIdRef = useRef(0);
  const [chatAttachEpoch, setChatAttachEpoch] = useState(0);
  const ompStartRef = useRef<string | null>(null);
  const ompSeedRef = useRef<{ id: string; done: Promise<unknown> } | null>(null);
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
  // Last model send whose stdin write was acked but whose OMP response has not landed yet.
  // Cleared on matching success/failure or turn_start; used to restore the draft if OMP refuses.
  const pendingSendRef = useRef<{
    commandId: string;
    draft: string;
    actions: SessionMessageDraft["pendingActions"];
    entryId: string;
    attachments: DraftAttachment[];
  } | null>(null);
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const queuedFollowUpsRef = useRef(queuedFollowUps);
  queuedFollowUpsRef.current = queuedFollowUps;

  const handleTerminalConnectionState = useCallback((state: SessionTerminalConnectionState) => setTerminalConnection(state), []);
  const messageDraftRef = useRef(messageDraft);
  messageDraftRef.current = messageDraft;
  const updateMessageDraft = (draft: SessionMessageDraft) => {
    messageDraftRef.current = draft;
    onMessageDraftChange(draft);
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
    pendingSendRef.current = null;
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
    setExecutionView(null);
    setExecutionError("");
    if (!taskSlug) return;
    const refresh = async () => {
      try {
        const next = await ipc.getTaskExecution(taskSlug, repoPath);
        if (alive) {
          setExecutionView(next);
          setExecutionError("");
        }
      } catch (error) {
        if (alive) setExecutionError(String(error));
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 1500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [taskSlug, repoPath, id]);

  const allowCompletion = async () => {
    if (!execution || execution.owner_session_id !== id) return;
    setCompletionBusy(true);
    try {
      await ipc.allowExecutionCompletion(taskSlug, execution.id, id, repoPath);
      setExecutionView(await ipc.getTaskExecution(taskSlug, repoPath));
      setExecutionError("");
    } catch (error) {
      setExecutionError(String(error));
    } finally {
      setCompletionBusy(false);
    }
  };

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
    if (!hasTask) {
      setTask(null);
      setParentTask(null);
      return;
    }
    ipc
      .listTasks()
      .then((tasks) => {
        if (!alive) return;
        const currentTask = tasks.find((candidate) => candidate.slug === taskSlug) ?? null;
        setTask(currentTask);
        setParentTask(currentTask?.parent_task ? (tasks.find((candidate) => candidate.slug === currentTask.parent_task) ?? null) : null);
      })
      .catch(() => {
        if (alive) {
          setTask(null);
          setParentTask(null);
        }
      });
    return () => {
      alive = false;
    };
  }, [hasTask, taskSlug]);

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
        await ipc.rpcWriteSession(id, getLoginProvidersCommand()).catch(() => undefined);
        await ipc.rpcWriteSession(id, getAvailableModelsCommand()).catch(() => undefined);
        await ipc.rpcWriteSession(id, getStateCommand()).catch(() => undefined);
        return null;
      case "hatch":
        toast(dispatch.reason, "info");
        return null;
      case "get-tools":
        await ipc.rpcWriteSession(id, getStateCommand());
        setToolsOpen(true);
        return null;
      case "mcp-list":
        mcpListWaitRef.current = true;
        await ipc.rpcWriteSession(id, promptCommand("/mcp list"));
        return null;
      case "compact":
        await ipc.rpcWriteSession(id, compactCommand(dispatch.customInstructions));
        return null;
      case "mcp-prompt":
      case "compact-mode":
      case "prompt":
      case "unknown-prompt":
      case "plain": {
        const message = extras?.message ?? dispatch.message;
        const images = extras?.images;
        const command = busy ? followUpCommand(message, undefined, images) : promptCommand(message, undefined, images);
        await ipc.rpcWriteSession(id, command);
        return plan.invokesModel ? { commandId: command.id } : null;
      }
    }
  };

  const sendCurrentMessage = async (text?: string) => {
    const caption = (text ?? messageDraftRef.current.body).trim();
    const attachments = messageDraftRef.current.attachments ?? [];
    if (messageSending || (caption.length === 0 && attachments.length === 0)) return;
    if (caption.startsWith("/") && attachments.length > 0) {
      toast.error("Remove attachments or clear the slash command");
      return;
    }
    const transport = observation?.transport;
    if (transport !== "rpc" && transport !== "pty") {
      setMessageError("The session is still connecting.");
      return;
    }
    const actions = [...messageDraftRef.current.pendingActions];
    const busy = isTurnActive({
      pendingTurn: chatRef.current.pendingTurn,
      turnOpen: chatRef.current.turnOpen,
      agentState: observation?.state?.agent?.state,
    });
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
        const sent = await dispatchChatPlan(plan, busy, extras);
        const rowAttachments = draftToRowAttachments(attachments);
        const applied = applySendPlan(chatRef.current, caption, plan, rowAttachments.length > 0 ? rowAttachments : undefined);
        chatRef.current = applied.state;
        setChat(applied.state);
        if (sent && applied.entryId) {
          pendingSendRef.current = { commandId: sent.commandId, draft: caption, actions, entryId: applied.entryId, attachments };
        }
        if (busy && plan.optimisticKind === "follow_up") {
          const nextQueue = [...queuedFollowUpsRef.current, { text: caption, attachments: queuedAttachments }];
          queuedFollowUpsRef.current = nextQueue;
          onQueuedFollowUpsChange?.(nextQueue);
        }
        updateMessageDraft({ body: "", pendingActions: [], attachments: [] });
      }
      if (actions.length > 0) {
        try {
          await ipc.finalizeSessionMessageActions(id, taskSlug, actions);
          await refreshFinalizedActions(actions);
        } catch (error) {
          setMessageError(`Delivered to session, but Alinery could not finalize message metadata: ${String(error)}`);
        }
      }
    } catch (error) {
      toast.error(String(error));
      setMessageError(String(error));
    } finally {
      setMessageSending(false);
    }
  };

  const sendNow = async () => {
    const draftBody = messageDraftRef.current.body.trim();
    const draftAttachments = messageDraftRef.current.attachments ?? [];
    const usingDraft = draftBody.length > 0 || draftAttachments.length > 0;
    const queued = latestQueuedFollowUp(queuedFollowUpsRef.current);
    const caption = usingDraft ? draftBody : (queued?.text ?? "");
    const attachments = usingDraft ? draftAttachments : (queued?.attachments ?? []);
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
      const command = abortAndPromptCommand(message, undefined, images);
      await ipc.rpcWriteSession(id, command);
      const rowAttachments = draftToRowAttachments(attachments);
      if (usingDraft) {
        updateMessageDraft({ body: "", pendingActions: [], attachments: [] });
        const next = appendOptimisticUser(chatRef.current, caption, "prompt", undefined, rowAttachments.length > 0 ? rowAttachments : undefined);
        chatRef.current = next;
        setChat(next);
        const entryId = next.entries[next.entries.length - 1]?.id;
        if (entryId) pendingSendRef.current = { commandId: command.id, draft: caption, actions: [], entryId, attachments: pendingAttachments };
      } else {
        const remaining = queuedFollowUpsRef.current.slice(0, -1);
        onQueuedFollowUpsChange?.(remaining);
        setChat((current) => {
          const entries = [...current.entries];
          let entryId: string | undefined;
          for (let i = entries.length - 1; i >= 0; i -= 1) {
            const entry = entries[i];
            if (entry?.type === "follow_up" && entry.text === caption) {
              entries[i] = { ...entry, type: "prompt" };
              entryId = entry.id;
              break;
            }
          }
          const next = { ...current, entries };
          chatRef.current = next;
          if (entryId) pendingSendRef.current = { commandId: command.id, draft: caption, actions: [], entryId, attachments: pendingAttachments };
          return next;
        });
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
    chatAttachIdRef.current += 1;
    const attachId = chatAttachIdRef.current;
    // The session-id effect already clears the transcript on a real session change. Do not
    // emptyTranscript() here: a liveRpc flap would wipe visible history. The poll catch above
    // keeps the last observation so a transient error does not re-enter; a later successful
    // poll after a failure bumps chatAttachEpoch to re-attach without clearing entries.

    setTerminalConnection("opening");
    const apply = (line: string) => {
      if (cancelled) return;
      try {
        const value: unknown = JSON.parse(line);
        const pending = pendingSendRef.current;
        const refused = pending ? matchingSendFailure(value, pending.commandId) : null;
        if (refused !== null && pending) {
          pendingSendRef.current = null;
          setChat((current) => {
            const next = removeOptimisticSend(applyRpcLine(current, value), pending.entryId);
            chatRef.current = next;
            return next;
          });
          updateMessageDraft({ body: pending.draft, pendingActions: pending.actions, attachments: pending.attachments });
          toast.error(refused);
          setMessageError(refused);
        } else {
          if (pending && (matchingSendSuccess(value, pending.commandId) || (typeof value === "object" && value !== null && "type" in value && value.type === "turn_start"))) {
            revokeDraftPreviewUrls(pending.attachments);
            pendingSendRef.current = null;
          }
          setChat((current) => {
            let next = applyRpcLine(current, value);
            const count = queuedCountFromGetState(value);
            if (typeof count === "number") {
              const reconciled = reconcileQueuedFollowUps(queuedFollowUpsRef.current, count);
              queuedFollowUpsRef.current = reconciled.texts;
              onQueuedFollowUpsChange?.(reconciled.texts);
              const texts = reconciled.texts.map((item) => item.text);
              next = {
                ...next,
                entries: next.entries.filter((entry) => entry.type !== "follow_up" || texts.includes(entry.text)),
              };
            }
            chatRef.current = next;
            return next;
          });
          const rec = value as { type?: string; success?: boolean; command?: string };
          if (
            (rec.type === "response" && rec.success === true && (rec.command === "follow_up" || rec.command === "abort_and_prompt")) ||
            rec.type === "turn_end" ||
            rec.type === "agent_end"
          ) {
            void ipc.rpcWriteSession(id, getStateCommand()).catch(() => undefined);
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
              void ipc.rpcWriteSession(id, getLoginProvidersCommand()).catch(() => undefined);
              void ipc.rpcWriteSession(id, getAvailableModelsCommand()).catch(() => undefined);
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
    void seedOmpJournal()

      .then(() => {
        if (cancelled) return;
        const missing = queuedTextsNotInEntries(
          queuedFollowUpsRef.current.map((item) => item.text),
          chatRef.current.entries,
        );
        if (missing.length > 0) {
          setChat((current) => {
            let next = current;
            for (const text of missing) next = appendOptimisticUser(next, text, "follow_up");
            chatRef.current = next;
            return next;
          });
        }
        return ipc.rpcAttachSession({ id, attachId, streamToken: attachId, onLine: apply });
      })

      .then(async () => {
        if (cancelled) return;
        setTerminalConnection("open");
        // No wait for `ready`: OMP emits it once at spawn, so on any established session the old
        // 2s deadline always expired in full and told us nothing. History no longer depends on it
        // either — it was read from the journal before this attach began.
        await ipc.rpcWriteSession(id, negotiateProtocolCommand());
        if (cancelled) return;
        await ipc.rpcWriteSession(id, getAvailableCommandsCommand());
        if (cancelled) return;
        await ipc.rpcWriteSession(id, getStateCommand());
        if (cancelled) return;
        await ipc.rpcWriteSession(id, setAutoCompactionCommand(chatAutoCompactionRef.current));
        if (cancelled) return;
        await ipc.rpcWriteSession(id, setSubagentSubscriptionCommand("events"));
        if (cancelled) return;
        await ipc.rpcWriteSession(id, getSubagentsCommand());
        if (cancelled) return;
        await ipc.rpcWriteSession(id, getLoginProvidersCommand());

        if (cancelled) return;
        await ipc.rpcWriteSession(id, getAvailableModelsCommand());
        void ipc.readOmpModelRoles().then((roles) => {
          if (!cancelled) setModelRoles(roles);
        });
      })
      .catch((error) => {
        if (!cancelled) {
          setTerminalConnection("failed");
          toast(String(error), "error");
        }
      });
    return () => {
      cancelled = true;
      void ipc.detachSession(id, attachId);
    };
  }, [liveRpc, id, seedOmpJournal, chatAttachEpoch]);
  useEffect(() => {
    if (!liveRpc) return;
    void ipc.rpcWriteSession(id, setAutoCompactionCommand(chatAutoCompaction)).catch(() => undefined);
  }, [chatAutoCompaction, liveRpc, id]);
  const settleOpenUrl = async (requestId: string, raw: string | undefined) => {
    try {
      await settleBrowserUrl(id, requestId, raw, (error) => toast(error, "error"));
      setChat((current) => dismissPendingUi(current, requestId));
    } catch (error) {
      toast(String(error), "error");
    }
  };
  useEffect(() => {
    if (!liveRpc) return;
    for (const request of chat.pendingUi) {
      if (handledUiRef.current.has(request.id)) continue;
      if (isPresentationUi(request.method)) {
        handledUiRef.current.add(request.id);
        void ipc.rpcWriteSession(id, cancelExtensionUi(request.id)).catch(() => undefined);
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
  }, [liveRpc, chat.pendingUi, id]);
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
      connected: liveRpc,
      suppressed: setupOpenedRef.current || modelDialog !== null,
      busy: isTurnActive({
        pendingTurn: chat.pendingTurn,
        turnOpen: chat.turnOpen,
        agentState: observation?.state?.agent?.state,
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
    liveRpc,
    chat.sessionMeta.loginProviders,
    chat.sessionMeta.model,
    chat.sessionMeta.models,
    chat.pendingTurn,
    chat.turnOpen,
    observation?.state?.agent?.state,
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
      await ipc.rpcWriteSession(id, abortCommand());
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
      agentState: observation?.state?.agent?.state,
    });
    if (active) {
      const ok = await confirmDanger(
        target === "pty" ? "Switch to Terminal?" : "Switch to Chat?",
        target === "pty" ? "Stop the agent’s current work and switch to Terminal?" : "Stop the agent’s current work and switch to Chat?",
        "Stop and switch",
      );
      if (!ok) return false;
      if (liveRpc) await ipc.rpcWriteSession(id, abortCommand()).catch(() => undefined);
      else await ipc.writeSession(id, OMP_INTERRUPT_DATA).catch(() => undefined);
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
  const turnActive = isTurnActive({
    pendingTurn: chat.pendingTurn,
    turnOpen: chat.turnOpen,
    agentState: observedState?.agent?.state,
  });
  const chatStatus: SessionChatStatus = chat.sessionMeta.isCompacting || pendingUiReply ? "waiting_approval" : turnActive ? "running" : "idle";
  const agentState = observedState?.agent?.state;
  const approvalNotice = agentState === "waiting_for_approval" ? lastApprovalNotice(chat.entries) : null;
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
  const chatMeta = [
    chat.sessionMeta.model || model,
    chat.sessionMeta.thinking,
    `${chat.entries.length} event${chat.entries.length === 1 ? "" : "s"}`,
    formatContextUsage(chat.sessionMeta.contextUsage?.tokens, chat.sessionMeta.contextUsage?.contextWindow),
    queuedMeta > 0 ? `${queuedMeta} queued` : "",
  ]
    .filter((part) => part && part.length > 0)
    .join(" · ");

  const replyExtensionValue = async (requestId: string, value: string) => {
    handledUiRef.current.add(requestId);
    try {
      await ipc.rpcWriteSession(id, extensionUiValue(requestId, value));
      setChat((current) => dismissPendingUi(current, requestId));
    } catch (error) {
      toast(String(error), "error");
    }
  };
  const cancelExtensionPrompt = async (requestId: string) => {
    handledUiRef.current.add(requestId);
    try {
      await ipc.rpcWriteSession(id, cancelExtensionUi(requestId));
      setChat((current) => dismissPendingUi(current, requestId));
    } catch (error) {
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
      await ipc.rpcWriteSession(id, extensionUiConfirm(requestId, allow));
      setChat((current) => dismissPendingUi(current, requestId));
    } catch (error) {
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
      await ipc.rpcWriteSession(id, setModelCommand(provider, modelId));
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
      await ipc.rpcWriteSession(id, loginCommand(providerId));
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
      await ipc.writeSession(id, "/login\n");
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

  return (
    <div className="sessionview">
      <div className="sessionhd">
        <button ref={backButtonRef} type="button" className="btn ghost small" onClick={onBack}>
          <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" /> Back
        </button>
        {hasTask && (
          <span className="session-task" title={taskSlug}>
            {task?.name || taskSlug}
          </span>
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
      </div>
      {finalizedNotice && <InlineStatus tone="warning">{finalizedNotice}</InlineStatus>}
      {hasTask && !navHistory && effectiveLifecycle?.state === "never_started" && (
        <div className="session-execution">
          <p>{execution?.start_requested ? "Start requested; waiting for the daemon to acquire capacity." : "This session is queued. Opening it does not start it."}</p>
          <button
            type="button"
            className="btn small"
            disabled={completionBusy || !!execution?.start_requested}
            onClick={async () => {
              setCompletionBusy(true);
              try {
                await ipc.startSession(taskSlug, id, repoPath);
                setObservation(await ipc.sessionStatus(id, taskSlug));
                setReclassifyTick((tick) => tick + 1);
                setExecutionView(await ipc.getTaskExecution(taskSlug, repoPath));
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
          Execution state unavailable; completion grants are disabled.
        </InlineStatus>
      )}
      {execution && executionView && (
        <div className="session-execution-bar">
          <details className="session-execution" aria-label="Session execution">
            <summary>
              {executionStep?.title ?? execution.candidate.step_key} · {execution.lifecycle} · Owner {execution.owner_session_id}
            </summary>
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
            <ul aria-label="Execution outputs">
              {execution.outputs.map((output) => (
                <li key={output.relative_path}>
                  <code>{output.selector}</code> → <code>{output.relative_path}</code> · {execution.receipt_id ? "accepted" : "pending"}
                </li>
              ))}
              {Object.values(executionView.state.occurrences)
                .filter((occurrence) => occurrence.producer_execution_id === execution.id && occurrence.selector.includes("*"))
                .map((occurrence) => (
                  <li key={occurrence.id}>
                    Accepted member <code>{occurrence.relative_path}</code> · occurrence {occurrence.id}
                  </li>
                ))}
            </ul>
            <p>
              Completion permission: {execution.permission.kind}
              {execution.permission.kind === "human_granted" ? ` · ${execution.permission.session_id}` : ""}
            </p>
          </details>
          {execution.owner_session_id === id && execution.permission.kind === "locked" && execution.lifecycle === "running" && (
            <button
              type="button"
              className="btn small"
              aria-label={`Allow this session to complete · ${id}`}
              title={`Allow session ${id} to request completion`}
              disabled={completionBusy || !!executionError}
              onClick={() => void allowCompletion()}
            >
              Allow this session to complete
            </button>
          )}
        </div>
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
                    entries={chat.entries}
                    status={chatStatus}
                    visibility={chatVisibility}
                    onApprove={onApproveChat}
                    onLoadOlder={loadOlder}
                    loadingOlder={loadingOlder}
                    atStart={chat.fileStart === 0}
                  />
                  {/* The history view is the live pane with the input switched off, so a finished
                      session reads the same way as a running one. */}
                  {liveRpc ? null : (
                    <ChatComposer body="" status="idle" catalog={[]} showHints={false} readOnly onBodyChange={() => undefined} onSend={() => undefined} onAbort={() => undefined} />
                  )}
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
          {!navHistory && termIntent && (
            <>
              {showChat ? (
                <>
                  {chatVisibility.showMeta ? (
                    <div className="chat-meta">
                      <p>{chatMeta}</p>
                    </div>
                  ) : null}
                  <div className="terminal-frame">
                    <ChatPane
                      entries={chat.entries}
                      status={chatStatus}
                      visibility={chatVisibility}
                      onApprove={onApproveChat}
                      onLoadOlder={loadOlder}
                      loadingOlder={loadingOlder}
                      atStart={chat.fileStart === 0}
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
                          if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
                          updateMessageDraft({ ...current, attachments: current.attachments.filter((item) => item.id !== id) });
                        }}
                        onClear={() => {
                          revokeDraftPreviewUrls(messageDraftRef.current.attachments);
                          updateMessageDraft({ body: "", pendingActions: messageDraftRef.current.pendingActions, attachments: [] });
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
                        approvalNotice={approvalNotice}
                        queuedCount={queuedMeta}
                      />
                      {messageError ? <InlineStatus tone="error">{messageError}</InlineStatus> : null}
                    </>
                  ) : null}
                </>
              ) : (
                showPtyTerminal && (
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
                onStartFresh={leftover ? () => undefined : onStartFresh}
                onArchive={handleArchive}
                archiveBusy={archiveBusy}
                onViewHistory={() => setShowHistory(true)}
                onKilled={() => setReclassifyTick((n) => n + 1)}
              />
              {showHistory &&
                (harness === "omp" ? (
                  <div className="terminal-frame">
                    <ChatPane entries={chat.entries} status="idle" visibility={chatVisibility} onLoadOlder={loadOlder} loadingOlder={loadingOlder} atStart={chat.fileStart === 0} />
                    <ChatComposer body="" status="idle" catalog={[]} showHints={false} readOnly onBodyChange={() => undefined} onSend={() => undefined} onAbort={() => undefined} />
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
                          {item.execution_id && (
                            <span className="dim">
                              Execution {item.execution_id} · {item.step_key} · {item.accepted ? "accepted" : "pending"}
                            </span>
                          )}
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
