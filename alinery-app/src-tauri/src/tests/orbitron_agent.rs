//! Tests for orbitron_agent.rs — tokens.toml first (Phase 3).
use super::*;
use std::path::PathBuf;

fn tokens_dir(name: &str) -> std::path::PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("saga-orbitron-tokens-{name}-{}-{nanos}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("app.toml"), b"# marker\n").unwrap();
    dir
}

#[test]
fn orbitron_xai_key_status_missing_file_is_absent() {
    let dir = tokens_dir("missing");
    assert_eq!(xai_key_status_in(&dir), OrbitronXaiKeyStatus { present: false });
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn orbitron_xai_key_set_then_present_mode_600_sibling() {
    let dir = tokens_dir("set");
    write_xai_key_in(&dir, "sk-test").expect("set");
    assert_eq!(xai_key_status_in(&dir), OrbitronXaiKeyStatus { present: true });

    let path = tokens_path_in(&dir);
    assert_eq!(path.file_name().unwrap(), "tokens.toml");
    assert_eq!(path.parent().unwrap(), dir.as_path());
    assert!(dir.join("app.toml").exists());

    let body = fs::read_to_string(&path).unwrap();
    let parsed: toml::Value = toml::from_str(&body).unwrap();
    assert_eq!(parsed.get("xai_api_key").and_then(|v| v.as_str()), Some("sk-test"));

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "tokens.toml must be 0o600, got {mode:o}");
    }

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn orbitron_xai_key_clear_removes_file() {
    let dir = tokens_dir("clear");
    write_xai_key_in(&dir, "sk-test").unwrap();
    clear_xai_key_in(&dir).unwrap();
    assert_eq!(xai_key_status_in(&dir), OrbitronXaiKeyStatus { present: false });
    assert!(!tokens_path_in(&dir).exists());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn orbitron_xai_key_rejects_empty_and_whitespace() {
    let dir = tokens_dir("empty");
    for bad in ["", "   "] {
        let err = write_xai_key_in(&dir, bad).expect_err("empty key must be refused");
        assert!(err.contains("Couldn't save the xAI key."), "{err}");
        assert!(!err.contains("   "));
        assert!(!tokens_path_in(&dir).exists());
    }
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn orbitron_xai_key_status_serializes_only_present() {
    let value = serde_json::to_value(OrbitronXaiKeyStatus { present: true }).unwrap();
    let obj = value.as_object().expect("object");
    assert_eq!(obj.keys().collect::<Vec<_>>(), vec!["present"]);
    assert!(!obj.contains_key("key"));
    assert!(!obj.contains_key("xai_api_key"));
}

#[test]
fn orbitron_xai_key_errors_do_not_echo_the_secret() {
    let dir = tokens_dir("noleak");
    let err = write_xai_key_in(&dir, "   ").expect_err("whitespace");
    assert!(!err.contains("sk-"));
    assert!(!err.contains("XAI_API_KEY"));
    assert!(!err.contains("xai_api_key"));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn orbitron_xai_key_does_not_write_app_toml() {
    let dir = tokens_dir("app-untouched");
    let before = fs::read(dir.join("app.toml")).unwrap();
    write_xai_key_in(&dir, "sk-test").unwrap();
    clear_xai_key_in(&dir).unwrap();
    assert_eq!(fs::read(dir.join("app.toml")).unwrap(), before);
    let _ = fs::remove_dir_all(&dir);
}

fn fake_agent(repo: &Path, spawn_count: usize, pid: u32) -> crate::ManagedOrbitronAgent {
    crate::ManagedOrbitronAgent {
        repo: repo.to_path_buf(),
        child: None,
        pid,
        mcp_seeded: false,
        spawn_count,
        rt: std::sync::Arc::new(crate::OrbitronRuntime::default()),
        stdin_writes: 0,
        attached: true,
    }
}

#[test]
fn stop_orbitron_agent_on_none_is_a_no_op() {
    let state = AppState::default();
    state.stop_orbitron_agent();
    assert!(state.orbitron_agent.lock().unwrap().is_none());
}

#[test]
fn orbitron_agent_availability_without_tokens() {
    assert!(!xai_key_status_in(&tokens_dir("avail-key")).present);
}

#[test]
fn start_orbitron_agent_without_omp_does_not_spawn() {
    let state = AppState::default();
    let repo = PathBuf::from("/tmp/repo-a");
    let mut spawned = 0;
    let err = crate::start_orbitron_agent_checked(&state, repo, None, Some("sk".into()), false, |_, _, _| {
        spawned += 1;
        Ok(fake_agent(&PathBuf::from("/tmp/repo-a"), 1, 1))
    })
    .err()
    .expect("missing omp");
    assert_eq!(err, "bundled OMP not found");
    assert_eq!(spawned, 0);
}

#[test]
fn start_orbitron_agent_without_key_does_not_spawn() {
    let state = AppState::default();
    let repo = PathBuf::from("/tmp/repo-a");
    let mut spawned = 0;
    let err = crate::start_orbitron_agent_checked(&state, repo, Some(PathBuf::from("/bin/omp")), None, false, |_, _, _| {
        spawned += 1;
        Ok(fake_agent(&PathBuf::from("/tmp/repo-a"), 1, 1))
    })
    .err()
    .expect("missing key");
    assert_eq!(err, "xAI key required.");
    assert_eq!(spawned, 0);
}

#[test]
fn start_for_the_same_repo_replaces_the_event_sink_and_does_not_respawn() {
    let state = AppState::default();
    let repo = PathBuf::from("/tmp/repo-a");
    *state.orbitron_agent.lock().unwrap() = Some(fake_agent(&repo, 1, 42));
    let mut spawned = 0;
    let started = crate::start_orbitron_agent_checked(&state, repo.clone(), Some(PathBuf::from("/bin/omp")), Some("sk".into()), false, |_, _, _| {
        spawned += 1;
        Ok(fake_agent(&repo, 2, 99))
    })
    .unwrap();
    assert_eq!(spawned, 0);
    assert_eq!(started.pid, 42);
    assert_eq!(started.spawn_count, 1);
}

#[test]
fn start_for_a_different_repo_stops_then_spawns() {
    let state = AppState::default();
    *state.orbitron_agent.lock().unwrap() = Some(fake_agent(&PathBuf::from("/tmp/repo-a"), 1, 1));
    let mut spawned = 0;
    let started = crate::start_orbitron_agent_checked(
        &state,
        PathBuf::from("/tmp/repo-b"),
        Some(PathBuf::from("/bin/omp")),
        Some("sk".into()),
        false,
        |repo, _, _| {
            spawned += 1;
            Ok(fake_agent(repo, 2, 7))
        },
    )
    .unwrap();
    assert_eq!(spawned, 1);
    assert_eq!(started.spawn_count, 2);
    assert_eq!(started.repo, PathBuf::from("/tmp/repo-b"));
}

#[test]
fn start_reattach_restarts_when_mcp_seeded_disagrees() {
    let state = AppState::default();
    let repo = PathBuf::from("/tmp/repo-a");
    let mut existing = fake_agent(&repo, 1, 1);
    existing.mcp_seeded = false;
    *state.orbitron_agent.lock().unwrap() = Some(existing);
    let mut spawned = 0;
    let started = crate::start_orbitron_agent_checked(&state, repo.clone(), Some(PathBuf::from("/bin/omp")), Some("sk".into()), true, |_, _, mcp| {
        spawned += 1;
        let mut next = fake_agent(&repo, 2, 2);
        next.mcp_seeded = mcp;
        Ok(next)
    })
    .unwrap();
    assert_eq!(spawned, 1);
    assert!(started.mcp_seeded);
}

#[test]
fn orbitron_spawn_argv_is_rpc_profile_session_no_tools() {
    let argv = crate::orbitron_spawn_argv(Path::new("/usr/bin/omp"), Path::new("/tmp/repo"), Path::new("/tmp/overlay.yaml"));
    let joined = argv.join(" ");
    assert!(joined.contains("--mode rpc"));
    assert!(joined.contains("--profile alinery-orbitron"));
    assert!(joined.contains(".alinery/orbitron-agent"));
    assert!(joined.contains("--no-tools"));
    assert!(joined.contains("--no-extensions"));
    assert!(joined.contains("--no-skills"));
    assert!(joined.contains("--append-system-prompt"));
    assert!(joined.contains("--config"));
}

#[test]
fn orbitron_spawn_env_sets_xai_key_and_strips_oauth() {
    let env = crate::orbitron_spawn_env(&[("XAI_OAUTH_TOKEN".into(), "abc".into()), ("PATH".into(), "/old".into())], "sk-live");
    assert!(env.iter().any(|(k, v)| k == "XAI_API_KEY" && v == "sk-live"));
    assert!(!env.iter().any(|(k, _)| k == "XAI_OAUTH_TOKEN"));
}

#[test]
fn current_json_points_at_session_basename() {
    let dir = std::env::temp_dir().join(format!("saga-orbitron-sess-{}", std::process::id()));
    crate::write_session_pointer(&dir, "/abs/path/sess.jsonl").unwrap();
    let body = fs::read_to_string(dir.join("current.json")).unwrap();
    assert_eq!(body, "{\"sessionFile\":\"sess.jsonl\"}");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn orbitron_mcp_seed_include_list_when_enabled() {
    let raw = crate::orbitron_mcp_seed_json(true, Path::new("/abs/alinery-mcp"), Path::new("/repo"), Path::new("/cfg/app.toml"));
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let server = &v["mcpServers"]["alinery"];
    assert!(server["command"].as_str().unwrap().starts_with('/'));
    assert_eq!(server["args"], serde_json::json!(["--repo", "/repo", "--app-config", "/cfg/app.toml"]));
    let tools: Vec<&str> = server["includeTools"].as_array().unwrap().iter().map(|t| t.as_str().unwrap()).collect();
    for name in ["alinery_list_tasks", "alinery_backup_now", "alinery_create_task"] {
        assert!(tools.contains(&name), "{name}");
    }
    for name in ["alinery_write_config", "alinery_write_harnesses", "alinery_delete_archived_storage"] {
        assert!(!tools.contains(&name), "{name}");
    }
}

#[test]
fn orbitron_mcp_seed_empty_when_disabled() {
    let raw = crate::orbitron_mcp_seed_json(false, Path::new("/abs/alinery-mcp"), Path::new("/repo"), Path::new("/cfg"));
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(v["mcpServers"], serde_json::json!({}));
}

#[test]
fn orbitron_config_overlay_disables_project_mcp() {
    let yaml = crate::orbitron_config_overlay();
    assert!(yaml.contains("enableProjectConfig: false"));
    assert!(yaml.contains("enabled: true"));
    assert!(!yaml.contains("approvalMode"));
}

#[test]
fn orbitron_host_tool_names_read_only_is_board_get() {
    assert_eq!(crate::host_tool_names(crate::CanvasEditMode::ReadOnly), vec!["board_get"]);
}

#[test]
fn orbitron_host_tool_names_edit_modes_are_the_catalog() {
    assert_eq!(crate::host_tool_names(crate::CanvasEditMode::AutoEdit).len(), 11);
    assert_eq!(crate::host_tool_names(crate::CanvasEditMode::RequestApproval).len(), 11);
}

#[test]
fn orbitron_bootstrap_set_model_is_xai_grok() {
    let line = crate::bootstrap_set_model();
    assert_eq!(line["provider"], "xai");
    assert_eq!(line["modelId"], "grok-4.6");
}

// Every command is discriminated by `type`. A line keyed `op` is answered
// `Unknown command: undefined`, which is how a whole bootstrap can be sent to a healthy
// daemon and change nothing at all.
#[test]
fn orbitron_rpc_lines_are_keyed_type() {
    assert_eq!(crate::bootstrap_negotiate()["type"], "negotiate_protocol");
    assert_eq!(crate::bootstrap_set_model()["type"], "set_model");
    assert_eq!(crate::get_state_request()["type"], "get_state");
    assert_eq!(crate::set_host_tools_request(crate::CanvasEditMode::ReadOnly)["type"], "set_host_tools");
    assert_eq!(crate::prompt_request("hi", None)["type"], "prompt");
    for line in [
        crate::bootstrap_negotiate(),
        crate::bootstrap_set_model(),
        crate::get_state_request(),
        crate::prompt_request("hi", None),
    ] {
        assert!(line.get("op").is_none(), "{line}");
    }
}

#[test]
fn orbitron_bootstrap_negotiates_protocol_2() {
    assert_eq!(crate::bootstrap_negotiate()["protocolVersion"], 2);
}

#[test]
fn orbitron_prompt_carries_streaming_behavior_only_when_given() {
    assert_eq!(crate::prompt_request("hi", Some("followUp"))["streamingBehavior"], "followUp");
    assert!(crate::prompt_request("hi", None).get("streamingBehavior").is_none());
    assert_eq!(crate::prompt_request("hi", None)["message"], "hi");
}

// The reasoning stream and the transcript arrive on the same event, keyed only by the
// `assistantMessageEvent` type — forwarding the wrong one puts the model's private
// deliberation in the chat.
#[test]
fn orbitron_event_mapper_drops_thinking_deltas() {
    for kind in ["thinking_start", "thinking_delta", "thinking_end"] {
        let line = serde_json::json!({ "type": "message_update", "assistantMessageEvent": { "type": kind, "delta": "secret plan", "content": "secret plan" } });
        assert!(crate::map_rpc_event(&line, None).is_none(), "{kind}");
    }
}

#[test]
fn orbitron_event_mapper_keeps_text_deltas() {
    let line = serde_json::json!({ "type": "message_update", "assistantMessageEvent": { "type": "text_delta", "delta": "Hello" } });
    match crate::map_rpc_event(&line, None).unwrap() {
        crate::OrbitronAgentEvent::Message { text, done, role } => {
            assert_eq!(text, "Hello");
            assert!(!done, "a delta appends to the open bubble");
            assert_eq!(role, "assistant");
        }
        other => panic!("{other:?}"),
    }
}

// `text_end` repeats the whole message; forwarding it would print every reply twice.
#[test]
fn orbitron_event_mapper_opens_a_bubble_on_text_start_and_ignores_text_end() {
    let start = serde_json::json!({ "type": "message_update", "assistantMessageEvent": { "type": "text_start" } });
    match crate::map_rpc_event(&start, None).unwrap() {
        crate::OrbitronAgentEvent::Message { text, done, .. } => {
            assert_eq!(text, "");
            assert!(done);
        }
        other => panic!("{other:?}"),
    }
    let end = serde_json::json!({ "type": "message_update", "assistantMessageEvent": { "type": "text_end", "content": "Hello" } });
    assert!(crate::map_rpc_event(&end, None).is_none());
}

// `isTerminal: false` means the session will resume; calling it Idle re-enables a composer
// whose next plain `prompt` would be rejected for arriving mid-stream.
#[test]
fn orbitron_non_terminal_agent_end_is_not_idle() {
    let line = serde_json::json!({ "type": "agent_end", "isTerminal": false });
    assert!(crate::map_rpc_event(&line, None).is_none());
    let terminal = serde_json::json!({ "type": "agent_end", "isTerminal": true });
    assert!(crate::map_rpc_event(&terminal, None).is_some());
}

#[test]
fn orbitron_event_mapper_status_words() {
    let compacting = crate::map_rpc_event(&serde_json::json!({ "type": "auto_compaction_start" }), None).unwrap();
    let thinking = crate::map_rpc_event(&serde_json::json!({ "type": "agent_start" }), None).unwrap();
    let idle = crate::map_rpc_event(&serde_json::json!({ "type": "agent_end" }), None).unwrap();
    let updating = crate::map_rpc_event(&serde_json::json!({ "type": "host_tool_call", "toolName": "concept_create" }), None).unwrap();
    assert!(matches!(
        compacting,
        crate::OrbitronAgentEvent::Status {
            status: crate::OrbitronAgentStatus::Compacting
        }
    ));
    assert!(matches!(
        thinking,
        crate::OrbitronAgentEvent::Status {
            status: crate::OrbitronAgentStatus::Thinking
        }
    ));
    assert!(matches!(
        idle,
        crate::OrbitronAgentEvent::Status {
            status: crate::OrbitronAgentStatus::Idle
        }
    ));
    assert!(matches!(
        updating,
        crate::OrbitronAgentEvent::Status {
            status: crate::OrbitronAgentStatus::UpdatingBoard
        }
    ));
}

#[test]
fn orbitron_sanitize_redacts_stored_key() {
    assert_eq!(crate::sanitize_text("use sk-live now", Some("sk-live")), "use *** now");
}

#[test]
fn orbitron_sanitize_redacts_xai_api_key_eq() {
    let out = crate::sanitize_text("XAI_API_KEY=sk-leak", None);
    assert!(!out.contains("XAI_API_KEY="));
}

#[test]
fn orbitron_bootstrap_does_not_set_thinking_level() {
    let lines = format!("{}{}", crate::bootstrap_negotiate(), crate::bootstrap_set_model());
    assert!(!lines.contains("set_thinking_level"));
}

fn hold_write(agent: &crate::ManagedOrbitronAgent, id: &str) {
    *agent.rt.pending_write_id.lock().unwrap_or_else(|e| e.into_inner()) = Some(id.into());
}

#[test]
fn second_mutating_host_tool_call_is_rejected() {
    let agent = fake_agent(&PathBuf::from("/tmp/r"), 1, 1);
    hold_write(&agent, "host_1");
    assert_eq!(crate::reject_second_write(&agent.rt, true), Some("Another board change is waiting."));
}

#[test]
fn board_get_may_run_while_a_write_is_held() {
    let agent = fake_agent(&PathBuf::from("/tmp/r"), 1, 1);
    hold_write(&agent, "host_1");
    assert_eq!(crate::reject_second_write(&agent.rt, false), None);
}

#[test]
fn set_model_failure_is_product_copy() {
    match crate::set_model_failure_event("…sk-live…") {
        crate::OrbitronAgentEvent::Error { message } => {
            assert_eq!(message, "Couldn't sign in to xAI. Check the API key.");
            assert!(!message.contains("sk-live"));
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn orbitron_host_tool_schemas_have_no_geometry_properties() {
    for schema in crate::host_tool_schemas(crate::CanvasEditMode::AutoEdit) {
        // `parameters`, not `inputSchema`: the MCP spelling registers the tool with no
        // arguments at all, so the agent can only ever call it wrong.
        let props = schema["parameters"]["properties"].as_object().unwrap();
        for bad in ["x", "y", "w", "h", "camX", "camY", "scale"] {
            assert!(!props.contains_key(bad), "{bad} in {}", schema["name"]);
        }
    }
}

// A widget request nobody answers stalls the turn forever: this is the difference between
// a reply in seconds and a chat that sits on "Thinking…".
#[test]
fn orbitron_extension_ui_is_dismissed_by_id() {
    let line = crate::cancel_extension_ui("ui_7");
    assert_eq!(line["type"], "extension_ui_response");
    assert_eq!(line["id"], "ui_7");
    assert_eq!(line["cancelled"], true);
}

// The host tool is correlated by the RPC call id, and the model reads text content.
#[test]
fn orbitron_host_tool_result_is_text_content_keyed_by_call_id() {
    let ok = crate::host_tool_result_line("host_3", &serde_json::json!({ "concepts": [] }), false);
    assert_eq!(ok["type"], "host_tool_result");
    assert_eq!(ok["id"], "host_3");
    assert_eq!(ok["result"]["content"][0]["type"], "text");
    assert_eq!(ok["result"]["content"][0]["text"], "{\"concepts\":[]}");
    assert!(ok.get("isError").is_none());
    let rejected = crate::host_tool_result_line("host_3", &serde_json::json!("Rejected."), true);
    assert_eq!(rejected["result"]["content"][0]["text"], "Rejected.", "a string result is not re-quoted");
    assert_eq!(rejected["isError"], true);
}

#[test]
fn orbitron_frame_decoder_passes_plain_frames_through() {
    let mut decoder = crate::RpcFrameDecoder::default();
    let frame = decoder.feed(serde_json::json!({ "type": "agent_start" })).unwrap().unwrap();
    assert_eq!(frame["type"], "agent_start");
}

#[test]
fn orbitron_frame_decoder_reassembles_chunks() {
    let payload = serde_json::json!({ "type": "agent_end", "messages": ["a", "b"] }).to_string();
    let bytes = payload.as_bytes();
    let split = bytes.len() / 2;
    let mut decoder = crate::RpcFrameDecoder::default();
    let chunk =
        |index: usize, data: &[u8]| serde_json::json!({ "type": "rpc_chunk", "chunkId": "rpc-1", "index": index, "count": 2, "byteLength": bytes.len(), "data": b64(data) });
    assert!(decoder.feed(chunk(0, &bytes[..split])).unwrap().is_none());
    let done = decoder.feed(chunk(1, &bytes[split..])).unwrap().unwrap();
    assert_eq!(done["type"], "agent_end");
    assert_eq!(done["messages"][1], "b");
}

// A frame that arrives mid-sequence means a chunk was lost. Concatenating it anyway would
// hand the reader a corrupt object built from two different frames.
#[test]
fn orbitron_frame_decoder_rejects_an_interrupted_sequence() {
    let mut decoder = crate::RpcFrameDecoder::default();
    let head = serde_json::json!({ "type": "rpc_chunk", "chunkId": "rpc-1", "index": 0, "count": 2, "byteLength": 8, "data": b64(b"1234") });
    assert!(decoder.feed(head).unwrap().is_none());
    assert!(decoder.feed(serde_json::json!({ "type": "agent_start" })).is_err());
    // …and the decoder is usable again afterwards.
    assert!(decoder.feed(serde_json::json!({ "type": "agent_start" })).unwrap().is_some());
}

fn b64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for group in bytes.chunks(3) {
        let b = [group[0], *group.get(1).unwrap_or(&0), *group.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= group.len() {
                out.push(ALPHABET[((n >> (18 - 6 * i)) & 0x3F) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[test]
fn detached_mutating_host_tool_is_board_isnt_open() {
    assert_eq!(
        crate::detached_write_error(false, false),
        Some("The board isn't open. Return to Orbitron View to apply board changes.")
    );
    assert_eq!(crate::detached_write_error(true, false), None, "the board is open, the call just is not held");
    assert_eq!(crate::detached_write_error(false, true), None, "a held call is answerable even after the view closed");
}

#[test]
fn start_without_flock_is_repo_busy() {
    let owner = AppState::default();
    let guest = AppState::default();
    let repo = std::env::temp_dir().join(format!("saga-orbitron-busy-{}", std::process::id()));
    fs::create_dir_all(repo.join(".alinery")).unwrap();
    assert!(owner.claim_repo(&repo));
    let err = crate::require_repo_owned(&guest, &repo).expect_err("guest");
    assert!(err.contains("repo-busy"));
    let _ = fs::remove_dir_all(&repo);
}
