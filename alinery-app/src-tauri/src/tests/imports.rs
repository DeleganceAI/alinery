//! Tests for imports.rs — Linear and GitHub reference parsing
//!
//! `use super::*` reaches the shared imports and fixtures in tests/mod.rs.
use super::*;
use crate::imports::{
    compose_github_description, import_github_with, GitHubClient, GitHubDiscussionItem, GitHubIssueRef, GitHubRequester, GitHubResource, GitHubResourceKind, GitHubTransport,
    MAX_GITHUB_COMMENTS, MAX_GITHUB_IMPORT_BYTES,
};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::net::{TcpListener, TcpStream};
use std::{cell::RefCell, rc::Rc};

#[derive(Default)]
struct FixtureRequester {
    rest_responses: HashMap<String, VecDeque<Result<Value, String>>>,
    rest_requests: Vec<String>,
}

impl FixtureRequester {
    fn rest(mut self, url: impl Into<String>, responses: Vec<Result<Value, String>>) -> Self {
        self.rest_responses.insert(url.into(), responses.into());
        self
    }
}

impl GitHubRequester for FixtureRequester {
    fn rest_json(&mut self, url: &str) -> Result<Value, String> {
        self.rest_requests.push(url.to_string());
        let response = self
            .rest_responses
            .get_mut(url)
            .and_then(VecDeque::pop_front)
            .unwrap_or_else(|| Err(format!("unexpected REST request: {url}")))?;
        if let Some(error) = crate::github_error(&response) {
            return Err(format!("GitHub error: {error}"));
        }
        Ok(response)
    }
}

fn issue_ref(number: u64) -> GitHubIssueRef {
    GitHubIssueRef {
        owner: "owner".into(),
        repo: "repo".into(),
        number,
    }
}

fn resource_value(number: u64, kind: GitHubResourceKind, title: &str, body: Value, comment_count: u64) -> Value {
    let mut value = json!({
        "number": number,
        "title": title,
        "body": body,
        "comments": comment_count,
        "html_url": format!(
            "https://github.com/owner/repo/{}/{}",
            if kind == GitHubResourceKind::Issue { "issues" } else { "pull" },
            number
        ),
    });
    if kind == GitHubResourceKind::PullRequest {
        value["pull_request"] = json!({});
    }
    value
}

fn resource(number: u64, kind: GitHubResourceKind, title: &str, body: &str) -> GitHubResource {
    GitHubResource {
        reference: issue_ref(number),
        kind,
        title: title.into(),
        body: body.into(),
        url: format!(
            "https://github.com/owner/repo/{}/{}",
            if kind == GitHubResourceKind::Issue { "issues" } else { "pull" },
            number
        ),
        comment_count: 0,
    }
}

fn comment(body: &str, login: Option<&str>, created_at: Option<&str>, html_url: Option<&str>) -> Value {
    json!({
        "body": body,
        "user": login.map(|login| json!({ "login": login })),
        "created_at": created_at,
        "html_url": html_url,
    })
}

fn discussion_item(body: impl Into<String>) -> GitHubDiscussionItem {
    GitHubDiscussionItem {
        source: issue_ref(42),
        body: body.into(),
        author: Some("author".into()),
        created_at: None,
        url: None,
    }
}

fn resource_api(number: u64) -> String {
    format!("https://api.github.com/repos/owner/repo/issues/{number}")
}

fn comments_page(number: u64, page: u64) -> String {
    format!("https://api.github.com/repos/owner/repo/issues/{number}/comments?per_page={MAX_GITHUB_COMMENTS}&page={page}")
}

#[derive(Default)]
struct RecordingState {
    responses: VecDeque<Result<Value, String>>,
    calls: Vec<(String, Option<String>)>,
}

#[derive(Clone, Default)]
struct RecordingTransport {
    state: Rc<RefCell<RecordingState>>,
}

impl RecordingTransport {
    fn with_responses(responses: Vec<Result<Value, String>>) -> Self {
        Self {
            state: Rc::new(RefCell::new(RecordingState {
                responses: responses.into(),
                calls: Vec::new(),
            })),
        }
    }

    fn calls(&self) -> Vec<(String, Option<String>)> {
        self.state.borrow().calls.clone()
    }
}

impl GitHubTransport for RecordingTransport {
    fn request_json(&mut self, url: &str, token: Option<&str>) -> Result<Value, String> {
        let mut state = self.state.borrow_mut();
        state.calls.push((url.into(), token.map(str::to_string)));
        state.responses.pop_front().unwrap_or_else(|| Err("unexpected request".into()))
    }
}

#[test]
fn parse_linear_ref_id_and_url() {
    assert_eq!(parse_linear_ref("ENG-123").as_deref(), Some("ENG-123"));
    assert_eq!(parse_linear_ref("eng-123").as_deref(), Some("ENG-123")); // upcased
    assert_eq!(parse_linear_ref("https://linear.app/acme/issue/ABC-42/some-title").as_deref(), Some("ABC-42"));
    assert_eq!(parse_linear_ref("  DEL-7  ").as_deref(), Some("DEL-7"));
    // Not an identifier shape.
    assert_eq!(parse_linear_ref("just some text"), None);
    assert_eq!(parse_linear_ref("123-ABC"), None); // letters then digits, not reversed
    assert_eq!(parse_linear_ref(""), None);
}

#[test]
fn oauth_callback_and_pkce_are_encoded_safely() {
    assert_eq!(percent_encode("http://127.0.0.1:43119/a b"), "http%3A%2F%2F127.0.0.1%3A43119%2Fa%20b");
    assert_eq!(
        parse_oauth_callback("GET /oauth/linear/callback?code=abc%2B123&state=state-1 HTTP/1.1\r\n\r\n").unwrap(),
        OAuthCallback::Code {
            code: "abc+123".into(),
            state: "state-1".into(),
        }
    );
    assert_eq!(
        pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk").unwrap(),
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
}

#[test]
fn curl_config_sends_secrets_over_stdin() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut request = [0; 4096];
        let count = stream.read(&mut request).unwrap();
        let request = String::from_utf8_lossy(&request[..count]);
        assert!(request.contains("Authorization: Bearer secret-token"));
        assert!(request.ends_with("code=secret%2Bvalue"));
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok").unwrap();
    });
    let response = curl_request(
        &format!("http://{address}/token"),
        &["Authorization: Bearer secret-token".into()],
        Some("code=secret%2Bvalue"),
    )
    .unwrap();
    server.join().unwrap();
    assert_eq!(response, b"ok");
}

#[test]
fn oauth_listener_ignores_unsolicited_callbacks() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let waiter = std::thread::spawn(move || wait_for_linear_callback(listener, "expected"));
    for request in [
        "GET /favicon.ico HTTP/1.1\r\n\r\n",
        "GET /oauth/linear/callback?code=wrong&state=other HTTP/1.1\r\n\r\n",
        "GET /oauth/linear/callback?code=right&state=expected HTTP/1.1\r\n\r\n",
    ] {
        let mut stream = (0..20)
            .find_map(|_| match TcpStream::connect(address) {
                Ok(stream) => Some(stream),
                Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => {
                    std::thread::sleep(Duration::from_millis(10));
                    None
                }
                Err(error) => panic!("connect to OAuth listener: {error}"),
            })
            .expect("OAuth listener did not accept connections");
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();
    }
    assert_eq!(waiter.join().unwrap().unwrap(), "right");
}

#[test]
fn parse_github_issue_refs() {
    let default = Some(("owner".to_string(), "repo".to_string()));
    assert_eq!(
        parse_github_ref("https://github.com/dtdannen/alinery/issues/9", None).map(|r| r.label()).as_deref(),
        Some("dtdannen/alinery#9")
    );
    assert_eq!(parse_github_ref("dtdannen/alinery#9", None).map(|r| r.label()).as_deref(), Some("dtdannen/alinery#9"));
    assert_eq!(
        parse_github_ref("dtdannen/alinery/issues/9?foo=bar", None).map(|r| r.label()).as_deref(),
        Some("dtdannen/alinery#9")
    );
    assert_eq!(parse_github_ref("#9", default.clone()).map(|r| r.label()).as_deref(), Some("owner/repo#9"));
    assert_eq!(parse_github_ref("9", default).map(|r| r.label()).as_deref(), Some("owner/repo#9"));
    assert_eq!(parse_github_ref("#0", Some(("o".into(), "r".into()))), None);
    assert_eq!(parse_github_ref("not an issue", None), None);
}

#[test]
fn parse_github_pull_refs() {
    assert_eq!(
        parse_github_ref("https://github.com/dtdannen/alinery/pull/42", None)
            .map(|reference| reference.label())
            .as_deref(),
        Some("dtdannen/alinery#42")
    );
    assert_eq!(
        parse_github_ref("dtdannen/alinery/pull/42?notification_referrer_id=1", None)
            .map(|reference| reference.label())
            .as_deref(),
        Some("dtdannen/alinery#42")
    );
    assert_eq!(parse_github_ref("dtdannen/alinery/pull/0", None), None);
    assert_eq!(parse_github_ref("dtdannen/alinery/pull/not-a-number", None), None);
    assert_eq!(parse_github_ref("dtdannen/alinery/pulls/42", None), None);
    assert_eq!(parse_github_ref("dtdannen/alinery/pull/42/files", None), None);
}

#[test]
fn github_token_lookup_pins_github_dot_com() {
    let command = crate::gh_auth_token_command();
    let args = command.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect::<Vec<_>>();

    assert_eq!(args, vec!["auth".to_string(), "token".to_string(), "--hostname".to_string(), "github.com".to_string(),]);
}

#[test]
fn github_repo_from_remote_supports_origin_shapes() {
    assert_eq!(github_repo_from_remote("git@github.com:owner/repo.git"), Some(("owner".to_string(), "repo".to_string())));
    assert_eq!(github_repo_from_remote("https://github.com/owner/repo"), Some(("owner".to_string(), "repo".to_string())));
    assert_eq!(
        github_repo_from_remote("ssh://git@github.com/owner/repo.git"),
        Some(("owner".to_string(), "repo".to_string()))
    );
    assert_eq!(github_repo_from_remote("git@git.example.com:owner/repo.git"), None);
}

#[test]
fn github_request_auth_candidates_keep_existing_order() {
    let transport = RecordingTransport::with_responses(vec![Ok(json!({ "message": "bad connected token" })), Ok(json!({ "ok": true }))]);
    let recorder = transport.clone();
    let mut client = GitHubClient::new(transport, Some("connected-secret".into()), Some("configured-secret".into()));

    assert_eq!(client.rest_json("https://api.github.com/example").unwrap(), json!({ "ok": true }));
    assert_eq!(
        recorder.calls(),
        vec![
            ("https://api.github.com/example".into(), Some("connected-secret".into())),
            ("https://api.github.com/example".into(), Some("configured-secret".into())),
        ]
    );

    let transport = RecordingTransport::with_responses(vec![Ok(json!({ "ok": "public" }))]);
    let recorder = transport.clone();
    let mut public = GitHubClient::new(transport, None, None);
    assert_eq!(public.rest_json("https://api.github.com/public").unwrap(), json!({ "ok": "public" }));
    assert_eq!(recorder.calls(), vec![("https://api.github.com/public".into(), None)]);

    let transport = RecordingTransport::with_responses(vec![Err("connected-secret configured-secret".into())]);
    let mut client = GitHubClient::new(transport, Some("connected-secret".into()), Some("configured-secret".into()));
    let error = client.rest_json("https://api.github.com/example").unwrap_err();
    assert!(!error.contains("connected-secret"));
    assert!(!error.contains("configured-secret"));
    assert!(error.contains("[REDACTED]"));
}

#[test]
fn github_description_preserves_legacy_bytes_without_comments() {
    let selected = resource(42, GitHubResourceKind::Issue, "Issue", "Opening body");
    assert_eq!(
        compose_github_description(&selected, &[], false),
        "GitHub: https://github.com/owner/repo/issues/42\n\nOpening body"
    );

    let selected = resource(42, GitHubResourceKind::Issue, "Issue", "");
    assert_eq!(compose_github_description(&selected, &[], false), "GitHub: https://github.com/owner/repo/issues/42\n");
}

#[test]
fn github_description_formats_attributed_comments_exactly() {
    let selected = resource(42, GitHubResourceKind::Issue, "Selected issue", "Opening body");
    let discussion = vec![
        GitHubDiscussionItem {
            source: issue_ref(42),
            body: "First comment".into(),
            author: Some("alice".into()),
            created_at: Some("2026-08-26T12:00:00Z".into()),
            url: Some("https://github.com/owner/repo/issues/42#issuecomment-1".into()),
        },
        GitHubDiscussionItem {
            source: issue_ref(42),
            body: "Second comment".into(),
            author: None,
            created_at: None,
            url: None,
        },
    ];

    assert_eq!(
        compose_github_description(&selected, &discussion, false),
        concat!(
            "GitHub: https://github.com/owner/repo/issues/42\n\nOpening body",
            "\n\n## GitHub Comments",
            "\n\n### owner/repo#42 — alice — 2026-08-26T12:00:00Z — https://github.com/owner/repo/issues/42#issuecomment-1",
            "\n\nFirst comment",
            "\n\n### owner/repo#42 — unknown GitHub author",
            "\n\nSecond comment",
        )
    );
}

#[test]
fn import_selected_resource_only_and_keeps_ascending_api_order() {
    let mut requester = FixtureRequester::default()
        .rest(
            resource_api(42),
            vec![Ok(resource_value(42, GitHubResourceKind::Issue, "Issue title", json!("Opening"), 2))],
        )
        .rest(
            comments_page(42, 1),
            vec![Ok(json!([
                comment("oldest comment", Some("old"), Some("2026-08-26T12:00:00Z"), None),
                comment("newest comment", Some("new"), Some("2026-08-27T12:00:00Z"), None)
            ]))],
        );

    let imported = import_github_with(&mut requester, issue_ref(42)).unwrap();

    assert_eq!(imported.reference, "owner/repo#42");
    assert_eq!(imported.title, "Issue title");
    assert!(imported.description.find("oldest comment").unwrap() < imported.description.find("newest comment").unwrap());
    assert_eq!(requester.rest_requests, vec![resource_api(42), comments_page(42, 1)]);
}

#[test]
fn selected_pull_request_imports_only_its_top_level_conversation() {
    let mut requester = FixtureRequester::default()
        .rest(
            resource_api(12),
            vec![Ok(resource_value(12, GitHubResourceKind::PullRequest, "Pull request title", json!("Opening"), 1))],
        )
        .rest(comments_page(12, 1), vec![Ok(json!([comment("selected PR conversation", Some("alice"), None, None)]))]);

    let imported = import_github_with(&mut requester, issue_ref(12)).unwrap();

    assert!(imported.description.contains("selected PR conversation"));
    assert_eq!(requester.rest_requests, vec![resource_api(12), comments_page(12, 1)]);
}

#[test]
fn import_keeps_the_newest_hundred_comments_and_marks_older_discussion() {
    let newest = (101..=200)
        .map(|number| comment(&format!("comment-{number:03}"), Some("author"), None, None))
        .collect::<Vec<_>>();
    let mut requester = FixtureRequester::default()
        .rest(resource_api(42), vec![Ok(resource_value(42, GitHubResourceKind::Issue, "Issue", json!("Opening"), 200))])
        .rest(comments_page(42, 2), vec![Ok(Value::Array(newest))]);

    let imported = import_github_with(&mut requester, issue_ref(42)).unwrap();

    assert!(!imported.description.contains("comment-100"));
    assert!(imported.description.find("comment-101").unwrap() < imported.description.find("comment-200").unwrap());
    assert!(imported
        .description
        .ends_with("GitHub import truncated. Additional discussion remains at https://github.com/owner/repo/issues/42."));
    assert_eq!(requester.rest_requests, vec![resource_api(42), comments_page(42, 2)]);
}

#[test]
fn exactly_one_hundred_comments_need_no_probe_or_truncation_notice() {
    let comments = (1..=100)
        .map(|number| comment(&format!("comment-{number:03}"), Some("author"), None, None))
        .collect::<Vec<_>>();
    let mut requester = FixtureRequester::default()
        .rest(resource_api(42), vec![Ok(resource_value(42, GitHubResourceKind::Issue, "Issue", json!("Opening"), 100))])
        .rest(comments_page(42, 1), vec![Ok(Value::Array(comments))]);

    let imported = import_github_with(&mut requester, issue_ref(42)).unwrap();

    assert!(imported.description.contains("comment-001"));
    assert!(imported.description.contains("comment-100"));
    assert!(!imported.description.contains("GitHub import truncated."));
    assert_eq!(requester.rest_requests, vec![resource_api(42), comments_page(42, 1)]);
}

#[test]
fn newest_hundred_comments_can_span_two_ascending_pages() {
    let first_page = (1..=100)
        .map(|number| comment(&format!("comment-{number:03}"), Some("author"), None, None))
        .collect::<Vec<_>>();
    let mut requester = FixtureRequester::default()
        .rest(resource_api(42), vec![Ok(resource_value(42, GitHubResourceKind::Issue, "Issue", json!("Opening"), 101))])
        .rest(comments_page(42, 1), vec![Ok(Value::Array(first_page))])
        .rest(comments_page(42, 2), vec![Ok(json!([comment("comment-101", Some("author"), None, None)]))]);

    let imported = import_github_with(&mut requester, issue_ref(42)).unwrap();

    assert!(!imported.description.contains("comment-001"));
    assert!(imported.description.contains("comment-002"));
    assert!(imported.description.contains("comment-101"));
    assert!(imported.description.find("comment-002").unwrap() < imported.description.find("comment-101").unwrap());
    assert_eq!(requester.rest_requests, vec![resource_api(42), comments_page(42, 1), comments_page(42, 2)]);
}

#[test]
fn rendered_size_limit_keeps_the_newest_whole_comments_and_marks_truncation() {
    let selected = resource(42, GitHubResourceKind::Issue, "Issue", "Opening body");
    let discussion = vec![
        discussion_item(format!("oldest-marker\n{}", "o".repeat(24 * 1024))),
        discussion_item(format!("middle-marker\n{}", "m".repeat(24 * 1024))),
        discussion_item(format!("newest-marker\n{}", "n".repeat(24 * 1024))),
    ];

    let description = compose_github_description(&selected, &discussion, false);

    assert!(!description.contains("oldest-marker"));
    assert!(description.find("middle-marker").unwrap() < description.find("newest-marker").unwrap());
    assert!(description.contains("GitHub import truncated."));
    assert!(description.len() <= MAX_GITHUB_IMPORT_BYTES);
}

#[test]
fn opening_body_is_never_discarded_even_when_it_exceeds_the_import_limit() {
    let opening = format!("opening-marker\n{}", "x".repeat(MAX_GITHUB_IMPORT_BYTES));
    let selected = resource(42, GitHubResourceKind::Issue, "Issue", &opening);
    let description = compose_github_description(&selected, &[discussion_item("comment-marker")], false);

    assert!(description.contains(&opening));
    assert!(!description.contains("comment-marker"));
    assert!(description.contains("GitHub import truncated."));
}

#[test]
fn import_preserves_authored_markdown_and_metadata_fallbacks() {
    let raw = "## Heading\n\n```rust\nfn main() {}\n```\n\n<div>raw</div>\n\n- [ ] task\n\n## Evidence & Pointers";
    let mut minimized = comment(raw, None, None, None);
    minimized["minimized"] = json!(true);
    let mut requester = FixtureRequester::default()
        .rest(resource_api(42), vec![Ok(resource_value(42, GitHubResourceKind::Issue, "Issue", json!(""), 2))])
        .rest(
            comments_page(42, 1),
            vec![Ok(json!([
                minimized,
                comment("bot body", Some("dependabot[bot]"), Some("2026-08-26T12:00:00Z"), Some("https://example/comment"))
            ]))],
        );

    let imported = import_github_with(&mut requester, issue_ref(42)).unwrap();

    assert!(imported.description.contains("dependabot[bot] — 2026-08-26T12:00:00Z — https://example/comment"));
    assert!(imported.description.contains("### owner/repo#42 — unknown GitHub author"));
    assert!(imported.description.contains(raw));
}

#[test]
fn import_rejects_malformed_required_resources_and_comment_bodies() {
    let mut missing_title = FixtureRequester::default().rest(resource_api(42), vec![Ok(json!({ "body": "body" }))]);
    assert!(import_github_with(&mut missing_title, issue_ref(42)).is_err());

    for malformed_body in [Value::Null, json!(17), json!({ "wrong": "body" })] {
        let mut requester = FixtureRequester::default()
            .rest(resource_api(42), vec![Ok(resource_value(42, GitHubResourceKind::Issue, "Issue", json!(""), 1))])
            .rest(comments_page(42, 1), vec![Ok(json!([{ "body": malformed_body }]))]);
        assert!(import_github_with(&mut requester, issue_ref(42)).is_err());
    }
}

#[test]
fn import_rejects_a_failed_tail_comment_page() {
    let comments = (1..=100).map(|number| comment(&format!("comment-{number}"), None, None, None)).collect();
    let mut requester = FixtureRequester::default()
        .rest(resource_api(42), vec![Ok(resource_value(42, GitHubResourceKind::Issue, "Issue", json!(""), 101))])
        .rest(comments_page(42, 1), vec![Ok(Value::Array(comments))])
        .rest(comments_page(42, 2), vec![Err("tail page failed".into())]);

    assert!(import_github_with(&mut requester, issue_ref(42)).is_err());
}
