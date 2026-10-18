//! Slim playbook helper. It does not bind the UI socket, does not acquire repo
//! ownership, does not boot-sweep, and does not launch a harness.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use super::{accept_phase_completion, execution_config_identity, now_secs, refuse_harness_launch, set_pi_session_opener, start_auto_advance_reconciler, Registry};
use alinery_core::{playbook_socket_path, CompletionOutcome, LaunchFields, PlaybookState, SessionState};

pub fn run() {
    refuse_harness_launch();
    set_pi_session_opener(open_on_pi_daemon);
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|arg| arg == "--protocol-version") {
        println!("{}", alinery_core::PROTOCOL_VERSION);
        std::process::exit(0);
    }
    let mut repo: Option<PathBuf> = None;
    let mut app_config: Option<PathBuf> = None;
    let mut namespace = String::new();
    let mut i = 1usize;
    while i < args.len() {
        match args[i].as_str() {
            "--repo" if i + 1 < args.len() => {
                repo = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--app-config" if i + 1 < args.len() => {
                app_config = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--socket-namespace" if i + 1 < args.len() => {
                namespace = args[i + 1].clone();
                i += 2;
            }
            "--build-id" if i + 1 < args.len() => i += 2,
            _ => i += 1,
        }
    }
    let Some(repo) = repo else {
        eprintln!("alinery-playbook: missing --repo");
        std::process::exit(2);
    };
    let app_config = app_config.unwrap_or_else(|| repo.join(".alinery").join("app.toml"));
    let _ = super::EXECUTION_CONFIG_IDENTITY.set(alinery_core::app_config_identity(&app_config));
    let socket = playbook_socket_path(&repo, (!namespace.is_empty()).then_some(namespace.as_str()));
    if let Some(parent) = socket.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::remove_file(&socket);
    let listener = match UnixListener::bind(&socket) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("alinery-playbook: bind {}: {error}", socket.display());
            std::process::exit(1);
        }
    };
    let reg: Registry = Arc::new(Mutex::new(std::collections::HashMap::new()));
    let host = Arc::new(None);
    start_auto_advance_reconciler(repo.clone(), reg.clone(), namespace.clone(), app_config.clone(), host.clone());
    let nonces = Arc::new(Mutex::new(load_nonces(&repo)));
    for stream in listener.incoming().flatten() {
        let repo = repo.clone();
        let app_config = app_config.clone();
        let namespace = namespace.clone();
        let reg = reg.clone();
        let host = host.clone();
        let nonces = nonces.clone();
        let socket = socket.clone();
        std::thread::spawn(move || {
            if !serve(&repo, &app_config, &namespace, &reg, &host, &nonces, stream, &socket) {
                let _ = std::fs::remove_file(&socket);
                std::process::exit(0);
            }
        });
    }
}

fn open_on_pi_daemon(repo: &Path, lane: &str, launch: &LaunchFields) -> Result<(), String> {
    let socket = alinery_core::alineryd_socket_path(repo, (!lane.is_empty()).then_some(lane));
    let token = std::env::var("ALINERY_PI_LAUNCH_TOKEN").unwrap_or_default();
    let request = json!({
        "op": "pi_open",
        "token": token,
        "id": launch.id,
        "task_slug": launch.task_slug,
        "model": launch.model,
    });
    let mut last = "pi daemon did not accept the session".to_string();
    for _ in 0..40 {
        match UnixStream::connect(&socket) {
            Ok(mut stream) => {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
                writeln!(stream, "{request}").map_err(|error| error.to_string())?;
                stream.flush().map_err(|error| error.to_string())?;
                let mut line = String::new();
                BufReader::new(stream).read_line(&mut line).map_err(|error| error.to_string())?;
                let value: Value = serde_json::from_str(line.trim()).map_err(|error| error.to_string())?;
                if value.get("ok").and_then(Value::as_bool) == Some(true) {
                    return Ok(());
                }
                last = value.get("error").and_then(Value::as_str).unwrap_or("pi open failed").to_string();
                return Err(last);
            }
            Err(error) => last = error.to_string(),
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(last)
}

fn nonce_path(repo: &Path) -> PathBuf {
    repo.join(".alinery").join("phase-nonces.json")
}

fn load_nonces(repo: &Path) -> BTreeMap<String, Value> {
    std::fs::read_to_string(nonce_path(repo))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_nonces(repo: &Path, nonces: &BTreeMap<String, Value>) {
    if let Ok(text) = serde_json::to_string(nonces) {
        let _ = std::fs::write(nonce_path(repo), text);
    }
}

fn serve(
    repo: &Path,
    app_config: &Path,
    lane: &str,
    reg: &Registry,
    host: &super::ProtectedHost,
    nonces: &Mutex<BTreeMap<String, Value>>,
    stream: UnixStream,
    socket: &Path,
) -> bool {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let mut reader = BufReader::new(stream.try_clone().unwrap_or(stream));
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return true;
    }
    let header: Value = match serde_json::from_str(line.trim()) {
        Ok(value) => value,
        Err(_) => {
            let _ = writeln!(reader.get_mut(), "{}", json!({"error":"invalid-json"}));
            return true;
        }
    };
    let op = header.get("op").and_then(Value::as_str).unwrap_or("");
    if header.get("body_bytes").is_some() {
        let bytes = header.get("body_bytes").and_then(Value::as_u64).unwrap_or(0) as usize;
        let mut body = vec![0; bytes];
        if reader.read_exact(&mut body).is_err() {
            let _ = writeln!(reader.get_mut(), "{}", json!({"error":"short-body"}));
            return true;
        }
        if op != "create_task" {
            let _ = writeln!(reader.get_mut(), "{}", json!({"error":"unexpected-body"}));
            return true;
        }
        let request = match serde_json::from_slice::<alinery_core::task_creation::CreateTaskRequest>(&body) {
            Ok(request) => request,
            Err(error) => {
                let _ = writeln!(reader.get_mut(), "{}", json!({"error": error.to_string()}));
                return true;
            }
        };
        let reply = super::execution::create_task(repo, reg, lane, app_config, host, request);
        write_result(reader.get_mut(), reply.map(|value| serde_json::to_value(value).unwrap_or(json!({"error":"encode"}))));
        return true;
    }
    match op {
        "stop" => {
            let _ = writeln!(reader.get_mut(), "{}", json!({"ok":true}));
            let _ = std::fs::remove_file(socket);
            return false;
        }
        "health" => {
            let _ = writeln!(reader.get_mut(), "{}", json!({"ok":true}));
        }
        "playbook_axis" => {
            let _ = writeln!(reader.get_mut(), "{}", playbook_axis(repo, lane));
        }
        "phase_request" => {
            let _ = writeln!(reader.get_mut(), "{}", phase_request(repo, reg, nonces, &header));
        }
        "grant_execution_completion" | "allow_execution_completion" => {
            let reply = grant(repo, lane, &header);
            let _ = writeln!(reader.get_mut(), "{reply}");
        }
        "get_task_execution" => {
            let slug = header.pointer("/request/task_slug").and_then(Value::as_str).unwrap_or("");
            write_result(
                reader.get_mut(),
                super::execution::query(repo, slug, lane).map(|value| serde_json::to_value(value).unwrap_or(json!({"error":"encode"}))),
            );
        }
        "create_execution_session" => match serde_json::from_value(header.get("request").cloned().unwrap_or(Value::Null)) {
            Ok(request) => write_result(
                reader.get_mut(),
                super::execution::create_session(repo, reg, lane, app_config, host, request).map(|value| serde_json::to_value(value).unwrap_or(json!({"error":"encode"}))),
            ),
            Err(error) => write_result(reader.get_mut(), Err(error.to_string())),
        },
        "start_session" => match serde_json::from_value(header.get("request").cloned().unwrap_or(Value::Null)) {
            Ok(request) => write_result(
                reader.get_mut(),
                super::execution::start(repo, reg, lane, app_config, host, request).map(|value| serde_json::to_value(value).unwrap_or(json!({"error":"encode"}))),
            ),
            Err(error) => write_result(reader.get_mut(), Err(error.to_string())),
        },
        "create_subtask" => {
            let parsed = serde_json::from_value::<alinery_core::CreateSubtaskInput>(header.get("request").cloned().unwrap_or(Value::Null));
            let reply = (|| {
                let input = parsed.map_err(|error| error.to_string())?;
                super::execution::product(repo, app_config)?;
                let start = input.start;
                let mut result = alinery_core::create_subtask(repo, lane, execution_config_identity(), input)?;
                super::execution::initialize_created_task(repo, reg, lane, app_config, host, start, &mut result.provisioning)?;
                serde_json::to_value(result).map_err(|error| error.to_string())
            })();
            write_result(reader.get_mut(), reply);
        }
        _ => {
            let _ = writeln!(reader.get_mut(), "{}", json!({"error":"unknown-op"}));
        }
    }
    true
}

fn write_result(stream: &mut UnixStream, result: Result<Value, impl std::fmt::Display>) {
    let value = match result {
        Ok(value) => value,
        Err(error) => json!({"error": error.to_string()}),
    };
    let _ = writeln!(stream, "{value}");
}

fn phase_request(repo: &Path, reg: &Registry, nonces: &Mutex<BTreeMap<String, Value>>, header: &Value) -> Value {
    let task_slug = header.get("task_slug").and_then(Value::as_str).unwrap_or("");
    let session_id = header.get("session_id").and_then(Value::as_str).unwrap_or("");
    let nonce = header.get("nonce").and_then(Value::as_str).unwrap_or("");
    if task_slug.is_empty() {
        return json!({"observed": true, "forwarded": false});
    }
    let key = format!("{task_slug}/{session_id}/{nonce}");
    if let Ok(guard) = nonces.lock() {
        if let Some(existing) = guard.get(&key) {
            return existing.clone();
        }
    }
    let meta_path = alinery_core::session_meta_path(repo, task_slug, session_id);
    let outcome = accept_phase_completion(reg, repo, session_id, task_slug, "", None, &meta_path, &PathBuf::new());
    let value = match outcome {
        Ok(CompletionOutcome::Accepted { receipt_id }) => json!({"ok": true, "outcome": "accepted", "receipt_id": receipt_id, "playbook": "ready_to_advance"}),
        Ok(CompletionOutcome::HumanAuthorizationRequired) => {
            json!({"ok": true, "outcome": "waiting_for_approval", "correlation_id": format!("completion-permission:{}", header.get("execution_id").and_then(|value| value.as_str()).unwrap_or(""))})
        }
        Ok(CompletionOutcome::InvalidOutputs { diagnostics }) => {
            use std::hash::{Hash, Hasher};
            let mut hash = std::collections::hash_map::DefaultHasher::new();
            diagnostics.hash(&mut hash);
            let execution_id = header.get("execution_id").and_then(Value::as_str).unwrap_or("");
            json!({"ok": true, "outcome": "waiting_for_input", "correlation_id": format!("completion-outputs:{execution_id}:{:016x}", hash.finish()), "diagnostics": diagnostics})
        }
        Err(error) => json!({"error": error}),
    };
    if let Ok(mut guard) = nonces.lock() {
        if !nonce.is_empty() {
            guard.insert(key, value.clone());
            save_nonces(repo, &guard);
        }
    }
    let _ = now_secs();
    value
}

fn grant(repo: &Path, lane: &str, header: &Value) -> Value {
    let request = header.get("request").cloned().unwrap_or(Value::Null);
    let task_slug = request.get("task_slug").and_then(Value::as_str).unwrap_or("");
    let execution_id = request.get("execution_id").and_then(Value::as_str).unwrap_or("");
    let session_id = request.get("session_id").and_then(Value::as_str).unwrap_or("");
    match alinery_core::execution::mutate_execution_state(repo, task_slug, lane, execution_config_identity(), "human completion authorization", |_, state| {
        alinery_core::execution::grant_execution_completion(state, execution_id, session_id)
    }) {
        Ok(()) => json!({"ok": true}),
        Err(error) => json!({"error": error}),
    }
}

fn playbook_axis(repo: &Path, lane: &str) -> Value {
    let mut sessions = Vec::new();
    for task in alinery_core::list_tasks_for_repo(repo) {
        let Ok(reply) = super::execution::query(repo, &task.slug, lane) else { continue };
        for record in reply.state.executions.values() {
            let playbook = match record.lifecycle {
                alinery_core::ExecutionLifecycle::Completed => PlaybookState::Completed,
                alinery_core::ExecutionLifecycle::LaunchFailed | alinery_core::ExecutionLifecycle::Interrupted => PlaybookState::Failed {
                    reason: record.error.clone().unwrap_or_else(|| "launch failed".into()),
                },
                alinery_core::ExecutionLifecycle::Finishing => PlaybookState::ReadyToAdvance,
                _ => PlaybookState::InProgress,
            };
            let mut state = SessionState {
                adapter: alinery_core::HarnessAdapter::Omp,
                message_adapter: alinery_core::MessageAdapter::Unsupported,
                playbook,
                ..SessionState::default()
            };
            state.playbook = match record.lifecycle {
                alinery_core::ExecutionLifecycle::Completed => PlaybookState::Completed,
                alinery_core::ExecutionLifecycle::Finishing => PlaybookState::ReadyToAdvance,
                _ => state.playbook,
            };
            sessions.push(json!({"id": record.owner_session_id, "playbook": state.playbook}));
        }
    }
    json!({"sessions": sessions})
}
