//! The typed request/reply wire for repo-file operations, run in-process for a local repo and
//! over a long-lived ssh stdio channel (hosted by `alinery-mcp --repo-service`) for a remote one.
//!
//! This is deliberately not daemon wire: the tag is `call`, not `op`, and it is always built
//! with serde. The runtime that serves it is installed by content hash beside the daemon, so it
//! always matches the app's build and needs no `PROTOCOL_VERSION`.
//!
//! Only host-level operations exist so far. Repo operations join `RepoOp` as their command
//! bodies move here from the app crate.

use crate::git::{classify_folder, init_absent_folder};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Directory listings stop here so a huge directory cannot stall the browse dialog.
pub const LIST_DIR_CAP: usize = 2000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "call", rename_all = "snake_case")]
pub enum RepoOp {
    Ping,
    /// Hold `<repo>/.alinery/.alinery-app.lock` for the life of the service process, as
    /// `claim_repo` does locally. Served only by the long-lived service host: the lock must
    /// outlive the call, and the kernel releases it when the ssh channel dies.
    ClaimRepo {
        repo: PathBuf,
    },
    ReleaseRepo {
        repo: PathBuf,
    },
    Classify {
        path: PathBuf,
    },
    Init {
        path: PathBuf,
    },
    ListDir {
        path: PathBuf,
        #[serde(default)]
        show_hidden: bool,
    },
    /// Atomic, owner-only write (parent directories are created).
    WriteFile {
        path: PathBuf,
        contents: String,
    },
    /// Merge the Mac's provider credentials into the store at `path`; the reply holds the
    /// providers where this side is strictly newer. See `credential_sync`.
    SyncCredentials {
        path: PathBuf,
        entries: serde_json::Map<String, Value>,
    },
    /// Start the daemon detached so it outlives the ssh session that asked.
    SpawnDaemon {
        repo: PathBuf,
        app_config: PathBuf,
        binary: PathBuf,
        build_id: String,
        #[serde(default)]
        namespace: Option<String>,
        #[serde(default)]
        ownership_lib: Option<PathBuf>,
        log: PathBuf,
        launch: Launch,
        /// systemd unit name; required for `SystemdRun`.
        #[serde(default)]
        unit: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Launch {
    /// `daemon_command` already `setsid`s the child.
    Direct,
    /// A transient user unit: survives logout only when the user is lingering.
    SystemdRun,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoRequest {
    pub id: u64,
    #[serde(flatten)]
    pub op: RepoOp,
}

/// Exactly one of `ok` / `err`. An enum, not two `Option`s: a successful reply with no payload
/// is `"ok":null`, which an `Option<Value>` reads back as absent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ReplyBody {
    Ok { ok: Value },
    Err { err: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoReply {
    pub id: u64,
    #[serde(flatten)]
    pub body: ReplyBody,
}

impl RepoReply {
    pub fn new(id: u64, result: Result<Value, String>) -> Self {
        let body = match result {
            Ok(ok) => ReplyBody::Ok { ok },
            Err(err) => ReplyBody::Err { err },
        };
        Self { id, body }
    }

    pub fn into_result(self) -> Result<Value, String> {
        match self.body {
            ReplyBody::Ok { ok } => Ok(ok),
            ReplyBody::Err { err } => Err(err),
        }
    }
}

/// The service sends its `Hello` unsolicited as the first reply, under this id, so the client
/// can tell the service from shell rc noise on the same stdout. Requests use ids from 1.
pub const HELLO_ID: u64 = 0;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hello {
    /// The service binary's package version; the content-hashed install makes it the app's own.
    pub runtime: String,
    pub pid: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirEntry {
    pub name: String,
    pub git: bool,
    pub symlink: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirListing {
    pub path: PathBuf,
    pub entries: Vec<DirEntry>,
    pub truncated: bool,
}

/// Subdirectories of `path`, sorted by name. Files are not listed: this feeds a folder picker.
pub fn list_dir(path: &Path, show_hidden: bool) -> Result<DirListing, String> {
    let read = std::fs::read_dir(path).map_err(|error| format!("read {}: {error}", path.display()))?;
    let mut entries = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !show_hidden && name.starts_with('.') {
            continue;
        }
        let full = entry.path();
        if !full.is_dir() {
            continue;
        }
        let symlink = entry.file_type().map(|kind| kind.is_symlink()).unwrap_or(false);
        entries.push(DirEntry {
            git: full.join(".git").exists(),
            name,
            symlink,
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    let truncated = entries.len() > LIST_DIR_CAP;
    entries.truncate(LIST_DIR_CAP);
    Ok(DirListing {
        path: path.to_path_buf(),
        entries,
        truncated,
    })
}

pub fn run(op: RepoOp) -> Result<Value, String> {
    match op {
        RepoOp::Ping => Ok(Value::Null),
        RepoOp::ClaimRepo { .. } | RepoOp::ReleaseRepo { .. } => Err("repo claims are held by the repo service host process".to_string()),
        RepoOp::Classify { path } => to_value(classify_folder(&path)?),
        RepoOp::Init { path } => to_value(init_absent_folder(&path)?),
        RepoOp::ListDir { path, show_hidden } => to_value(list_dir(&path, show_hidden)?),
        RepoOp::WriteFile { path, contents } => write_file(&path, &contents).map(|()| Value::Null),
        RepoOp::SyncCredentials { path, entries } => to_value(crate::credential_sync::apply_incoming(&path, &entries)?),
        RepoOp::SpawnDaemon {
            repo,
            app_config,
            binary,
            build_id,
            namespace,
            ownership_lib,
            log,
            launch,
            unit,
        } => spawn_daemon(
            &repo,
            &app_config,
            &binary,
            &build_id,
            namespace.as_deref(),
            ownership_lib.as_deref(),
            &log,
            launch,
            unit.as_deref(),
        )
        .map(|()| Value::Null),
    }
}

fn write_file(path: &Path, contents: &str) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|error| format!("create {}: {error}", parent.display()))?;
    crate::write_owner_only_bytes(path, contents.as_bytes())
}

#[allow(clippy::too_many_arguments)]
fn spawn_daemon(
    repo: &Path,
    app_config: &Path,
    binary: &Path,
    build_id: &str,
    namespace: Option<&str>,
    ownership_lib: Option<&Path>,
    log: &Path,
    launch: Launch,
    unit: Option<&str>,
) -> Result<(), String> {
    use std::process::{Command, Stdio};
    if let Some(parent) = log.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("create {}: {error}", parent.display()))?;
    }
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
        .map_err(|error| format!("open {}: {error}", log.display()))?;
    let log_again = log_file.try_clone().map_err(|error| error.to_string())?;
    let mut daemon = crate::daemon_command(binary, repo, app_config, build_id.as_ref(), namespace, None);
    if let Some(library) = ownership_lib {
        daemon.env("ALINERY_OWNERSHIP_LIB", library);
    }
    daemon.stdout(log_file).stderr(log_again);
    match launch {
        Launch::Direct => {
            let mut child = daemon.spawn().map_err(|error| format!("spawn {}: {error}", binary.display()))?;
            // Reap it if it exits early; a daemon that lives on is not waited for.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            Ok(())
        }
        Launch::SystemdRun => {
            let unit = unit.ok_or("systemd_run needs a unit name")?;
            let mut run = Command::new("systemd-run");
            run.args(["--user", "--collect", "--quiet"])
                .arg(format!("--unit={unit}"))
                .arg(format!("--working-directory={}", repo.display()));
            for (key, value) in daemon.get_envs() {
                if let Some(value) = value {
                    run.arg(format!("--setenv={}={}", key.to_string_lossy(), value.to_string_lossy()));
                }
            }
            run.arg("--").arg(daemon.get_program()).args(daemon.get_args());
            let output = run.stdin(Stdio::null()).output().map_err(|error| format!("systemd-run: {error}"))?;
            output
                .status
                .success()
                .then_some(())
                .ok_or_else(|| format!("systemd-run failed: {}", String::from_utf8_lossy(&output.stderr).trim()))
        }
    }
}

fn to_value<T: Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ai-rs-{name}-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn every_op_round_trips_through_the_wire() {
        let ops = [
            RepoOp::Ping,
            RepoOp::ClaimRepo { repo: "/srv/a".into() },
            RepoOp::ReleaseRepo { repo: "/srv/a".into() },
            RepoOp::Classify { path: "/srv/a".into() },
            RepoOp::Init { path: "/srv/a".into() },
            RepoOp::ListDir {
                path: "/srv".into(),
                show_hidden: true,
            },
            RepoOp::WriteFile {
                path: "/srv/a/app.toml".into(),
                contents: "x=1\n".into(),
            },
            RepoOp::SyncCredentials {
                path: "/srv/c.json".into(),
                entries: serde_json::Map::from_iter([("p".to_string(), serde_json::json!({"expires": 1}))]),
            },
            RepoOp::SpawnDaemon {
                repo: "/srv/a".into(),
                app_config: "/srv/c/app.toml".into(),
                binary: "/srv/rt/d".into(),
                build_id: "abc".into(),
                namespace: Some("dev".into()),
                ownership_lib: Some("/srv/rt/lib.so".into()),
                log: "/srv/c/logs/d.log".into(),
                launch: Launch::SystemdRun,
                unit: Some("alinery-daemon-abc".into()),
            },
        ];
        for (id, op) in ops.into_iter().enumerate() {
            let request = RepoRequest { id: id as u64, op };
            let line = serde_json::to_string(&request).unwrap();
            assert!(line.contains("\"call\""), "{line}");
            assert!(!line.contains("\"op\""), "{line}");
            assert_eq!(serde_json::from_str::<RepoRequest>(&line).unwrap(), request);
        }
    }

    #[test]
    fn list_dir_defaults_to_hiding_dotfolders() {
        let line = r#"{"id":1,"call":"list_dir","path":"/srv"}"#;
        let request: RepoRequest = serde_json::from_str(line).unwrap();
        assert_eq!(
            request.op,
            RepoOp::ListDir {
                path: "/srv".into(),
                show_hidden: false
            }
        );
    }

    #[test]
    fn reply_carries_exactly_one_side() {
        let ok = RepoReply::new(7, Ok(Value::Bool(true)));
        assert_eq!(serde_json::to_string(&ok).unwrap(), r#"{"id":7,"ok":true}"#);
        assert_eq!(ok.into_result(), Ok(Value::Bool(true)));
        let err = RepoReply::new(8, Err("nope".into()));
        assert_eq!(serde_json::to_string(&err).unwrap(), r#"{"id":8,"err":"nope"}"#);
        assert_eq!(err.into_result(), Err("nope".into()));
        // A payload-less success is `"ok":null` and must read back as success, not as nothing.
        let unit = RepoReply::new(9, Ok(Value::Null));
        let line = serde_json::to_string(&unit).unwrap();
        assert_eq!(line, r#"{"id":9,"ok":null}"#);
        assert_eq!(serde_json::from_str::<RepoReply>(&line).unwrap().into_result(), Ok(Value::Null));
        assert!(serde_json::from_str::<RepoReply>(r#"{"id":10}"#).is_err(), "neither side is malformed");
    }

    #[test]
    fn list_dir_lists_sorted_folders_with_git_badges_and_hides_dotfolders() {
        let root = temp_dir("list");
        fs::create_dir_all(root.join("beta/.git")).unwrap();
        fs::create_dir_all(root.join("alpha")).unwrap();
        fs::create_dir_all(root.join(".hidden")).unwrap();
        fs::write(root.join("file.txt"), "x").unwrap();

        let listing = list_dir(&root, false).unwrap();
        let names: Vec<_> = listing.entries.iter().map(|entry| (entry.name.as_str(), entry.git)).collect();
        assert_eq!(names, [("alpha", false), ("beta", true)]);
        assert!(!listing.truncated);
        assert_eq!(list_dir(&root, true).unwrap().entries.len(), 3);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn write_file_creates_parents_and_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let root = temp_dir("write");
        let path = root.join("config/id/app.toml");
        run(RepoOp::WriteFile {
            path: path.clone(),
            contents: "a=1\n".into(),
        })
        .unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "a=1\n");
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sync_credentials_reports_what_the_host_holds_newer() {
        let root = temp_dir("sync");
        let path = root.join("provider-credentials.json");
        fs::write(&path, r#"{"oauth":{"expires":900}}"#).unwrap();
        let entries = serde_json::Map::from_iter([
            ("oauth".to_string(), serde_json::json!({"expires": 100})),
            ("key".to_string(), serde_json::json!({"type": "api_key"})),
        ]);
        let newer = run(RepoOp::SyncCredentials { path: path.clone(), entries }).unwrap();
        assert_eq!(newer, serde_json::json!({"oauth": {"expires": 900}}));
        assert!(fs::read_to_string(&path).unwrap().contains("api_key"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn spawn_daemon_launches_detached_with_the_shared_recipe_and_logs_output() {
        let root = temp_dir("spawn");
        let binary = root.join("fake-daemon");
        // Print the arguments and the one env var the repo service adds, then exit.
        fs::write(&binary, "#!/bin/sh\necho \"args: $*\"\necho \"lib: $ALINERY_OWNERSHIP_LIB\"\n").unwrap();
        fs::set_permissions(&binary, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let log = root.join("logs/d.log");
        run(RepoOp::SpawnDaemon {
            repo: root.join("repo"),
            app_config: root.join("app.toml"),
            binary,
            build_id: "hash1".into(),
            namespace: Some("ns".into()),
            ownership_lib: Some("/opt/lib.so".into()),
            log: log.clone(),
            launch: Launch::Direct,
            unit: None,
        })
        .unwrap();
        let mut text = String::new();
        for _ in 0..100 {
            text = fs::read_to_string(&log).unwrap_or_default();
            if text.contains("lib:") {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(text.contains("--repo"), "{text}");
        assert!(text.contains("--build-id hash1"), "{text}");
        assert!(text.contains("--socket-namespace ns"), "{text}");
        assert!(text.contains("lib: /opt/lib.so"), "{text}");
        assert!(run(RepoOp::SpawnDaemon {
            launch: Launch::SystemdRun,
            unit: None,
            repo: root.clone(),
            app_config: root.clone(),
            binary: root.clone(),
            build_id: "x".into(),
            namespace: None,
            ownership_lib: None,
            log
        })
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn run_classifies_and_reports_missing_directories() {
        let root = temp_dir("classify");
        let value = run(RepoOp::Classify { path: root.clone() }).unwrap();
        assert_eq!(value["kind"], "absent");
        assert!(run(RepoOp::ListDir {
            path: root.join("missing"),
            show_hidden: false
        })
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
