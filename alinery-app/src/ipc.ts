// The single boundary between this app and its Rust backend.
//
// Every `invoke` in the frontend used to be written inline: 142 call sites across 18
// files, naming 94 commands as bare strings with untyped argument bags. Two consequences.
// A typo in a command name or an argument key was invisible until the click that used it,
// in a desktop app with no CI. And no view could be unit-tested, because there was nothing
// to mock — the Tauri boundary was everywhere and therefore nowhere.
//
// Rules:
//   - `@tauri-apps/*` may be imported HERE AND NOWHERE ELSE. Enforced by
//     scripts/tests/check-ipc-boundary.sh.
//   - Every command name below must exist in `generate_handler!` in src-tauri/src/lib.rs.
//     Enforced by scripts/tests/check-ipc-commands.sh.
//   - Sections mirror the Rust module map documented in AGENTS.md, so `// session.rs`
//     tells you exactly which file owns the other end.
//   - Up to three parameters are positional; four or more take a single object, because
//     `createTaskForRepo` has sixteen and nobody should count commas.
//   - Rust `snake_case` parameters are `camelCase` here — that is Tauri's own convention,
//     not a choice made in this file.
//
// Only the commands the frontend actually calls are wrapped (94 of the 111 registered).
// Add a wrapper when a view needs one, not before.

import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AccountSignOutResult,
  AccountStatus,
  AppConfig,
  AppearancePrefs,
  ArtifactComment,
  ArtifactCommentDraft,
  ArtifactListItem,
  ArtifactReviewPendingStatus,
  ArtifactTreeNode,
  BackupListItem,
  BackupMeta,
  BoardTask,
  Config,
  ConnectionStatus,
  CreateExecutionSessionReply,
  CreateExecutionSessionRequest,
  CreateTaskRequest,
  CreateTaskResult,
  DaemonStatus,
  DesktopCreditsView,
  GitHubIssue,
  GlobalSettings,
  HostedCatalogView,
  KanbanColumn,
  LinearTicket,
  McpStatus,
  NormalizedPlaybook,
  OmpUpdateStatus,
  PickerPreferences,
  PlaybookCatalog,
  PlaybookRef,
  PlaybookValidation,
  PreparedSessionMessageAction,
  PreparedTaskAttachments,
  PurgeArchivedResult,
  RelatedTaskRef,
  RepoOverrides,
  ReviewHandoffResult,
  SavePlaybookRequest,
  ScopedPlaybook,
  ScopedSettings,
  SessionListItem,
  SessionMessageActionProvenance,
  SessionMeta,
  SessionNotificationClearRef,
  SessionObservation,
  SessionStatusRef,
  StagedUpdate,
  StorageInfo,
  SubtaskManagerState,
  Task,
  TaskActivityRef,
  TaskActivitySummary,
  TaskExecutionReply,
  UpdateStatus,
} from "./types";

export { getName, getVersion } from "@tauri-apps/api/app";
export { listen } from "@tauri-apps/api/event";
export { homeDir } from "@tauri-apps/api/path";
export { getCurrentWebview } from "@tauri-apps/api/webview";
export { getCurrentWindow } from "@tauri-apps/api/window";
export { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
// ── platform (non-command Tauri APIs) ─────────────────────────────────
// Re-exported rather than imported directly by consumers, so the boundary gate has a
// single file to police and tests have a single module to mock.
export { Channel };

// ── app_config.rs ─────────────────────────────────────────────────────
export const pickAttachmentFilesDialog = () => invoke<string[]>("pick_attachment_files_dialog");
export const pickRepoDialog = () => invoke<string | null>("pick_repo_dialog");
export const readAppConfig = () => invoke<AppConfig>("read_app_config");
export const removeRepo = (path: string) => invoke<AppConfig>("remove_repo", { path });
export const setActiveRepo = (path: string, drawerSessionId: string | null) => invoke<AppConfig>("set_active_repo", { path, drawerSessionId });
export const writeAppearance = (appearance: AppearancePrefs) => invoke<AppConfig>("write_appearance", { appearance });

// ── artifacts.rs ──────────────────────────────────────────────────────
export const addArtifactComment = (a: {
  taskSlug: string;
  artifact: string;
  anchorId: string;
  anchorKind: string;
  anchorLabel: string;
  anchorExcerpt: string;
  lineStart: number;
  lineEnd: number;
  body: string;
}) => invoke<ArtifactComment[]>("add_artifact_comment", a);
export const addArtifactCommentForRepo = (a: {
  repoPath: string;
  taskSlug: string;
  artifact: string;
  anchorId: string;
  anchorKind: string;
  anchorLabel: string;
  anchorExcerpt: string;
  lineStart: number;
  lineEnd: number;
  body: string;
}) => invoke<ArtifactComment[]>("add_artifact_comment_for_repo", a);
export const prepareArtifactCommentsPrompt = (taskSlug: string, artifacts: string[]) =>
  invoke<PreparedSessionMessageAction>("prepare_artifact_comments_prompt", { taskSlug, artifacts });
export const archiveArtifactComments = (taskSlug: string, artifact: string) => invoke<string>("archive_artifact_comments", { taskSlug, artifact });
export const archiveArtifactCommentsForRepo = (repoPath: string, taskSlug: string, artifact: string) =>
  invoke<string>("archive_artifact_comments_for_repo", { repoPath, taskSlug, artifact });
export const artifactReviewPendingStatus = (taskSlug: string, artifact: string) =>
  invoke<ArtifactReviewPendingStatus | null>("artifact_review_pending_status", { taskSlug, artifact });
export const attachmentPath = (taskSlug: string, name: string) => invoke<string>("attachment_path", { taskSlug, name });
export const artifactNodePath = (taskSlug: string, nodeId: string) => invoke<string>("artifact_node_path", { taskSlug, nodeId });
export const clearArtifactReviewPending = (taskSlug: string, artifact: string) => invoke<void>("clear_artifact_review_pending", { taskSlug, artifact });
export const clearArtifactReviewPendingForRepo = (repoPath: string, taskSlug: string, artifact: string) =>
  invoke<void>("clear_artifact_review_pending_for_repo", { repoPath, taskSlug, artifact });
export const deleteArtifactCommentDraft = (taskSlug: string, artifact: string, anchorId: string) => invoke<void>("delete_artifact_comment_draft", { taskSlug, artifact, anchorId });
export const deleteArtifactCommentDraftForRepo = (repoPath: string, taskSlug: string, artifact: string, anchorId: string) =>
  invoke<void>("delete_artifact_comment_draft_for_repo", { repoPath, taskSlug, artifact, anchorId });
export const listArtifactCommentDrafts = (taskSlug: string) => invoke<ArtifactCommentDraft[]>("list_artifact_comment_drafts", { taskSlug });
export const listArtifactCommentDraftsForRepo = (repoPath: string, taskSlug: string) =>
  invoke<ArtifactCommentDraft[]>("list_artifact_comment_drafts_for_repo", { repoPath, taskSlug });
export const listArtifactComments = (taskSlug: string, artifact: string) => invoke<ArtifactComment[]>("list_artifact_comments", { taskSlug, artifact });
export const listArtifactsWithMetadata = (taskSlug: string) => invoke<ArtifactListItem[]>("list_artifacts_with_metadata", { taskSlug });
export const listTaskArtifactTree = (taskSlug: string) => invoke<ArtifactTreeNode[]>("list_task_artifact_tree", { taskSlug });
export const readArtifact = (taskSlug: string, name: string) => invoke<string>("read_artifact", { taskSlug, name });
export const readArtifactForRepo = (repoPath: string, taskSlug: string, name: string) => invoke<string>("read_artifact_for_repo", { repoPath, taskSlug, name });
export const readTaskArtifactNode = (taskSlug: string, nodeId: string) => invoke<string>("read_task_artifact_node", { taskSlug, nodeId });
export const saveArtifactCommentDraft = (a: {
  taskSlug: string;
  artifact: string;
  anchorId: string;
  anchorKind: string;
  anchorLabel: string;
  anchorExcerpt: string;
  lineStart: number;
  lineEnd: number;
  body: string;
}) => invoke<void>("save_artifact_comment_draft", a);
export const saveArtifactCommentDraftForRepo = (a: {
  repoPath: string;
  taskSlug: string;
  artifact: string;
  anchorId: string;
  anchorKind: string;
  anchorLabel: string;
  anchorExcerpt: string;
  lineStart: number;
  lineEnd: number;
  body: string;
}) => invoke<void>("save_artifact_comment_draft_for_repo", a);
export const sendReviewHandoff = (a: {
  sourceRepoPath: string;
  targetRepoPath: string;
  sourceSlug: string;
  sourceSession: string;
  sourceArtifact: string;
  targetSlug: string;
  targetPhase: string;
  harness: string;
  model: string;
  promptExtra: string;
}) => invoke<ReviewHandoffResult>("send_review_handoff", a);

// ── backup.rs ─────────────────────────────────────────────────────────
export const backupBusy = (repoPath: string | null) => invoke<boolean>("backup_busy", { repoPath });
export const backupNow = (repoPath: string | null) => invoke<BackupMeta>("backup_now", { repoPath });
export const listBackups = (repoPath: string | null) => invoke<BackupListItem[]>("list_backups", { repoPath });
export const pickBackupDestinationDialog = (repoPath: string) => invoke<string | null>("pick_backup_destination_dialog", { repoPath });
export const restoreBackup = (repoPath: string | null, backupPath: string) => invoke<void>("restore_backup", { repoPath, backupPath });

// ── daemon.rs ─────────────────────────────────────────────────────────
export const cancelQuit = () => invoke<void>("cancel_quit");
export const closeAllRepos = () => invoke<number>("close_all_repos");
export const daemonStatus = () => invoke<DaemonStatus>("daemon_status");
export const repoLiveSessions = (path: string) => invoke<number>("repo_live_sessions", { path });
export const stopDaemon = (path: string | null) => invoke<void>("stop_daemon", { path });
export const takeoverRepoDaemon = (path: string | null) => invoke<void>("takeover_repo_daemon", { path });

// ── git_ops.rs ────────────────────────────────────────────────────────
export const commitWorktree = (slug: string, message: string) => invoke<void>("commit_worktree", { slug, message });
export const commitWorktreeForRepo = (repoPath: string, slug: string, message: string) => invoke<void>("commit_worktree_for_repo", { repoPath, slug, message });
export const pushAndCompareUrl = (slug: string) => invoke<string>("push_and_compare_url", { slug });
export const pushAndCompareUrlForRepo = (repoPath: string, slug: string) => invoke<string>("push_and_compare_url_for_repo", { repoPath, slug });
export const removeWorktreeForRepo = (repoPath: string, slug: string) => invoke<void>("remove_worktree_for_repo", { repoPath, slug });
export const setPrUrl = (slug: string, url: string) => invoke<void>("set_pr_url", { slug, url });
export const setPrUrlForRepo = (repoPath: string, slug: string, url: string) => invoke<void>("set_pr_url_for_repo", { repoPath, slug, url });
export const worktreeExists = (slug: string) => invoke<boolean>("worktree_exists", { slug });

// ── connections.rs ────────────────────────────────────────────────────
export const connectionStatuses = () => invoke<ConnectionStatus[]>("connection_statuses");
export const connectGithub = () => invoke<ConnectionStatus>("connect_github");
export const connectLinear = () => invoke<ConnectionStatus>("connect_linear");
export const disconnectLinear = () => invoke<ConnectionStatus>("disconnect_linear");

// ── account.rs ────────────────────────────────────────────────────────
export const accountStatus = () => invoke<AccountStatus>("account_status");
export const accountRefresh = () => invoke<AccountStatus>("account_refresh");
export const accountSignIn = () => invoke<AccountStatus>("account_sign_in");
export const accountCancelSignIn = () => invoke<void>("account_cancel_sign_in");
export const accountSignOut = () => invoke<AccountSignOutResult>("account_sign_out");
export const accountOpen = () => invoke<void>("account_open");
export const hostedCatalog = () => invoke<HostedCatalogView>("hosted_catalog");
export const accountCredits = () => invoke<DesktopCreditsView>("account_credits");
export const accountOpenPlans = () => invoke<void>("account_open_plans");

// ── imports.rs ────────────────────────────────────────────────────────
export const importGithubForRepo = (repoPath: string, reference: string) => invoke<GitHubIssue>("import_github_for_repo", { repoPath, reference });
export const importLinearForRepo = (repoPath: string, reference: string) => invoke<LinearTicket>("import_linear_for_repo", { repoPath, reference });

// ── mcp.rs ────────────────────────────────────────────────────────────
export const mcpStatus = () => invoke<McpStatus>("mcp_status");
export const startMcpServer = () => invoke<McpStatus>("start_mcp_server");
export const stopMcpServer = () => invoke<McpStatus>("stop_mcp_server");

// ── notify.rs ─────────────────────────────────────────────────────────
export const notifySessionAttention = (repoPath: string, slug: string | null, reason: string) => invoke<void>("notify_session_attention", { repoPath, slug, reason });
export const notifyTest = () => invoke<void>("notify_test");
export const setDockBadgeCount = (count: number) => invoke<void>("set_dock_badge_count", { count });

// ── subtask.rs ────────────────────────────────────────────────────────
export const subtaskState = (taskSlug: string) => invoke<SubtaskManagerState>("subtask_state", { taskSlug });
export const startSubtaskManager = (taskSlug: string) => invoke<CreateExecutionSessionReply>("start_subtask_manager", { taskSlug });
export const recoverSubtaskManager = (taskSlug: string) => invoke<CreateExecutionSessionReply>("recover_subtask_manager", { taskSlug });
export const discardSubtask = (taskSlug: string, managerSessionId: string) => invoke<void>("discard_subtask", { taskSlug, managerSessionId });

// ── session.rs ────────────────────────────────────────────────────────

export const archiveSession = (taskSlug: string, id: string) => invoke<void>("archive_session", { taskSlug, id });
export const archiveSessionForRepo = (repoPath: string, taskSlug: string, id: string) => invoke<void>("archive_session_for_repo", { repoPath, taskSlug, id });
export const createSession = (request: CreateExecutionSessionRequest) => invoke<CreateExecutionSessionReply>("create_session", { request });
export const createSessionForRepo = (a: { repoPath: string; request: CreateExecutionSessionRequest }) => invoke<CreateExecutionSessionReply>("create_session_for_repo", a);
export const getTaskExecution = (taskSlug: string, repoPath?: string) => invoke<TaskExecutionReply>("get_task_execution", { taskSlug, repoPath });
export const allowExecutionCompletion = (taskSlug: string, executionId: string, sessionId: string, repoPath?: string) =>
  invoke<void>("allow_execution_completion", { taskSlug, executionId, sessionId, repoPath });
export const startSession = (taskSlug: string, sessionId: string, repoPath?: string) => invoke<CreateExecutionSessionReply>("start_session", { taskSlug, sessionId, repoPath });
export const detachSession = (id: string, attachId: number) => invoke<void>("detach_session", { id, attachId });
export const ensureDrawerTerminal = () => invoke<SessionMeta>("ensure_drawer_terminal");
export const killSession = (id: string, taskSlug: string) => invoke<void>("kill_session", { id, taskSlug });
export const killSessionForRepo = (repoPath: string, id: string, taskSlug: string) => invoke<void>("kill_session_for_repo", { repoPath, id, taskSlug });
export const listSessionItems = (allRepos: boolean, includeArchived: boolean) => invoke<SessionListItem[]>("list_session_items", { allRepos, includeArchived });
export const listSessions = (taskSlug: string) => invoke<SessionMeta[]>("list_sessions", { taskSlug });
export const markSessionNotificationRead = (repoPath: string, taskSlug: string, id: string) => invoke<void>("mark_session_notification_read", { repoPath, taskSlug, id });
export const clearSessionNotifications = (refs: SessionNotificationClearRef[]) => invoke<void>("clear_session_notifications", { refs });
export const openSession = (a: {
  id: string;
  cwd: string;
  attachId: number;
  streamToken: number;
  taskSlug?: string | null;
  phase?: string | null;
  model?: string | null;
  intent?: string | null;
  resumeToken?: string | null;
  cols?: number | null;
  rows?: number | null;
  onBytes: Channel<ArrayBuffer>;
}) => invoke<void>("open_session", a);
export const readSessionHistory = (a: { id: string; taskSlug?: string | null; offset?: number | null; limit?: number | null }) => invoke<number[]>("read_session_history", a);
// Raw bytes, not number[]: a Vec<u8> return would cross IPC as a JSON array of numbers (3.4x on
// the wire, and a per-byte JS array before a single row can be parsed).
export const readSessionOmp = (a: { id: string; taskSlug?: string | null; end?: number | null; want?: number | null }) => invoke<ArrayBuffer>("read_session_omp", a);
export const resizeSession = (id: string, cols: number, rows: number) => invoke<void>("resize_session", { id, cols, rows });
export const sessionArtifactReady = (id: string, taskSlug: string) => invoke<boolean>("session_artifact_ready", { id, taskSlug });
export const sessionListStatuses = (refs: SessionStatusRef[]) => invoke<Record<string, SessionObservation>>("session_list_statuses", { refs });
export const sessionStatus = (id: string, taskSlug: string | null) => invoke<SessionObservation>("session_status", { id, taskSlug });
export const sessionStatuses = (ids: string[], taskSlug: string) => invoke<Record<string, SessionObservation>>("session_statuses", { ids, taskSlug });
export const writeSession = (id: string, data: string) => invoke<void>("write_session", { id, data });
export const restateSession = (id: string, transport: "pty" | "rpc") => invoke<void>("restate_session", { id, transport });
export const rpcWriteSession = (id: string, payload: unknown) => invoke<void>("rpc_write_session", { id, payload });
/** Bring up (or reuse) the reserved setup session and get its id. Attach to it like any session. */
export const ompSetupSession = () => invoke<string>("omp_setup_session");
export const rpcAttachSession = (a: { id: string; attachId: number; streamToken: number; onLine: (line: string) => void }) => {
  const onLine = new Channel<string>();
  onLine.onmessage = a.onLine;
  return invoke<void>("rpc_attach_session", { id: a.id, attachId: a.attachId, streamToken: a.streamToken, onLine });
};
export const prepareReviewApprovalPrompt = (taskSlug: string, reviewArtifact: string) =>
  invoke<PreparedSessionMessageAction>("prepare_review_approval_prompt", { taskSlug, reviewArtifact });
export const finalizeSessionMessageActions = (id: string, taskSlug: string, actions: SessionMessageActionProvenance[]) =>
  invoke<void>("finalize_session_message_actions", { id, taskSlug, actions });

// ── settings.rs ───────────────────────────────────────────────────────
export const clearRepoOverrideForRepo = (repoPath: string, field: string) => invoke<ScopedSettings>("clear_repo_override_for_repo", { repoPath, field });
export const deleteAllArchivedStorage = (repoPath: string) => invoke<PurgeArchivedResult>("delete_all_archived_storage", { repoPath });
export const listHarnessModels = (harness: string) => invoke<string[]>("list_harness_models", { harness });
export const listHarnessModelsForRepo = (repoPath: string, harness: string) => invoke<string[]>("list_harness_models_for_repo", { repoPath, harness });
export const readConfig = () => invoke<Config>("read_config");
export const readConfigForRepo = (repoPath: string) => invoke<Config>("read_config_for_repo", { repoPath });
export const readGlobalSettings = () => invoke<GlobalSettings>("read_global_settings");
export const readModelFavorites = (harness: string) => invoke<string[]>("read_model_favorites", { harness });
export const readScopedSettingsForRepo = (repoPath: string) => invoke<ScopedSettings>("read_scoped_settings_for_repo", { repoPath });
export const storageInfo = (repoPath: string) => invoke<StorageInfo>("storage_info", { repoPath });
export const setModelFavorite = (harness: string, model: string, favorite: boolean) => invoke<string[]>("set_model_favorite", { harness, model, favorite });
export const writeGlobalSettings = (global: GlobalSettings) => invoke<GlobalSettings>("write_global_settings", { global });
export const writeRepoOverridesForRepo = (repoPath: string, overrides: RepoOverrides) => invoke<ScopedSettings>("write_repo_overrides_for_repo", { repoPath, overrides });

// ── task.rs ───────────────────────────────────────────────────────────
export const archiveTaskForRepo = (repoPath: string, slug: string) => invoke<void>("archive_task_for_repo", { repoPath, slug });
export const restoreTaskForRepo = (repoPath: string, slug: string) => invoke<void>("restore_task_for_repo", { repoPath, slug });
export const createTaskForRepo = (a: { repoPath: string; request: CreateTaskRequest }) => invoke<CreateTaskResult>("create_task_for_repo", a);
export const prepareTaskAttachments = (entries: string[]) => invoke<PreparedTaskAttachments>("prepare_task_attachments", { entries });
export const duplicateTaskForRepo = (repoPath: string, sourceSlug: string) => invoke<CreateTaskResult>("duplicate_task_for_repo", { repoPath, sourceSlug });
export const deleteDraftForRepo = (repoPath: string, slug: string) => invoke<void>("delete_draft_for_repo", { repoPath, slug });
export const getTask = (slug: string) => invoke<Task | null>("get_task", { slug });
export const listBoardTasks = (allRepos: boolean) => invoke<BoardTask[]>("list_board_tasks", { allRepos });
export const listTaskActivity = (refs: TaskActivityRef[]) => invoke<Record<string, TaskActivitySummary>>("list_task_activity", { refs });
export const listTasks = () => invoke<Task[]>("list_tasks");
export const setRelatedTasksForRepo = (repoPath: string, slug: string, related: RelatedTaskRef[]) => invoke<Task>("set_related_tasks_for_repo", { repoPath, slug, related });
export const writeDraftForRepo = (a: {
  repoPath: string;
  name: string;
  taskSlug: string;
  description: string;
  evidence: string;
  linearId: string;
  githubIssue: string;
  playbook: PlaybookRef;
  harness: string;
  model: string;
  autoAdvance?: string[] | null;
  maxLiveSessions: number;
  branchName: string;
  worktreeName: string;
  draftSlug: string;
}) => invoke<Task>("write_draft_for_repo", a);
export type ChatFileStat = { name: string; bytes: number };
export type CopyChatAttachmentsResult = { copied: string[]; failures: string[] };
export type ChatImage = { mime_type: string; data: string };
export const chatFileStat = (path: string) => invoke<ChatFileStat>("chat_file_stat", { path });
export const copyChatAttachments = (taskSlug: string, paths: string[]) => invoke<CopyChatAttachmentsResult>("copy_chat_attachments", { taskSlug, paths });
export const writeChatAttachmentBytes = (taskSlug: string, fileName: string, bytes: number[] | Uint8Array) =>
  invoke<string>("write_chat_attachment_bytes", { taskSlug, fileName, bytes });
export const readChatImage = (taskSlug: string, name: string) => invoke<ChatImage>("read_chat_image", { taskSlug, name });

// ── playbook.rs ───────────────────────────────────────────────────────
export const listKanbanColumns = (allRepos: boolean) => invoke<KanbanColumn[]>("list_kanban_columns", { allRepos });
export const listPlaybookCatalog = (repoPath?: string) => invoke<PlaybookCatalog>("list_playbook_catalog", { repoPath });
export const readPlaybook = (reference: PlaybookRef, repoPath?: string) => invoke<ScopedPlaybook>("read_playbook", { reference, repoPath });
export const validatePlaybookSource = (source: string) => invoke<PlaybookValidation>("validate_playbook_source", { source });
export const renderPlaybookSource = (definition: NormalizedPlaybook) => invoke<string>("render_playbook_source", { definition });
export const savePlaybookSource = (request: SavePlaybookRequest, repoPath?: string) => invoke<ScopedPlaybook>("save_playbook_source", { request, repoPath });
export const deletePlaybookSource = (reference: PlaybookRef, repoPath?: string) => invoke<void>("delete_playbook_source", { reference, repoPath });
export const readPlaybookPickerPreferences = () => invoke<PickerPreferences>("read_playbook_picker_preferences");
export const savePlaybookPickerPreferences = (preferences: PickerPreferences) => invoke<void>("save_playbook_picker_preferences", { preferences });

// ── update.rs ─────────────────────────────────────────────────────────
export const checkUpdate = () => invoke<UpdateStatus>("check_update");
export const downloadUpdate = (version: string) => invoke<StagedUpdate>("download_update", { version });
export const applyUpdate = (version: string) => invoke<void>("apply_update", { version });

// ── omp_update.rs ─────────────────────────────────────────────────────
export const checkOmpUpdate = () => invoke<OmpUpdateStatus>("check_omp_update");
export const updateOmp = () => invoke<string>("update_omp");
export const ompAgentSessionsDir = () => invoke<string>("omp_agent_sessions_dir");
export const readOmpModelRoles = () => invoke<Record<string, string>>("read_omp_model_roles");
export const writeOmpModelRoles = (roles: Record<string, string>) => invoke<Record<string, string>>("write_omp_model_roles", { roles });
