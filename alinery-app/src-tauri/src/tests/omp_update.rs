//! Tests for omp_update.rs
use crate::*;

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
