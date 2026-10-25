use super::*;
use crate::agent_customizations::{delete_vinculum_skill_at, install_vinculum_skill_at, render_vinculum_customization_prompt, vinculum_customizations_from_dir, write_skill_zip};
use std::os::unix::fs::symlink;
use std::path::PathBuf;

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

    fn inventory(&self) -> crate::agent_customizations::VinculumCustomizations {
        vinculum_customizations_from_dir(&self.agent)
    }
}

impl Drop for InventoryFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn loose_skills_are_listed_without_running_a_binary() {
    let fixture = InventoryFixture::new();
    fixture.file("skills/ponytail/SKILL.md", "---\nname: 'Ponytail: minimal'\ndescription: Keep it simple\n---\nInstructions");
    fixture.file("skills/fallback/SKILL.md", "No frontmatter, but still installed.");
    fixture.file(
        "skills/disabled/SKILL.md",
        "---\nname: disabled-skill\ndescription: Hidden\ndisable-model-invocation: true\n---\nInstructions",
    );
    fixture.file("skills/nested/child/SKILL.md", "Not a directly installed skill.");
    let inventory = fixture.inventory();
    assert!(inventory.errors.is_empty(), "{:?}", inventory.errors);
    let names: Vec<_> = inventory.items.iter().filter(|item| item.kind == "Skill").map(|item| item.name.as_str()).collect();
    assert_eq!(names, ["Ponytail: minimal", "disabled-skill", "fallback"]);
    let offered = |name: &str| inventory.items.iter().find(|item| item.name == name).and_then(|item| item.offered);
    assert_eq!(offered("Ponytail: minimal"), Some(true));
    assert_eq!(offered("disabled-skill"), Some(false));
    assert_eq!(offered("fallback"), Some(false));
    assert!(inventory.items.iter().all(|item| item.kind != "Plugin package"));
    assert!(inventory.items.iter().all(|item| item.source != "Provided by Alinery · injected at session launch"));
}

#[test]
fn missing_directories_are_an_empty_install() {
    let fixture = InventoryFixture::new();
    fs::remove_dir_all(&fixture.agent).unwrap();
    let inventory = fixture.inventory();
    assert!(inventory.errors.is_empty(), "{:?}", inventory.errors);
    assert!(inventory.items.is_empty());
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
    let inventory = fixture.inventory();
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
    let inventory = fixture.inventory();
    let names: Vec<_> = inventory.items.iter().map(|item| item.name.as_str()).collect();
    assert_eq!(names, ["invalid", "local", "remote"]);
    assert!(inventory.errors.iter().any(|error| error.contains("definition must be an object")));
    for item in &inventory.items {
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
    let inventory = fixture.inventory();
    let names: Vec<_> = inventory.items.iter().map(|item| item.name.as_str()).collect();
    assert_eq!(names, ["declared-extension", "indexed", "legacy-extension", "loose.ts", "linked-skill"]);
    assert!(!executed.exists());
}

#[test]
fn broken_links_and_invalid_directories_report_partial_inventory() {
    let fixture = InventoryFixture::new();
    fixture.file("skills/retained/SKILL.md", "Body");
    symlink(fixture.root.join("missing"), fixture.agent.join("skills/broken")).unwrap();
    fixture.file("extensions", "not a directory");
    let inventory = fixture.inventory();
    assert!(inventory.items.iter().any(|item| item.name == "retained"));
    assert!(inventory.errors.iter().any(|error| error.contains("skills/broken")));
    assert!(inventory.errors.iter().any(|error| error.contains("extensions")));
}

fn skill_md(name: &str, description: &str, body: &str) -> String {
    format!("---\nname: {name}\ndescription: {description}\n---\n{body}\n")
}

#[test]
fn markdown_upload_installs_one_skill_and_rejects_a_missing_description() {
    let fixture = InventoryFixture::new();
    let source = fixture.root.join("demo.md");
    fs::write(&source, skill_md("demo-skill", "Does the demo", "Secret body")).unwrap();
    let installed = install_vinculum_skill_at(&fixture.agent, &source, false).unwrap();
    assert_eq!(installed.name, "demo-skill");
    assert!(!installed.exists);
    let saved = fs::read_to_string(fixture.agent.join("skills/demo-skill/SKILL.md")).unwrap();
    assert!(saved.contains("Secret body"));
    assert!(fixture.agent.join("skills/demo-skill").read_dir().unwrap().count() == 1);

    fs::write(&source, "---\nname: other-skill\n---\nno description\n").unwrap();
    let error = install_vinculum_skill_at(&fixture.agent, &source, false).unwrap_err();
    assert!(error.contains("description"), "{error}");
    assert!(!fixture.agent.join("skills/other-skill").exists());
}

#[test]
fn zip_installs_one_skill_directory_and_rejects_escape_symlink_and_oversize() {
    let fixture = InventoryFixture::new();
    let zip_path = fixture.root.join("skill.zip");
    let body = skill_md("from-zip", "Packed skill", "Packed body");
    write_skill_zip(&zip_path, &[("bundle/SKILL.md", &body), ("bundle/scripts/run.sh", "echo hi")], None);
    let installed = install_vinculum_skill_at(&fixture.agent, &zip_path, false).unwrap();
    assert_eq!(installed.name, "from-zip");
    assert_eq!(fs::read_to_string(fixture.agent.join("skills/from-zip/scripts/run.sh")).unwrap(), "echo hi");
    assert!(!fixture.agent.join("skills/bundle").exists());

    write_skill_zip(&zip_path, &[("../SKILL.md", &body)], None);
    let error = install_vinculum_skill_at(&fixture.agent, &zip_path, false).unwrap_err();
    assert!(error.contains("escapes") || error.contains("absolute"), "{error}");
    assert!(!fixture.agent.join("SKILL.md").exists());

    write_skill_zip(&zip_path, &[("SKILL.md", &body)], Some(("scripts/link", 0o120777)));
    let error = install_vinculum_skill_at(&fixture.agent, &zip_path, true).unwrap_err();
    assert!(error.contains("symlink"), "{error}");

    let huge = fixture.root.join("huge.zip");
    let mut fat = body.clone();
    fat.push_str(&"x".repeat(8 * 1024 * 1024));
    write_skill_zip(&huge, &[("SKILL.md", &fat)], None);
    let error = install_vinculum_skill_at(&fixture.agent, &huge, false).unwrap_err();
    assert!(error.contains("8 MiB"), "{error}");
    assert!(fixture.agent.join("skills/from-zip/SKILL.md").is_file());
}

#[test]
fn replace_asks_by_leaving_the_directory_until_confirmed() {
    let fixture = InventoryFixture::new();
    let source = fixture.root.join("demo.md");
    fs::write(&source, skill_md("demo-skill", "First", "first body")).unwrap();
    install_vinculum_skill_at(&fixture.agent, &source, false).unwrap();
    fs::write(&source, skill_md("demo-skill", "Second", "second body")).unwrap();
    let pending = install_vinculum_skill_at(&fixture.agent, &source, false).unwrap();
    assert!(pending.exists);
    assert!(fs::read_to_string(fixture.agent.join("skills/demo-skill/SKILL.md")).unwrap().contains("first body"));
    let replaced = install_vinculum_skill_at(&fixture.agent, &source, true).unwrap();
    assert!(!replaced.exists);
    assert!(fs::read_to_string(fixture.agent.join("skills/demo-skill/SKILL.md")).unwrap().contains("second body"));
}

#[test]
fn delete_unlinks_a_skill_symlink_without_removing_the_target() {
    let fixture = InventoryFixture::new();
    let outside = fixture.root.join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("keep"), "safe").unwrap();
    fs::create_dir_all(fixture.agent.join("skills")).unwrap();
    symlink(&outside, fixture.agent.join("skills/linked")).unwrap();
    delete_vinculum_skill_at(&fixture.agent, "linked").unwrap();
    assert!(!fixture.agent.join("skills/linked").exists());
    assert_eq!(fs::read_to_string(outside.join("keep")).unwrap(), "safe");
}

#[test]
fn customization_prompt_quotes_the_agent_directory_and_does_not_dump_secrets() {
    let root = std::env::temp_dir().join(format!("alinery-prompt-{}", uuid::Uuid::new_v4()));
    let install = root.join("Alinery's $(touch INJECTED) 日本語");
    let app_config = install.join("app.toml");
    let (agent_dir, _) = alinery_core::vinculum_home_dirs(&app_config);
    fs::create_dir_all(&agent_dir).unwrap();
    fs::write(agent_dir.join("mcp.json"), "private-content-mcp").unwrap();
    fs::create_dir_all(agent_dir.join("skills/demo")).unwrap();
    fs::write(agent_dir.join("skills/demo/SKILL.md"), "private-content-skill").unwrap();
    let prompt = render_vinculum_customization_prompt(&app_config, "ai.delegance.alinery.dev");
    assert!(prompt.contains("pi-durable"));
    assert!(prompt.contains("1.3.0"));
    assert!(!prompt.contains("oh-my-pi"));
    assert!(!prompt.contains("v18.1.13"));
    assert!(!prompt.contains("private-content"));
    assert!(!prompt.contains("providers.alinery"));
    let start = prompt.find("\n(\n").unwrap();
    let end = prompt[start..].find("\n)\n").unwrap() + start + 3;
    let output = Command::new("/bin/sh").arg("-c").arg(&prompt[start..end]).current_dir(&root).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("SKILL.md"));
    assert!(stdout.contains("mcp.json"));
    assert!(!stdout.contains("private-content"));
    assert!(!root.join("INJECTED").exists());
    fs::remove_dir_all(root).unwrap();
}
