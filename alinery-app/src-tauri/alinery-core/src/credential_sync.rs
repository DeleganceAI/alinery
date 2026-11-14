//! Choosing the provider credentials to put on a remote host (the Mac's half).
//!
//! The store is `provider-credentials.json`: one opaque credential per provider, written by the
//! daemon under an `O_EXCL` `<file>.lock` (see `vinculum-daemon/src/credentials.ts`). Only API
//! keys travel from the Mac, and only the ones the user picked. A browser sign-in (`oauth`) is
//! never copied: its refresh token rotates, so two copies of one sign-in would log each other out.
//! The host signs in for itself, and a sign-in made there is left alone. The merge into the host's
//! store is the host service's (`vinculum-daemon/src/hostService`, plan S5.2).

use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

fn read_store(path: &Path) -> Result<Map<String, Value>, String> {
    match fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(map)) => Ok(map),
            _ => Err("credential store is unreadable".to_string()),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(error) => Err(format!("read {}: {error}", path.display())),
    }
}

/// The Mac's providers and what each holds: `api_key` or `oauth`.
pub fn kinds(path: &Path) -> Result<BTreeMap<String, String>, String> {
    Ok(read_store(path)?
        .into_iter()
        .filter_map(|(provider, credential)| {
            let kind = credential.get("type").and_then(Value::as_str)?;
            matches!(kind, "api_key" | "oauth").then(|| (provider, kind.to_string()))
        })
        .collect())
}

/// The API keys among `providers`. A provider the Mac no longer holds as a key (logged out, or
/// now a browser sign-in) is left out, which is how a stale choice stops being copied.
pub fn api_keys(path: &Path, providers: &[String]) -> Result<Map<String, Value>, String> {
    let store = read_store(path)?;
    Ok(providers
        .iter()
        .filter_map(|provider| {
            let credential = store.get(provider)?;
            (credential.get("type").and_then(Value::as_str) == Some("api_key")).then(|| (provider.clone(), credential.clone()))
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    fn temp_store(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ai-cred-{name}-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]));
        fs::create_dir_all(&dir).unwrap();
        dir.join("provider-credentials.json")
    }

    #[test]
    fn only_the_chosen_api_keys_are_offered_and_sign_ins_never_are() {
        let path = temp_store("offer");
        fs::write(
            &path,
            json!({
                "anthropic": {"type": "api_key", "key": "a"},
                "openai": {"type": "api_key", "key": "o"},
                "codex": {"type": "oauth", "refresh": "r", "expires": 5}
            })
            .to_string(),
        )
        .unwrap();
        let kinds = kinds(&path).unwrap();
        assert_eq!(kinds["anthropic"], "api_key");
        assert_eq!(kinds["codex"], "oauth");
        let chosen = api_keys(&path, &["anthropic".into(), "codex".into(), "gone".into()]).unwrap();
        assert_eq!(chosen.keys().collect::<Vec<_>>(), ["anthropic"], "a sign-in or a missing provider is not a key to copy");
    }
}
