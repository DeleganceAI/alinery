//! artifacts: extracted from lib.rs. See AGENTS.md for the module map.
use crate::*;

pub(crate) use alinery_core::artifact_comments::*;
pub(crate) use alinery_core::attachments::attachment_path as attachment_path_in;

#[tauri::command]
pub(crate) async fn artifact_review_pending_status(app: AppHandle, task_slug: String, artifact: String) -> Result<Option<ArtifactReviewPendingStatus>, String> {
    let target = active_repo_ref()?;
    off_main_thread("artifact review status", move || match target {
        RepoRef::Local(repo) => artifact_review_pending_status_for(&repo, &task_slug, &artifact),
        RepoRef::Remote { host_id, path } => remote_call(
            &app.state::<AppState>(),
            &host_id,
            RepoOp::ArtifactReviewPendingStatus {
                repo: path.into(),
                slug: task_slug,
                artifact,
            },
        ),
    })
    .await
}

#[tauri::command]
pub(crate) async fn clear_artifact_review_pending(app: AppHandle, state: State<'_, AppState>, task_slug: String, artifact: String) -> Result<(), String> {
    let target = require_active_target(&state)?;
    off_main_thread("clear artifact review", move || match target {
        ActiveRepo::Local(repo) => clear_artifact_review_pending_for(&repo, &task_slug, &artifact),
        ActiveRepo::Remote { host_id, path } => remote_call(
            &app.state::<AppState>(),
            &host_id,
            RepoOp::ClearArtifactReviewPending {
                repo: path.into(),
                slug: task_slug,
                artifact,
            },
        ),
    })
    .await
}

#[tauri::command]
pub(crate) async fn clear_artifact_review_pending_for_repo(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    task_slug: String,
    artifact: String,
) -> Result<(), String> {
    let target = owned_target(&app, &state, &repo_path)?;
    off_main_thread("clear artifact review", move || match target {
        RepoRef::Local(repo) => clear_artifact_review_pending_for(&repo, &task_slug, &artifact),
        RepoRef::Remote { host_id, path } => remote_call(
            &app.state::<AppState>(),
            &host_id,
            RepoOp::ClearArtifactReviewPending {
                repo: path.into(),
                slug: task_slug,
                artifact,
            },
        ),
    })
    .await
}

pub(crate) fn list_artifacts_for(repo: &Path, task_slug: &str) -> Result<Vec<String>, String> {
    alinery_core::visible_artifact_names(repo, task_slug)
}

// List artifact filenames for task detail (read-only; rendering is later polish).
// Returns [] if the dir doesn't exist yet (task made before its first phase session).
#[tauri::command]
pub(crate) async fn list_artifacts(app: AppHandle, task_slug: String) -> Result<Vec<String>, String> {
    let target = active_repo_ref()?;
    off_main_thread("list artifacts", move || match target {
        RepoRef::Local(repo) => list_artifacts_for(&repo, &task_slug),
        RepoRef::Remote { host_id, path } => remote_call(
            &app.state::<AppState>(),
            &host_id,
            RepoOp::ListArtifacts {
                repo: path.into(),
                slug: task_slug,
            },
        ),
    })
    .await
}

pub(crate) use alinery_core::board::artifacts_with_metadata as list_artifacts_with_metadata_in;

#[tauri::command]
pub(crate) async fn list_artifacts_with_metadata(app: AppHandle, task_slug: String) -> Result<Vec<alinery_core::ArtifactListItem>, String> {
    let target = active_repo_ref()?;
    off_main_thread("list artifacts with metadata", move || match target {
        RepoRef::Local(repo) => list_artifacts_with_metadata_in(&repo, &task_slug),
        RepoRef::Remote { host_id, path } => remote_call(
            &app.state::<AppState>(),
            &host_id,
            RepoOp::ListArtifactsWithMetadata {
                repo: path.into(),
                slug: task_slug,
            },
        ),
    })
    .await
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
    let source = owned_target(&app, &state, &source_repo_path)?;
    let target = owned_target(&app, &state, &target_repo_path)?;
    // The artifact is copied between the two repositories' files and the target's own daemon starts the
    // session, so both must be on one machine.
    if !same_machine(&source, &target) {
        return Err("A review handoff needs both tasks on the same machine; these repositories are on different machines.".into());
    }
    let app_config = app_config_path(&app)?;
    let request = alinery_core::ReviewHandoffRequest {
        source_slug,
        source_session,
        source_artifact,
        target_slug: target_slug.clone(),
        target_phase,
        harness,
        model,
        prompt_extra,
        start: true,
    };
    let remote = matches!(target, RepoRef::Remote { .. });
    let worker = app.clone();
    // Copies the artifact and waits on the daemon to start the target session.
    let result = tauri::async_runtime::spawn_blocking(move || match (source, target) {
        (RepoRef::Local(source_repo), RepoRef::Local(target_repo)) => {
            let daemon = task_daemon_for(&target_repo, &target_slug, &app_config)?;
            alinery_core::send_review_handoff_for_repos(&daemon, &source_repo, &target_repo, request)
        }
        (RepoRef::Remote { host_id, path: source_path }, RepoRef::Remote { path: target_path, .. }) => {
            let state = worker.state::<AppState>();
            let mut result: alinery_core::ReviewHandoffResult = remote_call(
                &state,
                &host_id,
                RepoOp::SendReviewHandoff {
                    source_repo: source_path.into(),
                    target_repo: target_path.into(),
                    app_config: host_app_config(&state, &host_id)?,
                    request,
                },
            )?;
            // The records on the host name host paths; the UI opens the target by its repo key.
            result.target_repo_path = target_repo_path;
            Ok(result)
        }
        _ => Err("review handoff repositories are on different machines".to_string()),
    })
    .await
    .map_err(|error| format!("send review handoff task: {error}"))??;
    if remote {
        return Ok(result);
    }
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
pub(crate) async fn read_artifact(app: AppHandle, task_slug: String, name: String) -> Result<String, String> {
    let target = active_repo_ref()?;
    off_main_thread("read artifact", move || match target {
        RepoRef::Local(repo) => read_artifact_for_repo_in(&repo, &task_slug, &name),
        RepoRef::Remote { host_id, path } => remote_call(
            &app.state::<AppState>(),
            &host_id,
            RepoOp::ReadArtifact {
                repo: path.into(),
                slug: task_slug,
                name,
            },
        ),
    })
    .await
}

#[tauri::command]
pub(crate) async fn read_artifact_for_repo(app: AppHandle, repo_path: String, task_slug: String, name: String) -> Result<String, String> {
    let target = target_repo_ref_for_app(&app, &repo_path)?;
    off_main_thread("read artifact", move || match target {
        RepoRef::Local(repo) => read_artifact_for_repo_in(&repo, &task_slug, &name),
        RepoRef::Remote { host_id, path } => remote_call(
            &app.state::<AppState>(),
            &host_id,
            RepoOp::ReadArtifact {
                repo: path.into(),
                slug: task_slug,
                name,
            },
        ),
    })
    .await
}

#[tauri::command]
pub(crate) async fn attachment_path(app: AppHandle, task_slug: String, name: String) -> Result<String, String> {
    let target = active_repo_ref()?;
    off_main_thread("attachment path", move || match target {
        RepoRef::Local(repo) => attachment_path_in(&repo, &task_slug, &name),
        // The path on the host: it cannot be revealed here, so the UI offers to copy it.
        RepoRef::Remote { host_id, path } => remote_call(
            &app.state::<AppState>(),
            &host_id,
            RepoOp::AttachmentPath {
                repo: path.into(),
                slug: task_slug,
                name,
            },
        ),
    })
    .await
}

#[tauri::command]
pub(crate) async fn list_artifact_comments(app: AppHandle, task_slug: String, artifact: String) -> Result<Vec<ArtifactComment>, String> {
    let target = active_repo_ref()?;
    off_main_thread("list artifact comments", move || match target {
        RepoRef::Local(repo) => load_artifact_comments_for(&repo, &task_slug, &artifact),
        RepoRef::Remote { host_id, path } => remote_call(
            &app.state::<AppState>(),
            &host_id,
            RepoOp::ListArtifactComments {
                repo: path.into(),
                slug: task_slug,
                artifact,
            },
        ),
    })
    .await
}

#[tauri::command]
pub(crate) async fn list_artifact_comment_drafts(app: AppHandle, task_slug: String) -> Result<Vec<ArtifactCommentDraft>, String> {
    let target = active_repo_ref()?;
    off_main_thread("list comment drafts", move || match target {
        RepoRef::Local(repo) => list_artifact_comment_drafts_for(&repo, &task_slug),
        RepoRef::Remote { host_id, path } => remote_call(
            &app.state::<AppState>(),
            &host_id,
            RepoOp::ListCommentDrafts {
                repo: path.into(),
                slug: task_slug,
            },
        ),
    })
    .await
}

#[tauri::command]
pub(crate) async fn list_artifact_comment_drafts_for_repo(app: AppHandle, repo_path: String, task_slug: String) -> Result<Vec<ArtifactCommentDraft>, String> {
    let target = target_repo_ref_for_app(&app, &repo_path)?;
    off_main_thread("list comment drafts", move || match target {
        RepoRef::Local(repo) => list_artifact_comment_drafts_for(&repo, &task_slug),
        RepoRef::Remote { host_id, path } => remote_call(
            &app.state::<AppState>(),
            &host_id,
            RepoOp::ListCommentDrafts {
                repo: path.into(),
                slug: task_slug,
            },
        ),
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn save_artifact_comment_draft(
    task_slug: String,
    artifact: String,
    anchor_id: String,
    anchor_kind: String,
    anchor_label: String,
    anchor_excerpt: String,
    line_start: u32,
    line_end: u32,
    body: String,
    app: AppHandle,
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
    let target = require_active_target(&state)?;
    off_main_thread("save comment draft", move || match target {
        ActiveRepo::Local(repo) => save_comment_draft_local(&repo, &task_slug, &artifact, comment),
        ActiveRepo::Remote { host_id, path } => remote_call(
            &app.state::<AppState>(),
            &host_id,
            RepoOp::SaveCommentDraft {
                repo: path.into(),
                slug: task_slug,
                artifact,
                comment,
            },
        ),
    })
    .await
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
pub(crate) fn owned_target(app: &AppHandle, state: &AppState, repo_path: &str) -> Result<RepoRef, String> {
    let target = target_repo_ref_for_app(app, repo_path)?;
    if let RepoRef::Local(repo) = &target {
        require_repo_owned(state, repo)?;
    }
    Ok(target)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn save_artifact_comment_draft_for_repo(
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
    let target = owned_target(&app, &state, &repo_path)?;
    off_main_thread("save comment draft", move || match target {
        RepoRef::Local(repo) => save_comment_draft_local(&repo, &task_slug, &artifact, comment),
        RepoRef::Remote { host_id, path } => remote_call(
            &app.state::<AppState>(),
            &host_id,
            RepoOp::SaveCommentDraft {
                repo: path.into(),
                slug: task_slug,
                artifact,
                comment,
            },
        ),
    })
    .await
}

#[tauri::command]
pub(crate) async fn delete_artifact_comment_draft(app: AppHandle, state: State<'_, AppState>, task_slug: String, artifact: String, anchor_id: String) -> Result<(), String> {
    let target = require_active_target(&state)?;
    off_main_thread("delete comment draft", move || match target {
        ActiveRepo::Local(repo) => delete_artifact_comment_draft_for(&repo, &task_slug, &artifact, &anchor_id),
        ActiveRepo::Remote { host_id, path } => remote_call(
            &app.state::<AppState>(),
            &host_id,
            RepoOp::DeleteCommentDraft {
                repo: path.into(),
                slug: task_slug,
                artifact,
                anchor_id,
            },
        ),
    })
    .await
}

#[tauri::command]
pub(crate) async fn delete_artifact_comment_draft_for_repo(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    task_slug: String,
    artifact: String,
    anchor_id: String,
) -> Result<(), String> {
    let target = owned_target(&app, &state, &repo_path)?;
    off_main_thread("delete comment draft", move || match target {
        RepoRef::Local(repo) => delete_artifact_comment_draft_for(&repo, &task_slug, &artifact, &anchor_id),
        RepoRef::Remote { host_id, path } => remote_call(
            &app.state::<AppState>(),
            &host_id,
            RepoOp::DeleteCommentDraft {
                repo: path.into(),
                slug: task_slug,
                artifact,
                anchor_id,
            },
        ),
    })
    .await
}

#[tauri::command]
pub(crate) async fn artifact_comment_markdown_path_for(app: AppHandle, task_slug: String, artifact: String) -> Result<String, String> {
    let target = active_repo_ref()?;
    off_main_thread("artifact comment path", move || match target {
        RepoRef::Local(repo) => artifact_comment_markdown_path(&repo, &task_slug, &artifact).map(|path| path.display().to_string()),
        // The path is on the host, where the agent that reads it runs.
        RepoRef::Remote { host_id, path } => remote_call(
            &app.state::<AppState>(),
            &host_id,
            RepoOp::ArtifactCommentMarkdownPath {
                repo: path.into(),
                slug: task_slug,
                artifact,
            },
        ),
    })
    .await
}

#[tauri::command]
pub(crate) async fn prepare_artifact_comments_prompt(
    app: AppHandle,
    state: State<'_, AppState>,
    task_slug: String,
    artifacts: Vec<String>,
) -> Result<PreparedSessionMessageAction, String> {
    let target = require_active_target(&state)?;
    off_main_thread("prepare comments prompt", move || match target {
        ActiveRepo::Local(repo) => {
            let prepared = prepare_artifact_comments_prompt_for(&repo, &task_slug, &artifacts)?;
            publish_auto_backup(&app, &repo, alinery_core::BackupTrigger::PostArtifactChange);
            Ok(prepared)
        }
        ActiveRepo::Remote { host_id, path } => {
            let prepared = remote_call(
                &app.state::<AppState>(),
                &host_id,
                RepoOp::PrepareArtifactCommentsPrompt {
                    repo: path.clone().into(),
                    slug: task_slug,
                    artifacts,
                },
            )?;
            publish_remote_backup(&app, &host_id, &path, alinery_core::BackupTrigger::PostArtifactChange);
            Ok(prepared)
        }
    })
    .await
}

#[tauri::command]
pub(crate) async fn archive_artifact_comments(app: AppHandle, state: State<'_, AppState>, task_slug: String, artifact: String) -> Result<String, String> {
    let target = require_active_target(&state)?;
    off_main_thread("archive artifact comments", move || match target {
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
        ActiveRepo::Remote { host_id, path } => {
            let review = remote_call(
                &app.state::<AppState>(),
                &host_id,
                RepoOp::ArchiveArtifactComments {
                    repo: path.clone().into(),
                    slug: task_slug,
                    artifact,
                },
            )?;
            publish_remote_backup(&app, &host_id, &path, alinery_core::BackupTrigger::PostArtifactChange);
            Ok(review)
        }
    })
    .await
}

#[tauri::command]
pub(crate) async fn archive_artifact_comments_for_repo(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    task_slug: String,
    artifact: String,
) -> Result<String, String> {
    let target = owned_target(&app, &state, &repo_path)?;
    off_main_thread("archive artifact comments", move || match target {
        RepoRef::Local(repo) => {
            let review = archive_artifact_comments_for(&repo, &task_slug, &artifact)?;
            publish_auto_backup(&app, &repo, alinery_core::BackupTrigger::PostArtifactChange);
            Ok(review.display().to_string())
        }
        RepoRef::Remote { host_id, path } => {
            let review = remote_call(
                &app.state::<AppState>(),
                &host_id,
                RepoOp::ArchiveArtifactComments {
                    repo: path.clone().into(),
                    slug: task_slug,
                    artifact,
                },
            )?;
            publish_remote_backup(&app, &host_id, &path, alinery_core::BackupTrigger::PostArtifactChange);
            Ok(review)
        }
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn add_artifact_comment(
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
    let target = require_active_target(&state)?;
    off_main_thread("add artifact comment", move || match target {
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
        ActiveRepo::Remote { host_id, path } => add_comment_remote(&app, &app.state::<AppState>(), &host_id, path, task_slug, artifact, comment),
    })
    .await
}

fn add_comment_remote(
    app: &AppHandle,
    state: &AppState,
    host_id: &str,
    path: String,
    slug: String,
    artifact: String,
    comment: CommentInput,
) -> Result<Vec<ArtifactComment>, String> {
    let comments = remote_call(
        state,
        host_id,
        RepoOp::AddArtifactComment {
            repo: path.clone().into(),
            slug,
            artifact,
            comment,
        },
    )?;
    publish_remote_backup(app, host_id, &path, alinery_core::BackupTrigger::PostArtifactChange);
    Ok(comments)
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
pub(crate) async fn list_task_artifact_tree(app: AppHandle, state: State<'_, AppState>, task_slug: String) -> Result<Vec<alinery_core::ArtifactTreeNode>, String> {
    let target = require_active_target(&state)?;
    off_main_thread("list artifact tree", move || match target {
        ActiveRepo::Local(repo) => list_task_artifact_tree_for(&repo, &task_slug),
        ActiveRepo::Remote { host_id, path } => remote_call(
            &app.state::<AppState>(),
            &host_id,
            RepoOp::ListTaskArtifactTree {
                repo: path.into(),
                slug: task_slug,
            },
        ),
    })
    .await
}

#[tauri::command]
pub(crate) async fn read_task_artifact_node(app: AppHandle, state: State<'_, AppState>, task_slug: String, node_id: String) -> Result<String, String> {
    let target = require_active_target(&state)?;
    off_main_thread("read artifact node", move || match target {
        ActiveRepo::Local(repo) => read_task_artifact_node_for(&repo, &task_slug, &node_id),
        ActiveRepo::Remote { host_id, path } => remote_call(
            &app.state::<AppState>(),
            &host_id,
            RepoOp::ReadTaskArtifactNode {
                repo: path.into(),
                slug: task_slug,
                node_id,
            },
        ),
    })
    .await
}

#[tauri::command]
pub(crate) async fn artifact_node_path(app: AppHandle, state: State<'_, AppState>, task_slug: String, node_id: String) -> Result<String, String> {
    let target = require_active_target(&state)?;
    off_main_thread("artifact node path", move || match target {
        ActiveRepo::Local(repo) => artifact_node_path_for(&repo, &task_slug, &node_id),
        ActiveRepo::Remote { host_id, path } => remote_call(
            &app.state::<AppState>(),
            &host_id,
            RepoOp::ArtifactNodePath {
                repo: path.into(),
                slug: task_slug,
                node_id,
            },
        ),
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn add_artifact_comment_for_repo(
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
    let target = owned_target(&app, &state, &repo_path)?;
    off_main_thread("add artifact comment", move || match target {
        RepoRef::Local(repo) => {
            let comments = add_comment_local(&repo, &task_slug, &artifact, comment)?;
            publish_auto_backup(&app, &repo, alinery_core::BackupTrigger::PostArtifactChange);
            Ok(comments)
        }
        RepoRef::Remote { host_id, path } => add_comment_remote(&app, &app.state::<AppState>(), &host_id, path, task_slug, artifact, comment),
    })
    .await
}
