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

/// # Safety
///
/// `reply` must be null or a pointer returned by `alinery_provision_task` or `alinery_create_subtask`
/// that has not already been freed.
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
}
