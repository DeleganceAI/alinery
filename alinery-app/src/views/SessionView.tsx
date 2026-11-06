import { ArrowLeft, MessageSquare, Pencil } from "lucide-react";
import type { KeyboardEvent } from "react";
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
import { prepareChatAttachments } from "../chat/prepareAttachments";
import { useProviderAccess } from "../chat/providerAccess";
import { shouldOfferProviderSetup } from "../chat/providers";
import type { ProvidersDialogTab } from "../chat/slash";
import type { SessionChatStatus } from "../chat/types";
import { chatVisibilityFromAppearance } from "../chat/visibility";
import {
  appendOptimisticAbort,
  appendOptimisticUser,
  applyFilePage,
  applySessionControls,
  applyVinculumTranscript,
  type ChatTranscriptState,
  emptyTranscript,
  NEXT_TURN_MODEL_TITLE,
  NEXT_TURN_THINKING_TITLE,
} from "../chatTranscript";
import { completionPrompt } from "../completionPrompt";
import { confirmDanger } from "../confirm";
import * as ipc from "../ipc";
import { awaitingSessionName, NameEditor, PendingSessionName, restoreNameFocus } from "../NameEditor";
import { filesAreRemote, revealPath } from "../revealPath";
import { SessionTerminal, type SessionTerminalConnectionState } from "../SessionTerminal";
import { appendGeneratedText, canAbortChatSession, isTurnActive, type SessionMessageDraft, shouldShowChatComposer } from "../sessionMessage";
import type { ContextAction } from "../shared";
import {
  ArtifactProvenanceBadges,
  ContextActionBar,
  ExecutionAvailabilityNotice,
  ExecutionOutputs,
  finalizedSubtaskNotice,
  findOwnedArtifactNode,
  harnessDisplayName,
  InlineStatus,
  isAllowedLaunchHarness,
  isVinculumHarness,
  LoadingState,
  StatusDot,
  sameArtifactListItems,
} from "../shared";
import { useBoardTask, useSessionDisplay } from "../sync/board";
import { allowExecutionCompletion, useTaskExecution } from "../sync/execution";
import { observationNow, useSessionObservation } from "../sync/sessionObservation";
import { addTaskAttachment, copyTaskAttachments } from "../sync/tasks";
import { watchSessionTranscript } from "../sync/transcript";
import { toast } from "../toast";
import type {
  AppearancePrefs,
  ArtifactListItem,
  ArtifactTreeNode,
  HostedCatalogView,
  LifecycleState,
  NameCommit,
  ReviewHandoffSource,
  SessionDisplayContext,
  SessionMessageActionProvenance,
  TaskExecutionReply,
} from "../types";
import { useArtifactCommentDrafts } from "../useArtifactCommentDrafts";
import { useArtifactPaneWidth } from "../useArtifactPaneWidth";
import { sessionIsRecoverable, sessionTerminalLabel } from "../vinculumHarness";
import { ChatModelDialog } from "./ChatModelDialog";
import { ChatPane } from "./ChatPane";
import { CustomEndpointForm, ProviderAccessPanel } from "./ProviderAccessPanel";
import { SessionActionPanel } from "./SessionActionPanel";
import { ThinkingSelect } from "./ThinkingSelect";

// ---- session view -------------------------------------------------------------

type ArtifactReviewPendingStatus = {
  artifact: string;
  review: string;
};

function prepareChatSend(taskSlug: string, repoPath: string, caption: string, attachments: DraftAttachment[]) {
  return prepareChatAttachments(
    {
      stat: (path) => ipc.chatFileStat(path),
      copy: (paths) => copyTaskAttachments(repoPath, taskSlug, paths),
      writeBytes: (fileName, bytes) => addTaskAttachment(repoPath, taskSlug, fileName, Uint8Array.from(bytes)),
      readImage: (name) => ipc.readChatImage(taskSlug, name),
      trailerDir: taskAttachmentDir(repoPath, taskSlug),
    },
    caption,
    attachments,
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
  onAppearanceChange,
  onBack,
  onStartFresh,
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
  onAppearanceChange: (next: AppearancePrefs) => void;
  onBack: () => void;
  onStartFresh: () => void;
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
  // The task, its parent and this session's display row all arrive on the daemon's streams.
  const task = useBoardTask(taskSlug ? repoPath : undefined, taskSlug) ?? null;
  const parentTask = useBoardTask(taskSlug ? repoPath : undefined, task?.parent_task ?? "") ?? null;
  const live = useSessionDisplay(taskSlug ? repoPath : undefined, taskSlug, id);
  const display = useMemo<SessionDisplayContext | null>(
    () => (live.session ? { session: live.session, task_name: live.taskName, subtask_name: live.subtaskName } : null),
    [live.session, live.taskName, live.subtaskName],
  );
  const [editingName, setEditingName] = useState(false);
  const nameTrigger = useRef<HTMLButtonElement | null>(null);
  const displayScope = `${repoPath}\u0000${taskSlug}\u0000${id}`;
  const closeNameEditor = () => {
    flushSync(() => setEditingName(false));
    restoreNameFocus(nameTrigger.current);
  };
  const nameScope = `${repoPath}\u0000${taskSlug}\u0000${id}`;
  const currentNameScope = useRef(nameScope);
  currentNameScope.current = nameScope;
  const saveName = async (name: string) => {
    const value = await ipc.renameSession({ repoPath, taskSlug, sessionId: id, name });
    // A save that finishes after the view moved to another session must not close that session's editor.
    if (currentNameScope.current === nameScope) closeNameEditor();
    onNameCommitted?.({ kind: "session", repo_path: repoPath, task_slug: taskSlug, session_id: id, value });
  };

  useEffect(() => {
    setEditingName(false);
  }, [repoPath, taskSlug, id]);
  const [executionView, setExecutionView] = useState<TaskExecutionReply | null>(null);
  const [executionError, setExecutionError] = useState("");
  const executionAvailable = executionView?.live?.status === "available" && !executionError && !executionView.state.history_only;
  const [completionBusy, setCompletionBusy] = useState(false);
  const [dismissedCompletionId, setDismissedCompletionId] = useState("");
  const execution = Object.values(executionView?.state.executions ?? {}).find((record) => record.owner_session_id === id || record.previous_session_ids.includes(id));
  const executionStep = executionView?.definition.step.find((step) => step.key === execution?.candidate.step_key);
  const completionAvailable = executionAvailable && execution?.owner_session_id === id && execution.lifecycle === "running";
  const [reviewFindingsComments, setReviewFindingsComments] = useState<ArtifactComment[]>([]);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalStatus, setApprovalStatus] = useState("");
  const hasTask = Boolean(taskSlug);
  const observation = useSessionObservation(intent === "history" ? "" : repoPath, taskSlug, id);
  const [terminalConnection, setTerminalConnection] = useState<SessionTerminalConnectionState>("opening");
  const [messageComposing, setMessageComposing] = useState(false);
  const [messageSending, setMessageSending] = useState(false);
  const [messageInterrupting, setMessageInterrupting] = useState(false);
  const [messageError, setMessageError] = useState("");
  const [chat, setChat] = useState<ChatTranscriptState>(emptyTranscript);
  const [modelDialog, setModelDialog] = useState<{ tab: ProvidersDialogTab; preselect: string; setup?: boolean } | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const providerAccess = useProviderAccess(isVinculumHarness(harness));
  const [modelRoles, setModelRoles] = useState<ModelRolesMap>({});
  const [hosted, setHosted] = useState<HostedCatalogView | null>(null);
  const [hostedLoaded, setHostedLoaded] = useState(false);
  const [grokReady, setGrokReady] = useState(false);
  const ompStartRef = useRef<string | null>(null);
  const handledUiRef = useRef(new Set<string>());
  const setupOpenedRef = useRef(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const archivePending = useRef(false);
  const [dropping, setDropping] = useState(false);
  const attachmentSeq = useRef(0);
  const chatRef = useRef(chat);
  chatRef.current = chat;

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
    observationNow(repoPath, taskSlug, id)
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
  }, [explicitIntent, leftover, id, taskSlug, repoPath, reclassifyTick, intent]);

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
    setTerminalConnection("opening");
    setMessageComposing(false);
    setMessageSending(false);
    setMessageError("");
    setChat(emptyTranscript());
    setModelDialog(null);
    setModelError(null);
    setModelRoles({});
    ompStartRef.current = null;
    handledUiRef.current.clear();
    setupOpenedRef.current = false;
  }, [id, taskSlug, repoPath, intent]);

  // The execution row is pushed by the daemon; an approval's refusal is shown until the next row lands.
  const executionFeed = useTaskExecution(repoPath, taskSlug);
  useEffect(() => {
    if (executionFeed.reply) setExecutionView(executionFeed.reply);
    setExecutionError(executionFeed.error);
  }, [executionFeed, taskSlug, repoPath, id]);

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
        const message = attachments.length > 0 ? (await prepareChatSend(taskSlug, repoPath, caption, attachments)).message : caption;
        if (attachments.length > 0) refreshAttachmentArtifacts();
        await ipc.sessionPrompt(id, message);
        const next = appendOptimisticUser(chatRef.current, caption, busy ? "follow_up" : "prompt");
        chatRef.current = next;
        setChat(next);
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
    const caption = messageDraftRef.current.body.trim();
    const attachments = messageDraftRef.current.attachments ?? [];
    if (messageSending || (caption.length === 0 && attachments.length === 0)) return;
    if (observation?.transport !== "rpc") {
      setMessageError("The session is still connecting.");
      return;
    }
    setMessageSending(true);
    setMessageError("");
    try {
      let message = caption;
      if (attachments.length > 0) {
        message = (await prepareChatSend(taskSlug, repoPath, caption, attachments)).message;
        refreshAttachmentArtifacts();
      }
      await ipc.sessionAbort(id);
      await ipc.sessionPrompt(id, message);
      const rowAttachments = draftToRowAttachments(attachments);
      updateMessageDraft({ body: "", pendingActions: [], attachments: [] });
      const next = appendOptimisticUser(chatRef.current, caption, "prompt", undefined, rowAttachments.length > 0 ? rowAttachments : undefined);
      chatRef.current = next;
      setChat(next);
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
  const vinculum = isVinculumHarness(harness);
  const liveRpc = observation?.transport === "rpc";
  // Exited RPC sessions still support replay, but their processes cannot accept commands.
  const rpcProcessLive = liveRpc && observation?.lifecycle.state === "live" && observation.state?.process.state === "alive";
  const livePty = observation?.transport === "pty";
  const ompCoding = vinculum && !leftover && !navHistory && !showPanel;
  const showChat = ompCoding && Boolean(termIntent) && !livePty;
  const showPtyTerminal = Boolean(termIntent) && !showChat;
  const showChatComposer = showChat && composerEligible;
  useEffect(() => {
    if (!showChat || termIntent !== "spawn" || observation?.transport) return;
    if (ompStartRef.current === id) return;
    ompStartRef.current = id;
    void ipc.startSession(taskSlug, id, repoPath).catch((error) => {
      setTerminalConnection("failed");
      toast(String(error), "error");
    });
  }, [showChat, termIntent, observation?.transport, id, taskSlug, repoPath, cwd, resumeToken]);

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
    if (!vinculum || !showChat) return;
    return watchSessionTranscript(repoPath, { taskSlug, id }, (reply) => {
      setChat(() => {
        const next = applyVinculumTranscript(reply);
        chatRef.current = next;
        return next;
      });
      setTerminalConnection("open");
    });
  }, [vinculum, showChat, repoPath, taskSlug, id]);
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
    void ipc.grokKeyReady().then(
      (ready) => {
        if (!cancelled) setGrokReady(ready);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    // `busy` keeps the dialog off a running agent; the effect re-runs when the turn closes and offers setup then.
    if (!hostedLoaded) return;
    const offer = shouldOfferProviderSetup({
      connected: rpcProcessLive,
      suppressed: setupOpenedRef.current || modelDialog !== null,
      busy: isTurnActive({
        pendingTurn: chat.pendingTurn,
        turnOpen: chat.turnOpen,
        agentState: observation?.state?.agent?.state,
      }),
      providers: providerAccess.loginProviders,
      models: providerAccess.models,
      currentModel: chat.sessionMeta.model,
      hostedReady: hosted?.ready === true,
    });
    if (!offer) return;
    setupOpenedRef.current = true;
    setModelError(null);
    setModelDialog({ tab: "accounts", preselect: "", setup: true });
  }, [
    rpcProcessLive,
    chat.sessionMeta.model,
    chat.pendingTurn,
    chat.turnOpen,
    observation?.state?.agent?.state,
    modelDialog,
    hosted,
    hostedLoaded,
    providerAccess.loginProviders,
    providerAccess.models,
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
  const interruptCurrentSession = async () => {
    if (!liveRpc || !canAbortChatSession(messageReadiness)) return;
    setMessageInterrupting(true);
    setMessageError("");
    try {
      setChat((current) => appendOptimisticAbort(current));
      await ipc.sessionAbort(id);
    } catch (error) {
      setMessageError(`Couldn't interrupt the session: ${String(error)}`);
    } finally {
      setMessageInterrupting(false);
    }
  };

  const completionCopy = useMemo(() => completionPrompt(executionView?.definition, execution), [executionView?.definition, execution]);
  // Vinculum has no extension confirm card. The locked execution itself is the request.
  const vinculumCompletionRequestId =
    vinculum && completionAvailable && execution?.permission.kind === "locked" && dismissedCompletionId !== `vinculum-completion:${execution.id}`
      ? `vinculum-completion:${execution.id}`
      : "";
  const chatVisibility = useMemo(() => chatVisibilityFromAppearance(appearance), [appearance]);
  const chatEntries = useMemo(() => {
    const entries = [...chat.entries];
    if (!vinculumCompletionRequestId) return entries;
    entries.push({
      id: vinculumCompletionRequestId,
      type: "approval",
      requestId: vinculumCompletionRequestId,
      actor: { kind: "system", name: "Alinery" },
      ...completionCopy,
      disabled: navHistory || completionBusy,
    });
    return entries;
  }, [chat.entries, completionCopy, navHistory, completionBusy, vinculumCompletionRequestId]);
  const turnActive = isTurnActive({
    pendingTurn: chat.pendingTurn,
    turnOpen: chat.turnOpen,
    agentState: observedState?.agent?.state,
  });
  const chatStatus: SessionChatStatus = chat.sessionMeta.isCompacting ? "waiting_approval" : turnActive ? "running" : "idle";
  const agentState = observedState?.agent?.state;
  const composerCanAbort = canAbortChatSession(messageReadiness);
  const sendNowEnabled =
    turnActive &&
    agentState !== "waiting_for_input" &&
    agentState !== "waiting_for_approval" &&
    !chat.sessionMeta.isCompacting &&
    (messageDraft.body.trim().length > 0 || (messageDraft.attachments?.length ?? 0) > 0);
  const queuedMeta = chat.sessionMeta.queuedMessageCount ?? 0;
  const chatMetaHead = chat.sessionMeta.model || model;
  const chatMetaTail = [
    `${chat.entries.length} event${chat.entries.length === 1 ? "" : "s"}`,
    formatContextUsage(chat.sessionMeta.contextUsage?.tokens, chat.sessionMeta.contextUsage?.contextWindow),
    queuedMeta > 0 ? `${queuedMeta} queued` : "",
  ]
    .filter((part) => part && part.length > 0)
    .join(" · ");
  const pickThinking = (level: string) => {
    void ipc.sessionSetThinkingLevel(id, level).then(
      (controls) => {
        setChat((current) => {
          const next = applySessionControls(current, controls);
          chatRef.current = next;
          return next;
        });
      },
      (error) => toast(String(error), "error"),
    );
  };

  const approveChat = async (requestId: string, allow: boolean) => {
    // The row stays mounted across the await, so without this a double-click sends two responses.
    if (handledUiRef.current.has(requestId)) return;
    handledUiRef.current.add(requestId);
    if (vinculumCompletionRequestId && requestId === vinculumCompletionRequestId) {
      if (!allow) {
        setDismissedCompletionId(requestId);
        handledUiRef.current.delete(requestId);
        return;
      }
      if (!execution || !completionAvailable || completionBusy) {
        handledUiRef.current.delete(requestId);
        return;
      }
      setCompletionBusy(true);
      try {
        await allowExecutionCompletion(repoPath, taskSlug, execution.id, executionView?.revision);
        setExecutionError("");
      } catch (error) {
        setExecutionError(String(error));
      } finally {
        handledUiRef.current.delete(requestId);
        setCompletionBusy(false);
      }
      return;
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
    try {
      const controls = await ipc.sessionSetModel(id, `${provider}/${modelId}`);
      setChat((current) => {
        const next = applySessionControls(current, controls);
        chatRef.current = next;
        return next;
      });
      setModelDialog(null);
    } catch (error) {
      setModelError(String(error));
    }
  };
  const startChatLogin = async (providerId: string) => {
    const row = providerAccess.loginProviders.find((provider) => provider.id === providerId);
    if (row?.apiKey && row.oauth) {
      providerAccess.choose(row);
      return;
    }
    await providerAccess.start(providerId, row?.oauth && !row.apiKey ? "oauth" : "api_key");
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

  const terminalLabel = sessionTerminalLabel(
    harness,
    id,
    execution,
    effectiveLifecycle?.state === "exited" || effectiveLifecycle?.state === "interrupted" || effectiveLifecycle?.state === "orphaned",
  );
  const canRecoverSession = executionAvailable && sessionIsRecoverable(harness, id, execution);
  const recoverSession = async () => {
    if (!canRecoverSession || completionBusy) return;
    setCompletionBusy(true);
    try {
      await ipc.startSession(taskSlug, id, repoPath);
      setReclassifyTick((tick) => tick + 1);
      setExecutionError("");
    } catch (error) {
      setExecutionError(String(error));
    } finally {
      setCompletionBusy(false);
    }
  };
  const finalizedNotice = task ? finalizedSubtaskNotice(task, parentTask) : "";
  const awaitingName = display != null && awaitingSessionName({ ...display.session, harness: display.session.harness || harness }, observation);

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
        <span className="pill" title={vinculum && turnActive ? NEXT_TURN_MODEL_TITLE : undefined}>
          {harnessDisplayName(harness) + (chatMetaHead ? ` · ${chatMetaHead}` : "")}
        </span>
        <StatusDot id={id} slug={taskSlug} repoPath={repoPath} observation={observation} terminalLabel={terminalLabel} />
        <span className="session-path dim mono">
          {id} · {cwd}
        </span>
        <CopyTextButton text={cwd} label="worktree path" />
      </div>
      {finalizedNotice && <InlineStatus tone="warning">{finalizedNotice}</InlineStatus>}
      {executionView && <ExecutionAvailabilityNotice live={executionView.live} controls />}
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
                setReclassifyTick((tick) => tick + 1);
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
            <ExecutionOutputs execution={execution} occurrences={executionView.state.occurrences} />
            <p>
              Completion permission: {execution.permission.kind}
              {execution.permission.kind === "human_granted" ? ` · ${execution.permission.session_id}` : ""}
            </p>
          </details>
        </div>
      )}
      <div className={`sessionbody${hasTask ? "" : " no-artifacts"}`} style={{ ["--artifact-width" as string]: `${artifactWidth}px` }}>
        <div className="termhost" ref={termhostRef}>
          {ompCoding && Boolean(termIntent) && !liveRpc && !livePty && (
            <div className="session-view-loading" role="status" aria-live="polite">
              <LoadingState label="Opening session…" state="connecting" />
            </div>
          )}
          {navHistory && (
            <div className="terminal-frame">
              {/* `liveRpc` is false the moment the session dies, which used to drop a finished OMP
                  chat onto the PTY terminal and a `.scrollback` an RPC session never wrote. The
                  journal does not need the session to be alive. */}
              {liveRpc || vinculum ? (
                <>
                  <ChatPane
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
                      <div>
                        <button
                          type="button"
                          className="btn ghost small"
                          aria-label="Change model"
                          title={turnActive ? NEXT_TURN_MODEL_TITLE : "Change model"}
                          onClick={() => {
                            setModelError(null);
                            setModelDialog({ tab: "models", preselect: "", setup: false });
                          }}
                        >
                          {chatMetaHead || "Model"}
                        </button>
                        {" · "}
                        {chat.sessionMeta.thinking ? (
                          <>
                            <ThinkingSelect
                              level={chat.sessionMeta.thinking}
                              levels={chat.sessionMeta.thinkingLevels}
                              disabledReason={rpcProcessLive ? null : "The session is not running, so its thinking level cannot change"}
                              title={turnActive ? NEXT_TURN_THINKING_TITLE : undefined}
                              onPick={pickThinking}
                            />
                            {" · "}
                          </>
                        ) : null}
                        {chatMetaTail}
                      </div>
                    </div>
                  ) : null}
                  <div className="terminal-frame">
                    <ChatPane
                      entries={chatEntries}
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
                onRecover={canRecoverSession ? () => void recoverSession() : undefined}
                recoverBusy={completionBusy}
              />
              {showHistory &&
                (vinculum ? (
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
              models={providerAccess.models}
              current={chat.sessionMeta.model}
              preselect={modelDialog.preselect}
              loginProviders={providerAccess.loginProviders}
              livePromotedIds={[]}
              configuredIds={providerAccess.custom.map((row) => row.id)}
              modelRoles={modelRoles}
              hosted={hosted}
              grok={grokReady}
              error={modelError || providerAccess.error}
              loginBusy={providerAccess.busy}
              onTabChange={(tab) => setModelDialog((current) => (current ? { ...current, tab, setup: false } : current))}
              onApplyModel={(provider, modelId) => void applyChatModel(provider, modelId)}
              onLogin={(providerId) => void startChatLogin(providerId)}
              onLogout={(providerId) => void providerAccess.logout(providerId)}
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
                void providerAccess.cancel();
                setModelDialog(null);
                setModelError(null);
              }}
              footer={<CustomEndpointForm access={providerAccess} />}
            >
              <ProviderAccessPanel access={providerAccess} />
            </ChatModelDialog>
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
                          <AttachmentPreview key={item.name} taskSlug={taskSlug} name={item.name} repoPath={repoPath}>
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
                              // A remote repo's files are on its host; the daemon never hands out a path.
                              if (filesAreRemote()) return;
                              ipc
                                .attachmentPath(taskSlug, item.name)
                                .then(revealPath)
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
