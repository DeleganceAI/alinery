//! `alinery-mcp --repo-service`: the remote half of the repo service wire (see
//! `alinery_core::repo_service`). One JSON request per stdin line, one reply per stdout line,
//! each request handled on its own thread so a slow git call never blocks a ping.
//!
//! The process is long-lived on purpose. It holds each claimed repo's GUI lock for as long as
//! the ssh channel lives, and the kernel releases the locks when the channel dies, which is
//! exactly the lifetime the local `claim_repo` has.

use alinery_core::repo_service::{self, Hello, RepoOp, RepoReply, RepoRequest, HELLO_ID};
use alinery_core::{alinery_app_lock_path, alinery_dir, try_lock_exclusive, LockFile};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

type Claims = Arc<Mutex<HashMap<PathBuf, LockFile>>>;

pub fn serve(input: impl BufRead, output: impl Write + Send + 'static) {
    let output = Arc::new(Mutex::new(output));
    let claims: Claims = Arc::default();
    let hello = Hello {
        runtime: env!("CARGO_PKG_VERSION").to_string(),
        pid: std::process::id(),
    };
    write_reply(&output, &RepoReply::new(HELLO_ID, serde_json::to_value(hello).map_err(|error| error.to_string())));

    let mut workers = Vec::new();
    for line in input.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let request = match serde_json::from_str::<RepoRequest>(&line) {
            Ok(request) => request,
            Err(error) => {
                // A request this build cannot decode (an op it does not know) still has an id the
                // client is waiting on; answer it instead of leaving the caller to time out.
                match serde_json::from_str::<Value>(&line).ok().and_then(|value| value.get("id")?.as_u64()) {
                    Some(id) => write_reply(&output, &RepoReply::new(id, Err(format!("the host's runtime does not understand this request: {error}")))),
                    None => eprintln!("repo-service: unreadable request: {error}"),
                }
                continue;
            }
        };
        let (output, claims) = (Arc::clone(&output), Arc::clone(&claims));
        workers.push(std::thread::spawn(move || {
            let result = handle(&claims, request.op);
            write_reply(&output, &RepoReply::new(request.id, result));
        }));
        workers.retain(|worker| !worker.is_finished());
    }
    for worker in workers {
        let _ = worker.join();
    }
}

fn handle(claims: &Claims, op: RepoOp) -> Result<Value, String> {
    match op {
        RepoOp::ClaimRepo { repo } => {
            let mut held = claims.lock().unwrap_or_else(|error| error.into_inner());
            if held.contains_key(&repo) {
                return Ok(json!({"claimed": true}));
            }
            std::fs::create_dir_all(alinery_dir(&repo)).map_err(|error| format!("prepare repository lock for {}: {error}", repo.display()))?;
            match try_lock_exclusive(&alinery_app_lock_path(&repo)).map_err(|error| format!("lock repository {}: {error}", repo.display()))? {
                Some(lock) => {
                    held.insert(repo, lock);
                    Ok(json!({"claimed": true}))
                }
                None => Ok(json!({"claimed": false})),
            }
        }
        RepoOp::ReleaseRepo { repo } => {
            claims.lock().unwrap_or_else(|error| error.into_inner()).remove(&repo);
            Ok(Value::Null)
        }
        other => repo_service::run(other),
    }
}

fn write_reply(output: &Arc<Mutex<impl Write>>, reply: &RepoReply) {
    let Ok(line) = serde_json::to_string(reply) else { return };
    let mut output = output.lock().unwrap_or_else(|error| error.into_inner());
    // A closed pipe means the channel died; the stdin loop ends on its own right after.
    let _ = writeln!(output, "{line}").and_then(|()| output.flush());
}
