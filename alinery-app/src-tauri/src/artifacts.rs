//! artifacts: extracted from lib.rs. See AGENTS.md for the module map.
use crate::*;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub(crate) struct ArtifactComment {
    pub(crate) id: String,
    pub(crate) artifact: String,
    pub(crate) anchor_id: String,
    pub(crate) anchor_kind: String,
    pub(crate) anchor_label: String,
    pub(crate) anchor_excerpt: String,
    pub(crate) line_start: u32,
    pub(crate) line_end: u32,
    pub(crate) body: String,
    pub(crate) created_at_ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub(crate) struct ArtifactCommentsFile {
    pub(crate) version: u32,
    pub(crate) artifact: String,
    pub(crate) comments: Vec<ArtifactComment>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub(crate) struct ArtifactCommentDraft {
    pub(crate) artifact: String,
    pub(crate) anchor_id: String,
    pub(crate) anchor_kind: String,
    pub(crate) anchor_label: String,
    pub(crate) anchor_excerpt: String,
    pub(crate) line_start: u32,
    pub(crate) line_end: u32,
    pub(crate) body: String,
    pub(crate) artifact_hash: String,
    pub(crate) updated_at_ms: u64,
    #[serde(skip)]
    pub(crate) stale: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub(crate) struct ArtifactCommentDraftsFile {
    pub(crate) version: u32,
    pub(crate) drafts: Vec<ArtifactCommentDraft>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub(crate) struct ArtifactReviewPendingFile {
    pub(crate) version: u32,
    pub(crate) artifact: String,
    pub(crate) review: String,
    pub(crate) artifact_hash_at_send: String,
    pub(crate) created_at_ms: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub(crate) struct ArtifactReviewPendingStatus {
    pub(crate) artifact: String,
    pub(crate) review: String,
}

pub(crate) fn artifact_comment_stem(name: &str) -> String {
    Path::new(name).file_stem().and_then(|s| s.to_str()).unwrap_or(name).to_string()
}

pub(crate) fn artifact_comment_json_path(repo: &Path, slug: &str, artifact: &str) -> Result<PathBuf, String> {
    let artifact_path = artifact_file_path(repo, slug, artifact)?;
    let stem = artifact_comment_stem(artifact);
    Ok(artifact_path.with_file_name(format!("{stem}.comments.json")))
}

pub(crate) fn artifact_comment_drafts_path(repo: &Path, slug: &str) -> PathBuf {
    task_dir(repo, slug).join("artifact-comment-drafts.json")
}

pub(crate) fn artifact_comment_markdown_path(repo: &Path, slug: &str, artifact: &str) -> Result<PathBuf, String> {
    let artifact_path = artifact_file_path(repo, slug, artifact)?;
    let stem = artifact_comment_stem(artifact);
    Ok(artifact_path.with_file_name(format!("{stem}.comments.md")))
}

pub(crate) fn artifact_review_pending_path(repo: &Path, slug: &str, artifact: &str) -> Result<PathBuf, String> {
    let artifact_path = artifact_file_path(repo, slug, artifact)?;
    let stem = artifact_comment_stem(artifact);
    Ok(artifact_path.with_file_name(format!("{stem}.review-pending.json")))
}

pub(crate) fn artifact_text_hash(text: &str) -> String {
    // ponytail: non-cryptographic hash only gates stale UI; use SHA-256 if this becomes a trust boundary.
    let mut hash = 0xcbf29ce484222325u64;
    for byte in text.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

pub(crate) fn artifact_hash_for(repo: &Path, slug: &str, artifact: &str) -> Result<String, String> {
    let path = artifact_file_path(repo, slug, artifact)?;
    let text = fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    Ok(artifact_text_hash(&text))
}

pub(crate) fn clamp_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

pub(crate) fn escape_comment_markdown(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

pub(crate) fn load_artifact_comments_for(repo: &Path, slug: &str, artifact: &str) -> Result<Vec<ArtifactComment>, String> {
    let path = artifact_comment_json_path(repo, slug, artifact)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read artifact comments {}: {e}", path.display()))?;
    let file: ArtifactCommentsFile = serde_json::from_str(&raw).map_err(|e| format!("parse artifact comments {}: {e}", path.display()))?;
    Ok(file.comments)
}

pub(crate) fn load_artifact_comment_drafts_for(repo: &Path, slug: &str) -> Result<Vec<ArtifactCommentDraft>, String> {
    let path = artifact_comment_drafts_path(repo, slug);
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read artifact comment drafts {}: {e}", path.display()))?;
    let file: ArtifactCommentDraftsFile = serde_json::from_str(&raw).map_err(|e| format!("parse artifact comment drafts {}: {e}", path.display()))?;
    Ok(file.drafts)
}

pub(crate) fn write_artifact_comment_drafts_for(repo: &Path, slug: &str, drafts: &[ArtifactCommentDraft]) -> Result<(), String> {
    let path = artifact_comment_drafts_path(repo, slug);
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

pub(crate) fn list_artifact_comment_drafts_for(repo: &Path, slug: &str) -> Result<Vec<ArtifactCommentDraft>, String> {
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
pub(crate) fn save_artifact_comment_draft_for(
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

pub(crate) fn delete_artifact_comment_draft_for(repo: &Path, slug: &str, artifact: &str, anchor_id: &str) -> Result<(), String> {
    artifact_file_path(repo, slug, artifact)?;
    let mut drafts = load_artifact_comment_drafts_for(repo, slug)?;
    drafts.retain(|draft| draft.artifact != artifact || draft.anchor_id != anchor_id);
    write_artifact_comment_drafts_for(repo, slug, &drafts)
}

pub(crate) fn write_artifact_comment_markdown(repo: &Path, slug: &str, artifact: &str, comments: &[ArtifactComment]) -> Result<(), String> {
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

pub(crate) fn next_artifact_review_markdown_path(repo: &Path, slug: &str, artifact: &str) -> Result<PathBuf, String> {
    let artifact_path = artifact_file_path(repo, slug, artifact)?;
    let stem = artifact_comment_stem(artifact);
    for idx in 1..=999 {
        let candidate = artifact_path.with_file_name(format!("{stem}.review-{idx:03}.md"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(format!("too many review files for {artifact}"))
}

pub(crate) fn write_artifact_review_pending(repo: &Path, slug: &str, artifact: &str, review_path: &Path) -> Result<(), String> {
    let path = artifact_review_pending_path(repo, slug, artifact)?;
    let created_at_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    let review = review_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("invalid review path: {}", review_path.display()))?
        .to_string();
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

pub(crate) fn artifact_review_pending_status_for(repo: &Path, slug: &str, artifact: &str) -> Result<Option<ArtifactReviewPendingStatus>, String> {
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

pub(crate) fn clear_artifact_review_pending_for(repo: &Path, slug: &str, artifact: &str) -> Result<(), String> {
    remove_file_if_exists(&artifact_review_pending_path(repo, slug, artifact)?)
}

fn prepared_review_path(repo: &Path, slug: &str, artifact: &str, markdown: &str) -> Result<PathBuf, String> {
    let artifact_path = artifact_file_path(repo, slug, artifact)?;
    let stem = artifact_comment_stem(artifact);
    let mut first_available = None;
    for idx in 1..=999 {
        let candidate = artifact_path.with_file_name(format!("{stem}.review-{idx:03}.md"));
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

pub(crate) fn prepare_artifact_comments_prompt_for(repo: &Path, slug: &str, artifacts: &[String]) -> Result<PreparedSessionMessageAction, String> {
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
        let review = review_path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| format!("invalid review path: {}", review_path.display()))?
            .to_string();
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

pub(crate) fn validate_artifact_comments_finalization(repo: &Path, slug: &str, items: &[PreparedArtifactCommentSnapshot]) -> Result<(), String> {
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

pub(crate) fn finalize_artifact_comments_for(repo: &Path, slug: &str, items: &[PreparedArtifactCommentSnapshot]) -> Result<(), String> {
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

pub(crate) fn archive_artifact_comments_for(repo: &Path, slug: &str, artifact: &str) -> Result<PathBuf, String> {
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

pub(crate) fn add_artifact_comment_for(
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

#[tauri::command]
pub(crate) fn artifact_review_pending_status(task_slug: String, artifact: String) -> Result<Option<ArtifactReviewPendingStatus>, String> {
    let repo = active_repo()?;
    artifact_review_pending_status_for(&repo, &task_slug, &artifact)
}

#[tauri::command]
pub(crate) fn clear_artifact_review_pending(state: State<'_, AppState>, task_slug: String, artifact: String) -> Result<(), String> {
    let repo = require_owned_active_repo(&state)?;
    clear_artifact_review_pending_for(&repo, &task_slug, &artifact)
}

#[tauri::command]
pub(crate) fn clear_artifact_review_pending_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, task_slug: String, artifact: String) -> Result<(), String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    clear_artifact_review_pending_for(&repo, &task_slug, &artifact)
}

pub(crate) fn list_artifacts_for(repo: &Path, task_slug: &str) -> Result<Vec<String>, String> {
    alinery_core::visible_artifact_names(repo, task_slug)
}

// List artifact filenames for task detail (read-only; rendering is later polish).
// Returns [] if the dir doesn't exist yet (task made before its first phase session).
#[tauri::command]
pub(crate) async fn list_artifacts(task_slug: String) -> Result<Vec<String>, String> {
    let repo = active_repo()?;
    list_artifacts_for(&repo, &task_slug)
}

#[tauri::command]
pub(crate) async fn list_artifacts_with_metadata(task_slug: String) -> Result<Vec<alinery_core::ArtifactListItem>, String> {
    let repo = active_repo()?;
    alinery_core::list_artifacts_with_metadata_for(&repo, &task_slug)
}

#[tauri::command]
pub(crate) fn send_review_handoff(
    app: AppHandle,
    source_slug: String,
    source_session: String,
    source_artifact: String,
    target_slug: String,
    target_phase: String,
    harness: String,
    model: String,
    prompt_extra: String,
) -> Result<alinery_core::ReviewHandoffResult, String> {
    let repo = active_repo()?;
    let result = alinery_core::send_review_handoff_for(
        &app_config_path(&app)?,
        &repo,
        alinery_core::ReviewHandoffRequest {
            source_slug,
            source_session,
            source_artifact,
            target_slug,
            target_phase,
            harness,
            model,
            prompt_extra,
        },
    )?;
    emit(
        &app,
        alinery_core::TelemetryEvent::ArtifactReviewHandoff {
            source: alinery_core::TelemetrySource::App,
            target_phase: result.target_record.target_phase.clone(),
            harness: result.target_session.harness.clone(),
        },
    );
    Ok(result)
}

pub(crate) fn read_artifact_for_repo_in(repo: &Path, task_slug: &str, name: &str) -> Result<String, String> {
    let p = artifact_file_path(repo, task_slug, name)?;
    fs::read_to_string(&p).map_err(|e| format!("read {}: {e}", p.display()))
}

#[tauri::command]
pub(crate) fn read_artifact(task_slug: String, name: String) -> Result<String, String> {
    read_artifact_for_repo_in(&active_repo()?, &task_slug, &name)
}

#[tauri::command]
pub(crate) fn read_artifact_for_repo(app: AppHandle, repo_path: String, task_slug: String, name: String) -> Result<String, String> {
    read_artifact_for_repo_in(&target_repo_for_app(&app, &repo_path)?, &task_slug, &name)
}

// safe_component is pass-or-None: it rejects empty, any `..`, any separator and absolute
// paths, and never rewrites — the right guard for two user-supplied components.
pub(crate) fn attachment_path_in(repo: &Path, task_slug: &str, name: &str) -> Result<String, String> {
    let slug = alinery_core::safe_component(task_slug).ok_or("invalid task slug")?;
    let name = alinery_core::safe_component(name).ok_or_else(|| format!("invalid attachment name: {name}"))?;
    let path = alinery_core::attachments_dir(repo, slug).join(name);
    if !path.is_file() {
        return Err(format!("attachment not found: {name}"));
    }
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub(crate) fn attachment_path(task_slug: String, name: String) -> Result<String, String> {
    attachment_path_in(&active_repo()?, &task_slug, &name)
}

#[tauri::command]
pub(crate) fn list_artifact_comments(task_slug: String, artifact: String) -> Result<Vec<ArtifactComment>, String> {
    let repo = active_repo()?;
    load_artifact_comments_for(&repo, &task_slug, &artifact)
}

#[tauri::command]
pub(crate) fn list_artifact_comment_drafts(task_slug: String) -> Result<Vec<ArtifactCommentDraft>, String> {
    list_artifact_comment_drafts_for(&active_repo()?, &task_slug)
}

#[tauri::command]
pub(crate) fn list_artifact_comment_drafts_for_repo(app: AppHandle, repo_path: String, task_slug: String) -> Result<Vec<ArtifactCommentDraft>, String> {
    list_artifact_comment_drafts_for(&target_repo_for_app(&app, &repo_path)?, &task_slug)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn save_artifact_comment_draft(
    task_slug: String,
    artifact: String,
    anchor_id: String,
    anchor_kind: String,
    anchor_label: String,
    anchor_excerpt: String,
    line_start: u32,
    line_end: u32,
    body: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    save_artifact_comment_draft_for(
        &require_owned_active_repo(&state)?,
        &task_slug,
        &artifact,
        anchor_id,
        anchor_kind,
        anchor_label,
        anchor_excerpt,
        line_start,
        line_end,
        body,
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn save_artifact_comment_draft_for_repo(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    task_slug: String,
    artifact: String,
    anchor_id: String,
    anchor_kind: String,
    anchor_label: String,
    anchor_excerpt: String,
    line_start: u32,
    line_end: u32,
    body: String,
) -> Result<(), String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    save_artifact_comment_draft_for(
        &repo,
        &task_slug,
        &artifact,
        anchor_id,
        anchor_kind,
        anchor_label,
        anchor_excerpt,
        line_start,
        line_end,
        body,
    )
}

#[tauri::command]
pub(crate) fn delete_artifact_comment_draft(state: State<'_, AppState>, task_slug: String, artifact: String, anchor_id: String) -> Result<(), String> {
    delete_artifact_comment_draft_for(&require_owned_active_repo(&state)?, &task_slug, &artifact, &anchor_id)
}

#[tauri::command]
pub(crate) fn delete_artifact_comment_draft_for_repo(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    task_slug: String,
    artifact: String,
    anchor_id: String,
) -> Result<(), String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    delete_artifact_comment_draft_for(&repo, &task_slug, &artifact, &anchor_id)
}

#[tauri::command]
pub(crate) fn artifact_comment_markdown_path_for(task_slug: String, artifact: String) -> Result<String, String> {
    let repo = active_repo()?;
    artifact_comment_markdown_path(&repo, &task_slug, &artifact).map(|path| path.display().to_string())
}

#[tauri::command]
pub(crate) fn prepare_artifact_comments_prompt(
    app: AppHandle,
    state: State<'_, AppState>,
    task_slug: String,
    artifacts: Vec<String>,
) -> Result<PreparedSessionMessageAction, String> {
    let repo = require_owned_active_repo(&state)?;
    let prepared = prepare_artifact_comments_prompt_for(&repo, &task_slug, &artifacts)?;
    publish_auto_backup(&app, &repo, alinery_core::BackupTrigger::PostArtifactChange);
    Ok(prepared)
}

#[tauri::command]
pub(crate) fn archive_artifact_comments(app: AppHandle, state: State<'_, AppState>, task_slug: String, artifact: String) -> Result<String, String> {
    let repo = require_owned_active_repo(&state)?;
    let review = archive_artifact_comments_for(&repo, &task_slug, &artifact)?;
    publish_auto_backup(&app, &repo, alinery_core::BackupTrigger::PostArtifactChange);
    emit(
        &app,
        alinery_core::TelemetryEvent::ArtifactReviewSend {
            source: alinery_core::TelemetrySource::App,
        },
    );
    Ok(review.display().to_string())
}

#[tauri::command]
pub(crate) fn archive_artifact_comments_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, task_slug: String, artifact: String) -> Result<String, String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    let review = archive_artifact_comments_for(&repo, &task_slug, &artifact)?;
    publish_auto_backup(&app, &repo, alinery_core::BackupTrigger::PostArtifactChange);
    Ok(review.display().to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn add_artifact_comment(
    app: AppHandle,
    state: State<'_, AppState>,
    task_slug: String,
    artifact: String,
    anchor_id: String,
    anchor_kind: String,
    anchor_label: String,
    anchor_excerpt: String,
    line_start: u32,
    line_end: u32,
    body: String,
) -> Result<Vec<ArtifactComment>, String> {
    let repo = require_owned_active_repo(&state)?;
    let comments = add_artifact_comment_for(
        &repo,
        &task_slug,
        &artifact,
        anchor_id,
        anchor_kind,
        anchor_label,
        anchor_excerpt,
        line_start,
        line_end,
        body,
    )?;
    publish_auto_backup(&app, &repo, alinery_core::BackupTrigger::PostArtifactChange);
    emit(
        &app,
        alinery_core::TelemetryEvent::ArtifactCommentAdd {
            source: alinery_core::TelemetrySource::App,
        },
    );
    Ok(comments)
}

pub(crate) fn list_task_artifact_tree_for(repo: &Path, task_slug: &str) -> Result<Vec<alinery_core::ArtifactTreeNode>, String> {
    alinery_core::list_task_artifact_tree(repo, task_slug)
}

pub(crate) fn read_task_artifact_node_for(repo: &Path, task_slug: &str, node_id: &str) -> Result<String, String> {
    alinery_core::read_task_artifact_node(repo, task_slug, node_id)
}

pub(crate) fn artifact_node_path_for(repo: &Path, task_slug: &str, node_id: &str) -> Result<String, String> {
    alinery_core::artifact_node_path(repo, task_slug, node_id)
}

#[tauri::command]
pub(crate) fn list_task_artifact_tree(state: State<'_, AppState>, task_slug: String) -> Result<Vec<alinery_core::ArtifactTreeNode>, String> {
    list_task_artifact_tree_for(&require_owned_active_repo(&state)?, &task_slug)
}

#[tauri::command]
pub(crate) fn read_task_artifact_node(state: State<'_, AppState>, task_slug: String, node_id: String) -> Result<String, String> {
    read_task_artifact_node_for(&require_owned_active_repo(&state)?, &task_slug, &node_id)
}

#[tauri::command]
pub(crate) fn artifact_node_path(state: State<'_, AppState>, task_slug: String, node_id: String) -> Result<String, String> {
    artifact_node_path_for(&require_owned_active_repo(&state)?, &task_slug, &node_id)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn add_artifact_comment_for_repo(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    task_slug: String,
    artifact: String,
    anchor_id: String,
    anchor_kind: String,
    anchor_label: String,
    anchor_excerpt: String,
    line_start: u32,
    line_end: u32,
    body: String,
) -> Result<Vec<ArtifactComment>, String> {
    let repo = target_repo_for_app(&app, &repo_path)?;
    require_repo_owned(&state, &repo)?;
    let comments = add_artifact_comment_for(
        &repo,
        &task_slug,
        &artifact,
        anchor_id,
        anchor_kind,
        anchor_label,
        anchor_excerpt,
        line_start,
        line_end,
        body,
    )?;
    publish_auto_backup(&app, &repo, alinery_core::BackupTrigger::PostArtifactChange);
    Ok(comments)
}
