//! Canonical scope-qualified playbook library commands. Runtime task definitions are daemon-owned.
use crate::*;
use alinery_core::playbook::{parse_playbook_md, render_playbook_md, NormalizedPlaybook, PlaybookRef, PlaybookScope, PlaybookValidationError};
use alinery_core::playbook_library::{
    self as library, PickerPreferences, PlaybookCatalog, PlaybookLoadError, PlaybookRoots, PlaybookSaveError, PlaybookSource, SavePlaybookRequest, ScopedPlaybook,
};

/// Where a command finds its playbook files. Bundled and global playbooks are always on this
/// machine. A repo's own playbooks are in place for a local repo; for a repo on another machine they
/// are a scratch copy that `with_library` fills from the host and writes back to.
pub(crate) struct Library {
    pub(crate) roots: PlaybookRoots,
    local_repo: Option<PathBuf>,
    remote: Option<RemoteLibrary>,
}

struct RemoteLibrary {
    host_id: String,
    /// The scratch copy of the repo, and the host path it stands for.
    stage_repo: String,
    host_path: String,
}

impl Library {
    pub(crate) fn has_repo(&self) -> bool {
        !self.roots.repo_dir.as_os_str().is_empty()
    }

    /// Changing a repo's library needs a repo this window owns, or a host that is connected.
    pub(crate) fn require_owned(&self, state: &AppState) -> Result<(), String> {
        match (&self.local_repo, &self.remote) {
            (Some(repo), _) => require_repo_owned(state, repo),
            (_, Some(remote)) => connected_session(state, &remote.host_id).map(|_| ()),
            _ => Ok(()),
        }
    }

    /// Point any path in `value` that names the scratch copy at the host's file instead.
    pub(crate) fn rehome<T: Serialize + serde::de::DeserializeOwned>(&self, value: T) -> T {
        fn swap(json: &mut Value, from: &str, to: &str) {
            match json {
                Value::String(text) if text.contains(from) => *text = text.replace(from, to),
                Value::Array(items) => items.iter_mut().for_each(|item| swap(item, from, to)),
                Value::Object(map) => map.values_mut().for_each(|item| swap(item, from, to)),
                _ => {}
            }
        }
        let Some(remote) = &self.remote else { return value };
        let Ok(mut json) = serde_json::to_value(&value) else { return value };
        swap(&mut json, &remote.stage_repo, &remote.host_path);
        serde_json::from_value(json).unwrap_or(value)
    }
}

/// Removes the scratch copy when the command is done with it.
struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Run `work` against the playbook files of `repo_path` (or the active repo, or none). A remote
/// repo's files are copied here first and whatever `work` changed is sent back, refused if the host's
/// copy moved in the meantime. This is the one place that knows a library can be on another machine,
/// so the library, the community import registry and the picker preferences all work unchanged.
pub(crate) fn with_library<T>(app: &AppHandle, repo_path: Option<&str>, work: impl FnOnce(&Library) -> T) -> Result<T, String> {
    let target = match repo_path {
        Some(path) => Some(target_repo_ref_for_app(app, path)?),
        None => active_repo_ref().ok(),
    };
    with_library_at(&app_config_path(app)?, &app.state::<AppState>(), target, work)
}

pub(crate) fn with_library_at<T>(app_config: &Path, state: &AppState, target: Option<RepoRef>, work: impl FnOnce(&Library) -> T) -> Result<T, String> {
    let global_config_dir = app_config_dir_of(app_config).ok_or("app config root unavailable")?.to_path_buf();
    match target {
        None => Ok(work(&Library {
            roots: PlaybookRoots {
                global_config_dir,
                repo_dir: PathBuf::new(),
            },
            local_repo: None,
            remote: None,
        })),
        Some(RepoRef::Local(repo)) => Ok(work(&Library {
            roots: PlaybookRoots {
                global_config_dir,
                repo_dir: repo.clone(),
            },
            local_repo: Some(repo),
            remote: None,
        })),
        Some(RepoRef::Remote { host_id, path }) => {
            let before: Vec<alinery_core::playbook_tree::TreeFile> = remote_call(state, &host_id, RepoOp::ReadPlaybookTree { repo: path.clone().into() })?;
            let scratch = Scratch(std::env::temp_dir().join(format!("alinery-library-{}", uuid::Uuid::new_v4())));
            let stage_repo = scratch.0.join("repo");
            fs::create_dir_all(&stage_repo).map_err(|error| error.to_string())?;
            alinery_core::playbook_tree::write_tree(&stage_repo, &before)?;
            let library = Library {
                roots: PlaybookRoots {
                    global_config_dir,
                    repo_dir: stage_repo.clone(),
                },
                local_repo: None,
                remote: Some(RemoteLibrary {
                    host_id: host_id.clone(),
                    stage_repo: stage_repo.display().to_string(),
                    host_path: path.clone(),
                }),
            };
            let result = work(&library);
            let changes = alinery_core::playbook_tree::changes_since(&stage_repo, &before)?;
            if !changes.is_empty() {
                remote_call::<()>(state, &host_id, RepoOp::ApplyPlaybookTree { repo: path.into(), changes })?;
            }
            Ok(result)
        }
    }
}

#[tauri::command]
pub(crate) async fn list_playbook_catalog(app: AppHandle, repo_path: Option<String>) -> Result<PlaybookCatalog, String> {
    // Parsing every playbook is disk work. Keep it off the webview thread so New Task can paint.
    off_main_thread("list playbook catalog", move || {
        with_library(&app, repo_path.as_deref(), |lib| lib.rehome(library::load_playbook_catalog(&lib.roots)))
    })
    .await
}

#[tauri::command]
pub(crate) async fn read_playbook(app: AppHandle, reference: PlaybookRef, repo_path: Option<String>) -> Result<ScopedPlaybook, PlaybookLoadError> {
    let io_error = |reference: &PlaybookRef, message: String| PlaybookLoadError::Io {
        source: PlaybookSource {
            reference: reference.clone(),
            path: None,
        },
        message,
    };
    // Only a repo-scoped playbook is in the repo; the others never need a copy of it.
    let repo_path = repo_path.filter(|_| reference.scope == PlaybookScope::Repo);
    let for_errors = reference.clone();
    tauri::async_runtime::spawn_blocking(move || with_library(&app, repo_path.as_deref(), |lib| lib.rehome(library::resolve_playbook(&lib.roots, &reference))))
        .await
        .map_err(|error| io_error(&for_errors, error.to_string()))?
        .map_err(|message| io_error(&for_errors, message))?
}

#[derive(Serialize)]
pub(crate) struct PlaybookValidation {
    definition: Option<NormalizedPlaybook>,
    diagnostics: Vec<PlaybookValidationError>,
}

#[tauri::command]
pub(crate) fn validate_playbook_source(source: String) -> PlaybookValidation {
    match parse_playbook_md(&source) {
        Ok(definition) => PlaybookValidation {
            definition: Some(definition),
            diagnostics: Vec::new(),
        },
        Err(diagnostics) => PlaybookValidation { definition: None, diagnostics },
    }
}

#[tauri::command]
pub(crate) fn render_playbook_source(definition: NormalizedPlaybook) -> String {
    render_playbook_md(&definition)
}

fn save_io(message: impl ToString) -> PlaybookSaveError {
    PlaybookSaveError::Io { message: message.to_string() }
}

#[tauri::command]
pub(crate) async fn save_playbook_source(app: AppHandle, request: SavePlaybookRequest, repo_path: Option<String>) -> Result<ScopedPlaybook, PlaybookSaveError> {
    let repo_scope = request.target.scope == PlaybookScope::Repo;
    let repo_path = repo_path.filter(|_| repo_scope);
    tauri::async_runtime::spawn_blocking(move || {
        with_library(&app, repo_path.as_deref(), |lib| {
            if repo_scope {
                if !lib.has_repo() {
                    return Err(save_io("select a repository before saving a repo playbook"));
                }
                lib.require_owned(&app.state::<AppState>()).map_err(save_io)?;
            }
            library::save_playbook(&lib.roots, request).map(|saved| lib.rehome(saved))
        })
    })
    .await
    .map_err(save_io)?
    .map_err(save_io)?
}

#[tauri::command]
pub(crate) async fn delete_playbook_source(app: AppHandle, reference: PlaybookRef, repo_path: Option<String>) -> Result<(), PlaybookSaveError> {
    let repo_scope = reference.scope == PlaybookScope::Repo;
    let repo_path = repo_path.filter(|_| repo_scope);
    tauri::async_runtime::spawn_blocking(move || {
        with_library(&app, repo_path.as_deref(), |lib| {
            if repo_scope {
                if !lib.has_repo() {
                    return Err(save_io("select a repository before deleting a repo playbook"));
                }
                lib.require_owned(&app.state::<AppState>()).map_err(save_io)?;
            }
            delete_playbook_keeping_imports(&lib.roots, &reference)
        })
    })
    .await
    .map_err(save_io)?
    .map_err(save_io)?
}

#[tauri::command]
pub(crate) async fn read_playbook_picker_preferences(app: AppHandle, repo_path: Option<String>) -> Result<PickerPreferences, String> {
    off_main_thread("read playbook picker preferences", move || {
        with_library(&app, repo_path.as_deref(), |lib| library::load_picker_preferences(&lib.roots))?
    })
    .await
}

#[tauri::command]
pub(crate) async fn save_playbook_picker_preferences(app: AppHandle, preferences: PickerPreferences, repo_path: Option<String>) -> Result<(), PlaybookSaveError> {
    tauri::async_runtime::spawn_blocking(move || {
        with_library(&app, repo_path.as_deref(), |lib| {
            if lib.has_repo() {
                lib.require_owned(&app.state::<AppState>()).map_err(save_io)?;
            }
            library::save_picker_preferences(&lib.roots, &preferences)
        })
    })
    .await
    .map_err(save_io)?
    .map_err(save_io)?
}

#[derive(Serialize, Clone)]
pub(crate) struct KanbanColumn {
    pub(crate) key: String,
    pub(crate) title: String,
}

#[tauri::command]
pub(crate) fn list_kanban_columns(_app: AppHandle, all_repos: bool) -> Result<Vec<KanbanColumn>, String> {
    if !all_repos {
        let _ = active_repo_ref()?;
    }
    Ok(KANBAN_COLUMNS
        .iter()
        .map(|(key, title)| KanbanColumn {
            key: (*key).into(),
            title: (*title).into(),
        })
        .collect())
}

pub(crate) const KANBAN_COLUMNS: &[(&str, &str)] = &[
    ("research-design", "Research & Design"),
    ("planning", "Planning"),
    ("implementation", "Implementation"),
    ("review", "Review"),
];
