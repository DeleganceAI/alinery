use alinery_core::safe_component;
use clap::Parser;
use serde_json::{json, Value};
use std::io::{self, BufRead, Read, Write};
use std::path::{Path, PathBuf};

/// alinery-mcp: MCP server for alinery (Model Context Protocol)
#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Optional at stdio launch — repo is now a required per-call tool argument (see
    /// `alinery_list_repos`). Still required for `--serve`, which uses it only to name the
    /// unix socket location.
    #[arg(long)]
    repo: Option<String>,

    /// Run in serve mode (unix socket under <repo>/.alinery/) for app-spawned child
    #[arg(long)]
    serve: bool,

    /// Exit when the app-owned stdin pipe closes.
    #[arg(long)]
    managed: bool,

    /// App-level app.toml for global settings/harness base.
    #[arg(long)]
    app_config: Option<String>,

    /// Optional lane namespace so prod/dev MCP runtime files don't collide (#74).
    #[arg(long)]
    socket_namespace: Option<String>,
}

const REMOTE_MSG: &str = "This repo appears to be remote (ssh). MCP currently supports read-only discovery of remote repos only. Full operations require the Alinery desktop app or future remote daemon support.";

/// Distinct from `REMOTE_MSG`: a registered entry whose path *exists* but has no `.git`
/// (never cloned, or a plain folder) is not necessarily remote/ssh — don't claim it is.
const NOT_LOCAL_CHECKOUT_MSG: &str = "This repo is registered but is not a local Git checkout at this path (no .git found). MCP currently supports read-only discovery of such repos only. Full operations require the Alinery desktop app or future remote daemon support.";

fn main() {
    let args = Args::parse();
    let process_repo = args.repo.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(PathBuf::from);
    let app_config = args.app_config.as_deref().map(PathBuf::from).or_else(alinery_core::app_config_toml_path);

    if args.serve {
        let repo = match process_repo.as_deref() {
            Some(repo) => repo,
            None => {
                eprintln!("Usage: alinery-mcp --serve --repo /path/to/repo");
                return;
            }
        };
        serve_socket(&repo.to_string_lossy(), app_config.clone(), args.socket_namespace.as_deref(), args.managed);
        return;
    }

    eprintln!(
        "alinery-mcp starting (stdio); --repo={} (repo is a per-call tool argument)",
        process_repo.as_deref().map(|p| p.display().to_string()).unwrap_or_else(|| "none".into())
    );

    // stdio JSON-RPC loop (primary path for MCP hosts like Claude Desktop)
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("parse error: {}", e);
                continue;
            }
        };
        if let Some(resp) = handle_request_in(&req, process_repo.as_deref(), app_config.as_deref(), "") {
            let _ = writeln!(stdout, "{}", resp);
            let _ = stdout.flush();
        }
    }
}

/// R2: real serve mode — the app-spawned child listens on a unix socket so it
fn write_mcp_status(status_path: &Path, clients: u32) {
    use std::sync::atomic::{AtomicU64, Ordering};
    // Unique temp name per write so concurrent connection threads don't collide.
    static NONCE: AtomicU64 = AtomicU64::new(0);
    let status = json!({"pid": std::process::id(), "clients": clients});
    let body = serde_json::to_string(&status).unwrap_or_default();
    // Atomic swap: a concurrent app-side reader never sees a half-written file.
    let tmp = status_path.with_extension(format!("tmp{}.{}", std::process::id(), NONCE.fetch_add(1, Ordering::Relaxed)));
    if std::fs::write(&tmp, body.as_bytes()).is_ok() && std::fs::rename(&tmp, status_path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

#[cfg(unix)]
fn watch_managed_parent(sock: PathBuf, status_path: PathBuf) {
    std::thread::spawn(move || {
        let stdin = io::stdin();
        let mut input = stdin.lock();
        let mut byte = [0_u8; 1];
        loop {
            match input.read(&mut byte) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
        let _ = std::fs::remove_file(sock);
        let _ = std::fs::remove_file(status_path);
        std::process::exit(0);
    });
}

#[cfg(unix)]
fn serve_socket(repo: &str, app_config: Option<PathBuf>, namespace: Option<&str>, managed: bool) {
    use std::os::unix::net::UnixListener;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;
    let repo_path = Path::new(repo);
    let sock = alinery_core::mcp_socket_path(repo_path, namespace);
    let status_path = alinery_core::mcp_status_path(repo_path, namespace);
    let alinery = alinery_core::alinery_dir(repo_path);
    let _ = std::fs::create_dir_all(&alinery);
    // Delete only own-lane runtime files.
    let _ = std::fs::remove_file(&sock);
    let _ = std::fs::remove_file(&status_path);
    let listener = match UnixListener::bind(&sock) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("serve: bind {} failed: {}", sock.display(), e);
            return;
        }
    };
    eprintln!("serve: listening on {}", sock.display());
    let clients = Arc::new(AtomicU32::new(0));
    let daemon_namespace = namespace.unwrap_or_default().to_string();
    let status_path = Arc::new(status_path);
    write_mcp_status(&status_path, 0);
    if managed {
        watch_managed_parent(sock.clone(), status_path.as_ref().clone());
    }
    // One thread per connection so accept() is never starved by a long-lived MCP host:
    // the per-poll connect() liveness probe (#74) must always be answered, and concurrent
    // hosts must be counted accurately.
    for stream in listener.incoming() {
        let mut stream = match stream {
            Ok(s) => s,
            Err(_) => continue,
        };
        let clients = Arc::clone(&clients);
        let status_path = Arc::clone(&status_path);
        let sock = sock.clone();
        let repo = repo.to_string();
        let app_config = app_config.clone();
        let daemon_namespace = daemon_namespace.clone();
        std::thread::spawn(move || {
            let reader = io::BufReader::new(match stream.try_clone() {
                Ok(s) => s,
                Err(_) => return,
            });
            let mut counted = false;
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };
                if line.trim().is_empty() {
                    continue;
                }
                if !counted {
                    counted = true;
                    write_mcp_status(&status_path, clients.fetch_add(1, Ordering::SeqCst) + 1);
                }
                let req: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                // E4: reap control. An orphaned managed listener (force-quit / crash)
                // is removed by asking the process that ANSWERS the socket to leave —
                // never by killing a pid read from mcp.status.json (pid reuse; the
                // identity-from-files antipattern #74 already deleted).
                //
                // Ack first, then unlink and exit: the caller must only remove the
                // socket after the listener has confirmed, never before.
                if req.get("op").and_then(|o| o.as_str()) == Some("exit") {
                    let _ = writeln!(stream, "{}", json!({"ok": true}));
                    let _ = stream.flush();
                    let _ = std::fs::remove_file(&sock);
                    let _ = std::fs::remove_file(status_path.as_ref());
                    std::process::exit(0);
                }
                if let Some(resp) = handle_request_in(&req, Some(Path::new(&repo)), app_config.as_deref(), &daemon_namespace) {
                    let _ = writeln!(stream, "{}", resp);
                    let _ = stream.flush();
                }
            }
            if counted {
                write_mcp_status(&status_path, clients.fetch_sub(1, Ordering::SeqCst).saturating_sub(1));
            }
        });
    }
}

#[cfg(not(unix))]
fn serve_socket(_repo: &str, _app_config: Option<PathBuf>, _namespace: Option<&str>, _managed: bool) {
    eprintln!("serve mode requires a unix platform; parking");
    std::thread::park();
}

/// Dispatch one JSON-RPC message. Returns None for notifications (no `id`),
/// which per JSON-RPC must NOT receive a response.
fn handle_request_in(req: &Value, process_repo: Option<&Path>, app_config: Option<&Path>, daemon_namespace: &str) -> Option<Value> {
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = req.get("params").cloned().unwrap_or(json!({}));
    let id = req.get("id").cloned();

    let outcome: Result<Value, (i64, String)> = match method {
        "initialize" => {
            // echo the client's requested protocol version when present
            let ver = params.get("protocolVersion").and_then(|v| v.as_str()).unwrap_or("2024-11-05").to_string();
            Ok(json!({
                "protocolVersion": ver,
                "capabilities": {"tools": {}, "resources": {}},
                "serverInfo": {"name": "alinery-mcp", "version": "0.1"}
            }))
        }
        "tools/list" => Ok(json!({"tools": list_tools()})),
        "tools/call" => Ok(handle_tool_call_in(params, process_repo, app_config, daemon_namespace)),
        // MCP resource URIs are inherently one process's namespace — unrelated to per-call
        // `repo` tool targeting, so these stay bound to --repo at process launch.
        "resources/list" => match process_repo {
            Some(repo) => {
                let repo = repo.display().to_string();
                eprintln!("MCP resources/list for repo={}", repo);
                Ok(json!({"resources": [
                    {"uri": format!("alinery://{}/.alinery/tasks/{{slug}}/task.md", repo), "name": "task.md"},
                    {"uri": format!("alinery://{}/.alinery/tasks/{{slug}}/artifacts/{{nn}}.md", repo), "name": "artifact"},
                    {"uri": format!("alinery://{}/.alinery/tasks/{{slug}}/sessions/{{id}}.meta.json", repo), "name": "session meta"}
                ]}))
            }
            None => Err((-32602, "resources/list requires --repo at process launch (MCP resource URIs are process-scoped)".into())),
        },
        "resources/read" => match process_repo {
            Some(repo) => Ok(handle_resource_read(&params, repo)),
            None => Err((-32602, "resources/read requires --repo at process launch (MCP resource URIs are process-scoped)".into())),
        },
        // notifications (e.g. notifications/initialized) land here with no id → no response
        _ => Err((-32601, "Method not found".into())),
    };

    // notification: never respond
    let id = id?;
    Some(match outcome {
        Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
        Err((code, message)) => {
            json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
        }
    })
}

/// Test-only convenience: mirrors production `arguments.repo` by injecting `repo` into a
/// `tools/call` request's arguments (or `repo`/process_repo directly for `handle_tool_call`)
/// so the hundreds of existing dispatch tests below don't each need to thread it by hand.
/// Production dispatch (`handle_request_in` / `handle_tool_call_in`) never does this — it
/// hard-errors on a missing `repo`, which the dedicated tests below cover directly.
#[cfg(test)]
fn with_injected_repo(mut params: Value, repo: &str) -> Value {
    match params.get_mut("arguments").and_then(Value::as_object_mut) {
        Some(map) => {
            map.entry("repo".to_string()).or_insert_with(|| Value::String(repo.to_string()));
        }
        None => {
            params["arguments"] = json!({"repo": repo});
        }
    }
    params
}

#[cfg(test)]
fn handle_request(req: &Value, repo: &str, app_config: Option<&Path>) -> Option<Value> {
    let mut req = req.clone();
    if req.get("method").and_then(Value::as_str) == Some("tools/call") {
        if let Some(params) = req.get("params").cloned() {
            req["params"] = with_injected_repo(params, repo);
        }
    }
    handle_request_in(&req, Some(Path::new(repo)), app_config, "")
}

fn is_remote(repo: &Path) -> bool {
    !repo.exists() || !repo.join(".git").exists()
}

// Archive cleanup addresses every discovered daemon lane through the shared typed client.
#[cfg(unix)]
fn kill_session_on_lanes(repo: &Path, id: &str) {
    for (_namespace, socket_path) in alinery_core::list_alineryd_lane_sockets(repo) {
        if let Ok(client) = alinery_core::daemon_client::DaemonClient::connect_path(socket_path) {
            let _ = client.kill_session(id);
        }
    }
}

#[cfg(not(unix))]
fn kill_session_on_lanes(_repo: &Path, _id: &str) {}

fn text_result(s: impl Into<String>) -> Value {
    json!({"content": [{"type": "text", "text": s.into()}]})
}

fn load_public_app_config(app_config: Option<&Path>) -> Option<alinery_core::AppConfig> {
    app_config
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|content| toml::from_str::<alinery_core::AppConfig>(&content).ok())
}

/// Allow-list of registerable repo values: `known_repos` unioned with a non-empty
/// `active_repo` (trimmed). Mirrors the app crate's own `sanitize_app_config`, which pushes
/// `active_repo` into `known_repos` on every load/save — a hand-edited or partially migrated
/// `app.toml` can otherwise have an `active_repo` that `alinery_list_repos` advertises as
/// valid but every repo-scoped tool then rejects as "not in the known repository set".
fn known_repos(app_config: Option<&Path>) -> Vec<String> {
    let cfg = load_public_app_config(app_config).unwrap_or_default();
    let active = cfg.active_repo.trim();
    let mut repos = cfg.known_repos;
    if !active.is_empty() && !repos.iter().any(|known| known.trim() == active) {
        repos.push(active.to_string());
    }
    repos
}

fn list_repos_text(process_repo: Option<&Path>, app_config: Option<&Path>) -> String {
    let fallback = process_repo.map(|p| p.display().to_string()).unwrap_or_default();
    let public_config = load_public_app_config(app_config).unwrap_or_else(|| alinery_core::AppConfig {
        active_repo: fallback.clone(),
        known_repos: if fallback.is_empty() { Vec::new() } else { vec![fallback.clone()] },
    });
    serde_json::to_string(&public_config).unwrap_or_else(|_| format!(r#"{{"active_repo":"{}","known_repos":[]}}"#, fallback))
}

fn handle_resource_read(params: &Value, repo: &Path) -> Value {
    let uri = params.get("uri").and_then(|v| v.as_str()).unwrap_or("");
    eprintln!("MCP resources/read: uri={} repo={}", uri, repo.display());
    if is_remote(repo) {
        eprintln!("MCP remote-skip: resources/read (repo not local)");
        return json!({"contents": [{"uri": uri, "mimeType": "text/plain", "text": REMOTE_MSG}]});
    }
    let rel = uri.strip_prefix("alinery://").unwrap_or(uri).trim_start_matches('/');
    // Resolve to a path under .alinery, then confine it there (#5 traversal guard).
    let tail = if let Some(after) = rel.split_once("/.alinery/") {
        after.1.to_string()
    } else if let Some(stripped) = rel.strip_prefix(".alinery/") {
        stripped.to_string()
    } else {
        rel.to_string()
    };
    let base = repo.join(".alinery");
    let candidate = base.join(&tail);
    let confined = candidate.canonicalize().ok().filter(|c| c.starts_with(base.canonicalize().unwrap_or(base.clone())));
    let content = match confined {
        Some(p) => std::fs::read_to_string(p).unwrap_or_default(),
        None => {
            eprintln!("MCP resources/read: rejected out-of-tree uri {}", uri);
            String::new()
        }
    };
    json!({"contents": [{"uri": uri, "mimeType": "text/markdown", "text": content}]})
}

/// Resolved backup prefs for this repo: global defaults (app.toml, when the caller passed
/// one) overlaid with the repo's `.alinery/config.toml` overrides — the same merge the app uses,
/// so the MCP server can never disagree with the UI about where backups go.
fn effective_backup_settings(repo: &Path, app_config: Option<&Path>) -> alinery_core::BackupDefaults {
    let global = app_config.map(alinery_core::load_global_settings).unwrap_or_else(alinery_core::default_global_settings);
    let overrides = alinery_core::load_repo_overrides(repo);
    alinery_core::resolve_effective_config(&global, &overrides).backup
}
fn create_pre_archive_backup(repo: &Path, app_config: Option<&Path>) {
    let settings = effective_backup_settings(repo, app_config);
    if settings.trigger_pre_archive {
        if let Err(error) = alinery_core::create_backup(repo, &settings, alinery_core::BackupTrigger::PreArchive, env!("CARGO_PKG_VERSION")) {
            eprintln!("MCP pre-archive backup failed: {error}");
        }
    }
}

fn repo_prop() -> Value {
    json!({"type": "string", "description": "Repo root path — one of the paths returned by alinery_list_repos (active_repo or known_repos)."})
}

fn list_tools() -> Value {
    json!([
        {"name":"alinery_list_repos","description":"List known repos (local + discovery)","inputSchema":{"type":"object"}},
        {"name":"alinery_list_tasks","description":"List tasks for repo","inputSchema":{"type":"object","properties":{"repo":repo_prop()},"required":["repo"]}},
        {"name":"alinery_get_task","description":"Get task.md content","inputSchema":{"type":"object","properties":{"repo":repo_prop(),"slug":{"type":"string"}},"required":["repo"]}},
        {"name":"alinery_create_task","description":"Create a task plus its first session, in the given playbook (default: superdevelop) (local only)","inputSchema":{"type":"object","properties":{"repo":repo_prop(),"name":{"type":"string"},"description":{"type":"string"},"playbook":{"type":"string","description":"Primary playbook for the task's first session. Defaults to 'superdevelop'. Built-in options: superdevelop, one-shot, free-form, review, bug-hunting. Call alinery_list_playbooks for the full set available in this repo (custom playbooks may be configured)."}},"required":["repo"]}},
        {"name":"alinery_list_sessions","description":"List sessions for task","inputSchema":{"type":"object","properties":{"repo":repo_prop(),"slug":{"type":"string"}},"required":["repo"]}},
        {"name":"alinery_create_session","description":"Create a playbook-step OMP session in the task's primary or selected playbook, or an auxiliary Generic Terminal session (no-harness). prompt_extra appends instructions to a playbook-step prompt exactly once; Generic Terminal rows do not take prompt_extra. Set start=true to start durably through alineryd.","inputSchema":{"type":"object","properties":{"repo":repo_prop(),"slug":{"type":"string"},"task_slug":{"type":"string"},"playbook":{"type":"string","description":"Playbook to select for this session; defaults to the task's primary playbook. Built-in options: superdevelop, one-shot, free-form, review, bug-hunting. Call alinery_list_playbooks for the full set available in this repo (custom playbooks may be configured)."},"generic":{"type":"boolean","default":false},"phase":{"type":"string"},"model":{"type":"string"},"prompt_extra":{"type":"string"},"start":{"type":"boolean","default":false}},"required":["repo"]}},
        {"name":"alinery_start_session","description":"Durably start an eligible never-started task session through its recorded alineryd lane. This does not attach interactive terminal control.","inputSchema":{"type":"object","properties":{"repo":repo_prop(),"task_slug":{"type":"string"},"session_id":{"type":"string"}},"required":["repo","task_slug","session_id"]}},
        {"name":"alinery_send_review_handoff","description":"Copy review findings to another task and create a target session (local only)","inputSchema":{"type":"object","properties":{"repo":repo_prop(),"source_slug":{"type":"string"},"source_artifact":{"type":"string"},"target_slug":{"type":"string"},"source_session":{"type":"string"},"target_phase":{"type":"string"},"model":{"type":"string"},"prompt_extra":{"type":"string"}},"required":["repo","source_slug","source_artifact","target_slug"]}},
        {"name":"alinery_list_playbook_steps","description":"List selectable steps for a playbook","inputSchema":{"type":"object","properties":{"repo":repo_prop(),"playbook":{"type":"string"}},"required":["repo"]}},
        {"name":"alinery_session_status","description":"Read complete persisted metadata and lifecycle plus optional structured live process, agent, playbook, and adapter state. Observation never starts or attaches a daemon.","inputSchema":{"type":"object","properties":{"repo":repo_prop(),"slug":{"type":"string"},"task_slug":{"type":"string"},"id":{"type":"string"},"session_id":{"type":"string"}},"required":["repo"]}},
        {"name":"alinery_read_session_history","description":"Read bounded history without interactive control: reconstructed terminal screen by default, or a lossless raw byte window when offset and limit are supplied together.","inputSchema":{"type":"object","properties":{"repo":repo_prop(),"task_slug":{"type":"string"},"session_id":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":0}},"required":["repo","task_slug","session_id"]}},
        {"name":"alinery_list_artifacts","description":"List artifacts","inputSchema":{"type":"object","properties":{"repo":repo_prop(),"slug":{"type":"string"}},"required":["repo"]}},
        {"name":"alinery_read_artifact","description":"Read artifact content","inputSchema":{"type":"object","properties":{"repo":repo_prop(),"slug":{"type":"string"},"filename":{"type":"string"}},"required":["repo"]}},
        {"name":"alinery_read_config","description":"Read .alinery/config.toml","inputSchema":{"type":"object","properties":{"repo":repo_prop()},"required":["repo"]}},
        {"name":"alinery_write_config","description":"Write .alinery/config.toml (validated as TOML)","inputSchema":{"type":"object","properties":{"repo":repo_prop(),"content":{"type":"string"}},"required":["repo"]}},
        {"name":"alinery_list_phases","description":"Compatibility: list SuperDevelop playbook steps","inputSchema":{"type":"object","properties":{"repo":repo_prop()},"required":["repo"]}},
        {"name":"alinery_list_playbooks","description":"List playbook summaries","inputSchema":{"type":"object","properties":{"repo":repo_prop()},"required":["repo"]}},
        {"name":"alinery_create_subtask","description":"Create an approved child for an Alinery sub-task manager","inputSchema":{"type":"object","additionalProperties":false,"properties":{"repo":repo_prop(),"manager_session_id":{"type":"string"},"name":{"type":"string"},"slug":{"type":"string"},"playbook":{"type":"string","description":"Playbook for the child task. Built-in options: superdevelop, one-shot, free-form, review, bug-hunting. Call alinery_list_playbooks for the full set available in this repo (custom playbooks may be configured)."},"instructions":{"type":"string"}},"required":["repo","manager_session_id","name","slug","playbook"]}},
        {"name":"alinery_inspect_subtask_finish","description":"Inspect durable Git and artifact state before finishing a child","inputSchema":{"type":"object","additionalProperties":false,"properties":{"repo":repo_prop(),"manager_session_id":{"type":"string"}},"required":["repo","manager_session_id"]}},
        {"name":"alinery_finalize_subtask","description":"Finalize an inspected child with an explicit code disposition","inputSchema":{"type":"object","additionalProperties":false,"properties":{"repo":repo_prop(),"manager_session_id":{"type":"string"},"mode":{"type":"string","enum":["artifacts_only","integrated_code","archive_without_code"]}},"required":["repo","manager_session_id","mode"]}},
        {"name":"alinery_archive_task","description":"Archive task","inputSchema":{"type":"object","properties":{"repo":repo_prop(),"slug":{"type":"string"}},"required":["repo"]}},
        {"name":"alinery_storage_info","description":"Disk usage for the repo: archived (reclaimable) vs active Alinery data","inputSchema":{"type":"object","properties":{"repo":repo_prop()},"required":["repo"]}},
        {"name":"alinery_delete_archived_storage","description":"Permanently delete archived tasks, archived sessions and their worktrees (local only, irreversible)","inputSchema":{"type":"object","properties":{"repo":repo_prop()},"required":["repo"]}},
        {"name":"alinery_backup_now","description":"Create a point-in-time backup of this repo's Alinery data (no restore via MCP)","inputSchema":{"type":"object","properties":{"repo":repo_prop()},"required":["repo"]}}
    ])
}

fn create_session_meta_with_app_config(app_config: Option<&Path>, repo: &Path, input: alinery_core::CreateSessionInput) -> Result<alinery_core::SessionMeta, String> {
    match app_config {
        Some(path) => alinery_core::create_session_meta_for(path, repo, input),
        None => alinery_core::create_session_meta(repo, input),
    }
}

fn create_initial_subtask_session(app_config: Option<&Path>, repo: &Path, result: &alinery_core::CreateSubtaskResult) -> Result<alinery_core::SessionMeta, String> {
    let app_config = app_config.ok_or("the manager session did not provide an app config")?;
    let defaults = alinery_core::read_scoped_settings(app_config, repo).effective.defaults;
    let playbook_key = &result.child_task.playbook;
    let playbook = alinery_core::get_playbook(repo, playbook_key).ok_or_else(|| format!("unknown playbook '{playbook_key}'"))?;
    let phase = playbook
        .steps
        .first()
        .filter(|step| !step.is_empty())
        .ok_or_else(|| format!("playbook '{playbook_key}' has no first step"))?;
    let meta = create_session_meta_with_app_config(
        Some(app_config),
        repo,
        alinery_core::CreateSessionInput {
            task_slug: result.child_task.slug.clone(),
            playbook: playbook_key.clone(),
            phase: phase.clone(),
            harness: alinery_core::DEFAULT_HARNESS_KEY.to_string(),
            model: alinery_core::omp_default_model(&defaults),
            ..Default::default()
        },
    )?;
    let namespace = &result.manager_session.daemon_namespace;
    let socket = alinery_core::alineryd_socket_path(repo, (!namespace.is_empty()).then_some(namespace));
    let (client, _) = alinery_core::connect_compatible_once(socket, app_config).map_err(|error| match error {
        alinery_core::DaemonClientError::ProtocolMismatch { .. } => "the manager daemon uses an incompatible protocol".to_string(),
        alinery_core::DaemonClientError::AppConfigMismatch { .. } => "the manager daemon uses a different app config".to_string(),
        other => other.to_string(),
    })?;
    client.spawn_session(&meta.id, &result.child_task.slug)?;
    Ok(alinery_core::read_session_meta_full(&alinery_core::session_meta_path(repo, &result.child_task.slug, &meta.id)).unwrap_or(meta))
}

fn subtask_creation_response(app_config: Option<&Path>, repo: &Path, result: alinery_core::CreateSubtaskResult) -> Value {
    let initial_session = create_initial_subtask_session(app_config, repo, &result);
    let mut response = serde_json::to_value(result).unwrap_or_else(|_| json!({}));
    if let Some(object) = response.as_object_mut() {
        match initial_session {
            Ok(meta) => {
                object.insert("initial_session".into(), serde_json::to_value(meta).unwrap_or(Value::Null));
            }
            Err(error) => {
                object.insert("initial_session_error".into(), Value::String(error));
            }
        }
    }
    response
}

fn send_review_handoff_with_app_config(app_config: Option<&Path>, repo: &Path, request: alinery_core::ReviewHandoffRequest) -> Result<alinery_core::ReviewHandoffResult, String> {
    match app_config {
        Some(path) => alinery_core::send_review_handoff_for(path, repo, request),
        None => alinery_core::send_review_handoff(repo, request),
    }
}

fn validate_exact_arguments(args: &Value, allowed: &[&str], required: &[&str]) -> Result<(), Value> {
    let Some(object) = args.as_object() else {
        return Err(text_result("error: arguments must be an object"));
    };
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(text_result(format!("error: unknown argument '{key}'")));
    }
    if let Some(key) = required.iter().find(|key| !object.get(**key).is_some_and(|value| value.is_string())) {
        return Err(text_result(format!("error: missing required argument '{key}'")));
    }
    Ok(())
}

#[cfg(unix)]
fn observed_parent_sessions(repo: &Path, app_config: Option<&Path>, manager_session_id: &str) -> Vec<String> {
    let Some(config_path) = app_config.map(Path::to_path_buf).or_else(alinery_core::app_config_toml_path) else {
        return Vec::new();
    };
    let mut live = std::collections::BTreeSet::new();
    for (_, socket) in alinery_core::list_alineryd_lane_sockets(repo) {
        let Ok((client, _)) = alinery_core::connect_compatible_once(socket, &config_path) else {
            continue;
        };
        let Ok(sessions) = client.session_statuses_observed() else {
            continue;
        };
        for session in sessions {
            if matches!(session.state.process, alinery_core::ProcessState::Starting | alinery_core::ProcessState::Alive) {
                live.insert(session.id);
            }
        }
    }
    let Ok(owner_slug) = alinery_core::subtask_manager_owner_slug(repo, manager_session_id) else {
        return Vec::new();
    };
    std::fs::read_dir(alinery_core::sessions_dir(repo, &owner_slug))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| alinery_core::read_session_meta_full(&entry.path()))
        .filter(|meta| !meta.archived && live.contains(&meta.id))
        .map(|meta| meta.id)
        .collect()
}

#[cfg(not(unix))]
fn observed_parent_sessions(_repo: &Path, _app_config: Option<&Path>, _manager_session_id: &str) -> Vec<String> {
    Vec::new()
}

fn effective_app_config_path(app_config: Option<&Path>) -> Result<PathBuf, String> {
    app_config
        .map(Path::to_path_buf)
        .or_else(alinery_core::app_config_toml_path)
        .ok_or_else(|| "app config path is unavailable".into())
}

fn load_owned_session(repo: &Path, task_slug: &str, session_id: &str) -> Result<alinery_core::SessionMeta, String> {
    safe_component(task_slug).ok_or_else(|| format!("invalid task_slug '{task_slug}'"))?;
    safe_component(session_id).ok_or_else(|| format!("invalid session_id '{session_id}'"))?;
    alinery_core::read_task(repo, task_slug).ok_or_else(|| format!("missing task '{task_slug}'"))?;
    let path = alinery_core::session_meta_path(repo, task_slug, session_id);
    let meta = alinery_core::read_session_meta_full(&path).ok_or_else(|| format!("missing session meta '{session_id}' for task '{task_slug}'"))?;
    if meta.id != session_id {
        return Err(format!("session metadata id '{}' does not match '{session_id}'", meta.id));
    }
    Ok(meta)
}

fn start_task_session(repo: &Path, app_config: Option<&Path>, task_slug: &str, session_id: &str) -> Result<alinery_core::SessionStartResult, String> {
    let app_config = effective_app_config_path(app_config)?;
    alinery_core::validate_task_session_start(&app_config, repo, task_slug, session_id)?;
    let meta = load_owned_session(repo, task_slug, session_id)?;
    let namespace = (!meta.daemon_namespace.is_empty()).then_some(meta.daemon_namespace.as_str());
    let (client, _) = alinery_core::daemon_client::ensure_compatible_daemon(repo, &app_config, namespace).map_err(|error| error.to_string())?;
    client.spawn_session(session_id, task_slug)?;

    let persisted = load_owned_session(repo, task_slug, session_id)?;
    let started_at = persisted.started_at.ok_or("daemon acknowledged spawn without a durable started_at stamp")?;
    let live = client
        .session_status_observed(session_id)?
        .ok_or("daemon acknowledged spawn but does not own the session")?;
    Ok(alinery_core::SessionStartResult {
        task_slug: task_slug.to_string(),
        session_id: session_id.to_string(),
        started_at,
        state: live.state,
    })
}

fn observe_task_session(repo: &Path, app_config: Option<&Path>, task_slug: &str, session_id: &str) -> Result<alinery_core::SessionStatusResult, String> {
    let meta = load_owned_session(repo, task_slug, session_id)?;
    let app_config = effective_app_config_path(app_config)?;
    let namespace = (!meta.daemon_namespace.is_empty()).then_some(meta.daemon_namespace.as_str());
    let socket_path = alinery_core::alineryd_socket_path(repo, namespace);
    let live = match alinery_core::daemon_client::connect_compatible(socket_path, &app_config) {
        Ok((client, _)) => client.session_status_observed(session_id)?,
        Err(alinery_core::daemon_client::DaemonClientError::Unreachable { .. }) => None,
        Err(error) => return Err(error.to_string()),
    };
    let lifecycle = alinery_core::classify(meta.started_at, meta.ended_at, meta.exit_code, live.as_ref().map(|live| &live.state.process));
    Ok(alinery_core::SessionStatusResult {
        session: meta,
        task_slug: task_slug.to_string(),
        session_id: session_id.to_string(),
        lifecycle,
        state: live.map(|live| live.state),
    })
}

/// True when `requested` matches a known repo entry — either the calling process's own
/// `--repo`, or an entry in the app's `known_repos` list — using plain string comparison
/// (trailing-slash spelling ignored), never Git validation. This is what makes the
/// pre-existing "remote repo" contract (read-only discovery of a repo that is listed but
/// not locally cloned on this machine) reachable at all: such a repo can never resolve
/// through `git rev-parse --show-toplevel`.
fn is_registered_repo_entry(requested: &str, process_repo: Option<&Path>, known_repos: &[String]) -> bool {
    let requested = requested.trim_end_matches('/');
    process_repo.is_some_and(|p| p.to_string_lossy().trim_end_matches('/') == requested) || known_repos.iter().any(|known| known.trim().trim_end_matches('/') == requested)
}

/// Resolve the per-call `repo` argument for one tool invocation. The single choke point for
/// every repo-scoped tool: a missing `repo` is a hard error, an unregistered repo is a hard
/// error, and a registered-but-not-locally-cloned entry is allowed only for the read-only
/// discovery tools that have always tolerated it — never for anything that writes. A missing
/// path and an existing-but-not-a-checkout path get distinct messages: only the former is
/// plausibly remote/ssh.
fn resolve_call_repo(tool_name: &str, args: &Value, process_repo: Option<&Path>, app_config: Option<&Path>) -> Result<PathBuf, Value> {
    let requested = args.get("repo").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if requested.is_empty() {
        return Err(text_result("error: repo is required"));
    }
    let known = known_repos(app_config);
    if is_registered_repo_entry(&requested, process_repo, &known) {
        let candidate = PathBuf::from(&requested);
        let discovery_only_msg = if candidate.exists() { NOT_LOCAL_CHECKOUT_MSG } else { REMOTE_MSG };
        if is_remote(&candidate) {
            return if matches!(tool_name, "alinery_list_tasks" | "alinery_get_task") {
                Ok(candidate)
            } else {
                Err(text_result(discovery_only_msg))
            };
        }
    }
    alinery_core::resolve_target_repo(&requested, process_repo, &known).map_err(|error| text_result(format!("error: {error}")))
}

fn handle_tool_call_in(params: Value, process_repo: Option<&Path>, app_config: Option<&Path>, daemon_namespace: &str) -> Value {
    let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
    let args = params.get("arguments").cloned().unwrap_or(json!({}));

    // The one tool with no repo argument at all — it reports the global known-repos list.
    if name == "alinery_list_repos" {
        return text_result(list_repos_text(process_repo, app_config));
    }

    let repo = match resolve_call_repo(name, &args, process_repo, app_config) {
        Ok(path) => path,
        Err(response) => return response,
    };
    let repo = repo.as_path();
    eprintln!("MCP tool call: name={} repo={}", name, repo.display());

    // helper to pull + validate a required path component argument
    let comp = |key: &str| -> Result<String, Value> {
        let raw = args.get(key).and_then(|v| v.as_str()).unwrap_or("");
        match safe_component(raw) {
            Some(s) => Ok(s.to_string()),
            None => Err(text_result(format!("error: invalid {} '{}'", key, raw))),
        }
    };

    match name {
        "alinery_list_tasks" => {
            let list: Vec<_> = alinery_core::list_tasks_for_repo(repo).into_iter().map(|t| t.slug).collect();
            text_result(serde_json::to_string(&list).unwrap())
        }
        "alinery_get_task" => {
            let slug = match comp("slug") {
                Ok(s) => s,
                Err(e) => return e,
            };
            let p = repo.join(".alinery/tasks").join(&slug).join("task.md");
            text_result(std::fs::read_to_string(p).unwrap_or_default())
        }
        "alinery_create_task" => create_task(repo, app_config, &args),
        "alinery_list_sessions" => {
            let slug = match comp("slug") {
                Ok(s) => s,
                Err(e) => return e,
            };
            let dir = repo.join(".alinery/tasks").join(&slug).join("sessions");
            let mut list: Vec<Value> = vec![];
            if let Ok(rd) = std::fs::read_dir(&dir) {
                for e in rd.flatten() {
                    let p = e.path();
                    if p.extension().and_then(|s| s.to_str()) == Some("json") {
                        if let Ok(s) = std::fs::read_to_string(&p) {
                            if let Ok(v) = serde_json::from_str::<Value>(&s) {
                                list.push(v);
                            }
                        }
                    }
                }
            }
            text_result(serde_json::to_string(&list).unwrap_or_else(|_| "[]".into()))
        }
        "alinery_create_session" => {
            if args.get("prompt").is_some() {
                return text_result("error: exact prompt replacement is not supported; use prompt_extra");
            }
            let raw_slug = args.get("task_slug").and_then(Value::as_str).unwrap_or("");
            let slug = match safe_component(raw_slug) {
                Some(slug) => slug.to_string(),
                None => return text_result(format!("error: invalid slug '{raw_slug}'")),
            };
            let start = args.get("start").and_then(Value::as_bool).unwrap_or(false);
            let generic = args.get("generic").and_then(Value::as_bool).unwrap_or(false);
            let created = create_session_meta_with_app_config(
                app_config,
                repo,
                alinery_core::CreateSessionInput {
                    task_slug: slug.clone(),
                    playbook: args.get("playbook").and_then(Value::as_str).unwrap_or("").to_string(),
                    generic,
                    phase: args.get("phase").and_then(Value::as_str).unwrap_or("").to_string(),
                    harness: if generic {
                        alinery_core::NO_HARNESS_KEY.to_string()
                    } else {
                        alinery_core::DEFAULT_HARNESS_KEY.to_string()
                    },
                    model: args.get("model").and_then(Value::as_str).unwrap_or("").to_string(),
                    prompt_extra: args.get("prompt_extra").and_then(Value::as_str).unwrap_or("").to_string(),
                    daemon_namespace: daemon_namespace.to_string(),
                    ..Default::default()
                },
            );
            match created {
                Ok(meta) => {
                    if let Some(path) = app_config {
                        alinery_core::record_event(
                            path,
                            alinery_core::TelemetryEvent::SessionCreate {
                                source: alinery_core::TelemetrySource::Mcp,
                                harness: meta.harness.clone(),
                                phase: meta.phase.clone(),
                                generic: meta.generic,
                                drawer: false,
                                is_resume: false,
                                session_id: meta.telemetry_id.clone(),
                                task_id: alinery_core::telemetry_id_for_task(repo, &slug),
                            },
                        );
                    }
                    if !start {
                        text_result(serde_json::to_string(&meta).unwrap_or_default())
                    } else {
                        match start_task_session(repo, app_config, &slug, &meta.id) {
                            Ok(result) => text_result(serde_json::to_string(&result).unwrap_or_default()),
                            Err(error) => text_result(format!("error: created task_slug={} session_id={}; start failed: {error}", slug, meta.id)),
                        }
                    }
                }
                Err(error) => text_result(format!("error: {error}")),
            }
        }
        "alinery_start_session" => {
            let task_slug = match comp("task_slug") {
                Ok(value) => value,
                Err(error) => return error,
            };
            let session_id = match comp("session_id") {
                Ok(value) => value,
                Err(error) => return error,
            };
            match start_task_session(repo, app_config, &task_slug, &session_id) {
                Ok(result) => text_result(serde_json::to_string(&result).unwrap_or_default()),
                Err(error) => text_result(format!("error: {error}")),
            }
        }
        "alinery_send_review_handoff" => {
            let source_slug = match comp("source_slug") {
                Ok(s) => s,
                Err(e) => return e,
            };
            let target_slug = match comp("target_slug") {
                Ok(s) => s,
                Err(e) => return e,
            };
            let source_artifact = match alinery_core::validate_artifact_filename(args.get("source_artifact").and_then(|v| v.as_str()).unwrap_or("")) {
                Ok(s) => s,
                Err(e) => return text_result(format!("error: {e}")),
            };
            match send_review_handoff_with_app_config(
                app_config,
                repo,
                alinery_core::ReviewHandoffRequest {
                    source_slug,
                    source_session: args.get("source_session").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    source_artifact,
                    target_slug,
                    target_phase: args.get("target_phase").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    harness: alinery_core::DEFAULT_HARNESS_KEY.to_string(),
                    model: args.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    prompt_extra: args.get("prompt_extra").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                },
            ) {
                Ok(result) => {
                    if let Some(path) = app_config {
                        alinery_core::record_event(
                            path,
                            alinery_core::TelemetryEvent::ArtifactReviewHandoff {
                                source: alinery_core::TelemetrySource::Mcp,
                                target_phase: result.target_record.target_phase.clone(),
                                harness: result.target_session.harness.clone(),
                            },
                        );
                    }
                    text_result(serde_json::to_string(&result).unwrap_or_default())
                }
                Err(e) => text_result(format!("error: {e}")),
            }
        }
        "alinery_session_status" => {
            let raw_task_slug = args.get("task_slug").and_then(Value::as_str).unwrap_or("");
            let task_slug = match safe_component(raw_task_slug) {
                Some(value) => value.to_string(),
                None => return text_result(format!("error: invalid task slug '{raw_task_slug}'")),
            };
            let raw_session_id = args.get("session_id").and_then(Value::as_str).unwrap_or("");
            let session_id = match safe_component(raw_session_id) {
                Some(value) => value.to_string(),
                None => return text_result(format!("error: invalid session id '{raw_session_id}'")),
            };
            match observe_task_session(repo, app_config, &task_slug, &session_id) {
                Ok(result) => text_result(serde_json::to_string(&result).unwrap_or_default()),
                Err(error) => text_result(format!("error: {error}")),
            }
        }
        "alinery_read_session_history" => {
            let task_slug = match comp("task_slug") {
                Ok(value) => value,
                Err(error) => return error,
            };
            let session_id = match comp("session_id") {
                Ok(value) => value,
                Err(error) => return error,
            };
            let number = |key: &str| -> Result<Option<u64>, Value> {
                match args.get(key) {
                    None => Ok(None),
                    Some(value) => value.as_u64().map(Some).ok_or_else(|| text_result(format!("error: {key} must be a non-negative integer"))),
                }
            };
            let offset = match number("offset") {
                Ok(value) => value,
                Err(error) => return error,
            };
            let limit = match number("limit") {
                Ok(value) => value,
                Err(error) => return error,
            };
            match alinery_core::read_session_history(repo, &task_slug, &session_id, offset, limit) {
                Ok(result) => text_result(serde_json::to_string(&result).unwrap_or_default()),
                Err(error) => text_result(format!("error: {error}")),
            }
        }
        "alinery_list_artifacts" => {
            let slug = match comp("slug") {
                Ok(s) => s,
                Err(e) => return e,
            };
            let list = alinery_core::visible_artifact_names(repo, &slug).unwrap_or_default();
            text_result(serde_json::to_string(&list).unwrap())
        }
        "alinery_read_artifact" => {
            let slug = match comp("slug") {
                Ok(s) => s,
                Err(e) => return e,
            };
            let fname = match comp("filename") {
                Ok(s) => s,
                Err(e) => return e,
            };
            let p = repo.join(".alinery/tasks").join(&slug).join("artifacts").join(&fname);
            text_result(std::fs::read_to_string(p).unwrap_or_default())
        }
        "alinery_read_config" => text_result(std::fs::read_to_string(repo.join(".alinery/config.toml")).unwrap_or_default()),
        "alinery_write_config" => write_toml_file(repo.join(".alinery/config.toml"), &args, app_config, repo, alinery_core::SettingsChangeScope::Repo),
        "alinery_list_phases" => {
            let wf = alinery_core::get_playbook(repo, alinery_core::DEFAULT_PLAYBOOK_KEY).unwrap_or_else(|| alinery_core::default_playbook(repo));
            let ps: Vec<_> = wf.steps.iter().filter_map(|key| wf.step.get(key).map(|s| json!({"key": key, "title": s.title}))).collect();
            text_result(serde_json::to_string(&ps).unwrap_or_else(|_| "[]".into()))
        }
        "alinery_list_playbook_steps" => {
            let playbook = args.get("playbook").and_then(|v| v.as_str()).unwrap_or(alinery_core::DEFAULT_PLAYBOOK_KEY);
            let wf = alinery_core::get_playbook(repo, playbook).unwrap_or_else(|| alinery_core::default_playbook(repo));
            let steps: Vec<_> = wf
                .steps
                .iter()
                .filter_map(|key| {
                    wf.step.get(key).map(|s| {
                        json!({
                            "key": key,
                            "title": s.title,
                            "short": s.short,
                            "artifact": s.artifact,
                            "column": s.column,
                            "harness": s.harness
                        })
                    })
                })
                .collect();
            text_result(serde_json::to_string(&steps).unwrap_or_else(|_| "[]".into()))
        }
        "alinery_list_playbooks" => {
            let f = alinery_core::load_playbooks(repo);
            let mut keys = f.playbook_order.clone();
            for key in f.playbooks.keys() {
                if !keys.contains(key) {
                    keys.push(key.clone());
                }
            }
            let list: Vec<_> = keys.iter().filter_map(|key| f.playbooks.get(key).map(|wf| json!({
                "key": key, "title": wf.title, "description": wf.description, "kind": wf.kind,
                "default_harness": wf.default_harness, "steps": wf.steps,
                "auto_advance": alinery_core::ordered_auto_advance_edges(wf).into_iter().map(|(edge_key, edge)| json!({"key": edge_key, "title": edge.title, "from": edge.from, "to": edge.to, "default_enabled": edge.default_enabled})).collect::<Vec<_>>()
            }))).collect();
            text_result(serde_json::to_string(&list).unwrap_or_else(|_| "[]".into()))
        }
        "alinery_create_subtask" => {
            if let Err(error) = validate_exact_arguments(
                &args,
                &["repo", "manager_session_id", "name", "slug", "playbook", "instructions"],
                &["repo", "manager_session_id", "name", "slug", "playbook"],
            ) {
                return error;
            }
            if args.get("instructions").is_some_and(|value| !value.is_string()) {
                return text_result("error: instructions must be a string");
            }
            let input = alinery_core::CreateSubtaskInput {
                manager_session_id: args["manager_session_id"].as_str().unwrap_or_default().to_string(),
                name: args["name"].as_str().unwrap_or_default().to_string(),
                slug: args["slug"].as_str().unwrap_or_default().to_string(),
                playbook: args["playbook"].as_str().unwrap_or_default().to_string(),
                instructions: args.get("instructions").and_then(Value::as_str).unwrap_or("").to_string(),
            };
            match alinery_core::create_subtask(repo, input) {
                Ok(result) => text_result(subtask_creation_response(app_config, repo, result).to_string()),
                Err(error) => text_result(format!("error: {error}")),
            }
        }
        "alinery_inspect_subtask_finish" => {
            if let Err(error) = validate_exact_arguments(&args, &["repo", "manager_session_id"], &["repo", "manager_session_id"]) {
                return error;
            }
            let manager_session_id = args["manager_session_id"].as_str().unwrap_or_default();
            let observed = observed_parent_sessions(repo, app_config, manager_session_id);
            match alinery_core::inspect_subtask_finish(repo, manager_session_id, observed) {
                Ok(result) => text_result(serde_json::to_string(&result).unwrap_or_default()),
                Err(error) => text_result(format!("error: {error}")),
            }
        }
        "alinery_finalize_subtask" => {
            if let Err(error) = validate_exact_arguments(&args, &["repo", "manager_session_id", "mode"], &["repo", "manager_session_id", "mode"]) {
                return error;
            }
            let mode = match args["mode"].as_str().unwrap_or_default() {
                "artifacts_only" => alinery_core::FinalizeMode::ArtifactsOnly,
                "integrated_code" => alinery_core::FinalizeMode::IntegratedCode,
                "archive_without_code" => alinery_core::FinalizeMode::ArchiveWithoutCode,
                other => return text_result(format!("error: unknown finalize mode '{other}'")),
            };
            create_pre_archive_backup(repo, app_config);
            match alinery_core::finalize_subtask(repo, args["manager_session_id"].as_str().unwrap_or_default(), mode) {
                Ok(result) => text_result(serde_json::to_string(&result).unwrap_or_default()),
                Err(error) => text_result(format!("error: {error}")),
            }
        }
        "alinery_archive_task" => {
            let slug = match comp("slug") {
                Ok(s) => s,
                Err(e) => return e,
            };
            if alinery_core::read_task(repo, &slug).is_none() {
                return text_result("error: no such task");
            }
            if let Err(error) = alinery_core::ensure_task_can_archive(repo, &slug) {
                return text_result(format!("error: {error}"));
            }
            create_pre_archive_backup(repo, app_config);
            match alinery_core::archive_task_guarded(repo, &slug) {
                Ok(()) => {
                    if let Some(path) = app_config {
                        alinery_core::record_event(
                            path,
                            alinery_core::TelemetryEvent::TaskArchive {
                                source: alinery_core::TelemetrySource::Mcp,
                                task_id: alinery_core::telemetry_id_for_task(repo, &slug),
                            },
                        );
                    }
                    text_result("archived")
                }
                Err(e) => text_result(format!("error: {e}")),
            }
        }
        "alinery_storage_info" => {
            let s = alinery_core::storage_stats(repo);
            text_result(
                json!({
                    "archived_task_count": s.archived_task_count,
                    "archived_session_count": s.archived_session_count,
                    "archived_bytes": s.archived_bytes,
                    "archived_mb": alinery_core::format_mb(s.archived_bytes),
                    "active_bytes": s.active_bytes,
                    "active_mb": alinery_core::format_mb(s.active_bytes),
                    "total_mb": alinery_core::format_mb(s.active_bytes + s.archived_bytes),
                })
                .to_string(),
            )
        }
        "alinery_delete_archived_storage" => match alinery_core::purge_archived_storage(repo, &|_slug: &str, id: &str| {
            kill_session_on_lanes(repo, id);
        }) {
            Ok(res) => {
                if let Some(path) = app_config {
                    alinery_core::record_event(
                        path,
                        alinery_core::TelemetryEvent::StoragePurge {
                            source: alinery_core::TelemetrySource::Mcp,
                        },
                    );
                }
                text_result(serde_json::to_string(&res).unwrap_or_default())
            }
            Err(error) => text_result(format!("error: {error}")),
        },
        "alinery_backup_now" => {
            let settings = effective_backup_settings(repo, app_config);
            match alinery_core::create_backup(repo, &settings, alinery_core::BackupTrigger::Mcp, env!("CARGO_PKG_VERSION")) {
                Ok(meta) => {
                    if let Some(path) = app_config {
                        alinery_core::record_event(
                            path,
                            alinery_core::TelemetryEvent::BackupCreate {
                                source: alinery_core::TelemetrySource::Mcp,
                                trigger: alinery_core::BackupTrigger::Mcp,
                            },
                        );
                    }
                    text_result(serde_json::to_string(&meta).unwrap_or_else(|_| "{}".into()))
                }
                Err(e) => text_result(format!("error: {e}")),
            }
        }
        _ => text_result(format!("unknown tool {}", name)),
    }
}

#[cfg(test)]
fn handle_tool_call(params: Value, repo: &str, app_config: Option<&Path>) -> Value {
    handle_tool_call_in(with_injected_repo(params, repo), Some(Path::new(repo)), app_config, "")
}

/// Validate content parses as TOML before overwriting a settings file (#8).
fn write_toml_file(path: std::path::PathBuf, args: &Value, app_config: Option<&Path>, repo: &Path, scope: alinery_core::SettingsChangeScope) -> Value {
    let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
    if let Err(e) = content.parse::<toml::Value>() {
        return text_result(format!("error: not valid TOML ({}); not written", e));
    }
    let is_config = path.file_name().is_some_and(|n| n == "config.toml");
    let prior_text = if is_config && app_config.is_some() { std::fs::read_to_string(&path).ok() } else { None };
    match std::fs::write(&path, content) {
        Ok(_) => {
            if is_config {
                if let Some(cfg) = app_config {
                    match toml::from_str::<alinery_core::RepoOverrides>(content) {
                        Ok(next) => {
                            let prior = alinery_core::repo_overrides_prior_from_text(prior_text.as_deref());
                            alinery_core::log_repo_settings_event(cfg, repo, alinery_core::RepoSettingsEvent::Written { prior: &prior, next: &next });
                        }
                        Err(e) => alinery_core::log_repo_settings_event(cfg, repo, alinery_core::RepoSettingsEvent::UnparseableOverlay { source: content, error: &e }),
                    }
                }
            }
            if let Some(cfg) = app_config {
                alinery_core::record_event(
                    cfg,
                    alinery_core::TelemetryEvent::SettingsChange {
                        source: alinery_core::TelemetrySource::Mcp,
                        scope,
                    },
                );
            }
            text_result(format!("wrote {}", path.display()))
        }
        Err(e) => {
            if is_config {
                if let Some(cfg) = app_config {
                    alinery_core::log_repo_settings_event(cfg, repo, alinery_core::RepoSettingsEvent::WriteFailed { error: &e.to_string() });
                }
            }
            text_result(format!("write error: {}", e))
        }
    }
}

fn create_task(repo: &Path, app_config: Option<&Path>, args: &Value) -> Value {
    let nm = args.get("name").and_then(|v| v.as_str()).unwrap_or("untitled").trim().to_string();
    if nm.is_empty() {
        return text_result("error: empty name");
    }
    let desc = args.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let playbook_key = args.get("playbook").and_then(Value::as_str).unwrap_or("").trim();
    let playbook_key = if playbook_key.is_empty() {
        alinery_core::DEFAULT_PLAYBOOK_KEY.to_string()
    } else {
        playbook_key.to_string()
    };
    let playbook = match alinery_core::get_playbook(repo, &playbook_key) {
        Some(wf) => wf,
        None => return text_result(format!("error: unknown playbook '{playbook_key}'")),
    };
    let slug = alinery_core::unique_slug(repo, &alinery_core::slugify(&nm));
    if let Err(e) = alinery_core::prepare_task_dirs_and_ticket(repo, &slug, &nm, &desc) {
        return text_result(format!("prep error: {}", e));
    }
    let worktree_str = repo.join(".alinery/worktrees").join(&slug).to_string_lossy().to_string();
    let git_ok = alinery_core::git_cmd(repo)
        .args(["worktree", "add", &worktree_str, "-b", &slug])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !git_ok {
        let _ = std::fs::remove_dir_all(repo.join(".alinery/tasks").join(&slug));
        return text_result("git worktree failed");
    }
    let task = alinery_core::Task {
        name: nm.clone(),
        slug: slug.clone(),
        requested_slug: String::new(),
        branch: slug.clone(),
        worktree: worktree_str.clone(),
        has_worktree: true,
        created: now_secs(),
        archived: false,
        pr_url: String::new(),
        linear_id: String::new(),
        github_issue: String::new(),
        playbook: playbook_key.clone(),
        auto_advance: alinery_core::ordered_auto_advance_edges(&playbook)
            .into_iter()
            .filter(|(_, e)| e.default_enabled)
            .map(|(k, _)| k.clone())
            .collect(),
        parent_task: String::new(),
        active_subtask: String::new(),
        subtask_outcome: String::new(),
        draft: false,
        related_tasks: Vec::new(),
        telemetry_id: alinery_core::new_telemetry_id(),
    };
    if let Err(e) = alinery_core::write_task(repo, &task) {
        let _ = std::fs::remove_dir_all(repo.join(".alinery/tasks").join(&slug));
        let _ = alinery_core::git_cmd(repo).args(["worktree", "remove", "--force", &worktree_str]).output();
        return text_result(format!("write error: {}", e));
    }
    if let Some(path) = app_config {
        alinery_core::record_event(
            path,
            alinery_core::TelemetryEvent::TaskCreate {
                source: alinery_core::TelemetrySource::Mcp,
                has_attachments: false,
                has_worktree: true,
                from_draft: false,
                playbook: task.playbook.clone(),
                has_linear: false,
                has_github: false,
                task_id: task.telemetry_id.clone(),
            },
        );
    }
    let phase = playbook.steps.first().cloned().unwrap_or_default();
    match create_session_meta_with_app_config(
        app_config,
        repo,
        alinery_core::CreateSessionInput {
            task_slug: slug.clone(),
            phase,
            harness: alinery_core::DEFAULT_HARNESS_KEY.to_string(),
            ..Default::default()
        },
    ) {
        Ok(meta) => {
            if let Some(path) = app_config {
                alinery_core::record_event(
                    path,
                    alinery_core::TelemetryEvent::SessionCreate {
                        source: alinery_core::TelemetrySource::Mcp,
                        harness: meta.harness.clone(),
                        phase: meta.phase.clone(),
                        generic: meta.generic,
                        drawer: false,
                        is_resume: false,
                        session_id: meta.telemetry_id.clone(),
                        task_id: task.telemetry_id.clone(),
                    },
                );
            }
            text_result(format!("created task {} and session {}", slug, meta.id))
        }
        Err(e) => text_result(format!("created task {}; session creation failed: {}", slug, e)),
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

// Only tests need nanosecond uniqueness now that create_session_meta mints session ids (T0-3).
#[cfg(test)]
fn now_nanos() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_method_is_top_level_error() {
        let req = json!({"jsonrpc": "2.0", "id": 1, "method": "bogus"});
        let resp = handle_request(&req, "/tmp/x", None).unwrap();
        assert!(resp.get("error").is_some(), "error must be top-level, not in result");
        assert!(resp.get("result").is_none());
        assert_eq!(resp["error"]["code"], -32601);
    }

    #[test]
    fn notification_gets_no_response() {
        // no `id` → notification → must not respond
        let req = json!({"jsonrpc": "2.0", "method": "notifications/initialized"});
        assert!(handle_request(&req, "/tmp/x", None).is_none());
    }

    #[test]
    fn initialize_echoes_protocol_version() {
        let req = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}});
        let resp = handle_request(&req, "/tmp/x", None).unwrap();
        assert_eq!(resp["result"]["protocolVersion"], "2025-06-18");
    }

    #[test]
    fn traversal_components_rejected() {
        assert!(safe_component("../etc").is_none());
        assert!(safe_component("a/b").is_none());
        assert!(safe_component("/abs").is_none());
        assert!(safe_component("good-slug").is_some());
    }

    // A real, minimal Git checkout: `resolve_target_repo`/`git_top_level` shell out to
    // `git rev-parse --show-toplevel`, which a bare `.git/` directory does not satisfy.
    fn unique_repo(name: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let repo = std::env::temp_dir().join(format!("alinery-mcp-{name}-{nanos}"));
        std::fs::create_dir_all(&repo).unwrap();
        let init = alinery_core::git_cmd(&repo).args(["init"]).output().expect("git init");
        assert!(init.status.success(), "git init failed: {:?}", init);
        repo
    }

    fn write_task(repo: &std::path::Path, slug: &str, playbook: &str, worktree: &str) {
        let task = alinery_core::Task {
            name: slug.to_string(),
            slug: slug.to_string(),
            branch: slug.to_string(),
            worktree: worktree.to_string(),
            has_worktree: !worktree.is_empty(),
            created: 1,
            playbook: playbook.to_string(),
            ..Default::default()
        };
        let dir = repo.join(".alinery/tasks").join(slug);
        std::fs::create_dir_all(dir.join("artifacts")).unwrap();
        std::fs::create_dir_all(dir.join("sessions")).unwrap();
        std::fs::write(dir.join("task.md"), toml::to_string(&task).unwrap()).unwrap();
    }

    fn text_content(v: &Value) -> &str {
        v["content"][0]["text"].as_str().unwrap()
    }

    #[test]
    fn alinery_send_review_handoff_schema_is_listed() {
        let req = json!({"jsonrpc":"2.0","id":1,"method":"tools/list"});
        let resp = handle_request(&req, "/tmp/x", None).unwrap();
        let tools = resp["result"]["tools"].as_array().unwrap();
        let handoff = tools.iter().find(|tool| tool["name"] == "alinery_send_review_handoff").unwrap();
        assert_eq!(handoff["inputSchema"]["required"], json!(["repo", "source_slug", "source_artifact", "target_slug"]));
        let props = &handoff["inputSchema"]["properties"];
        assert!(props.get("source_session").is_some());
        assert!(props.get("target_phase").is_some());
        assert!(props.get("prompt_extra").is_some());
        assert!(tools.iter().any(|tool| tool["name"] == "alinery_list_playbook_steps"));
    }

    #[test]
    fn subtask_tools_have_closed_schemas() {
        let req = json!({"jsonrpc":"2.0","id":1,"method":"tools/list"});
        let resp = handle_request(&req, "/tmp/x", None).unwrap();
        let tools = resp["result"]["tools"].as_array().unwrap();
        let create = tools.iter().find(|tool| tool["name"] == "alinery_create_subtask").unwrap();
        let inspect = tools.iter().find(|tool| tool["name"] == "alinery_inspect_subtask_finish").unwrap();
        let finalize = tools.iter().find(|tool| tool["name"] == "alinery_finalize_subtask").unwrap();
        assert_eq!(create["inputSchema"]["additionalProperties"], false);
        assert_eq!(create["inputSchema"]["required"], json!(["repo", "manager_session_id", "name", "slug", "playbook"]));
        assert_eq!(inspect["inputSchema"]["additionalProperties"], false);
        assert_eq!(
            finalize["inputSchema"]["properties"]["mode"]["enum"],
            json!(["artifacts_only", "integrated_code", "archive_without_code"])
        );
    }

    #[test]
    fn subtask_tools_reject_unknown_and_invalid_arguments() {
        let repo = unique_repo("subtask-args");
        for (name, arguments, expected) in [
            (
                "alinery_create_subtask",
                json!({"manager_session_id":"m","name":"Child","slug":"child","playbook":"superdevelop","parent_slug":"spoof"}),
                "unknown argument 'parent_slug'",
            ),
            (
                "alinery_inspect_subtask_finish",
                json!({"manager_session_id":"m","slug":"spoof"}),
                "unknown argument 'slug'",
            ),
            (
                "alinery_finalize_subtask",
                json!({"manager_session_id":"m","mode":"merge"}),
                "unknown finalize mode 'merge'",
            ),
        ] {
            let result = handle_tool_call(json!({"name":name,"arguments":arguments}), repo.to_str().unwrap(), None);
            assert!(text_content(&result).contains(expected), "{name}: {}", text_content(&result));
        }
        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn session_tool_schemas_expose_create_start_status_and_history_contract() {
        let req = json!({"jsonrpc":"2.0","id":1,"method":"tools/list"});
        let resp = handle_request(&req, "/tmp/x", None).unwrap();
        let tools = resp["result"]["tools"].as_array().unwrap();
        let mut failures = Vec::new();

        let create = tools.iter().find(|tool| tool["name"] == "alinery_create_session").unwrap();
        let create_props = &create["inputSchema"]["properties"];
        for field in ["playbook", "generic", "prompt_extra", "start"] {
            if create_props.get(field).is_none() {
                failures.push(format!("create schema is missing {field}"));
            }
        }
        if create_props.get("prompt").is_some() {
            failures.push("create schema exposes exact prompt replacement".into());
        }
        if create_props["prompt_extra"].get("maxLength").is_some() {
            failures.push("prompt_extra has a field-specific maxLength".into());
        }

        match tools.iter().find(|tool| tool["name"] == "alinery_start_session") {
            Some(tool) if tool["inputSchema"]["required"] == json!(["repo", "task_slug", "session_id"]) => {}
            Some(_) => failures.push("start schema has the wrong required fields".into()),
            None => failures.push("start tool is missing".into()),
        }
        match tools.iter().find(|tool| tool["name"] == "alinery_read_session_history") {
            Some(tool) if tool["inputSchema"]["required"] == json!(["repo", "task_slug", "session_id"]) => {
                let props = &tool["inputSchema"]["properties"];
                if props.get("offset").is_none() || props.get("limit").is_none() {
                    failures.push("history schema is missing raw paging fields".into());
                }
            }
            Some(_) => failures.push("history schema has the wrong required fields".into()),
            None => failures.push("history tool is missing".into()),
        }
        for prohibited in [
            "alinery_attach_session",
            "alinery_write_session",
            "alinery_resize_session",
            "alinery_detach_session",
            "alinery_kill_session",
            "alinery_resume_session",
        ] {
            if tools.iter().any(|tool| tool["name"] == prohibited) {
                failures.push(format!("prohibited interactive tool is exposed: {prohibited}"));
            }
        }

        assert!(failures.is_empty(), "{}", failures.join("; "));
    }

    // Derived from the live `tools/list` output, not a pinned count: every repo-scoped tool
    // must require `repo`, and `alinery_list_repos` must stay global (issue: MCP tools
    // silently ignored `repo` and always targeted one process-bound repo).
    #[test]
    fn every_repo_scoped_tool_requires_repo_except_list_repos() {
        let req = json!({"jsonrpc":"2.0","id":1,"method":"tools/list"});
        let resp = handle_request(&req, "/tmp/x", None).unwrap();
        let tools = resp["result"]["tools"].as_array().unwrap();
        assert!(tools.len() > 20, "sanity: tool list looks truncated ({} tools)", tools.len());
        for tool in tools {
            let name = tool["name"].as_str().unwrap();
            let required = tool["inputSchema"]["required"].as_array().cloned().unwrap_or_default();
            let requires_repo = required.iter().any(|v| v.as_str() == Some("repo"));
            if name == "alinery_list_repos" {
                assert!(!requires_repo, "{name} must stay global — it reports the known-repos list itself");
            } else {
                assert!(requires_repo, "{name} must require repo in its schema");
                let props = tool["inputSchema"]["properties"].as_object().expect("properties object");
                assert!(props.contains_key("repo"), "{name} must document a repo property");
            }
        }
    }

    #[test]
    fn alinery_send_review_handoff_rejects_traversal() {
        let repo = unique_repo("handoff-traversal");
        write_task(&repo, "review", "review", "/tmp/review");
        write_task(&repo, "target", "superdevelop", "/tmp/target");
        let result = handle_tool_call(
            json!({
                "name": "alinery_send_review_handoff",
                "arguments": {"source_slug":"review","source_artifact":"../03-review-findings.md","target_slug":"target"}
            }),
            repo.to_str().unwrap(),
            None,
        );
        assert!(text_content(&result).contains("invalid artifact filename"));
        assert!(!repo.join(".alinery/tasks/target/artifacts/review-handoff-001.md").exists());
        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn alinery_send_review_handoff_returns_json_result() {
        let repo = unique_repo("handoff-result");
        write_task(&repo, "review", "review", "/tmp/review");
        write_task(&repo, "target", "superdevelop", "/tmp/target");
        std::fs::write(repo.join(".alinery/tasks/review/artifacts/03-review-findings.md"), "finding").unwrap();
        let result = handle_tool_call(
            json!({
                "name": "alinery_send_review_handoff",
                "arguments": {
                    "source_slug":"review",
                    "source_session":"s1",
                    "source_artifact":"03-review-findings.md",
                    "target_slug":"target",
                    "target_phase":"implementation",

                    "model":"sonnet",
                    "prompt_extra":"extra"
                }
            }),
            repo.to_str().unwrap(),
            None,
        );
        let parsed: alinery_core::ReviewHandoffResult = serde_json::from_str(text_content(&result)).unwrap();
        assert_eq!(parsed.target_artifact, "review-handoff-001.md");
        assert_eq!(parsed.target_session.handoff_artifact, "review-handoff-001.md");
        assert_eq!(parsed.target_session.prompt_extra, "extra");
        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn alinery_send_review_handoff_is_local_only() {
        let repo = std::env::temp_dir().join("alinery-mcp-remote-missing");
        let _ = std::fs::remove_dir_all(&repo);
        let result = handle_tool_call(
            json!({
                "name": "alinery_send_review_handoff",
                "arguments": {"source_slug":"review","source_artifact":"03-review-findings.md","target_slug":"target"}
            }),
            repo.to_str().unwrap(),
            None,
        );
        assert_eq!(text_content(&result), REMOTE_MSG);
    }

    #[test]
    fn alinery_create_session_returns_session_meta_json() {
        let repo = unique_repo("create-session");
        let worktree = repo.join("worktree");
        std::fs::create_dir_all(&worktree).unwrap();
        write_task(&repo, "task", "superdevelop", worktree.to_str().unwrap());
        let result = handle_tool_call(
            json!({
                "name": "alinery_create_session",
                "arguments": {"task_slug":"task","phase":"research"}
            }),
            repo.to_str().unwrap(),
            None,
        );
        let parsed: alinery_core::SessionMeta = serde_json::from_str(text_content(&result)).unwrap();
        assert_eq!(parsed.phase, "research");
        assert_eq!(parsed.artifact, "02-investigate.md");
        assert!(repo.join(".alinery/tasks/task/sessions").join(format!("{}.meta.json", parsed.id)).exists());
        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn session_create_supports_selected_playbook_and_generic_namespace() {
        let repo = unique_repo("create-session-matrix");
        let worktree = repo.join("worktree");
        std::fs::create_dir_all(&worktree).unwrap();
        write_task(&repo, "task", "one-shot", worktree.to_str().unwrap());
        let socket = alinery_core::alineryd_socket_path(&repo, None);

        let selected = handle_tool_call_in(
            json!({
                "name": "alinery_create_session",
                "arguments": {
                    "repo": repo.to_str().unwrap(),
                    "task_slug": "task",
                    "playbook": "superdevelop",
                    "phase": "implementation",

                    "prompt_extra": "preserve task work"
                }
            }),
            Some(&repo),
            None,
            "dev",
        );
        let selected: alinery_core::SessionMeta = serde_json::from_str(text_content(&selected)).unwrap();
        assert_eq!(selected.playbook, "superdevelop");
        assert_eq!(selected.phase, "implementation");
        assert_eq!(selected.artifact, "06-build.md");
        assert_eq!(selected.prompt_extra, "preserve task work");
        assert_eq!(selected.daemon_namespace, "dev");
        assert!(!selected.generic);

        let generic = handle_tool_call(
            json!({
                "name": "alinery_create_session",
                "arguments": {"task_slug": "task", "generic": true}
            }),
            repo.to_str().unwrap(),
            None,
        );
        let generic: alinery_core::SessionMeta = serde_json::from_str(text_content(&generic)).unwrap();
        assert!(generic.generic);
        assert_eq!(generic.playbook, "one-shot");
        assert_eq!(generic.phase, "");
        assert_eq!(generic.artifact, "");
        assert_eq!(generic.harness, alinery_core::NO_HARNESS_KEY);
        assert_eq!(generic.prompt_extra, "");
        assert!(generic.started_at.is_none());

        let before = std::fs::read_dir(repo.join(".alinery/tasks/task/sessions")).unwrap().count();
        let invalid = handle_tool_call(
            json!({
                "name": "alinery_create_session",
                "arguments": {"task_slug": "task", "generic": true, "playbook": "superdevelop", "phase": "implementation"}
            }),
            repo.to_str().unwrap(),
            None,
        );
        assert!(text_content(&invalid).contains("generic") && text_content(&invalid).contains("playbook"));
        let replacement = handle_tool_call(
            json!({
                "name": "alinery_create_session",
                "arguments": {"task_slug": "task", "phase": "implementation", "prompt": "replace"}
            }),
            repo.to_str().unwrap(),
            None,
        );
        assert!(text_content(&replacement).contains("exact prompt replacement is not supported"));
        assert_eq!(std::fs::read_dir(repo.join(".alinery/tasks/task/sessions")).unwrap().count(), before);
        assert!(!socket.exists(), "create without start must not contact or launch alineryd");
        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn session_status_and_history_are_additive_bounded_passive_and_archived_safe() {
        let repo = unique_repo("session-observation");
        let worktree = repo.join("worktree");
        std::fs::create_dir_all(&worktree).unwrap();
        write_task(&repo, "task", "superdevelop", worktree.to_str().unwrap());
        let created = create_session_meta_with_app_config(
            None,
            &repo,
            alinery_core::CreateSessionInput {
                task_slug: "task".into(),
                generic: true,
                harness: alinery_core::NO_HARNESS_KEY.into(),
                ..Default::default()
            },
        )
        .unwrap();
        let meta_path = alinery_core::session_meta_path(&repo, "task", &created.id);
        let mut archived = created.clone();
        archived.archived = true;
        archived.started_at = Some(10);
        archived.ended_at = Some(20);
        archived.exit_code = Some(23);
        std::fs::write(&meta_path, serde_json::to_vec(&archived).unwrap()).unwrap();
        let history_path = repo.join(".alinery/tasks/task/sessions").join(format!("{}.scrollback", created.id));
        let raw_history = [0xff, b'a', b'b', b'c', b'\n'];
        std::fs::write(&history_path, raw_history).unwrap();
        let before_meta = std::fs::read(&meta_path).unwrap();
        let socket = alinery_core::alineryd_socket_path(&repo, None);

        let status = handle_tool_call(
            json!({"name": "alinery_session_status", "arguments": {"task_slug": "task", "session_id": created.id}}),
            repo.to_str().unwrap(),
            Some(&repo.join(".alinery/app.toml")),
        );
        let status: alinery_core::SessionStatusResult = serde_json::from_str(text_content(&status)).unwrap();
        assert_eq!(status.task_slug, "task");
        assert_eq!(status.session_id, created.id);
        assert_eq!(status.lifecycle, alinery_core::LifecycleState::Exited { code: 23 });
        assert!(status.state.is_none());
        assert!(status.session.archived);
        assert!(!socket.exists(), "status must not launch an absent daemon");

        let raw = handle_tool_call(
            json!({
                "name": "alinery_read_session_history",
                "arguments": {"task_slug": "task", "session_id": created.id, "offset": 1, "limit": 3}
            }),
            repo.to_str().unwrap(),
            None,
        );
        let raw: alinery_core::SessionHistoryResult = serde_json::from_str(text_content(&raw)).unwrap();
        assert_eq!(raw.mode, alinery_core::HistoryMode::Raw);
        assert_eq!(raw.data, b"abc");
        assert_eq!(raw.next_offset, Some(4));
        assert_eq!(raw.eof, Some(false));

        let screen = handle_tool_call(
            json!({
                "name": "alinery_read_session_history",
                "arguments": {"task_slug": "task", "session_id": created.id}
            }),
            repo.to_str().unwrap(),
            None,
        );
        let screen: alinery_core::SessionHistoryResult = serde_json::from_str(text_content(&screen)).unwrap();
        assert_eq!(screen.mode, alinery_core::HistoryMode::Screen);
        assert_eq!(screen.task_slug, "task");
        assert_eq!(screen.session_id, created.id);

        let unpaired = handle_tool_call(
            json!({
                "name": "alinery_read_session_history",
                "arguments": {"task_slug": "task", "session_id": created.id, "offset": 0}
            }),
            repo.to_str().unwrap(),
            None,
        );
        assert!(text_content(&unpaired).contains("offset and limit must be provided together"));
        let traversal = handle_tool_call(
            json!({
                "name": "alinery_read_session_history",
                "arguments": {"task_slug": "../task", "session_id": created.id}
            }),
            repo.to_str().unwrap(),
            None,
        );
        assert!(text_content(&traversal).contains("invalid task_slug"));
        assert_eq!(std::fs::read(&meta_path).unwrap(), before_meta);
        assert!(!socket.exists(), "history must not connect to or launch alineryd");
        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn standalone_start_rejects_local_ineligible_rows_before_daemon_launch() {
        let repo = unique_repo("start-ineligible");
        let worktree = repo.join("worktree");
        std::fs::create_dir_all(&worktree).unwrap();
        write_task(&repo, "task", "superdevelop", worktree.to_str().unwrap());
        let meta_path = alinery_core::session_meta_path(&repo, "task", "s1");
        let mut meta = alinery_core::SessionMeta {
            id: "s1".into(),
            worktree: worktree.display().to_string(),
            created: 1,
            playbook: "superdevelop".into(),
            phase: "research".into(),
            harness: "not-registered".into(),
            ..Default::default()
        };
        std::fs::write(&meta_path, serde_json::to_vec(&meta).unwrap()).unwrap();
        let app_config = repo.join(".alinery/app.toml");
        let socket = alinery_core::alineryd_socket_path(&repo, None);
        let call_start = || {
            handle_tool_call(
                json!({"name": "alinery_start_session", "arguments": {"task_slug": "task", "session_id": "s1"}}),
                repo.to_str().unwrap(),
                Some(&app_config),
            )
        };

        let unknown = call_start();
        assert!(text_content(&unknown).contains("unknown harness"), "{}", text_content(&unknown));
        assert!(!socket.exists());

        meta.harness = "claude".into();
        meta.archived = true;
        std::fs::write(&meta_path, serde_json::to_vec(&meta).unwrap()).unwrap();
        assert!(text_content(&call_start()).contains("session-archived"));
        meta.archived = false;
        std::fs::write(&meta_path, serde_json::to_vec(&meta).unwrap()).unwrap();
        let mut task = alinery_core::read_task(&repo, "task").unwrap();
        task.archived = true;
        alinery_core::write_task(&repo, &task).unwrap();
        assert!(text_content(&call_start()).contains("task-archived"));
        task.archived = false;
        task.has_worktree = false;
        alinery_core::write_task(&repo, &task).unwrap();
        assert!(text_content(&call_start()).contains("missing-worktree"));
        assert!(!socket.exists(), "local eligibility failures must not launch alineryd");

        let traversal = handle_tool_call(
            json!({"name": "alinery_start_session", "arguments": {"task_slug": "../task", "session_id": "s1"}}),
            repo.to_str().unwrap(),
            Some(&app_config),
        );
        assert!(text_content(&traversal).contains("invalid task_slug"));

        let remote = std::env::temp_dir().join(format!("alinery-mcp-remote-start-{}", now_nanos()));
        let remote_result = handle_tool_call(
            json!({"name": "alinery_start_session", "arguments": {"task_slug": "task", "session_id": "s1"}}),
            remote.to_str().unwrap(),
            Some(&app_config),
        );
        assert_eq!(text_content(&remote_result), REMOTE_MSG);
        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn alinery_list_playbooks_includes_bug_hunting_by_default() {
        let repo = unique_repo("list-playbooks-bug-hunting");
        let result = handle_tool_call(json!({"name": "alinery_list_playbooks", "arguments": {}}), repo.to_str().unwrap(), None);
        let list: serde_json::Value = serde_json::from_str(text_content(&result)).unwrap();
        let keys: Vec<&str> = list.as_array().unwrap().iter().map(|w| w["key"].as_str().unwrap()).collect();
        assert_eq!(keys, vec!["superdevelop", "one-shot", "free-form", "review", "bug-hunting"]);
        let bug_hunting = list.as_array().unwrap().iter().find(|w| w["key"] == "bug-hunting").unwrap();
        assert_eq!(bug_hunting["title"], "Bug Hunting");
        assert_eq!(bug_hunting["steps"], json!(["rca", "solutions", "design", "implementation", "pr"]));
        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn alinery_list_playbooks_appends_keys_missing_from_playbook_order() {
        let repo = unique_repo("list-playbooks-order-fallback");
        std::fs::create_dir_all(repo.join(".alinery")).unwrap();
        // Registry entries omitted from the display order still appear. No builtins are injected.
        std::fs::write(
            repo.join(".alinery/playbooks.toml"),
            r#"version = 1
default = "superdevelop"
playbook_order = ["superdevelop"]

[playbooks.superdevelop]
title = "SuperDevelop"

[playbooks.appended]
title = "Appended"
"#,
        )
        .unwrap();
        let result = handle_tool_call(json!({"name": "alinery_list_playbooks", "arguments": {}}), repo.to_str().unwrap(), None);
        let list: serde_json::Value = serde_json::from_str(text_content(&result)).unwrap();
        let keys: Vec<&str> = list.as_array().unwrap().iter().map(|w| w["key"].as_str().unwrap()).collect();
        assert_eq!(keys, vec!["superdevelop", "appended"]);
        let _ = std::fs::remove_dir_all(repo);
    }

    /// T0-3: alinery_create_task must write a full SessionMeta through create_session_meta
    /// (artifact allocation + resume token + lifecycle keys), not an 8-field hand-roll.
    #[test]
    fn alinery_create_task_writes_full_session_meta() {
        let repo = unique_repo("create-task-meta");
        // Real git repo so `git worktree add` inside create_task succeeds.
        let init = alinery_core::git_cmd(&repo).args(["init"]).output().expect("git init");
        assert!(init.status.success(), "git init: {:?}", init);
        let _ = alinery_core::git_cmd(&repo).args(["config", "user.email", "t@t"]).status();
        let _ = alinery_core::git_cmd(&repo).args(["config", "user.name", "t"]).status();
        std::fs::write(repo.join("README"), "x").unwrap();
        let add = alinery_core::git_cmd(&repo).args(["add", "README"]).status().expect("git add");
        assert!(add.success());
        let commit = alinery_core::git_cmd(&repo).args(["commit", "-m", "init", "--allow-empty"]).output().expect("git commit");
        // Prefer the README commit; empty commit is a fallback if add was enough.
        if !commit.status.success() {
            let empty = alinery_core::git_cmd(&repo)
                .args(["commit", "--allow-empty", "-m", "init"])
                .status()
                .expect("git empty commit");
            assert!(empty.success(), "git commit failed: {:?}", commit);
        }

        let name = format!("t0-3-meta-{}", now_nanos());
        let result = handle_tool_call(
            json!({
                "name": "alinery_create_task",
                "arguments": {"name": name, "description": "tdd"}
            }),
            repo.to_str().unwrap(),
            None,
        );
        let text = text_content(&result).to_string();
        assert!(text.starts_with("created task ") && text.contains(" and session "), "unexpected create_task reply: {text}");
        let session_id = text.rsplit(" and session ").next().unwrap_or("").trim().to_string();
        assert!(session_id.starts_with('s'), "session id missing from reply: {text}");
        let slug = text.trim_start_matches("created task ").split(" and session ").next().unwrap_or("").to_string();
        assert!(!slug.is_empty(), "slug missing from reply: {text}");

        let meta_path = repo.join(".alinery/tasks").join(&slug).join("sessions").join(format!("{session_id}.meta.json"));
        assert!(meta_path.exists(), "missing meta at {}", meta_path.display());
        let raw = std::fs::read_to_string(&meta_path).expect("read meta");
        let raw_val: Value = serde_json::from_str(&raw).expect("meta json");
        // Full SessionMeta serialization includes lifecycle + artifact keys.
        for key in [
            "artifact",
            "handoff_artifact",
            "prompt_extra",
            "started_at",
            "status_changed_at",
            "status_revision",
            "ended_at",
            "exit_code",
            "harness_resume_token",
            "resume_of",
            "daemon_namespace",
            "notification_read_at",
            "exit_notification_read_at",
        ] {
            assert!(raw_val.get(key).is_some(), "meta missing key {key}; raw={raw}");
        }

        let parsed: alinery_core::SessionMeta = serde_json::from_str(&raw).expect("SessionMeta");
        assert_eq!(parsed.id, session_id);
        assert_eq!(parsed.phase, "research-questions");
        assert_eq!(parsed.harness, "omp");
        assert!(!parsed.artifact.is_empty(), "create_session_meta must allocate an artifact; got empty");
        assert!(parsed.artifact.contains("clarify"), "artifact should be the Clarify slot, got {}", parsed.artifact);
        assert!(parsed.harness_resume_token.is_empty(), "product omp is manual, not launch-bind");
        assert!(parsed.started_at.is_none());
        assert!(parsed.ended_at.is_none());
        assert!(parsed.exit_code.is_none());

        let _ = alinery_core::git_cmd(&repo)
            .args(["worktree", "remove", "--force", repo.join(".alinery/worktrees").join(&slug).to_str().unwrap_or("")])
            .status();
        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn alinery_create_task_accepts_playbook_and_uses_its_first_step() {
        let repo = unique_repo("create-task-playbook");
        let init = alinery_core::git_cmd(&repo).args(["init"]).output().expect("git init");
        assert!(init.status.success(), "git init: {:?}", init);
        let _ = alinery_core::git_cmd(&repo).args(["config", "user.email", "t@t"]).status();
        let _ = alinery_core::git_cmd(&repo).args(["config", "user.name", "t"]).status();
        let commit = alinery_core::git_cmd(&repo).args(["commit", "--allow-empty", "-m", "init"]).output().expect("git commit");
        assert!(commit.status.success(), "git commit failed: {:?}", commit);

        let name = format!("t0-3-playbook-{}", now_nanos());
        let result = handle_tool_call(
            json!({
                "name": "alinery_create_task",
                "arguments": {"name": name, "playbook": "review"}
            }),
            repo.to_str().unwrap(),
            None,
        );
        let text = text_content(&result).to_string();
        assert!(text.starts_with("created task ") && text.contains(" and session "), "unexpected create_task reply: {text}");
        let session_id = text.rsplit(" and session ").next().unwrap_or("").trim().to_string();
        let slug = text.trim_start_matches("created task ").split(" and session ").next().unwrap_or("").to_string();

        let task_md = std::fs::read_to_string(repo.join(".alinery/tasks").join(&slug).join("task.md")).expect("read task.md");
        assert!(task_md.contains("review"), "task.md should record playbook=review; got {task_md}");

        let meta_path = repo.join(".alinery/tasks").join(&slug).join("sessions").join(format!("{session_id}.meta.json"));
        let raw = std::fs::read_to_string(&meta_path).expect("read meta");
        let parsed: alinery_core::SessionMeta = serde_json::from_str(&raw).expect("SessionMeta");
        assert_eq!(parsed.phase, "review-context", "first session should start on review's first step");

        let _ = alinery_core::git_cmd(&repo)
            .args(["worktree", "remove", "--force", repo.join(".alinery/worktrees").join(&slug).to_str().unwrap_or("")])
            .status();
        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn alinery_create_task_rejects_unknown_playbook() {
        let repo = unique_repo("create-task-bad-playbook");
        let init = alinery_core::git_cmd(&repo).args(["init"]).output().expect("git init");
        assert!(init.status.success(), "git init: {:?}", init);
        let result = handle_tool_call(
            json!({
                "name": "alinery_create_task",
                "arguments": {"name": "bogus-playbook-task", "playbook": "not-a-real-playbook"}
            }),
            repo.to_str().unwrap(),
            None,
        );
        let text = text_content(&result).to_string();
        assert!(text.contains("unknown playbook"), "expected unknown playbook error, got: {text}");
        // No task should have been created (no worktree left behind, no dirs written).
        assert!(alinery_core::list_tasks_for_repo(&repo).is_empty());
        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn list_repos_omits_app_level_secrets() {
        let path = std::env::temp_dir().join(format!("alinery-mcp-app-{}.toml", now_nanos()));
        std::fs::write(
            &path,
            r#"
active_repo = "/tmp/repo-a"
known_repos = ["/tmp/repo-a", "/tmp/repo-b"]

[global.linear]
api_key = "linear-secret"

[global.github]
token = "github-secret"

[[global.harnesses.harness]]
key = "secret-harness"
name = "Secret Harness"
binary = "/usr/local/bin/secret"
args = ["--token", "harness-secret"]
"#,
        )
        .unwrap();

        let req = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "alinery_list_repos", "arguments": {}}
        });
        let resp = handle_request(&req, "/tmp/current-repo", Some(&path)).unwrap();
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        let repos: alinery_core::AppConfig = serde_json::from_str(text).unwrap();

        assert_eq!(repos.active_repo, "/tmp/repo-a");
        assert_eq!(repos.known_repos, vec!["/tmp/repo-a", "/tmp/repo-b"]);
        assert!(!text.contains("linear-secret"));
        assert!(!text.contains("github-secret"));
        assert!(!text.contains("harness-secret"));
        assert!(!text.contains("api_key"));
        assert!(!text.contains("token"));
        assert!(!text.contains("global"));

        let _ = std::fs::remove_file(path);
    }

    // ---- issue: repo becomes a required per-call tool argument ----

    #[test]
    fn tool_call_rejects_missing_repo() {
        let req = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"alinery_list_tasks","arguments":{}}});
        let resp = handle_request_in(&req, None, None, "").unwrap();
        assert_eq!(text_content(&resp["result"]), "error: repo is required");
    }

    #[test]
    fn tool_call_rejects_repo_not_known_or_process() {
        let process_repo = unique_repo("process-repo");
        let other_repo = unique_repo("other-repo");
        let resp = handle_tool_call_in(
            json!({"name": "alinery_list_tasks", "arguments": {"repo": other_repo.to_str().unwrap()}}),
            Some(&process_repo),
            None,
            "",
        );
        assert!(text_content(&resp).contains("not in the known repository set"), "{}", text_content(&resp));
        let _ = std::fs::remove_dir_all(process_repo);
        let _ = std::fs::remove_dir_all(other_repo);
    }

    // The ticket's own reproduction, machine-checked: a process launched against one repo
    // must reach the repo *named in the call* — never silently fall back to its own.
    #[test]
    fn tool_call_dispatch_targets_arguments_repo_not_process_repo() {
        let process_repo = unique_repo("process-only");
        let target_repo = unique_repo("target-only");
        write_task(&target_repo, "repro-check", "superdevelop", "");
        let app_config = std::env::temp_dir().join(format!("alinery-mcp-app-targets-{}.toml", now_nanos()));
        std::fs::write(
            &app_config,
            format!("active_repo = \"{}\"\nknown_repos = [\"{}\"]\n", target_repo.display(), target_repo.display()),
        )
        .unwrap();

        let targeted = handle_tool_call_in(
            json!({"name": "alinery_list_tasks", "arguments": {"repo": target_repo.to_str().unwrap()}}),
            Some(&process_repo),
            Some(&app_config),
            "",
        );
        let targeted_tasks: Vec<String> = serde_json::from_str(text_content(&targeted)).unwrap_or_else(|_| panic!("expected a task list, got {}", text_content(&targeted)));
        assert_eq!(targeted_tasks, vec!["repro-check".to_string()], "must list the named target repo's tasks");

        let from_process = handle_tool_call_in(
            json!({"name": "alinery_list_tasks", "arguments": {"repo": process_repo.to_str().unwrap()}}),
            Some(&process_repo),
            Some(&app_config),
            "",
        );
        let process_tasks: Vec<String> = serde_json::from_str(text_content(&from_process)).unwrap_or_else(|_| panic!("expected a task list, got {}", text_content(&from_process)));
        assert!(process_tasks.is_empty(), "process repo must never see the target repo's tasks");

        let _ = std::fs::remove_dir_all(process_repo);
        let _ = std::fs::remove_dir_all(target_repo);
        let _ = std::fs::remove_file(app_config);
    }

    // Regression: `alinery_list_repos` advertises `active_repo` as a valid per-call target
    // even when a hand-edited/partially migrated `app.toml` never pushed it into
    // `known_repos` (the app crate's `sanitize_app_config` normally keeps them in sync).
    #[test]
    fn tool_call_accepts_active_repo_not_in_known_repos() {
        let repo = unique_repo("active-only");
        let app_config = std::env::temp_dir().join(format!("alinery-mcp-app-active-only-{}.toml", now_nanos()));
        std::fs::write(&app_config, format!("active_repo = \"{}\"\nknown_repos = []\n", repo.display())).unwrap();

        let resp = handle_tool_call_in(
            json!({"name": "alinery_list_tasks", "arguments": {"repo": repo.to_str().unwrap()}}),
            None,
            Some(&app_config),
            "",
        );
        let tasks: Vec<String> = serde_json::from_str(text_content(&resp)).unwrap_or_else(|_| panic!("expected a task list, got {}", text_content(&resp)));
        assert!(tasks.is_empty());

        let _ = std::fs::remove_dir_all(repo);
        let _ = std::fs::remove_file(app_config);
    }

    // Regression for the "unreachable remote allow-list" defect: a repo that is registered
    // (known_repos) but not locally cloned can never satisfy `git rev-parse --show-toplevel`,
    // so per-call resolution must classify it as a known remote entry BEFORE attempting Git
    // canonicalization — otherwise every remote discovery call fails at resolution before the
    // remote allow-list ever runs.
    #[test]
    fn known_remote_entry_reaches_discovery_but_not_mutation() {
        let remote = std::env::temp_dir().join(format!("alinery-mcp-known-remote-{}", now_nanos()));
        let _ = std::fs::remove_dir_all(&remote); // deliberately never created: "known but not cloned"
        let app_config = std::env::temp_dir().join(format!("alinery-mcp-app-remote-{}.toml", now_nanos()));
        std::fs::write(&app_config, format!("active_repo = \"{}\"\nknown_repos = [\"{}\"]\n", remote.display(), remote.display())).unwrap();

        let list = handle_tool_call_in(
            json!({"name": "alinery_list_tasks", "arguments": {"repo": remote.to_str().unwrap()}}),
            None,
            Some(&app_config),
            "",
        );
        let tasks: Vec<String> = serde_json::from_str(text_content(&list)).unwrap_or_else(|_| panic!("expected a task list, got {}", text_content(&list)));
        assert!(tasks.is_empty());

        let archive = handle_tool_call_in(
            json!({"name": "alinery_archive_task", "arguments": {"repo": remote.to_str().unwrap(), "slug": "x"}}),
            None,
            Some(&app_config),
            "",
        );
        assert_eq!(text_content(&archive), REMOTE_MSG);

        let _ = std::fs::remove_file(app_config);
    }

    // L3: a trailing-slash spelling of a `known_repos` entry must still match — the
    // pre-classify string comparison is not Git validation, so it has to normalize itself.
    #[test]
    fn known_remote_entry_with_trailing_slash_still_matches_known_repos() {
        let remote = std::env::temp_dir().join(format!("alinery-mcp-known-remote-slash-{}", now_nanos()));
        let _ = std::fs::remove_dir_all(&remote);
        let app_config = std::env::temp_dir().join(format!("alinery-mcp-app-remote-slash-{}.toml", now_nanos()));
        std::fs::write(&app_config, format!("active_repo = \"{}\"\nknown_repos = [\"{}\"]\n", remote.display(), remote.display())).unwrap();

        let list = handle_tool_call_in(
            json!({"name": "alinery_list_tasks", "arguments": {"repo": format!("{}/", remote.display())}}),
            None,
            Some(&app_config),
            "",
        );
        let tasks: Vec<String> = serde_json::from_str(text_content(&list)).unwrap_or_else(|_| panic!("expected a task list, got {}", text_content(&list)));
        assert!(tasks.is_empty());

        let _ = std::fs::remove_file(app_config);
    }

    // L3: a registered entry whose path *exists* but was never `git init`'d is not
    // plausibly remote/ssh — it must not get the ssh-flavored `REMOTE_MSG`.
    #[test]
    fn known_registered_entry_without_git_checkout_gets_non_ssh_message() {
        let entry = std::env::temp_dir().join(format!("alinery-mcp-known-no-git-{}", now_nanos()));
        let _ = std::fs::remove_dir_all(&entry);
        std::fs::create_dir_all(&entry).unwrap();
        let app_config = std::env::temp_dir().join(format!("alinery-mcp-app-no-git-{}.toml", now_nanos()));
        std::fs::write(&app_config, format!("active_repo = \"{}\"\nknown_repos = [\"{}\"]\n", entry.display(), entry.display())).unwrap();

        let list = handle_tool_call_in(
            json!({"name": "alinery_list_tasks", "arguments": {"repo": entry.to_str().unwrap()}}),
            None,
            Some(&app_config),
            "",
        );
        let tasks: Vec<String> = serde_json::from_str(text_content(&list)).unwrap_or_else(|_| panic!("expected a task list, got {}", text_content(&list)));
        assert!(tasks.is_empty());

        let archive = handle_tool_call_in(
            json!({"name": "alinery_archive_task", "arguments": {"repo": entry.to_str().unwrap(), "slug": "x"}}),
            None,
            Some(&app_config),
            "",
        );
        let msg = text_content(&archive);
        assert_ne!(msg, REMOTE_MSG, "an existing non-git registered folder must not get the ssh-flavored message");
        assert!(!msg.to_lowercase().contains("ssh"), "{msg}");

        let _ = std::fs::remove_dir_all(&entry);
        let _ = std::fs::remove_file(app_config);
    }

    // ---- issue #91: storage size + purge over MCP ----

    fn write_archived_task(repo: &std::path::Path, slug: &str) {
        write_task(repo, slug, "superdevelop", "");
        let mut t = alinery_core::read_task(repo, slug).unwrap();
        t.archived = true;
        alinery_core::write_task(repo, &t).unwrap();
    }

    /// `^\d+\.\d{2} MB$` without pulling in a regex dependency.
    fn is_two_decimal_mb(s: &str) -> bool {
        let Some(num) = s.strip_suffix(" MB") else {
            return false;
        };
        match num.split_once('.') {
            Some((whole, frac)) => !whole.is_empty() && whole.bytes().all(|b| b.is_ascii_digit()) && frac.len() == 2 && frac.bytes().all(|b| b.is_ascii_digit()),
            None => false,
        }
    }

    #[test]
    fn storage_tools_are_listed() {
        let req = json!({"jsonrpc":"2.0","id":1,"method":"tools/list"});
        let resp = handle_request(&req, "/tmp/x", None).unwrap();
        let tools = resp["result"]["tools"].as_array().unwrap();
        assert!(tools.iter().any(|t| t["name"] == "alinery_storage_info"));
        assert!(tools.iter().any(|t| t["name"] == "alinery_delete_archived_storage"));
    }

    #[test]
    fn alinery_storage_info_returns_counts_and_mb() {
        let repo = unique_repo("storage-info");
        write_archived_task(&repo, "gone");
        write_task(&repo, "kept", "superdevelop", "");

        let result = handle_tool_call(json!({"name": "alinery_storage_info", "arguments": {}}), repo.to_str().unwrap(), None);
        let parsed: Value = serde_json::from_str(text_content(&result)).unwrap();

        assert_eq!(parsed["archived_task_count"], 1);
        for key in ["archived_mb", "active_mb", "total_mb"] {
            let v = parsed[key].as_str().unwrap_or("");
            assert!(is_two_decimal_mb(v), "{key} = {v:?}");
        }
        assert!(parsed["active_bytes"].as_u64().unwrap() > 0);

        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn alinery_delete_archived_storage_removes_archived_task() {
        let repo = unique_repo("storage-purge");
        write_archived_task(&repo, "gone");
        write_task(&repo, "kept", "superdevelop", "");

        let result = handle_tool_call(json!({"name": "alinery_delete_archived_storage", "arguments": {}}), repo.to_str().unwrap(), None);
        let parsed: alinery_core::PurgeArchivedResult = serde_json::from_str(text_content(&result)).unwrap();

        assert_eq!(parsed.deleted_tasks, 1);
        assert!(parsed.errors.is_empty(), "{:?}", parsed.errors);
        assert!(!repo.join(".alinery/tasks/gone").exists());
        assert!(repo.join(".alinery/tasks/kept/task.md").exists());

        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn alinery_delete_archived_storage_reports_lock_contention() {
        use std::net::TcpListener;
        use std::time::Duration;

        let repo = unique_repo("storage-purge-contention");
        write_archived_task(&repo, "gone");
        let task_path = repo.join(".alinery/tasks/gone/task.md");
        let task_bytes = std::fs::read(&task_path).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let app_config = std::env::temp_dir().join(format!("alinery-mcp-app-purge-{}.toml", now_nanos()));
        std::fs::write(
            &app_config,
            format!("[global.telemetry]\nenabled = true\nprompted = true\ninstall_id = \"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\"\nendpoint = \"{endpoint}\"\n"),
        )
        .unwrap();

        alinery_core::with_task_mutation_lock(&repo, "test hold", || {
            let result = handle_tool_call(
                json!({"name": "alinery_delete_archived_storage", "arguments": {}}),
                repo.to_str().unwrap(),
                Some(&app_config),
            );
            assert_eq!(text_content(&result), "error: task mutation busy during purge archived storage");
            Ok(())
        })
        .unwrap();

        assert_eq!(std::fs::read(&task_path).unwrap(), task_bytes);
        std::thread::sleep(Duration::from_millis(100));
        let error = listener.accept().unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock, "rejected purge emitted telemetry");
        let _ = std::fs::remove_dir_all(repo);
        let _ = std::fs::remove_file(app_config);
    }

    #[test]
    fn alinery_delete_archived_storage_is_local_only() {
        let repo = std::env::temp_dir().join("alinery-mcp-remote-missing-storage");
        let _ = std::fs::remove_dir_all(&repo);
        let result = handle_tool_call(json!({"name": "alinery_delete_archived_storage", "arguments": {}}), repo.to_str().unwrap(), None);
        assert_eq!(text_content(&result), REMOTE_MSG);
    }

    // ---- Backup (issue #79, Phase 6) ----------------------------------------
    // MCP gets create only. An agent must never be able to wipe a repo, and archiving
    // must never depend on backup state.

    // 6.1 — the tool is discoverable with an object schema and requires `repo`, like every
    // other repo-scoped tool (`every_repo_scoped_tool_requires_repo_except_list_repos` above
    // enforces this generically; this test pins the specific tool by name too).
    #[test]
    fn alinery_backup_now_is_listed() {
        let req = json!({"jsonrpc":"2.0","id":1,"method":"tools/list"});
        let resp = handle_request(&req, "/tmp/x", None).unwrap();
        let tools = resp["result"]["tools"].as_array().unwrap();
        let tool = tools.iter().find(|tool| tool["name"] == "alinery_backup_now").expect("alinery_backup_now must be listed");
        assert_eq!(tool["inputSchema"]["type"], "object");
        let required = tool["inputSchema"]["required"].as_array().cloned().unwrap_or_default();
        assert!(required.iter().any(|r| r == "repo"), "alinery_backup_now must require repo: {:?}", tool["inputSchema"]);
    }

    // 6.2 — restore is deliberately out of scope for MCP: it stops the daemon and clears
    // alinery data, which is not a decision an agent gets to make unattended.
    #[test]
    fn no_restore_tool_is_exposed() {
        let req = json!({"jsonrpc":"2.0","id":1,"method":"tools/list"});
        let resp = handle_request(&req, "/tmp/x", None).unwrap();
        for tool in resp["result"]["tools"].as_array().unwrap() {
            let name = tool["name"].as_str().unwrap_or("");
            assert!(!name.contains("restore"), "restore tool exposed: {name}");
        }
    }

    // 6.3 — unconfigured is the default state; it must read as a plain error, not a panic.
    #[test]
    fn alinery_backup_now_errors_cleanly_when_unconfigured() {
        let repo = unique_repo("backup-unconfigured");
        let req = json!({
            "jsonrpc":"2.0","id":1,"method":"tools/call",
            "params":{"name":"alinery_backup_now","arguments":{}}
        });
        let resp = handle_request(&req, repo.to_str().unwrap(), None).unwrap();
        let text = text_content(&resp["result"]);
        assert!(text.starts_with("error:"), "unexpected result: {text}");
        assert!(text.contains("disabled") || text.contains("destination"), "error must name the reason: {text}");
        let zips = std::fs::read_dir(&repo)
            .unwrap()
            .flatten()
            .filter(|e| e.path().extension().map(|x| x == "zip").unwrap_or(false))
            .count();
        assert_eq!(zips, 0);
        let _ = std::fs::remove_dir_all(repo);
    }

    // 6.4 — archive must never be blocked by backup state.
    #[test]
    fn archive_task_succeeds_when_backup_unconfigured() {
        let repo = unique_repo("archive-backup-off");
        write_task(&repo, "alpha", "superdevelop", "");
        let req = json!({
            "jsonrpc":"2.0","id":1,"method":"tools/call",
            "params":{"name":"alinery_archive_task","arguments":{"slug":"alpha"}}
        });
        let resp = handle_request(&req, repo.to_str().unwrap(), None).unwrap();
        assert_eq!(text_content(&resp["result"]), "archived");
        assert!(alinery_core::read_task(&repo, "alpha").unwrap().archived);
        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn archive_task_cannot_bypass_active_subtask_lifecycle() {
        let repo = unique_repo("archive-subtask-guard");
        write_task(&repo, "parent", "superdevelop", "");
        write_task(&repo, "child", "superdevelop", "");
        let mut parent = alinery_core::read_task(&repo, "parent").unwrap();
        let mut child = alinery_core::read_task(&repo, "child").unwrap();
        parent.active_subtask = "child".into();
        child.parent_task = "parent".into();
        alinery_core::write_task(&repo, &parent).unwrap();
        alinery_core::write_task(&repo, &child).unwrap();

        for slug in ["parent", "child"] {
            let result = handle_tool_call(json!({"name":"alinery_archive_task","arguments":{"slug":slug}}), repo.to_str().unwrap(), None);
            assert!(text_content(&result).contains("error:"), "{slug} should be refused");
            assert!(!alinery_core::read_task(&repo, slug).unwrap().archived);
        }
        let _ = std::fs::remove_dir_all(repo);
    }

    // 6.5 — a configured-but-broken destination is a soft failure: archive still wins.
    #[test]
    fn archive_task_succeeds_when_backup_fails() {
        let repo = unique_repo("archive-backup-broken");
        write_task(&repo, "alpha", "superdevelop", "");
        std::fs::write(
            repo.join(".alinery/config.toml"),
            format!(
                "[backup]\nenabled = true\ntrigger_pre_archive = true\ndestination = \"{}\"\n",
                repo.join("no-such-folder").display()
            ),
        )
        .unwrap();
        let req = json!({
            "jsonrpc":"2.0","id":1,"method":"tools/call",
            "params":{"name":"alinery_archive_task","arguments":{"slug":"alpha"}}
        });
        let resp = handle_request(&req, repo.to_str().unwrap(), None).unwrap();
        assert_eq!(text_content(&resp["result"]), "archived");
        assert!(alinery_core::read_task(&repo, "alpha").unwrap().archived);
        let _ = std::fs::remove_dir_all(repo);
    }

    // The configured happy path: a valid destination yields a real archive whose meta says
    // the request came from MCP.
    #[test]
    fn alinery_backup_now_creates_archive_when_configured() {
        let repo = unique_repo("backup-configured");
        write_task(&repo, "alpha", "superdevelop", "");
        let dest = repo.parent().unwrap().join(format!("{}-dest", repo.file_name().unwrap().to_string_lossy()));
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::write(
            repo.join(".alinery/config.toml"),
            format!("[backup]\nenabled = true\ndestination = \"{}\"\n", dest.display()),
        )
        .unwrap();
        let req = json!({
            "jsonrpc":"2.0","id":1,"method":"tools/call",
            "params":{"name":"alinery_backup_now","arguments":{}}
        });
        let resp = handle_request(&req, repo.to_str().unwrap(), None).unwrap();
        let text = text_content(&resp["result"]);
        let meta: alinery_core::BackupMeta = serde_json::from_str(text).expect(text);
        assert_eq!(meta.trigger, alinery_core::BackupTrigger::Mcp);
        assert_eq!(meta.alinery_version, env!("CARGO_PKG_VERSION"));
        let zips: Vec<_> = std::fs::read_dir(&dest)
            .unwrap()
            .flatten()
            .filter(|e| e.path().extension().map(|x| x == "zip").unwrap_or(false))
            .collect();
        assert_eq!(zips.len(), 1);
        let _ = std::fs::remove_dir_all(&dest);
        let _ = std::fs::remove_dir_all(repo);
    }

    fn unique_app_config(name: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("alinery-mcp-app-{name}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        let app = dir.join("app.toml");
        (dir, app)
    }

    fn log_text(app_config: &Path) -> String {
        std::fs::read_to_string(alinery_core::log_path(app_config)).unwrap_or_default()
    }

    #[test]
    fn write_config_preserves_comments_and_unknown_table_and_logs_diff() {
        let repo = unique_repo("write-config-log");
        std::fs::create_dir_all(repo.join(".alinery")).unwrap();
        let path = repo.join(".alinery/config.toml");
        std::fs::write(&path, "# keep me\n[backup]\nenabled = false\n\n[not_a_real_table]\nx = 1\n").unwrap();
        let (app_dir, app_config) = unique_app_config("write-config-log");
        let content = "# keep me\n[backup]\nenabled = true\n\n[not_a_real_table]\nx = 1\n";
        let resp = write_toml_file(
            path.clone(),
            &json!({"content": content}),
            Some(&app_config),
            &repo,
            alinery_core::SettingsChangeScope::Repo,
        );
        assert!(text_content(&resp).starts_with("wrote "), "{resp}");
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(on_disk.contains("# keep me"), "{on_disk}");
        assert!(on_disk.contains("[not_a_real_table]"), "{on_disk}");
        let text = log_text(&app_config);
        assert!(text.contains("backup.enabled=true"), "{text}");
        let _ = std::fs::remove_dir_all(app_dir);
        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn write_config_unparseable_overlay_still_writes() {
        let repo = unique_repo("write-config-shape");
        std::fs::create_dir_all(repo.join(".alinery")).unwrap();
        let path = repo.join(".alinery/config.toml");
        let (app_dir, app_config) = unique_app_config("write-config-shape");
        let content = "github = \"sk-overlay-secret\"\n";
        let resp = write_toml_file(
            path.clone(),
            &json!({"content": content}),
            Some(&app_config),
            &repo,
            alinery_core::SettingsChangeScope::Repo,
        );
        assert!(text_content(&resp).starts_with("wrote "), "{resp}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), content);
        let text = log_text(&app_config);
        assert!(text.contains("unparseable-overlay"), "{text}");
        assert!(text.contains("reason=parse"), "{text}");
        assert!(!text.contains("sk-overlay-secret"), "{text}");
        assert!(!text.contains("invalid type"), "{text}");
        let _ = std::fs::remove_dir_all(app_dir);
        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn write_config_does_not_log_harness_overlay() {
        let repo = unique_repo("write-config-nolog");
        std::fs::create_dir_all(repo.join(".alinery")).unwrap();
        let path = repo.join(".alinery/config.toml");
        let (app_dir, app_config) = unique_app_config("write-config-nolog");
        let resp = write_toml_file(
            path.clone(),
            &json!({"content": "[backup]\nenabled = true\n"}),
            Some(&app_config),
            &repo,
            alinery_core::SettingsChangeScope::Repo,
        );
        assert!(text_content(&resp).starts_with("wrote "), "{resp}");
        assert!(!log_text(&app_config).contains("harnesses.toml"));
        let _ = std::fs::remove_dir_all(app_dir);
        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn write_config_without_app_config_is_silent() {
        let repo = unique_repo("write-config-none");
        std::fs::create_dir_all(repo.join(".alinery")).unwrap();
        let path = repo.join(".alinery/config.toml");
        let content = "[backup]\nenabled = true\n";
        let resp = write_toml_file(path.clone(), &json!({"content": content}), None, &repo, alinery_core::SettingsChangeScope::Repo);
        assert!(text_content(&resp).starts_with("wrote "), "{resp}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), content);
        let _ = std::fs::remove_dir_all(repo);
    }
}
