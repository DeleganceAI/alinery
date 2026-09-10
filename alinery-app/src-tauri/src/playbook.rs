//! playbook: extracted from lib.rs. See AGENTS.md for the module map.
use crate::*;

// SuperDevelop phases and phase_prompt live in alinery-core (single source of truth for alineryd + app).
#[derive(Serialize)]
pub(crate) struct Phase {
    pub(crate) key: String,
    pub(crate) title: String,
}

#[tauri::command]
pub(crate) fn list_phases() -> Vec<Phase> {
    PHASES
        .iter()
        .map(|(k, t, _)| Phase {
            key: k.to_string(),
            title: t.to_string(),
        })
        .collect()
}

pub(crate) fn list_playbooks_in(repo: &Path) -> Vec<PlaybookSummary> {
    let f = alinery_core::load_playbooks(repo);
    let mut keys = f.playbook_order.clone();
    for key in f.playbooks.keys() {
        if !keys.contains(key) {
            keys.push(key.clone());
        }
    }
    keys.into_iter()
        .filter_map(|key| {
            let wf = f.playbooks.get(&key)?;
            Some(PlaybookSummary {
                key: key.clone(),
                title: wf.title.clone(),
                description: wf.description.clone(),
                kind: wf.kind.clone(),
                default_harness: wf.default_harness.clone(),
                steps: wf.steps.clone(),
                auto_advance: alinery_core::ordered_auto_advance_edges(wf)
                    .into_iter()
                    .map(|(edge_key, edge)| AutoAdvanceSummary {
                        key: edge_key.clone(),
                        title: edge.title.clone(),
                        from: edge.from.clone(),
                        to: edge.to.clone(),
                        default_enabled: edge.default_enabled,
                    })
                    .collect(),
            })
        })
        .collect()
}

#[tauri::command]
pub(crate) fn list_playbooks() -> Result<Vec<PlaybookSummary>, String> {
    Ok(list_playbooks_in(&active_repo()?))
}

#[tauri::command]
pub(crate) fn list_playbooks_for_repo(app: AppHandle, repo_path: String) -> Result<Vec<PlaybookSummary>, String> {
    Ok(list_playbooks_in(&target_repo_for_app(&app, &repo_path)?))
}

#[tauri::command]
pub(crate) fn get_playbook(key: String) -> Result<alinery_core::Playbook, String> {
    let repo = active_repo()?;
    alinery_core::get_playbook(&repo, &key).ok_or_else(|| format!("unknown playbook '{key}'"))
}

pub(crate) fn list_playbook_steps_in(repo: &Path, playbook: &str) -> Result<Vec<PlaybookStepSummary>, String> {
    let wf = alinery_core::get_playbook(repo, playbook).ok_or_else(|| format!("unknown playbook '{playbook}'"))?;
    Ok(wf
        .steps
        .iter()
        .filter_map(|key| {
            let step = wf.step.get(key)?;
            Some(PlaybookStepSummary {
                key: key.clone(),
                title: step.title.clone(),
                short: step.short.clone(),
                artifact: step.artifact.clone(),
                column: step.column.clone(),
                harness: step.harness.clone(),
            })
        })
        .collect())
}

#[tauri::command]
pub(crate) async fn list_playbook_steps(playbook: String) -> Result<Vec<PlaybookStepSummary>, String> {
    list_playbook_steps_in(&active_repo()?, &playbook)
}

#[tauri::command]
pub(crate) fn list_playbook_steps_for_repo(app: AppHandle, repo_path: String, playbook: String) -> Result<Vec<PlaybookStepSummary>, String> {
    list_playbook_steps_in(&target_repo_for_app(&app, &repo_path)?, &playbook)
}

#[tauri::command]
pub(crate) fn list_kanban_columns(_app: AppHandle, all_repos: bool) -> Result<Vec<KanbanColumn>, String> {
    if !all_repos {
        let _ = active_repo()?;
    }
    Ok(KANBAN_COLUMNS
        .iter()
        .map(|(key, title)| KanbanColumn {
            key: (*key).into(),
            title: (*title).into(),
        })
        .collect())
}

#[derive(Serialize)]
pub(crate) struct PlaybookSummary {
    pub(crate) key: String,
    pub(crate) title: String,
    pub(crate) description: String,
    pub(crate) kind: String,
    pub(crate) default_harness: String,
    pub(crate) steps: Vec<String>,
    pub(crate) auto_advance: Vec<AutoAdvanceSummary>,
}

#[derive(Serialize)]
pub(crate) struct PlaybookStepSummary {
    pub(crate) key: String,
    pub(crate) title: String,
    pub(crate) short: String,
    pub(crate) artifact: String,
    pub(crate) column: String,
    pub(crate) harness: String,
}

#[derive(Serialize, Clone)]
pub(crate) struct KanbanColumn {
    pub(crate) key: String,
    pub(crate) title: String,
}

pub(crate) fn playbook_key_for_task(task: &Task) -> String {
    task.playbook.clone()
}

pub(crate) fn playbook_step_exists(repo: &Path, playbook: &str, phase: &str) -> bool {
    if phase.is_empty() {
        return false;
    }
    alinery_core::get_playbook(repo, playbook).map(|wf| wf.steps.iter().any(|s| s == phase)).unwrap_or(false)
}

pub(crate) fn first_step_for_playbook(repo: &Path, playbook: &str) -> String {
    alinery_core::get_playbook(repo, playbook)
        .filter(|wf| wf.kind != "freeform")
        .and_then(|wf| wf.steps.first().cloned())
        .unwrap_or_default()
}

pub(crate) fn default_auto_advance_for_playbook(repo: &Path, playbook: &str) -> Vec<String> {
    alinery_core::get_playbook(repo, playbook)
        .map(|wf| {
            alinery_core::ordered_auto_advance_edges(&wf)
                .into_iter()
                .filter(|(_, edge)| edge.default_enabled)
                .map(|(key, _)| key.clone())
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn playbook_title(repo: &Path, key: &str) -> String {
    alinery_core::get_playbook(repo, key)
        .map(|wf| if wf.title.is_empty() { key.to_string() } else { wf.title })
        .unwrap_or_else(|| format!("Unknown playbook ({key})"))
}

pub(crate) fn step_title(repo: &Path, playbook: &str, phase: &str) -> String {
    if phase.is_empty() {
        return String::new();
    }
    alinery_core::get_playbook(repo, playbook)
        .and_then(|wf| wf.step.get(phase).cloned())
        .map(|st| if st.title.is_empty() { phase.to_string() } else { st.title })
        .unwrap_or_else(|| phase.to_string())
}

pub(crate) fn resolve_playbook_selection(repo: &Path, playbook: &str) -> String {
    let f = alinery_core::load_playbooks(repo);
    if !playbook.trim().is_empty() && f.playbooks.contains_key(playbook.trim()) {
        playbook.trim().to_string()
    } else if f.playbooks.contains_key(&f.default) {
        f.default
    } else {
        alinery_core::DEFAULT_PLAYBOOK_KEY.to_string()
    }
}

pub(crate) const KANBAN_COLUMNS: &[(&str, &str)] = &[
    ("research-design", "Research & Design"),
    ("planning", "Planning"),
    ("implementation", "Implementation"),
    ("review", "Review"),
];

pub(crate) fn kanban_column_for_phase(phase: &str) -> (&'static str, &'static str) {
    match phase {
        "structure" | "tdd" => ("planning", "Planning"),
        "implementation" => ("implementation", "Implementation"),
        "pr" => ("review", "Review"),
        p if p.starts_with("review-") => ("review", "Review"),
        _ => ("research-design", "Research & Design"),
    }
}

pub(crate) fn column_for_phase(_repo: &Path, _playbook: &str, phase: &str) -> (String, String) {
    let (key, title) = kanban_column_for_phase(phase);
    (key.into(), title.into())
}
