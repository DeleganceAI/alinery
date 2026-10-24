//! Human review comments on a task's artifacts: the comment, draft and review-pending files, the
//! prepared "address these comments" prompt, and the helpers behind them. It lives in core so a
//! remote host runs the same code a local repo does; the app only routes to it.

use crate::{artifact_file_path, artifacts_dir, write_bytes_atomic};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("remove {}: {error}", path.display())),
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct PreparedSessionMessageAction {
    pub text: String,
    pub provenance: SessionMessageActionProvenance,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct PreparedArtifactCommentSnapshot {
    pub artifact: String,
    pub review: String,
    pub comments_hash: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionMessageActionProvenance {
    ArtifactComments { items: Vec<PreparedArtifactCommentSnapshot> },
    ReviewApproval { review_artifact: String },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ArtifactComment {
    pub id: String,
    pub artifact: String,
    pub anchor_id: String,
    pub anchor_kind: String,
    pub anchor_label: String,
    pub anchor_excerpt: String,
    pub line_start: u32,
    pub line_end: u32,
    pub body: String,
    pub created_at_ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ArtifactCommentsFile {
    pub version: u32,
    pub artifact: String,
    pub comments: Vec<ArtifactComment>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ArtifactCommentDraft {
    pub artifact: String,
    pub anchor_id: String,
    pub anchor_kind: String,
    pub anchor_label: String,
    pub anchor_excerpt: String,
    pub line_start: u32,
    pub line_end: u32,
    pub body: String,
    pub artifact_hash: String,
    pub updated_at_ms: u64,
    #[serde(skip)]
    pub stale: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ArtifactCommentDraftsFile {
    pub version: u32,
    pub drafts: Vec<ArtifactCommentDraft>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ArtifactReviewPendingFile {
    pub version: u32,
    pub artifact: String,
    pub review: String,
    pub artifact_hash_at_send: String,
    pub created_at_ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ArtifactReviewPendingStatus {
    pub artifact: String,
    pub review: String,
}

/// What a reviewer typed: where in the artifact it is anchored, and the text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommentInput {
    pub anchor_id: String,
    pub anchor_kind: String,
    pub anchor_label: String,
    pub anchor_excerpt: String,
    pub line_start: u32,
    pub line_end: u32,
    pub body: String,
}

pub fn read_artifact_text(repo: &Path, task_slug: &str, name: &str) -> Result<String, String> {
    let path = artifact_file_path(repo, task_slug, name)?;
    fs::read_to_string(&path).map_err(|error| format!("read {}: {error}", path.display()))
}

pub fn artifact_comment_stem(name: &str) -> String {
    Path::new(name).with_extension("").to_string_lossy().into_owned()
}

pub fn artifact_comment_json_path(repo: &Path, slug: &str, artifact: &str) -> Result<PathBuf, String> {
    artifact_file_path(repo, slug, artifact)?;
    artifact_file_path(repo, slug, &format!("{}.comments.json", artifact_comment_stem(artifact)))
}

pub fn artifact_comment_drafts_path(repo: &Path, slug: &str) -> Result<PathBuf, String> {
    let slug = crate::safe_component(slug).ok_or("invalid task slug")?;
    crate::resolve_artifact_path(repo, &format!(".alinery/tasks/{slug}/artifact-comment-drafts.json"))
}

pub fn artifact_comment_markdown_path(repo: &Path, slug: &str, artifact: &str) -> Result<PathBuf, String> {
    artifact_file_path(repo, slug, artifact)?;
    artifact_file_path(repo, slug, &format!("{}.comments.md", artifact_comment_stem(artifact)))
}

pub fn artifact_review_pending_path(repo: &Path, slug: &str, artifact: &str) -> Result<PathBuf, String> {
    artifact_file_path(repo, slug, artifact)?;
    artifact_file_path(repo, slug, &format!("{}.review-pending.json", artifact_comment_stem(artifact)))
}

pub fn artifact_text_hash(text: &str) -> String {
    // ponytail: non-cryptographic hash only gates stale UI; use SHA-256 if this becomes a trust boundary.
    let mut hash = 0xcbf29ce484222325u64;
    for byte in text.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

pub fn artifact_hash_for(repo: &Path, slug: &str, artifact: &str) -> Result<String, String> {
    let path = artifact_file_path(repo, slug, artifact)?;
    let text = fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    Ok(artifact_text_hash(&text))
}

pub fn clamp_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

pub fn escape_comment_markdown(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

pub fn load_artifact_comments_for(repo: &Path, slug: &str, artifact: &str) -> Result<Vec<ArtifactComment>, String> {
    let path = artifact_comment_json_path(repo, slug, artifact)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read artifact comments {}: {e}", path.display()))?;
    let file: ArtifactCommentsFile = serde_json::from_str(&raw).map_err(|e| format!("parse artifact comments {}: {e}", path.display()))?;
    Ok(file.comments)
}

pub fn load_artifact_comment_drafts_for(repo: &Path, slug: &str) -> Result<Vec<ArtifactCommentDraft>, String> {
    let path = artifact_comment_drafts_path(repo, slug)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read artifact comment drafts {}: {e}", path.display()))?;
    let file: ArtifactCommentDraftsFile = serde_json::from_str(&raw).map_err(|e| format!("parse artifact comment drafts {}: {e}", path.display()))?;
    Ok(file.drafts)
}

pub fn write_artifact_comment_drafts_for(repo: &Path, slug: &str, drafts: &[ArtifactCommentDraft]) -> Result<(), String> {
    let path = artifact_comment_drafts_path(repo, slug)?;
    if drafts.is_empty() {
        return remove_file_if_exists(&path);
    }
    let file = ArtifactCommentDraftsFile {
        version: 1,
        drafts: drafts.to_vec(),
    };
    let bytes = serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?;
    write_bytes_atomic(&path, &bytes).map_err(|e| format!("write artifact comment drafts {}: {e}", path.display()))
}

pub fn list_artifact_comment_drafts_for(repo: &Path, slug: &str) -> Result<Vec<ArtifactCommentDraft>, String> {
    let mut drafts = load_artifact_comment_drafts_for(repo, slug)?;
    let mut hashes: HashMap<String, String> = HashMap::new();
    for draft in &mut drafts {
        let current_hash = if let Some(hash) = hashes.get(&draft.artifact) {
            Some(hash.clone())
        } else {
            let hash = artifact_hash_for(repo, slug, &draft.artifact).ok();
            if let Some(hash) = &hash {
                hashes.insert(draft.artifact.clone(), hash.clone());
            }
            hash
        };
        draft.stale = current_hash.as_deref() != Some(draft.artifact_hash.as_str());
    }
    Ok(drafts)
}

#[allow(clippy::too_many_arguments)]
pub fn save_artifact_comment_draft_for(
    repo: &Path,
    slug: &str,
    artifact: &str,
    anchor_id: String,
    anchor_kind: String,
    anchor_label: String,
    anchor_excerpt: String,
    line_start: u32,
    line_end: u32,
    body: String,
) -> Result<(), String> {
    if body.is_empty() {
        return delete_artifact_comment_draft_for(repo, slug, artifact, &anchor_id);
    }
    let artifact_hash = artifact_hash_for(repo, slug, artifact)?;
    let updated_at_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    let mut drafts = load_artifact_comment_drafts_for(repo, slug)?;
    drafts.retain(|draft| draft.artifact != artifact || draft.anchor_id != anchor_id);
    drafts.push(ArtifactCommentDraft {
        artifact: artifact.to_string(),
        anchor_id,
        anchor_kind,
        anchor_label: clamp_chars(&anchor_label, 120),
        anchor_excerpt: clamp_chars(&anchor_excerpt, 500),
        line_start,
        line_end,
        body,
        artifact_hash,
        updated_at_ms,
        stale: false,
    });
    drafts.sort_by(|a, b| {
        a.artifact
            .cmp(&b.artifact)
            .then(a.line_start.cmp(&b.line_start))
            .then(a.updated_at_ms.cmp(&b.updated_at_ms))
    });
    write_artifact_comment_drafts_for(repo, slug, &drafts)
}

pub fn delete_artifact_comment_draft_for(repo: &Path, slug: &str, artifact: &str, anchor_id: &str) -> Result<(), String> {
    artifact_file_path(repo, slug, artifact)?;
    let mut drafts = load_artifact_comment_drafts_for(repo, slug)?;
    drafts.retain(|draft| draft.artifact != artifact || draft.anchor_id != anchor_id);
    write_artifact_comment_drafts_for(repo, slug, &drafts)
}

pub fn write_artifact_comment_markdown(repo: &Path, slug: &str, artifact: &str, comments: &[ArtifactComment]) -> Result<(), String> {
    let path = artifact_comment_markdown_path(repo, slug, artifact)?;
    let stem = artifact_comment_stem(artifact);
    let mut markdown =
        format!("# Human comments for {artifact}\n\nGenerated by Alinery from `{stem}.comments.json`. Read this file alongside `{artifact}` before acting on the design.\n");

    for comment in comments {
        let label = escape_comment_markdown(&comment.anchor_label);
        let excerpt = escape_comment_markdown(&comment.anchor_excerpt);
        let body = escape_comment_markdown(&comment.body);
        markdown.push_str(&format!(
            "\n## Comment {} — {}\n\n- Anchor: `{}`\n- Lines: {}-{}\n\nContext:\n\n",
            comment.id, label, comment.anchor_id, comment.line_start, comment.line_end
        ));
        for line in excerpt.lines() {
            markdown.push_str("> ");
            markdown.push_str(line);
            markdown.push('\n');
        }
        markdown.push_str(&format!(
            "\n<comment id=\"{}\" line_start=\"{}\" line_end=\"{}\">\n{}\n</comment>\n",
            comment.id, comment.line_start, comment.line_end, body
        ));
    }

    fs::write(&path, markdown).map_err(|e| format!("write {}: {e}", path.display()))
}

pub fn next_artifact_review_markdown_path(repo: &Path, slug: &str, artifact: &str) -> Result<PathBuf, String> {
    artifact_file_path(repo, slug, artifact)?;
    let stem = artifact_comment_stem(artifact);
    for idx in 1..=999 {
        let candidate = artifact_file_path(repo, slug, &format!("{stem}.review-{idx:03}.md"))?;
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(format!("too many review files for {artifact}"))
}

pub fn write_artifact_review_pending(repo: &Path, slug: &str, artifact: &str, review_path: &Path) -> Result<(), String> {
    let path = artifact_review_pending_path(repo, slug, artifact)?;
    let created_at_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    let review = artifact_relative_name(repo, slug, review_path)?;
    let file = ArtifactReviewPendingFile {
        version: 1,
        artifact: artifact.to_string(),
        review,
        artifact_hash_at_send: artifact_hash_for(repo, slug, artifact)?,
        created_at_ms,
    };
    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| format!("write {}: {e}", path.display()))
}

pub fn artifact_review_pending_status_for(repo: &Path, slug: &str, artifact: &str) -> Result<Option<ArtifactReviewPendingStatus>, String> {
    let path = artifact_review_pending_path(repo, slug, artifact)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let pending: ArtifactReviewPendingFile = serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", path.display()))?;
    if pending.artifact != artifact {
        remove_file_if_exists(&path)?;
        return Ok(None);
    }
    if artifact_hash_for(repo, slug, artifact)? != pending.artifact_hash_at_send {
        remove_file_if_exists(&path)?;
        return Ok(None);
    }
    Ok(Some(ArtifactReviewPendingStatus {
        artifact: pending.artifact,
        review: pending.review,
    }))
}

pub fn clear_artifact_review_pending_for(repo: &Path, slug: &str, artifact: &str) -> Result<(), String> {
    remove_file_if_exists(&artifact_review_pending_path(repo, slug, artifact)?)
}

fn prepared_review_path(repo: &Path, slug: &str, artifact: &str, markdown: &str) -> Result<PathBuf, String> {
    artifact_file_path(repo, slug, artifact)?;
    let stem = artifact_comment_stem(artifact);
    let mut first_available = None;
    for idx in 1..=999 {
        let candidate = artifact_file_path(repo, slug, &format!("{stem}.review-{idx:03}.md"))?;
        if candidate.exists() {
            if fs::read_to_string(&candidate).map_err(|error| format!("read {}: {error}", candidate.display()))? == markdown {
                return Ok(candidate);
            }
        } else if first_available.is_none() {
            first_available = Some(candidate);
        }
    }
    first_available.ok_or_else(|| format!("too many review files for {artifact}"))
}

fn artifact_relative_name(repo: &Path, slug: &str, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(artifacts_dir(repo, slug))
        .ok()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("invalid artifact path: {}", path.display()))?;
    artifact_file_path(repo, slug, relative)?;
    Ok(relative.to_string())
}

pub fn prepare_artifact_comments_prompt_for(repo: &Path, slug: &str, artifacts: &[String]) -> Result<PreparedSessionMessageAction, String> {
    if artifacts.is_empty() {
        return Err("no artifact comments selected".into());
    }
    let mut items = Vec::with_capacity(artifacts.len());
    let mut prompt_rows = Vec::with_capacity(artifacts.len());
    for artifact in artifacts {
        let comments = load_artifact_comments_for(repo, slug, artifact)?;
        if comments.is_empty() {
            return Err(format!("no comments to prepare for {artifact}"));
        }
        write_artifact_comment_markdown(repo, slug, artifact, &comments)?;
        let markdown_path = artifact_comment_markdown_path(repo, slug, artifact)?;
        let markdown = fs::read_to_string(&markdown_path).map_err(|error| format!("read {}: {error}", markdown_path.display()))?;
        let review_path = prepared_review_path(repo, slug, artifact, &markdown)?;
        if !review_path.exists() {
            fs::write(&review_path, markdown.as_bytes()).map_err(|error| format!("write {}: {error}", review_path.display()))?;
        }
        let review = artifact_relative_name(repo, slug, &review_path)?;
        items.push(PreparedArtifactCommentSnapshot {
            artifact: artifact.clone(),
            review,
            comments_hash: artifact_text_hash(&markdown),
        });
        prompt_rows.push(format!("- `{artifact}` → `{}`", review_path.display()));
    }
    let text = if prompt_rows.len() == 1 {
        format!(
            "Human review comments were added for `{}`. Read `{}`, address each comment in this session, and update `{}` if the design should change; otherwise explain why no change is needed.",
            items[0].artifact,
            artifact_file_path(repo, slug, &items[0].review)?.display(),
            items[0].artifact
        )
    } else {
        [
            "Human review comments were added for multiple artifacts:".to_string(),
            prompt_rows.join("\n"),
            String::new(),
            "Read each review file alongside its paired artifact, address every comment in this session, and update the corresponding artifact when needed; otherwise explain why no change is needed.".to_string(),
        ]
        .join("\n")
    };
    Ok(PreparedSessionMessageAction {
        text,
        provenance: SessionMessageActionProvenance::ArtifactComments { items },
    })
}

pub fn validate_artifact_comments_finalization(repo: &Path, slug: &str, items: &[PreparedArtifactCommentSnapshot]) -> Result<(), String> {
    if items.is_empty() {
        return Err("artifact comment provenance is empty".into());
    }
    for item in items {
        artifact_file_path(repo, slug, &item.artifact)?;
        let stem = artifact_comment_stem(&item.artifact);
        let review_suffix = item.review.strip_prefix(&format!("{stem}.review-")).and_then(|value| value.strip_suffix(".md"));
        if !review_suffix.is_some_and(|value| value.len() == 3 && value.bytes().all(|byte| byte.is_ascii_digit())) {
            return Err(format!("invalid prepared review for {}", item.artifact));
        }
        let review_path = artifact_file_path(repo, slug, &item.review)?;
        let review = fs::read_to_string(&review_path).map_err(|error| format!("read {}: {error}", review_path.display()))?;
        if artifact_text_hash(&review) != item.comments_hash {
            return Err(format!("prepared review hash mismatch for {}", item.artifact));
        }
    }
    Ok(())
}

pub fn finalize_artifact_comments_for(repo: &Path, slug: &str, items: &[PreparedArtifactCommentSnapshot]) -> Result<(), String> {
    validate_artifact_comments_finalization(repo, slug, items)?;
    for item in items {
        let review_path = artifact_file_path(repo, slug, &item.review)?;
        let pending_path = artifact_review_pending_path(repo, slug, &item.artifact)?;
        let already_finalized = fs::read_to_string(&pending_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<ArtifactReviewPendingFile>(&raw).ok())
            .is_some_and(|pending| pending.artifact == item.artifact && pending.review == item.review);
        if !already_finalized {
            write_artifact_review_pending(repo, slug, &item.artifact, &review_path)?;
        }
        let markdown_path = artifact_comment_markdown_path(repo, slug, &item.artifact)?;
        let matches_prepared = fs::read_to_string(&markdown_path)
            .ok()
            .is_some_and(|markdown| artifact_text_hash(&markdown) == item.comments_hash);
        if matches_prepared {
            remove_file_if_exists(&artifact_comment_json_path(repo, slug, &item.artifact)?)?;
            remove_file_if_exists(&markdown_path)?;
        }
    }
    Ok(())
}

pub fn archive_artifact_comments_for(repo: &Path, slug: &str, artifact: &str) -> Result<PathBuf, String> {
    let comments = load_artifact_comments_for(repo, slug, artifact)?;
    if comments.is_empty() {
        return Err(format!("no comments to archive for {artifact}"));
    }

    let markdown_path = artifact_comment_markdown_path(repo, slug, artifact)?;
    if !markdown_path.exists() {
        write_artifact_comment_markdown(repo, slug, artifact, &comments)?;
    }

    let review_path = next_artifact_review_markdown_path(repo, slug, artifact)?;
    fs::copy(&markdown_path, &review_path).map_err(|e| format!("copy {} to {}: {e}", markdown_path.display(), review_path.display()))?;
    write_artifact_review_pending(repo, slug, artifact, &review_path)?;
    remove_file_if_exists(&artifact_comment_json_path(repo, slug, artifact)?)?;
    remove_file_if_exists(&markdown_path)?;
    Ok(review_path)
}

pub fn add_artifact_comment_for(
    repo: &Path,
    slug: &str,
    artifact: &str,
    anchor_id: String,
    anchor_kind: String,
    anchor_label: String,
    anchor_excerpt: String,
    line_start: u32,
    line_end: u32,
    body: String,
) -> Result<Vec<ArtifactComment>, String> {
    let body = body.trim().to_string();
    if body.is_empty() {
        return Err("comment body is empty".into());
    }

    let mut comments = load_artifact_comments_for(repo, slug, artifact)?;
    let created_at_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    let mut id = format!("c{created_at_ms}");
    let mut suffix = 2;
    while comments.iter().any(|comment| comment.id == id) {
        id = format!("c{created_at_ms}_{suffix}");
        suffix += 1;
    }

    comments.push(ArtifactComment {
        id,
        artifact: artifact.to_string(),
        anchor_id,
        anchor_kind,
        anchor_label: clamp_chars(&anchor_label, 120),
        anchor_excerpt: clamp_chars(&anchor_excerpt, 500),
        line_start,
        line_end,
        body,
        created_at_ms,
    });
    comments.sort_by_key(|comment| (comment.line_start, comment.created_at_ms));

    let path = artifact_comment_json_path(repo, slug, artifact)?;
    let dir = path.parent().ok_or_else(|| format!("invalid artifact comments path: {}", path.display()))?;
    fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    let file = ArtifactCommentsFile {
        version: 1,
        artifact: artifact.to_string(),
        comments: comments.clone(),
    };
    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| format!("write {}: {e}", path.display()))?;
    write_artifact_comment_markdown(repo, slug, artifact, &comments)?;
    Ok(comments)
}

pub fn prepare_review_approval_prompt_for(repo: &Path, task_slug: &str, review_artifact: &str) -> Result<PreparedSessionMessageAction, String> {
    let task = crate::board::read_task_checked(repo, task_slug)?;
    let artifact_path = artifact_file_path(repo, task_slug, review_artifact)?;
    let metadata = fs::metadata(&artifact_path).map_err(|error| format!("read {}: {error}", artifact_path.display()))?;
    if !metadata.is_file() {
        return Err(format!("review findings artifact is not a file: {}", artifact_path.display()));
    }
    let artifact_path = fs::canonicalize(&artifact_path).map_err(|error| format!("resolve {}: {error}", artifact_path.display()))?;
    let pr = if task.pr_url.is_empty() {
        "PR URL: not set in Alinery task metadata; infer it from the checked-out branch/remote if possible.".to_string()
    } else {
        format!("PR URL: {}", task.pr_url)
    };
    Ok(PreparedSessionMessageAction {
        text: [
            "Review playbook action: approve this PR through the harness, not through Alinery.".to_string(),
            pr,
            format!("Review findings artifact: {review_artifact}"),
            format!("Review findings path: {}", artifact_path.display()),
            "Read the findings artifact. If it contains no blocking work, submit an approving GitHub PR review or comment using your own GitHub capability.".to_string(),
            "Do not ask Alinery/the local app to call a GitHub approval API; the approval/comment is harness-owned.".to_string(),
            "After submitting or deciding not to submit, write or update the review-response artifact with the decision and evidence.".to_string(),
        ]
        .join("\n"),
        provenance: SessionMessageActionProvenance::ReviewApproval {
            review_artifact: review_artifact.to_string(),
        },
    })
}

pub fn finalize_session_message_actions_for(repo: &Path, id: &str, task_slug: &str, actions: &[SessionMessageActionProvenance]) -> Result<(), String> {
    let session = crate::board::load_session_meta(repo, task_slug, id)?;
    if session.id != id {
        return Err("session id mismatch".into());
    }
    for action in actions {
        match action {
            SessionMessageActionProvenance::ArtifactComments { items } => {
                validate_artifact_comments_finalization(repo, task_slug, items)?;
            }
            SessionMessageActionProvenance::ReviewApproval { review_artifact } => {
                artifact_file_path(repo, task_slug, review_artifact)?;
            }
        }
    }
    for action in actions {
        match action {
            SessionMessageActionProvenance::ArtifactComments { items } => {
                finalize_artifact_comments_for(repo, task_slug, items)?;
            }
            SessionMessageActionProvenance::ReviewApproval { .. } => {}
        }
    }
    Ok(())
}
