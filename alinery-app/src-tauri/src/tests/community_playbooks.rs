//! Community playbook library and the auth retry it uses. What stays in the shell is the network half: browsing, the library's
//! version of a publication, downloading a package with this machine's account, previewing and publishing. The registry and the
//! import/update/delete rules are the daemon's (`vinculum-daemon/src/rpc/community.test.ts`).
//!
//! HTTP is injected. These tests must not open a socket to accounts.alinery.ai
//! or to the production Supabase host.
use super::*;
use crate::{
    community_remote_status_with, download_community_source_with, list_community_playbooks_with, list_my_community_playbooks_with, preview_community_playbook_with,
    publish_community_playbook_with, unpublish_community_playbook_with, CommunityHttp, CommunityHttpRequest, CommunityHttpResponse, MineResult, PreviewResult, PublishResult,
    SourceResult, UnpublishResult,
};
use crate::{rotated_tokens_for_test, save_tokens_for_test, AccountTokens};

fn write_pairing(path: &Path, access: &str, refresh: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        path,
        serde_json::json!({
            "access_token": access,
            "refresh_token": refresh,
            "expires_at": 4_000_000_000u64,
            "user": { "id": "u1", "email": "a@example.com", "providers": [] },
            "plan": "Founders Edition",
            "session_id": format!("session-{refresh}")
        })
        .to_string(),
    )
    .unwrap();
}

fn auth_dir(name: &str) -> std::path::PathBuf {
    unique_attachment_temp(name)
}

/// The same session with a different refresh token — what another operation's rotation
/// looks like on disk. `write_pairing` derives the session from the refresh token, so it
/// cannot express "same session, new generation".
fn write_rotated_pairing(path: &Path, session_id: &str, access: &str, refresh: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        path,
        serde_json::json!({
            "access_token": access,
            "refresh_token": refresh,
            "expires_at": 4_000_000_000u64,
            "user": { "id": "u1", "email": "a@example.com", "providers": [] },
            "plan": "Founders Edition",
            "session_id": session_id
        })
        .to_string(),
    )
    .unwrap();
}

fn session_of(path: &Path) -> String {
    let value: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    value["session_id"].as_str().unwrap_or_default().to_string()
}

/// What a refresh seam produces from `base`, persisted the way `refresh_paired_access`
/// persists it. The retry clears exactly the generation it tested, so a fake seam that
/// only returned a token would not model the real one.
fn rotated(path: &Path, tokens: &AccountTokens) -> AccountTokens {
    let next = rotated_tokens_for_test(tokens, "new-access", "rotated-refresh");
    save_tokens_for_test(path, &next);
    next
}

#[test]
fn missing_auth_does_not_call() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let path = auth_dir("community-auth-missing").join("auth.json");
    let mut calls = 0;
    let mut refreshes = 0;
    let result: Result<(), AuthRetryError> = with_access_token_retry(
        &path,
        |_| {
            calls += 1;
            AuthAttempt::Response(())
        },
        |tokens| {
            refreshes += 1;
            Ok(rotated(&path, tokens))
        },
    );
    assert!(matches!(result, Err(AuthRetryError::NeedsAccount)), "{result:?}");
    assert_eq!(calls, 0);
    assert_eq!(refreshes, 0);
}

#[test]
fn success_does_not_refresh() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let path = auth_dir("community-auth-ok").join("auth.json");
    write_pairing(&path, "old-access", "refresh-keep");
    let mut seen = Vec::new();
    let mut refreshes = 0;
    let result = with_access_token_retry(
        &path,
        |token| {
            seen.push(token.to_string());
            // A completed non-401 status, including 404 and 503, is Response.
            AuthAttempt::Response("ok")
        },
        |tokens| {
            refreshes += 1;
            Ok(rotated(&path, tokens))
        },
    );
    assert_eq!(result.unwrap(), "ok");
    assert_eq!(refreshes, 0);
    assert_eq!(seen, vec!["old-access".to_string()]);
    assert!(path.is_file());
}

#[test]
fn unauthorized_refreshes_once() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let path = auth_dir("community-auth-refresh").join("auth.json");
    write_pairing(&path, "old-access", "refresh-keep");
    let mut seen = Vec::new();
    let result = with_access_token_retry(
        &path,
        |token| {
            seen.push(token.to_string());
            if seen.len() == 1 {
                AuthAttempt::Unauthorized
            } else {
                AuthAttempt::Response("ok")
            }
        },
        |tokens| Ok(rotated(&path, tokens)),
    );
    assert_eq!(result.unwrap(), "ok");
    assert_eq!(seen, vec!["old-access".to_string(), "new-access".to_string()]);
    assert!(path.is_file());
}

#[test]
fn second_unauthorized_clears() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let path = auth_dir("community-auth-second-401").join("auth.json");
    write_pairing(&path, "old-access", "refresh-keep");
    let mut calls = 0;
    let result: Result<(), AuthRetryError> = with_access_token_retry(
        &path,
        |_| {
            calls += 1;
            AuthAttempt::Unauthorized
        },
        |tokens| Ok(rotated(&path, tokens)),
    );
    assert!(matches!(result, Err(AuthRetryError::NeedsAccount)), "{result:?}");
    assert_eq!(calls, 2);
    assert!(!path.exists(), "second 401 must clear the pairing");
}

#[test]
fn invalid_refresh_clears_without_retry() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let path = auth_dir("community-auth-invalid-refresh").join("auth.json");
    write_pairing(&path, "old-access", "refresh-dead");
    let mut calls = 0;
    let result: Result<(), AuthRetryError> = with_access_token_retry(
        &path,
        |_| {
            calls += 1;
            AuthAttempt::Unauthorized
        },
        |_| Err(AccountAuthError::InvalidRefreshToken("dead".into())),
    );
    assert!(matches!(result, Err(AuthRetryError::NeedsAccount)), "{result:?}");
    assert_eq!(calls, 1, "invalid refresh must not retry the call");
    assert!(!path.exists(), "invalid refresh must clear the pairing");
}

#[test]
fn refresh_is_handed_the_originating_credential_not_a_replacement() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let path = auth_dir("community-auth-replaced-mid-flight").join("auth.json");
    write_pairing(&path, "old-access", "refresh-keep");
    let mut calls = 0;
    let result: Result<(), AuthRetryError> = with_access_token_retry(
        &path,
        |_| {
            calls += 1;
            if calls == 1 {
                // A different sign-in replaces the shared credential while the first
                // request is still pending.
                write_pairing(&path, "b-access", "b-refresh");
            }
            if calls == 1 {
                AuthAttempt::Unauthorized
            } else {
                AuthAttempt::Response(())
            }
        },
        |tokens| Ok(rotated(&path, tokens)),
    );
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(calls, 2);
    assert_eq!(
        session_of(&path),
        "session-refresh-keep",
        "the refresh must be built from the credential the call started with, not the one that replaced it"
    );
}

#[test]
fn replaced_pairing_is_neither_used_nor_cleared() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let path = auth_dir("community-auth-replaced-refused").join("auth.json");
    write_pairing(&path, "old-access", "refresh-keep");
    let mut calls = 0;
    let result: Result<(), AuthRetryError> = with_access_token_retry(
        &path,
        |_| {
            calls += 1;
            if calls == 1 {
                write_pairing(&path, "b-access", "b-refresh");
            }
            AuthAttempt::Unauthorized
        },
        |_| Err(AccountAuthError::Replaced("the pairing changed while this request was in flight".into())),
    );
    assert!(matches!(result, Err(AuthRetryError::NeedsAccount)), "{result:?}");
    assert_eq!(calls, 1, "a replaced pairing must not be retried as the replacement");
    assert_eq!(session_of(&path), "session-b-refresh", "the replacement pairing must survive");
}

#[test]
fn late_unauthorized_does_not_clear_a_newer_generation() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let path = auth_dir("community-auth-late-401").join("auth.json");
    write_pairing(&path, "old-access", "refresh-keep");
    let mut calls = 0;
    let result: Result<(), AuthRetryError> = with_access_token_retry(
        &path,
        |_| {
            calls += 1;
            if calls == 2 {
                // Another operation rotates the same session to a newer generation
                // before this retry's late 401 lands.
                write_rotated_pairing(&path, "session-refresh-keep", "newer-access", "refresh-newer");
            }
            AuthAttempt::Unauthorized
        },
        |tokens| Ok(rotated(&path, tokens)),
    );
    assert!(matches!(result, Err(AuthRetryError::NeedsAccount)), "{result:?}");
    assert_eq!(calls, 2);
    let stored: serde_json::Value = serde_json::from_slice(&fs::read(&path).expect("the newer generation must survive")).unwrap();
    assert_eq!(stored["refresh_token"], "refresh-newer");
}

#[test]
fn transient_refresh_keeps_pairing() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let path = auth_dir("community-auth-transient").join("auth.json");
    write_pairing(&path, "old-access", "refresh-keep");
    let mut calls = 0;
    let result: Result<(), AuthRetryError> = with_access_token_retry(
        &path,
        |_| {
            calls += 1;
            AuthAttempt::Unauthorized
        },
        |_| Err(AccountAuthError::Transient("network".into())),
    );
    assert!(matches!(result, Err(AuthRetryError::Transport(_))), "{result:?}");
    assert_eq!(calls, 1, "transient refresh must not retry the call");
    assert!(path.is_file(), "transient refresh must keep the pairing");
}

struct Recorder {
    requests: Vec<CommunityHttpRequest>,
    script: Vec<Result<CommunityHttpResponse, String>>,
}

impl CommunityHttp for Recorder {
    fn exchange(&mut self, request: CommunityHttpRequest) -> Result<CommunityHttpResponse, String> {
        self.requests.push(request);
        self.script.remove(0)
    }
}

fn recorder(script: Vec<Result<CommunityHttpResponse, String>>) -> Recorder {
    Recorder { requests: Vec::new(), script }
}

fn json_response(status: u16, body: &str) -> Result<CommunityHttpResponse, String> {
    Ok(CommunityHttpResponse {
        status,
        body: body.as_bytes().to_vec(),
    })
}

fn summary_json(id: &str, label: &str, key: &str, version: u64) -> String {
    format!(
        r#"{{"id":"{id}","label":"{label}","playbook_key":"{key}","title":"Review","description":"Review a change.","default_harness":"vinculum","has_coding_step":false,"step_count":4,"version":{version},"body_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","published_at":"2026-09-22T18:04:11Z","updated_at":"2026-09-22T19:10:00Z"}}"#
    )
}

const SAMPLE_ID: &str = "8c19b367-d20b-4e60-b2ec-df73d8123aa1";
const OTHER_ID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

fn no_authorization(headers: &[String]) -> bool {
    !headers.iter().any(|header| header.to_ascii_lowercase().starts_with("authorization:"))
}

#[test]
fn blank_q_is_omitted() {
    let mut http = recorder(vec![json_response(200, r#"{"ok":true,"playbooks":[],"next_cursor":null}"#)]);
    list_community_playbooks_with(&mut http, "http://library.test", Some("   "), None).unwrap();
    assert_eq!(http.requests.len(), 1);
    assert_eq!(http.requests[0].url, "http://library.test/api/desktop/playbooks");
    assert!(no_authorization(&http.requests[0].headers));
    assert!(!http.requests[0].url.contains('q'));
}

#[test]
fn trimmed_q_is_encoded() {
    let mut http = recorder(vec![json_response(200, r#"{"ok":true,"playbooks":[],"next_cursor":null}"#)]);
    list_community_playbooks_with(&mut http, "http://library.test", Some(" q "), None).unwrap();
    assert_eq!(http.requests[0].url, "http://library.test/api/desktop/playbooks?q=q");
    assert!(no_authorization(&http.requests[0].headers));
}

#[test]
fn q_over_80_does_not_call() {
    let mut http = recorder(Vec::new());
    let q = "a".repeat(81);
    let error = list_community_playbooks_with(&mut http, "http://library.test", Some(&q), None).unwrap_err();
    assert!(http.requests.is_empty());
    assert_eq!(error, "Invalid query.");
}

#[test]
fn cursor_is_opaque() {
    let cursor = "2026-09-22T19:10:00Z,8c19b367-d20b-4e60-b2ec-df73d8123aa1";
    let mut http = recorder(vec![json_response(200, r#"{"ok":true,"playbooks":[],"next_cursor":null}"#)]);
    list_community_playbooks_with(&mut http, "http://library.test", None, Some(cursor)).unwrap();
    let url = &http.requests[0].url;
    assert!(url.contains(&format!("cursor={}", percent_encode(cursor))), "{url}");
    assert!(url.contains("%2C"), "{url}");
    for forbidden in ["sort=", "harness=", "coding=", "limit="] {
        assert!(!url.contains(forbidden), "{url}");
    }
    assert!(no_authorization(&http.requests[0].headers));
}

#[test]
fn empty_page_is_success() {
    let mut http = recorder(vec![json_response(200, r#"{"ok":true,"playbooks":[],"next_cursor":null}"#)]);
    let page = list_community_playbooks_with(&mut http, "http://library.test", None, None).unwrap();
    assert!(page.playbooks.is_empty());
    assert_eq!(page.next_cursor, None);
}

#[test]
fn duplicate_keys_both_remain() {
    let body = format!(
        r#"{{"ok":true,"playbooks":[{},{}],"next_cursor":null}}"#,
        summary_json(SAMPLE_ID, "nyx", "review", 3),
        summary_json(OTHER_ID, "ada", "review", 1)
    );
    let mut http = recorder(vec![json_response(200, &body)]);
    let page = list_community_playbooks_with(&mut http, "http://library.test", None, None).unwrap();
    assert_eq!(page.playbooks.len(), 2);
    assert_eq!(page.playbooks[0].playbook_key, "review");
    assert_eq!(page.playbooks[1].playbook_key, "review");
    assert_ne!(page.playbooks[0].id, page.playbooks[1].id);
}

#[test]
fn service_role_key_is_replaced() {
    let body = r#"{"ok":false,"error":"Playbook library is unavailable. SUPABASE_SERVICE_ROLE_KEY is not configured on the server.","code":"unavailable"}"#;
    let mut http = recorder(vec![json_response(503, body)]);
    let error = list_community_playbooks_with(&mut http, "http://library.test", None, None).unwrap_err();
    assert_eq!(error, "Playbook library is unavailable.");
    assert!(!error.contains("SUPABASE_SERVICE_ROLE_KEY"));
}

#[test]
fn browse_401_is_reachability() {
    let body = r#"{"ok":false,"error":"Sign in to continue.","code":"unauthenticated"}"#;
    let mut http = recorder(vec![json_response(401, body)]);
    let error = list_community_playbooks_with(&mut http, "http://library.test", None, None).unwrap_err();
    assert_eq!(error, "Could not reach the playbook library.");
    assert!(!error.contains("Sign in"));
}

fn detail_ok(summary: &str) -> String {
    format!(r#"{{"ok":true,{}"#, summary.trim_start_matches('{'))
}

const IMPORT_ID: &str = "8c19b367-d20b-4e60-b2ec-df73d8123aa1";

fn desktop_fixture() -> String {
    "+++\nversion = 2\nkey = \"test\"\ntitle = \"Test\"\ndescription = \"\"\ndefault_model = \"\"\ndefault_harness = \"\"\n[[step]]\nkey = \"run\"\ntitle = \"Run\"\nshort = \"\"\nis_coding_step = false\nauto_advance_default = false\ninputs = [{path = \"ticket.md\", mode = \"single\"}]\noutputs = [{path = \"result.md\"}]\nmodel = \"\"\nharness = \"\"\n+++\nPreamble\n<!-- alinery:step run -->\nRead {{TICKET_FILE}}.\n".into()
}

fn source_body(id: &str, version: u64, body: &str, playbook_key: &str) -> String {
    serde_json::json!({
        "ok": true,
        "id": id,
        "label": "nyx",
        "playbook_key": playbook_key,
        "title": "Test",
        "description": "",
        "default_harness": "",
        "has_coding_step": false,
        "step_count": 1,
        "version": version,
        "body_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "published_at": "2026-09-22T18:04:11Z",
        "updated_at": "2026-09-22T19:10:00Z",
        "body": body,
        "attested_at": "2026-09-22T19:10:00Z"
    })
    .to_string()
}

/// The seam for tests that only need the retry to carry on: no persistence, because
/// nothing in those flows inspects the generation it produced.
fn keep_refresh(tokens: &AccountTokens) -> Result<AccountTokens, AccountAuthError> {
    Ok(rotated_tokens_for_test(tokens, "new-access", "rotated-refresh"))
}

#[test]
fn preview_needs_account() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let auth = auth_dir("community-preview-signed-out").join("missing-auth.json");
    let mut http = recorder(Vec::new());
    let result = preview_community_playbook_with(&mut http, "http://library.test", &auth, keep_refresh, IMPORT_ID);
    assert_eq!(result, PreviewResult::NeedsAccount);
    assert!(http.requests.is_empty());
}

#[test]
fn preview_malformed_id_does_not_call() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let path = auth_dir("community-preview-id").join("auth.json");
    write_pairing(&path, "access", "refresh-keep");
    let mut http = recorder(Vec::new());
    let result = preview_community_playbook_with(&mut http, "http://library.test", &path, keep_refresh, "NOT-A-UUID");
    assert_eq!(
        result,
        PreviewResult::Failed {
            message: "Playbook not found.".into()
        }
    );
    assert!(http.requests.is_empty());
}

#[test]
fn preview_returns_the_document_and_writes_nothing() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let repo = auth_dir("community-preview-ok");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    let document = desktop_fixture();
    let mut http = recorder(vec![json_response(200, &source_body(IMPORT_ID, 3, &document, "test"))]);
    let result = preview_community_playbook_with(&mut http, "http://library.test", &auth, keep_refresh, IMPORT_ID);
    assert_eq!(result, PreviewResult::Loaded { source: document });
    assert_eq!(http.requests.len(), 1);
    assert_eq!(http.requests[0].method, "GET");
    assert!(http.requests[0].url.ends_with(&format!("/api/desktop/playbooks/{IMPORT_ID}/source")));
    assert!(!repo.join(".alinery").exists());
}

#[test]
fn preview_404_and_503_are_messages() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let path = auth_dir("community-preview-status").join("auth.json");
    write_pairing(&path, "access", "refresh-keep");
    let mut http = recorder(vec![json_response(404, r#"{"ok":false,"error":"Playbook not found.","code":"not_found"}"#)]);
    assert_eq!(
        preview_community_playbook_with(&mut http, "http://library.test", &path, keep_refresh, IMPORT_ID),
        PreviewResult::Failed {
            message: "Playbook not found.".into()
        }
    );
    let mut http = recorder(vec![json_response(
        503,
        r#"{"ok":false,"error":"SUPABASE_SERVICE_ROLE_KEY is not configured on the server.","code":"unavailable"}"#,
    )]);
    let result = preview_community_playbook_with(&mut http, "http://library.test", &path, keep_refresh, IMPORT_ID);
    let PreviewResult::Failed { message } = result else {
        panic!("{result:?}");
    };
    assert!(!message.contains("SUPABASE_SERVICE_ROLE_KEY"));
    assert_eq!(message, "Playbook library is unavailable.");
}

#[test]
fn mine_needs_account_does_not_call() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let auth = auth_dir("community-mine-signed-out").join("missing-auth.json");
    let mut http = recorder(Vec::new());
    let result = list_my_community_playbooks_with(&mut http, "http://library.test", &auth, keep_refresh);
    assert_eq!(result, MineResult::NeedsAccount);
    assert!(http.requests.is_empty());
}

#[test]
fn mine_lists_the_callers_playbooks() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let path = auth_dir("community-mine-ok").join("auth.json");
    write_pairing(&path, "access", "refresh-keep");
    let body = format!(r#"{{"ok":true,"playbooks":[{}],"truncated":false}}"#, summary_json(IMPORT_ID, "nyx", "review", 3));
    let mut http = recorder(vec![json_response(200, &body)]);
    let result = list_my_community_playbooks_with(&mut http, "http://library.test", &path, keep_refresh);
    let MineResult::Loaded { playbooks, truncated } = result else {
        panic!("{result:?}");
    };
    assert!(!truncated);
    assert_eq!(playbooks.len(), 1);
    assert_eq!(playbooks[0].label, "nyx");
    assert_eq!(playbooks[0].playbook_key, "review");
    assert_eq!(playbooks[0].version, 3);
    assert_eq!(http.requests.len(), 1);
    assert_eq!(http.requests[0].method, "GET");
    assert!(http.requests[0].url.ends_with("/api/desktop/playbooks/mine"));
    assert!(http.requests[0].body.is_none());
    assert_eq!(bearer(&http.requests[0].headers), "access");
}

#[test]
fn mine_keeps_the_truncated_flag() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let path = auth_dir("community-mine-truncated").join("auth.json");
    write_pairing(&path, "access", "refresh-keep");
    let mut http = recorder(vec![json_response(200, r#"{"ok":true,"playbooks":[],"truncated":true}"#)]);
    assert_eq!(
        list_my_community_playbooks_with(&mut http, "http://library.test", &path, keep_refresh),
        MineResult::Loaded {
            playbooks: Vec::new(),
            truncated: true
        }
    );
}

#[test]
fn mine_503_scrubs_the_service_role() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let path = auth_dir("community-mine-503").join("auth.json");
    write_pairing(&path, "access", "refresh-keep");
    let mut http = recorder(vec![json_response(
        503,
        r#"{"ok":false,"error":"SUPABASE_SERVICE_ROLE_KEY is not configured on the server.","code":"unavailable"}"#,
    )]);
    let result = list_my_community_playbooks_with(&mut http, "http://library.test", &path, keep_refresh);
    let MineResult::Failed { message } = result else {
        panic!("{result:?}");
    };
    assert_eq!(message, "Playbook library is unavailable.");
    assert!(!message.contains("SUPABASE_SERVICE_ROLE_KEY"));
}

#[test]
fn preview_401_refreshes_once() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let path = auth_dir("community-preview-401").join("auth.json");
    write_pairing(&path, "old-access", "refresh-keep");
    let document = desktop_fixture();
    let mut http = recorder(vec![
        json_response(401, r#"{"ok":false,"error":"Sign in to continue.","code":"unauthenticated"}"#),
        json_response(200, &source_body(IMPORT_ID, 1, &document, "test")),
    ]);
    let result = preview_community_playbook_with(&mut http, "http://library.test", &path, keep_refresh, IMPORT_ID);
    assert_eq!(result, PreviewResult::Loaded { source: document });
    assert_eq!(http.requests.len(), 2);
    assert!(http.requests[0].headers.iter().any(|header| header.contains("old-access")));
    assert!(http.requests[1].headers.iter().any(|header| header.contains("new-access")));
}

fn bearer(headers: &[String]) -> String {
    headers.iter().find_map(|header| header.strip_prefix("Authorization: Bearer ")).unwrap_or("").to_string()
}

fn json_body(request: &CommunityHttpRequest) -> serde_json::Value {
    serde_json::from_str(request.body.as_deref().unwrap_or("{}")).unwrap()
}

fn validate_ok(key_taken: bool, existing_id: Option<&str>) -> String {
    serde_json::json!({
        "ok": true,
        "valid": true,
        "key_taken": key_taken,
        "existing_id": existing_id,
        "summary": { "key": "test", "title": "Test", "description": "", "default_harness": "", "step_count": 1, "has_coding_step": false }
    })
    .to_string()
}

fn detail_saved(id: &str, version: u64) -> String {
    serde_json::json!({
        "ok": true,
        "id": id,
        "label": "nyx",
        "playbook_key": "test",
        "title": "Test",
        "description": "",
        "default_harness": "",
        "has_coding_step": false,
        "step_count": 1,
        "version": version,
        "body_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "published_at": "2026-09-22T18:04:11Z",
        "updated_at": "2026-09-22T19:10:00Z",
        "body": "stored",
        "attested_at": "2026-09-22T19:10:00Z"
    })
    .to_string()
}

fn error_json(status_code: &str, error: &str) -> String {
    serde_json::json!({"ok": false, "error": error, "code": status_code}).to_string()
}

fn publish(http: &mut Recorder, auth: &Path, source: &str, key: &str, label: Option<&str>) -> PublishResult {
    publish_community_playbook_with(http, "http://library.test", auth, keep_refresh, source, key, label)
}

#[test]
fn publish_sends_stored_text() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let repo = auth_dir("community-publish-stored");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    let stored = desktop_fixture().replace('\n', "\r\n");
    let source = stored.to_string();
    let mut http = recorder(vec![json_response(200, &validate_ok(false, None)), json_response(201, &detail_saved(IMPORT_ID, 1))]);
    let result = publish(&mut http, &auth, &source, "test", None);
    assert!(matches!(result, PublishResult::Saved { version: 1, .. }), "{result:?}");
    for request in &http.requests {
        if request.body.is_none() {
            continue;
        }
        let payload = json_body(request);
        let source = payload["source"].as_str().unwrap();
        assert!(source.contains('\r'), "stored CRLF must be the publish body");
        assert!(payload.get("title").is_none());
        assert!(payload.get("key").is_none());
        assert!(payload.get("version").is_none());
        assert!(payload.get("step_count").is_none());
    }
}

#[test]
fn publish_key_taken_puts() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let repo = auth_dir("community-publish-put");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    let source = desktop_fixture().to_string();
    let mut http = recorder(vec![
        json_response(200, &validate_ok(true, Some(IMPORT_ID))),
        json_response(200, &detail_saved(IMPORT_ID, 4)),
    ]);
    let result = publish(&mut http, &auth, &source, "test", Some("nyx"));
    assert!(matches!(result, PublishResult::Saved { .. }), "{result:?}");
    assert!(http.requests.iter().any(|request| request.method == "PUT" && request.url.ends_with(IMPORT_ID)));
    assert!(!http
        .requests
        .iter()
        .any(|request| request.method == "POST" && request.url.ends_with("/api/desktop/playbooks")));
    let put = http.requests.iter().find(|request| request.method == "PUT").unwrap();
    assert!(json_body(put).get("label").is_none());
}

#[test]
fn publish_create_201() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let repo = auth_dir("community-publish-create");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    let source = desktop_fixture().to_string();
    let mut http = recorder(vec![json_response(200, &validate_ok(false, None)), json_response(201, &detail_saved(IMPORT_ID, 1))]);
    let result = publish(&mut http, &auth, &source, "test", None);
    match result {
        PublishResult::Saved { id, version, .. } => {
            assert_eq!(id, IMPORT_ID);
            assert_eq!(version, 1);
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn publish_label_required_does_not_retry_inside_the_command() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let repo = auth_dir("community-publish-label");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    let source = desktop_fixture().to_string();
    let mut http = recorder(vec![
        json_response(200, &validate_ok(false, None)),
        json_response(400, &error_json("label_required", "Choose a public label.")),
    ]);
    let result = publish(&mut http, &auth, &source, "test", None);
    assert_eq!(result, PublishResult::LabelRequired);
    assert_eq!(
        http.requests
            .iter()
            .filter(|request| request.method == "POST" && request.url.ends_with("/api/desktop/playbooks"))
            .count(),
        1
    );
    let mut http = recorder(vec![json_response(200, &validate_ok(false, None)), json_response(201, &detail_saved(IMPORT_ID, 1))]);
    let result = publish(&mut http, &auth, &source, "test", Some("nyx"));
    assert!(matches!(result, PublishResult::Saved { .. }), "{result:?}");
    let create = http
        .requests
        .iter()
        .find(|request| request.method == "POST" && request.url.ends_with("/api/desktop/playbooks"))
        .unwrap();
    assert_eq!(json_body(create)["label"], "nyx");
}

#[test]
fn publish_create_conflict_puts_mine_row() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let repo = auth_dir("community-publish-conflict");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    let source = desktop_fixture().to_string();
    let mine = serde_json::json!({"ok": true, "truncated": false, "playbooks": [serde_json::from_str::<serde_json::Value>(&summary_json(IMPORT_ID, "nyx", "test", 2)).unwrap()]})
        .to_string();
    let mut http = recorder(vec![
        json_response(200, &validate_ok(false, None)),
        json_response(409, &error_json("conflict", "You already published this playbook. Update it.")),
        json_response(200, &mine),
        json_response(200, &detail_saved(IMPORT_ID, 3)),
    ]);
    let result = publish(&mut http, &auth, &source, "test", None);
    assert!(matches!(result, PublishResult::Saved { .. }), "{result:?}");
    assert_eq!(http.requests.iter().filter(|request| request.method == "PUT").count(), 1);
    assert_eq!(
        http.requests
            .iter()
            .filter(|request| request.method == "POST" && request.url.ends_with("/api/desktop/playbooks"))
            .count(),
        1
    );
}

#[test]
fn publish_truncated_mine_does_not_post_again() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let repo = auth_dir("community-publish-truncated");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    let source = desktop_fixture().to_string();
    let mine = r#"{"ok":true,"truncated":true,"playbooks":[]}"#;
    let mut http = recorder(vec![
        json_response(200, &validate_ok(false, None)),
        json_response(409, &error_json("conflict", "You already published this playbook. Update it.")),
        json_response(200, mine),
    ]);
    let result = publish(&mut http, &auth, &source, "test", None);
    match result {
        PublishResult::Failed { message, .. } => assert_eq!(message, "You already published this playbook, but it is not in the newest 1000. It was not updated."),
        other => panic!("{other:?}"),
    }
    assert_eq!(
        http.requests
            .iter()
            .filter(|request| request.method == "POST" && request.url.ends_with("/api/desktop/playbooks"))
            .count(),
        1
    );
}

#[test]
fn publish_concurrent_put_retries_twice() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let repo = auth_dir("community-publish-concurrent");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    let source = desktop_fixture().to_string();
    let conflict = error_json("conflict", "Playbook was updated concurrently. Try again.");
    let mut http = recorder(vec![
        json_response(200, &validate_ok(true, Some(IMPORT_ID))),
        json_response(409, &conflict),
        json_response(409, &conflict),
        json_response(409, &conflict),
    ]);
    let result = publish(&mut http, &auth, &source, "test", None);
    match result {
        PublishResult::Failed { message, .. } => assert_eq!(message, "Playbook was updated concurrently. Try again."),
        other => panic!("{other:?}"),
    }
    let puts: Vec<_> = http.requests.iter().filter(|request| request.method == "PUT").collect();
    assert_eq!(puts.len(), 3);
    assert_eq!(puts[0].body, puts[1].body);
    assert_eq!(puts[1].body, puts[2].body);
}

#[test]
fn publish_key_changed_does_not_retry() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let repo = auth_dir("community-publish-key-changed");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    let source = desktop_fixture().to_string();
    let mut http = recorder(vec![
        json_response(200, &validate_ok(true, Some(IMPORT_ID))),
        json_response(422, &error_json("key_changed", "The playbook key cannot change. Publish a new one.")),
    ]);
    let result = publish(&mut http, &auth, &source, "test", None);
    match result {
        PublishResult::Failed { message, .. } => assert_eq!(message, "The playbook key cannot change. Publish a new one."),
        other => panic!("{other:?}"),
    }
    assert_eq!(http.requests.iter().filter(|request| request.method == "PUT").count(), 1);
}

#[test]
fn publish_503_is_replaced() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let repo = auth_dir("community-publish-503");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    let source = desktop_fixture().to_string();
    let body = r#"{"ok":false,"error":"Playbook library is unavailable. SUPABASE_SERVICE_ROLE_KEY is not configured on the server.","code":"unavailable"}"#;
    let mut http = recorder(vec![json_response(503, body)]);
    let result = publish(&mut http, &auth, &source, "test", None);
    match result {
        PublishResult::Failed { message, .. } => {
            assert_eq!(message, "Playbook library is unavailable.");
            assert!(!message.contains("SUPABASE_SERVICE_ROLE_KEY"));
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn publish_needs_account() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let repo = auth_dir("community-publish-signed-out");
    let auth = repo.join("missing-auth.json");
    let source = desktop_fixture().to_string();
    let mut http = recorder(Vec::new());
    let result = publish(&mut http, &auth, &source, "test", None);
    assert_eq!(result, PublishResult::NeedsAccount);
    assert!(http.requests.is_empty());
}

#[test]
fn publish_401_refreshes_once() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let repo = auth_dir("community-publish-401");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "old-access", "refresh-keep");
    let source = desktop_fixture().to_string();
    let mut refreshes = 0;
    let mut http = recorder(vec![
        json_response(401, &error_json("unauthenticated", "Sign in to continue.")),
        json_response(200, &validate_ok(false, None)),
        json_response(201, &detail_saved(IMPORT_ID, 1)),
    ]);
    let result = publish_community_playbook_with(
        &mut http,
        "http://library.test",
        &auth,
        |tokens| {
            refreshes += 1;
            Ok(rotated(&auth, tokens))
        },
        &source,
        "test",
        None,
    );
    assert!(matches!(result, PublishResult::Saved { .. }), "{result:?}");
    assert_eq!(refreshes, 1);
    assert_eq!(bearer(&http.requests[0].headers), "old-access");
    assert!(http.requests.iter().skip(1).all(|request| bearer(&request.headers) == "new-access"));
    assert!(auth.is_file());
}

#[test]
fn publish_second_401_clears() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let repo = auth_dir("community-publish-second-401");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "old-access", "refresh-keep");
    let source = desktop_fixture().to_string();
    let mut http = recorder(vec![
        json_response(401, &error_json("unauthenticated", "Sign in to continue.")),
        json_response(401, &error_json("unauthenticated", "Sign in to continue.")),
    ]);
    let result = publish_community_playbook_with(&mut http, "http://library.test", &auth, |tokens| Ok(rotated(&auth, tokens)), &source, "test", None);
    assert_eq!(result, PublishResult::NeedsAccount);
    assert!(!auth.exists());
}

fn status_ids() -> [&'static str; 4] {
    [
        "11111111-1111-4111-8111-111111111111",
        "33333333-3333-4333-8333-333333333333",
        "44444444-4444-4444-8444-444444444444",
        "55555555-5555-4555-8555-555555555555",
    ]
}

#[test]
fn remote_status_reports_each_publication() {
    let [found, missing, broken, unreachable] = status_ids();
    let mut http = recorder(vec![
        json_response(200, &detail_ok(&summary_json(found, "nyx", "review", 4))),
        json_response(404, r#"{"ok":false,"error":"Playbook not found.","code":"not_found"}"#),
        json_response(500, r#"{"ok":false,"error":"nope","code":"nope"}"#),
        json_response(401, r#"{"ok":false,"error":"Sign in to continue.","code":"unauthenticated"}"#),
    ]);
    let ids: Vec<String> = status_ids().iter().map(|id| (*id).to_string()).collect();
    let rows = community_remote_status_with(&mut http, "http://library.test", &ids);
    let row = |id: &str| rows.iter().find(|row| row.id == id).unwrap_or_else(|| panic!("missing {id}"));
    assert_eq!(rows.len(), 4);
    assert_eq!(row(found).remote_version, Some(4));
    assert_eq!(row(found).title.as_deref(), Some("Review"));
    assert!(row(found).error.is_none() && !row(found).remote_missing);
    assert!(row(missing).remote_missing && row(missing).error.is_none());
    assert!(row(broken).error.is_some());
    assert_eq!(row(unreachable).error.as_deref(), Some("Could not reach the playbook library."));
    assert!(http.requests.iter().all(|request| !request.url.contains("/source") && no_authorization(&request.headers)));
}

#[test]
fn remote_status_with_a_malformed_id_does_not_call() {
    let mut http = recorder(Vec::new());
    let rows = community_remote_status_with(&mut http, "http://library.test", &["NOT-A-UUID".to_string()]);
    assert_eq!(rows[0].error.as_deref(), Some("Playbook not found."));
    assert!(http.requests.is_empty());
}

#[test]
fn download_source_needs_account() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let auth = auth_dir("community-source-signed-out").join("missing-auth.json");
    let mut http = recorder(Vec::new());
    assert_eq!(
        download_community_source_with(&mut http, "http://library.test", &auth, keep_refresh, IMPORT_ID),
        SourceResult::NeedsAccount
    );
    assert!(http.requests.is_empty());
}

#[test]
fn download_source_with_a_malformed_id_does_not_call() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let path = auth_dir("community-source-id").join("auth.json");
    write_pairing(&path, "access", "refresh-keep");
    let mut http = recorder(Vec::new());
    let result = download_community_source_with(&mut http, "http://library.test", &path, keep_refresh, "8C19B367-D20B-4E60-B2EC-DF73D8123AA1");
    assert_eq!(
        result,
        SourceResult::Failed {
            message: "Playbook not found.".into()
        }
    );
    assert!(http.requests.is_empty());
}

#[test]
fn download_source_returns_the_package_and_writes_nothing() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let repo = auth_dir("community-source-ok");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    let document = desktop_fixture();
    let mut http = recorder(vec![json_response(200, &source_body(IMPORT_ID, 3, &document, "test"))]);
    let result = download_community_source_with(&mut http, "http://library.test", &auth, keep_refresh, IMPORT_ID);
    assert_eq!(
        result,
        SourceResult::Downloaded {
            document,
            version: 3,
            label: "nyx".into(),
            playbook_key: "test".into()
        }
    );
    assert_eq!(http.requests.len(), 1);
    assert!(http.requests[0].url.ends_with(&format!("/api/desktop/playbooks/{IMPORT_ID}/source")));
    assert!(!repo.join(".alinery").exists());
}

#[test]
fn download_source_404_and_503_are_messages() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let path = auth_dir("community-source-status").join("auth.json");
    write_pairing(&path, "access", "refresh-keep");
    let mut http = recorder(vec![json_response(404, r#"{"ok":false,"error":"Playbook not found.","code":"not_found"}"#)]);
    assert_eq!(
        download_community_source_with(&mut http, "http://library.test", &path, keep_refresh, IMPORT_ID),
        SourceResult::Failed {
            message: "Playbook not found.".into()
        }
    );
    let mut http = recorder(vec![json_response(
        503,
        r#"{"ok":false,"error":"SUPABASE_SERVICE_ROLE_KEY is not configured on the server.","code":"unavailable"}"#,
    )]);
    let SourceResult::Failed { message } = download_community_source_with(&mut http, "http://library.test", &path, keep_refresh, IMPORT_ID) else {
        panic!("not a failure");
    };
    assert_eq!(message, "Playbook library is unavailable.");
}

#[test]
fn unpublish_deletes_the_listing_with_the_bearer() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let path = auth_dir("community-unpublish-ok").join("auth.json");
    write_pairing(&path, "access", "refresh-keep");
    let mut http = recorder(vec![json_response(200, r#"{"ok":true,"deleted":true}"#)]);
    assert_eq!(
        unpublish_community_playbook_with(&mut http, "http://library.test", &path, keep_refresh, IMPORT_ID),
        UnpublishResult::Removed
    );
    assert_eq!(http.requests[0].method, "DELETE");
    assert_eq!(http.requests[0].url, format!("http://library.test/api/desktop/playbooks/{IMPORT_ID}"));
    assert!(http.requests[0].body.is_none());
    assert_eq!(bearer(&http.requests[0].headers), "access");
}

#[test]
fn unpublish_reads_a_missing_listing_as_removed_and_another_owner_as_refused() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let path = auth_dir("community-unpublish-refused").join("auth.json");
    write_pairing(&path, "access", "refresh-keep");
    let mut http = recorder(vec![
        json_response(404, r#"{"ok":false,"error":"Playbook not found.","code":"not_found"}"#),
        json_response(403, r#"{"ok":false,"error":"You cannot remove this playbook.","code":"forbidden"}"#),
    ]);
    assert_eq!(
        unpublish_community_playbook_with(&mut http, "http://library.test", &path, keep_refresh, IMPORT_ID),
        UnpublishResult::Removed
    );
    assert_eq!(
        unpublish_community_playbook_with(&mut http, "http://library.test", &path, keep_refresh, IMPORT_ID),
        UnpublishResult::Failed {
            message: "You cannot remove this playbook.".into()
        }
    );
}

#[test]
fn unpublish_signed_out_or_with_a_bad_id_sends_nothing() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let missing = auth_dir("community-unpublish-signed-out").join("missing-auth.json");
    let mut http = recorder(Vec::new());
    assert_eq!(
        unpublish_community_playbook_with(&mut http, "http://library.test", &missing, keep_refresh, IMPORT_ID),
        UnpublishResult::NeedsAccount
    );
    assert!(matches!(
        unpublish_community_playbook_with(&mut http, "http://library.test", &missing, keep_refresh, "../x"),
        UnpublishResult::Failed { .. }
    ));
    assert!(http.requests.is_empty());
}
