//! Tests for omp_update.rs
use crate::*;
use std::os::unix::fs::PermissionsExt;

static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct OmpPathGuard {
    prev: Option<std::ffi::OsString>,
    _lock: std::sync::MutexGuard<'static, ()>,
}
impl OmpPathGuard {
    fn set(value: Option<&str>) -> Self {
        let lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev = std::env::var_os("ALINERY_OMP_PATH");
        match value {
            Some(v) => std::env::set_var("ALINERY_OMP_PATH", v),
            None => std::env::remove_var("ALINERY_OMP_PATH"),
        }
        Self { prev, _lock: lock }
    }
}
impl Drop for OmpPathGuard {
    fn drop(&mut self) {
        match &self.prev {
            Some(v) => std::env::set_var("ALINERY_OMP_PATH", v),
            None => std::env::remove_var("ALINERY_OMP_PATH"),
        }
    }
}

fn write_exec(path: &std::path::Path, body: &str) {
    fs::write(path, body).unwrap();
    let mut p = fs::metadata(path).unwrap().permissions();
    p.set_mode(0o755);
    fs::set_permissions(path, p).unwrap();
}

#[test]
fn check_omp_update_never_err_on_resolve_or_network_failure() {
    let _guard = OmpPathGuard::set(Some("/no/such/alinery-omp-update"));
    let _api = std::env::var_os("ALINERY_OMP_RELEASE_API_URL");
    std::env::set_var("ALINERY_OMP_RELEASE_API_URL", "http://127.0.0.1:1/latest");
    let status = omp_update_status_now();
    match _api {
        Some(v) => std::env::set_var("ALINERY_OMP_RELEASE_API_URL", v),
        None => std::env::remove_var("ALINERY_OMP_RELEASE_API_URL"),
    }
    assert_eq!(status.installed, "");
    assert_eq!(status.available, None);
}

#[test]
fn check_omp_update_installed_from_version_stdout() {
    let path = std::env::temp_dir().join(format!("alinery-omp-ver-{}", std::process::id()));
    write_exec(&path, "#!/bin/sh\necho omp/18.1.10\n");
    let _guard = OmpPathGuard::set(Some(path.to_str().unwrap()));
    let _api = std::env::var_os("ALINERY_OMP_RELEASE_API_URL");
    std::env::set_var("ALINERY_OMP_RELEASE_API_URL", "http://127.0.0.1:1/latest");
    let status = omp_update_status_now();
    match _api {
        Some(v) => std::env::set_var("ALINERY_OMP_RELEASE_API_URL", v),
        None => std::env::remove_var("ALINERY_OMP_RELEASE_API_URL"),
    }
    let _ = fs::remove_file(&path);
    assert!(status.installed.contains("18.1.10"), "installed={}", status.installed);
}

#[test]
fn check_omp_update_available_when_github_newer() {
    let body = br#"{
      "tag_name": "v18.2.0",
      "assets": [
        {"name": "omp-darwin-arm64", "browser_download_url": "https://github.com/can1357/oh-my-pi/releases/download/v18.2.0/omp-darwin-arm64"},
        {"name": "omp-linux-x64", "browser_download_url": "https://github.com/can1357/oh-my-pi/releases/download/v18.2.0/omp-linux-x64"}
      ]
    }"#;
    let asset = omp_github_asset_name().unwrap_or("omp-darwin-arm64");
    let latest = parse_github_omp_release(body, asset).expect("parse");
    assert_eq!(latest.version, "v18.2.0");
    assert!(latest.asset_url.contains(asset), "{}", latest.asset_url);
    let status = evaluate_omp_update("omp/18.1.10", Some(&latest), 42);
    assert_eq!(status.available.as_ref().map(|r| r.version.as_str()), Some("v18.2.0"));
    assert_eq!(status.available.as_ref().map(|r| r.asset_url.as_str()), Some(latest.asset_url.as_str()));
}

#[test]
fn update_omp_rejects_checksum_mismatch_without_touching_binary() {
    let dest = std::env::temp_dir().join(format!("alinery-omp-dest-{}", std::process::id()));
    fs::write(&dest, b"old-bytes").unwrap();
    let err = install_verified_omp(
        &dest,
        b"new-bytes",
        "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef  omp-darwin-arm64\n",
        "omp-darwin-arm64",
    )
    .expect_err("mismatch");
    assert!(err.contains("checksum"), "{err}");
    assert_eq!(fs::read(&dest).unwrap(), b"old-bytes");
    let _ = fs::remove_file(&dest);
}

#[test]
fn update_omp_atomic_replace_on_match() {
    let dest = std::env::temp_dir().join(format!("alinery-omp-ok-{}", std::process::id()));
    fs::write(&dest, b"old-bytes").unwrap();
    let asset = b"new-verified-omp\n";
    let tmp_hash = std::env::temp_dir().join(format!("alinery-omp-hash-{}", std::process::id()));
    fs::write(&tmp_hash, asset).unwrap();
    let hash = sha256_file(&tmp_hash);
    let _ = fs::remove_file(&tmp_hash);
    let sums = format!("{hash}  omp-darwin-arm64\n");
    install_verified_omp(&dest, asset, &sums, "omp-darwin-arm64").expect("match");
    assert_eq!(fs::read(&dest).unwrap(), asset);
    let mode = fs::metadata(&dest).unwrap().permissions().mode();
    assert_eq!(mode & 0o111, 0o111, "dest should be executable, mode={mode:o}");
    let _ = fs::remove_file(&dest);
}

#[test]
fn model_roles_yaml_round_trip_preserves_other_keys() {
    let existing = "theme: dark\nmodelRoles:\n  smol: old/model\nother: keep\n";
    let mut roles = HashMap::new();
    roles.insert("default".into(), "anthropic/claude".into());
    roles.insert("smol".into(), "xai/grok".into());
    let rendered = render_model_roles_yaml(existing, &roles);
    assert!(rendered.contains("theme: dark"));
    assert!(rendered.contains("other: keep"));
    assert!(!rendered.contains("old/model"));
    let parsed = parse_model_roles_yaml(&rendered);
    assert_eq!(parsed.get("default").map(String::as_str), Some("anthropic/claude"));
    assert_eq!(parsed.get("smol").map(String::as_str), Some("xai/grok"));
}

#[test]
fn model_roles_clear_removes_block() {
    let existing = "a: 1\nmodelRoles:\n  smol: x/y\nb: 2\n";
    let rendered = render_model_roles_yaml(existing, &HashMap::new());
    assert!(!rendered.contains("modelRoles"));
    assert!(rendered.contains("a: 1"));
    assert!(rendered.contains("b: 2"));
}
