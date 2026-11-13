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
//     (3) PR LINK: compare URL generation and background GitHub PR discovery live in
//     git_ops.rs. (4) TICKET IMPORT: one-way Linear/GitHub imports via ureq.
//     GitHub auth is `git credential fill`, not the gh CLI. config.toml mirrors harnesses.toml
//     (bundled default via include_str!, degrades to defaults on a bad edit).
// Deferred (do NOT add here): Linear status write-back,
//     PRD track, SQLite, session resurrection, stream-json/rich adapters, auto-advance,
//     per-repo windows.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use alinery_core::legacy_daemon::read_socket_line;
#[cfg(test)]
use alinery_core::legacy_daemon::{format_daemon_timeout, SocketReadError, DAEMON_CONTROL_TIMEOUT, DAEMON_OBSERVATION_TIMEOUT};
use alinery_core::lockfile::{try_lock_exclusive, LockFile};
pub(crate) use alinery_core::write_owner_only_bytes;
#[cfg(test)]
pub(crate) use alinery_core::write_task;
use alinery_core::{alinery_app_lock_path, alinery_dir, login_shell_path, DaemonCompat, PollerAction, PROTOCOL_VERSION};
pub use alinery_core::{
    alineryd_lock_path,
    alineryd_socket_path,
    classify,
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
};
#[cfg(test)]
use alinery_core::{configure_detached_process, file_content_id};
use tauri::{AppHandle, Emitter, Manager, State, UserAttentionType};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;

mod account;
#[path = "vinculum_customizations.rs"]
mod agent_customizations;
mod app_config;
mod backup;
mod chat;
mod community_playbooks;
mod connections;
mod daemon;
mod daemon_rpc;
mod git_ops;
mod host_wire;
mod hosted;
mod imports;
mod mcp;
mod notify;
mod omp_update;
mod paths;
mod pi_durable;
mod remote;
mod session;
mod settings;
mod state;
mod task;
mod telemetry;
mod update;

use account::*;
use agent_customizations::*;
use app_config::*;
use backup::*;
use chat::*;
use community_playbooks::*;
use connections::*;
use daemon::*;
use daemon_rpc::*;
use git_ops::*;
use hosted::*;
use imports::*;
use mcp::*;
use notify::*;
use omp_update::*;
use paths::*;
use remote::*;
use session::*;
use settings::*;
use state::*;
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
            if let Ok(bundle) = crate::remote::bundled_runtime_dir(app.handle()) {
                let _ = crate::pi_durable::RUNTIME_BUNDLE.set(bundle);
            }
            // B5: keep a daemon alive for every open repo (spawn-only — see the fn).
            spawn_daemon_poller(app.handle().clone());
            spawn_remote_supervisor(app.handle().clone());
            spawn_pi_hosted_refresh(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            read_app_config,
            daemon_rpc,
            daemon_rpc_cancel,
            write_appearance,
            set_active_repo,
            remove_repo,
            remote_hosts,
            runtime_status,
            list_hosts,
            set_host_onboarded,
            remote_add_host,
            remote_ssh_aliases,
            remote_describe_destination,
            remote_test_host,
            remote_discard_host,
            remote_sharing,
            remote_set_sharing,
            remote_connect,
            remote_disconnect,
            remote_join_daemon,
            remote_list_dir,
            remote_classify,
            remote_init,
            remote_add_repo,
            remove_remote_repo_keep_running,
            pick_repo_dialog,
            classify_picked_folder,
            init_picked_folder,
            pick_attachment_files_dialog,
            read_local_file,
            save_file_dialog,
            lookup_task_pull_request,
            list_chat_repos,
            list_community_playbooks,
            community_remote_status,
            download_community_source,
            preview_community_playbook,
            list_my_community_playbooks,
            publish_community_playbook,
            grok_key_ready,
            chat_file_stat,
            daemon_status,
            prepare_repo_takeover,
            confirm_repo_takeover,
            cancel_repo_takeover,
            read_global_settings,
            write_global_settings,
            read_model_favorites,
            set_model_favorite,
            notify_test,
            set_dock_badge_count,
            notify_session_attention,
            prepare_hosted_inference,
            stop_daemon,
            repair_task_state,
            reset_repo_state,
            close_all_repos,
            cancel_quit,
            mcp_status,
            start_mcp_server,
            stop_mcp_server,
            pick_backup_destination_dialog,
            restore_backup,
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
            account_credits,
            account_open_plans,
            import_linear_for_repo,
            import_github_for_repo,
            check_update,
            download_update,
            apply_update,
            open_vinculum_agent_dir,
            pick_vinculum_skill_dialog,
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
