//! The app crate's unit tests, one file per owning module in src/.
//!
//! This was a single 4,600-line tests.rs. Splitting it makes "where does my test go"
//! answerable by looking at which module the code under test lives in, and stops every
//! new test from being appended to the same file.
//!
//! Shared imports and fixtures live here; each child starts with `use super::*`.
pub(crate) use super::{
    account_auth_path_in, account_lock_path, account_status_from_path, accounts_url, alineryd_socket_namespace_for, apply_credits_to_hosted_view, attach_repo_daemon,
    begin_sign_in_attempt, cancel_sign_in_at, classify_refresh_response, clear_linear_account_in, configure_detached_process, credits_view_from, curl_http, curl_request,
    curl_request_with_timeouts, current_alineryd_socket_path, display_label, end_sign_in_attempt, entitlement_url, fetch_desktop_credits_at, file_content_id, finish_sign_in,
    github_repo_from_remote, gui_lock_held_elsewhere, hold_lock_after_compare_then_clear, hosted_refresh_needed, inference_path, is_hosted_model, is_paid_plan,
    linear_account_path_in, list_tasks_for_repo, loopback_html, open_chat_repos_in, paid_from_stored_plan, parse_desktop_credits_body, parse_desktop_login_callback,
    parse_entitlement_plan, parse_github_ref, parse_hosted_catalog_body, parse_hosted_error, parse_linear_oauth_tokens, parse_linear_ref, parse_oauth_callback, percent_encode,
    pkce_challenge, plan_label, production_livemode, read_model_favorites_in, read_task, refresh_account_at, refresh_hosted_inference_for_spawn_at, register_runtime_plugins,
    remove_mcp_lane_runtime_files, remove_repo_from_config, require_repo_owned, resolve_hosted_catalog, sanitize_app_config, sanitize_appearance, session_meta_path, sessions_dir,
    set_active_repo_global, set_model_favorite_in, sign_out_at, store_credits_snapshot, sync_hosted_inference, task_dir, validate_known_target_repo,
    wait_for_desktop_login_callback, wait_for_desktop_login_callback_until, wait_for_linear_callback, with_access_token_retry, write_global_settings_in, write_task,
    AccountAuthError, AccountUser, AppConfig, AppState, AppearancePrefs, AuthAttempt, AuthRetryError, Command, DesktopCreditsView, LinearTokenError, OAuthCallback, SessionMeta,
    SignInAttempt, SignInGuard, Task, HOSTED_MODEL_UNAVAILABLE, PROTOCOL_VERSION,
};
pub(crate) use alinery_core::{
    alinery_app_lock_path, hosted_models_yml_unavailable, models_yml_path, parse_inference_session_body, render_models_yml, wipe_hosted_files, write_hosted_models_yml,
    HarnessFile, RepoOverrides, DEFAULT_HARNESSES_TOML,
};
pub(crate) use alinery_core::{git_cmd, git_top_level};
pub(crate) use std::sync::Mutex;
pub(crate) use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
pub(crate) use std::{fs, io::Write, path::Path};

mod account;
mod app_config;
mod backup;
mod community_playbooks;
mod connections;
mod daemon;
mod daemon_rpc;
mod git_ops;
mod host_wire;
mod hosted;
mod imports;
mod notify;
mod omp_update;
mod paths;
mod pi_durable;
mod remote;
mod session;
mod settings;
mod task;
mod update;

// worktree_exists / create_session's archived-task guard both read the process-global
// ACTIVE_REPO; serialize the handful of tests that mutate it so parallel test threads
// never stomp on each other's active repo.
static ACTIVE_REPO_TEST_LOCK: Mutex<()> = Mutex::new(());

pub(crate) use alinery_core::http::accept_for_test;

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
    let mut execution = alinery_core::execution::new_execution_state(reference, source, lane.into(), 10, Default::default(), Default::default(), Default::default()).unwrap();
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
