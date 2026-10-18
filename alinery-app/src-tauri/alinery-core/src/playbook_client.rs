//! Requests for the experimental playbook helper socket.
//!
//! This is not the UI protocol. The app and MCP must not hand-build `{"op":...}`
//! for this socket, and these builders stay out of `daemon_client.rs` so protocol 16
//! is unchanged.

use serde_json::{json, Value};

pub fn stop_request() -> Value {
    json!({"op":"stop"})
}

pub fn health_request() -> Value {
    json!({"op":"health"})
}

pub fn playbook_axis_request() -> Value {
    json!({"op":"playbook_axis"})
}

pub fn phase_request(task_slug: &str, session_id: &str, phase: &str, execution_id: &str, nonce: &str) -> Value {
    json!({
        "op": "phase_request",
        "task_slug": task_slug,
        "session_id": session_id,
        "phase": phase,
        "execution_id": execution_id,
        "nonce": nonce,
    })
}

pub fn grant_request(task_slug: &str, execution_id: &str, session_id: &str) -> Value {
    json!({
        "op": "grant_execution_completion",
        "request": {
            "task_slug": task_slug,
            "execution_id": execution_id,
            "session_id": session_id,
        }
    })
}

pub fn forwarded_header(op: &str, request: &Value) -> Value {
    json!({"op": op, "request": request})
}
