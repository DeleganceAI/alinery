//! Tests for canvas.rs — the Orbitron View spatial sidecar (`.alinery/canvas.json`)
//!
//! `use super::*` reaches the shared imports and fixtures in tests/mod.rs.
//!
//! The sidecar is the only durable state this slice adds, and every failure mode here is
//! silent: a validator that lets a bad document through, or a reader that turns a corrupt
//! file into an empty board, both look like "the canvas is blank" and the next write
//! destroys the user's real layout. So the validator rules are individually pinned.
use super::*;

use std::collections::BTreeMap;
use std::path::PathBuf;

fn canvas_repo(name: &str) -> PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let repo = std::env::temp_dir().join(format!("saga-canvas-{name}-{}-{nanos}", std::process::id()));
    fs::create_dir_all(alinery_core::alinery_dir(&repo)).unwrap();
    repo
}

fn concept(id: &str) -> CanvasConcept {
    CanvasConcept {
        id: id.into(),
        name: "Authentication".into(),
        x: 10.0,
        y: 20.0,
        w: 240.0,
        h: 120.0,
        manual: false,
    }
}

fn placement(concepts: &[&str]) -> CanvasPlacement {
    CanvasPlacement {
        concepts: concepts.iter().map(|c| (*c).to_string()).collect(),
        x: 5.0,
        y: 6.0,
        placed: true,
    }
}

fn doc_with(concepts: Vec<CanvasConcept>, placements: Vec<(&str, CanvasPlacement)>, relations: Vec<CanvasRelation>) -> CanvasDoc {
    CanvasDoc {
        concepts,
        placements: placements.into_iter().map(|(slug, p)| (slug.to_string(), p)).collect::<BTreeMap<_, _>>(),
        relations,
        ..empty_canvas_doc()
    }
}

fn relation(a: &str, b: &str, kind: CanvasRelationKind) -> CanvasRelation {
    CanvasRelation { a: a.into(), b: b.into(), kind }
}

// 1.1 — a repo that has never opened Orbitron must read as an empty board, and reading
// must not create the file: `read_canvas` runs on every mount, including for repos this
// window does not own.
#[test]
fn canvas_missing_file_returns_empty_doc_and_creates_nothing() {
    let repo = canvas_repo("missing");
    let doc = read_canvas_doc(&repo).expect("missing sidecar reads as an empty board");

    assert_eq!(doc, empty_canvas_doc());
    assert_eq!(doc.version, 1);
    assert!(doc.concepts.is_empty() && doc.placements.is_empty() && doc.relations.is_empty());
    assert_eq!(doc.view.cam_x, 0.0);
    assert_eq!(doc.view.cam_y, 0.0);
    assert_eq!(doc.view.scale, 1.0);
    assert!(!doc.view.auto_arrange);
    assert_eq!(doc.view.canvas_edit_mode, crate::CanvasEditMode::RequestApproval);
    assert!(!canvas_path(&repo).exists(), "reading must not create the sidecar");

    let _ = fs::remove_dir_all(&repo);
}

// 1.2 — round-trip on a real slug key, and the serde `camelCase` lock. A silent `cam_x`
// rename would make every saved camera unreadable by the TS side, which typechecks fine.
#[test]
fn canvas_write_then_read_round_trips_slug_placement() {
    let repo = canvas_repo("round-trip");
    let doc = doc_with(vec![concept("c_auth")], vec![("login-form", placement(&["c_auth", "c_ui"]))], vec![]);

    write_canvas_doc(&repo, doc.clone()).expect("valid doc writes");

    let bytes = fs::read_to_string(canvas_path(&repo)).expect("sidecar exists after write");
    assert!(bytes.contains("\"camX\""), "view prefs must serialize camelCase: {bytes}");
    assert!(bytes.contains("\"camY\""), "view prefs must serialize camelCase: {bytes}");
    assert!(bytes.contains("\"autoArrange\""), "view prefs must serialize camelCase: {bytes}");
    assert!(bytes.contains("\"canvasEditMode\""), "view prefs must serialize camelCase: {bytes}");

    let back = read_canvas_doc(&repo).expect("written doc reads back");
    let placed = back.placements.get("login-form").expect("slug key survives the round-trip");
    assert_eq!(placed.concepts, vec!["c_auth".to_string(), "c_ui".to_string()]);
    assert!(placed.placed);
    assert_eq!(back.concepts.len(), 1);
    assert_eq!(back.concepts[0].id, "c_auth");

    let _ = fs::remove_dir_all(&repo);
}

// 1.3 — a future schema must not be silently downgraded, and the rejection must not have
// already truncated the good file.
#[test]
fn canvas_rejects_version_2_and_leaves_previous_file() {
    let repo = canvas_repo("version");
    write_canvas_doc(&repo, doc_with(vec![concept("c_keep")], vec![], vec![])).unwrap();
    let before = fs::read(canvas_path(&repo)).unwrap();

    let future = CanvasDoc { version: 2, ..empty_canvas_doc() };
    let err = write_canvas_doc(&repo, future).expect_err("version 2 must be refused");
    assert!(err.contains("version"), "unexpected error: {err}");
    assert_eq!(fs::read(canvas_path(&repo)).unwrap(), before, "a refused write must not touch the previous file");

    let _ = fs::remove_dir_all(&repo);
}

// 1.4 — a concept id is a document key; empty ids collapse membership.
#[test]
fn canvas_rejects_empty_concept_id() {
    let repo = canvas_repo("empty-id");
    let err = write_canvas_doc(&repo, doc_with(vec![concept("")], vec![], vec![])).expect_err("empty concept id must be refused");
    assert!(err.contains("concept"), "unexpected error: {err}");
    assert!(!canvas_path(&repo).exists(), "a refused write must not create the sidecar");
    let _ = fs::remove_dir_all(&repo);
}

// 1.5 — placement keys are task slugs, which are path components elsewhere in the app.
#[test]
fn canvas_rejects_unsafe_placement_key() {
    let repo = canvas_repo("unsafe-key");
    let err = write_canvas_doc(&repo, doc_with(vec![], vec![("../x", placement(&[]))], vec![])).expect_err("traversal key must be refused");
    assert!(err.contains("placement"), "unexpected error: {err}");
    assert!(!canvas_path(&repo).exists());
    let _ = fs::remove_dir_all(&repo);
}

// 1.6 — a self relation has no geometry and would render as a degenerate pipe.
#[test]
fn canvas_rejects_self_relation() {
    let repo = canvas_repo("self-rel");
    let err = write_canvas_doc(&repo, doc_with(vec![], vec![], vec![relation("same", "same", CanvasRelationKind::Informs)])).expect_err("a == b must be refused");
    assert!(err.contains("same task"), "unexpected error: {err}");
    let _ = fs::remove_dir_all(&repo);
}

// 1.7 — a non-finite or non-positive scale divides the camera by zero on load and the
// board never paints again.
#[test]
fn canvas_rejects_invalid_scale() {
    let repo = canvas_repo("scale");
    write_canvas_doc(&repo, doc_with(vec![concept("c_ok")], vec![], vec![])).unwrap();
    let before = fs::read(canvas_path(&repo)).unwrap();

    for bad in [f64::NAN, f64::INFINITY, 0.0, -1.0] {
        let mut doc = empty_canvas_doc();
        doc.view.scale = bad;
        let err = write_canvas_doc(&repo, doc).expect_err("scale must be finite and positive");
        assert!(err.contains("scale"), "unexpected error for {bad}: {err}");
        assert_eq!(fs::read(canvas_path(&repo)).unwrap(), before, "refused write must not touch the previous file");
    }

    let _ = fs::remove_dir_all(&repo);
}

// 1.8 — relations are undirected. Storing direction would show two pipes for one edge.
#[test]
fn canvas_sorts_relation_endpoints() {
    let repo = canvas_repo("sort");
    write_canvas_doc(&repo, doc_with(vec![], vec![], vec![relation("zeta", "alpha", CanvasRelationKind::Blocks)])).unwrap();

    let back = read_canvas_doc(&repo).unwrap();
    assert_eq!(back.relations.len(), 1);
    assert_eq!(back.relations[0].a, "alpha");
    assert_eq!(back.relations[0].b, "zeta");

    let _ = fs::remove_dir_all(&repo);
}

// 1.9 — one kind per pair, last write wins, regardless of endpoint order.
#[test]
fn canvas_last_kind_wins_per_pair() {
    let repo = canvas_repo("last-kind");
    let doc = doc_with(
        vec![],
        vec![],
        vec![
            relation("alpha", "zeta", CanvasRelationKind::Blocks),
            relation("zeta", "alpha", CanvasRelationKind::Surface),
        ],
    );
    write_canvas_doc(&repo, doc).unwrap();

    let back = read_canvas_doc(&repo).unwrap();
    assert_eq!(back.relations.len(), 1, "one relation per pair: {:?}", back.relations);
    assert_eq!(back.relations[0].kind, CanvasRelationKind::Surface);
    assert_eq!(back.relations[0].a, "alpha");
    assert_eq!(back.relations[0].b, "zeta");

    let _ = fs::remove_dir_all(&repo);
}

// 1.10 — a slug absent from the catalog is normal (another branch, an unarchived task, a
// task created on another machine). Dropping it silently deletes the user's placement.
#[test]
fn canvas_keeps_unknown_slug_placement() {
    let repo = canvas_repo("unknown-slug");
    write_canvas_doc(&repo, doc_with(vec![], vec![("ghost-slug", placement(&[]))], vec![])).unwrap();

    let back = read_canvas_doc(&repo).unwrap();
    assert!(back.placements.contains_key("ghost-slug"), "catalog-absent slugs stay on disk");

    let _ = fs::remove_dir_all(&repo);
}

// 1.11 — without an active repo there is no sidecar to write; the command must refuse
// rather than guess a path.
#[test]
fn canvas_write_without_active_repo_does_not_write() {
    let _guard = ACTIVE_REPO_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    set_active_repo_global(None).unwrap();

    let err = write_canvas_in(&AppState::default(), empty_canvas_doc()).expect_err("no active repo must refuse");
    assert!(err.contains("no active repo"), "unexpected error: {err}");
}

// 1.12 — writing is a mutation, so it needs the GUI flock like every other write path.
#[test]
fn canvas_write_without_ownership_does_not_write() {
    let _guard = ACTIVE_REPO_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let repo = canvas_repo("ownership");
    set_active_repo_global(Some(repo.clone())).unwrap();

    let owner = AppState::default();
    assert!(owner.claim_repo(&repo), "owner takes the free repo");

    let guest = AppState::default();
    let err = write_canvas_in(&guest, empty_canvas_doc()).expect_err("a guest window must not write the sidecar");
    assert!(err.contains("repo-busy"), "unexpected error: {err}");
    assert!(!canvas_path(&repo).exists(), "a refused write must not create the sidecar");

    // The owner can write.
    write_canvas_in(&owner, empty_canvas_doc()).expect("owner writes");
    assert!(canvas_path(&repo).exists());

    set_active_repo_global(None).unwrap();
    let _ = fs::remove_dir_all(&repo);
}

// 1.15 — a corrupt sidecar must be an error, not an empty board. Swallowing it shows the
// user a blank canvas and the next write erases their real one.
#[test]
fn canvas_rejects_unparseable_file() {
    let repo = canvas_repo("unparseable");
    fs::write(canvas_path(&repo), b"not json").unwrap();

    let err = read_canvas_doc(&repo).expect_err("a corrupt sidecar must not read as empty");
    assert!(err.contains("canvas.json"), "the error should name the file: {err}");

    let _ = fs::remove_dir_all(&repo);
}

// 1.16 — an object with no version is not a version-1 document.
#[test]
fn canvas_rejects_missing_version() {
    let repo = canvas_repo("no-version");
    fs::write(
        canvas_path(&repo),
        br#"{"concepts":[],"placements":{},"relations":[],"view":{"camX":0,"camY":0,"scale":1,"autoArrange":false}}"#,
    )
    .unwrap();

    read_canvas_doc(&repo).expect_err("a document without a version must be refused");

    let _ = fs::remove_dir_all(&repo);
}

// 1.17 — duplicate ids make membership ambiguous: two hulls answer to one tag.
#[test]
fn canvas_rejects_duplicate_concept_ids() {
    let repo = canvas_repo("dup-id");
    let err = write_canvas_doc(&repo, doc_with(vec![concept("c_same"), concept("c_same")], vec![], vec![])).expect_err("duplicate ids must be refused");
    assert!(err.contains("duplicate"), "unexpected error: {err}");
    assert!(!canvas_path(&repo).exists());
    let _ = fs::remove_dir_all(&repo);
}

// 1.18 — an unknown kind on disk is refused by the serde enum, not coerced to a default.
#[test]
fn canvas_rejects_unknown_relation_kind() {
    let repo = canvas_repo("bad-kind");
    fs::write(
        canvas_path(&repo),
        br#"{"version":1,"concepts":[],"placements":{},"relations":[{"a":"one","b":"two","kind":"wat"}],"view":{"camX":0,"camY":0,"scale":1,"autoArrange":false}}"#,
    )
    .unwrap();

    read_canvas_doc(&repo).expect_err("an unknown relation kind must be refused");

    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn canvas_omitted_edit_mode_defaults_to_request_approval() {
    let repo = canvas_repo("omitted-mode");
    let bytes = br#"{"version":1,"concepts":[],"placements":{},"relations":[],"view":{"camX":0,"camY":0,"scale":1,"autoArrange":false}}"#;
    fs::write(canvas_path(&repo), bytes).unwrap();

    let doc = read_canvas_doc(&repo).expect("a sidecar written before canvasEditMode still loads");
    assert_eq!(doc.view.canvas_edit_mode, crate::CanvasEditMode::RequestApproval);
    assert_eq!(fs::read(canvas_path(&repo)).unwrap(), bytes, "a bare read must not rewrite");

    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn canvas_round_trips_auto_edit_mode() {
    let repo = canvas_repo("auto-edit");
    let mut doc = empty_canvas_doc();
    doc.view.canvas_edit_mode = crate::CanvasEditMode::AutoEdit;
    write_canvas_doc(&repo, doc).unwrap();

    let bytes = fs::read_to_string(canvas_path(&repo)).unwrap();
    assert!(bytes.contains("\"autoEdit\""), "enum must serialize camelCase: {bytes}");
    assert_eq!(read_canvas_doc(&repo).unwrap().view.canvas_edit_mode, crate::CanvasEditMode::AutoEdit);

    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn canvas_round_trips_read_only_mode() {
    let repo = canvas_repo("read-only");
    let mut doc = empty_canvas_doc();
    doc.view.canvas_edit_mode = crate::CanvasEditMode::ReadOnly;
    write_canvas_doc(&repo, doc).unwrap();

    let bytes = fs::read_to_string(canvas_path(&repo)).unwrap();
    assert!(bytes.contains("\"readOnly\""), "enum must serialize camelCase: {bytes}");
    assert_eq!(read_canvas_doc(&repo).unwrap().view.canvas_edit_mode, crate::CanvasEditMode::ReadOnly);

    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn canvas_rejects_unknown_edit_mode() {
    let repo = canvas_repo("bad-mode");
    fs::write(
        canvas_path(&repo),
        br#"{"version":1,"concepts":[],"placements":{},"relations":[],"view":{"camX":0,"camY":0,"scale":1,"autoArrange":false,"canvasEditMode":"yolo"}}"#,
    )
    .unwrap();

    read_canvas_doc(&repo).expect_err("an unknown canvasEditMode must be refused");

    let _ = fs::remove_dir_all(&repo);
}

// 1.19 — relation endpoints are slugs too.
#[test]
fn canvas_rejects_unsafe_relation_endpoint() {
    let repo = canvas_repo("unsafe-endpoint");
    let err = write_canvas_doc(&repo, doc_with(vec![], vec![], vec![relation("../x", "ok", CanvasRelationKind::Blocks)])).expect_err("traversal endpoint must be refused");
    assert!(err.contains("relation"), "unexpected error: {err}");
    assert!(!canvas_path(&repo).exists());
    let _ = fs::remove_dir_all(&repo);
}

// 1.20 — non-finite hull or card geometry poisons every hit-test and cull comparison.
#[test]
fn canvas_rejects_non_finite_geometry() {
    let repo = canvas_repo("geometry");

    let mut bad_hull = concept("c_nan");
    bad_hull.w = f64::NAN;
    let err = write_canvas_doc(&repo, doc_with(vec![bad_hull], vec![], vec![])).expect_err("NaN hull size must be refused");
    assert!(err.contains("concept"), "unexpected error: {err}");

    let mut bad_card = placement(&[]);
    bad_card.x = f64::INFINITY;
    let err = write_canvas_doc(&repo, doc_with(vec![], vec![("login-form", bad_card)], vec![])).expect_err("infinite card position must be refused");
    assert!(err.contains("placement"), "unexpected error: {err}");

    assert!(!canvas_path(&repo).exists());
    let _ = fs::remove_dir_all(&repo);
}

// Cross-language contract. `05-tdd.md` (3.1) notes that nothing compares the TS
// `emptyCanvasDoc()` / document shape with the Rust one — the two are kept in sync by review,
// which is exactly the kind of agreement that rots silently: a renamed field typechecks on
// both sides and only fails at runtime, as "the board is empty again".
//
// So this is the real thing: the literal bytes a composed frontend session emitted
// (`canvas/ids.ts` + `pack.ts` + `arrange.ts` + `pipes.ts`, driven end to end), pasted here
// verbatim. Rust must read it without loss and write it back unchanged.
#[test]
fn canvas_reads_a_frontend_authored_document() {
    let repo = canvas_repo("frontend-doc");
    let authored = r#"{
  "version": 1,
  "concepts": [
    { "id": "c_api", "name": "API surface", "x": 472, "y": 0, "w": 260, "h": 140, "manual": true }
  ],
  "placements": {
    "login-form": { "concepts": [], "x": 16, "y": 52, "placed": false },
    "token-refresh": { "concepts": [], "x": 228, "y": 52, "placed": false },
    "api-audit": { "concepts": [], "x": 616, "y": 52, "placed": true }
  },
  "relations": [
    { "a": "api-audit", "b": "login-form", "kind": "blocks" },
    { "a": "login-form", "b": "token-refresh", "kind": "informs" }
  ],
  "view": { "camX": 0, "camY": 0, "scale": 1, "autoArrange": false, "canvasEditMode": "requestApproval" }
}
"#;
    fs::write(canvas_path(&repo), authored).unwrap();

    let doc = read_canvas_doc(&repo).expect("a document the frontend wrote must load");
    assert_eq!(doc.concepts.len(), 1);
    assert_eq!(doc.concepts[0].id, "c_api");
    assert!(doc.concepts[0].manual);
    assert_eq!(doc.view.cam_x, 0.0);
    assert_eq!(doc.view.scale, 1.0);
    assert!(!doc.view.auto_arrange);
    assert_eq!(doc.view.canvas_edit_mode, crate::CanvasEditMode::RequestApproval);
    // Unplaced rows survive: a hull the user deleted leaves its members' positions behind.
    assert!(!doc.placements["login-form"].placed);
    assert!(doc.placements["api-audit"].placed);
    assert_eq!(doc.placements["token-refresh"].x, 228.0);
    assert_eq!(doc.relations.len(), 2);
    assert_eq!(doc.relations[0].kind, CanvasRelationKind::Blocks);
    assert_eq!(doc.relations[1].kind, CanvasRelationKind::Informs);

    // Re-serializing is a no-op on content: a load/save cycle must not drift the document.
    write_canvas_doc(&repo, doc.clone()).expect("round-trip write");
    assert_eq!(read_canvas_doc(&repo).unwrap(), doc);

    let _ = fs::remove_dir_all(&repo);
}

// 6.8 — archiving a task must not disturb its placement. The card stays on the board,
// grayed; dropping the row here would silently lose the position the user chose.
//
// Scope: `archive_task_in` takes `&AppHandle<Wry>` for the pre-archive backup and the
// telemetry emit, and a `MockRuntime` handle is a different type — no unit test in this
// crate can call it. So this drives the half that touches the repo, the `read_task` /
// `archived = true` / `write_task` flip that `archive_task_in` performs, and pins that
// neither `write_task` nor `read_canvas_doc` prunes the sidecar. The two AppHandle-bound
// steps cannot remove a placement: the backup *includes* `canvas.json` (1.13) and the
// telemetry emit writes no repo state.
#[test]
fn canvas_archive_does_not_drop_placement() {
    let _guard = ACTIVE_REPO_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let repo = init_git_test_repo("canvas-archive");
    alinery_core::ensure_playbooks(&repo).unwrap();
    set_active_repo_global(Some(repo.clone())).unwrap();

    let task = create_task_for_test(&repo, "Archive Keeps Placement", false, "", "");
    write_canvas_doc(&repo, doc_with(vec![concept("c_auth")], vec![(task.slug.as_str(), placement(&["c_auth"]))], vec![])).unwrap();
    let before = fs::read(canvas_path(&repo)).unwrap();

    let mut archived = read_task(&repo, &task.slug).unwrap();
    archived.archived = true;
    write_task(&repo, &archived).unwrap();

    assert!(read_task(&repo, &task.slug).unwrap().archived, "the task is archived");
    assert_eq!(fs::read(canvas_path(&repo)).unwrap(), before, "archiving a task must not rewrite the sidecar");

    let back = read_canvas_doc(&repo).unwrap();
    let placed = back.placements.get(&task.slug).expect("archive must keep the placement row");
    assert!(placed.placed, "the card stays on the board");
    assert_eq!(placed.concepts, vec!["c_auth".to_string()]);

    set_active_repo_global(None).unwrap();
    let _ = fs::remove_dir_all(&repo);
}
