//! artifacts: extracted from lib.rs. See AGENTS.md for the module map.
use crate::*;

pub(crate) use alinery_core::artifact_comments::*;

#[tauri::command]
pub(crate) fn artifact_review_pending_status(state: State<'_, AppState>, task_slug: String, artifact: String) -> Result<Option<ArtifactReviewPendingStatus>, String> {
    match active_repo_ref()? {
        RepoRef::Local(repo) => artifact_review_pending_status_for(&repo, &task_slug, &artifact),
        RepoRef::Remote { host_id, path } => remote_call(
            &state,
            &host_id,
            RepoOp::ArtifactReviewPendingStatus {
                repo: path.into(),
                slug: task_slug,
                artifact,
            },
        ),
    }
}

#[tauri::command]
pub(crate) fn clear_artifact_review_pending(state: State<'_, AppState>, task_slug: String, artifact: String) -> Result<(), String> {
    match require_active_target(&state)? {
        ActiveRepo::Local(repo) => clear_artifact_review_pending_for(&repo, &task_slug, &artifact),
        ActiveRepo::Remote { host_id, path } => remote_call(
            &state,
            &host_id,
            RepoOp::ClearArtifactReviewPending {
                repo: path.into(),
                slug: task_slug,
                artifact,
            },
        ),
    }
}

#[tauri::command]
pub(crate) fn clear_artifact_review_pending_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, task_slug: String, artifact: String) -> Result<(), String> {
    match owned_target(&app, &state, &repo_path)? {
        RepoRef::Local(repo) => clear_artifact_review_pending_for(&repo, &task_slug, &artifact),
        RepoRef::Remote { host_id, path } => remote_call(
            &state,
            &host_id,
            RepoOp::ClearArtifactReviewPending {
                repo: path.into(),
                slug: task_slug,
                artifact,
            },
        ),
    }
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

pub(crate) use alinery_core::board::artifacts_with_metadata as list_artifacts_with_metadata_in;

#[tauri::command]
pub(crate) async fn list_artifacts_with_metadata(state: State<'_, AppState>, task_slug: String) -> Result<Vec<alinery_core::ArtifactListItem>, String> {
    match active_repo_ref()? {
        RepoRef::Local(repo) => list_artifacts_with_metadata_in(&repo, &task_slug),
        RepoRef::Remote { host_id, path } => remote_call(
            &state,
            &host_id,
            RepoOp::ListArtifactsWithMetadata {
                repo: path.into(),
                slug: task_slug,
            },
        ),
    }
}

#[tauri::command]
pub(crate) async fn send_review_handoff(
    app: AppHandle,
    state: State<'_, AppState>,
    source_repo_path: String,
    target_repo_path: String,
    source_slug: String,
    source_session: String,
    source_artifact: String,
    target_slug: String,
    target_phase: String,
    harness: String,
    model: String,
    prompt_extra: String,
) -> Result<alinery_core::ReviewHandoffResult, String> {
    let source_repo = target_repo_for_app(&app, &source_repo_path)?;
    let target_repo = target_repo_for_app(&app, &target_repo_path)?;
    require_repo_owned(&state, &source_repo)?;
    require_repo_owned(&state, &target_repo)?;
    let app_config = app_config_path(&app)?;
    // Copies the artifact and waits on the daemon to start the target session.
    let result = tauri::async_runtime::spawn_blocking(move || {
        let daemon = task_daemon_for(&target_repo, &target_slug, &app_config)?;
        alinery_core::send_review_handoff_for_repos(
            &daemon,
            &source_repo,
            &target_repo,
            alinery_core::ReviewHandoffRequest {
                source_slug,
                source_session,
                source_artifact,
                target_slug,
                target_phase,
                harness,
                model,
                prompt_extra,
                start: true,
            },
        )
    })
    .await
    .map_err(|error| format!("send review handoff task: {error}"))??;
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

pub(crate) use alinery_core::artifact_comments::read_artifact_text as read_artifact_for_repo_in;

#[tauri::command]
pub(crate) fn read_artifact(state: State<'_, AppState>, task_slug: String, name: String) -> Result<String, String> {
    match active_repo_ref()? {
        RepoRef::Local(repo) => read_artifact_for_repo_in(&repo, &task_slug, &name),
        RepoRef::Remote { host_id, path } => remote_call(
            &state,
            &host_id,
            RepoOp::ReadArtifact {
                repo: path.into(),
                slug: task_slug,
                name,
            },
        ),
    }
}

#[tauri::command]
pub(crate) fn read_artifact_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, task_slug: String, name: String) -> Result<String, String> {
    match target_repo_ref_for_app(&app, &repo_path)? {
        RepoRef::Local(repo) => read_artifact_for_repo_in(&repo, &task_slug, &name),
        RepoRef::Remote { host_id, path } => remote_call(
            &state,
            &host_id,
            RepoOp::ReadArtifact {
                repo: path.into(),
                slug: task_slug,
                name,
            },
        ),
    }
}

// safe_component is pass-or-None: it rejects empty, any `..`, any separator and absolute
// paths, and never rewrites — the right guard for two user-supplied components.
pub(crate) fn attachment_path_in(repo: &Path, task_slug: &str, name: &str) -> Result<String, String> {
    let slug = alinery_core::safe_component(task_slug).ok_or("invalid task slug")?;
    let name = alinery_core::safe_component(name).ok_or_else(|| format!("invalid attachment name: {name}"))?;
    let path = alinery_core::resolve_artifact_path(repo, &format!(".alinery/tasks/{slug}/artifacts/attachments/{name}"))?;
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
pub(crate) fn list_artifact_comments(state: State<'_, AppState>, task_slug: String, artifact: String) -> Result<Vec<ArtifactComment>, String> {
    match active_repo_ref()? {
        RepoRef::Local(repo) => load_artifact_comments_for(&repo, &task_slug, &artifact),
        RepoRef::Remote { host_id, path } => remote_call(
            &state,
            &host_id,
            RepoOp::ListArtifactComments {
                repo: path.into(),
                slug: task_slug,
                artifact,
            },
        ),
    }
}

#[tauri::command]
pub(crate) fn list_artifact_comment_drafts(state: State<'_, AppState>, task_slug: String) -> Result<Vec<ArtifactCommentDraft>, String> {
    match active_repo_ref()? {
        RepoRef::Local(repo) => list_artifact_comment_drafts_for(&repo, &task_slug),
        RepoRef::Remote { host_id, path } => remote_call(
            &state,
            &host_id,
            RepoOp::ListCommentDrafts {
                repo: path.into(),
                slug: task_slug,
            },
        ),
    }
}

#[tauri::command]
pub(crate) fn list_artifact_comment_drafts_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, task_slug: String) -> Result<Vec<ArtifactCommentDraft>, String> {
    match target_repo_ref_for_app(&app, &repo_path)? {
        RepoRef::Local(repo) => list_artifact_comment_drafts_for(&repo, &task_slug),
        RepoRef::Remote { host_id, path } => remote_call(
            &state,
            &host_id,
            RepoOp::ListCommentDrafts {
                repo: path.into(),
                slug: task_slug,
            },
        ),
    }
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
    let comment = CommentInput {
        anchor_id,
        anchor_kind,
        anchor_label,
        anchor_excerpt,
        line_start,
        line_end,
        body,
    };
    match require_active_target(&state)? {
        ActiveRepo::Local(repo) => save_comment_draft_local(&repo, &task_slug, &artifact, comment),
        ActiveRepo::Remote { host_id, path } => remote_call(
            &state,
            &host_id,
            RepoOp::SaveCommentDraft {
                repo: path.into(),
                slug: task_slug,
                artifact,
                comment,
            },
        ),
    }
}

fn save_comment_draft_local(repo: &Path, slug: &str, artifact: &str, comment: CommentInput) -> Result<(), String> {
    save_artifact_comment_draft_for(
        repo,
        slug,
        artifact,
        comment.anchor_id,
        comment.anchor_kind,
        comment.anchor_label,
        comment.anchor_excerpt,
        comment.line_start,
        comment.line_end,
        comment.body,
    )
}

/// The repo a mutating `_for_repo` command acts on: a local one must be owned by this window.
fn owned_target(app: &AppHandle, state: &AppState, repo_path: &str) -> Result<RepoRef, String> {
    let target = target_repo_ref_for_app(app, repo_path)?;
    if let RepoRef::Local(repo) = &target {
        require_repo_owned(state, repo)?;
    }
    Ok(target)
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
    let comment = CommentInput {
        anchor_id,
        anchor_kind,
        anchor_label,
        anchor_excerpt,
        line_start,
        line_end,
        body,
    };
    match owned_target(&app, &state, &repo_path)? {
        RepoRef::Local(repo) => save_comment_draft_local(&repo, &task_slug, &artifact, comment),
        RepoRef::Remote { host_id, path } => remote_call(
            &state,
            &host_id,
            RepoOp::SaveCommentDraft {
                repo: path.into(),
                slug: task_slug,
                artifact,
                comment,
            },
        ),
    }
}

#[tauri::command]
pub(crate) fn delete_artifact_comment_draft(state: State<'_, AppState>, task_slug: String, artifact: String, anchor_id: String) -> Result<(), String> {
    match require_active_target(&state)? {
        ActiveRepo::Local(repo) => delete_artifact_comment_draft_for(&repo, &task_slug, &artifact, &anchor_id),
        ActiveRepo::Remote { host_id, path } => remote_call(
            &state,
            &host_id,
            RepoOp::DeleteCommentDraft {
                repo: path.into(),
                slug: task_slug,
                artifact,
                anchor_id,
            },
        ),
    }
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
    match owned_target(&app, &state, &repo_path)? {
        RepoRef::Local(repo) => delete_artifact_comment_draft_for(&repo, &task_slug, &artifact, &anchor_id),
        RepoRef::Remote { host_id, path } => remote_call(
            &state,
            &host_id,
            RepoOp::DeleteCommentDraft {
                repo: path.into(),
                slug: task_slug,
                artifact,
                anchor_id,
            },
        ),
    }
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
    match require_active_target(&state)? {
        ActiveRepo::Local(repo) => {
            let prepared = prepare_artifact_comments_prompt_for(&repo, &task_slug, &artifacts)?;
            publish_auto_backup(&app, &repo, alinery_core::BackupTrigger::PostArtifactChange);
            Ok(prepared)
        }
        // The local backup is about this machine's copy of a repo, which a remote one is not.
        ActiveRepo::Remote { host_id, path } => remote_call(
            &state,
            &host_id,
            RepoOp::PrepareArtifactCommentsPrompt {
                repo: path.into(),
                slug: task_slug,
                artifacts,
            },
        ),
    }
}

#[tauri::command]
pub(crate) fn archive_artifact_comments(app: AppHandle, state: State<'_, AppState>, task_slug: String, artifact: String) -> Result<String, String> {
    match require_active_target(&state)? {
        ActiveRepo::Local(repo) => {
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
        ActiveRepo::Remote { host_id, path } => remote_call(
            &state,
            &host_id,
            RepoOp::ArchiveArtifactComments {
                repo: path.into(),
                slug: task_slug,
                artifact,
            },
        ),
    }
}

#[tauri::command]
pub(crate) fn archive_artifact_comments_for_repo(app: AppHandle, state: State<'_, AppState>, repo_path: String, task_slug: String, artifact: String) -> Result<String, String> {
    match owned_target(&app, &state, &repo_path)? {
        RepoRef::Local(repo) => {
            let review = archive_artifact_comments_for(&repo, &task_slug, &artifact)?;
            publish_auto_backup(&app, &repo, alinery_core::BackupTrigger::PostArtifactChange);
            Ok(review.display().to_string())
        }
        RepoRef::Remote { host_id, path } => remote_call(
            &state,
            &host_id,
            RepoOp::ArchiveArtifactComments {
                repo: path.into(),
                slug: task_slug,
                artifact,
            },
        ),
    }
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
    let comment = CommentInput {
        anchor_id,
        anchor_kind,
        anchor_label,
        anchor_excerpt,
        line_start,
        line_end,
        body,
    };
    match require_active_target(&state)? {
        ActiveRepo::Local(repo) => {
            let comments = add_comment_local(&repo, &task_slug, &artifact, comment)?;
            publish_auto_backup(&app, &repo, alinery_core::BackupTrigger::PostArtifactChange);
            emit(
                &app,
                alinery_core::TelemetryEvent::ArtifactCommentAdd {
                    source: alinery_core::TelemetrySource::App,
                },
            );
            Ok(comments)
        }
        ActiveRepo::Remote { host_id, path } => remote_call(
            &state,
            &host_id,
            RepoOp::AddArtifactComment {
                repo: path.into(),
                slug: task_slug,
                artifact,
                comment,
            },
        ),
    }
}

fn add_comment_local(repo: &Path, slug: &str, artifact: &str, comment: CommentInput) -> Result<Vec<ArtifactComment>, String> {
    add_artifact_comment_for(
        repo,
        slug,
        artifact,
        comment.anchor_id,
        comment.anchor_kind,
        comment.anchor_label,
        comment.anchor_excerpt,
        comment.line_start,
        comment.line_end,
        comment.body,
    )
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
    match require_active_target(&state)? {
        ActiveRepo::Local(repo) => list_task_artifact_tree_for(&repo, &task_slug),
        ActiveRepo::Remote { host_id, path } => remote_call(
            &state,
            &host_id,
            RepoOp::ListTaskArtifactTree {
                repo: path.into(),
                slug: task_slug,
            },
        ),
    }
}

#[tauri::command]
pub(crate) fn read_task_artifact_node(state: State<'_, AppState>, task_slug: String, node_id: String) -> Result<String, String> {
    match require_active_target(&state)? {
        ActiveRepo::Local(repo) => read_task_artifact_node_for(&repo, &task_slug, &node_id),
        ActiveRepo::Remote { host_id, path } => remote_call(
            &state,
            &host_id,
            RepoOp::ReadTaskArtifactNode {
                repo: path.into(),
                slug: task_slug,
                node_id,
            },
        ),
    }
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
    let comment = CommentInput {
        anchor_id,
        anchor_kind,
        anchor_label,
        anchor_excerpt,
        line_start,
        line_end,
        body,
    };
    match owned_target(&app, &state, &repo_path)? {
        RepoRef::Local(repo) => {
            let comments = add_comment_local(&repo, &task_slug, &artifact, comment)?;
            publish_auto_backup(&app, &repo, alinery_core::BackupTrigger::PostArtifactChange);
            Ok(comments)
        }
        RepoRef::Remote { host_id, path } => remote_call(
            &state,
            &host_id,
            RepoOp::AddArtifactComment {
                repo: path.into(),
                slug: task_slug,
                artifact,
                comment,
            },
        ),
    }
}
