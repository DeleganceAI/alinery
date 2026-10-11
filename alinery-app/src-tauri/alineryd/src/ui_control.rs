//! UI authority is tied to a kernel-authenticated Unix connection.
use super::*;
use alinery_core::daemon_client::peer_process_id;
fn executable(pid: i32) -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        let mut path = vec![0_u8; 4096];
        let length = unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
        if length <= 0 {
            return Err("UI peer executable unavailable".into());
        }
        let end = path.iter().position(|b| *b == 0).unwrap_or(length as usize);
        let path = std::str::from_utf8(&path[..end]).map_err(|e| e.to_string())?;
        fs::canonicalize(path).map_err(|e| e.to_string())
    }
    #[cfg(target_os = "linux")]
    {
        fs::canonicalize(format!("/proc/{pid}/exe")).map_err(|e| e.to_string())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = pid;
        Err("UI peer executable unsupported".into())
    }
}
pub(super) fn serve(stream: &mut UnixStream, repo: &Path, lane: &str, host: &ProtectedHost) {
    let authorize = || {
        let host = host.as_ref().as_ref().ok_or("protected UI host unavailable")?;
        let pid = peer_process_id(stream)?;
        if executable(pid)? != *host {
            return Err("UI control requires the protected UI host".into());
        }
        Ok::<_, String>(pid)
    };
    let pid = match authorize() {
        Ok(pid) => pid,
        Err(error) => {
            reply(stream, json!({"error":error}));
            return;
        }
    };
    reply(stream, json!({"ok":true}));
    // Retained backend connection may be idle between user gestures; reads are not a lease.
    let _ = stream.set_read_timeout(None);
    while let Some(line) = read_line(stream, MAX_CONTROL_HEADER_BYTES) {
        let result = (|| {
            if executable(pid)? != *host.as_ref().as_ref().ok_or("protected UI host unavailable")? {
                return Err("UI executable changed".into());
            }
            let value: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
            match value.get("op").and_then(Value::as_str) {
                Some("allow_execution_completion") => {
                    let request: alinery_core::task_creation::AllowExecutionCompletionRequest =
                        serde_json::from_value(value.get("request").cloned().ok_or("missing request")?).map_err(|e| e.to_string())?;
                    alinery_core::execution::mutate_execution_state(repo, &request.task_slug, lane, execution_config_identity(), "human completion authorization", |_, state| {
                        alinery_core::execution::grant_execution_completion(state, &request.execution_id, &request.session_id)
                    })
                }
                _ => Err("operation unavailable on UI control channel".into()),
            }
        })();
        match result {
            Ok(()) => reply(stream, json!({"ok":true})),
            Err(error) => reply(stream, json!({"error":error})),
        }
    }
}
