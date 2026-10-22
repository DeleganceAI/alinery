//! Tests for omp_update.rs
use crate::*;
use std::os::unix::fs::PermissionsExt;

fn write_exec(path: &std::path::Path, body: &str) {
    fs::write(path, body).unwrap();
    let mut p = fs::metadata(path).unwrap().permissions();
    p.set_mode(0o755);
    fs::set_permissions(path, p).unwrap();
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

#[test]
fn ensure_default_model_role_only_fills_when_unset() {
    let dir = std::env::temp_dir().join(format!("alinery-default-role-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    ensure_default_model_role(&dir, "alinery/Qwen3.6-35B-A3B").unwrap();
    let first = parse_model_roles_yaml(&fs::read_to_string(dir.join("config.yml")).unwrap());
    assert_eq!(first.get("default").map(String::as_str), Some("alinery/Qwen3.6-35B-A3B"));
    ensure_default_model_role(&dir, "alinery/other").unwrap();
    let second = parse_model_roles_yaml(&fs::read_to_string(dir.join("config.yml")).unwrap());
    assert_eq!(second.get("default").map(String::as_str), Some("alinery/Qwen3.6-35B-A3B"));
    let _ = fs::remove_dir_all(&dir);
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
