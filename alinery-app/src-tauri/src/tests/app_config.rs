//! Tests for app_config.rs — mcp_enabled logging via write_app_config_at.
use super::*;
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
fn remote_hosts_round_trip_and_are_absent_for_local_only_configs() {
    let local_only: AppConfig = toml::from_str("known_repos=['/a']\n").unwrap();
    assert!(local_only.remote_hosts.is_empty());
    assert!(!toml::to_string(&local_only).unwrap().contains("remote_hosts"));

    let source = "known_repos=['alinery+ssh://devbox-a1b2c3/home/me/repo']\n[remote_hosts.devbox-a1b2c3]\nlabel='devbox'\nssh_args=['-p','2222','me@box']\nhome='/home/me'\n";
    let cfg: AppConfig = toml::from_str(source).unwrap();
    let host = &cfg.remote_hosts["devbox-a1b2c3"];
    assert_eq!(host.ssh_args, ["-p", "2222", "me@box"]);
    assert_eq!(host.home.as_deref(), Some("/home/me"));
    assert_eq!(host.platform, None);
    let reloaded: AppConfig = toml::from_str(&toml::to_string(&cfg).unwrap()).unwrap();
    assert_eq!(reloaded.remote_hosts, cfg.remote_hosts);
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
    cfg.appearance.chat_show_block_copy_buttons = true;
    crate::write_app_config_at(&path, &cfg).unwrap();
    let saved = fs::read_to_string(&path).unwrap();
    let reloaded: AppConfig = toml::from_str(&saved).unwrap();
    assert_eq!(reloaded.known_repos, cfg.known_repos);
    assert_eq!(reloaded.active_repo, cfg.active_repo);
    assert_eq!(reloaded.appearance.ui_scale, 1.25);
    assert!(reloaded.appearance.chat_show_block_copy_buttons);
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
    let err = match crate::set_active_repo_sync(app.handle().clone(), app.state(), repo.display().to_string()) {
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

/// A destination another window holds is refused before anything changes.
#[test]
fn set_active_repo_rejects_a_destination_another_window_holds() {
    use std::io::{BufRead, BufReader};
    use tauri::Manager;
    let _guard = ACTIVE_REPO_TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let _reset = ActiveRepoReset;
    let previous = canonical_repo("held-prev");
    let destination = canonical_repo("held-dest");
    set_active_repo_global(Some(previous.clone())).unwrap();
    let state = AppState::default();
    assert!(state.claim_repo(&previous));
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier = format!("test.alinery.held.{}", uuid::Uuid::new_v4());
    let app = tauri::test::mock_builder().manage(state).build(context).unwrap();
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
    let err = match crate::set_active_repo_sync(app.handle().clone(), app.state(), destination.display().to_string()) {
        Ok(_) => panic!("a held destination lock must reject the switch"),
        Err(err) => err,
    };
    assert!(err.contains("open in another Alinery window"), "{err}");
    assert_eq!(
        crate::active_repo().ok().as_deref(),
        Some(previous.as_path()),
        "a refused switch leaves the active repo alone"
    );
    let _ = holder.kill();
    let _ = holder.wait();
    drop(app);
    let _ = fs::remove_dir_all(&previous);
    let _ = fs::remove_dir_all(&destination);
}
