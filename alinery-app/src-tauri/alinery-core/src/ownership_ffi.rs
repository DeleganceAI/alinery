//! Same `repo_ownership::acquire` the release daemon calls, held for the process lifetime.
//! The Pi daemon loads this cdylib and calls it before binding the UI socket. The helper
//! must not call it.

use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::path::Path;

static LAST_ERROR: std::sync::Mutex<Option<CString>> = std::sync::Mutex::new(None);
// Runtime path, lane, and identity are arguments, so this cannot be a LazyLock.
static HELD_OWNERSHIP: std::sync::OnceLock<crate::repo_ownership::RepoOwnership> = std::sync::OnceLock::new();

fn set_error(message: &str) {
    if let Ok(mut slot) = LAST_ERROR.lock() {
        *slot = CString::new(message.replace('\0', " ")).ok();
    }
}

/// Acquire `.repo-owner.lock` and the lane locks and keep the guard until process exit.
/// Returns 0 on success. Does not unlink lock files.
///
/// # Safety
///
/// `repo`, `lane`, and `identity` must be null or point at valid NUL-terminated strings
/// that live for the duration of the call.
#[no_mangle]
pub unsafe extern "C" fn alinery_pi_acquire(repo: *const c_char, lane: *const c_char, identity: *const c_char) -> i32 {
    let outcome = std::panic::catch_unwind(|| {
        if repo.is_null() || lane.is_null() || identity.is_null() {
            return Err("missing ownership argument".to_string());
        }
        let repo = unsafe { CStr::from_ptr(repo) }.to_string_lossy().into_owned();
        let lane = unsafe { CStr::from_ptr(lane) }.to_string_lossy().into_owned();
        let identity = unsafe { CStr::from_ptr(identity) }.to_string_lossy().into_owned();
        let guard = crate::repo_ownership::acquire(Path::new(&repo), &lane, &identity)?;
        HELD_OWNERSHIP.set(guard).map_err(|_| "ownership already held".to_string())?;
        Ok(())
    });
    match outcome {
        Ok(Ok(())) => 0,
        Ok(Err(error)) => {
            set_error(&error);
            1
        }
        Err(_) => {
            set_error("ownership acquire panicked");
            1
        }
    }
}

#[no_mangle]
pub extern "C" fn alinery_pi_acquire_error() -> *const c_char {
    LAST_ERROR
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(|value| value.as_ptr()))
        .unwrap_or(std::ptr::null())
}
