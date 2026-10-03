//! Tests for app_config.rs — mcp_enabled logging via write_app_config_at.
use super::*;
use crate::DaemonClient;
use std::path::PathBuf;

fn temp_app(name: &str) -> (std::path::PathBuf, std::path::PathBuf) {
    let dir = unique_attachment_temp(name);
    let path = dir.join("app.toml");
    (dir, path)
}

fn log_text(app_config: &Path) -> String {
    fs::read_to_string(alinery_core::log_path(app_config)).unwrap_or_default()
}

#[test]
fn mcp_enabled_flip_logs_once() {
    let (dir, path) = temp_app("mcp-flip");
    let mut cfg = AppConfig::default();
    crate::write_app_config_at(&path, &cfg).unwrap();
    cfg.mcp_enabled = false;
    cfg.known_repos = vec!["/tmp/example".into()];
    crate::write_app_config_at(&path, &cfg).unwrap();
    let text = log_text(&path);
    let lines: Vec<&str> = text.lines().filter(|l| l.contains("settings.app")).collect();
    assert_eq!(lines.len(), 1, "{text}");
    assert!(lines[0].contains("settings.app mcp_enabled=false"), "{text}");
    assert!(!text.contains("appearance"), "{text}");
    assert!(!text.contains("known_repos"), "{text}");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn mcp_enabled_unchanged_is_silent() {
    let (dir, path) = temp_app("mcp-same");
    let cfg = AppConfig::default();
    crate::write_app_config_at(&path, &cfg).unwrap();
    crate::write_app_config_at(&path, &cfg).unwrap();
    let text = log_text(&path);
    assert!(!text.contains("settings.app"), "{text}");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn unparseable_prior_is_not_overwritten() {
    let (dir, path) = temp_app("mcp-garbage");
    let original = "this is not toml";
    fs::write(&path, original).unwrap();
    let result = crate::write_app_config_at(&path, &AppConfig::default());
    let retained = fs::read_to_string(&path).unwrap();
    let text = log_text(&path);
    let _ = fs::remove_dir_all(dir);
    assert!(result.is_err());
    assert_eq!(retained, original);
    assert!(!text.contains("settings.app"));
}

#[test]
fn legacy_playbook_default_keeps_repositories_and_appearance_on_save() {
    let (dir, path) = temp_app("legacy-default-integrity");
    let original = "active_repo='/keep'\nknown_repos=['/keep','/another']\n[appearance]\nui_scale=1.25\n[global.defaults]\nplaybook='superdevelop'\n";
    fs::write(&path, original).unwrap();
    let mut cfg: AppConfig = toml::from_str(original).unwrap();
    assert_eq!(cfg.active_repo, "/keep");
    assert_eq!(cfg.known_repos, ["/keep", "/another"]);
    assert_eq!(
        cfg.global.defaults.playbook,
        alinery_core::playbook::PlaybookRef {
            scope: alinery_core::playbook::PlaybookScope::Bundled,
            key: "superdevelop".into(),
        }
    );
    cfg.appearance.chat_show_block_copy_buttons = false;
    crate::write_app_config_at(&path, &cfg).unwrap();
    let saved = fs::read_to_string(&path).unwrap();
    let reloaded: AppConfig = toml::from_str(&saved).unwrap();
    assert_eq!(reloaded.known_repos, cfg.known_repos);
    assert_eq!(reloaded.active_repo, cfg.active_repo);
    assert_eq!(reloaded.appearance.ui_scale, 1.25);
    assert!(!reloaded.appearance.chat_show_block_copy_buttons);
    let value: toml::Value = toml::from_str(&saved).unwrap();
    assert_eq!(value["global"]["defaults"]["playbook"]["scope"].as_str(), Some("bundled"));
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn set_active_repo_rejects_a_deleted_git_dir_without_creating_alinery() {
    use tauri::Manager;
    let repo = init_git_test_repo("deleted-git");
    fs::remove_dir_all(repo.join(".git")).unwrap();
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier = format!("test.alinery.open-git.{}", uuid::Uuid::new_v4());
    let app = tauri::test::mock_builder().manage(AppState::default()).build(context).unwrap();
    let err = match crate::set_active_repo_sync(app.handle().clone(), app.state(), repo.display().to_string(), Vec::new()) {
        Ok(_) => panic!("deleted .git must not open"),
        Err(err) => err,
    };
    assert!(err.contains("Couldn't open"), "{err}");
    assert!(err.contains("not a git repository"), "{err}");
    assert!(!repo.join(".alinery").exists());
    drop(app);
    let _ = fs::remove_dir_all(repo);
}

struct ActiveRepoReset;
impl Drop for ActiveRepoReset {
    fn drop(&mut self) {
        let _ = set_active_repo_global(None);
    }
}

#[derive(Clone, Debug)]
struct RecordedOp {
    op: String,
    id: Option<String>,
}

fn canonical_repo(name: &str) -> PathBuf {
    // init_git_test_repo lives under temp_dir(), and that path plus the namespaced
    // socket exceeds macOS SUN_LEN. Same git init, under a short /tmp name.
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() % 1_000_000)
        .unwrap_or(0);
    let repo = PathBuf::from(format!("/tmp/al-{name}-{n}"));
    let _ = fs::remove_dir_all(&repo);
    fs::create_dir_all(&repo).unwrap();
    let run = |args: &[&str]| {
        let out = git_cmd(&repo).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
    };
    run(&["init", "-q"]);
    run(&["config", "user.email", "test@alinery.local"]);
    run(&["config", "user.name", "alinery Test"]);
    run(&["commit", "--allow-empty", "-q", "-m", "init"]);
    alinery_core::require_working_tree(&repo).expect("git toplevel")
}

fn serve_daemon(
    socket_path: PathBuf,
    version_identity: String,
    kill_error: bool,
) -> (
    std::sync::Arc<Mutex<Vec<RecordedOp>>>,
    std::sync::Arc<std::sync::atomic::AtomicBool>,
    std::thread::JoinHandle<()>,
) {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    fs::create_dir_all(socket_path.parent().unwrap()).unwrap();
    let _ = fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap();
    listener.set_nonblocking(true).unwrap();
    let requests = std::sync::Arc::new(Mutex::new(Vec::new()));
    let recorded = requests.clone();
    let stop = std::sync::Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();
    let handle = std::thread::spawn(move || {
        while !stopped.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    stream.set_nonblocking(false).unwrap();
                    let mut line = String::new();
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    if reader.read_line(&mut line).unwrap_or(0) == 0 {
                        continue;
                    }
                    let request: serde_json::Value = serde_json::from_str(line.trim()).unwrap_or(serde_json::Value::Null);
                    let op = request.get("op").and_then(|value| value.as_str()).unwrap_or("").to_string();
                    let id = request.get("id").and_then(|value| value.as_str()).map(str::to_owned);
                    recorded.lock().unwrap_or_else(|error| error.into_inner()).push(RecordedOp { op: op.clone(), id });
                    let response = if op == "version" {
                        serde_json::json!({
                            "protocol": PROTOCOL_VERSION,
                            "build_id": "fixture",
                            "app_config_identity": version_identity,
                        })
                        .to_string()
                    } else if op == "kill" && kill_error {
                        "{\"error\":\"kill failed\"}".to_string()
                    } else if op == "list" {
                        "{\"sessions\":[]}".to_string()
                    } else {
                        "{\"ok\":true}".to_string()
                    };
                    let _ = writeln!(stream, "{response}");
                    let _ = stream.flush();
                }
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(5)),
            }
        }
        drop(listener);
        let _ = fs::remove_file(socket_path);
    });
    (requests, stop, handle)
}

fn kills_of(requests: &Mutex<Vec<RecordedOp>>) -> Vec<String> {
    requests
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .iter()
        .filter(|request| request.op == "kill")
        .map(|request| request.id.clone().unwrap_or_default())
        .collect()
}

struct DrawerSwitch {
    previous: PathBuf,
    destination: PathBuf,
    app: tauri::App<tauri::test::MockRuntime>,
    prev_requests: std::sync::Arc<Mutex<Vec<RecordedOp>>>,
    dest_requests: std::sync::Arc<Mutex<Vec<RecordedOp>>>,
    prev_stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    dest_stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    prev_thread: Option<std::thread::JoinHandle<()>>,
    dest_thread: Option<std::thread::JoinHandle<()>>,
    _reset: ActiveRepoReset,
}

impl Drop for DrawerSwitch {
    fn drop(&mut self) {
        self.prev_stop.store(true, std::sync::atomic::Ordering::SeqCst);
        self.dest_stop.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(thread) = self.prev_thread.take() {
            let _ = thread.join();
        }
        if let Some(thread) = self.dest_thread.take() {
            let _ = thread.join();
        }
        let _ = fs::remove_dir_all(&self.previous);
        let _ = fs::remove_dir_all(&self.destination);
    }
}

fn drawer_switch(name: &str, kill_error: bool) -> DrawerSwitch {
    use tauri::Manager;
    let previous = canonical_repo(&format!("{name}-prev"));
    let destination = canonical_repo(&format!("{name}-dest"));
    set_active_repo_global(Some(previous.clone())).unwrap();
    let state = AppState::default();
    assert!(state.claim_repo(&previous), "previous repo must be owned");
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier = format!("test.alinery.{name}.{}", uuid::Uuid::new_v4());
    let app = tauri::test::mock_builder().manage(state).build(context).unwrap();
    let config_path = crate::app_config_path(app.handle()).unwrap();
    let identity = alinery_core::app_config_identity(&config_path);
    let (prev_requests, prev_stop, prev_thread) = serve_daemon(current_alineryd_socket_path(&previous), identity.clone(), kill_error);
    let (dest_requests, dest_stop, dest_thread) = serve_daemon(current_alineryd_socket_path(&destination), identity.clone(), false);
    app.state::<AppState>().set_daemon(
        &previous,
        DaemonClient::connect_path(current_alineryd_socket_path(&previous)).unwrap(),
        alinery_core::DaemonCompat::Current,
        identity,
        false,
    );
    DrawerSwitch {
        previous,
        destination,
        app,
        prev_requests,
        dest_requests,
        prev_stop,
        dest_stop,
        prev_thread: Some(prev_thread),
        dest_thread: Some(dest_thread),
        _reset: ActiveRepoReset,
    }
}

fn seed_routes(state: &AppState, ids: &[&str]) {
    let mut routes = state.session_routes.lock().unwrap_or_else(|error| error.into_inner());
    for id in ids {
        routes.insert((*id).to_string(), DaemonClient::connect_path(PathBuf::from("/tmp/unused-drawer-route.sock")).unwrap());
    }
}

#[test]
fn set_active_repo_kills_every_drawer_id_only_when_the_repo_changes() {
    use tauri::Manager;
    let _guard = ACTIVE_REPO_TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let fixture = drawer_switch("drawer-kill", false);
    let state = fixture.app.state::<AppState>();
    seed_routes(&state, &["s-a", "s-b"]);
    let result = crate::set_active_repo_sync(
        fixture.app.handle().clone(),
        fixture.app.state(),
        fixture.destination.display().to_string(),
        vec!["s-a".into(), "s-b".into()],
    );
    assert!(result.is_ok(), "{}", result.err().unwrap_or_default());
    assert_eq!(kills_of(&fixture.prev_requests), vec!["s-a".to_string(), "s-b".to_string()]);
    assert!(kills_of(&fixture.dest_requests).is_empty(), "destination socket received a kill");
    let routes = state.session_routes.lock().unwrap_or_else(|error| error.into_inner());
    assert!(!routes.contains_key("s-a"));
    assert!(!routes.contains_key("s-b"));
}

#[test]
fn set_active_repo_does_not_kill_drawer_ids_when_the_repo_stays() {
    use tauri::Manager;
    let _guard = ACTIVE_REPO_TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let fixture = drawer_switch("drawer-same", false);
    let again = alinery_core::require_working_tree(Path::new(&fixture.previous.display().to_string())).unwrap();
    assert_eq!(again, fixture.previous);
    let result = crate::set_active_repo_sync(fixture.app.handle().clone(), fixture.app.state(), again.display().to_string(), vec!["s-a".into()]);
    assert!(result.is_ok(), "{}", result.err().unwrap_or_default());
    assert!(kills_of(&fixture.prev_requests).is_empty(), "same-repo switch must not kill");
}

#[test]
fn set_active_repo_does_not_kill_drawer_ids_when_the_list_is_empty() {
    use tauri::Manager;
    let _guard = ACTIVE_REPO_TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let fixture = drawer_switch("drawer-empty", false);
    let result = crate::set_active_repo_sync(fixture.app.handle().clone(), fixture.app.state(), fixture.destination.display().to_string(), Vec::new());
    assert!(result.is_ok(), "{}", result.err().unwrap_or_default());
    assert!(kills_of(&fixture.prev_requests).is_empty());
    assert!(kills_of(&fixture.dest_requests).is_empty());
}

#[test]
fn set_active_repo_clears_drawer_routes_when_kill_fails() {
    use tauri::Manager;
    let _guard = ACTIVE_REPO_TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let fixture = drawer_switch("drawer-kill-err", true);
    let state = fixture.app.state::<AppState>();
    seed_routes(&state, &["s-a"]);
    let result = crate::set_active_repo_sync(
        fixture.app.handle().clone(),
        fixture.app.state(),
        fixture.destination.display().to_string(),
        vec!["s-a".into()],
    );
    assert!(result.is_ok(), "{}", result.err().unwrap_or_default());
    assert_eq!(kills_of(&fixture.prev_requests), vec!["s-a".to_string()]);
    assert!(!state.session_routes.lock().unwrap_or_else(|error| error.into_inner()).contains_key("s-a"));
}

#[test]
fn set_active_repo_does_not_kill_drawer_ids_when_reservation_fails() {
    use std::io::{BufRead, BufReader};
    use tauri::Manager;
    let _guard = ACTIVE_REPO_TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let _reset = ActiveRepoReset;
    let previous = canonical_repo("drawer-reserved-prev");
    let destination = canonical_repo("drawer-reserved-dest");
    set_active_repo_global(Some(previous.clone())).unwrap();
    let state = AppState::default();
    assert!(state.claim_repo(&previous));
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier = format!("test.alinery.drawer-reserved.{}", uuid::Uuid::new_v4());
    let app = tauri::test::mock_builder().manage(state).build(context).unwrap();
    let (prev_requests, prev_stop, prev_thread) = serve_daemon(current_alineryd_socket_path(&previous), "fixture".into(), false);
    app.state::<AppState>().set_daemon(
        &previous,
        DaemonClient::connect_path(current_alineryd_socket_path(&previous)).unwrap(),
        alinery_core::DaemonCompat::Current,
        "fixture".into(),
        false,
    );
    // flock does not exclude a second descriptor in this process (lockfile.rs). Hold the
    // destination GUI lock from another process so reserve_repo fails the way a second window does.
    let lock_path = alinery_app_lock_path(&destination);
    fs::create_dir_all(lock_path.parent().unwrap()).unwrap();
    let mut holder = std::process::Command::new("python3")
        .arg("-c")
        .arg("import fcntl,sys,time; f=open(sys.argv[1],'a+'); fcntl.flock(f.fileno(), fcntl.LOCK_EX|fcntl.LOCK_NB); sys.stdout.write('ready\\n'); sys.stdout.flush(); time.sleep(30)")
        .arg(&lock_path)
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("python3 flock holder");
    let mut ready = String::new();
    BufReader::new(holder.stdout.take().unwrap()).read_line(&mut ready).unwrap();
    assert_eq!(ready.trim(), "ready");
    let err = match crate::set_active_repo_sync(app.handle().clone(), app.state(), destination.display().to_string(), vec!["s-a".into(), "s-b".into()]) {
        Ok(_) => panic!("a held destination lock must reject the switch"),
        Err(err) => err,
    };
    assert!(err.contains("open in another Alinery window"), "{err}");
    assert!(kills_of(&prev_requests).is_empty(), "reservation failure must not kill");
    let _ = holder.kill();
    let _ = holder.wait();
    prev_stop.store(true, std::sync::atomic::Ordering::SeqCst);
    let _ = prev_thread.join();
    drop(app);
    let _ = fs::remove_dir_all(&previous);
    let _ = fs::remove_dir_all(&destination);
}
