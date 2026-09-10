use alinery_core::{ensure_playbooks, load_playbooks, resolve_playbook_step_prompt, PromptVars};
use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn superdevelop_seeds_seven_complete_prompts_and_notices_and_preserves_custom_files() {
    let repo = std::env::temp_dir().join(format!(
        "alinery-prompts-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
    ));
    ensure_playbooks(&repo).unwrap();
    let registry = load_playbooks(&repo);
    let playbook = &registry.playbooks["superdevelop"];
    let titles = ["Clarify", "Investigate", "Decide", "Plan", "Define Tests", "Build", "Prepare Review"];
    assert_eq!(playbook.steps.len(), titles.len());
    let artifacts = repo.join("artifacts with spaces");
    let assigned = artifacts.join("result-002.md");
    let handoff = artifacts.join("handoff.md");
    let ticket = repo.join("task.md");
    for (key, title) in playbook.steps.iter().zip(titles) {
        let step = &playbook.step[key];
        assert_eq!(step.title, title);
        let path = repo.join(".alinery").join(&step.prompt);
        let seeded = fs::read_to_string(&path).unwrap();
        assert_eq!(seeded.matches("## Common session instructions").count(), 1);
        assert!(seeded.contains(&format!("# {title}")));
        let vars = PromptVars {
            artifacts_dir: &artifacts,
            artifact_file: &assigned,
            review_handoff_file: Some(&handoff),
            prompt_extra: "specific extra instruction",
            session_history_dir: &repo,
            task_name: "Example",
            task_slug: "example",
            worktree: "/tmp/worktree with spaces",
            playbook_key: "superdevelop",
            phase_key: key,
            phase_title: title,
            ticket_file: &ticket,
        };
        let prompt = resolve_playbook_step_prompt(&repo, "superdevelop", key, &vars).unwrap().unwrap();
        assert!(prompt.contains(assigned.to_str().unwrap()));
        assert!(prompt.contains(handoff.to_str().unwrap()));
        assert_eq!(prompt.matches("specific extra instruction").count(), 1);
        assert!(!prompt.contains("{{"));
        fs::write(&path, "User-owned custom instructions").unwrap();
        ensure_playbooks(&repo).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "User-owned custom instructions");
    }
    for (name, expected) in [
        ("LICENSE.superpowers", include_str!("../../playbooks/superdevelop/LICENSE.superpowers")),
        ("README.md", include_str!("../../playbooks/superdevelop/README.md")),
    ] {
        let path = repo.join(".alinery/playbooks/superdevelop").join(name);
        assert_eq!(fs::read_to_string(&path).unwrap(), expected);
        fs::remove_file(&path).unwrap();
        ensure_playbooks(&repo).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), expected);
        let customized = format!("{expected}\nAdditional downstream attribution.\n");
        fs::write(&path, &customized).unwrap();
        ensure_playbooks(&repo).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), customized);
    }
    fs::remove_dir_all(repo).unwrap();
}

#[test]
fn loading_playbooks_does_not_migrate_existing_configuration() {
    let repo = std::env::temp_dir().join(format!(
        "alinery-no-migration-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
    ));
    fs::create_dir_all(repo.join(".alinery")).unwrap();
    let config = repo.join(".alinery/playbooks.toml");
    let original = "version = 1\ndefault = \"custom\"\n[playbooks.custom]\ntitle = \"User-owned\"\nsteps = []\n";
    fs::write(&config, original).unwrap();
    let registry = load_playbooks(&repo);
    assert_eq!(registry.playbooks.len(), 1);
    assert!(registry.playbooks.contains_key("custom"));
    assert_eq!(fs::read_to_string(config).unwrap(), original);
    fs::remove_dir_all(repo).unwrap();
}
