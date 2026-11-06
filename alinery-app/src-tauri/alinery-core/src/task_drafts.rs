//! Task drafts: the half-written task a person autosaves before creating it. A draft is files only
//! (`task.md`, a ticket artifact, an attachments file), so a remote host writes it with the same
//! code a local repo uses.
use std::path::Path;

// kebab-case: lowercase alnum runs joined by single dashes, no leading/trailing dash.
pub fn slugify(name: &str) -> String {
    let mut s = String::new();
    let mut prev_dash = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if !s.is_empty() && !prev_dash {
            s.push('-');
            prev_dash = true;
        }
    }
    let s = s.trim_end_matches('-').to_string();
    if s.is_empty() {
        "task".to_string()
    } else {
        s
    }
}

pub fn branch_ref_conflicts(repo: &Path, candidate: &str) -> bool {
    let Ok(out) = crate::git_cmd(repo).args(["for-each-ref", "--format=%(refname:strip=2)", "refs/heads"]).output() else {
        return false;
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .any(|existing| crate::branch_names_conflict(existing, candidate))
}

// Dedupe so dir, branch, and worktree path are all unique (-2, -3, …). `git
// worktree add -b` fails if the branch OR path already exists — check all three.
// Archived drafts require explicit restore. Autosave and create must treat their slugs as occupied.
