//! Community playbook library and the auth retry it uses.
//!
//! HTTP is injected. These tests must not open a socket to accounts.alinery.ai
//! or to the production Supabase host.
use super::*;
use crate::{
    community_download_status_with, delete_playbook_keeping_imports, import_community_playbook_with, list_community_playbooks_with, preview_community_playbook_with,
    publish_community_playbook_with, read_community_imports, registry_path, update_community_import_with, write_community_imports, CommunityHttp, CommunityHttpRequest,
    CommunityHttpResponse, CommunityImportRecord, ImportResult, PreviewResult, PublishResult, UpdateResult,
};
use crate::{rotated_tokens_for_test, save_tokens_for_test, AccountTokens};
use alinery_core::playbook::{PlaybookRef, PlaybookScope};
use alinery_core::playbook_library::{PlaybookRoots, PlaybookSaveError};

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
        r#"{{"id":"{id}","label":"{label}","playbook_key":"{key}","title":"Review","description":"Review a change.","default_harness":"omp","has_coding_step":false,"step_count":4,"version":{version},"body_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","published_at":"2026-09-22T18:04:11Z","updated_at":"2026-09-22T19:10:00Z"}}"#
    )
}

fn no_authorization(headers: &[String]) -> bool {
    !headers.iter().any(|header| header.to_ascii_lowercase().starts_with("authorization:"))
}

const SAMPLE_ID: &str = "8c19b367-d20b-4e60-b2ec-df73d8123aa1";
const OTHER_ID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

fn sample_record() -> CommunityImportRecord {
    CommunityImportRecord {
        id: SAMPLE_ID.into(),
        label: "nyx".into(),
        playbook_key: "review".into(),
        local_scope: "repo".into(),
        local_key: "review".into(),
        imported_version: 3,
        local_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
        imported_at: "2026-09-22T18:04:11Z".into(),
    }
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

#[test]
fn registry_round_trip() {
    let repo = auth_dir("community-registry");
    let missing = read_community_imports(&repo).unwrap();
    assert!(missing.is_empty());
    let sample = sample_record();
    write_community_imports(&repo, std::slice::from_ref(&sample)).unwrap();
    let read = read_community_imports(&repo).unwrap();
    assert_eq!(read, vec![sample]);
    let path = registry_path(&repo);
    let before = fs::read(&path).unwrap();
    fs::write(&path, "not = [valid").unwrap();
    assert!(read_community_imports(&repo).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"not = [valid");
    let _ = before;
}

fn detail_ok(summary: &str) -> String {
    format!(r#"{{"ok":true,{}"#, summary.trim_start_matches('{'))
}

#[test]
fn download_status_versions() {
    let repo = auth_dir("community-status");
    let higher = "11111111-1111-4111-8111-111111111111";
    let equal = "22222222-2222-4222-8222-222222222222";
    let lower = "33333333-3333-4333-8333-333333333333";
    let missing = "44444444-4444-4444-8444-444444444444";
    let broken = "55555555-5555-4555-8555-555555555555";
    let sibling = "66666666-6666-4666-8666-666666666666";
    let specs = [(higher, 3u64), (equal, 3), (lower, 3), (missing, 3), (broken, 3), (sibling, 1)];
    let records: Vec<_> = specs
        .iter()
        .map(|(id, version)| {
            let mut record = sample_record();
            record.id = (*id).into();
            record.local_key = (*id).into();
            record.imported_version = *version;
            record
        })
        .collect();
    write_community_imports(&repo, &records).unwrap();
    let mut http = recorder(vec![
        json_response(200, &detail_ok(&summary_json(higher, "nyx", "review", 4))),
        json_response(200, &detail_ok(&summary_json(equal, "nyx", "review", 3))),
        json_response(200, &detail_ok(&summary_json(lower, "nyx", "review", 2))),
        json_response(404, r#"{"ok":false,"error":"Playbook not found.","code":"not_found"}"#),
        json_response(500, r#"{"ok":false,"error":"nope","code":"nope"}"#),
        json_response(200, &detail_ok(&summary_json(sibling, "nyx", "review", 1))),
    ]);
    let rows = community_download_status_with(&mut http, "http://library.test", &repo).unwrap();
    let row = |id: &str| rows.iter().find(|row| row.id == id).unwrap_or_else(|| panic!("missing {id}"));
    assert!(row(higher).update_available);
    assert_eq!(row(higher).remote_version, Some(4));
    assert!(!row(equal).update_available);
    assert_eq!(row(equal).remote_version, Some(3));
    assert!(!row(lower).update_available);
    assert_eq!(row(lower).remote_version, Some(2));
    assert_eq!(row(lower).imported_version, 3);
    assert!(row(missing).remote_missing);
    assert!(row(missing).error.is_none());
    assert!(!row(missing).update_available);
    assert!(row(broken).error.is_some());
    assert!(row(sibling).error.is_none());
    assert_eq!(rows.len(), 6);
    assert!(http.requests.iter().all(|request| !request.url.contains("/source")));
}

#[test]
fn download_status_has_no_bearer() {
    let repo = auth_dir("community-status-bearer");
    write_community_imports(&repo, &[sample_record()]).unwrap();
    let mut http = recorder(vec![json_response(200, &detail_ok(&summary_json(SAMPLE_ID, "nyx", "review", 3)))]);
    community_download_status_with(&mut http, "http://library.test", &repo).unwrap();
    assert_eq!(http.requests.len(), 1);
    assert!(no_authorization(&http.requests[0].headers));
    assert!(!http.requests[0].url.contains("q="));
    assert!(!http.requests[0].url.contains("cursor="));
}

#[test]
fn download_status_401_is_reachability() {
    let repo = auth_dir("community-status-401");
    write_community_imports(&repo, &[sample_record()]).unwrap();
    let mut http = recorder(vec![json_response(401, r#"{"ok":false,"error":"Sign in to continue.","code":"unauthenticated"}"#)]);
    let rows = community_download_status_with(&mut http, "http://library.test", &repo).unwrap();
    assert_eq!(rows[0].error.as_deref(), Some("Could not reach the playbook library."));
    assert!(!rows[0].error.as_deref().unwrap_or("").contains("Sign in"));
    assert!(http.requests.iter().all(|request| !request.url.contains("/source")));
}

const IMPORT_ID: &str = "8c19b367-d20b-4e60-b2ec-df73d8123aa1";
const OTHER_IMPORT_ID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

fn desktop_fixture() -> String {
    "+++\nversion = 2\nkey = \"test\"\ntitle = \"Test\"\ndescription = \"\"\ndefault_model = \"\"\ndefault_harness = \"\"\n[[step]]\nkey = \"run\"\ntitle = \"Run\"\nshort = \"\"\nis_coding_step = false\nauto_advance_default = false\ninputs = [{path = \"ticket.md\", mode = \"single\"}]\noutputs = [{path = \"result.md\"}]\nmodel = \"\"\nharness = \"\"\n+++\nPreamble\n<!-- alinery:step run -->\nRead {{TICKET_FILE}}.\n".into()
}

fn server_minimal() -> String {
    "+++\nversion = 2\nkey = \"review\"\ntitle = \"Review\"\ndescription = \"Review a change.\"\ndefault_model = \"\"\ndefault_harness = \"omp\"\n[[step]]\nkey = \"read\"\ntitle = \"Read\"\nshort = \"Read the diff\"\nis_coding_step = false\nauto_advance_default = false\ninputs = []\noutputs = []\nmodel = \"\"\nharness = \"\"\n+++\n".into()
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

fn repo_roots(name: &str) -> (std::path::PathBuf, PlaybookRoots) {
    let repo = auth_dir(name);
    fs::create_dir_all(repo.join("global-config")).unwrap();
    let roots = PlaybookRoots {
        global_config_dir: repo.join("global-config"),
        repo_dir: repo.clone(),
    };
    (repo, roots)
}

fn playbook_file(repo: &Path, key: &str) -> std::path::PathBuf {
    repo.join(".alinery/playbooks").join(key).join("playbook.md")
}

/// The seam for tests that only need the retry to carry on: no persistence, because
/// nothing in those flows inspects the generation it produced.
fn keep_refresh(tokens: &AccountTokens) -> Result<AccountTokens, AccountAuthError> {
    Ok(rotated_tokens_for_test(tokens, "new-access", "rotated-refresh"))
}

fn file_sha256(path: &Path) -> String {
    let output = std::process::Command::new("/usr/bin/openssl").args(["dgst", "-sha256"]).arg(path).output().unwrap();
    String::from_utf8_lossy(&output.stdout).split_whitespace().last().unwrap().to_lowercase()
}

#[test]
fn import_needs_account() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let (repo, roots) = repo_roots("community-import-signed-out");
    let auth = repo.join("missing-auth.json");
    let mut http = recorder(Vec::new());
    let result = import_community_playbook_with(&mut http, "http://library.test", &auth, keep_refresh, &roots, IMPORT_ID, false);
    assert_eq!(result, ImportResult::NeedsAccount);
    assert!(http.requests.is_empty());
    assert!(!playbook_file(&repo, "test").exists());
    assert!(!registry_path(&repo).exists());
}

#[test]
fn import_rejects_desktop_invalid_body() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let (repo, roots) = repo_roots("community-import-invalid");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    let mut http = recorder(vec![json_response(200, &source_body(IMPORT_ID, 1, &server_minimal(), "review"))]);
    let result = import_community_playbook_with(&mut http, "http://library.test", &auth, keep_refresh, &roots, IMPORT_ID, false);
    assert!(matches!(result, ImportResult::Invalid { .. }), "{result:?}");
    assert!(!playbook_file(&repo, "review").exists());
    assert!(!playbook_file(&repo, "test").exists());
    assert!(read_community_imports(&repo).unwrap().is_empty());
}

#[test]
fn import_saves_repo_file_and_version() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let (repo, roots) = repo_roots("community-import-save");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    let mut http = recorder(vec![json_response(200, &source_body(IMPORT_ID, 3, &desktop_fixture(), "test"))]);
    let result = import_community_playbook_with(&mut http, "http://library.test", &auth, keep_refresh, &roots, IMPORT_ID, false);
    let ImportResult::Saved {
        reference,
        imported_version,
        local_sha256,
    } = result
    else {
        panic!("{result:?}");
    };
    assert_eq!(reference.scope, PlaybookScope::Repo);
    assert_eq!(reference.key, "test");
    assert_eq!(imported_version, 3);
    let path = playbook_file(&repo, "test");
    assert!(path.is_file());
    assert_eq!(local_sha256, file_sha256(&path));
    let records = read_community_imports(&repo).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].id, IMPORT_ID);
    assert_eq!(records[0].imported_version, 3);
    assert_eq!(records[0].local_sha256, local_sha256);
    assert_eq!(records[0].local_key, "test");
    assert_eq!(records[0].local_scope, "repo");
}

#[test]
fn import_conflict_does_not_write() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let (repo, roots) = repo_roots("community-import-conflict");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    let path = playbook_file(&repo, "test");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "original-bytes").unwrap();
    let mut http = recorder(vec![json_response(200, &source_body(IMPORT_ID, 3, &desktop_fixture(), "test"))]);
    let result = import_community_playbook_with(&mut http, "http://library.test", &auth, keep_refresh, &roots, IMPORT_ID, false);
    assert_eq!(result, ImportResult::Conflict { local_key: "test".into() });
    assert_eq!(fs::read(&path).unwrap(), b"original-bytes");
    assert!(read_community_imports(&repo).unwrap().is_empty());
}

#[test]
fn import_overwrite_replaces_record() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let (repo, roots) = repo_roots("community-import-overwrite");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    let path = playbook_file(&repo, "test");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "original-bytes").unwrap();
    let mut previous = sample_record();
    previous.id = OTHER_IMPORT_ID.into();
    previous.local_key = "test".into();
    write_community_imports(&repo, &[previous]).unwrap();
    let mut http = recorder(vec![json_response(200, &source_body(IMPORT_ID, 4, &desktop_fixture(), "test"))]);
    let result = import_community_playbook_with(&mut http, "http://library.test", &auth, keep_refresh, &roots, IMPORT_ID, true);
    assert!(matches!(result, ImportResult::Saved { .. }), "{result:?}");
    assert_ne!(fs::read(&path).unwrap(), b"original-bytes");
    let records = read_community_imports(&repo).unwrap();
    assert!(records.iter().all(|record| record.id != OTHER_IMPORT_ID));
    assert!(records.iter().any(|record| record.id == IMPORT_ID && record.local_key == "test"));
}

#[test]
fn second_import_is_already_downloaded() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let (repo, roots) = repo_roots("community-import-twice");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    let path = playbook_file(&repo, "test");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "kept-bytes").unwrap();
    let mut record = sample_record();
    record.id = IMPORT_ID.into();
    record.local_key = "test".into();
    write_community_imports(&repo, &[record]).unwrap();
    let mut http = recorder(Vec::new());
    let result = import_community_playbook_with(&mut http, "http://library.test", &auth, keep_refresh, &roots, IMPORT_ID, true);
    assert_eq!(result, ImportResult::AlreadyDownloaded);
    assert!(http.requests.iter().all(|request| !request.url.contains("/source")));
    assert_eq!(fs::read(&path).unwrap(), b"kept-bytes");
}

#[test]
fn update_matching_hash_overwrites() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let (repo, roots) = repo_roots("community-update-match");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    let mut http = recorder(vec![json_response(200, &source_body(IMPORT_ID, 3, &desktop_fixture(), "test"))]);
    assert!(matches!(
        import_community_playbook_with(&mut http, "http://library.test", &auth, keep_refresh, &roots, IMPORT_ID, false),
        ImportResult::Saved { .. }
    ));
    let revised = desktop_fixture().replace("title = \"Test\"", "title = \"Updated\"");
    let mut http = recorder(vec![json_response(200, &source_body(IMPORT_ID, 5, &revised, "test"))]);
    let result = update_community_import_with(&mut http, "http://library.test", &auth, keep_refresh, &roots, IMPORT_ID, false);
    let UpdateResult::Saved { imported_version, .. } = result else {
        panic!("{result:?}");
    };
    assert_eq!(imported_version, 5);
    assert!(fs::read_to_string(playbook_file(&repo, "test")).unwrap().contains("Updated"));
    assert_eq!(read_community_imports(&repo).unwrap()[0].imported_version, 5);
}

#[test]
fn update_edited_does_not_fetch() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let (repo, roots) = repo_roots("community-update-edited");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    let mut http = recorder(vec![json_response(200, &source_body(IMPORT_ID, 3, &desktop_fixture(), "test"))]);
    import_community_playbook_with(&mut http, "http://library.test", &auth, keep_refresh, &roots, IMPORT_ID, false);
    let path = playbook_file(&repo, "test");
    fs::write(&path, "locally edited").unwrap();
    let mut http = recorder(Vec::new());
    let result = update_community_import_with(&mut http, "http://library.test", &auth, keep_refresh, &roots, IMPORT_ID, false);
    assert_eq!(result, UpdateResult::Edited);
    assert!(http.requests.is_empty());
    assert_eq!(fs::read(&path).unwrap(), b"locally edited");
    assert_eq!(read_community_imports(&repo).unwrap()[0].imported_version, 3);
}

#[test]
fn update_edited_overwrite_writes() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let (repo, roots) = repo_roots("community-update-force");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    let mut http = recorder(vec![json_response(200, &source_body(IMPORT_ID, 3, &desktop_fixture(), "test"))]);
    import_community_playbook_with(&mut http, "http://library.test", &auth, keep_refresh, &roots, IMPORT_ID, false);
    fs::write(playbook_file(&repo, "test"), "locally edited").unwrap();
    let mut http = recorder(vec![json_response(200, &source_body(IMPORT_ID, 6, &desktop_fixture(), "test"))]);
    let result = update_community_import_with(&mut http, "http://library.test", &auth, keep_refresh, &roots, IMPORT_ID, true);
    assert!(matches!(result, UpdateResult::Saved { imported_version: 6, .. }), "{result:?}");
    assert_ne!(fs::read(playbook_file(&repo, "test")).unwrap(), b"locally edited");
}

#[test]
fn update_missing_file_is_not_edited() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let (repo, roots) = repo_roots("community-update-missing");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    let mut record = sample_record();
    record.id = IMPORT_ID.into();
    record.local_key = "test".into();
    record.imported_version = 2;
    write_community_imports(&repo, &[record]).unwrap();
    let mut http = recorder(vec![json_response(200, &source_body(IMPORT_ID, 4, &desktop_fixture(), "test"))]);
    let result = update_community_import_with(&mut http, "http://library.test", &auth, keep_refresh, &roots, IMPORT_ID, false);
    assert!(matches!(result, UpdateResult::Saved { .. }), "{result:?}");
    assert!(playbook_file(&repo, "test").is_file());
}

#[test]
fn update_invalid_body_keeps_version() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let (repo, roots) = repo_roots("community-update-invalid");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    let mut http = recorder(vec![json_response(200, &source_body(IMPORT_ID, 3, &desktop_fixture(), "test"))]);
    import_community_playbook_with(&mut http, "http://library.test", &auth, keep_refresh, &roots, IMPORT_ID, false);
    let before = fs::read(playbook_file(&repo, "test")).unwrap();
    let mut http = recorder(vec![json_response(200, &source_body(IMPORT_ID, 9, &server_minimal(), "review"))]);
    let result = update_community_import_with(&mut http, "http://library.test", &auth, keep_refresh, &roots, IMPORT_ID, false);
    assert!(matches!(result, UpdateResult::Invalid { .. }), "{result:?}");
    assert_eq!(fs::read(playbook_file(&repo, "test")).unwrap(), before);
    assert_eq!(read_community_imports(&repo).unwrap()[0].imported_version, 3);
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
    let (repo, _roots) = repo_roots("community-preview-ok");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    let document = desktop_fixture();
    let mut http = recorder(vec![json_response(200, &source_body(IMPORT_ID, 3, &document, "test"))]);
    let result = preview_community_playbook_with(&mut http, "http://library.test", &auth, keep_refresh, IMPORT_ID);
    assert_eq!(result, PreviewResult::Loaded { source: document });
    assert_eq!(http.requests.len(), 1);
    assert_eq!(http.requests[0].method, "GET");
    assert!(http.requests[0].url.ends_with(&format!("/api/desktop/playbooks/{IMPORT_ID}/source")));
    assert!(!playbook_file(&repo, "test").exists());
    assert!(!registry_path(&repo).exists());
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

#[test]
fn delete_repo_playbook_forgets_import() {
    let (repo, roots) = repo_roots("community-delete-import");
    let mut record = sample_record();
    record.local_key = "test".into();
    write_community_imports(&repo, &[record]).unwrap();
    let path = playbook_file(&repo, "test");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, desktop_fixture()).unwrap();
    delete_playbook_keeping_imports(
        &roots,
        &PlaybookRef {
            scope: PlaybookScope::Repo,
            key: "test".into(),
        },
    )
    .unwrap();
    assert!(read_community_imports(&repo).unwrap().iter().all(|record| record.local_key != "test"));
    let before = fs::read(registry_path(&repo)).unwrap();
    delete_playbook_keeping_imports(
        &roots,
        &PlaybookRef {
            scope: PlaybookScope::Global,
            key: "test".into(),
        },
    )
    .ok();
    assert_eq!(fs::read(registry_path(&repo)).unwrap(), before);
}

/// Writes a playbook into the repo when the source request is served — the window between
/// the pre-fetch check and the write.
struct WriteOnFetch {
    inner: Recorder,
    path: std::path::PathBuf,
    bytes: Vec<u8>,
}

impl CommunityHttp for WriteOnFetch {
    fn exchange(&mut self, request: CommunityHttpRequest) -> Result<CommunityHttpResponse, String> {
        if request.url.ends_with("/source") {
            fs::create_dir_all(self.path.parent().unwrap()).unwrap();
            fs::write(&self.path, &self.bytes).unwrap();
        }
        self.inner.exchange(request)
    }
}

#[test]
fn update_does_not_replace_an_edit_made_while_the_source_was_fetched() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let (repo, roots) = repo_roots("community-update-race");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    let mut http = recorder(vec![json_response(200, &source_body(IMPORT_ID, 3, &desktop_fixture(), "test"))]);
    import_community_playbook_with(&mut http, "http://library.test", &auth, keep_refresh, &roots, IMPORT_ID, false);
    let path = playbook_file(&repo, "test");
    let edited = desktop_fixture().replace("Preamble", "Locally edited preamble");
    let mut http = WriteOnFetch {
        inner: recorder(vec![json_response(200, &source_body(IMPORT_ID, 4, &desktop_fixture(), "test"))]),
        path: path.clone(),
        bytes: edited.clone().into_bytes(),
    };
    let result = update_community_import_with(&mut http, "http://library.test", &auth, keep_refresh, &roots, IMPORT_ID, false);
    assert_eq!(result, UpdateResult::Edited);
    assert_eq!(fs::read_to_string(&path).unwrap(), edited, "the edit must survive the update");
    assert_eq!(read_community_imports(&repo).unwrap()[0].imported_version, 3, "a refused write must not bump the version");
}

#[test]
fn import_does_not_overwrite_a_playbook_created_while_the_source_was_fetched() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let (repo, roots) = repo_roots("community-import-race");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    let path = playbook_file(&repo, "test");
    let appeared = desktop_fixture().replace("Preamble", "Created during the fetch");
    let mut http = WriteOnFetch {
        inner: recorder(vec![json_response(200, &source_body(IMPORT_ID, 1, &desktop_fixture(), "test"))]),
        path: path.clone(),
        bytes: appeared.clone().into_bytes(),
    };
    let result = import_community_playbook_with(&mut http, "http://library.test", &auth, keep_refresh, &roots, IMPORT_ID, false);
    assert_eq!(result, ImportResult::Conflict { local_key: "test".into() });
    assert_eq!(fs::read_to_string(&path).unwrap(), appeared, "a file that appeared mid-flight is not replaced");
    assert!(read_community_imports(&repo).unwrap().is_empty());
}

#[test]
fn delete_keeps_the_definition_when_the_registry_cannot_be_read() {
    let (repo, roots) = repo_roots("community-delete-bad-registry");
    let path = playbook_file(&repo, "test");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, desktop_fixture()).unwrap();
    fs::write(registry_path(&repo), b"not = [valid").unwrap();
    let result = delete_playbook_keeping_imports(
        &roots,
        &PlaybookRef {
            scope: PlaybookScope::Repo,
            key: "test".into(),
        },
    );
    assert!(matches!(result, Err(PlaybookSaveError::Io { .. })), "{result:?}");
    assert!(path.is_file(), "a registry we cannot read must not cost the definition");
}

#[test]
fn malformed_id_does_not_call() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let (repo, roots) = repo_roots("community-import-malformed");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    let mut http = recorder(Vec::new());
    let result = import_community_playbook_with(&mut http, "http://library.test", &auth, keep_refresh, &roots, "8C19B367-D20B-4E60-B2EC-DF73D8123AA1", false);
    assert!(http.requests.is_empty());
    match result {
        ImportResult::Failed { message } => assert_eq!(message, "Playbook not found."),
        other => panic!("{other:?}"),
    }
}

fn repo_ref(key: &str) -> PlaybookRef {
    PlaybookRef {
        scope: PlaybookScope::Repo,
        key: key.into(),
    }
}

fn write_stored(repo: &Path, key: &str, text: &str) {
    let path = playbook_file(repo, key);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, text).unwrap();
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

fn publish(http: &mut Recorder, roots: &PlaybookRoots, auth: &Path, reference: &PlaybookRef, label: Option<&str>) -> PublishResult {
    publish_community_playbook_with(http, "http://library.test", auth, keep_refresh, roots, reference, label)
}

#[test]
fn publish_desktop_invalid_does_not_call() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let (repo, roots) = repo_roots("community-publish-invalid");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    write_stored(&repo, "review", &server_minimal());
    let mut http = recorder(Vec::new());
    let result = publish(&mut http, &roots, &auth, &repo_ref("review"), None);
    assert!(http.requests.is_empty());
    assert!(matches!(result, PublishResult::Invalid { .. }), "{result:?}");
}

#[test]
fn publish_sends_stored_text() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let (repo, roots) = repo_roots("community-publish-stored");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    let stored = desktop_fixture().replace('\n', "\r\n");
    write_stored(&repo, "test", &stored);
    let mut http = recorder(vec![json_response(200, &validate_ok(false, None)), json_response(201, &detail_saved(IMPORT_ID, 1))]);
    let result = publish(&mut http, &roots, &auth, &repo_ref("test"), None);
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
    let (repo, roots) = repo_roots("community-publish-put");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    write_stored(&repo, "test", &desktop_fixture());
    let mut http = recorder(vec![
        json_response(200, &validate_ok(true, Some(IMPORT_ID))),
        json_response(200, &detail_saved(IMPORT_ID, 4)),
    ]);
    let result = publish(&mut http, &roots, &auth, &repo_ref("test"), Some("nyx"));
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
    let (repo, roots) = repo_roots("community-publish-create");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    write_stored(&repo, "test", &desktop_fixture());
    let mut http = recorder(vec![json_response(200, &validate_ok(false, None)), json_response(201, &detail_saved(IMPORT_ID, 1))]);
    let result = publish(&mut http, &roots, &auth, &repo_ref("test"), None);
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
    let (repo, roots) = repo_roots("community-publish-label");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    write_stored(&repo, "test", &desktop_fixture());
    let mut http = recorder(vec![
        json_response(200, &validate_ok(false, None)),
        json_response(400, &error_json("label_required", "Choose a public label.")),
    ]);
    let result = publish(&mut http, &roots, &auth, &repo_ref("test"), None);
    assert_eq!(result, PublishResult::LabelRequired);
    assert_eq!(
        http.requests
            .iter()
            .filter(|request| request.method == "POST" && request.url.ends_with("/api/desktop/playbooks"))
            .count(),
        1
    );
    let mut http = recorder(vec![json_response(200, &validate_ok(false, None)), json_response(201, &detail_saved(IMPORT_ID, 1))]);
    let result = publish(&mut http, &roots, &auth, &repo_ref("test"), Some("nyx"));
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
    let (repo, roots) = repo_roots("community-publish-conflict");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    write_stored(&repo, "test", &desktop_fixture());
    let mine = serde_json::json!({"ok": true, "truncated": false, "playbooks": [serde_json::from_str::<serde_json::Value>(&summary_json(IMPORT_ID, "nyx", "test", 2)).unwrap()]})
        .to_string();
    let mut http = recorder(vec![
        json_response(200, &validate_ok(false, None)),
        json_response(409, &error_json("conflict", "You already published this playbook. Update it.")),
        json_response(200, &mine),
        json_response(200, &detail_saved(IMPORT_ID, 3)),
    ]);
    let result = publish(&mut http, &roots, &auth, &repo_ref("test"), None);
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
    let (repo, roots) = repo_roots("community-publish-truncated");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    write_stored(&repo, "test", &desktop_fixture());
    let mine = r#"{"ok":true,"truncated":true,"playbooks":[]}"#;
    let mut http = recorder(vec![
        json_response(200, &validate_ok(false, None)),
        json_response(409, &error_json("conflict", "You already published this playbook. Update it.")),
        json_response(200, mine),
    ]);
    let result = publish(&mut http, &roots, &auth, &repo_ref("test"), None);
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
    let (repo, roots) = repo_roots("community-publish-concurrent");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    write_stored(&repo, "test", &desktop_fixture());
    let conflict = error_json("conflict", "Playbook was updated concurrently. Try again.");
    let mut http = recorder(vec![
        json_response(200, &validate_ok(true, Some(IMPORT_ID))),
        json_response(409, &conflict),
        json_response(409, &conflict),
        json_response(409, &conflict),
    ]);
    let result = publish(&mut http, &roots, &auth, &repo_ref("test"), None);
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
    let (repo, roots) = repo_roots("community-publish-key-changed");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    write_stored(&repo, "test", &desktop_fixture());
    let mut http = recorder(vec![
        json_response(200, &validate_ok(true, Some(IMPORT_ID))),
        json_response(422, &error_json("key_changed", "The playbook key cannot change. Publish a new one.")),
    ]);
    let result = publish(&mut http, &roots, &auth, &repo_ref("test"), None);
    match result {
        PublishResult::Failed { message, .. } => assert_eq!(message, "The playbook key cannot change. Publish a new one."),
        other => panic!("{other:?}"),
    }
    assert_eq!(http.requests.iter().filter(|request| request.method == "PUT").count(), 1);
}

#[test]
fn publish_503_is_replaced() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let (repo, roots) = repo_roots("community-publish-503");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    write_stored(&repo, "test", &desktop_fixture());
    let body = r#"{"ok":false,"error":"Playbook library is unavailable. SUPABASE_SERVICE_ROLE_KEY is not configured on the server.","code":"unavailable"}"#;
    let mut http = recorder(vec![json_response(503, body)]);
    let result = publish(&mut http, &roots, &auth, &repo_ref("test"), None);
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
    let (repo, roots) = repo_roots("community-publish-signed-out");
    let auth = repo.join("missing-auth.json");
    write_stored(&repo, "test", &desktop_fixture());
    let mut http = recorder(Vec::new());
    let result = publish(&mut http, &roots, &auth, &repo_ref("test"), None);
    assert_eq!(result, PublishResult::NeedsAccount);
    assert!(http.requests.is_empty());
}

#[test]
fn publish_401_refreshes_once() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let (repo, roots) = repo_roots("community-publish-401");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "old-access", "refresh-keep");
    write_stored(&repo, "test", &desktop_fixture());
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
        &roots,
        &repo_ref("test"),
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
    let (repo, roots) = repo_roots("community-publish-second-401");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "old-access", "refresh-keep");
    write_stored(&repo, "test", &desktop_fixture());
    let mut http = recorder(vec![
        json_response(401, &error_json("unauthenticated", "Sign in to continue.")),
        json_response(401, &error_json("unauthenticated", "Sign in to continue.")),
    ]);
    let result = publish_community_playbook_with(
        &mut http,
        "http://library.test",
        &auth,
        |tokens| Ok(rotated(&auth, tokens)),
        &roots,
        &repo_ref("test"),
        None,
    );
    assert_eq!(result, PublishResult::NeedsAccount);
    assert!(!auth.exists());
}

#[test]
fn publish_does_not_clear_registry() {
    let _serial = crate::CREDENTIAL_HOOK_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let (repo, roots) = repo_roots("community-publish-registry");
    let auth = repo.join("auth.json");
    write_pairing(&auth, "access", "refresh-keep");
    write_stored(&repo, "test", &desktop_fixture());
    let mut record = sample_record();
    record.local_key = "test".into();
    write_community_imports(&repo, &[record]).unwrap();
    let before = fs::read(registry_path(&repo)).unwrap();
    let mut http = recorder(vec![json_response(200, &validate_ok(false, None)), json_response(201, &detail_saved(IMPORT_ID, 1))]);
    let result = publish(&mut http, &roots, &auth, &repo_ref("test"), None);
    assert!(matches!(result, PublishResult::Saved { .. }), "{result:?}");
    assert_eq!(fs::read(registry_path(&repo)).unwrap(), before);
}
