//! The typed request/reply wire for repo-file operations, run in-process for a local repo and
//! over a long-lived ssh stdio channel (hosted by `alinery-mcp --repo-service`) for a remote one.
//!
//! This is deliberately not daemon wire: the tag is `call`, not `op`, and it is always built
//! with serde. The runtime that serves it is installed by content hash beside the daemon, so it
//! always matches the app's build and needs no `PROTOCOL_VERSION`.
//!
//! Only host-level operations exist so far. Repo operations join `RepoOp` as their command
//! bodies move here from the app crate.

use crate::git::{classify_folder, init_absent_folder};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Directory listings stop here so a huge directory cannot stall the browse dialog.
pub const LIST_DIR_CAP: usize = 2000;

/// Ops are flattened into `RepoRequest`, whose own key is `id`: no variant may have a field
/// called `id`, or the two collide on the wire (the round-trip test covers every variant).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "call", rename_all = "snake_case")]
// One short-lived value per request, built and dropped on the spot: boxing the biggest variant buys nothing.
#[allow(clippy::large_enum_variant)]
pub enum RepoOp {
    Ping,
    /// Hold `<repo>/.alinery/.alinery-app.lock` for the life of the service process, as
    /// `claim_repo` does locally. Served only by the long-lived service host: the lock must
    /// outlive the call, and the kernel releases it when the ssh channel dies.
    ClaimRepo {
        repo: PathBuf,
    },
    ReleaseRepo {
        repo: PathBuf,
    },
    Classify {
        path: PathBuf,
    },
    Init {
        path: PathBuf,
    },
    ListDir {
        path: PathBuf,
        #[serde(default)]
        show_hidden: bool,
    },
    /// The board rows of one repo (`alinery_core::board::board_tasks`).
    ListBoardTasks {
        repo: PathBuf,
    },
    ListTasks {
        repo: PathBuf,
    },
    /// `null` when the task does not exist.
    GetTask {
        repo: PathBuf,
        slug: String,
    },
    /// A task's sessions with their display names, oldest first.
    ListSessions {
        repo: PathBuf,
        slug: String,
    },
    GetSessionDisplay {
        repo: PathBuf,
        slug: String,
        session_id: String,
    },
    SubtaskState {
        repo: PathBuf,
        slug: String,
    },
    /// The task's retained execution state and playbook, as stored.
    SavedExecution {
        repo: PathBuf,
        slug: String,
    },
    ListArtifactsWithMetadata {
        repo: PathBuf,
        slug: String,
    },
    ListTaskArtifactTree {
        repo: PathBuf,
        slug: String,
    },
    ReadTaskArtifactNode {
        repo: PathBuf,
        slug: String,
        node_id: String,
    },
    /// `null` when the session has no meta.
    ReadLaunchFields {
        repo: PathBuf,
        slug: String,
        session_id: String,
    },
    WorktreeExists {
        repo: PathBuf,
        slug: String,
    },
    /// Sets the user's name for a session; the reply is the stored name.
    RenameSession {
        repo: PathBuf,
        slug: String,
        session_id: String,
        name: String,
    },
    RenameTask {
        repo: PathBuf,
        slug: String,
        name: String,
    },
    MarkSessionNotificationRead {
        repo: PathBuf,
        slug: String,
        session_id: String,
    },
    /// Flags a session archived. Stopping its process is the daemon's job, done first.
    StampSessionArchived {
        repo: PathBuf,
        slug: String,
        session_id: String,
    },
    ArchiveTask {
        repo: PathBuf,
        slug: String,
    },
    /// A session's scrollback; the reply carries the bytes as base64.
    ReadSessionHistory {
        repo: PathBuf,
        slug: String,
        session_id: String,
        #[serde(default)]
        offset: Option<u64>,
        #[serde(default)]
        limit: Option<u64>,
    },
    /// One backward page of a session's journal.
    ReadOmpWindow {
        repo: PathBuf,
        slug: String,
        session_id: String,
        #[serde(default)]
        end: Option<u64>,
        #[serde(default)]
        want: Option<u64>,
    },
    ReadArtifact {
        repo: PathBuf,
        slug: String,
        name: String,
    },
    ListArtifactComments {
        repo: PathBuf,
        slug: String,
        artifact: String,
    },
    AddArtifactComment {
        repo: PathBuf,
        slug: String,
        artifact: String,
        comment: crate::artifact_comments::CommentInput,
    },
    /// Turns an artifact's comments into a review file; the reply is the host's path to it.
    ArchiveArtifactComments {
        repo: PathBuf,
        slug: String,
        artifact: String,
    },
    PrepareArtifactCommentsPrompt {
        repo: PathBuf,
        slug: String,
        artifacts: Vec<String>,
    },
    PrepareReviewApprovalPrompt {
        repo: PathBuf,
        slug: String,
        review_artifact: String,
    },
    FinalizeSessionMessageActions {
        repo: PathBuf,
        slug: String,
        session_id: String,
        actions: Vec<crate::artifact_comments::SessionMessageActionProvenance>,
    },
    ArtifactReviewPendingStatus {
        repo: PathBuf,
        slug: String,
        artifact: String,
    },
    ClearArtifactReviewPending {
        repo: PathBuf,
        slug: String,
        artifact: String,
    },
    ListCommentDrafts {
        repo: PathBuf,
        slug: String,
    },
    SaveCommentDraft {
        repo: PathBuf,
        slug: String,
        artifact: String,
        comment: crate::artifact_comments::CommentInput,
    },
    DeleteCommentDraft {
        repo: PathBuf,
        slug: String,
        artifact: String,
        anchor_id: String,
    },
    TaskSourceBranches {
        repo: PathBuf,
        #[serde(default)]
        selected_base_ref: Option<String>,
    },
    /// `git worktree remove --force` the task's worktree and clear it from the task.
    RemoveWorktree {
        repo: PathBuf,
        slug: String,
    },
    /// Push from the task's worktree with the host's git credentials; the reply is the compare URL.
    PushAndCompareUrl {
        repo: PathBuf,
        slug: String,
    },
    SetPrUrl {
        repo: PathBuf,
        slug: String,
        url: String,
    },
    CommitWorktree {
        repo: PathBuf,
        slug: String,
        message: String,
    },
    /// What a PR lookup needs from the repo (the stored link, the branch, the origin URL).
    TaskPullRequestInputs {
        repo: PathBuf,
        slug: String,
    },
    RecordDiscoveredPullRequest {
        repo: PathBuf,
        slug: String,
        branch: String,
        previous_url: String,
        url: String,
    },
    SubtaskManagerRequest {
        repo: PathBuf,
        slug: String,
        recover: bool,
    },
    /// The (owner task, session) pairs that discarding a sub-task has to stop first.
    SubtaskDiscardSessions {
        repo: PathBuf,
        slug: String,
        manager_session_id: String,
    },
    DiscardSubtask {
        repo: PathBuf,
        slug: String,
        manager_session_id: String,
    },
    /// The host's own path to an attachment, for "copy path on host".
    AttachmentPath {
        repo: PathBuf,
        slug: String,
        name: String,
    },
    ArtifactNodePath {
        repo: PathBuf,
        slug: String,
        node_id: String,
    },
    ReadChatImage {
        repo: PathBuf,
        slug: String,
        name: String,
    },
    /// An attachment (or artifact-tree attachment node) image; the reply carries the bytes as base64.
    ReadAttachmentImage {
        repo: PathBuf,
        slug: String,
        name: String,
        #[serde(default)]
        node_id: Option<String>,
    },
    /// Adds a file to the task's attachments under a unique name; the reply is the name it got.
    WriteAttachment {
        repo: PathBuf,
        slug: String,
        file_name: String,
        #[serde(with = "crate::rpc_chunk::base64_bytes")]
        data: Vec<u8>,
    },
    /// Chat threads of one repo. `repo_path` in each row is the host path.
    ListChatThreads {
        repo: PathBuf,
        include_archived: bool,
    },
    /// The chat thread's session meta; refuses an id that is not a chat thread.
    ChatThreadMeta {
        repo: PathBuf,
        session_id: String,
    },
    ChatThreadName {
        repo: PathBuf,
        session_id: String,
    },
    ChatBranchLabel {
        repo: PathBuf,
        session_id: String,
    },
    SetChatPinned {
        repo: PathBuf,
        session_id: String,
        pinned: bool,
    },
    /// The chat ops below that also touch a process run beside the host's own daemon.
    CreateChatThread {
        repo: PathBuf,
        app_config: PathBuf,
        model: String,
        create_worktree: bool,
    },
    ArchiveChatThread {
        repo: PathBuf,
        app_config: PathBuf,
        session_id: String,
        remove_worktree: bool,
    },
    RemoveChatWorktree {
        repo: PathBuf,
        app_config: PathBuf,
        session_id: String,
    },
    ResumeChatThread {
        repo: PathBuf,
        app_config: PathBuf,
        session_id: String,
    },
    WriteChatThreadAttachment {
        repo: PathBuf,
        session_id: String,
        file_name: String,
        #[serde(with = "crate::rpc_chunk::base64_bytes")]
        data: Vec<u8>,
    },
    ReadChatThreadImage {
        repo: PathBuf,
        session_id: String,
        name: String,
    },
    RestoreTask {
        repo: PathBuf,
        slug: String,
    },
    /// The create request for a copy of a task, built from its files; the app sends it to the daemon.
    DuplicateTaskPackage {
        repo: PathBuf,
        source_slug: String,
    },
    /// The repository's `config.toml` override layer (empty when the file is absent).
    ReadRepoOverrides {
        repo: PathBuf,
    },
    /// Replaces the override layer; `app_config` is where the settings audit line is logged.
    WriteRepoOverrides {
        repo: PathBuf,
        app_config: PathBuf,
        overrides: crate::RepoOverrides,
    },
    /// Every session row of the repo's unarchived tasks. `repo_path` is stamped on each row.
    ListSessionItems {
        repo: PathBuf,
        repo_path: String,
        include_archived: bool,
    },
    /// Metas for (task slug, session id) pairs, in order; `null` for one that is missing.
    ReadSessionMetas {
        repo: PathBuf,
        refs: Vec<(String, String)>,
    },
    SessionArtifactReady {
        repo: PathBuf,
        slug: String,
        session_id: String,
    },
    ClearSessionNotifications {
        repo: PathBuf,
        refs: Vec<crate::session_actions::SessionNotificationClearRef>,
    },
    /// Task activity from the host's files and the live session states the app observed.
    /// Result keys are built from `repo_path`.
    TaskActivity {
        repo: PathBuf,
        repo_path: String,
        slugs: Vec<String>,
        statuses: Vec<crate::daemon_client::DaemonSessionStatus>,
    },
    /// Autosave (or first save) of a task draft; the reply is the stored task.
    WriteDraft {
        repo: PathBuf,
        draft_slug: String,
        task_slug: String,
        name: String,
        description: String,
        evidence: String,
        linear_id: String,
        github_issue: String,
        playbook: crate::playbook::PlaybookRef,
        harness: String,
        model: String,
        #[serde(default)]
        auto_advance: Option<Vec<String>>,
        #[serde(default)]
        step_models: Option<std::collections::BTreeMap<String, String>>,
        max_live_sessions: u32,
        branch_name: String,
        worktree_name: String,
        #[serde(default)]
        draft_base_ref: Option<String>,
        #[serde(default)]
        draft_attachments: Option<crate::task_drafts::DraftAttachments>,
    },
    ReadDraftAttachments {
        repo: PathBuf,
        slug: String,
    },
    DeleteDraft {
        repo: PathBuf,
        slug: String,
    },
    /// The URL of the repository's `origin` remote, if it has one.
    GitOriginUrl {
        repo: PathBuf,
    },
    /// The repo's playbook files (library, committed playbooks, picker and import registry).
    ReadPlaybookTree {
        repo: PathBuf,
    },
    /// Changes to those files, applied only if each still holds what the sender started from.
    ApplyPlaybookTree {
        repo: PathBuf,
        changes: Vec<crate::playbook_tree::TreeChange>,
    },
    SetAutoApproveAll {
        repo: PathBuf,
        slug: String,
        enabled: bool,
    },
    /// Related tasks are paths on this host: the app refuses anything that is not.
    SetRelatedTasks {
        repo: PathBuf,
        slug: String,
        related: Vec<crate::RelatedTaskRef>,
    },
    /// The task's visible artifact names.
    ListArtifacts {
        repo: PathBuf,
        slug: String,
    },
    /// Where the pending review comments of an artifact are written for the agent.
    ArtifactCommentMarkdownPath {
        repo: PathBuf,
        slug: String,
        artifact: String,
    },
    /// The text of an attention notification for a task.
    SessionAttentionBody {
        repo: PathBuf,
        #[serde(default)]
        slug: Option<String>,
        reason: String,
    },
    /// Copy a review artifact between two repositories on this host and start the target session
    /// through the host's own daemon.
    SendReviewHandoff {
        source_repo: PathBuf,
        target_repo: PathBuf,
        app_config: PathBuf,
        request: crate::ReviewHandoffRequest,
    },
    /// Atomic, owner-only write (parent directories are created).
    WriteFile {
        path: PathBuf,
        contents: String,
    },
    /// Merge the Mac's provider credentials into the store at `path`; the reply holds the
    /// providers where this side is strictly newer. See `credential_sync`.
    SyncCredentials {
        path: PathBuf,
        entries: serde_json::Map<String, Value>,
    },
    /// Start the daemon detached so it outlives the ssh session that asked.
    SpawnDaemon {
        repo: PathBuf,
        app_config: PathBuf,
        binary: PathBuf,
        build_id: String,
        #[serde(default)]
        namespace: Option<String>,
        #[serde(default)]
        ownership_lib: Option<PathBuf>,
        log: PathBuf,
        launch: Launch,
        /// systemd unit name; required for `SystemdRun`.
        #[serde(default)]
        unit: Option<String>,
        /// A file holding the secret that lets the app control this daemon's UI-only ops over a
        /// forward. The daemon reads it and deletes it before it listens.
        #[serde(default)]
        ui_secret_file: Option<PathBuf>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Launch {
    /// `daemon_command` already `setsid`s the child.
    Direct,
    /// A transient user unit: survives logout only when the user is lingering.
    SystemdRun,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RepoRequest {
    pub id: u64,
    #[serde(flatten)]
    pub op: RepoOp,
}

/// Exactly one of `ok` / `err`. An enum, not two `Option`s: a successful reply with no payload
/// is `"ok":null`, which an `Option<Value>` reads back as absent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ReplyBody {
    Ok { ok: Value },
    Err { err: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoReply {
    pub id: u64,
    #[serde(flatten)]
    pub body: ReplyBody,
}

impl RepoReply {
    pub fn new(id: u64, result: Result<Value, String>) -> Self {
        let body = match result {
            Ok(ok) => ReplyBody::Ok { ok },
            Err(err) => ReplyBody::Err { err },
        };
        Self { id, body }
    }

    pub fn into_result(self) -> Result<Value, String> {
        match self.body {
            ReplyBody::Ok { ok } => Ok(ok),
            ReplyBody::Err { err } => Err(err),
        }
    }
}

/// The service sends its `Hello` unsolicited as the first reply, under this id, so the client
/// can tell the service from shell rc noise on the same stdout. Requests use ids from 1.
pub const HELLO_ID: u64 = 0;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hello {
    /// The service binary's package version; the content-hashed install makes it the app's own.
    pub runtime: String,
    pub pid: u32,
}

/// Raw bytes on the wire: base64, never a JSON number array.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireBytes {
    #[serde(with = "crate::rpc_chunk::base64_bytes")]
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireOmpWindow {
    pub start: u64,
    pub end: u64,
    pub length: u64,
    #[serde(with = "crate::rpc_chunk::base64_bytes")]
    pub data: Vec<u8>,
}

impl From<WireOmpWindow> for crate::OmpWindow {
    fn from(wire: WireOmpWindow) -> Self {
        Self {
            start: wire.start,
            end: wire.end,
            length: wire.length,
            data: wire.data,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirEntry {
    pub name: String,
    pub git: bool,
    pub symlink: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirListing {
    pub path: PathBuf,
    pub entries: Vec<DirEntry>,
    pub truncated: bool,
}

/// Subdirectories of `path`, sorted by name. Files are not listed: this feeds a folder picker.
pub fn list_dir(path: &Path, show_hidden: bool) -> Result<DirListing, String> {
    let read = std::fs::read_dir(path).map_err(|error| format!("read {}: {error}", path.display()))?;
    let mut entries = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !show_hidden && name.starts_with('.') {
            continue;
        }
        let full = entry.path();
        if !full.is_dir() {
            continue;
        }
        let symlink = entry.file_type().map(|kind| kind.is_symlink()).unwrap_or(false);
        entries.push(DirEntry {
            git: full.join(".git").exists(),
            name,
            symlink,
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    let truncated = entries.len() > LIST_DIR_CAP;
    entries.truncate(LIST_DIR_CAP);
    Ok(DirListing {
        path: path.to_path_buf(),
        entries,
        truncated,
    })
}

pub fn run(op: RepoOp) -> Result<Value, String> {
    match op {
        RepoOp::Ping => Ok(Value::Null),
        RepoOp::ClaimRepo { .. } | RepoOp::ReleaseRepo { .. } => Err("repo claims are held by the repo service host process".to_string()),
        RepoOp::Classify { path } => to_value(classify_folder(&path)?),
        RepoOp::Init { path } => to_value(init_absent_folder(&path)?),
        RepoOp::ListDir { path, show_hidden } => to_value(list_dir(&path, show_hidden)?),
        RepoOp::ListBoardTasks { repo } => to_value(crate::board::board_tasks(&repo, &repo.to_string_lossy())?),
        RepoOp::ListTasks { repo } => to_value(crate::board::list_tasks_checked(&repo)?),
        RepoOp::GetTask { repo, slug } => to_value(crate::board::read_task_opt(&repo, &slug)?),
        RepoOp::ListSessions { repo, slug } => to_value(crate::board::list_session_displays(&repo, &slug)?),
        RepoOp::GetSessionDisplay { repo, slug, session_id } => to_value(crate::board::session_display_context(&repo, &slug, &session_id)?),
        RepoOp::SubtaskState { repo, slug } => to_value(crate::subtask::subtask_manager_state(&repo, &slug)?),
        RepoOp::SavedExecution { repo, slug } => to_value(crate::board::saved_task_execution(&repo, &slug)?),
        RepoOp::ListArtifactsWithMetadata { repo, slug } => to_value(crate::board::artifacts_with_metadata(&repo, &slug)?),
        RepoOp::ListTaskArtifactTree { repo, slug } => to_value(crate::list_task_artifact_tree(&repo, &slug)?),
        RepoOp::ReadTaskArtifactNode { repo, slug, node_id } => to_value(crate::read_task_artifact_node(&repo, &slug, &node_id)?),
        RepoOp::ReadLaunchFields { repo, slug, session_id } => to_value(crate::read_meta_launch_fields(&repo, &slug, &session_id)),
        RepoOp::WorktreeExists { repo, slug } => to_value(crate::board::worktree_exists(&repo, &slug)?),
        RepoOp::RenameSession { repo, slug, session_id, name } => to_value(crate::set_session_name(&repo, &slug, &session_id, &name, crate::SessionNameSource::User)?.value),
        RepoOp::RenameTask { repo, slug, name } => to_value(crate::rename_task(&repo, &slug, &name)?),
        RepoOp::MarkSessionNotificationRead { repo, slug, session_id } => crate::session_actions::mark_notification_read(&repo, &slug, &session_id).map(|()| Value::Null),
        RepoOp::StampSessionArchived { repo, slug, session_id } => crate::session_actions::stamp_session_archived(&repo, &slug, &session_id).map(|()| Value::Null),
        RepoOp::ArchiveTask { repo, slug } => crate::session_actions::archive_task_on_disk(&repo, &slug).map(|()| Value::Null),
        RepoOp::ReadSessionHistory {
            repo,
            slug,
            session_id,
            offset,
            limit,
        } => to_value(WireBytes {
            data: crate::read_session_history(&repo, &slug, &session_id, offset, limit)?.data,
        }),
        RepoOp::ReadOmpWindow {
            repo,
            slug,
            session_id,
            end,
            want,
        } => {
            let window = crate::read_omp_window(&repo, &slug, &session_id, end, want)?;
            to_value(WireOmpWindow {
                start: window.start,
                end: window.end,
                length: window.length,
                data: window.data,
            })
        }
        RepoOp::ReadArtifact { repo, slug, name } => to_value(crate::artifact_comments::read_artifact_text(&repo, &slug, &name)?),
        RepoOp::ListArtifactComments { repo, slug, artifact } => to_value(crate::artifact_comments::load_artifact_comments_for(&repo, &slug, &artifact)?),
        RepoOp::AddArtifactComment { repo, slug, artifact, comment } => to_value(crate::artifact_comments::add_artifact_comment_for(
            &repo,
            &slug,
            &artifact,
            comment.anchor_id,
            comment.anchor_kind,
            comment.anchor_label,
            comment.anchor_excerpt,
            comment.line_start,
            comment.line_end,
            comment.body,
        )?),
        RepoOp::ArchiveArtifactComments { repo, slug, artifact } => {
            to_value(crate::artifact_comments::archive_artifact_comments_for(&repo, &slug, &artifact)?.display().to_string())
        }
        RepoOp::PrepareArtifactCommentsPrompt { repo, slug, artifacts } => to_value(crate::artifact_comments::prepare_artifact_comments_prompt_for(&repo, &slug, &artifacts)?),
        RepoOp::PrepareReviewApprovalPrompt { repo, slug, review_artifact } => {
            to_value(crate::artifact_comments::prepare_review_approval_prompt_for(&repo, &slug, &review_artifact)?)
        }
        RepoOp::FinalizeSessionMessageActions { repo, slug, session_id, actions } => {
            crate::artifact_comments::finalize_session_message_actions_for(&repo, &session_id, &slug, &actions).map(|()| Value::Null)
        }
        RepoOp::ArtifactReviewPendingStatus { repo, slug, artifact } => to_value(crate::artifact_comments::artifact_review_pending_status_for(&repo, &slug, &artifact)?),
        RepoOp::ClearArtifactReviewPending { repo, slug, artifact } => crate::artifact_comments::clear_artifact_review_pending_for(&repo, &slug, &artifact).map(|()| Value::Null),
        RepoOp::ListCommentDrafts { repo, slug } => to_value(crate::artifact_comments::list_artifact_comment_drafts_for(&repo, &slug)?),
        RepoOp::SaveCommentDraft { repo, slug, artifact, comment } => crate::artifact_comments::save_artifact_comment_draft_for(
            &repo,
            &slug,
            &artifact,
            comment.anchor_id,
            comment.anchor_kind,
            comment.anchor_label,
            comment.anchor_excerpt,
            comment.line_start,
            comment.line_end,
            comment.body,
        )
        .map(|()| Value::Null),
        RepoOp::DeleteCommentDraft { repo, slug, artifact, anchor_id } => {
            crate::artifact_comments::delete_artifact_comment_draft_for(&repo, &slug, &artifact, &anchor_id).map(|()| Value::Null)
        }
        RepoOp::TaskSourceBranches { repo, selected_base_ref } => to_value(crate::git_actions::task_source_branches(&repo, selected_base_ref.as_deref())?),
        RepoOp::RemoveWorktree { repo, slug } => crate::git_actions::remove_worktree(&repo, &slug).map(|()| Value::Null),
        RepoOp::PushAndCompareUrl { repo, slug } => to_value(crate::git_actions::push_and_compare_url(&repo, &slug)?),
        RepoOp::SetPrUrl { repo, slug, url } => crate::git_actions::set_pr_url_in(&repo, slug, url).map(|()| Value::Null),
        RepoOp::CommitWorktree { repo, slug, message } => crate::git_actions::commit_worktree_in(&repo, slug, message).map(|()| Value::Null),
        RepoOp::TaskPullRequestInputs { repo, slug } => to_value(crate::git_actions::pull_request_inputs(&repo, &slug)?),
        RepoOp::RecordDiscoveredPullRequest {
            repo,
            slug,
            branch,
            previous_url,
            url,
        } => crate::git_actions::record_discovered_pull_request_in(&repo, &slug, &branch, &previous_url, &url).map(|()| Value::Null),
        RepoOp::SubtaskManagerRequest { repo, slug, recover } => to_value(crate::subtask::subtask_manager_request(&repo, slug, recover)?),
        RepoOp::SubtaskDiscardSessions { repo, slug, manager_session_id } => to_value(crate::subtask_discard_sessions(&repo, &slug, &manager_session_id)?),
        RepoOp::DiscardSubtask { repo, slug, manager_session_id } => crate::discard_subtask(&repo, &slug, &manager_session_id).map(|_| Value::Null),
        RepoOp::AttachmentPath { repo, slug, name } => to_value(crate::attachments::attachment_path(&repo, &slug, &name)?),
        RepoOp::ArtifactNodePath { repo, slug, node_id } => to_value(crate::artifact_node_path(&repo, &slug, &node_id)?),
        RepoOp::ReadChatImage { repo, slug, name } => to_value(crate::attachments::read_chat_image(&repo, &slug, &name)?),
        RepoOp::ReadAttachmentImage { repo, slug, name, node_id } => to_value(WireBytes {
            data: crate::attachments::read_attachment_image(&repo, &slug, &name, node_id.as_deref())?,
        }),
        RepoOp::WriteAttachment { repo, slug, file_name, data } => to_value(crate::attachments::write_chat_attachment_bytes(&repo, &slug, &file_name, &data)?),
        RepoOp::ListChatThreads { repo, include_archived } => to_value(crate::chat::list_chat_threads_in(&[repo], include_archived)?),
        RepoOp::ChatThreadMeta { repo, session_id } => to_value(crate::chat::load_root_omp(&repo, &session_id)?),
        RepoOp::ChatThreadName { repo, session_id } => {
            crate::chat::load_root_omp(&repo, &session_id)?;
            to_value(crate::read_session_name(&repo, "", &session_id)?.map(|name| name.name))
        }
        RepoOp::ChatBranchLabel { repo, session_id } => to_value(crate::chat::chat_branch_of(&repo, &crate::chat::load_root_omp(&repo, &session_id)?)),
        RepoOp::SetChatPinned { repo, session_id, pinned } => crate::chat::set_chat_pinned_in(&repo, &session_id, pinned).map(|()| Value::Null),
        RepoOp::CreateChatThread {
            repo,
            app_config,
            model,
            create_worktree,
        } => {
            let daemon = host_daemon(&repo, &app_config).ok_or("daemon not connected")?;
            to_value(crate::chat::create_chat_thread_in(&repo, &daemon, &model, create_worktree)?)
        }
        RepoOp::ArchiveChatThread {
            repo,
            app_config,
            session_id,
            remove_worktree,
        } => crate::chat::archive_chat_thread_in(&repo, &session_id, remove_worktree, host_daemon(&repo, &app_config).as_ref()).map(|()| Value::Null),
        RepoOp::RemoveChatWorktree { repo, app_config, session_id } => {
            crate::chat::remove_chat_worktree_in(&repo, &session_id, host_daemon(&repo, &app_config).as_ref()).map(|()| Value::Null)
        }
        RepoOp::ResumeChatThread { repo, app_config, session_id } => to_value(crate::chat::resume_chat_thread_in(&repo, &session_id, host_daemon(&repo, &app_config).as_ref())?),
        RepoOp::WriteChatThreadAttachment {
            repo,
            session_id,
            file_name,
            data,
        } => to_value(crate::chat::write_chat_thread_attachment_bytes_in(&repo, &session_id, &file_name, &data)?),
        RepoOp::ReadChatThreadImage { repo, session_id, name } => to_value(crate::chat::read_chat_thread_image_in(&repo, &session_id, &name)?),
        RepoOp::RestoreTask { repo, slug } => crate::restore_task(&repo, &slug).map(|()| Value::Null),
        RepoOp::DuplicateTaskPackage { repo, source_slug } => to_value(crate::task_creation::duplicate_task_package(&repo, &source_slug)?),
        RepoOp::ReadRepoOverrides { repo } => to_value(crate::load_repo_overrides_strict(&repo)?),
        RepoOp::WriteRepoOverrides { repo, app_config, overrides } => crate::write_repo_overrides(Some(&app_config), &repo, &overrides).map(|()| Value::Null),
        RepoOp::ListSessionItems {
            repo,
            repo_path,
            include_archived,
        } => to_value(crate::board::session_list_items_for_repo(&repo, &repo_path, include_archived)?),
        RepoOp::ReadSessionMetas { repo, refs } => to_value(crate::board::read_session_metas(&repo, &refs)),
        RepoOp::SessionArtifactReady { repo, slug, session_id } => to_value(crate::board::session_artifact_ready(&repo, &slug, &session_id)),
        RepoOp::ClearSessionNotifications { repo, refs } => crate::session_actions::clear_session_notifications_in(&repo, &refs).map(|()| Value::Null),
        RepoOp::TaskActivity { repo, repo_path, slugs, statuses } => to_value(crate::task_activity::resolve_task_activity_for_repo(&repo, &repo_path, &slugs, &statuses)),
        RepoOp::WriteDraft {
            repo,
            draft_slug,
            task_slug,
            name,
            description,
            evidence,
            linear_id,
            github_issue,
            playbook,
            harness,
            model,
            auto_advance,
            step_models,
            max_live_sessions,
            branch_name,
            worktree_name,
            draft_base_ref,
            draft_attachments,
        } => to_value(crate::task_drafts::write_draft_in_with_slug(
            &repo,
            // Telemetry is about this person's own machine; the host records none.
            None,
            &draft_slug,
            &task_slug,
            name,
            description,
            evidence,
            linear_id,
            github_issue,
            playbook,
            harness,
            model,
            auto_advance,
            step_models,
            max_live_sessions,
            branch_name,
            worktree_name,
            draft_base_ref,
            draft_attachments,
        )?),
        RepoOp::ReadDraftAttachments { repo, slug } => to_value(crate::task_drafts::read_draft_attachments_in(&repo, &slug)?),
        RepoOp::DeleteDraft { repo, slug } => crate::task_drafts::delete_draft_in(&repo, None, &slug).map(|()| Value::Null),
        RepoOp::GitOriginUrl { repo } => to_value(git_origin_url(&repo)),
        RepoOp::ReadPlaybookTree { repo } => to_value(crate::playbook_tree::read_tree(&repo)?),
        RepoOp::ApplyPlaybookTree { repo, changes } => crate::playbook_tree::apply_changes(&repo, &changes).map(|()| Value::Null),
        RepoOp::SetAutoApproveAll { repo, slug, enabled } => to_value(crate::task::set_auto_approve_all_in(&repo, slug, enabled)?),
        RepoOp::SetRelatedTasks { repo, slug, related } => to_value(crate::task::set_related_tasks_in(&repo, slug, related)?),
        RepoOp::ListArtifacts { repo, slug } => to_value(crate::visible_artifact_names(&repo, &slug)?),
        RepoOp::ArtifactCommentMarkdownPath { repo, slug, artifact } => {
            to_value(crate::artifact_comments::artifact_comment_markdown_path(&repo, &slug, &artifact)?.display().to_string())
        }
        RepoOp::SessionAttentionBody { repo, slug, reason } => to_value(crate::session_actions::session_attention_body(&repo, slug, &reason)?),
        RepoOp::SendReviewHandoff {
            source_repo,
            target_repo,
            app_config,
            request,
        } => {
            let daemon = host_daemon(&target_repo, &app_config).ok_or("daemon not connected")?;
            to_value(crate::send_review_handoff_for_repos(&daemon, &source_repo, &target_repo, request)?)
        }
        RepoOp::WriteFile { path, contents } => write_file(&path, &contents).map(|()| Value::Null),
        RepoOp::SyncCredentials { path, entries } => to_value(crate::credential_sync::apply_incoming(&path, &entries)?),
        RepoOp::SpawnDaemon {
            repo,
            app_config,
            binary,
            build_id,
            namespace,
            ownership_lib,
            log,
            launch,
            unit,
            ui_secret_file,
        } => spawn_daemon(
            &repo,
            &app_config,
            &binary,
            &build_id,
            namespace.as_deref(),
            ownership_lib.as_deref(),
            &log,
            launch,
            unit.as_deref(),
            ui_secret_file.as_deref(),
        )
        .map(|()| Value::Null),
    }
}

/// The host's own daemon for `repo`, or none when it is not running or does not match this build.
fn host_daemon(repo: &Path, app_config: &Path) -> Option<crate::DaemonClient> {
    crate::connect_compatible_once(crate::alineryd_socket_path(repo, None), app_config)
        .ok()
        .map(|(client, _)| client)
}

fn git_origin_url(repo: &Path) -> Option<String> {
    let out = crate::git_cmd(repo).args(["remote", "get-url", "origin"]).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn write_file(path: &Path, contents: &str) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|error| format!("create {}: {error}", parent.display()))?;
    crate::write_owner_only_bytes(path, contents.as_bytes())
}

#[allow(clippy::too_many_arguments)]
fn spawn_daemon(
    repo: &Path,
    app_config: &Path,
    binary: &Path,
    build_id: &str,
    namespace: Option<&str>,
    ownership_lib: Option<&Path>,
    log: &Path,
    launch: Launch,
    unit: Option<&str>,
    ui_secret_file: Option<&Path>,
) -> Result<(), String> {
    use std::process::{Command, Stdio};
    if let Some(parent) = log.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("create {}: {error}", parent.display()))?;
    }
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
        .map_err(|error| format!("open {}: {error}", log.display()))?;
    let log_again = log_file.try_clone().map_err(|error| error.to_string())?;
    let mut daemon = crate::daemon_command(binary, repo, app_config, build_id.as_ref(), namespace, None);
    if let Some(library) = ownership_lib {
        daemon.env("ALINERY_OWNERSHIP_LIB", library);
    }
    if let Some(file) = ui_secret_file {
        daemon.arg("--ui-secret-file").arg(file);
    }
    daemon.stdout(log_file).stderr(log_again);
    match launch {
        Launch::Direct => {
            let mut child = daemon.spawn().map_err(|error| format!("spawn {}: {error}", binary.display()))?;
            // Reap it if it exits early; a daemon that lives on is not waited for.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            Ok(())
        }
        Launch::SystemdRun => {
            let unit = unit.ok_or("systemd_run needs a unit name")?;
            let mut run = Command::new("systemd-run");
            run.args(["--user", "--collect", "--quiet"])
                .arg(format!("--unit={unit}"))
                .arg(format!("--working-directory={}", repo.display()));
            for (key, value) in daemon.get_envs() {
                if let Some(value) = value {
                    run.arg(format!("--setenv={}={}", key.to_string_lossy(), value.to_string_lossy()));
                }
            }
            run.arg("--").arg(daemon.get_program()).args(daemon.get_args());
            let output = run.stdin(Stdio::null()).output().map_err(|error| format!("systemd-run: {error}"))?;
            output
                .status
                .success()
                .then_some(())
                .ok_or_else(|| format!("systemd-run failed: {}", String::from_utf8_lossy(&output.stderr).trim()))
        }
    }
}

fn to_value<T: Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Task;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ai-rs-{name}-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn every_op_round_trips_through_the_wire() {
        let ops = [
            RepoOp::Ping,
            RepoOp::ClaimRepo { repo: "/srv/a".into() },
            RepoOp::ReleaseRepo { repo: "/srv/a".into() },
            RepoOp::Classify { path: "/srv/a".into() },
            RepoOp::Init { path: "/srv/a".into() },
            RepoOp::ListDir {
                path: "/srv".into(),
                show_hidden: true,
            },
            RepoOp::ListBoardTasks { repo: "/srv/a".into() },
            RepoOp::ListTasks { repo: "/srv/a".into() },
            RepoOp::GetTask {
                repo: "/srv/a".into(),
                slug: "t".into(),
            },
            RepoOp::ListSessions {
                repo: "/srv/a".into(),
                slug: "t".into(),
            },
            RepoOp::GetSessionDisplay {
                repo: "/srv/a".into(),
                slug: "t".into(),
                session_id: "s".into(),
            },
            RepoOp::SubtaskState {
                repo: "/srv/a".into(),
                slug: "t".into(),
            },
            RepoOp::SavedExecution {
                repo: "/srv/a".into(),
                slug: "t".into(),
            },
            RepoOp::ListArtifactsWithMetadata {
                repo: "/srv/a".into(),
                slug: "t".into(),
            },
            RepoOp::ListTaskArtifactTree {
                repo: "/srv/a".into(),
                slug: "t".into(),
            },
            RepoOp::ReadTaskArtifactNode {
                repo: "/srv/a".into(),
                slug: "t".into(),
                node_id: "n".into(),
            },
            RepoOp::ReadLaunchFields {
                repo: "/srv/a".into(),
                slug: "t".into(),
                session_id: "s".into(),
            },
            RepoOp::WorktreeExists {
                repo: "/srv/a".into(),
                slug: "t".into(),
            },
            RepoOp::ReadArtifact {
                repo: "/srv/a".into(),
                slug: "t".into(),
                name: "01.md".into(),
            },
            RepoOp::ListArtifactComments {
                repo: "/srv/a".into(),
                slug: "t".into(),
                artifact: "01.md".into(),
            },
            RepoOp::AddArtifactComment {
                repo: "/srv/a".into(),
                slug: "t".into(),
                artifact: "01.md".into(),
                comment: crate::artifact_comments::CommentInput {
                    anchor_id: "a".into(),
                    anchor_kind: "heading".into(),
                    anchor_label: "L".into(),
                    anchor_excerpt: "E".into(),
                    line_start: 1,
                    line_end: 2,
                    body: "B".into(),
                },
            },
            RepoOp::ArchiveArtifactComments {
                repo: "/srv/a".into(),
                slug: "t".into(),
                artifact: "01.md".into(),
            },
            RepoOp::PrepareArtifactCommentsPrompt {
                repo: "/srv/a".into(),
                slug: "t".into(),
                artifacts: vec!["01.md".into()],
            },
            RepoOp::PrepareReviewApprovalPrompt {
                repo: "/srv/a".into(),
                slug: "t".into(),
                review_artifact: "r.md".into(),
            },
            RepoOp::FinalizeSessionMessageActions {
                repo: "/srv/a".into(),
                slug: "t".into(),
                session_id: "s".into(),
                actions: vec![crate::artifact_comments::SessionMessageActionProvenance::ReviewApproval { review_artifact: "r.md".into() }],
            },
            RepoOp::ArtifactReviewPendingStatus {
                repo: "/srv/a".into(),
                slug: "t".into(),
                artifact: "01.md".into(),
            },
            RepoOp::ClearArtifactReviewPending {
                repo: "/srv/a".into(),
                slug: "t".into(),
                artifact: "01.md".into(),
            },
            RepoOp::ListCommentDrafts {
                repo: "/srv/a".into(),
                slug: "t".into(),
            },
            RepoOp::SaveCommentDraft {
                repo: "/srv/a".into(),
                slug: "t".into(),
                artifact: "01.md".into(),
                comment: crate::artifact_comments::CommentInput {
                    anchor_id: "a".into(),
                    anchor_kind: "heading".into(),
                    anchor_label: "L".into(),
                    anchor_excerpt: "E".into(),
                    line_start: 1,
                    line_end: 2,
                    body: "B".into(),
                },
            },
            RepoOp::DeleteCommentDraft {
                repo: "/srv/a".into(),
                slug: "t".into(),
                artifact: "01.md".into(),
                anchor_id: "a".into(),
            },
            RepoOp::TaskSourceBranches {
                repo: "/srv/a".into(),
                selected_base_ref: Some("refs/heads/main".into()),
            },
            RepoOp::RemoveWorktree {
                repo: "/srv/a".into(),
                slug: "t".into(),
            },
            RepoOp::PushAndCompareUrl {
                repo: "/srv/a".into(),
                slug: "t".into(),
            },
            RepoOp::SetPrUrl {
                repo: "/srv/a".into(),
                slug: "t".into(),
                url: "https://github.com/o/r/pull/1".into(),
            },
            RepoOp::CommitWorktree {
                repo: "/srv/a".into(),
                slug: "t".into(),
                message: "m".into(),
            },
            RepoOp::TaskPullRequestInputs {
                repo: "/srv/a".into(),
                slug: "t".into(),
            },
            RepoOp::RecordDiscoveredPullRequest {
                repo: "/srv/a".into(),
                slug: "t".into(),
                branch: "b".into(),
                previous_url: String::new(),
                url: "https://github.com/o/r/pull/1".into(),
            },
            RepoOp::SubtaskManagerRequest {
                repo: "/srv/a".into(),
                slug: "t".into(),
                recover: true,
            },
            RepoOp::SubtaskDiscardSessions {
                repo: "/srv/a".into(),
                slug: "t".into(),
                manager_session_id: "m".into(),
            },
            RepoOp::DiscardSubtask {
                repo: "/srv/a".into(),
                slug: "t".into(),
                manager_session_id: "m".into(),
            },
            RepoOp::AttachmentPath {
                repo: "/srv/a".into(),
                slug: "t".into(),
                name: "a.png".into(),
            },
            RepoOp::ArtifactNodePath {
                repo: "/srv/a".into(),
                slug: "t".into(),
                node_id: "n".into(),
            },
            RepoOp::ReadChatImage {
                repo: "/srv/a".into(),
                slug: "t".into(),
                name: "a.png".into(),
            },
            RepoOp::ReadAttachmentImage {
                repo: "/srv/a".into(),
                slug: "t".into(),
                name: "a.png".into(),
                node_id: Some("n".into()),
            },
            RepoOp::WriteAttachment {
                repo: "/srv/a".into(),
                slug: "t".into(),
                file_name: "a.bin".into(),
                data: vec![0, 255, 7],
            },
            RepoOp::ListChatThreads {
                repo: "/srv/a".into(),
                include_archived: true,
            },
            RepoOp::ChatThreadMeta {
                repo: "/srv/a".into(),
                session_id: "s".into(),
            },
            RepoOp::ChatThreadName {
                repo: "/srv/a".into(),
                session_id: "s".into(),
            },
            RepoOp::ChatBranchLabel {
                repo: "/srv/a".into(),
                session_id: "s".into(),
            },
            RepoOp::SetChatPinned {
                repo: "/srv/a".into(),
                session_id: "s".into(),
                pinned: true,
            },
            RepoOp::CreateChatThread {
                repo: "/srv/a".into(),
                app_config: "/c/app.toml".into(),
                model: "m".into(),
                create_worktree: true,
            },
            RepoOp::ArchiveChatThread {
                repo: "/srv/a".into(),
                app_config: "/c/app.toml".into(),
                session_id: "s".into(),
                remove_worktree: true,
            },
            RepoOp::RemoveChatWorktree {
                repo: "/srv/a".into(),
                app_config: "/c/app.toml".into(),
                session_id: "s".into(),
            },
            RepoOp::ResumeChatThread {
                repo: "/srv/a".into(),
                app_config: "/c/app.toml".into(),
                session_id: "s".into(),
            },
            RepoOp::WriteChatThreadAttachment {
                repo: "/srv/a".into(),
                session_id: "s".into(),
                file_name: "a.bin".into(),
                data: vec![0, 255, 7],
            },
            RepoOp::ReadChatThreadImage {
                repo: "/srv/a".into(),
                session_id: "s".into(),
                name: "a.png".into(),
            },
            RepoOp::RestoreTask {
                repo: "/srv/a".into(),
                slug: "t".into(),
            },
            RepoOp::DuplicateTaskPackage {
                repo: "/srv/a".into(),
                source_slug: "t".into(),
            },
            RepoOp::ReadRepoOverrides { repo: "/srv/a".into() },
            RepoOp::WriteRepoOverrides {
                repo: "/srv/a".into(),
                app_config: "/c/app.toml".into(),
                overrides: crate::RepoOverrides::default(),
            },
            RepoOp::ListSessionItems {
                repo: "/srv/a".into(),
                repo_path: "alinery+ssh://h/srv/a".into(),
                include_archived: true,
            },
            RepoOp::ReadSessionMetas {
                repo: "/srv/a".into(),
                refs: vec![("t".into(), "s".into())],
            },
            RepoOp::SessionArtifactReady {
                repo: "/srv/a".into(),
                slug: "t".into(),
                session_id: "s".into(),
            },
            RepoOp::ClearSessionNotifications {
                repo: "/srv/a".into(),
                refs: vec![crate::session_actions::SessionNotificationClearRef {
                    repo_path: "k".into(),
                    task_slug: "t".into(),
                    id: "s".into(),
                    notification_suppression: None,
                }],
            },
            RepoOp::TaskActivity {
                repo: "/srv/a".into(),
                repo_path: "k".into(),
                slugs: vec!["t".into()],
                statuses: vec![crate::daemon_client::DaemonSessionStatus {
                    id: "s".into(),
                    state: Default::default(),
                    transport: Default::default(),
                }],
            },
            RepoOp::WriteDraft {
                repo: "/srv/a".into(),
                draft_slug: "d".into(),
                task_slug: "t".into(),
                name: "Name".into(),
                description: "desc".into(),
                evidence: String::new(),
                linear_id: String::new(),
                github_issue: String::new(),
                playbook: crate::playbook::PlaybookRef {
                    scope: crate::playbook::PlaybookScope::Repo,
                    key: "one-shot".into(),
                },
                harness: "omp".into(),
                model: "m".into(),
                auto_advance: Some(vec!["a".into()]),
                step_models: Some([("a".to_string(), "m".to_string())].into()),
                max_live_sessions: 3,
                branch_name: "b".into(),
                worktree_name: "w".into(),
                draft_base_ref: None,
                draft_attachments: Some(crate::task_drafts::DraftAttachments {
                    entries: vec!["e".into()],
                    images: vec![crate::task_drafts::DraftImage {
                        name: "a.png".into(),
                        bytes: vec![0, 255],
                        mime_type: "image/png".into(),
                    }],
                }),
            },
            RepoOp::ReadDraftAttachments {
                repo: "/srv/a".into(),
                slug: "d".into(),
            },
            RepoOp::DeleteDraft {
                repo: "/srv/a".into(),
                slug: "d".into(),
            },
            RepoOp::GitOriginUrl { repo: "/srv/a".into() },
            RepoOp::ReadPlaybookTree { repo: "/srv/a".into() },
            RepoOp::ApplyPlaybookTree {
                repo: "/srv/a".into(),
                changes: vec![
                    crate::playbook_tree::TreeChange {
                        path: ".alinery/playbooks/a/playbook.md".into(),
                        expected: Some(vec![0, 255]),
                        new: None,
                    },
                    crate::playbook_tree::TreeChange {
                        path: ".alinery/playbooks/b/playbook.md".into(),
                        expected: None,
                        new: Some(vec![1]),
                    },
                ],
            },
            RepoOp::SetAutoApproveAll {
                repo: "/srv/a".into(),
                slug: "t".into(),
                enabled: true,
            },
            RepoOp::SetRelatedTasks {
                repo: "/srv/a".into(),
                slug: "t".into(),
                related: vec![crate::RelatedTaskRef {
                    repo_path: "/srv/b".into(),
                    slug: "u".into(),
                    name: "U".into(),
                }],
            },
            RepoOp::ListArtifacts {
                repo: "/srv/a".into(),
                slug: "t".into(),
            },
            RepoOp::ArtifactCommentMarkdownPath {
                repo: "/srv/a".into(),
                slug: "t".into(),
                artifact: "01.md".into(),
            },
            RepoOp::SessionAttentionBody {
                repo: "/srv/a".into(),
                slug: Some("t".into()),
                reason: "idle".into(),
            },
            RepoOp::SendReviewHandoff {
                source_repo: "/srv/a".into(),
                target_repo: "/srv/b".into(),
                app_config: "/c/app.toml".into(),
                request: crate::ReviewHandoffRequest {
                    source_slug: "s".into(),
                    source_session: "x".into(),
                    source_artifact: "01.md".into(),
                    target_slug: "t".into(),
                    target_phase: "p".into(),
                    harness: "omp".into(),
                    model: "m".into(),
                    prompt_extra: String::new(),
                    start: true,
                },
            },
            RepoOp::RenameSession {
                repo: "/srv/a".into(),
                slug: "t".into(),
                session_id: "s".into(),
                name: "n".into(),
            },
            RepoOp::RenameTask {
                repo: "/srv/a".into(),
                slug: "t".into(),
                name: "n".into(),
            },
            RepoOp::MarkSessionNotificationRead {
                repo: "/srv/a".into(),
                slug: "t".into(),
                session_id: "s".into(),
            },
            RepoOp::StampSessionArchived {
                repo: "/srv/a".into(),
                slug: "t".into(),
                session_id: "s".into(),
            },
            RepoOp::ArchiveTask {
                repo: "/srv/a".into(),
                slug: "t".into(),
            },
            RepoOp::ReadSessionHistory {
                repo: "/srv/a".into(),
                slug: "t".into(),
                session_id: "s".into(),
                offset: Some(1),
                limit: Some(2),
            },
            RepoOp::ReadOmpWindow {
                repo: "/srv/a".into(),
                slug: "t".into(),
                session_id: "s".into(),
                end: None,
                want: Some(3),
            },
            RepoOp::WriteFile {
                path: "/srv/a/app.toml".into(),
                contents: "x=1\n".into(),
            },
            RepoOp::SyncCredentials {
                path: "/srv/c.json".into(),
                entries: serde_json::Map::from_iter([("p".to_string(), serde_json::json!({"expires": 1}))]),
            },
            RepoOp::SpawnDaemon {
                repo: "/srv/a".into(),
                app_config: "/srv/c/app.toml".into(),
                binary: "/srv/rt/d".into(),
                build_id: "abc".into(),
                namespace: Some("dev".into()),
                ownership_lib: Some("/srv/rt/lib.so".into()),
                log: "/srv/c/logs/d.log".into(),
                launch: Launch::SystemdRun,
                unit: Some("alinery-daemon-abc".into()),
                ui_secret_file: Some("/srv/c/ui-secrets/abc.secret".into()),
            },
        ];
        for (id, op) in ops.into_iter().enumerate() {
            let request = RepoRequest { id: id as u64, op };
            let line = serde_json::to_string(&request).unwrap();
            assert!(line.contains("\"call\""), "{line}");
            // Only a top-level op field can collide with the request id; nested objects may have their own `id`.
            let fields = serde_json::to_value(&request.op).unwrap();
            assert!(fields.get("id").is_none(), "an op field collides with the request id: {line}");
            assert!(!line.contains("\"op\""), "{line}");
            assert_eq!(serde_json::from_str::<RepoRequest>(&line).unwrap(), request);
        }
    }

    #[test]
    fn list_dir_defaults_to_hiding_dotfolders() {
        let line = r#"{"id":1,"call":"list_dir","path":"/srv"}"#;
        let request: RepoRequest = serde_json::from_str(line).unwrap();
        assert_eq!(
            request.op,
            RepoOp::ListDir {
                path: "/srv".into(),
                show_hidden: false
            }
        );
    }

    #[test]
    fn reply_carries_exactly_one_side() {
        let ok = RepoReply::new(7, Ok(Value::Bool(true)));
        assert_eq!(serde_json::to_string(&ok).unwrap(), r#"{"id":7,"ok":true}"#);
        assert_eq!(ok.into_result(), Ok(Value::Bool(true)));
        let err = RepoReply::new(8, Err("nope".into()));
        assert_eq!(serde_json::to_string(&err).unwrap(), r#"{"id":8,"err":"nope"}"#);
        assert_eq!(err.into_result(), Err("nope".into()));
        // A payload-less success is `"ok":null` and must read back as success, not as nothing.
        let unit = RepoReply::new(9, Ok(Value::Null));
        let line = serde_json::to_string(&unit).unwrap();
        assert_eq!(line, r#"{"id":9,"ok":null}"#);
        assert_eq!(serde_json::from_str::<RepoReply>(&line).unwrap().into_result(), Ok(Value::Null));
        assert!(serde_json::from_str::<RepoReply>(r#"{"id":10}"#).is_err(), "neither side is malformed");
    }

    #[test]
    fn list_dir_lists_sorted_folders_with_git_badges_and_hides_dotfolders() {
        let root = temp_dir("list");
        fs::create_dir_all(root.join("beta/.git")).unwrap();
        fs::create_dir_all(root.join("alpha")).unwrap();
        fs::create_dir_all(root.join(".hidden")).unwrap();
        fs::write(root.join("file.txt"), "x").unwrap();

        let listing = list_dir(&root, false).unwrap();
        let names: Vec<_> = listing.entries.iter().map(|entry| (entry.name.as_str(), entry.git)).collect();
        assert_eq!(names, [("alpha", false), ("beta", true)]);
        assert!(!listing.truncated);
        assert_eq!(list_dir(&root, true).unwrap().entries.len(), 3);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn board_reads_over_the_wire_equal_the_in_process_projection() {
        let repo = temp_dir("board");
        let task = Task {
            name: "Wire task".into(),
            slug: "wire-task".into(),
            branch: "wire-task".into(),
            created: 1_700_000_000,
            ..Default::default()
        };
        let dir = repo.join(".alinery/tasks/wire-task");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("task.md"), toml::to_string(&task).unwrap()).unwrap();

        let direct = serde_json::to_value(crate::board::board_tasks(&repo, &repo.to_string_lossy()).unwrap()).unwrap();
        let over_wire = run(RepoOp::ListBoardTasks { repo: repo.clone() }).unwrap();
        assert_eq!(over_wire, direct);
        assert_eq!(over_wire[0]["slug"], "wire-task", "the task fields are flattened into the row");
        assert_eq!(run(RepoOp::ListTasks { repo: repo.clone() }).unwrap()[0]["name"], "Wire task");
        assert_eq!(
            run(RepoOp::GetTask {
                repo: repo.clone(),
                slug: "wire-task".into()
            })
            .unwrap()["slug"],
            "wire-task"
        );
        assert_eq!(
            run(RepoOp::GetTask {
                repo: repo.clone(),
                slug: "absent".into()
            })
            .unwrap(),
            Value::Null
        );
        // A malformed task.md is a reported fault, not a missing task.
        fs::write(dir.join("task.md"), "not = [valid").unwrap();
        assert!(run(RepoOp::GetTask {
            repo: repo.clone(),
            slug: "wire-task".into()
        })
        .is_err());
        assert!(run(RepoOp::ListBoardTasks { repo: repo.clone() }).is_err());
        fs::remove_dir_all(repo).unwrap();
    }

    #[test]
    fn write_file_creates_parents_and_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let root = temp_dir("write");
        let path = root.join("config/id/app.toml");
        run(RepoOp::WriteFile {
            path: path.clone(),
            contents: "a=1\n".into(),
        })
        .unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "a=1\n");
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sync_credentials_reports_what_the_host_holds_newer() {
        let root = temp_dir("sync");
        let path = root.join("provider-credentials.json");
        fs::write(&path, r#"{"oauth":{"expires":900}}"#).unwrap();
        let entries = serde_json::Map::from_iter([
            ("oauth".to_string(), serde_json::json!({"expires": 100})),
            ("key".to_string(), serde_json::json!({"type": "api_key"})),
        ]);
        let newer = run(RepoOp::SyncCredentials { path: path.clone(), entries }).unwrap();
        assert_eq!(newer, serde_json::json!({"oauth": {"expires": 900}}));
        assert!(fs::read_to_string(&path).unwrap().contains("api_key"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn spawn_daemon_launches_detached_with_the_shared_recipe_and_logs_output() {
        let root = temp_dir("spawn");
        let binary = root.join("fake-daemon");
        // Print the arguments and the one env var the repo service adds, then exit.
        fs::write(&binary, "#!/bin/sh\necho \"args: $*\"\necho \"lib: $ALINERY_OWNERSHIP_LIB\"\n").unwrap();
        fs::set_permissions(&binary, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let log = root.join("logs/d.log");
        run(RepoOp::SpawnDaemon {
            repo: root.join("repo"),
            app_config: root.join("app.toml"),
            binary,
            build_id: "hash1".into(),
            namespace: Some("ns".into()),
            ownership_lib: Some("/opt/lib.so".into()),
            log: log.clone(),
            launch: Launch::Direct,
            unit: None,
            ui_secret_file: Some(root.join("ui.secret")),
        })
        .unwrap();
        let mut text = String::new();
        for _ in 0..100 {
            text = fs::read_to_string(&log).unwrap_or_default();
            if text.contains("lib:") {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(text.contains("--repo"), "{text}");
        assert!(text.contains("--build-id hash1"), "{text}");
        assert!(text.contains("--socket-namespace ns"), "{text}");
        assert!(text.contains("lib: /opt/lib.so"), "{text}");
        assert!(text.contains(&format!("--ui-secret-file {}", root.join("ui.secret").display())), "{text}");
        assert!(run(RepoOp::SpawnDaemon {
            launch: Launch::SystemdRun,
            unit: None,
            repo: root.clone(),
            app_config: root.clone(),
            binary: root.clone(),
            build_id: "x".into(),
            namespace: None,
            ownership_lib: None,
            log,
            ui_secret_file: None,
        })
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn run_classifies_and_reports_missing_directories() {
        let root = temp_dir("classify");
        let value = run(RepoOp::Classify { path: root.clone() }).unwrap();
        assert_eq!(value["kind"], "absent");
        assert!(run(RepoOp::ListDir {
            path: root.join("missing"),
            show_hidden: false
        })
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
