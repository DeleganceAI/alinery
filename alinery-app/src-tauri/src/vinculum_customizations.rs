//! The two parts of the agent directory's page that need this machine: the Finder window and the file picker. The directory itself
//! (model roles, the inventory, skill install and delete, the prompt) is the daemon's on every host, `AgentService` (S4.10, O12 a);
//! a picked skill reaches it as a staged upload the page makes.
use crate::*;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// Reveals this machine's agent directory. A host's own is not on this machine; the page hides the button for a remote repository.
#[tauri::command]
pub(crate) async fn open_vinculum_agent_dir(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (agent_dir, _) = alinery_core::vinculum_home_dirs(&app_config_path(&app)?);
        fs::create_dir_all(&agent_dir).map_err(|error| format!("Cannot create the Vinculum agent directory: {error}"))?;
        app.opener().open_path(agent_dir.to_string_lossy(), None::<&str>).map_err(|error| error.to_string())
    })
    .await
    .map_err(|_| "Could not open the Vinculum agent directory".to_string())?
}

#[tauri::command]
pub(crate) async fn pick_vinculum_skill_dialog(app: AppHandle) -> Result<Option<String>, String> {
    let Some(file) = app.dialog().file().set_title("Choose a skill").add_filter("Skill", &["md", "zip"]).blocking_pick_file() else {
        return Ok(None);
    };
    Ok(Some(file.into_path().map_err(|error| error.to_string())?.to_string_lossy().into_owned()))
}
