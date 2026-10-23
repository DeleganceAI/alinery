//! Drives the real `alinery-mcp --repo-service` binary over its stdio pipes.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

struct Service {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl Service {
    fn start() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_alinery-mcp"))
            .arg("--repo-service")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let hello = read_line(&mut stdout);
        assert_eq!(hello["id"], 0, "{hello}");
        assert_eq!(hello["ok"]["pid"], child.id(), "{hello}");
        Self { child, stdin, stdout, next_id: 1 }
    }

    fn send(&mut self, call: Value) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        let mut request = call;
        request["id"] = json!(id);
        writeln!(self.stdin.as_mut().unwrap(), "{request}").unwrap();
        id
    }

    fn call(&mut self, call: Value) -> Value {
        let id = self.send(call);
        let reply = read_line(&mut self.stdout);
        assert_eq!(reply["id"], id, "{reply}");
        reply
    }

    fn close(mut self) {
        drop(self.stdin.take());
        assert!(self.child.wait().unwrap().success());
    }
}

fn read_line(stdout: &mut BufReader<ChildStdout>) -> Value {
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    serde_json::from_str(&line).unwrap_or_else(|error| panic!("unreadable reply {line:?}: {error}"))
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ai-rsvc-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn answers_ping_list_dir_and_errors_with_the_request_id() {
    let root = temp_dir("calls");
    std::fs::create_dir_all(root.join("project/.git")).unwrap();
    let mut service = Service::start();

    assert_eq!(service.call(json!({"call": "ping"}))["ok"], Value::Null);
    let listing = service.call(json!({"call": "list_dir", "path": root}));
    assert_eq!(listing["ok"]["entries"][0], json!({"name": "project", "git": true, "symlink": false}));
    let missing = service.call(json!({"call": "list_dir", "path": root.join("nope")}));
    assert!(missing["err"].as_str().unwrap().contains("read"), "{missing}");

    service.close();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_claim_is_exclusive_across_services_and_dies_with_the_channel() {
    let repo = temp_dir("claim");
    let claim = |service: &mut Service, repo: &Path| service.call(json!({"call": "claim_repo", "repo": repo}))["ok"]["claimed"].clone();

    let mut first = Service::start();
    let mut second = Service::start();
    assert_eq!(claim(&mut first, &repo), json!(true));
    assert_eq!(claim(&mut first, &repo), json!(true), "claiming again is idempotent");
    assert_eq!(claim(&mut second, &repo), json!(false), "a second host cannot take the lock");

    // The kernel drops the flock when the first channel closes; no release call is needed.
    first.close();
    assert_eq!(claim(&mut second, &repo), json!(true));
    assert_eq!(second.call(json!({"call": "release_repo", "repo": repo}))["ok"], Value::Null);
    second.close();
    std::fs::remove_dir_all(repo).unwrap();
}
