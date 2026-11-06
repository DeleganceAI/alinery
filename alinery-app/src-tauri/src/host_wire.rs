//! The host service wire (plan S5.2, O15 b): `proto/alinery/v1/host.proto`, hand-encoded with prost like the admin messages in
//! `daemon_rpc.rs` (the shell has no generated Rust). The service is `alinery-vinculum-daemon --host-service` on the host, and
//! the bytes here are tested against what protobuf-es writes from the same file (`proto/golden/host.json`).
//!
//! Framing is `[u32 big-endian length][message]`. The service prints the line `alinery-host-service/1` first, so whatever a login
//! shell printed before it (rc-file noise) is skipped instead of being read as a length.
//!
//! This is not daemon wire and needs no `PROTOCOL_VERSION`: the runtime that serves it is installed by content hash beside the
//! daemon, so it is always this app's own build.

use prost::Message;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{BufRead, Read};
use std::path::PathBuf;

/// The line the service prints before its first frame.
pub(crate) const MARKER: &str = "alinery-host-service/1";
/// A frame longer than this is a broken stream, not a message.
pub(crate) const MAX_FRAME: usize = 64 * 1024 * 1024;
/// How much a login shell may print ahead of the marker before the host is given up on.
const MAX_NOISE: usize = 1024 * 1024;
/// The service sends its `HostHello` unprompted as the first reply, under this id. Requests use ids from 1.
pub(crate) const HELLO_ID: u64 = 0;

#[derive(Clone, PartialEq, Message)]
pub(crate) struct HostRequest {
    #[prost(uint64, tag = "1")]
    pub id: u64,
    #[prost(oneof = "host_request::Call", tags = "2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14")]
    pub call: Option<host_request::Call>,
}

pub(crate) mod host_request {
    #[derive(Clone, PartialEq, prost::Oneof)]
    pub enum Call {
        #[prost(message, tag = "2")]
        Ping(super::HostPing),
        #[prost(message, tag = "3")]
        ClaimRepo(super::HostClaimRepo),
        #[prost(message, tag = "4")]
        ReleaseRepo(super::HostReleaseRepo),
        #[prost(message, tag = "5")]
        Classify(super::HostClassify),
        #[prost(message, tag = "6")]
        Init(super::HostInit),
        #[prost(message, tag = "7")]
        ListDir(super::HostListDir),
        #[prost(message, tag = "8")]
        WriteFile(super::HostWriteFile),
        #[prost(message, tag = "9")]
        SyncCredentials(super::HostSyncCredentials),
        #[prost(message, tag = "10")]
        RemoveFile(super::HostRemoveFile),
        #[prost(message, tag = "11")]
        BackupVerify(super::HostBackupVerify),
        #[prost(message, tag = "12")]
        BackupRestore(super::HostBackupRestore),
        #[prost(message, tag = "13")]
        WaitDaemonGone(super::HostWaitDaemonGone),
        #[prost(message, tag = "14")]
        SpawnDaemon(super::HostSpawnDaemon),
    }
}

#[derive(Clone, PartialEq, Message)]
pub(crate) struct HostReply {
    #[prost(uint64, tag = "1")]
    pub id: u64,
    #[prost(oneof = "host_reply::Body", tags = "2, 3, 4, 5, 6, 7, 8, 9")]
    pub body: Option<host_reply::Body>,
}

pub(crate) mod host_reply {
    #[derive(Clone, PartialEq, prost::Oneof)]
    pub enum Body {
        #[prost(string, tag = "2")]
        Error(String),
        #[prost(message, tag = "3")]
        Hello(super::HostHello),
        #[prost(message, tag = "4")]
        Done(super::HostDone),
        #[prost(message, tag = "5")]
        Claim(super::HostClaimReply),
        #[prost(message, tag = "6")]
        Folder(super::HostFolderReply),
        #[prost(message, tag = "7")]
        Init(super::HostInitReply),
        #[prost(message, tag = "8")]
        Listing(super::HostListing),
        #[prost(message, tag = "9")]
        Erased(super::HostErased),
    }
}

#[derive(Clone, PartialEq, Message)]
pub(crate) struct HostDone {}

#[derive(Clone, PartialEq, Message)]
pub(crate) struct HostHello {
    #[prost(string, tag = "1")]
    pub runtime: String,
    #[prost(uint32, tag = "2")]
    pub pid: u32,
}

#[derive(Clone, PartialEq, Message)]
pub(crate) struct HostPing {}

#[derive(Clone, PartialEq, Message)]
pub(crate) struct HostClaimRepo {
    #[prost(string, tag = "1")]
    pub repo: String,
}

#[derive(Clone, PartialEq, Message)]
pub(crate) struct HostClaimReply {
    #[prost(bool, tag = "1")]
    pub claimed: bool,
}

#[derive(Clone, PartialEq, Message)]
pub(crate) struct HostReleaseRepo {
    #[prost(string, tag = "1")]
    pub repo: String,
}

#[derive(Clone, PartialEq, Message)]
pub(crate) struct HostClassify {
    #[prost(string, tag = "1")]
    pub path: String,
}

#[derive(Clone, PartialEq, Message)]
pub(crate) struct HostFolderReply {
    #[prost(enumeration = "FolderKind", tag = "1")]
    pub kind: i32,
    #[prost(string, tag = "2")]
    pub path: String,
    #[prost(string, tag = "3")]
    pub message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, prost::Enumeration)]
#[repr(i32)]
pub(crate) enum FolderKind {
    Unspecified = 0,
    Checkout = 1,
    Absent = 2,
    Refused = 3,
}

#[derive(Clone, PartialEq, Message)]
pub(crate) struct HostInit {
    #[prost(string, tag = "1")]
    pub path: String,
}

#[derive(Clone, PartialEq, Message)]
pub(crate) struct HostInitReply {
    #[prost(enumeration = "InitKind", tag = "1")]
    pub kind: i32,
    #[prost(string, tag = "2")]
    pub root: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, prost::Enumeration)]
#[repr(i32)]
pub(crate) enum InitKind {
    Unspecified = 0,
    Initialized = 1,
    AlreadyCheckout = 2,
}

#[derive(Clone, PartialEq, Message)]
pub(crate) struct HostListDir {
    #[prost(string, tag = "1")]
    pub path: String,
    #[prost(bool, tag = "2")]
    pub show_hidden: bool,
}

#[derive(Clone, PartialEq, Message)]
pub(crate) struct HostListing {
    #[prost(string, tag = "1")]
    pub path: String,
    #[prost(message, repeated, tag = "2")]
    pub entries: Vec<HostListingEntry>,
    #[prost(bool, tag = "3")]
    pub truncated: bool,
}

/// `HostListing.Entry` in the proto file.
#[derive(Clone, PartialEq, Message)]
pub(crate) struct HostListingEntry {
    #[prost(string, tag = "1")]
    pub name: String,
    #[prost(bool, tag = "2")]
    pub git: bool,
    #[prost(bool, tag = "3")]
    pub symlink: bool,
}

#[derive(Clone, PartialEq, Message)]
pub(crate) struct HostWriteFile {
    #[prost(string, tag = "1")]
    pub path: String,
    #[prost(string, tag = "2")]
    pub contents: String,
}

#[derive(Clone, PartialEq, Message)]
pub(crate) struct HostSyncCredentials {
    #[prost(string, tag = "1")]
    pub path: String,
    #[prost(btree_map = "string, string", tag = "2")]
    pub set: BTreeMap<String, String>,
    #[prost(string, repeated, tag = "3")]
    pub remove: Vec<String>,
    #[prost(bool, tag = "4")]
    pub erase_oauth: bool,
}

#[derive(Clone, PartialEq, Message)]
pub(crate) struct HostErased {
    #[prost(string, repeated, tag = "1")]
    pub providers: Vec<String>,
}

#[derive(Clone, PartialEq, Message)]
pub(crate) struct HostRemoveFile {
    #[prost(string, tag = "1")]
    pub path: String,
}

#[derive(Clone, PartialEq, Message)]
pub(crate) struct HostBackupVerify {
    #[prost(string, tag = "1")]
    pub repo: String,
    #[prost(string, tag = "2")]
    pub backup_path: String,
}

#[derive(Clone, PartialEq, Message)]
pub(crate) struct HostBackupRestore {
    #[prost(string, tag = "1")]
    pub repo: String,
    #[prost(string, tag = "2")]
    pub backup_path: String,
}

#[derive(Clone, PartialEq, Message)]
pub(crate) struct HostWaitDaemonGone {
    #[prost(string, tag = "1")]
    pub repo: String,
}

#[derive(Clone, PartialEq, Message)]
pub(crate) struct HostSpawnDaemon {
    #[prost(string, tag = "1")]
    pub repo: String,
    #[prost(string, tag = "2")]
    pub app_config: String,
    #[prost(string, tag = "3")]
    pub binary: String,
    #[prost(string, tag = "4")]
    pub build_id: String,
    #[prost(string, tag = "5")]
    pub namespace: String,
    #[prost(string, tag = "6")]
    pub log: String,
    #[prost(enumeration = "Launch", tag = "7")]
    pub launch: i32,
    #[prost(string, tag = "8")]
    pub unit: String,
    #[prost(string, tag = "9")]
    pub ui_secret_file: String,
    #[prost(string, tag = "10")]
    pub rpc_secret_file: String,
    #[prost(string, tag = "11")]
    pub app_version: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, prost::Enumeration)]
#[repr(i32)]
pub(crate) enum Launch {
    Unspecified = 0,
    /// A detached child.
    Direct = 1,
    /// A transient user unit: survives logout only when the user is lingering.
    SystemdRun = 2,
}

/// What the shell asks of a host, in Rust terms; `into_call` is the wire form.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum HostOp {
    /// Answered by the service with nothing; the shell has no use for it beyond the hello, so only the tests send it.
    #[cfg_attr(not(test), allow(dead_code))]
    Ping,
    /// Hold `<repo>/.alinery/.alinery-app.lock` for the life of the channel, as the local `claim_repo` does.
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
        show_hidden: bool,
    },
    /// Atomic, owner-only write (parent directories are created).
    WriteFile {
        path: PathBuf,
        contents: String,
    },
    /// Change the provider credentials at `path`: write the API keys in `set`, drop the ones in `remove`, and with
    /// `erase_oauth` drop every browser sign-in. The reply names the sign-ins erased. See `credential_sync`.
    SyncCredentials {
        path: PathBuf,
        set: serde_json::Map<String, Value>,
        remove: Vec<String>,
        erase_oauth: bool,
    },
    /// Delete a file this app wrote earlier. A missing file is not an error.
    RemoveFile {
        path: PathBuf,
    },
    /// Check that an archive belongs to the repo, before anything is stopped to restore it: a refused archive must not cost the
    /// host's live sessions.
    BackupVerify {
        repo: PathBuf,
        backup_path: PathBuf,
    },
    /// Replace the repo's curated Alinery data with an archive. The caller has stopped the daemon.
    BackupRestore {
        repo: PathBuf,
        backup_path: PathBuf,
    },
    /// Return once the repo's daemon has released its socket and process lock. It stops nothing itself.
    WaitDaemonGone {
        repo: PathBuf,
    },
    /// Start the daemon detached so it outlives the ssh session that asked.
    SpawnDaemon {
        repo: PathBuf,
        app_config: PathBuf,
        binary: PathBuf,
        build_id: String,
        namespace: Option<String>,
        log: PathBuf,
        launch: Launch,
        /// systemd unit name; required for `SystemdRun`.
        unit: Option<String>,
        /// A file holding the secret that lets the app control this daemon's UI-only ops over a forward. The daemon reads it and
        /// deletes it before it listens.
        ui_secret_file: Option<PathBuf>,
        /// The same for the RPC socket's bearer token (`--rpc-secret-file`).
        rpc_secret_file: Option<PathBuf>,
    },
}

fn text(path: &std::path::Path) -> String {
    path.to_string_lossy().into_owned()
}

impl HostOp {
    pub(crate) fn into_call(self) -> host_request::Call {
        use host_request::Call;
        match self {
            Self::Ping => Call::Ping(HostPing {}),
            Self::ClaimRepo { repo } => Call::ClaimRepo(HostClaimRepo { repo: text(&repo) }),
            Self::ReleaseRepo { repo } => Call::ReleaseRepo(HostReleaseRepo { repo: text(&repo) }),
            Self::Classify { path } => Call::Classify(HostClassify { path: text(&path) }),
            Self::Init { path } => Call::Init(HostInit { path: text(&path) }),
            Self::ListDir { path, show_hidden } => Call::ListDir(HostListDir { path: text(&path), show_hidden }),
            Self::WriteFile { path, contents } => Call::WriteFile(HostWriteFile { path: text(&path), contents }),
            Self::SyncCredentials { path, set, remove, erase_oauth } => Call::SyncCredentials(HostSyncCredentials {
                path: text(&path),
                // Each credential travels as JSON text: its shape is Pi's and is not interpreted on the way.
                set: set.into_iter().map(|(provider, credential)| (provider, credential.to_string())).collect(),
                remove,
                erase_oauth,
            }),
            Self::RemoveFile { path } => Call::RemoveFile(HostRemoveFile { path: text(&path) }),
            Self::BackupVerify { repo, backup_path } => Call::BackupVerify(HostBackupVerify {
                repo: text(&repo),
                backup_path: text(&backup_path),
            }),
            Self::BackupRestore { repo, backup_path } => Call::BackupRestore(HostBackupRestore {
                repo: text(&repo),
                backup_path: text(&backup_path),
            }),
            Self::WaitDaemonGone { repo } => Call::WaitDaemonGone(HostWaitDaemonGone { repo: text(&repo) }),
            Self::SpawnDaemon {
                repo,
                app_config,
                binary,
                build_id,
                namespace,
                log,
                launch,
                unit,
                ui_secret_file,
                rpc_secret_file,
            } => Call::SpawnDaemon(HostSpawnDaemon {
                repo: text(&repo),
                app_config: text(&app_config),
                binary: text(&binary),
                build_id,
                namespace: namespace.unwrap_or_default(),
                log: text(&log),
                launch: launch as i32,
                unit: unit.unwrap_or_default(),
                ui_secret_file: ui_secret_file.map(|file| text(&file)).unwrap_or_default(),
                rpc_secret_file: rpc_secret_file.map(|file| text(&file)).unwrap_or_default(),
                // The version a telemetry event carries (`--app-version`). All three crates moved together; this is the app's.
                app_version: env!("CARGO_PKG_VERSION").to_string(),
            }),
        }
    }
}

/// `[u32 big-endian length][HostRequest]`.
pub(crate) fn encode_request(id: u64, op: HostOp) -> Vec<u8> {
    frame(&HostRequest { id, call: Some(op.into_call()) }.encode_to_vec())
}

pub(crate) fn frame(message: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + message.len());
    out.extend_from_slice(&(message.len() as u32).to_be_bytes());
    out.extend_from_slice(message);
    out
}

/// A reply's answer in the JSON shape the page and the callers read: `Err` is the service's own sentence; success with nothing to
/// say is `null`; the rest are the objects `classify`, `init`, `list_dir` and the credential sync have always returned.
pub(crate) fn reply_value(reply: HostReply) -> Result<Value, String> {
    use host_reply::Body;
    match reply.body {
        None => Err("the host's repo service sent an empty reply".to_string()),
        Some(Body::Error(message)) => Err(message),
        Some(Body::Hello(hello)) => Ok(json!({"runtime": hello.runtime, "pid": hello.pid})),
        Some(Body::Done(_)) => Ok(Value::Null),
        Some(Body::Claim(claim)) => Ok(json!({"claimed": claim.claimed})),
        Some(Body::Folder(folder)) => match FolderKind::try_from(folder.kind) {
            Ok(FolderKind::Checkout) => Ok(json!({"kind": "checkout", "root": folder.path})),
            Ok(FolderKind::Absent) => Ok(json!({"kind": "absent", "path": folder.path})),
            Ok(FolderKind::Refused) => Ok(json!({"kind": "refused", "message": folder.message})),
            _ => Err("the host's repo service sent an unknown folder kind".to_string()),
        },
        Some(Body::Init(init)) => match InitKind::try_from(init.kind) {
            Ok(InitKind::Initialized) => Ok(json!({"kind": "initialized", "root": init.root})),
            Ok(InitKind::AlreadyCheckout) => Ok(json!({"kind": "already_checkout", "root": init.root})),
            _ => Err("the host's repo service sent an unknown init kind".to_string()),
        },
        Some(Body::Listing(listing)) => Ok(json!({
            "path": listing.path,
            "entries": listing.entries.into_iter().map(|entry| json!({"name": entry.name, "git": entry.git, "symlink": entry.symlink})).collect::<Vec<_>>(),
            "truncated": listing.truncated,
        })),
        Some(Body::Erased(erased)) => Ok(json!(erased.providers)),
    }
}

/// Skip what a login shell printed, up to the marker line. `false` when the stream ended or the noise went on past the limit.
pub(crate) fn skip_to_marker(input: &mut impl BufRead) -> bool {
    let mut seen = 0usize;
    let mut line = Vec::new();
    loop {
        line.clear();
        match input.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => return false,
            Ok(read) => {
                seen += read;
                if line.strip_suffix(b"\n").is_some_and(|text| text.strip_suffix(b"\r").unwrap_or(text) == MARKER.as_bytes()) {
                    return true;
                }
                if seen > MAX_NOISE {
                    return false;
                }
            }
        }
    }
}

/// The next frame's bytes; `None` at the end of the stream, or when the length is not a plausible message.
pub(crate) fn read_frame(input: &mut impl Read) -> Option<Vec<u8>> {
    let mut header = [0u8; 4];
    input.read_exact(&mut header).ok()?;
    let length = u32::from_be_bytes(header) as usize;
    if length > MAX_FRAME {
        return None;
    }
    let mut message = vec![0u8; length];
    input.read_exact(&mut message).ok()?;
    Some(message)
}
