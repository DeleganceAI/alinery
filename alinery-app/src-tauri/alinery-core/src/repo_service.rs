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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoRequest {
    pub id: u64,
    #[serde(flatten)]
    pub op: RepoOp,
}

/// Exactly one of `ok` / `err` is set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoReply {
    pub id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ok: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub err: Option<String>,
}

impl RepoReply {
    pub fn new(id: u64, result: Result<Value, String>) -> Self {
        match result {
            Ok(value) => Self { id, ok: Some(value), err: None },
            Err(error) => Self { id, ok: None, err: Some(error) },
        }
    }

    pub fn into_result(self) -> Result<Value, String> {
        match (self.ok, self.err) {
            (_, Some(error)) => Err(error),
            (Some(value), None) => Ok(value),
            (None, None) => Err("repo service reply carried neither ok nor err".to_string()),
        }
    }
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
        RepoOp::Classify { path } => to_value(classify_folder(&path)?),
        RepoOp::Init { path } => to_value(init_absent_folder(&path)?),
        RepoOp::ListDir { path, show_hidden } => to_value(list_dir(&path, show_hidden)?),
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
            RepoOp::Classify { path: "/srv/a".into() },
            RepoOp::Init { path: "/srv/a".into() },
            RepoOp::ListDir {
                path: "/srv".into(),
                show_hidden: true,
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
        assert!(RepoReply { id: 9, ok: None, err: None }.into_result().is_err());
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
