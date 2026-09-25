//! The app crate's unit tests, one file per owning module in src/.
//!
//! This was a single 4,600-line tests.rs. Splitting it makes "where does my test go"
//! answerable by looking at which module the code under test lives in, and stops every
//! new test from being appended to the same file.
//!
//! Shared imports and fixtures live here; each child starts with `use super::*`.
pub(crate) use super::{
    account_auth_path_in, account_lock_path, account_status_from_path, accounts_url, active_github_repo, add_artifact_comment_for, alineryd_socket_namespace_for,
    allow_root_session_open, apply_credits_to_hosted_view, archive_artifact_comments_for, artifact_comment_drafts_path, artifact_comment_json_path, artifact_comment_markdown_path,
    artifact_file_path, artifact_review_pending_path, artifact_review_pending_status_for, artifacts_dir, attach_repo_daemon, attachment_path_in, backup_now_with,
    backup_queue_lock, begin_sign_in_attempt, board_tasks_for_repo, cancel_sign_in_at, classify_refresh_response, classify_version, clear_artifact_review_pending_for,
    clear_curated_alinery_data, clear_linear_account_in, commit_worktree_in, compare_url, configure_detached_process, copy_task_attachments, credits_view_from, curl_http,
    curl_request, curl_request_with_timeouts, current_alineryd_socket_path, delete_artifact_comment_draft_for, delete_draft_in, discard_subtask_with, display_label,
    end_sign_in_attempt, entitlement_url, fetch_desktop_credits_at, file_content_id, finalize_session_message_actions_for, finish_sign_in, frame_session_channel_bytes, git_cmd,
    git_top_level, github_repo_from_remote, gui_lock_held_elsewhere, hold_lock_after_compare_then_clear, hosted_refresh_needed, inference_path, is_hosted_model, is_paid_plan,
    linear_account_path_in, list_artifact_comment_drafts_for, list_artifacts_for, list_tasks_for_repo, load_artifact_comment_drafts_for, load_artifact_comments_for, loopback_html,
    next_artifact_review_markdown_path, paid_from_stored_plan, parse_desktop_credits_body, parse_desktop_login_callback, parse_entitlement_plan, parse_github_ref,
    parse_hosted_catalog_body, parse_hosted_error, parse_linear_oauth_tokens, parse_linear_ref, parse_oauth_callback, percent_encode, pkce_challenge, plan_label,
    prepare_artifact_comments_prompt_for, prepare_review_approval_prompt_for, production_livemode, pump_session_stream, read_model_favorites_in, read_task, read_task_opt,
    refresh_account_at, refresh_hosted_inference_for_spawn_at, register_runtime_plugins, remove_mcp_lane_runtime_files, remove_repo_from_config, require_repo_owned,
    resolve_hosted_catalog, restore_backup_into, root_sessions_dir, route_socket_path, sanitize_app_config, sanitize_appearance, save_artifact_comment_draft_for,
    session_list_items_for_repo, session_meta_path, sessions_dir, set_active_repo_global, set_model_favorite_in, sign_out_at, store_credits_snapshot, subtask_state_in,
    sync_hosted_inference, task_dir, unique_attachment_name, validate_known_target_repo, wait_for_daemon_gone, wait_for_desktop_login_callback,
    wait_for_desktop_login_callback_until, wait_for_linear_callback, worktree_exists, worktrees_dir, write_draft_in_with_slug, write_global_settings_in, write_task,
    AccountAuthError, AccountUser, AppConfig, AppState, AppearancePrefs, ArtifactCommentDraftsFile, ArtifactCommentsFile, BackupSlot, Command, DesktopCreditsView,
    EnsureDaemonError, LinearTokenError, OAuthCallback, SessionMessageActionProvenance, SessionMeta, SignInAttempt, SignInGuard, Task, DEFAULT_CONFIG_TOML,
    HOSTED_MODEL_UNAVAILABLE, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_SET_BYTES, PROTOCOL_VERSION, SESSION_CHANNEL_BATCH_BYTES, TAURI_RAW_FETCH_MIN_BYTES,
};
pub(crate) use alinery_core::{
    alinery_app_lock_path, hosted_models_yml_unavailable, models_yml_path, parse_inference_session_body, render_models_yml, strip_terminal_queries, subst, wipe_hosted_files,
    write_hosted_models_yml, HarnessFile, RepoOverrides, DEFAULT_HARNESSES_TOML,
};
pub(crate) use std::sync::Mutex;
pub(crate) use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
pub(crate) use std::{fs, io::Write, path::Path};

mod account;
mod app_config;
mod artifacts;
mod backup;
mod connections;
mod daemon;
mod git_ops;
mod hosted;
mod imports;
mod notify;
mod omp_update;
mod paths;
mod session;
mod settings;
mod subtask;
mod task;
mod telemetry;
mod update;

// worktree_exists / create_session's archived-task guard both read the process-global
// ACTIVE_REPO; serialize the handful of tests that mutate it so parallel test threads
// never stomp on each other's active repo.
static ACTIVE_REPO_TEST_LOCK: Mutex<()> = Mutex::new(());

// Real `git init` + one empty commit so `git checkout -b` has a HEAD to fork from.
fn init_git_test_repo(name: &str) -> std::path::PathBuf {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-{name}-{n}"));
    fs::create_dir_all(&repo).unwrap();
    let run = |args: &[&str]| {
        let out = git_cmd(&repo).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
    };
    run(&["init", "-q"]);
    run(&["config", "user.email", "test@alinery.local"]);
    run(&["config", "user.name", "alinery Test"]);
    run(&["commit", "--allow-empty", "-q", "-m", "init"]);
    repo
}

fn default_playbook_key() -> String {
    "superdevelop".into()
}

fn create_task_for_test(repo: &Path, name: &str, use_worktree: bool, branch_name: &str, worktree_name: &str) -> Task {
    let slug = alinery_core::slugify(name);
    let branch = if branch_name.is_empty() { slug.clone() } else { branch_name.to_string() };
    let worktree = if use_worktree {
        let path = worktrees_dir(repo).join(if worktree_name.is_empty() { &slug } else { worktree_name });
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let out = git_cmd(repo).args(["worktree", "add", "-b", &branch]).arg(&path).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        path
    } else {
        repo.to_path_buf()
    };
    let task = Task {
        name: name.into(),
        slug,
        branch,
        worktree: worktree.to_string_lossy().into_owned(),
        has_worktree: use_worktree,
        created: 1,
        ..Default::default()
    };
    fs::create_dir_all(sessions_dir(repo, &task.slug)).unwrap();
    fs::create_dir_all(artifacts_dir(repo, &task.slug)).unwrap();
    write_task(repo, &task).unwrap();
    task
}

fn write_retained_discovery_task(repo: &Path, slug: &str, lane: &str, archived: bool) -> Task {
    let source = include_str!("../../playbooks/one-shot/playbook.md");
    let reference = alinery_core::playbook::PlaybookRef {
        scope: alinery_core::playbook::PlaybookScope::Repo,
        key: "one-shot".into(),
    };
    let task = Task {
        name: slug.into(),
        slug: slug.into(),
        archived,
        engine_version: 2,
        playbook: reference.key.clone(),
        playbook_ref: Some(reference.clone()),
        ..Default::default()
    };
    fs::create_dir_all(sessions_dir(repo, slug)).unwrap();
    fs::write(alinery_core::execution::task_playbook_path(repo, slug).unwrap(), source).unwrap();
    let mut execution = alinery_core::execution::new_execution_state(reference, source, lane.into(), 10, Default::default(), Default::default()).unwrap();
    execution.creation = "ready".into();
    execution.owning_app_config_identity = "foreign-config".into();
    alinery_core::execution::write_execution_state_unlocked(repo, slug, &mut execution).unwrap();
    write_task(repo, &task).unwrap();
    task
}

// --- Task attachments & evidence (Phases 3-4) ---------------------------------------

// A plain temp dir with no git HEAD: the copier and attachment_path_in never shell out.
fn unique_attachment_temp(name: &str) -> std::path::PathBuf {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("alinery-{name}-{n}"));
    fs::create_dir_all(&repo).unwrap();
    repo
}

fn attachments_of(repo: &Path, slug: &str) -> std::path::PathBuf {
    repo.join(".alinery/tasks").join(slug).join("artifacts/attachments")
}

fn activity_repo(label: &str) -> std::path::PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::path::PathBuf::from("/tmp").join(format!("alinery-test-{label}-{nanos}"));
    fs::create_dir_all(&repo).unwrap();

    repo
}

fn write_activity_task(repo: &Path, slug: &str, phase: &str, archived: bool) {
    fs::create_dir_all(super::artifacts_dir(repo, slug)).unwrap();
    fs::create_dir_all(super::sessions_dir(repo, slug)).unwrap();
    write_task(
        repo,
        &Task {
            name: slug.into(),
            slug: slug.into(),
            requested_slug: String::new(),
            branch: slug.into(),
            worktree: repo.display().to_string(),
            has_worktree: false,
            created: 1,
            archived: false,
            pr_url: String::new(),
            linear_id: String::new(),
            github_issue: String::new(),
            playbook: "superdevelop".into(),
            auto_advance: vec![],
            draft: false,
            telemetry_id: String::new(),
            parent_task: String::new(),
            active_subtask: String::new(),
            subtask_outcome: String::new(),
            related_tasks: Vec::new(),
            ..Default::default()
        },
    )
    .unwrap();
    let meta = SessionMeta {
        id: format!("{slug}-session"),
        worktree: repo.display().to_string(),
        created: 1,
        archived,
        phase: phase.into(),
        playbook: "superdevelop".into(),
        ..Default::default()
    };
    fs::write(session_meta_path(repo, slug, &meta.id), serde_json::to_string(&meta).unwrap()).unwrap();
}

// Build a DaemonSessionStatus with the given agent state (Busy = "running", Idle = "idle",
// Unknown = unsupported/exited/unknown). Process is Alive in all cases.
fn activity_status_busy(id: &str) -> super::DaemonSessionStatus {
    super::DaemonSessionStatus {
        id: id.into(),
        state: alinery_core::SessionState {
            process: alinery_core::ProcessState::Alive,
            agent: alinery_core::AgentState::Busy,
            playbook: alinery_core::PlaybookState::InProgress,
            adapter: alinery_core::HarnessAdapter::Omp,
            message_adapter: alinery_core::MessageAdapter::OmpBracketedPaste,
        },
        transport: alinery_core::SessionTransport::Pty,
    }
}

fn activity_status_idle(id: &str) -> super::DaemonSessionStatus {
    super::DaemonSessionStatus {
        id: id.into(),
        state: alinery_core::SessionState {
            process: alinery_core::ProcessState::Alive,
            agent: alinery_core::AgentState::Idle,
            playbook: alinery_core::PlaybookState::InProgress,
            adapter: alinery_core::HarnessAdapter::Omp,
            message_adapter: alinery_core::MessageAdapter::OmpBracketedPaste,
        },
        transport: alinery_core::SessionTransport::Pty,
    }
}

fn activity_status_unknown(id: &str) -> super::DaemonSessionStatus {
    super::DaemonSessionStatus {
        id: id.into(),
        state: alinery_core::SessionState {
            process: alinery_core::ProcessState::Alive,
            agent: alinery_core::AgentState::Unknown,
            playbook: alinery_core::PlaybookState::InProgress,
            adapter: alinery_core::HarnessAdapter::Unsupported,
            message_adapter: alinery_core::MessageAdapter::Unsupported,
        },
        transport: alinery_core::SessionTransport::Pty,
    }
}

struct FixtureListener {
    calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    stop: Option<std::sync::mpsc::Sender<()>>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl FixtureListener {
    fn calls(mut self) -> usize {
        self.shutdown();
        self.calls.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn shutdown(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for FixtureListener {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn activity_list_socket(repo: &Path, response: Option<&str>) -> FixtureListener {
    activity_list_socket_with_identity(repo, response, "config")
}

// Passive activity observation is two round-trips on one worker: `version`, then
// either `list` or `live_session_count` (only an identity mismatch pays for the
// latter). A 200ms accept window measured from thread spawn lost the second one
// whenever CI scheduled that worker late, so the summary came back empty and the
// call count was 1. Stay up until the test reads the count. The deadline only
// bounds a test that never does.
fn activity_list_socket_with_identity(repo: &Path, response: Option<&str>, version_identity: &str) -> FixtureListener {
    let socket = super::current_alineryd_socket_path(repo);
    let listener = std::os::unix::net::UnixListener::bind(socket).unwrap();
    listener.set_nonblocking(true).unwrap();
    let response = response.map(str::to_owned);
    let version_identity = version_identity.to_owned();
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let calls_thread = std::sync::Arc::clone(&calls);
    let (stop_tx, stop_rx) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if stop_rx.try_recv().is_ok() {
                break;
            }
            match listener.accept() {
                Ok((mut stream, _)) => {
                    calls_thread.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let request = super::read_socket_line(&mut stream).unwrap_or_default();
                    let is_version = serde_json::from_str::<serde_json::Value>(&request)
                        .ok()
                        .and_then(|value| value.get("op").and_then(|op| op.as_str()).map(str::to_owned))
                        .as_deref()
                        == Some("version");
                    if is_version {
                        // A panicked write kills the listener; the next probe then
                        // connects to a leftover socket file and gets ECONNREFUSED.
                        let _ = writeln!(
                            stream,
                            "{}",
                            serde_json::json!({
                                "protocol": PROTOCOL_VERSION,
                                "build_id": "fixture",
                                "app_config_identity": version_identity,
                                "host_guard_ready": true,
                            })
                        );
                        let _ = stream.flush();
                    } else if let Some(response) = &response {
                        let _ = stream.write_all(response.as_bytes());
                        let _ = stream.flush();
                    }
                }
                // Any `accept` error, including ECONNABORTED from the liveness probe
                // and EINTR, must not drop the listener. Dropping it leaves the
                // socket file behind and the next connect is ECONNREFUSED.
                Err(_) => {
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
        }
    });
    FixtureListener {
        calls,
        stop: Some(stop_tx),
        handle: Some(handle),
    }
}

// ---- Session list performance regression — TDD red tests (05-tdd.md) ----

// Stay up until the test reads the count. An 1800ms accept window measured from
// spawn, and any fatal `accept` error, both drop the listener while the socket
// file remains — the next connect is then `ECONNREFUSED`, which is what
// durable_board_discovery saw for the foreign-config lane.
fn status_list_socket(socket_path: std::path::PathBuf, response: Option<&str>) -> FixtureListener {
    fs::create_dir_all(socket_path.parent().unwrap()).unwrap();
    let listener = std::os::unix::net::UnixListener::bind(socket_path).unwrap();
    listener.set_nonblocking(true).unwrap();
    let response = response.map(str::to_owned);
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let calls_thread = std::sync::Arc::clone(&calls);
    let (stop_tx, stop_rx) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if stop_rx.try_recv().is_ok() {
                break;
            }
            match listener.accept() {
                Ok((mut stream, _)) => {
                    calls_thread.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    // Answer here, not on a fresh thread. Observation calls give up after
                    // 250ms. The liveness probe connects and drops without a line; a
                    // failed read is that probe, and the listener has to stay up for the
                    // real request that follows.
                    if super::read_socket_line(&mut stream).is_err() {
                        continue;
                    }
                    if let Some(response) = &response {
                        // Not `unwrap`: a caller can close after the read. Panicking
                        // killed the listener, and every later op then read as a daemon
                        // that answers nothing — a protocol mismatch turned into a
                        // missing protocol.
                        let _ = stream.write_all(response.as_bytes());
                        let _ = stream.flush();
                    } else {
                        // Hold the socket open so the client observes a timeout, not EOF.
                        std::thread::sleep(Duration::from_millis(1200));
                    }
                }
                // Any `accept` error, including ECONNABORTED from the liveness probe
                // and EINTR, must not drop the listener. Dropping it leaves the
                // socket file behind and the next connect is ECONNREFUSED.
                Err(_) => {
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
        }
    });
    FixtureListener {
        calls,
        stop: Some(stop_tx),
        handle: Some(handle),
    }
}

#[allow(clippy::too_many_arguments)]
fn write_status_session(
    repo: &Path,
    slug: &str,
    id: &str,
    phase: &str,
    daemon_namespace: &str,
    started_at: Option<u64>,
    ended_at: Option<u64>,
    exit_code: Option<i32>,
    artifact: &str,
) {
    fs::create_dir_all(super::artifacts_dir(repo, slug)).unwrap();
    fs::create_dir_all(super::sessions_dir(repo, slug)).unwrap();
    write_task(
        repo,
        &Task {
            name: slug.into(),
            slug: slug.into(),
            requested_slug: String::new(),
            branch: slug.into(),
            worktree: repo.display().to_string(),
            has_worktree: false,
            created: 1,
            archived: false,
            pr_url: String::new(),
            linear_id: String::new(),
            github_issue: String::new(),
            playbook: "superdevelop".into(),
            auto_advance: vec![],
            draft: false,
            telemetry_id: String::new(),
            parent_task: String::new(),
            active_subtask: String::new(),
            subtask_outcome: String::new(),
            related_tasks: Vec::new(),
            ..Default::default()
        },
    )
    .unwrap();
    let meta = SessionMeta {
        id: id.into(),
        worktree: repo.display().to_string(),
        created: 1,
        phase: phase.into(),
        playbook: "superdevelop".into(),
        artifact: artifact.into(),
        started_at,
        ended_at,
        exit_code,
        daemon_namespace: if daemon_namespace.is_empty() {
            super::alineryd_socket_namespace().unwrap_or_default()
        } else {
            daemon_namespace.into()
        },
        ..Default::default()
    };
    fs::write(session_meta_path(repo, slug, id), serde_json::to_string(&meta).unwrap()).unwrap();
}

fn status_ref(repo: &Path, slug: &str, id: &str) -> super::SessionStatusRef {
    super::SessionStatusRef {
        repo_path: repo.display().to_string(),
        task_slug: slug.into(),
        id: id.into(),
    }
}
