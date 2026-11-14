//! What an older Alinery left behind under its removed `omp` harness, and the confirmed Back up and reset that clears it.
//! Nothing reads `omp` as Vinculum: a project holding such sessions is held (`repo_ownership`) until the user resets it,
//! and the reset renames the harness in the settings and playbook files it keeps.
use std::fs;
use std::path::Path;

/// The removed harness's key, as an older Alinery wrote it.
const OLDER_HARNESS: &str = "omp";

/// The banner's evidence line for a held project; the shell's `outdated` flag is what picks the copy.
pub const OLDER_SESSIONS_ISSUE: &str = "this project has sessions from an older version of Alinery";

/// Whether a sessions directory holds an older Alinery's session: its `<id>.omp/` journal or a meta naming `omp`.
pub fn has_older_sessions(dir: &Path) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.ends_with(".omp") {
            return true;
        }
        name.ends_with(".meta.json")
            && fs::read(entry.path())
                .ok()
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
                .is_some_and(|meta| meta.get("harness").and_then(|h| h.as_str()) == Some(OLDER_HARNESS))
    })
}

/// `harness = "omp"` and `default_harness = "omp"` lines renamed to `vinculum`; `None` when there are none.
/// Line-level so a hand-edited file keeps its comments and layout.
pub fn rename_older_harness_lines(text: &str) -> Option<String> {
    let mut changed = false;
    let out: Vec<String> = text
        .split_inclusive('\n')
        .map(|line| {
            let body = line.trim_end_matches(['\n', '\r']);
            let Some((key, value)) = body.split_once('=') else {
                return line.to_string();
            };
            let key = key.trim();
            if (key == "harness" || key == "default_harness") && value.trim() == format!("\"{OLDER_HARNESS}\"") {
                changed = true;
                return line.replacen(&format!("\"{OLDER_HARNESS}\""), "\"vinculum\"", 1);
            }
            line.to_string()
        })
        .collect();
    changed.then(|| out.concat())
}

/// Renames the older harness in every `.toml` and `.md` file at or under each root (a file, or a directory walked
/// recursively; a missing root is skipped). Returns how many files changed.
pub fn rename_older_harness_in(roots: &[&Path]) -> Result<usize, String> {
    fn visit(path: &Path, changed: &mut usize) -> Result<(), String> {
        let Ok(metadata) = fs::symlink_metadata(path) else {
            return Ok(());
        };
        if metadata.is_dir() {
            let entries = fs::read_dir(path).map_err(|e| format!("read {}: {e}", path.display()))?;
            for entry in entries {
                visit(&entry.map_err(|e| format!("read {}: {e}", path.display()))?.path(), changed)?;
            }
        } else if metadata.is_file() && path.extension().is_some_and(|ext| ext == "toml" || ext == "md") {
            let Ok(text) = fs::read_to_string(path) else {
                return Ok(());
            };
            if let Some(next) = rename_older_harness_lines(&text) {
                crate::write_bytes_atomic(path, next.as_bytes())?;
                *changed += 1;
            }
        }
        Ok(())
    }
    let mut changed = 0;
    for root in roots {
        visit(root, &mut changed)?;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_harness_keys_naming_the_older_harness_are_renamed() {
        let text = "+++\nkey = \"mine\"\ndefault_harness = \"omp\"\n\n[[step]]\nharness  =  \"omp\"\nmodel = \"omp\"\nharness = \"vinculum\"\n+++\nharness = \"omp\" in prose\n";
        let next = rename_older_harness_lines(text).unwrap();
        assert_eq!(
            next,
            "+++\nkey = \"mine\"\ndefault_harness = \"vinculum\"\n\n[[step]]\nharness  =  \"vinculum\"\nmodel = \"omp\"\nharness = \"vinculum\"\n+++\nharness = \"omp\" in prose\n"
        );
        assert_eq!(rename_older_harness_lines("harness = \"vinculum\"\n"), None);
    }

    #[test]
    fn older_sessions_are_a_journal_folder_or_a_meta_naming_the_older_harness() {
        let dir = std::env::temp_dir().join(format!("alinery-older-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        assert!(!has_older_sessions(&dir));
        fs::write(dir.join("a.meta.json"), r#"{"harness":"vinculum"}"#).unwrap();
        assert!(!has_older_sessions(&dir));
        fs::write(dir.join("b.meta.json"), r#"{"harness":"omp"}"#).unwrap();
        assert!(has_older_sessions(&dir));
        fs::remove_file(dir.join("b.meta.json")).unwrap();
        fs::create_dir(dir.join("c.omp")).unwrap();
        assert!(has_older_sessions(&dir));
        assert!(!has_older_sessions(&dir.join("missing")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn files_under_the_roots_are_renamed_and_others_left() {
        let root = std::env::temp_dir().join(format!("alinery-older-files-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("playbooks/mine")).unwrap();
        fs::write(root.join("config.toml"), "[defaults]\nharness = \"omp\"\nmodel = \"m\"\n").unwrap();
        fs::write(root.join("playbooks/mine/playbook.md"), "+++\ndefault_harness = \"omp\"\n+++\n").unwrap();
        fs::write(root.join("playbooks/mine/notes.txt"), "harness = \"omp\"\n").unwrap();
        let changed = rename_older_harness_in(&[&root.join("config.toml"), &root.join("playbooks"), &root.join("absent")]).unwrap();
        assert_eq!(changed, 2);
        assert_eq!(fs::read_to_string(root.join("config.toml")).unwrap(), "[defaults]\nharness = \"vinculum\"\nmodel = \"m\"\n");
        assert_eq!(
            fs::read_to_string(root.join("playbooks/mine/playbook.md")).unwrap(),
            "+++\ndefault_harness = \"vinculum\"\n+++\n"
        );
        assert_eq!(fs::read_to_string(root.join("playbooks/mine/notes.txt")).unwrap(), "harness = \"omp\"\n");
        let _ = fs::remove_dir_all(&root);
    }
}
