//! Keeping the Pi provider credentials of this Mac and a remote host in step.
//!
//! The store is `provider-credentials.json`: one opaque credential per provider, written by the
//! daemon under an `O_EXCL` `<file>.lock` (see `vinculum-daemon/src/credentials.ts`). OAuth
//! credentials rotate their refresh tokens, so a one-way copy would let the two sides
//! invalidate each other; instead the side with the later `expires` wins per provider.
//!
//! Direction rules: a provider the Mac has is pushed to the remote when the remote lacks it or
//! is not newer. A provider only the remote has is never pulled back, so logging out on the Mac
//! cannot be undone by a stale remote copy.

use serde_json::{Map, Value};
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

fn expires(credential: &Value) -> Option<f64> {
    credential.get("expires").and_then(Value::as_f64)
}

/// True when `incoming` should replace `existing`: no `expires` to compare means the pushing
/// side (the Mac) is the source of truth.
fn incoming_wins(incoming: &Value, existing: &Value) -> bool {
    match (expires(incoming), expires(existing)) {
        (Some(incoming), Some(existing)) => incoming >= existing,
        _ => true,
    }
}

/// Merge `incoming` (the Mac's credentials) into the store at `path`. Returns the providers
/// where the store holds a strictly newer credential, which the caller applies back locally.
pub fn apply_incoming(path: &Path, incoming: &Map<String, Value>) -> Result<Map<String, Value>, String> {
    with_store_lock(path, || {
        let mut store = read_store(path)?;
        let mut newer = Map::new();
        for (provider, credential) in incoming {
            match store.get(provider) {
                Some(existing) if !incoming_wins(credential, existing) => {
                    newer.insert(provider.clone(), existing.clone());
                }
                _ => {
                    store.insert(provider.clone(), credential.clone());
                }
            }
        }
        write_store(path, &store)?;
        Ok(newer)
    })
}

/// Replace the given providers in the store, leaving every other provider alone.
pub fn overwrite_providers(path: &Path, replacements: &Map<String, Value>) -> Result<(), String> {
    if replacements.is_empty() {
        return Ok(());
    }
    with_store_lock(path, || {
        let mut store = read_store(path)?;
        for (provider, credential) in replacements {
            if store.contains_key(provider) {
                store.insert(provider.clone(), credential.clone());
            }
        }
        write_store(path, &store)
    })
}

/// The Mac's whole store, or empty when it has none.
pub fn read_all(path: &Path) -> Result<Map<String, Value>, String> {
    read_store(path)
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
    fn pushes_missing_providers_and_keeps_remote_only_ones_remote() {
        let path = temp_store("push");
        write_store(&path, &map(json!({"remote-only": {"type": "api_key", "key": "r"}}))).unwrap();
        let newer = apply_incoming(&path, &map(json!({"anthropic": {"type": "api_key", "key": "a"}}))).unwrap();
        assert!(newer.is_empty());
        let store = read_store(&path).unwrap();
        assert_eq!(store["anthropic"]["key"], "a");
        assert_eq!(store["remote-only"]["key"], "r");
    }

    #[test]
    fn the_later_expiry_wins_and_a_newer_remote_comes_back() {
        let path = temp_store("expiry");
        write_store(&path, &map(json!({"oauth": {"type": "oauth", "refresh": "remote", "expires": 200}}))).unwrap();

        let newer = apply_incoming(&path, &map(json!({"oauth": {"type": "oauth", "refresh": "mac", "expires": 100}}))).unwrap();
        assert_eq!(newer["oauth"]["refresh"], "remote", "the remote refreshed after the Mac did");
        assert_eq!(read_store(&path).unwrap()["oauth"]["refresh"], "remote");

        let newer = apply_incoming(&path, &map(json!({"oauth": {"type": "oauth", "refresh": "mac", "expires": 300}}))).unwrap();
        assert!(newer.is_empty());
        assert_eq!(read_store(&path).unwrap()["oauth"]["refresh"], "mac");
    }

    #[test]
    fn without_expiry_the_pushing_side_wins() {
        let path = temp_store("noexp");
        write_store(&path, &map(json!({"k": {"type": "api_key", "key": "old"}}))).unwrap();
        apply_incoming(&path, &map(json!({"k": {"type": "api_key", "key": "new"}}))).unwrap();
        assert_eq!(read_store(&path).unwrap()["k"]["key"], "new");
    }

    #[test]
    fn overwrite_only_touches_providers_already_present() {
        let path = temp_store("overwrite");
        write_store(&path, &map(json!({"have": {"v": 1}}))).unwrap();
        overwrite_providers(&path, &map(json!({"have": {"v": 2}, "logged-out": {"v": 3}}))).unwrap();
        let store = read_store(&path).unwrap();
        assert_eq!(store["have"]["v"], 2);
        assert!(!store.contains_key("logged-out"), "a provider the Mac logged out of must not come back");
    }

    #[test]
    fn a_stale_lock_is_stolen_and_a_corrupt_store_is_refused() {
        let path = temp_store("lock");
        fs::write(lock_path(&path), "").unwrap();
        let old = SystemTime::now() - Duration::from_secs(60);
        fs::File::options().write(true).open(lock_path(&path)).unwrap().set_modified(old).unwrap();
        apply_incoming(&path, &map(json!({"a": {"v": 1}}))).unwrap();
        assert!(!lock_path(&path).exists(), "the lock is released");

        fs::write(&path, "not json").unwrap();
        assert!(apply_incoming(&path, &map(json!({"a": {"v": 1}}))).unwrap_err().contains("unreadable"));
    }
}
