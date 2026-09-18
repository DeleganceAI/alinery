//! Canonical scope-qualified playbook library commands. Runtime task definitions are daemon-owned.
use crate::*;
use alinery_core::playbook::{NormalizedPlaybook, PlaybookRef, PlaybookValidationError, parse_playbook_md, render_playbook_md};
use alinery_core::playbook_library::{self as library, PlaybookRoots, PlaybookCatalog, ScopedPlaybook, SavePlaybookRequest, PickerPreferences, PlaybookSaveError, PlaybookLoadError};

fn library_roots(app: &AppHandle, repo_path: Option<&str>) -> Result<PlaybookRoots, String> {
    let repo_dir = match repo_path {
        Some(path) => target_repo_for_app(app, path)?,
        None => active_repo().unwrap_or_default(),
    };
    let config = app_config_path(app)?;
    let global_config_dir = app_config_dir_of(&config).ok_or("app config root unavailable")?.to_path_buf();
    Ok(PlaybookRoots { global_config_dir, repo_dir })
}

#[tauri::command]
pub(crate) fn list_playbook_catalog(app: AppHandle, repo_path: Option<String>) -> Result<PlaybookCatalog, String> {
    Ok(library::load_playbook_catalog(&library_roots(&app, repo_path.as_deref())?))
}

#[tauri::command]
pub(crate) fn read_playbook(app: AppHandle, reference: PlaybookRef, repo_path: Option<String>) -> Result<ScopedPlaybook, PlaybookLoadError> {
    let roots = library_roots(&app, repo_path.as_deref()).map_err(|message| PlaybookLoadError::Io {
        source: library::PlaybookSource { reference: reference.clone(), path: None }, message,
    })?;
    library::resolve_playbook(&roots, &reference)
}

#[derive(Serialize)]
pub(crate) struct PlaybookValidation {
    definition: Option<NormalizedPlaybook>,
    diagnostics: Vec<PlaybookValidationError>,
}

#[tauri::command]
pub(crate) fn validate_playbook_source(source: String) -> PlaybookValidation {
    match parse_playbook_md(&source) {
        Ok(definition) => PlaybookValidation { definition: Some(definition), diagnostics: Vec::new() },
        Err(diagnostics) => PlaybookValidation { definition: None, diagnostics },
    }
}

#[tauri::command]
pub(crate) fn render_playbook_source(definition: NormalizedPlaybook) -> String {
    render_playbook_md(&definition)
}

#[tauri::command]
pub(crate) fn save_playbook_source(app: AppHandle, request: SavePlaybookRequest, repo_path: Option<String>) -> Result<ScopedPlaybook, PlaybookSaveError> {
    let roots = library_roots(&app, repo_path.as_deref()).map_err(|message| PlaybookSaveError::Io { message })?;
    if request.target.scope == alinery_core::playbook::PlaybookScope::Repo {
        if roots.repo_dir.as_os_str().is_empty() { return Err(PlaybookSaveError::Io { message: "select a repository before saving a repo playbook".into() }); }
        require_repo_owned(&app.state::<AppState>(), &roots.repo_dir).map_err(|message| PlaybookSaveError::Io { message })?;
    }
    library::save_playbook(&roots, request)
}

#[tauri::command]
pub(crate) fn delete_playbook_source(app: AppHandle, reference: PlaybookRef, repo_path: Option<String>) -> Result<(), PlaybookSaveError> {
    let roots = library_roots(&app, repo_path.as_deref()).map_err(|message| PlaybookSaveError::Io { message })?;
    if reference.scope == alinery_core::playbook::PlaybookScope::Repo {
        if roots.repo_dir.as_os_str().is_empty() { return Err(PlaybookSaveError::Io { message: "select a repository before deleting a repo playbook".into() }); }
        require_repo_owned(&app.state::<AppState>(), &roots.repo_dir).map_err(|message| PlaybookSaveError::Io { message })?;
    }
    library::delete_playbook(&roots, &reference)
}

#[tauri::command]
pub(crate) fn read_playbook_picker_preferences(app: AppHandle) -> Result<PickerPreferences, String> {
    library::load_picker_preferences(&library_roots(&app, None)?)
}

#[tauri::command]
pub(crate) fn save_playbook_picker_preferences(app: AppHandle, preferences: PickerPreferences) -> Result<(), PlaybookSaveError> {
    let roots = library_roots(&app, None).map_err(|message| PlaybookSaveError::Io { message })?;
    library::save_picker_preferences(&roots, &preferences)
}

#[derive(Serialize, Clone)]
pub(crate) struct KanbanColumn { pub(crate) key: String, pub(crate) title: String }

#[tauri::command]
pub(crate) fn list_kanban_columns(_app: AppHandle, all_repos: bool) -> Result<Vec<KanbanColumn>, String> {
    if !all_repos { let _ = active_repo()?; }
    Ok(KANBAN_COLUMNS.iter().map(|(key, title)| KanbanColumn { key: (*key).into(), title: (*title).into() }).collect())
}

pub(crate) const KANBAN_COLUMNS: &[(&str, &str)] = &[
    ("research-design", "Research & Design"), ("planning", "Planning"), ("implementation", "Implementation"), ("review", "Review"),
];

