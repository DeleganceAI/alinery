//! The host service wire against the bytes protobuf-es writes from `proto/alinery/v1/host.proto` (`bun proto/golden.ts`).
//! A field renumbered or retyped in `host_wire.rs` changes the bytes and fails here naming the message.

use crate::host_wire::*;
use prost::Message;
use serde_json::json;
use std::io::Cursor;
use std::path::Path;

fn golden(name: &str) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../proto/golden/host.json");
    let fixtures: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap();
    let hex = fixtures[name].as_str().unwrap_or_else(|| panic!("{name} is missing from {}", path.display()));
    (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
}

/// What `into_call` makes for `op`, as the request protobuf-es wrote for the same call.
fn assert_request(name: &str, id: u64, op: HostOp) {
    let bytes = golden(name);
    let mut call = op.into_call();
    // The golden file was written with a fixed app version; the shell sends its own.
    if let host_request::Call::SpawnDaemon(spawn) = &mut call {
        assert_eq!(spawn.app_version, env!("CARGO_PKG_VERSION"), "{name}: the app version travels with the spawn");
        spawn.app_version = "0.26.0".into();
        assert_eq!(spawn.started_by, alinery_core::started_by_label(), "{name}: this app's label travels with the spawn");
        spawn.started_by = "nyx on MacBook".into();
    }
    let ours = HostRequest { id, call: Some(call) };
    assert_eq!(ours.encode_to_vec(), bytes, "{name}: our bytes differ from protobuf-es");
    assert_eq!(HostRequest::decode(bytes.as_slice()).unwrap(), ours, "{name}: protobuf-es bytes decode to something else");
}

#[test]
fn every_request_matches_the_bytes_protobuf_es_wrote() {
    let p = |s: &str| Path::new(s).to_path_buf();
    assert_request("request.ping", 1, HostOp::Ping);
    assert_request("request.claim_repo", 2, HostOp::ClaimRepo { repo: p("/srv/claim") });
    assert_request("request.release_repo", 3, HostOp::ReleaseRepo { repo: p("/srv/release") });
    assert_request("request.classify", 4, HostOp::Classify { path: p("/srv/classify") });
    assert_request("request.init", 5, HostOp::Init { path: p("/srv/init") });
    assert_request(
        "request.list_dir",
        6,
        HostOp::ListDir {
            path: p("/srv/list"),
            show_hidden: true,
        },
    );
    assert_request(
        "request.write_file",
        7,
        HostOp::WriteFile {
            path: p("/srv/c/app.toml"),
            contents: "x = 1\n".into(),
        },
    );
    assert_request(
        "request.sync_credentials",
        8,
        HostOp::SyncCredentials {
            path: p("/srv/c/creds.json"),
            set: serde_json::Map::from_iter([("anthropic".to_string(), json!({"type": "api_key"}))]),
            remove: vec!["old".into()],
            erase_oauth: true,
        },
    );
    assert_request("request.remove_file", 9, HostOp::RemoveFile { path: p("/srv/c/inference.json") });
    assert_request(
        "request.backup_verify",
        10,
        HostOp::BackupVerify {
            repo: p("/srv/verify"),
            backup_path: p("/srv/b/verify.zip"),
        },
    );
    assert_request(
        "request.backup_restore",
        11,
        HostOp::BackupRestore {
            repo: p("/srv/restore"),
            backup_path: p("/srv/b/restore.zip"),
        },
    );
    assert_request("request.wait_daemon_gone", 12, HostOp::WaitDaemonGone { repo: p("/srv/gone") });
    assert_request(
        "request.spawn_daemon",
        13,
        HostOp::SpawnDaemon {
            repo: p("/srv/spawn"),
            app_config: p("/srv/c/app.toml"),
            binary: p("/srv/rt/alinery-vinculum-daemon"),
            build_id: "abc123".into(),
            namespace: Some("dev".into()),
            log: p("/srv/c/logs/d.log"),
            launch: Launch::SystemdRun,
            unit: Some("alinery-daemon-abc".into()),
            rpc_secret_file: Some(p("/srv/c/rpc-secrets/a.rpc")),
        },
    );
    assert_request("request.list_daemons", 14, HostOp::ListDaemons);
}

#[test]
fn a_spawn_with_nothing_optional_sends_empty_strings_the_service_leaves_out() {
    let call = HostOp::SpawnDaemon {
        repo: "/r".into(),
        app_config: "/c".into(),
        binary: "/b".into(),
        build_id: "h".into(),
        namespace: None,
        log: "/l".into(),
        launch: Launch::Direct,
        unit: None,
        rpc_secret_file: None,
    }
    .into_call();
    let host_request::Call::SpawnDaemon(spawn) = call else { panic!("not a spawn") };
    assert_eq!((spawn.namespace.as_str(), spawn.unit.as_str(), spawn.rpc_secret_file.as_str()), ("", "", ""));
    assert_eq!(spawn.launch, Launch::Direct as i32);
}

fn reply(name: &str) -> HostReply {
    HostReply::decode(golden(name).as_slice()).unwrap_or_else(|e| panic!("{name}: {e}"))
}

#[test]
fn every_reply_decodes_field_by_field_and_encodes_back_to_the_same_bytes() {
    for name in [
        "reply.error",
        "reply.hello",
        "reply.done",
        "reply.claim",
        "reply.folder",
        "reply.init",
        "reply.listing",
        "reply.erased",
        "reply.daemons",
    ] {
        assert_eq!(reply(name).encode_to_vec(), golden(name), "{name}");
    }
    assert_eq!(
        reply("reply.error"),
        HostReply {
            id: 21,
            body: Some(host_reply::Body::Error("no such folder".into()))
        }
    );
    let host_reply::Body::Hello(hello) = reply("reply.hello").body.unwrap() else {
        panic!("not a hello")
    };
    assert_eq!((hello.runtime.as_str(), hello.pid), ("0.26.0", 4242));
    assert_eq!(reply("reply.hello").id, HELLO_ID);
    let host_reply::Body::Folder(folder) = reply("reply.folder").body.unwrap() else {
        panic!("not a folder")
    };
    assert_eq!(
        (folder.kind, folder.path.as_str(), folder.message.as_str()),
        (FolderKind::Refused as i32, "/srv/folder", "not a work tree")
    );
    let host_reply::Body::Init(init) = reply("reply.init").body.unwrap() else {
        panic!("not an init")
    };
    assert_eq!((init.kind, init.root.as_str()), (InitKind::AlreadyCheckout as i32, "/srv/root"));
    let host_reply::Body::Listing(listing) = reply("reply.listing").body.unwrap() else {
        panic!("not a listing")
    };
    assert_eq!(listing.path, "/srv/home");
    assert!(listing.truncated);
    assert_eq!(
        listing.entries,
        vec![
            HostListingEntry {
                name: "alpha".into(),
                git: true,
                symlink: false
            },
            HostListingEntry {
                name: "beta".into(),
                git: false,
                symlink: true
            },
        ]
    );
}

#[test]
fn replies_become_the_json_the_page_and_the_callers_read() {
    assert_eq!(reply_value(reply("reply.done")), Ok(serde_json::Value::Null));
    assert_eq!(reply_value(reply("reply.error")), Err("no such folder".to_string()));
    assert_eq!(reply_value(reply("reply.claim")), Ok(json!({"claimed": true})));
    assert_eq!(reply_value(reply("reply.folder")), Ok(json!({"kind": "refused", "message": "not a work tree"})));
    assert_eq!(reply_value(reply("reply.init")), Ok(json!({"kind": "already_checkout", "root": "/srv/root"})));
    assert_eq!(reply_value(reply("reply.erased")), Ok(json!(["codex", "openai"])));
    assert_eq!(
        reply_value(reply("reply.daemons")),
        Ok(
            json!([{"repo": "/srv/app", "lane": "dev", "pid": 4243, "os_user": "dev", "started_by": "jon on Strix", "started_at_ms": 1_700_000_000_456_i64, "version": "0.600.0", "protocol": 42}])
        )
    );
    assert_eq!(
        reply_value(reply("reply.listing")),
        Ok(json!({
            "path": "/srv/home",
            "entries": [
                {"name": "alpha", "git": true, "symlink": false},
                {"name": "beta", "git": false, "symlink": true},
            ],
            "truncated": true,
        }))
    );
    // The two folder kinds the page matches on, and what a reply with no body or an unknown kind is.
    let folder = |kind: FolderKind, path: &str| HostReply {
        id: 1,
        body: Some(host_reply::Body::Folder(HostFolderReply {
            kind: kind as i32,
            path: path.into(),
            message: String::new(),
        })),
    };
    assert_eq!(reply_value(folder(FolderKind::Checkout, "/a")), Ok(json!({"kind": "checkout", "root": "/a"})));
    assert_eq!(reply_value(folder(FolderKind::Absent, "/b")), Ok(json!({"kind": "absent", "path": "/b"})));
    assert!(reply_value(folder(FolderKind::Unspecified, "/c")).is_err());
    assert!(reply_value(HostReply { id: 1, body: None }).is_err());
}

#[test]
fn a_frame_is_a_big_endian_length_and_the_message() {
    let bytes = encode_request(7, HostOp::Ping);
    let message = HostRequest {
        id: 7,
        call: Some(HostOp::Ping.into_call()),
    }
    .encode_to_vec();
    assert_eq!(&bytes[..4], &(message.len() as u32).to_be_bytes());
    assert_eq!(&bytes[4..], message.as_slice());
    assert_eq!(read_frame(&mut Cursor::new(bytes)).unwrap(), message);
}

#[test]
fn the_reader_skips_what_a_login_shell_printed_before_the_marker() {
    let mut stream = Vec::new();
    stream.extend_from_slice(b"Welcome to a host\n\xff\xfe not utf-8\r\n");
    stream.extend_from_slice(format!("{MARKER}\n").as_bytes());
    stream.extend_from_slice(&frame(b"one"));
    stream.extend_from_slice(&frame(b""));
    let mut input = Cursor::new(stream);
    assert!(skip_to_marker(&mut input));
    assert_eq!(read_frame(&mut input).unwrap(), b"one");
    assert_eq!(read_frame(&mut input).unwrap(), b"");
    assert_eq!(read_frame(&mut input), None, "the end of the stream ends the frames");
}

#[test]
fn a_stream_with_no_marker_is_not_the_service() {
    assert!(!skip_to_marker(&mut Cursor::new(b"just a shell\nprinting things\n".to_vec())));
    // A marker with something after it on the same line is shell output, not the line.
    assert!(!skip_to_marker(&mut Cursor::new(format!("{MARKER} extra\n").into_bytes())));
    let noise = vec![b'x'; 2 * 1024 * 1024];
    let mut long = noise.clone();
    long.push(b'\n');
    long.extend_from_slice(format!("{MARKER}\n").as_bytes());
    assert!(!skip_to_marker(&mut Cursor::new(long)), "noise past the limit gives the host up");
}

#[test]
fn a_length_over_the_limit_or_a_cut_off_frame_ends_the_stream() {
    let too_long = ((MAX_FRAME + 1) as u32).to_be_bytes().to_vec();
    assert_eq!(read_frame(&mut Cursor::new(too_long)), None);
    let mut cut = 10u32.to_be_bytes().to_vec();
    cut.extend_from_slice(b"short");
    assert_eq!(read_frame(&mut Cursor::new(cut)), None);
}

/// The Rust channel against the real TypeScript service over real pipes: no ssh, the same bytes. Needs `bun` (check.sh has it).
mod against_the_service {
    use super::*;
    use crate::remote::{HostChannel, DISCONNECTED};
    use std::process::{Command, Stdio};
    use std::time::Duration;

    fn service() -> HostChannel {
        let main = Path::new(env!("CARGO_MANIFEST_DIR")).join("vinculum-daemon/src/main.ts");
        let child = Command::new("bun")
            .arg(main)
            .args(["--host-service", "--app-version", "1.2.3"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("bun must be on PATH to run the daemon's tests (check.sh puts it there)");
        HostChannel::attach(child).unwrap()
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ai-hw-{name}-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    const T: Duration = Duration::from_secs(30);

    #[test]
    fn every_host_call_the_shell_makes_gets_the_answer_it_reads() {
        let channel = service();
        let root = temp_dir("calls");
        assert_eq!(channel.call(HostOp::Ping, T), Ok(serde_json::Value::Null));

        // Browse, classify, initialize.
        std::fs::create_dir_all(root.join("proj")).unwrap();
        std::fs::create_dir_all(root.join("other/.git")).unwrap();
        let listing = channel
            .call(
                HostOp::ListDir {
                    path: root.clone(),
                    show_hidden: false,
                },
                T,
            )
            .unwrap();
        assert_eq!(
            listing["entries"],
            json!([{"name": "other", "git": true, "symlink": false}, {"name": "proj", "git": false, "symlink": false}])
        );
        let proj = root.join("proj");
        assert_eq!(channel.call(HostOp::Classify { path: proj.clone() }, T).unwrap(), json!({"kind": "absent", "path": proj}));
        assert_eq!(channel.call(HostOp::Init { path: proj.clone() }, T).unwrap(), json!({"kind": "initialized", "root": proj}));
        assert_eq!(channel.call(HostOp::Classify { path: proj.clone() }, T).unwrap(), json!({"kind": "checkout", "root": proj}));
        let error = channel.call(HostOp::Classify { path: root.join("missing") }, T).unwrap_err();
        assert!(error.contains("folder does not exist"), "{error}");

        // Write, merge credentials, remove.
        let creds = root.join("c/provider-credentials.json");
        channel
            .call(
                HostOp::WriteFile {
                    path: root.join("c/app.toml"),
                    contents: "a = 1\n".into(),
                },
                T,
            )
            .unwrap();
        assert_eq!(std::fs::read_to_string(root.join("c/app.toml")).unwrap(), "a = 1\n");
        std::fs::write(&creds, r#"{"codex":{"type":"oauth","refresh":"r"}}"#).unwrap();
        let erased = channel
            .call(
                HostOp::SyncCredentials {
                    path: creds.clone(),
                    set: serde_json::Map::from_iter([("anthropic".to_string(), json!({"type": "api_key", "key": "k"}))]),
                    remove: vec![],
                    erase_oauth: true,
                },
                T,
            )
            .unwrap();
        assert_eq!(erased, json!(["codex"]));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&std::fs::read_to_string(&creds).unwrap()).unwrap(),
            json!({"anthropic": {"type": "api_key", "key": "k"}})
        );
        channel.call(HostOp::RemoveFile { path: creds.clone() }, T).unwrap();
        assert!(!creds.exists());
        channel.call(HostOp::RemoveFile { path: creds }, T).unwrap();
    }

    #[test]
    fn a_second_claimant_is_told_the_repo_is_busy_until_the_first_channel_closes() {
        let repo = temp_dir("claim");
        let first = service();
        let second = service();
        assert_eq!(first.call(HostOp::ClaimRepo { repo: repo.clone() }, T).unwrap(), json!({"claimed": true}));
        assert_eq!(second.call(HostOp::ClaimRepo { repo: repo.clone() }, T).unwrap(), json!({"claimed": false}));
        first.call(HostOp::ReleaseRepo { repo: repo.clone() }, T).unwrap();
        assert_eq!(second.call(HostOp::ClaimRepo { repo: repo.clone() }, T).unwrap(), json!({"claimed": true}));
        // Dropping a channel ends the service, which is how a dead ssh session lets go of its repos.
        drop(second);
        let third = service();
        let mut claimed = false;
        for _ in 0..100 {
            if third.call(HostOp::ClaimRepo { repo: repo.clone() }, T).unwrap() == json!({"claimed": true}) {
                claimed = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(claimed, "the lock went with the dropped channel");
    }

    #[test]
    fn a_dead_service_is_reported_as_a_disconnect_not_a_timeout() {
        let channel = service();
        // Kill the child behind the channel's back, the way a dropped ssh session ends it.
        channel.kill_for_test();
        let mut error = String::new();
        for _ in 0..100 {
            match channel.call(HostOp::Ping, Duration::from_secs(5)) {
                Err(e) => {
                    error = e;
                    break;
                }
                Ok(_) => std::thread::sleep(Duration::from_millis(50)),
            }
        }
        assert_eq!(error, DISCONNECTED);
    }
}
