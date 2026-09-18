use alinery_core::*;
use serde_json::{json, Value};
use std::{io::{self, Read}, path::PathBuf};

fn main() {
    let args: Vec<_> = std::env::args().collect();
    let roots = PlaybookRoots { repo_dir: PathBuf::from(&args[1]), global_config_dir: PathBuf::from(&args[2]) };
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let request: Value = serde_json::from_str(&input).unwrap();
    let command = request["command"].as_str().unwrap();
    let arguments = &request["args"];
    let result: Result<Value, Value> = (|| {
        let source = || arguments["source"].as_str().ok_or_else(|| json!("missing source"));
        match command {
            "list_playbook_catalog" => Ok(json!(load_playbook_catalog(&roots))),
            "read_playbook" => {
                let reference = serde_json::from_value(arguments["reference"].clone()).map_err(|e| json!(e.to_string()))?;
                resolve_playbook(&roots, &reference).map(|value| json!(value)).map_err(|e| json!(e))
            },
            "validate_playbook_source" => Ok(match parse_playbook_md(source()?) {
                Ok(definition) => json!({"definition": definition, "diagnostics": []}),
                Err(diagnostics) => json!({"definition": null, "diagnostics": diagnostics}),
            }),
            "render_playbook_source" => {
                let definition = serde_json::from_value(arguments["definition"].clone()).map_err(|e| json!(e.to_string()))?;
                Ok(json!(render_playbook_md(&definition)))
            },
            "save_playbook_source" => {
                let request = serde_json::from_value(arguments["request"].clone()).map_err(|e| json!(e.to_string()))?;
                save_playbook(&roots, request).map(|value| json!(value)).map_err(|e| json!(e))
            },
            "delete_playbook_source" => {
                let reference = serde_json::from_value(arguments["reference"].clone()).map_err(|e| json!(e.to_string()))?;
                delete_playbook(&roots, &reference).map(|()| Value::Null).map_err(|e| json!(e))
            },
            "read_playbook_picker_preferences" => load_picker_preferences(&roots).map(|value| json!(value)).map_err(|e| json!(e)),
            "save_playbook_picker_preferences" => {
                let preferences = serde_json::from_value(arguments["preferences"].clone()).map_err(|e| json!(e.to_string()))?;
                save_picker_preferences(&roots, &preferences).map(|()| Value::Null).map_err(|e| json!(e))
            },
            "read_global_settings" => load_global_settings_strict(&roots.global_config_dir.join("app.toml")).map(|settings| json!(settings)).map_err(|error| json!(error)),
            "read_config_for_repo" => read_scoped_settings_strict(&roots.global_config_dir.join("app.toml"), &roots.repo_dir).map(|settings| json!(settings.effective)).map_err(|error| json!(error)),
            "read_model_favorites" => {
                let settings = load_global_settings_strict(&roots.global_config_dir.join("app.toml")).map_err(|error| json!(error))?;
                Ok(json!(settings.model_favorites.get(arguments["harness"].as_str().unwrap_or("omp")).map(Vec::as_slice).unwrap_or(&[])))
            },
            "list_harness_models_for_repo" | "list_harness_models" | "connection_statuses" => Ok(json!([])),
            _ => Err(json!(format!("unhandled smoke command: {command}"))),
        }
    })();
    println!("{}", match result { Ok(value) => json!({"ok":true,"value":value}), Err(error) => json!({"ok":false,"error":error}) });
}
