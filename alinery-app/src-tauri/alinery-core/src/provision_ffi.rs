//! JSON entry points for the Pi daemon. The provisioning implementation stays in
//! `task_creation` and `subtask`. The caller frees every returned string with
//! `alinery_string_free`.

use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::path::Path;

use serde_json::json;

fn reply_string(body: String) -> *mut c_char {
    CString::new(body.replace('\0', " "))
        .unwrap_or_else(|_| CString::new(r#"{"error":"reply contained a null"}"#).expect("static reply"))
        .into_raw()
}

fn arguments(repo: *const c_char, lane: *const c_char, identity: *const c_char, request: *const c_char) -> Result<(String, String, String, String), String> {
    if repo.is_null() || lane.is_null() || identity.is_null() || request.is_null() {
        return Err("missing provisioning argument".into());
    }
    let repo = unsafe { CStr::from_ptr(repo) }.to_string_lossy().into_owned();
    let lane = unsafe { CStr::from_ptr(lane) }.to_string_lossy().into_owned();
    let identity = unsafe { CStr::from_ptr(identity) }.to_string_lossy().into_owned();
    let request = unsafe { CStr::from_ptr(request) }.to_string_lossy().into_owned();
    Ok((repo, lane, identity, request))
}

fn provision_json(repo: &str, lane: &str, identity: &str, request: &str) -> Result<String, String> {
    let request: crate::task_creation::CreateTaskRequest = serde_json::from_str(request).map_err(|error| error.to_string())?;
    let reply = crate::task_creation::provision_task(Path::new(repo), lane, identity, &request)?;
    serde_json::to_string(&reply).map_err(|error| error.to_string())
}

fn subtask_json(repo: &str, lane: &str, identity: &str, request: &str) -> Result<String, String> {
    let request: crate::CreateSubtaskInput = serde_json::from_str(request).map_err(|error| error.to_string())?;
    let reply = crate::create_subtask(Path::new(repo), lane, identity, request)?;
    serde_json::to_string(&reply).map_err(|error| error.to_string())
}

fn call(repo: *const c_char, lane: *const c_char, identity: *const c_char, request: *const c_char, op: fn(&str, &str, &str, &str) -> Result<String, String>) -> *mut c_char {
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let (repo, lane, identity, request) = arguments(repo, lane, identity, request)?;
        op(&repo, &lane, &identity, &request)
    }));
    let body = match outcome {
        Ok(Ok(body)) => body,
        Ok(Err(error)) => json!({ "error": error }).to_string(),
        Err(_) => json!({ "error": "provisioning panicked" }).to_string(),
    };
    reply_string(body)
}

/// # Safety
///
/// Each pointer must be null or a valid NUL-terminated string for the duration of the call.
/// The returned pointer is owned by the caller and freed with `alinery_string_free`.
#[no_mangle]
pub unsafe extern "C" fn alinery_provision_task(repo: *const c_char, lane: *const c_char, identity: *const c_char, request: *const c_char) -> *mut c_char {
    call(repo, lane, identity, request, provision_json)
}

/// # Safety
///
/// Same contract as `alinery_provision_task`.
#[no_mangle]
pub unsafe extern "C" fn alinery_create_subtask(repo: *const c_char, lane: *const c_char, identity: *const c_char, request: *const c_char) -> *mut c_char {
    call(repo, lane, identity, request, subtask_json)
}

fn c_string(ptr: *const c_char) -> Result<String, String> {
    if ptr.is_null() {
        return Err("missing session name argument".into());
    }
    Ok(unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned())
}

fn session_name_json(repo: &str, task_slug: &str, session_id: &str, name: &str) -> Result<String, String> {
    let outcome = crate::set_session_name(Path::new(repo), task_slug, session_id, name, crate::SessionNameSource::Auto)?;
    serde_json::to_string(&outcome).map_err(|error| error.to_string())
}

/// Save an automatic session or chat name. Manual names stay on the app command.
///
/// # Safety
///
/// Each pointer must be null or a valid NUL-terminated string for the duration of the call.
/// The returned pointer is owned by the caller and freed with `alinery_string_free`.
#[no_mangle]
pub unsafe extern "C" fn alinery_set_session_name(repo: *const c_char, task_slug: *const c_char, session_id: *const c_char, name: *const c_char) -> *mut c_char {
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        session_name_json(&c_string(repo)?, &c_string(task_slug)?, &c_string(session_id)?, &c_string(name)?)
    }));
    let body = match outcome {
        Ok(Ok(body)) => body,
        Ok(Err(error)) => json!({ "error": error }).to_string(),
        Err(_) => json!({ "error": "session naming panicked" }).to_string(),
    };
    reply_string(body)
}

/// # Safety
///
/// `reply` must be null or a pointer returned by `alinery_provision_task`, `alinery_create_subtask`,
/// or `alinery_set_session_name` that has not already been freed.
#[no_mangle]
pub unsafe extern "C" fn alinery_string_free(reply: *mut c_char) {
    if !reply.is_null() {
        drop(unsafe { CString::from_raw(reply) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_provision_json_is_an_error_reply() {
        let repo = c".";
        let lane = c"";
        let identity = c"test";
        let request = c"not-json";
        let reply = unsafe { alinery_provision_task(repo.as_ptr(), lane.as_ptr(), identity.as_ptr(), request.as_ptr()) };
        let text = unsafe { CStr::from_ptr(reply) }.to_string_lossy().into_owned();
        unsafe { alinery_string_free(reply) };
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert!(value.get("error").and_then(|item| item.as_str()).is_some());
    }

    fn ffi_name(repo: &std::path::Path, slug: &str, id: &str, name: &str) -> serde_json::Value {
        let repo = CString::new(repo.to_string_lossy().as_ref()).unwrap();
        let slug = CString::new(slug).unwrap();
        let id = CString::new(id).unwrap();
        let name = CString::new(name).unwrap();
        let reply = unsafe { alinery_set_session_name(repo.as_ptr(), slug.as_ptr(), id.as_ptr(), name.as_ptr()) };
        let text = unsafe { CStr::from_ptr(reply) }.to_string_lossy().into_owned();
        unsafe { alinery_string_free(reply) };
        serde_json::from_str(&text).unwrap()
    }

    #[test]
    fn automatic_chat_name_saves_and_a_human_name_wins() {
        let repo = std::env::temp_dir().join(format!("alinery-ffi-name-{}", uuid::Uuid::new_v4()));
        let id = "s01234567";
        let meta_path = crate::session_meta_path(&repo, "", id);
        std::fs::create_dir_all(meta_path.parent().unwrap()).unwrap();
        std::fs::write(
            &meta_path,
            serde_json::to_vec(&crate::SessionMeta {
                id: id.into(),
                harness: crate::DEFAULT_HARNESS_KEY.into(),
                generic: true,
                worktree: repo.to_string_lossy().into_owned(),
                created: 1,
                ..crate::SessionMeta::default()
            })
            .unwrap(),
        )
        .unwrap();
        let saved = ffi_name(&repo, "", id, "Fix login bug");
        assert_eq!(saved["status"], "saved");
        assert_eq!(saved["value"]["name"], "Fix login bug");
        assert_eq!(saved["value"]["source"], "auto");
        let replaced = ffi_name(&repo, "", id, "Login cookie scope");
        assert_eq!(replaced["status"], "saved");
        assert_eq!(replaced["value"]["name"], "Login cookie scope");
        crate::set_session_name(&repo, "", id, "My title", crate::SessionNameSource::User).unwrap();
        let kept = ffi_name(&repo, "", id, "Late auto");
        assert_eq!(kept["status"], "unchanged");
        assert_eq!(kept["value"]["source"], "user");
        assert_eq!(kept["value"]["name"], "My title");
        let missing = ffi_name(&repo, "", "missing", "Nope");
        assert!(missing.get("error").and_then(|item| item.as_str()).is_some());
        let _ = std::fs::remove_dir_all(&repo);
    }
}
