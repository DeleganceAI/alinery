//! Orbitron manager agent: installation-global `tokens.toml`, the `omp --mode rpc` child,
//! and the stdio transport that connects the two to the pane.
//!
//! The XAI key lives beside the effective `app.toml`, never in Keychain and never on
//! `app.toml`. JS only ever sees `{ present }`. The secret reaches the child via env only.
//!
//! The wire contract is `omp://rpc.md`; this module is its only implementation in the app.
//! Frames in and out are appended to `<repo>/.alinery/orbitron-agent/agent.log`, which is
//! the only record of why a chat did or did not answer.

use crate::*;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

const SAVE_ERR: &str = "Couldn't save the xAI key.";

#[derive(Serialize, Deserialize, Default)]
struct TokensToml {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    xai_api_key: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct OrbitronXaiKeyStatus {
    pub(crate) present: bool,
}

pub(crate) fn tokens_path_in(dir: &Path) -> PathBuf {
    dir.join("tokens.toml")
}

fn tokens_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_config_path(app)?.with_file_name("tokens.toml"))
}

pub(crate) fn read_xai_key_in(dir: &Path) -> Option<String> {
    let raw = fs::read_to_string(tokens_path_in(dir)).ok()?;
    let parsed: TokensToml = toml::from_str(&raw).ok()?;
    let key = parsed.xai_api_key?;
    let trimmed = key.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub(crate) fn write_xai_key_in(dir: &Path, key: &str) -> Result<(), String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err(SAVE_ERR.into());
    }
    let body = toml::to_string(&TokensToml {
        xai_api_key: Some(trimmed.to_string()),
    })
    .map_err(|_| SAVE_ERR.to_string())?;
    let path = tokens_path_in(dir);
    write_bytes_atomic(&path, body.as_bytes()).map_err(|_| SAVE_ERR.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|_| SAVE_ERR.to_string())?;
    }
    Ok(())
}

pub(crate) fn clear_xai_key_in(dir: &Path) -> Result<(), String> {
    let path = tokens_path_in(dir);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(SAVE_ERR.into()),
    }
}

pub(crate) fn xai_key_status_in(dir: &Path) -> OrbitronXaiKeyStatus {
    OrbitronXaiKeyStatus {
        present: read_xai_key_in(dir).is_some(),
    }
}

fn tokens_dir(app: &AppHandle) -> Result<PathBuf, String> {
    tokens_path(app)?.parent().map(Path::to_path_buf).ok_or_else(|| SAVE_ERR.to_string())
}

#[allow(dead_code)]
pub(crate) fn read_xai_key(app: &AppHandle) -> Option<String> {
    read_xai_key_in(&tokens_dir(app).ok()?)
}

#[tauri::command]
pub(crate) fn orbitron_xai_key_status(app: AppHandle) -> OrbitronXaiKeyStatus {
    tokens_dir(&app).map(|dir| xai_key_status_in(&dir)).unwrap_or(OrbitronXaiKeyStatus { present: false })
}

#[tauri::command]
pub(crate) fn set_orbitron_xai_key(app: AppHandle, key: String) -> Result<OrbitronXaiKeyStatus, String> {
    let dir = tokens_dir(&app)?;
    write_xai_key_in(&dir, &key)?;
    Ok(xai_key_status_in(&dir))
}

#[tauri::command]
pub(crate) fn clear_orbitron_xai_key(app: AppHandle) -> Result<OrbitronXaiKeyStatus, String> {
    let dir = tokens_dir(&app)?;
    clear_xai_key_in(&dir)?;
    Ok(xai_key_status_in(&dir))
}

const OMP_REQUIRED: &str = "bundled OMP not found";
const KEY_REQUIRED: &str = "xAI key required.";
const COMPACTING_SEND: &str = "The agent is compacting. Try again in a moment.";
const IN_FLIGHT: &str = "Another board change is waiting.";
const BOARD_CLOSED: &str = "The board isn't open. Return to Orbitron View to apply board changes.";
const XAI_SIGNIN: &str = "Couldn't sign in to xAI. Check the API key.";
const SEND_FAILED: &str = "The agent didn't take that message. Check the Orbitron log.";
const MANAGER_PROMPT: &str = include_str!("../../prompts/orbitron/manager.md");

const HOST_TOOLS: &[&str] = &[
    "board_get",
    "concept_create",
    "concept_rename",
    "concept_delete",
    "task_place",
    "task_unplace",
    "task_tag",
    "task_untag",
    "relation_upsert",
    "relation_delete",
    "board_arrange",
];

const MCP_INCLUDE: &[&str] = &[
    "alinery_list_tasks",
    "alinery_get_task",
    "alinery_list_sessions",
    "alinery_session_status",
    "alinery_read_session_history",
    "alinery_list_artifacts",
    "alinery_read_artifact",
    "alinery_list_playbook_steps",
    "alinery_list_playbooks",
    "alinery_list_phases",
    "alinery_create_task",
    "alinery_create_session",
    "alinery_start_session",
    "alinery_archive_task",
    "alinery_send_review_handoff",
    "alinery_backup_now",
];

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OrbitronAgentStatus {
    #[default]
    Idle,
    Thinking,
    UpdatingBoard,
    Compacting,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OrbitronAgentAvailability {
    pub(crate) omp_found: bool,
    pub(crate) omp_path: Option<String>,
    pub(crate) key_present: bool,
    pub(crate) mcp_enabled: bool,
}

#[derive(Clone, Serialize, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum OrbitronAgentEvent {
    Ready,
    Status {
        status: OrbitronAgentStatus,
    },
    Message {
        role: String,
        text: String,
        done: bool,
    },
    HostToolCall {
        id: String,
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        arguments: Value,
    },
    Error {
        message: String,
    },
    Exited,
}

pub(crate) fn stop_managed_orbitron(managed: &mut ManagedOrbitronAgent) {
    // Closing stdin is the documented RPC shutdown: omp drains, disposes the session and
    // exits 0. The kill is only for a child that ignores EOF.
    drop(managed.rt.stdin.lock().unwrap_or_else(|e| e.into_inner()).take());
    if let Some(mut child) = managed.child.take() {
        let _ = child.wait();
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn emit(rt: &OrbitronRuntime, event: OrbitronAgentEvent) {
    let guard = rt.channel.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(channel) = guard.as_ref() {
        let _ = channel.send(event);
    }
}

/// Append to `<repo>/.alinery/orbitron-agent/agent.log`: every line in, every line out,
/// and the child's stderr. Uncapped and never truncated, like a session's `.scrollback`.
/// When a chat sits on "Thinking…" this file is the only place that says why, so it is
/// written before the frame is parsed — a line we cannot decode is exactly the one worth
/// having.
fn log_rpc(rt: &OrbitronRuntime, dir: char, text: &str) {
    let mut guard = rt.log.lock().unwrap_or_else(|e| e.into_inner());
    let Some(file) = guard.as_mut() else { return };
    let key = rt.key.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or_default();
    let _ = writeln!(file, "{stamp} {dir} {}", sanitize_text(text.trim_end(), key.as_deref()));
}

/// One RPC line to the child. Every command and every extension-UI answer goes through
/// here so the log and the single stdin lock have no second home.
fn write_rpc(rt: &OrbitronRuntime, line: &Value) -> Result<(), String> {
    let text = line.to_string();
    log_rpc(rt, '>', &text);
    let mut guard = rt.stdin.lock().unwrap_or_else(|e| e.into_inner());
    let stdin = guard.as_mut().ok_or_else(|| SEND_FAILED.to_string())?;
    stdin
        .write_all(text.as_bytes())
        .and_then(|()| stdin.write_all(b"\n"))
        .and_then(|()| stdin.flush())
        .map_err(|_| SEND_FAILED.to_string())
}

pub(crate) fn current_status(rt: &OrbitronRuntime) -> OrbitronAgentStatus {
    if rt.compacting.load(Ordering::Relaxed) {
        OrbitronAgentStatus::Compacting
    } else if rt.streaming.load(Ordering::Relaxed) {
        OrbitronAgentStatus::Thinking
    } else {
        OrbitronAgentStatus::Idle
    }
}

/// Status is also the send gate (`send_orbitron_agent_prompt`), so the flags move with the
/// event rather than being re-derived from a second reading of the frame.
fn note_status(rt: &OrbitronRuntime, status: OrbitronAgentStatus) {
    match status {
        OrbitronAgentStatus::Thinking => rt.streaming.store(true, Ordering::Relaxed),
        OrbitronAgentStatus::Compacting => rt.compacting.store(true, Ordering::Relaxed),
        OrbitronAgentStatus::Idle => {
            rt.streaming.store(false, Ordering::Relaxed);
            rt.compacting.store(false, Ordering::Relaxed);
        }
        OrbitronAgentStatus::UpdatingBoard => {}
    }
}

pub(crate) fn packaged_omp() -> Option<PathBuf> {
    alinery_core::resolve_packaged_omp_path().ok()
}

pub(crate) fn orbitron_spawn_argv(omp: &Path, repo: &Path, config: &Path) -> Vec<String> {
    let session_dir = alinery_dir(repo).join("orbitron-agent");
    vec![
        omp.display().to_string(),
        "--mode".into(),
        "rpc".into(),
        "--profile".into(),
        "alinery-orbitron".into(),
        "--session-dir".into(),
        session_dir.display().to_string(),
        "--no-tools".into(),
        "--no-extensions".into(),
        "--no-skills".into(),
        "--append-system-prompt".into(),
        MANAGER_PROMPT.replace("{mode}", "requestApproval"),
        "--config".into(),
        config.display().to_string(),
    ]
}

pub(crate) fn orbitron_spawn_env(parent: &[(String, String)], key: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = parent.iter().filter(|(k, _)| k != "XAI_OAUTH_TOKEN" && k != "XAI_API_KEY").cloned().collect();
    out.retain(|(k, _)| k != "PATH");
    out.push(("PATH".into(), login_shell_path()));
    out.push(("XAI_API_KEY".into(), key.to_string()));
    out
}

pub(crate) fn orbitron_config_overlay() -> String {
    "mcp:\n  enableProjectConfig: false\ncompaction:\n  enabled: true\n".into()
}

pub(crate) fn orbitron_mcp_seed_json(enabled: bool, command: &Path, repo: &Path, app_config: &Path) -> String {
    if !enabled {
        return "{\"mcpServers\":{}}".into();
    }
    let include: Vec<&str> = MCP_INCLUDE.to_vec();
    json!({
        "mcpServers": {
            "alinery": {
                "command": command,
                "args": ["--repo", repo, "--app-config", app_config],
                "includeTools": include,
            }
        }
    })
    .to_string()
}

pub(crate) fn host_tool_names(mode: CanvasEditMode) -> Vec<&'static str> {
    match mode {
        CanvasEditMode::ReadOnly => vec!["board_get"],
        _ => HOST_TOOLS.to_vec(),
    }
}

pub(crate) fn host_tool_schemas(mode: CanvasEditMode) -> Vec<Value> {
    host_tool_names(mode)
        .into_iter()
        .map(|name| {
            json!({
                "name": name,
                "description": name,
                // `set_host_tools` names this field `parameters` (omp://rpc.md). `inputSchema`
                // is the MCP spelling; sending that registers the tool with no arguments.
                "parameters": { "type": "object", "properties": schema_properties(name) }
            })
        })
        .collect()
}

fn schema_properties(name: &str) -> Value {
    match name {
        "concept_create" => json!({ "name": { "type": "string" } }),
        "concept_rename" => json!({ "id": { "type": "string" }, "name": { "type": "string" } }),
        "concept_delete" => json!({ "id": { "type": "string" } }),
        "task_place" => json!({ "slug": { "type": "string" }, "conceptId": { "type": "string" } }),
        "task_unplace" => json!({ "slug": { "type": "string" } }),
        "task_tag" => json!({ "slug": { "type": "string" }, "conceptId": { "type": "string" }, "primary": { "type": "boolean" } }),
        "task_untag" => json!({ "slug": { "type": "string" }, "conceptId": { "type": "string" } }),
        "relation_upsert" => json!({ "a": { "type": "string" }, "b": { "type": "string" }, "kind": { "enum": ["blocks", "surface", "informs"] } }),
        "relation_delete" => json!({ "a": { "type": "string" }, "b": { "type": "string" } }),
        _ => json!({}),
    }
}

/// One OMP stdio RPC line. `type` is the command discriminator (`omp://rpc.md`); a line
/// keyed `op` comes back as `Unknown command: undefined`. The discriminator is inserted
/// rather than written in the literal because `check-wire-parsing-boundary.sh` reads an
/// `op`-keyed object literal as an alineryd request, which this is not.
fn omp_rpc(command: &str, mut fields: Value) -> Value {
    fields.as_object_mut().expect("omp_rpc fields").insert("type".into(), Value::String(command.into()));
    fields
}

pub(crate) fn bootstrap_set_model() -> Value {
    omp_rpc("set_model", json!({ "provider": "xai", "modelId": "grok-4.6" }))
}

pub(crate) fn bootstrap_negotiate() -> Value {
    omp_rpc("negotiate_protocol", json!({ "protocolVersion": 2 }))
}

/// Replaces the whole host-owned tool set, so this is both the bootstrap registration and
/// the mode switch.
pub(crate) fn set_host_tools_request(mode: CanvasEditMode) -> Value {
    omp_rpc("set_host_tools", json!({ "tools": host_tool_schemas(mode) }))
}

/// Sent once after bootstrap: the reply is what names the session file for the pointer.
pub(crate) fn get_state_request() -> Value {
    omp_rpc("get_state", json!({}))
}

pub(crate) fn prompt_request(text: &str, streaming_behavior: Option<&str>) -> Value {
    let mut line = omp_rpc("prompt", json!({ "message": text }));
    if let Some(behavior) = streaming_behavior {
        line["streamingBehavior"] = Value::String(behavior.into());
    }
    line
}

/// Host-tool completion. The frontend's result is arbitrary JSON; the wire wants MCP-style
/// text content, so a string passes through and anything else is serialized for the model.
pub(crate) fn host_tool_result_line(id: &str, result: &Value, is_error: bool) -> Value {
    let text = result.as_str().map(str::to_string).unwrap_or_else(|| result.to_string());
    let mut line = json!({ "type": "host_tool_result", "id": id, "result": { "content": [{ "type": "text", "text": text }] } });
    if is_error {
        line["isError"] = Value::Bool(true);
    }
    line
}

pub(crate) fn sanitize_text(text: &str, key: Option<&str>) -> String {
    let mut out = text.replace("XAI_API_KEY=", "***");
    if let Some(k) = key {
        if !k.is_empty() {
            out = out.replace(k, "***");
        }
    }
    out
}

pub(crate) fn map_rpc_event(line: &Value, key: Option<&str>) -> Option<OrbitronAgentEvent> {
    let kind = line.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "auto_compaction_start" => Some(OrbitronAgentEvent::Status {
            status: OrbitronAgentStatus::Compacting,
        }),
        // `isTerminal: false` means maintenance or async delivery scheduled more work and
        // the session will resume, so the turn is not over and the composer must stay in
        // its streaming gate. The field is optional; absent means terminal.
        "agent_end" if line.get("isTerminal").and_then(|v| v.as_bool()) == Some(false) => None,
        "auto_compaction_end" | "agent_end" => Some(OrbitronAgentEvent::Status {
            status: OrbitronAgentStatus::Idle,
        }),
        "agent_start" => Some(OrbitronAgentEvent::Status {
            status: OrbitronAgentStatus::Thinking,
        }),
        "host_tool_call" => {
            let name = line.get("toolName").and_then(|v| v.as_str()).unwrap_or("");
            if name == "board_get" {
                return None;
            }
            Some(OrbitronAgentEvent::Status {
                status: OrbitronAgentStatus::UpdatingBoard,
            })
        }
        "message_update" => assistant_text(line, key),
        _ => None,
    }
}

/// Assistant text arrives as `assistantMessageEvent` deltas, interleaved with the model's
/// reasoning: `thinking_start` / `thinking_delta` / `thinking_end`, then `text_start` /
/// `text_delta` / `text_end` (verified against omp 17.3.5). Only the text deltas are
/// transcript. `text_end` repeats the whole message, so forwarding it would double it.
///
/// `done` is the pane's "start a new bubble" flag, which is why the *start* of a message is
/// the event that carries it and the deltas that follow do not.
fn assistant_text(line: &Value, key: Option<&str>) -> Option<OrbitronAgentEvent> {
    let event = line.get("assistantMessageEvent")?;
    let kind = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let (text, done) = match kind {
        "text_start" => (String::new(), true),
        "text_delta" => (event.get("delta").and_then(|v| v.as_str()).unwrap_or_default().to_string(), false),
        _ => return None,
    };
    Some(OrbitronAgentEvent::Message {
        role: "assistant".into(),
        text: sanitize_text(&text, key),
        done,
    })
}

/// Protocol v2 lossless framing. An oversized stdout object is emitted as an
/// uninterrupted run of `rpc_chunk` frames carrying base64 segments of the original UTF-8
/// JSON; anything else passes straight through. Worth the ~50 lines because `agent_end`
/// carries the whole message list: on v1 the frame that ends a long chat is the one most
/// likely to blow the 1 MiB cap, and losing it leaves the pane on "Thinking…" forever.
#[derive(Default)]
pub(crate) struct RpcFrameDecoder {
    chunk_id: Option<String>,
    next_index: usize,
    count: usize,
    byte_length: usize,
    buf: Vec<u8>,
}

const MAX_REASSEMBLED_BYTES: usize = 67_108_864;

impl RpcFrameDecoder {
    /// `Ok(None)` = a chunk was absorbed and the object is still incomplete.
    pub(crate) fn feed(&mut self, frame: Value) -> Result<Option<Value>, String> {
        if frame.get("type").and_then(|v| v.as_str()) != Some("rpc_chunk") {
            if self.chunk_id.is_some() {
                self.reset();
                return Err("interleaved frame inside an rpc_chunk sequence".into());
            }
            return Ok(Some(frame));
        }
        let field = |name: &str| {
            frame
                .get(name)
                .and_then(|v| v.as_u64())
                .map(|n| n as usize)
                .ok_or_else(|| format!("rpc_chunk without {name}"))
        };
        let id = frame.get("chunkId").and_then(|v| v.as_str()).ok_or("rpc_chunk without chunkId")?.to_string();
        let index = field("index")?;
        let count = field("count")?;
        let byte_length = field("byteLength")?;
        let data = frame.get("data").and_then(|v| v.as_str()).ok_or("rpc_chunk without data")?;
        if index == 0 {
            self.reset();
            self.chunk_id = Some(id.clone());
            self.count = count;
            self.byte_length = byte_length;
        }
        if self.chunk_id.as_deref() != Some(id.as_str()) || index != self.next_index || count != self.count || byte_length != self.byte_length {
            self.reset();
            return Err("interrupted rpc_chunk sequence".into());
        }
        if byte_length > MAX_REASSEMBLED_BYTES {
            self.reset();
            return Err("rpc_chunk sequence over the reassembly limit".into());
        }
        self.buf.extend_from_slice(&base64_decode(data)?);
        self.next_index += 1;
        if self.next_index < count {
            return Ok(None);
        }
        let bytes = std::mem::take(&mut self.buf);
        self.reset();
        if bytes.len() != byte_length {
            return Err("rpc_chunk byteLength mismatch".into());
        }
        let text = String::from_utf8(bytes).map_err(|_| "rpc_chunk payload is not UTF-8".to_string())?;
        serde_json::from_str(&text).map(Some).map_err(|e| e.to_string())
    }

    fn reset(&mut self) {
        self.chunk_id = None;
        self.next_index = 0;
        self.count = 0;
        self.byte_length = 0;
        self.buf.clear();
    }
}

/// Standard alphabet, padding ignored. Hand-rolled to match `connections.rs` and
/// `telemetry.rs` rather than take a dependency for one decode.
fn base64_decode(text: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\r' | b'\n' => continue,
            _ => return Err("rpc_chunk data is not base64".into()),
        };
        acc = (acc << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

/// The child's stdout, for the life of the process. Owns nothing but the runtime, so it
/// can never contend with the command path for `AppState.orbitron_agent`.
fn reader_loop(stdout: std::process::ChildStdout, rt: std::sync::Arc<OrbitronRuntime>) {
    let mut decoder = RpcFrameDecoder::default();
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        log_rpc(&rt, '<', &line);
        let frame = match serde_json::from_str::<Value>(&line) {
            Ok(frame) => frame,
            Err(e) => {
                log_rpc(&rt, '!', &e.to_string());
                continue;
            }
        };
        match decoder.feed(frame) {
            Ok(Some(frame)) => handle_frame(&rt, &frame),
            Ok(None) => {}
            Err(e) => log_rpc(&rt, '!', &e),
        }
    }
    rt.streaming.store(false, Ordering::Relaxed);
    rt.compacting.store(false, Ordering::Relaxed);
    emit(&rt, OrbitronAgentEvent::Exited);
}

fn handle_frame(rt: &OrbitronRuntime, frame: &Value) {
    let key = rt.key.lock().unwrap_or_else(|e| e.into_inner()).clone();
    match frame.get("type").and_then(|v| v.as_str()).unwrap_or("") {
        // Answering this is not optional: `omp` raises `setWidget` before the first turn
        // and after every turn, and an extension UI request nobody answers stalls the turn
        // indefinitely — the same prompt reaches `agent_end` in 4s answered and never
        // completes unanswered (omp 17.3.5). Alinery renders no OMP widgets, so the honest
        // answer to all of them is "dismissed".
        "extension_ui_request" => {
            if let Some(id) = frame.get("id").and_then(|v| v.as_str()) {
                let _ = write_rpc(rt, &cancel_extension_ui(id));
            }
        }
        "host_tool_call" => {
            let id = frame.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            let tool_name = frame.get("toolName").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            let tool_call_id = frame.get("toolCallId").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            let mutating = tool_name != "board_get";
            // One board change at a time: the held call is the one the human is being asked
            // about, so a second is refused rather than silently taking its place — an
            // overwritten id can never be answered and the agent waits on it forever.
            if let Some(refusal) = reject_second_write(rt, mutating) {
                let _ = write_rpc(rt, &host_tool_result_line(&id, &Value::String(refusal.into()), true));
                return;
            }
            if mutating {
                *rt.pending_write_id.lock().unwrap_or_else(|e| e.into_inner()) = Some(id.clone());
            }
            if let Some(event) = map_rpc_event(frame, key.as_deref()) {
                if let OrbitronAgentEvent::Status { status } = event {
                    note_status(rt, status);
                }
                emit(rt, event);
            }
            emit(
                rt,
                OrbitronAgentEvent::HostToolCall {
                    id,
                    tool_call_id,
                    tool_name,
                    arguments: frame.get("arguments").cloned().unwrap_or_else(|| json!({})),
                },
            );
        }
        // The agent gave up on the call; the pane's Accept would have nowhere to land.
        "host_tool_cancel" => {
            let target = frame.get("targetId").and_then(|v| v.as_str()).unwrap_or_default();
            let mut pending = rt.pending_write_id.lock().unwrap_or_else(|e| e.into_inner());
            if pending.as_deref() == Some(target) {
                *pending = None;
            }
        }
        "response" => handle_response(rt, frame),
        _ => {
            if let Some(event) = map_rpc_event(frame, key.as_deref()) {
                if let OrbitronAgentEvent::Status { status } = event {
                    note_status(rt, status);
                }
                emit(rt, event);
            }
        }
    }
}

/// Command replies. Only three matter to the product: a rejected key, a rejected send, and
/// the session file. Everything else is in the log.
fn handle_response(rt: &OrbitronRuntime, frame: &Value) {
    let command = frame.get("command").and_then(|v| v.as_str()).unwrap_or("");
    let ok = frame.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
    match (command, ok) {
        ("set_model", false) => emit(rt, set_model_failure_event(&frame.to_string())),
        ("prompt", false) => {
            note_status(rt, OrbitronAgentStatus::Idle);
            emit(rt, OrbitronAgentEvent::Error { message: SEND_FAILED.into() });
            emit(
                rt,
                OrbitronAgentEvent::Status {
                    status: OrbitronAgentStatus::Idle,
                },
            );
        }
        ("get_state", true) => {
            if let Some(file) = frame.pointer("/data/sessionFile").and_then(|v| v.as_str()) {
                let _ = write_session_pointer(&rt.dir, file);
            }
        }
        _ => {}
    }
}

pub(crate) fn write_session_pointer(dir: &Path, session_file: &str) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let body = json!({ "sessionFile": Path::new(session_file).file_name().and_then(|s| s.to_str()).unwrap_or(session_file) });
    fs::write(dir.join("current.json"), body.to_string()).map_err(|e| e.to_string())
}

pub(crate) fn start_orbitron_agent_checked(
    state: &AppState,
    repo: PathBuf,
    omp: Option<PathBuf>,
    key: Option<String>,
    mcp_enabled: bool,
    mut spawn: impl FnMut(&Path, &str, bool) -> Result<ManagedOrbitronAgent, String>,
) -> Result<ManagedOrbitronAgent, String> {
    if omp.is_none() {
        return Err(OMP_REQUIRED.into());
    }
    let Some(key) = key.filter(|k| !k.trim().is_empty()) else {
        return Err(KEY_REQUIRED.into());
    };
    let mut guard = state.orbitron_agent.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(existing) = guard.as_mut() {
        if existing.repo == repo {
            if existing.mcp_seeded != mcp_enabled {
                stop_managed_orbitron(existing);
                let spawned = spawn(&repo, &key, mcp_enabled)?;
                *existing = spawned;
                return Ok(clone_handle(existing));
            }
            existing.attached = true;
            return Ok(clone_handle(existing));
        }
        stop_managed_orbitron(existing);
        *guard = None;
    }
    let spawned = spawn(&repo, &key, mcp_enabled)?;
    let handle = clone_handle(&spawned);
    *guard = Some(spawned);
    Ok(handle)
}

fn clone_handle(agent: &ManagedOrbitronAgent) -> ManagedOrbitronAgent {
    ManagedOrbitronAgent {
        repo: agent.repo.clone(),
        child: None,
        pid: agent.pid,
        mcp_seeded: agent.mcp_seeded,
        spawn_count: agent.spawn_count,
        rt: std::sync::Arc::clone(&agent.rt),
        stdin_writes: agent.stdin_writes,
        attached: agent.attached,
    }
}

#[tauri::command]
pub(crate) fn orbitron_agent_availability(app: AppHandle) -> OrbitronAgentAvailability {
    let omp = packaged_omp();
    OrbitronAgentAvailability {
        omp_found: omp.is_some(),
        omp_path: omp.map(|p| p.display().to_string()),
        key_present: read_xai_key(&app).is_some(),
        mcp_enabled: load_app_config(&app).mcp_enabled,
    }
}

#[tauri::command]
pub(crate) fn start_orbitron_agent(app: AppHandle, state: State<AppState>, repo_path: String, on_event: tauri::ipc::Channel<OrbitronAgentEvent>) -> Result<(), String> {
    let repo = PathBuf::from(&repo_path);
    require_repo_owned(&state, &repo)?;
    let omp = packaged_omp();
    let key = read_xai_key(&app);
    let mcp_enabled = load_app_config(&app).mcp_enabled;
    let channel = on_event.clone();
    let started = start_orbitron_agent_checked(&state, repo, omp.clone(), key.clone(), mcp_enabled, |repo, key, mcp| {
        spawn_orbitron_child(&app, repo, omp.as_ref().expect("checked"), key, mcp, channel.clone())
    })?;
    // Reattach reuses the running child, so the new pane's channel has to replace the old
    // one here as well — the spawn path only sets it for a process it just created.
    *started.rt.channel.lock().unwrap_or_else(|e| e.into_inner()) = Some(on_event.clone());
    let _ = on_event.send(OrbitronAgentEvent::Ready);
    let _ = on_event.send(OrbitronAgentEvent::Status {
        status: current_status(&started.rt),
    });
    Ok(())
}

fn spawn_orbitron_child(app: &AppHandle, repo: &Path, omp: &Path, key: &str, mcp_enabled: bool, channel: Channel<OrbitronAgentEvent>) -> Result<ManagedOrbitronAgent, String> {
    let session_dir = alinery_dir(repo).join("orbitron-agent");
    fs::create_dir_all(&session_dir).map_err(|e| e.to_string())?;
    let overlay = session_dir.join("overlay.yaml");
    fs::write(&overlay, orbitron_config_overlay()).map_err(|e| e.to_string())?;
    let cfg = app_config_path(app).unwrap_or_default();
    let (agent_dir, config_root) = alinery_core::omp_home_dirs(&cfg);
    let mcp_path = agent_dir.join("profiles/alinery-orbitron/agent/mcp.json");
    if let Some(parent) = mcp_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let command = resolve_mcp_path().unwrap_or_else(|| PathBuf::from("alinery-mcp"));
    let _ = fs::write(&mcp_path, orbitron_mcp_seed_json(mcp_enabled, &command, repo, &cfg));
    let argv = orbitron_spawn_argv(omp, repo, &overlay);
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..])
        .current_dir(repo)
        .env_clear()
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let inherited: Vec<(String, String)> = alinery_core::omp_inherited_env().into_iter().map(|(k, v)| (k.to_string(), v)).collect();
    for (k, v) in orbitron_spawn_env(&inherited, key) {
        cmd.env(k, v);
    }
    cmd.env("PI_CODING_AGENT_DIR", &agent_dir);
    cmd.env("PI_CONFIG_DIR", &config_root);
    let mut child = cmd.spawn().map_err(|_| OMP_REQUIRED.to_string())?;
    let pid = child.id();
    let rt = std::sync::Arc::new(OrbitronRuntime {
        stdin: Mutex::new(child.stdin.take()),
        channel: Mutex::new(Some(channel)),
        log: Mutex::new(fs::OpenOptions::new().create(true).append(true).open(session_dir.join("agent.log")).ok()),
        key: Mutex::new(Some(key.to_string())),
        dir: session_dir,
        ..OrbitronRuntime::default()
    });
    if let Some(stdout) = child.stdout.take() {
        let reader_rt = std::sync::Arc::clone(&rt);
        std::thread::spawn(move || reader_loop(stdout, reader_rt));
    }
    if let Some(stderr) = child.stderr.take() {
        let stderr_rt = std::sync::Arc::clone(&rt);
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log_rpc(&stderr_rt, '!', &line);
            }
        });
    }
    // Order matters: v2 framing before anything large can be emitted, then the model, then
    // the tools the agent is allowed to call. `get_state` is last only for its session file.
    let _ = write_rpc(&rt, &bootstrap_negotiate());
    let _ = write_rpc(&rt, &bootstrap_set_model());
    let _ = write_rpc(&rt, &set_host_tools_request(CanvasEditMode::RequestApproval));
    let _ = write_rpc(&rt, &get_state_request());
    Ok(ManagedOrbitronAgent {
        repo: repo.to_path_buf(),
        child: Some(child),
        pid,
        mcp_seeded: mcp_enabled,
        spawn_count: 1,
        rt,
        stdin_writes: 0,
        attached: true,
    })
}

#[tauri::command]
pub(crate) fn send_orbitron_agent_prompt(state: State<AppState>, repo_path: String, text: String, streaming_behavior: Option<String>) -> Result<(), String> {
    let mut guard = state.orbitron_agent.lock().unwrap_or_else(|e| e.into_inner());
    let Some(agent) = guard.as_mut() else {
        return Err("The Orbitron agent is not running.".into());
    };
    if agent.repo != Path::new(&repo_path) {
        return Err("The Orbitron agent is not running.".into());
    }
    if agent.rt.compacting.load(Ordering::Relaxed) {
        return Err(COMPACTING_SEND.into());
    }
    // `prompt` fails outright if it arrives mid-stream without a queue policy, so a send
    // the pane did not mark as a follow-up is dropped rather than turned into an error.
    if agent.rt.streaming.load(Ordering::Relaxed) && streaming_behavior.as_deref() != Some("followUp") {
        return Ok(());
    }
    write_rpc(&agent.rt, &prompt_request(&text, streaming_behavior.as_deref()))?;
    agent.stdin_writes += 1;
    Ok(())
}

#[tauri::command]
pub(crate) fn orbitron_host_tool_result(state: State<AppState>, repo_path: String, id: String, result: Value, is_error: bool) -> Result<(), String> {
    let mut guard = state.orbitron_agent.lock().unwrap_or_else(|e| e.into_inner());
    let Some(agent) = guard.as_mut() else {
        return Err("Unknown board tool.".into());
    };
    if agent.repo != Path::new(&repo_path) {
        return Err("Unknown board tool.".into());
    }
    let mut pending = agent.rt.pending_write_id.lock().unwrap_or_else(|e| e.into_inner());
    if pending.as_deref() != Some(id.as_str()) && pending.is_some() {
        return Err("Unknown board tool.".into());
    }
    if let Some(err) = detached_write_error(agent.attached, pending.is_some()) {
        return Err(err.into());
    }
    *pending = None;
    drop(pending);
    write_rpc(&agent.rt, &host_tool_result_line(&id, &result, is_error))
}

#[tauri::command]
pub(crate) fn set_orbitron_agent_mode(state: State<AppState>, repo_path: String, mode: CanvasEditMode) -> Result<(), String> {
    let guard = state.orbitron_agent.lock().unwrap_or_else(|e| e.into_inner());
    let Some(agent) = guard.as_ref() else {
        return Ok(());
    };
    if agent.repo != Path::new(&repo_path) {
        return Ok(());
    }
    // Read Only is enforced by shipping the agent a smaller tool set, not by refusing calls
    // it was told it could make.
    let _ = write_rpc(&agent.rt, &set_host_tools_request(mode));
    Ok(())
}

/// The single home of the one-in-flight rule, consulted by the reader before it forwards a
/// mutating call to the board.
pub(crate) fn reject_second_write(rt: &OrbitronRuntime, mutating: bool) -> Option<&'static str> {
    if mutating && rt.pending_write_id.lock().unwrap_or_else(|e| e.into_inner()).is_some() {
        Some(IN_FLIGHT)
    } else {
        None
    }
}

/// A result for a call nobody is holding, from a view that is gone: the board it would
/// have been applied to is no longer on screen.
pub(crate) fn detached_write_error(attached: bool, pending: bool) -> Option<&'static str> {
    (!pending && !attached).then_some(BOARD_CLOSED)
}

pub(crate) fn set_model_failure_event(raw: &str) -> OrbitronAgentEvent {
    let _ = raw;
    OrbitronAgentEvent::Error { message: XAI_SIGNIN.into() }
}

/// Not an `RpcCommand` — extension UI is its own inbound frame category, keyed
/// `extension_ui_response` and answered by `id`.
pub(crate) fn cancel_extension_ui(id: &str) -> Value {
    json!({ "type": "extension_ui_response", "id": id, "cancelled": true })
}
