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
import type { SessionControls, VinculumTranscript } from "./chatTranscript";
import type { DaemonRpc, DaemonRpcCancel } from "./daemon/bridgeFetch";
import type {
  AccountSignOutResult,
  AccountStatus,
  AppConfig,
  AppearancePrefs,
  CommunityMineResult,
  CommunityPlaybookPage,
  CommunitySourceResult,
  ConnectionStatus,
  DesktopCreditsView,
  GitHubIssue,
  GlobalSettings,
  HostEntry,
  HostedCatalogView,
  HostTestReport,
  LinearTicket,
  McpStatus,
  PreviewResult,
  PublishResult,
  PullRequest,
  RemoteDirListing,
  RemoteHostView,
  RemoteSharingView,
  RemoteStatusRow,
  ShellDaemonStatus,
  SshTarget,
  StagedUpdate,
  TakeoverOutcome,
  TakeoverPreview,
  UpdateStatus,
} from "./types";

export { getName, getVersion } from "@tauri-apps/api/app";

import { listen } from "@tauri-apps/api/event";

export { homeDir } from "@tauri-apps/api/path";
export type { Webview } from "@tauri-apps/api/webview";
export { getCurrentWebview } from "@tauri-apps/api/webview";
export { getCurrentWindow } from "@tauri-apps/api/window";
export { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
// ── platform (non-command Tauri APIs) ─────────────────────────────────
// Re-exported rather than imported directly by consumers, so the boundary gate has a
// single file to police and tests have a single module to mock.
export { Channel, listen };

// ── app_config.rs ─────────────────────────────────────────────────────
export type PickedFolder = { kind: "checkout"; root: string } | { kind: "absent"; path: string } | { kind: "refused"; message: string };

export type InitializedFolder = { kind: "initialized"; root: string } | { kind: "already_checkout"; root: string };

export const pickAttachmentFilesDialog = () => invoke<string[]>("pick_attachment_files_dialog");
export const pickRepoDialog = () => invoke<string | null>("pick_repo_dialog");
export const classifyPickedFolder = (path: string) => invoke<PickedFolder>("classify_picked_folder", { path });
export const initPickedFolder = (path: string) => invoke<InitializedFolder>("init_picked_folder", { path });
export const readAppConfig = () => invoke<AppConfig>("read_app_config");
export const removeRepo = (path: string) => invoke<AppConfig>("remove_repo", { path });
export const setActiveRepo = (path: string) => invoke<AppConfig>("set_active_repo", { path });
export const writeAppearance = (appearance: AppearancePrefs) => invoke<AppConfig>("write_appearance", { appearance });

// ── remote.rs ─────────────────────────────────────────────────────────
// A failed connect whose message starts with HOST_KEY_UNKNOWN (remoteRepo.ts) means first
// contact with the host: confirm with the user, then connect again with trust = true.
export const listHosts = () => invoke<HostEntry[]>("list_hosts");
export const setHostOnboarded = (hostId: string, onboarded: boolean) => invoke<void>("set_host_onboarded", { hostId, onboarded });
export const remoteHosts = () => invoke<RemoteHostView[]>("remote_hosts");
export const remoteAddHost = (destination: string, label?: string) => invoke<RemoteHostView>("remote_add_host", { destination, label: label ?? null });
export const remoteSshAliases = () => invoke<string[]>("remote_ssh_aliases");
export const remoteDescribeDestination = (destination: string) => invoke<SshTarget>("remote_describe_destination", { destination });
export const remoteTestHost = (destination: string, trust: boolean) => invoke<HostTestReport>("remote_test_host", { destination, trust });
export const remoteDiscardHost = (hostId: string) => invoke<void>("remote_discard_host", { hostId });
export const remoteConnect = (hostId: string, trust: boolean) => invoke<void>("remote_connect", { hostId, trust });
export const remoteDisconnect = (hostId: string) => invoke<void>("remote_disconnect", { hostId });
export const remoteSharing = (hostId: string) => invoke<RemoteSharingView>("remote_sharing", { hostId });
export const remoteSetSharing = (hostId: string, shared: string[]) => invoke<RemoteSharingView>("remote_set_sharing", { hostId, shared });
export const remoteListDir = (hostId: string, path: string, showHidden: boolean) => invoke<RemoteDirListing>("remote_list_dir", { hostId, path, showHidden });
export const remoteClassify = (hostId: string, path: string) => invoke<PickedFolder>("remote_classify", { hostId, path });
export const remoteInit = (hostId: string, path: string) => invoke<InitializedFolder>("remote_init", { hostId, path });
export const remoteAddRepo = (hostId: string, path: string) => invoke<string>("remote_add_repo", { hostId, path });
export const removeRemoteRepoKeepRunning = (path: string) => invoke<AppConfig>("remove_remote_repo_keep_running", { path });

// ── backup.rs ─────────────────────────────────────────────────────────
export const pickBackupDestinationDialog = (repoPath: string) => invoke<string | null>("pick_backup_destination_dialog", { repoPath });
export const restoreBackup = (repoPath: string | null, backupPath: string) => invoke<void>("restore_backup", { repoPath, backupPath });

// ── daemon.rs ─────────────────────────────────────────────────────────
export const cancelQuit = () => invoke<void>("cancel_quit");
export const closeAllRepos = () => invoke<number>("close_all_repos");
// daemon_rpc.rs: the webview bridge (plan 2.1.9). The body goes raw; the call and the Channel ride in headers.
// Non-ASCII is escaped so the JSON is a legal header value.
const asciiJson = (v: unknown) => JSON.stringify(v).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
export const daemonRpc =
  (repo: string): DaemonRpc =>
  async (callId, path, headers, body, onMessage) => {
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (m) => onMessage(new Uint8Array(m));
    await invoke<void>("daemon_rpc", body, {
      headers: { "x-alinery-rpc": asciiJson({ repo, call_id: callId, path, headers }), "x-alinery-channel": channel.toJSON() },
    });
  };
export const daemonRpcCancel: DaemonRpcCancel = (callId) => {
  invoke<void>("daemon_rpc_cancel", { callId }).catch(() => {});
};
export const daemonStatus = () => invoke<ShellDaemonStatus>("daemon_status");
export const stopDaemon = (path: string | null) => invoke<void>("stop_daemon", { path });
export const prepareRepoTakeover = (repoPath: string, ownerLane: string) => invoke<TakeoverPreview>("prepare_repo_takeover", { repoPath, ownerLane });
export const confirmRepoTakeover = (confirmationId: string) => invoke<TakeoverOutcome>("confirm_repo_takeover", { confirmationId });
export const cancelRepoTakeover = (confirmationId: string) => invoke<void>("cancel_repo_takeover", { confirmationId });

// ── git_ops.rs ────────────────────────────────────────────────────────
export const lookupTaskPullRequest = (prUrl: string, branch: string, originUrl: string | null) =>
  invoke<PullRequest | null>("lookup_task_pull_request", { prUrl, branch, originUrl });

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
/** The request goes out from this machine with this machine's credentials. `originUrl` (the repo's `origin`, for a bare `#123`) and `tokenOverride` (its settings row's GitHub token, null: none) come from the repository's daemon (sync/imports.ts). */
export const importGithubForRepo = (repoPath: string, reference: string, originUrl: string | null, tokenOverride: string | null) =>
  invoke<GitHubIssue>("import_github_for_repo", { repoPath, reference, originUrl, tokenOverride });
export const importLinearForRepo = (repoPath: string, reference: string) => invoke<LinearTicket>("import_linear_for_repo", { repoPath, reference });

// ── mcp.rs ────────────────────────────────────────────────────────────
export const mcpStatus = () => invoke<McpStatus>("mcp_status");
export const startMcpServer = () => invoke<McpStatus>("start_mcp_server");
export const stopMcpServer = () => invoke<McpStatus>("stop_mcp_server");

// ── notify.rs ─────────────────────────────────────────────────────────
/** Shows an OS notification. The text is the caller's: it comes from the session entity, so the shell reads no file. */
export const notifySessionAttention = (body: string) => invoke<void>("notify_session_attention", { body });
export const notifyTest = () => invoke<void>("notify_test");
export const setDockBadgeCount = (count: number) => invoke<void>("set_dock_badge_count", { count });

// ── session.rs ────────────────────────────────────────────────────────

/** Repos open in this window (owned, daemon connected): the only repos chat lists or offers. */
export const listChatRepos = () => invoke<string[]>("list_chat_repos");
/**
 * Refreshes the hosted-model credentials the daemon reads at spawn; run before a start, create, spawn or resume that may launch a
 * hosted model. `harness` is a hint for that refresh and nothing else; unset means the default harness.
 */
export const prepareHostedInference = (model: string, harness?: string) => invoke<void>("prepare_hosted_inference", { model, harness });
export type { SessionControls, VinculumTranscript };

// ── settings.rs ───────────────────────────────────────────────────────
export const grokKeyReady = () => invoke<boolean>("grok_key_ready");
export const readGlobalSettings = () => invoke<GlobalSettings>("read_global_settings");
export const readModelFavorites = (harness: string) => invoke<string[]>("read_model_favorites", { harness });
export const setModelFavorite = (harness: string, model: string, favorite: boolean) => invoke<string[]>("set_model_favorite", { harness, model, favorite });
export const writeGlobalSettings = (global: GlobalSettings) => invoke<GlobalSettings>("write_global_settings", { global });

// ── task.rs ───────────────────────────────────────────────────────────
export type ChatFileStat = { name: string; bytes: number };
export type CopyChatAttachmentsResult = { copied: string[]; failures: string[] };
export type ChatImage = { mime_type: string; data: string };
/** A local file's bytes (25 MB at most), for the webview to upload through BlobService. */
export const readLocalFile = (path: string) => invoke<ArrayBuffer>("read_local_file", { path });
/** The backup an archive waits for; rejects when it fails so the task is left as it was. */
export const chatFileStat = (path: string) => invoke<ChatFileStat>("chat_file_stat", { path });

// ── community_playbooks.rs ────────────────────────────────────────────
// The network half of the community library, with this machine's account. The registry and the import rules are the repository's daemon
// (sync/community.ts); a downloaded package reaches it as a staged upload.
export const listCommunityPlaybooks = (args: { q?: string; cursor?: string }) => invoke<CommunityPlaybookPage>("list_community_playbooks", args);
export const listMyCommunityPlaybooks = () => invoke<CommunityMineResult>("list_my_community_playbooks");
export const communityRemoteStatus = (ids: string[]) => invoke<RemoteStatusRow[]>("community_remote_status", { ids });
export const downloadCommunitySource = (id: string) => invoke<CommunitySourceResult>("download_community_source", { id });
export const previewCommunityPlaybook = (args: { id: string }) => invoke<PreviewResult>("preview_community_playbook", args);
/** `source` is the playbook as the repository's daemon holds it and `key` its declared key. */
export const publishCommunityPlaybook = (args: { source: string; key: string; label?: string }) => invoke<PublishResult>("publish_community_playbook", args);

// ── update.rs ─────────────────────────────────────────────────────────
export const checkUpdate = () => invoke<UpdateStatus>("check_update");
export const downloadUpdate = (version: string) => invoke<StagedUpdate>("download_update", { version });
export const applyUpdate = (version: string) => invoke<void>("apply_update", { version });

// ── vinculum_customizations.rs ────────────────────────────────────────
// The Finder window and the file picker; the agent directory itself is the daemon's (sync/agent.ts).
export const openVinculumAgentDir = () => invoke<void>("open_vinculum_agent_dir");
export const pickVinculumSkillDialog = () => invoke<string | null>("pick_vinculum_skill_dialog");

/**
 * A remote host was connected (the first time, or brought back after it dropped). A pane that lost
 * its stream while the host was away rejoins here. Returns the unlisten.
 */
export function onRemoteHostConnected(handler: () => void): () => void {
  let disposed = false;
  let stop: (() => void) | null = null;
  void listen("remote_host_connected", () => {
    if (!disposed) handler();
  }).then((unlisten) => {
    if (disposed) unlisten();
    else stop = unlisten;
  });
  return () => {
    disposed = true;
    stop?.();
  };
}
