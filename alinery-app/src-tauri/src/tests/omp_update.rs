//! Tests for omp_update.rs
use crate::*;
use std::os::unix::fs::PermissionsExt;

struct OmpPathGuard {
    prev: Option<std::ffi::OsString>,
    _lock: std::sync::MutexGuard<'static, ()>,
}
impl OmpPathGuard {
    fn set(value: Option<&str>) -> Self {
        let lock = super::OMP_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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
fn model_roles_read_flow_mapping_without_rewriting_configuration() {
    let dir = std::env::temp_dir().join(format!("alinery-role-read-{}", uuid::Uuid::new_v4()));
    let app_config = dir.join("app.toml");
    let (agent, _) = alinery_core::omp_home_dirs(&app_config);
    fs::create_dir_all(&agent).unwrap();
    let original = "theme: dark\nmodelRoles: {default: 'provider/model', smol: 'other/model'}\n";
    fs::write(agent.join("config.yaml"), original).unwrap();
    let roles = alinery_core::read_omp_model_roles(&app_config).unwrap();
    assert_eq!(roles.get("default").map(String::as_str), Some("provider/model"));
    assert_eq!(roles.get("smol").map(String::as_str), Some("other/model"));
    assert_eq!(fs::read_to_string(agent.join("config.yaml")).unwrap(), original);
    assert!(!agent.join("config.yml").exists());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn customization_prompt_commands_target_exact_installation_without_shell_expansion() {
    let root = std::env::temp_dir().join(format!("alinery-prompt-{}", uuid::Uuid::new_v4()));
    let install = root.join("Alinery's $(touch INJECTED) 日本語");
    let app_config = install.join("app.toml");
    let (agent_dir, config_dir) = alinery_core::omp_home_dirs(&app_config);
    fs::create_dir_all(&agent_dir).unwrap();
    let binary = install.join("omp's binary");
    write_exec(
        &binary,
        "#!/bin/sh\nprintf '%s\\n' \"$PI_CONFIG_DIR\" \"$PI_CODING_AGENT_DIR\" \"$PWD\" \"$*\" \"${PROVIDER_SECRET-unset}\"\n",
    );
    let prompt = render_omp_customization_prompt(&app_config, "ai.delegance.alinery.dev", &binary, "18.1.13");
    let start = prompt.find("\n(\n").unwrap();
    let end = prompt[start..].find("\n)\n").unwrap() + start + 3;
    let output = Command::new("/bin/sh")
        .arg("-c")
        .arg(&prompt[start..end])
        .env("PROVIDER_SECRET", "secret-from-shell")
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let stdout = String::from_utf8(output.stdout).unwrap();
    let lines: Vec<_> = stdout.lines().collect();
    assert_eq!(lines[0], config_dir.to_str().unwrap());
    assert_eq!(lines[1], agent_dir.to_str().unwrap());
    assert_eq!(lines[2], fs::canonicalize(&agent_dir).unwrap().to_str().unwrap());
    assert_eq!(lines[3], "--version");
    assert_eq!(lines[4], "unset");
    assert_eq!(lines[8], "plugin list --json");
    assert_eq!(lines[9], "unset");
    assert!(!root.join("INJECTED").exists());
    assert!(!agent_dir.join("INJECTED").exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn customization_prompt_reads_version_but_never_copies_configuration_secrets() {
    let root = std::env::temp_dir().join(format!("alinery-prompt-secrets-{}", uuid::Uuid::new_v4()));
    let app_config = root.join("app.toml");
    let (agent_dir, _) = alinery_core::omp_home_dirs(&app_config);
    fs::create_dir_all(&agent_dir).unwrap();
    for name in ["config.yml", "models.yml", "mcp.json", "agent.db"] {
        fs::write(agent_dir.join(name), format!("private-content-{name}")).unwrap();
    }
    let binary = root.join("packaged-omp");
    write_exec(&binary, "#!/bin/sh\nprintf 'omp/18.1.13\\n'\nprintf 'private-stderr' >&2\n");
    let prompt = omp_customization_prompt_for(&app_config, "ai.delegance.alinery.dev", &binary).unwrap();
    assert!(prompt.contains("18.1.13"));
    assert!(prompt.contains("ai.delegance.alinery.dev"));
    assert!(prompt.contains("providers.alinery"));
    assert!(!prompt.contains("private-content"));
    assert!(!prompt.contains("private-stderr"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn customization_prompt_rejects_failed_or_nonversion_cli_output_without_leaking_it() {
    let root = std::env::temp_dir().join(format!("alinery-prompt-error-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let binary = root.join("omp");
    for script in ["#!/bin/sh\necho private-token\n", "#!/bin/sh\necho private-token >&2\nexit 1\n"] {
        write_exec(&binary, script);
        let error = omp_customization_prompt_for(&root.join("app.toml"), "alinery", &binary).unwrap_err();
        assert!(!error.contains("private-token"));
    }
    fs::remove_dir_all(root).unwrap();
}
