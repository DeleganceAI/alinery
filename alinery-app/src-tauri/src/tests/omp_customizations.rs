use crate::omp_customizations::{append_omp_plugin_inventory, omp_customizations_from_paths, OmpCustomizations};
use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

struct InventoryFixture {
    root: PathBuf,
    agent: PathBuf,
}

impl InventoryFixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("alinery-customizations-{}", uuid::Uuid::new_v4()));
        let agent = root.join("agent");
        fs::create_dir_all(&agent).unwrap();
        Self { root, agent }
    }

    fn file(&self, relative: &str, content: &str) {
        let path = self.agent.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn cli(&self, body: &str) -> PathBuf {
        let path = self.root.join("omp");
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn inventory(&self, binary: Option<&Path>) -> OmpCustomizations {
        omp_customizations_from_paths(&self.agent, &self.root, binary, Duration::from_secs(2))
    }
}

impl Drop for InventoryFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn loose_skills_survive_an_empty_plugin_list_and_cli_uses_isolated_config() {
    let fixture = InventoryFixture::new();
    fixture.file("skills/ponytail/SKILL.md", "---\nname: 'Ponytail: minimal'\ndescription: Keep it simple\n---\nInstructions");
    fixture.file("skills/fallback/SKILL.md", "No frontmatter, but still installed.");
    fixture.file("skills/disabled/SKILL.md", "---\nname: Disabled\nenabled: false\n---\nInstructions");
    fixture.file("skills/nested/child/SKILL.md", "Not a directly installed skill.");
    let cli = fixture.cli(
        "[ \"$#\" = 3 ] && [ \"$1\" = plugin ] && [ \"$2\" = list ] && [ \"$3\" = --json ] || exit 10\n\
         [ \"$PWD\" = / ] && [ \"$PI_CODING_AGENT_DIR\" = \"$PI_CONFIG_DIR/agent\" ] || exit 11\n\
         [ -f \"$PI_CODING_AGENT_DIR/skills/ponytail/SKILL.md\" ] && [ \"$OMP_SKIP_SETUP\" = 1 ] || exit 12\n\
         printf '%s' '{\"npm\":[],\"marketplace\":[]}'",
    );
    let inventory = fixture.inventory(Some(&cli));
    assert!(inventory.errors.is_empty(), "{:?}", inventory.errors);
    let names: Vec<_> = inventory.items.iter().filter(|item| item.kind == "Skill").map(|item| item.name.as_str()).collect();
    assert_eq!(names, ["Disabled", "Ponytail: minimal", "fallback"]);
    assert!(inventory.items.iter().all(|item| item.kind != "Plugin package"));
}

#[test]
fn missing_directories_are_empty_but_alinery_integration_is_always_identified() {
    let fixture = InventoryFixture::new();
    fs::remove_dir(&fixture.agent).unwrap();
    let cli = fixture.cli("printf '%s' '{\"npm\":[],\"marketplace\":[]}'");
    let inventory = fixture.inventory(Some(&cli));
    assert!(inventory.errors.is_empty(), "{:?}", inventory.errors);
    let provided: Vec<_> = inventory.items.iter().map(|item| (item.name.as_str(), item.kind.as_str(), item.path.as_deref())).collect();
    assert_eq!(provided, [("Alinery runner integration", "Extension", None), ("alinery", "MCP server", None)]);
    assert!(inventory.items.iter().all(|item| item.source.starts_with("Provided by Alinery")));
}

#[test]
fn malformed_skill_and_extension_metadata_keep_filename_fallbacks_and_partial_results() {
    let fixture = InventoryFixture::new();
    fixture.file("skills/broken/SKILL.md", "---\nname: [secret-frontmatter\n---\nBody");
    fixture.file("skills/unclosed/SKILL.md", "---\nname: secret-unclosed");
    fixture.file("skills/good/SKILL.md", "---\nname: >-\n  Folded name\n---\nBody");
    fixture.file("extensions/broken-package/package.json", "{\"name\":\"secret-package\"");
    fixture.file("mcp.json", "{\"mcpServers\":{\"secret-json-excerpt\":");
    fixture.file(".mcp.json", "{\"mcpServers\":{\"healthy-server\":{\"command\":\"server\"}}}");
    let inventory = fixture.inventory(None);
    for name in ["broken", "unclosed", "Folded name", "broken-package", "healthy-server"] {
        assert!(inventory.items.iter().any(|item| item.name == name), "missing {name}");
    }
    assert!(inventory.errors.iter().any(|error| error.contains("malformed YAML")));
    assert!(inventory.errors.iter().any(|error| error.contains("unterminated")));
    assert!(inventory.errors.iter().any(|error| error.contains("mcp.json")));
    let serialized = serde_json::to_string(&inventory).unwrap();
    assert!(!serialized.contains("secret-"));
}

#[test]
fn mcp_inventory_exposes_only_names_and_sources_even_for_invalid_definitions() {
    let fixture = InventoryFixture::new();
    fixture.file(
        "mcp.json",
        r#"{"mcpServers":{"local":{"command":"secret-command","args":["secret-arg"],"env":{"API_KEY":"secret-env"}},"remote":{"url":"https://secret-url","headers":{"Authorization":"secret-header"},"oauth":{"clientSecret":"secret-oauth"}},"invalid":"secret-invalid-definition"},"unrelated":"secret-top-level"}"#,
    );
    let inventory = fixture.inventory(None);
    let names: Vec<_> = inventory.items.iter().filter(|item| item.path.is_some()).map(|item| item.name.as_str()).collect();
    assert_eq!(names, ["invalid", "local", "remote"]);
    assert!(inventory.errors.iter().any(|error| error.contains("definition must be an object")));
    for item in inventory.items.iter().filter(|item| item.path.is_some()) {
        assert_eq!(item.path.as_deref(), fixture.agent.join("mcp.json").to_str());
        assert_eq!(item.source, fixture.agent.join("mcp.json").display().to_string());
    }
    assert!(!serde_json::to_string(&inventory).unwrap().contains("secret-"));
}

#[test]
fn extensions_are_discovered_without_executing_code_and_linked_skills_are_supported() {
    let fixture = InventoryFixture::new();
    let executed = fixture.root.join("extension-executed");
    let code = format!(
        "import {{ writeFileSync }} from 'node:fs'; writeFileSync({}, 'executed');",
        serde_json::to_string(&executed).unwrap()
    );
    fixture.file("extensions/loose.ts", &code);
    fixture.file("extensions/indexed/index.js", &code);
    fixture.file("extensions/declared/package.json", r#"{"name":"declared-extension","omp":{"extensions":["custom.ts"]}}"#);
    fixture.file("extensions/declared/custom.ts", &code);
    fixture.file("extensions/unrelated/package.json", r#"{"name":"not-an-extension"}"#);
    fixture.file("extensions/legacy/gemini-extension.json", r#"{"name":"legacy-extension"}"#);
    fixture.file(".skill-source/SKILL.md", "---\nname: linked-skill\n---\nBody");
    fs::create_dir_all(fixture.agent.join("skills")).unwrap();
    symlink(fixture.agent.join(".skill-source"), fixture.agent.join("skills/linked")).unwrap();
    let inventory = fixture.inventory(None);
    let names: Vec<_> = inventory.items.iter().filter(|item| item.path.is_some()).map(|item| item.name.as_str()).collect();
    assert_eq!(names, ["declared-extension", "indexed", "legacy-extension", "loose.ts", "linked-skill"]);
    assert!(!executed.exists());
}

#[test]
fn plugin_json_keeps_valid_packages_and_excludes_project_scope_and_sensitive_metadata() {
    let mut inventory = OmpCustomizations::default();
    append_omp_plugin_inventory(
        br#"{"npm":[{"name":"npm-plugin","path":"/install/npm-plugin","manifest":{"token":"secret-manifest"}},{"path":"/install/fallback"},{}],"marketplace":[{"id":"market@source","scope":"user","entries":[{"installPath":"/install/market","token":"secret-market"}]},{"id":"project-only","scope":"project","entries":[{"installPath":"/repo/.omp/plugin"}]}]}"#,
        &mut inventory,
    );
    let names: Vec<_> = inventory.items.iter().map(|item| item.name.as_str()).collect();
    assert_eq!(names, ["npm-plugin", "fallback", "market@source"]);
    assert_eq!(inventory.items[2].path.as_deref(), Some("/install/market"));
    assert!(inventory.errors.iter().any(|error| error.contains("without a name")));
    assert!(!serde_json::to_string(&inventory).unwrap().contains("secret-"));

    let mut partial = OmpCustomizations::default();
    append_omp_plugin_inventory(br#"{"npm":[{"name":"kept"}],"marketplace":false}"#, &mut partial);
    assert_eq!(partial.items[0].name, "kept");
    assert!(partial.errors.iter().any(|error| error.contains("marketplace")));
}

#[test]
fn failed_and_malformed_cli_discovery_preserve_loose_items_without_output_excerpts() {
    let fixture = InventoryFixture::new();
    fixture.file("skills/retained/SKILL.md", "Body");
    for body in [
        "printf secret-stdout; printf secret-stderr >&2; exit 1",
        "printf secret-malformed-json",
        "printf '%s' '{\"npm\":[],\"marketplace\":[]}'; printf secret-diagnostic >&2",
    ] {
        let cli = fixture.cli(body);
        let inventory = fixture.inventory(Some(&cli));
        assert!(inventory.items.iter().any(|item| item.name == "retained"));
        assert!(inventory.errors.iter().any(|error| error.contains("incomplete")));
        assert!(!serde_json::to_string(&inventory).unwrap().contains("secret-"));
    }
}

#[test]
fn timed_out_cli_returns_partial_inventory_promptly() {
    let fixture = InventoryFixture::new();
    fixture.file("skills/retained/SKILL.md", "Body");
    let cli = fixture.cli("while :; do :; done");
    let started = Instant::now();
    let inventory = omp_customizations_from_paths(&fixture.agent, &fixture.root, Some(&cli), Duration::from_millis(50));
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(inventory.items.iter().any(|item| item.name == "retained"));
    assert!(inventory.errors.iter().any(|error| error.contains("timed out")));
}

#[test]
fn broken_links_and_invalid_directories_report_partial_inventory() {
    let fixture = InventoryFixture::new();
    fixture.file("skills/retained/SKILL.md", "Body");
    symlink(fixture.root.join("missing"), fixture.agent.join("skills/broken")).unwrap();
    fixture.file("extensions", "not a directory");
    let inventory = fixture.inventory(None);
    assert!(inventory.items.iter().any(|item| item.name == "retained"));
    assert!(inventory.errors.iter().any(|error| error.contains("skills/broken")));
    assert!(inventory.errors.iter().any(|error| error.contains("extensions")));
}
