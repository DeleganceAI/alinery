//! Putting the provider credentials the user chose onto a remote host.
//!
//! The store is `provider-credentials.json`: one opaque credential per provider, written by the
//! daemon under an `O_EXCL` `<file>.lock` (see `vinculum-daemon/src/credentials.ts`). Only API
//! keys travel from the Mac, and only the ones the user picked. A browser sign-in (`oauth`) is
//! never copied: its refresh token rotates, so two copies of one sign-in would log each other out.
//! The host signs in for itself, and a sign-in made there is left alone here.

use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::{Duration, SystemTime};

const LOCK_ATTEMPTS: u32 = 250;
const LOCK_RETRY: Duration = Duration::from_millis(20);
const LOCK_STALE: Duration = Duration::from_secs(5);

fn lock_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".lock");
    PathBuf::from(name)
}

/// Same protocol as the daemon: create `<file>.lock` exclusively, steal it after 5 s.
fn with_store_lock<T>(path: &Path, run: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("create {}: {error}", parent.display()))?;
    }
    let lock = lock_path(path);
    for _ in 0..LOCK_ATTEMPTS {
        match OpenOptions::new().write(true).create_new(true).open(&lock) {
            Ok(_) => {
                let result = run();
                let _ = fs::remove_file(&lock);
                return result;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let stale = fs::metadata(&lock)
                    .and_then(|meta| meta.modified())
                    .is_ok_and(|modified| SystemTime::now().duration_since(modified).unwrap_or_default() > LOCK_STALE);
                if stale {
                    let _ = fs::remove_file(&lock);
                }
                sleep(LOCK_RETRY);
            }
            Err(error) => return Err(format!("lock {}: {error}", path.display())),
        }
    }
    Err("credential store is busy".to_string())
}

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

fn write_store(path: &Path, store: &Map<String, Value>) -> Result<(), String> {
    let bytes = serde_json::to_vec(store).map_err(|error| error.to_string())?;
    crate::write_owner_only_bytes(path, &bytes)
}

fn is_oauth(credential: &Value) -> bool {
    credential.get("type").and_then(Value::as_str) == Some("oauth")
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

/// Change the host's store. `set` replaces those providers; `remove` drops API keys this app
/// copied earlier (a sign-in the host made since is kept); `erase_oauth` drops every browser
/// sign-in, once, for a host set up before sign-ins stopped being copied. Returns the sign-ins
/// erased.
pub fn apply(path: &Path, set: &Map<String, Value>, remove: &[String], erase_oauth: bool) -> Result<Vec<String>, String> {
    with_store_lock(path, || {
        let mut store = read_store(path)?;
        let mut erased = Vec::new();
        if erase_oauth {
            erased = store.iter().filter(|(_, credential)| is_oauth(credential)).map(|(provider, _)| provider.clone()).collect();
            store.retain(|_, credential| !is_oauth(credential));
        }
        for provider in remove {
            if store.get(provider).is_some_and(|credential| !is_oauth(credential)) {
                store.remove(provider);
            }
        }
        for (provider, credential) in set {
            store.insert(provider.clone(), credential.clone());
        }
        write_store(path, &store)?;
        Ok(erased)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_store(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ai-cred-{name}-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]));
        fs::create_dir_all(&dir).unwrap();
        dir.join("provider-credentials.json")
    }

    fn map(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn only_the_chosen_api_keys_are_offered_and_sign_ins_never_are() {
        let path = temp_store("offer");
        write_store(
            &path,
            &map(json!({
                "anthropic": {"type": "api_key", "key": "a"},
                "openai": {"type": "api_key", "key": "o"},
                "codex": {"type": "oauth", "refresh": "r", "expires": 5}
            })),
        )
        .unwrap();
        let kinds = kinds(&path).unwrap();
        assert_eq!(kinds["anthropic"], "api_key");
        assert_eq!(kinds["codex"], "oauth");
        let chosen = api_keys(&path, &["anthropic".into(), "codex".into(), "gone".into()]).unwrap();
        assert_eq!(chosen.keys().collect::<Vec<_>>(), ["anthropic"], "a sign-in or a missing provider is not a key to copy");
    }

    #[test]
    fn set_replaces_and_keeps_every_other_provider() {
        let path = temp_store("set");
        write_store(&path, &map(json!({"host-only": {"type": "oauth", "refresh": "h"}, "k": {"type": "api_key", "key": "old"}}))).unwrap();
        apply(&path, &map(json!({"k": {"type": "api_key", "key": "new"}})), &[], false).unwrap();
        let store = read_store(&path).unwrap();
        assert_eq!(store["k"]["key"], "new");
        assert_eq!(store["host-only"]["refresh"], "h", "a sign-in made on the host is not touched");
    }

    #[test]
    fn remove_drops_a_copied_key_but_not_a_sign_in_that_took_its_place() {
        let path = temp_store("remove");
        write_store(
            &path,
            &map(json!({"copied": {"type": "api_key", "key": "k"}, "signed-in": {"type": "oauth", "refresh": "r"}})),
        )
        .unwrap();
        apply(&path, &Map::new(), &["copied".into(), "signed-in".into(), "absent".into()], false).unwrap();
        let store = read_store(&path).unwrap();
        assert!(!store.contains_key("copied"));
        assert!(store.contains_key("signed-in"), "the host's own sign-in stays even if the Mac once copied a key there");
    }

    #[test]
    fn erase_oauth_removes_sign_ins_only_and_names_them() {
        let path = temp_store("erase");
        write_store(
            &path,
            &map(json!({"a": {"type": "oauth", "refresh": "r"}, "b": {"type": "api_key", "key": "k"}, "c": {"type": "oauth", "refresh": "s"}})),
        )
        .unwrap();
        let mut erased = apply(&path, &Map::new(), &[], true).unwrap();
        erased.sort();
        assert_eq!(erased, ["a", "c"]);
        assert_eq!(read_store(&path).unwrap().keys().collect::<Vec<_>>(), ["b"]);
        assert!(apply(&path, &Map::new(), &[], false).unwrap().is_empty(), "without the flag nothing is erased");
    }

    #[test]
    fn a_stale_lock_is_stolen_and_a_corrupt_store_is_refused() {
        let path = temp_store("lock");
        fs::write(lock_path(&path), "").unwrap();
        let old = SystemTime::now() - Duration::from_secs(60);
        fs::File::options().write(true).open(lock_path(&path)).unwrap().set_modified(old).unwrap();
        apply(&path, &map(json!({"a": {"v": 1}})), &[], false).unwrap();
        assert!(!lock_path(&path).exists(), "the lock is released");

        fs::write(&path, "not json").unwrap();
        assert!(apply(&path, &map(json!({"a": {"v": 1}})), &[], false).unwrap_err().contains("unreadable"));
    }
}
