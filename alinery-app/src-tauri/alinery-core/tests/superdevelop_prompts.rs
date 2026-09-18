use alinery_core::{load_playbook_catalog, resolve_playbook, PlaybookRef, PlaybookRoots, PlaybookScope};
use std::fs;

#[test]
fn loading_canonical_playbooks_preserves_but_never_resolves_legacy_sources() {
    let repo = std::env::temp_dir().join(format!("alinery-no-migration-{}", uuid::Uuid::new_v4()));
    let legacy_dir = repo.join(".alinery/playbooks/superdevelop");
    fs::create_dir_all(&legacy_dir).unwrap();
    let config = repo.join(".alinery/playbooks.toml");
    let original = "version = 1\ndefault = \"custom\"\n[playbooks.custom]\ntitle = \"User-owned\"\nsteps = []\n";
    fs::write(&config, original).unwrap();
    let legacy_prompt = legacy_dir.join("01-clarify.md");
    fs::write(&legacy_prompt, "User-owned legacy prompt").unwrap();
    let roots = PlaybookRoots { global_config_dir: repo.join("config"), repo_dir: repo.clone() };
    let catalog = load_playbook_catalog(&roots);
    let bundled = resolve_playbook(&roots, &PlaybookRef { scope: PlaybookScope::Bundled, key: "superdevelop".into() });
    let legacy = resolve_playbook(&roots, &PlaybookRef { scope: PlaybookScope::Repo, key: "custom".into() });
    let config_after = fs::read_to_string(&config).unwrap();
    let prompt_after = fs::read_to_string(&legacy_prompt).unwrap();
    let generated_canonical = legacy_dir.join("playbook.md").exists();
    fs::remove_dir_all(repo).unwrap();

    assert!(bundled.is_ok(), "{bundled:?}");
    assert!(legacy.is_err());
    assert!(catalog.candidates.iter().all(|candidate| candidate.source.reference.scope != PlaybookScope::Repo));
    assert_eq!(config_after, original);
    assert_eq!(prompt_after, "User-owned legacy prompt");
    assert!(!generated_canonical);
}
