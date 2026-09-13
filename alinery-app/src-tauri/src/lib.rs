// alinery M2+M3 backend.
// M0: `ping` proves the JS->Rust->JS round-trip.
// M1: interactive `claude` pty sessions, raw bytes streamed to the frontend.
// M2: tasks + one git worktree per task + a flat bag of cheap sessions, with the
//     filesystem as the database (`<repo>/.alinery/`). Git is shelled out.
//     Sessions keep running in the background and REATTACH on reopen (in-process;
//     surviving an app restart still needs a daemon — deferred).
// M3: SuperDevelop phases. A session carries a `phase`; on FRESH spawn its bundled prompt
//     (compiled in via include_str!) is substituted ({{ARTIFACTS_DIR}}) and passed as
//     the harness's initial message. Artifacts are task-owned under
//     `.alinery/tasks/<slug>/artifacts/`. `current_phase` is DERIVED from
//     the latest session's phase — nothing to store, "advance" = create the next session.
// M4: harness registry. `harnesses.toml` declares each harness command and semantic
//     adapter capability. OMP sessions report typed agent/playbook facts through
//     `alinery-runner`; unsupported harnesses retain terminal/process behavior only.
//     alineryd owns every PTY, process group, scrollback stream, and process transition.
// M5: quality-of-life notifications consume explicit idle/input/approval transitions,
//     gated on config.toml, rather than parsing terminal output.
//     Sound is a bundled tron_notification.wav (include_bytes!) played via `afplay`, decoupled
//     from the banner so sound/banner/bounce toggle independently (no new dep). (2) REMOVE-WORKTREE:
//     end the task's live sessions, `git worktree remove --force`, clear task.worktree.
//     (3) PR LINK: push + build the forge COMPARE URL by
//     STRING-PARSING `origin` (ssh + https, GitHub + Gitea) — no forge API — stored as an
//     editable `pr_url`. (4) TICKET IMPORT: one-way Linear/GitHub imports via curl (zero
//     new deps, mirrors the git shell-out pattern). config.toml mirrors harnesses.toml
//     (bundled default via include_str!, degrades to defaults on a bad edit).
// Deferred (do NOT add here): Linear status write-back / PR auto-detect / forge API polling,
//     PRD track, SQLite, session resurrection, stream-json/rich adapters, auto-advance,
//     per-repo windows.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

mod backup_queue;
use alinery_core::daemon_client;
#[cfg(test)]
use alinery_core::daemon_client::DAEMON_OBSERVATION_TIMEOUT;
use alinery_core::daemon_client::{format_daemon_timeout, read_socket_line, DaemonClient, DaemonSessionStatus, SocketReadError, DAEMON_CONTROL_TIMEOUT};
use alinery_core::lockfile::{try_lock_exclusive, LockFile};
use alinery_core::{alinery_app_lock_path, alinery_dir, ensure_harnesses_toml, login_shell_path, poller_action, DaemonCompat, PollerAction, PROTOCOL_VERSION};
pub use alinery_core::{
    alineryd_lock_path,
    alineryd_socket_path,
    classify,
    phase_prompt,
    stamp_meta,
    write_meta_atomic,
    // Structured semantic types (Step 3 cutover).
    AgentState,
    HarnessAdapter,
    LifecycleState,
    PlaybookState,
    ProcessState,
    // Protocol / event types re-exported for test modules.
    RunnerEvent,
    RunnerEventEnvelope,
    SemanticCheckpoint,
    SessionState,
    PHASES,
};
#[cfg(test)]
use alinery_core::{configure_detached_process, file_content_id};
pub(crate) use alinery_core::{write_bytes_atomic, write_owner_only_bytes};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State, UserAttentionType};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;

mod account;
mod app_config;
mod artifacts;
mod backup;
mod connections;
mod daemon;
mod git_ops;
mod hosted;
mod imports;
mod mcp;
mod notify;
mod omp_update;
mod paths;
mod playbook;
mod session;
mod settings;
mod state;
mod subtask;
mod task;
mod telemetry;
mod update;

use account::*;
use app_config::*;
use artifacts::*;
use backup::*;
use connections::*;
use daemon::*;
use git_ops::*;
use hosted::*;
use imports::*;
use mcp::*;
use notify::*;
use omp_update::*;
use paths::*;
use playbook::*;
use session::*;
use settings::*;
use state::*;
use subtask::*;
use task::*;
use telemetry::*;
use update::*;

fn register_runtime_plugins<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    let _ = EFFECTIVE_APP_IDENTIFIER.set(context.config().identifier.clone());
    register_runtime_plugins(tauri::Builder::default())
        .manage(AppState::default())
        .setup(|app| {
            // B5: keep a daemon alive for every open repo (spawn-only — see the fn).
            spawn_daemon_poller(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            read_app_config,
            write_appearance,
            set_active_repo,
            remove_repo,
            pick_repo_dialog,
            pick_attachment_files_dialog,
            create_task,
            create_task_for_repo,
            duplicate_task_for_repo,
            get_task,
            write_draft,
            write_draft_for_repo,
            delete_draft,
            delete_draft_for_repo,
            list_tasks,
            list_board_tasks,
            list_task_activity,
            archive_task,
            archive_task_for_repo,
            restore_task_for_repo,
            set_related_tasks_for_repo,
            create_session,
            create_session_for_repo,
            preview_session_prompt,
            ensure_drawer_terminal,
            list_sessions,
            list_session_items,
            session_list_statuses,
            archive_session,
            archive_session_for_repo,
            mark_session_notification_read,
            clear_session_notifications,
            subtask_state,
            start_subtask_manager,
            recover_subtask_manager,
            discard_subtask,
            list_phases,
            list_playbooks,
            list_playbooks_for_repo,
            get_playbook,
            list_playbook_steps,
            list_playbook_steps_for_repo,
            list_kanban_columns,
            list_harness_models,
            session_artifact_ready,
            list_harness_models_for_repo,
            list_artifacts,
            list_artifacts_with_metadata,
            send_review_handoff,
            read_artifact,
            read_artifact_for_repo,
            attachment_path,
            list_task_artifact_tree,
            read_task_artifact_node,
            artifact_node_path,
            list_artifact_comments,
            list_artifact_comment_drafts,
            list_artifact_comment_drafts_for_repo,
            save_artifact_comment_draft,
            save_artifact_comment_draft_for_repo,
            delete_artifact_comment_draft,
            delete_artifact_comment_draft_for_repo,
            add_artifact_comment,
            add_artifact_comment_for_repo,
            artifact_comment_markdown_path_for,
            prepare_artifact_comments_prompt,
            archive_artifact_comments,
            archive_artifact_comments_for_repo,
            artifact_review_pending_status,
            clear_artifact_review_pending,
            clear_artifact_review_pending_for_repo,
            open_session,
            detach_session,
            write_session,
            prepare_review_approval_prompt,
            finalize_session_message_actions,
            resize_session,
            restate_session,
            rpc_attach_session,
            rpc_write_session,
            omp_setup_session,
            session_status,
            session_statuses,
            spawn_session_detached,
            spawn_session_detached_for_repo,
            kill_session,
            kill_session_for_repo,
            read_session_history,
            read_session_omp,
            daemon_status,
            read_config,
            read_config_for_repo,
            write_config,
            read_global_settings,
            write_global_settings,
            read_model_favorites,
            set_model_favorite,
            read_scoped_settings_for_repo,
            read_repo_overrides_for_repo,
            write_repo_overrides_for_repo,
            clear_repo_override_for_repo,
            storage_info,
            delete_all_archived_storage,
            notify_test,
            set_dock_badge_count,
            notify_session_attention,
            stop_daemon,
            repo_live_sessions,
            takeover_repo_daemon,
            close_all_repos,
            cancel_quit,
            mcp_status,
            start_mcp_server,
            stop_mcp_server,
            pick_backup_destination_dialog,
            backup_now,
            backup_busy,
            list_backups,
            restore_backup,
            remove_worktree,
            remove_worktree_for_repo,
            worktree_exists,
            push_and_compare_url,
            push_and_compare_url_for_repo,
            set_pr_url,
            set_pr_url_for_repo,
            commit_worktree,
            commit_worktree_for_repo,
            connection_statuses,
            connect_github,
            connect_linear,
            disconnect_linear,
            account_status,
            account_refresh,
            account_sign_in,
            account_cancel_sign_in,
            account_sign_out,
            account_open,
            hosted_catalog,
            account_open_plans,
            import_linear,
            import_linear_for_repo,
            import_github,
            import_github_for_repo,
            check_update,
            download_update,
            apply_update,
            check_omp_update,
            update_omp,
            omp_agent_sessions_dir,
            read_omp_model_roles,
            write_omp_model_roles,
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(state) = app.try_state::<AppState>() {
                    state.kill_mcp(); // R2: ensure managed child dies with app
                }
            }
            // alineryd remains detached (on purpose)
        });
}

#[cfg(test)]
mod tests;
