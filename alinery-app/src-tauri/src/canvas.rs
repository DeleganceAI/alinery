//! canvas: the Orbitron View spatial sidecar. See AGENTS.md for the module map.
//!
//! `.alinery/canvas.json` is Alinery-local spatial state — concepts (abstract tags with
//! geometry), which task sits where, undirected relations, and the camera. It is a sidecar
//! on purpose: `task.md` gains no field, so a task's identity and its position on a board
//! stay separable, and a repo that never opens Orbitron never grows the file.
//!
//! The join key is `Task.slug`. Placement keys and relation endpoints are therefore slugs,
//! which are path components elsewhere in the app, so they go through `safe_component`.
//!
//! Rust validates and normalizes; it never invents layout. Membership and packing are the
//! frontend's business, and a slug that is absent from the current catalog is kept — it may
//! belong to another branch or another machine, and dropping it would delete a placement
//! the user chose.
use crate::*;

/// Task slug — the join key between this sidecar and `.alinery/tasks/<slug>/task.md`.
pub(crate) type TaskId = String;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum CanvasRelationKind {
    Blocks,
    /// "same surface" in the UI; `surface` on disk.
    Surface,
    Informs,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct CanvasConcept {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) w: f64,
    pub(crate) h: f64,
    /// The user sized this hull by hand: packing may grow it, never shrink it.
    pub(crate) manual: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct CanvasPlacement {
    /// Concept tags. `concepts[0]` is the primary placement (which hull holds the card);
    /// the rest are chips only. Never a source of duplicate cards.
    pub(crate) concepts: Vec<String>,
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) placed: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub(crate) struct CanvasRelation {
    pub(crate) a: TaskId,
    pub(crate) b: TaskId,
    pub(crate) kind: CanvasRelationKind,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CanvasEditMode {
    AutoEdit,
    ReadOnly,
    #[default]
    RequestApproval,
}
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CanvasViewPrefs {
    pub(crate) cam_x: f64,
    pub(crate) cam_y: f64,
    pub(crate) scale: f64,
    pub(crate) auto_arrange: bool,
    #[serde(default)]
    pub(crate) canvas_edit_mode: CanvasEditMode,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct CanvasDoc {
    pub(crate) version: u32,
    pub(crate) concepts: Vec<CanvasConcept>,
    /// BTreeMap so the written JSON is stable: a rewrite that only reorders keys would
    /// otherwise churn git diffs and the backup archive.
    pub(crate) placements: BTreeMap<TaskId, CanvasPlacement>,
    pub(crate) relations: Vec<CanvasRelation>,
    pub(crate) view: CanvasViewPrefs,
}

pub(crate) const CANVAS_DOC_VERSION: u32 = 1;

pub(crate) fn canvas_path(repo: &Path) -> PathBuf {
    alinery_dir(repo).join("canvas.json")
}

pub(crate) fn empty_canvas_doc() -> CanvasDoc {
    CanvasDoc {
        version: CANVAS_DOC_VERSION,
        concepts: Vec::new(),
        placements: BTreeMap::new(),
        relations: Vec::new(),
        view: CanvasViewPrefs {
            cam_x: 0.0,
            cam_y: 0.0,
            scale: 1.0,
            auto_arrange: false,
            canvas_edit_mode: CanvasEditMode::RequestApproval,
        },
    }
}

/// Missing file ⇒ empty board, and no file is created: this runs on every mount.
///
/// A file that exists but does not parse or does not validate is an **error**, never an
/// empty board — a blank canvas followed by a save is how a corrupt sidecar turns into a
/// lost one.
pub(crate) fn read_canvas_doc(repo: &Path) -> Result<CanvasDoc, String> {
    let path = canvas_path(repo);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(empty_canvas_doc()),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    let mut doc: CanvasDoc = serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", path.display()))?;
    validate_and_normalize(&mut doc).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(doc)
}

/// Validate, normalize, then write atomically. Validation runs first so a refused write
/// leaves the previous board exactly as it was.
pub(crate) fn write_canvas_doc(repo: &Path, mut doc: CanvasDoc) -> Result<(), String> {
    validate_and_normalize(&mut doc)?;
    let bytes = serde_json::to_vec_pretty(&doc).map_err(|e| format!("serialize canvas doc: {e}"))?;
    write_bytes_atomic(&canvas_path(repo), &bytes)
}

fn finite(v: f64) -> bool {
    v.is_finite()
}

fn validate_and_normalize(doc: &mut CanvasDoc) -> Result<(), String> {
    if doc.version != CANVAS_DOC_VERSION {
        return Err(format!("unsupported canvas version {} (expected {CANVAS_DOC_VERSION})", doc.version));
    }

    let mut ids: HashSet<&str> = HashSet::with_capacity(doc.concepts.len());
    for c in &doc.concepts {
        if alinery_core::safe_component(&c.id).is_none() {
            return Err(format!("unsafe concept id {:?}", c.id));
        }
        if !ids.insert(c.id.as_str()) {
            return Err(format!("duplicate concept id {:?}", c.id));
        }
        if !(finite(c.x) && finite(c.y) && finite(c.w) && finite(c.h)) {
            return Err(format!("concept {:?} has non-finite geometry", c.id));
        }
    }

    for (slug, p) in doc.placements.iter() {
        if alinery_core::safe_component(slug).is_none() {
            return Err(format!("unsafe placement key {slug:?}"));
        }
        if !(finite(p.x) && finite(p.y)) {
            return Err(format!("placement {slug:?} has non-finite position"));
        }
    }

    normalize_relations(doc)?;

    let v = &doc.view;
    if !(finite(v.cam_x) && finite(v.cam_y)) {
        return Err("camera position must be finite".into());
    }
    if !finite(v.scale) || v.scale <= 0.0 {
        return Err(format!("camera scale must be finite and positive, got {}", v.scale));
    }
    Ok(())
}

/// Relations are undirected: endpoints are sorted, and one pair carries at most one kind.
/// Last write wins so re-picking a kind in the UI replaces rather than accumulates.
fn normalize_relations(doc: &mut CanvasDoc) -> Result<(), String> {
    let mut out: Vec<CanvasRelation> = Vec::with_capacity(doc.relations.len());
    let mut seen: HashMap<(String, String), usize> = HashMap::with_capacity(doc.relations.len());

    for r in doc.relations.drain(..) {
        if alinery_core::safe_component(&r.a).is_none() || alinery_core::safe_component(&r.b).is_none() {
            return Err(format!("unsafe relation endpoint {:?}..{:?}", r.a, r.b));
        }
        if r.a == r.b {
            return Err(format!("relation {:?} joins the same task to itself", r.a));
        }
        let (a, b) = if r.a <= r.b { (r.a, r.b) } else { (r.b, r.a) };
        match seen.get(&(a.clone(), b.clone())) {
            Some(&at) => out[at].kind = r.kind,
            None => {
                seen.insert((a.clone(), b.clone()), out.len());
                out.push(CanvasRelation { a, b, kind: r.kind });
            }
        }
    }

    doc.relations = out;
    Ok(())
}

// ---- Commands -----------------------------------------------------------------
// Active repo only. Reading is a status-shaped operation (like `list_board_tasks`) and
// claims nothing; writing is a mutation and needs the GUI flock.

#[tauri::command]
pub(crate) fn read_canvas() -> Result<CanvasDoc, String> {
    read_canvas_doc(&active_repo()?)
}

pub(crate) fn write_canvas_in(state: &AppState, doc: CanvasDoc) -> Result<(), String> {
    let repo = require_owned_active_repo(state)?;
    write_canvas_doc(&repo, doc)
}

#[tauri::command]
pub(crate) fn write_canvas(state: State<'_, AppState>, doc: CanvasDoc) -> Result<(), String> {
    write_canvas_in(&state, doc)
}
