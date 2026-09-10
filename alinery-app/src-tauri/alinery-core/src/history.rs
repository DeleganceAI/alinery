use crate::{alinery_dir, read_task, safe_component, session_meta_path, session_omp_dir, sessions_dir, SessionMeta};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

pub const HISTORY_REPLAY_BYTES: u64 = 8 * 1024 * 1024;
pub const HISTORY_WINDOW_MAX: u64 = 1024 * 1024;

/// One backward page of an OMP journal. Sized to cover a screenful of conversation in one
/// round trip; `read_omp_window` widens it on demand when a single row is larger.
pub const OMP_WINDOW_DEFAULT: u64 = 256 * 1024;

/// Ceiling on the widening in `read_omp_window`. Without it a single newline-free row makes one
/// page the journal's whole prefix, in the backend buffer, the IPC response and the webview alike.
// ponytail: 8 MiB cap, raise if real journals carry single rows larger than this
pub const OMP_WINDOW_MAX: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HistoryMode {
    Screen,
    Raw,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionHistoryResult {
    pub task_slug: String,
    pub session_id: String,
    pub mode: HistoryMode,
    pub data: Vec<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub length: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eof: Option<bool>,
}

#[derive(Debug)]
struct HistoryPart {
    path: PathBuf,
    start: u64,
    len: u64,
}

fn history_chunk_index(path: &Path) -> Option<u64> {
    match path.extension().and_then(|value| value.to_str()) {
        None => path.file_name()?.to_str()?.parse().ok(),
        Some(_) => None,
    }
}

/// A regular file, following no link. `Path::is_file` follows symlinks, which is the whole hole:
/// `.alinery/` lives inside the repository, so a clone can carry a scrollback — or a chunk inside
/// one — as a git symlink (mode 120000) aimed anywhere the process can read.
fn is_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file())
}

fn history_parts(path: &Path) -> Result<(Vec<HistoryPart>, u64), String> {
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_symlink()) {
        return Err(format!("history path is a symlink: {}", path.display()));
    }
    if !path.is_dir() {
        let len = fs::metadata(path).map(|metadata| metadata.len()).unwrap_or(0);
        return Ok((
            vec![HistoryPart {
                path: path.to_path_buf(),
                start: 0,
                len,
            }],
            len,
        ));
    }

    let mut chunks = Vec::new();
    for entry in fs::read_dir(path).map_err(|error| format!("read {}: {error}", path.display()))? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if !is_regular_file(&path) {
            continue;
        }
        let Some(index) = history_chunk_index(&path) else {
            continue;
        };
        chunks.push((index, path));
    }
    chunks.sort_by_key(|(index, _)| *index);

    let mut start = 0u64;
    let mut parts = Vec::with_capacity(chunks.len());
    for (_, path) in chunks {
        let len = fs::metadata(&path).map(|metadata| metadata.len()).unwrap_or(0);
        parts.push(HistoryPart { path, start, len });
        start = start.saturating_add(len);
    }
    Ok((parts, start))
}

fn read_open_window(file: &mut fs::File, offset: u64, limit: u64) -> Vec<u8> {
    if file.seek(SeekFrom::Start(offset)).is_err() {
        return Vec::new();
    }
    let mut data = Vec::new();
    let _ = file.take(limit).read_to_end(&mut data);
    data
}

fn read_file_window(path: &Path, offset: u64, limit: u64) -> Vec<u8> {
    let Ok(mut file) = fs::File::open(path) else {
        return Vec::new();
    };
    if file.seek(SeekFrom::Start(offset)).is_err() {
        return Vec::new();
    }
    let mut data = Vec::new();
    let _ = file.take(limit).read_to_end(&mut data);
    data
}

fn read_parts_window(parts: &[HistoryPart], offset: u64, limit: u64) -> Vec<u8> {
    let mut remaining = limit;
    let mut data = Vec::new();
    for part in parts {
        if remaining == 0 {
            break;
        }
        let end = part.start.saturating_add(part.len);
        if offset >= end {
            continue;
        }
        let local_offset = offset.saturating_sub(part.start);
        let available = part.len.saturating_sub(local_offset);
        let bytes = read_file_window(&part.path, local_offset, remaining.min(available));
        remaining = remaining.saturating_sub(bytes.len() as u64);
        data.extend(bytes);
    }
    data
}

fn validate_owned_session(repo: &Path, task_slug: &str, session_id: &str) -> Result<PathBuf, String> {
    safe_component(task_slug).ok_or_else(|| format!("invalid task_slug '{task_slug}'"))?;
    safe_component(session_id).ok_or_else(|| format!("invalid session_id '{session_id}'"))?;
    read_task(repo, task_slug).ok_or_else(|| format!("read task {task_slug}: missing task.md"))?;
    let meta_path = session_meta_path(repo, task_slug, session_id);
    let raw = fs::read_to_string(&meta_path).map_err(|error| format!("read {}: {error}", meta_path.display()))?;
    let meta: SessionMeta = serde_json::from_str(&raw).map_err(|error| format!("parse {}: {error}", meta_path.display()))?;
    if meta.id != session_id {
        return Err(format!("session metadata id '{}' does not match '{session_id}'", meta.id));
    }
    let history = sessions_dir(repo, task_slug).join(format!("{session_id}.scrollback"));
    // Containment, which this function never checked: the meta proves ownership of the session,
    // not that the scrollback beside it still resolves inside `.alinery`. A session that has
    // never written one is the normal early state, so a missing path is not an error.
    if let Ok(resolved) = fs::canonicalize(&history) {
        let root = fs::canonicalize(alinery_dir(repo)).map_err(|error| format!("canonicalize alinery dir: {error}"))?;
        if !resolved.starts_with(&root) {
            return Err(format!("session history escapes the repo: {}", resolved.display()));
        }
    }
    Ok(history)
}

/// A backward page of an OMP session journal. `data` begins at a row boundary, so the caller can
/// split on newlines without stitching pages together — the one exception being a row larger than
/// `OMP_WINDOW_MAX`, where the page opens mid-row and the leading fragment is the caller's to drop.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OmpWindow {
    /// Byte offset of the first row in `data`. Zero means this page reaches the start of the file.
    pub start: u64,
    /// Byte offset just past the last row in `data`. Pass it back as `end` to page further back.
    pub end: u64,
    /// Total size of the journal, so a caller can tell a short page from the end of the file.
    pub length: u64,
    pub data: Vec<u8>,
}

/// The journal for a session, chosen by FILENAME rather than mtime.
///
/// OMP names journals `<iso-timestamp>_<uuidv7>.jsonl` — both halves monotonic, so lexical order
/// is chronological. mtime is not a usable signal here: `updateSessionTitle` rewrites the
/// fixed-width 256-byte title record in place, which touches mtime without adding any
/// conversation content.
///
/// `--resume` appends to the journal it is given, so a resumed session keeps one growing file and
/// there is nothing to concatenate. A second file in the same dir means an unrelated fresh
/// session landed there (see `restate_without_jsonl_passes_session_dir_only`), and splicing that
/// in would join two different conversations — so take the newest and only the newest.
pub fn newest_omp_jsonl(dir: &Path) -> Option<PathBuf> {
    let mut best: Option<PathBuf> = None;
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }
        // symlink_metadata, not `path.is_file()`: that one follows the link, so a `.jsonl` symlink
        // dropped into an otherwise valid session dir would hand any file the process can read
        // straight to the webview. The dir is contained (see `validate_omp_session`); its children
        // have to be too. A hard link passes that check — it IS the file, so no path-based test
        // can place it — and macOS has no protected_hardlinks, so a process that cannot read a
        // file can still link it in here and have Alinery read it out. OMP writes each journal
        // once, so a link count above one is not a journal we wrote.
        // ponytail: nlink is the cheap proxy; if a real journal ever legitimately gains a link,
        // compare (dev, ino) against a handle opened inside the verified dir instead.
        if !fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.is_file() && metadata.nlink() == 1) {
            continue;
        }
        if best.as_ref().is_none_or(|saved| saved.file_name() < path.file_name()) {
            best = Some(path);
        }
    }
    best
}

/// Ownership gate for the OMP journal.
///
/// Deliberately not `validate_owned_session`: that one rejects every taskless session
/// (`safe_component("")` is None), demands a `task.md` a root session cannot have, and resolves
/// the task-branch directory unconditionally. Here the session's own meta is the ownership proof,
/// and the session DIR is containment-checked after canonicalization so it cannot point out of the
/// repo. That covers the dir and nothing below it — the journal inside is a separate symlink
/// question, answered in `newest_omp_jsonl`.
fn validate_omp_session(repo: &Path, task_slug: &str, session_id: &str) -> Result<PathBuf, String> {
    if !task_slug.is_empty() {
        safe_component(task_slug).ok_or_else(|| format!("invalid task_slug '{task_slug}'"))?;
    }
    safe_component(session_id).ok_or_else(|| format!("invalid session_id '{session_id}'"))?;
    let meta_path = session_meta_path(repo, task_slug, session_id);
    let raw = fs::read_to_string(&meta_path).map_err(|error| format!("read {}: {error}", meta_path.display()))?;
    let meta: SessionMeta = serde_json::from_str(&raw).map_err(|error| format!("parse {}: {error}", meta_path.display()))?;
    if meta.id != session_id {
        return Err(format!("session metadata id '{}' does not match '{session_id}'", meta.id));
    }
    let dir = session_omp_dir(repo, task_slug, session_id);
    let Ok(resolved) = fs::canonicalize(&dir) else {
        // No .omp dir at all. OMP creates it at spawn but writes nothing until its first
        // assistant message, so this is a normal early-session state, not an error.
        return Ok(dir);
    };
    let root = fs::canonicalize(alinery_dir(repo)).map_err(|error| format!("canonicalize alinery dir: {error}"))?;
    if !resolved.starts_with(&root) {
        return Err(format!("session dir escapes the repo: {}", resolved.display()));
    }
    Ok(resolved)
}

/// Read the rows ending at `end`, covering roughly `want` bytes backward.
///
/// Pass `end = None` for the tail of the journal, then feed each result's `start` back as the next
/// `end` to walk backward a page at a time. An empty result with `length == 0` means the session
/// has no journal yet.
pub fn read_omp_window(repo: &Path, task_slug: &str, session_id: &str, end: Option<u64>, want: Option<u64>) -> Result<OmpWindow, String> {
    let dir = validate_omp_session(repo, task_slug, session_id)?;
    let Some(path) = newest_omp_jsonl(&dir) else {
        return Ok(OmpWindow {
            start: 0,
            end: 0,
            length: 0,
            data: Vec::new(),
        });
    };
    // One handle for the stat and every window read. Re-opening per read let the verified path be
    // swapped for a symlink in between, so the checks above described a file we then did not read.
    let mut file = fs::File::open(&path).map_err(|error| format!("read {}: {error}", path.display()))?;
    let length = file.metadata().map_err(|error| format!("read {}: {error}", path.display()))?.len();
    let end = end.unwrap_or(length).min(length);
    let mut want = want.unwrap_or(OMP_WINDOW_DEFAULT).clamp(1, OMP_WINDOW_MAX);

    loop {
        let from = end.saturating_sub(want);
        let buf = read_open_window(&mut file, from, end.saturating_sub(from));
        if from == 0 {
            return Ok(OmpWindow { start: 0, end, length, data: buf });
        }
        // The window's last byte is the newline terminating its own final row. Treating that as a
        // row boundary would return an empty page forever, so it is never scanned.
        let scan = buf.len().saturating_sub(1);
        if let Some(index) = buf[..scan].iter().position(|&byte| byte == b'\n') {
            let start = from.saturating_add(index as u64).saturating_add(1);
            return Ok(OmpWindow {
                start,
                end,
                length,
                data: buf[index + 1..].to_vec(),
            });
        }
        if want >= OMP_WINDOW_MAX {
            // A single row larger than the cap. Return the capped bytes rather than widening to
            // the file's whole prefix: `data` then opens mid-row, and the decoder drops a row it
            // cannot parse (see `ompFile.ts`), so the page costs that one row instead of the
            // journal's entire prefix in memory. Paging back from `start` resyncs on the next
            // newline, so nothing after the oversized row is lost.
            return Ok(OmpWindow {
                start: from,
                end,
                length,
                data: buf,
            });
        }
        // One row is larger than the whole window — compaction rows reach megabytes. Widen until
        // a boundary appears, or until `from` reaches 0 and the page is the file's whole prefix.
        want = want.saturating_mul(2).min(OMP_WINDOW_MAX);
    }
}

pub fn read_session_history(repo: &Path, task_slug: &str, session_id: &str, offset: Option<u64>, limit: Option<u64>) -> Result<SessionHistoryResult, String> {
    if offset.is_some() != limit.is_some() {
        return Err("offset and limit must be provided together".into());
    }
    let history_path = validate_owned_session(repo, task_slug, session_id)?;
    let (parts, length) = history_parts(&history_path)?;

    if let (Some(offset), Some(requested_limit)) = (offset, limit) {
        let limit = requested_limit.min(HISTORY_WINDOW_MAX);
        let data = read_parts_window(&parts, offset, limit);
        let next_offset = offset.saturating_add(data.len() as u64);
        return Ok(SessionHistoryResult {
            task_slug: task_slug.to_string(),
            session_id: session_id.to_string(),
            mode: HistoryMode::Raw,
            data,
            offset: Some(offset),
            limit: Some(limit),
            length: Some(length),
            next_offset: Some(next_offset),
            eof: Some(next_offset >= length),
        });
    }

    let tail_start = length.saturating_sub(HISTORY_REPLAY_BYTES);
    let bytes = read_parts_window(&parts, tail_start, HISTORY_REPLAY_BYTES);
    let data = if bytes.is_empty() {
        Vec::new()
    } else {
        let mut parser = vt100::Parser::new(40, 120, 0);
        parser.process(&bytes);
        let screen = parser.screen();
        let mut frame = Vec::new();
        if screen.alternate_screen() {
            frame.extend_from_slice(b"\x1b[?1049h");
        }
        frame.extend_from_slice(&screen.state_formatted());
        frame
    };
    Ok(SessionHistoryResult {
        task_slug: task_slug.to_string(),
        session_id: session_id.to_string(),
        mode: HistoryMode::Screen,
        data,
        offset: None,
        limit: None,
        length: None,
        next_offset: None,
        eof: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{task_dir, Task};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    // An .omp journal dir for the `s1` session `fixture` already registers.
    fn omp_fixture(name: &str, files: &[(&str, &str)]) -> PathBuf {
        let (repo, _) = fixture(name);
        let dir = session_omp_dir(&repo, "task", "s1");
        fs::create_dir_all(&dir).unwrap();
        for (filename, body) in files {
            fs::write(dir.join(filename), body).unwrap();
        }
        repo
    }

    fn row(id: &str, text: &str) -> String {
        format!("{{\"type\":\"message\",\"id\":\"{id}\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"{text}\"}}]}}}}\n")
    }

    fn ids(data: &[u8]) -> Vec<String> {
        String::from_utf8_lossy(data)
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                serde_json::from_str::<serde_json::Value>(line)
                    .expect("every returned row parses")
                    .get("id")
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect()
    }

    // OMP names journals `<timestamp>_<uuidv7>.jsonl`, both monotonic. mtime is not usable:
    // updateSessionTitle rewrites the 256-byte title record in place, touching mtime without
    // adding conversation content. Here the lexically-newer file is written FIRST, so its mtime
    // is the older of the two — picking by mtime would choose wrong.
    #[test]
    fn newest_journal_is_chosen_by_filename_not_mtime() {
        let repo = omp_fixture(
            "omp_window_newest",
            &[
                ("2026-02-01T00-00-00Z_b.jsonl", &row("new", "second")),
                ("2026-01-01T00-00-00Z_a.jsonl", &row("old", "first")),
            ],
        );
        let window = read_omp_window(&repo, "task", "s1", None, None).unwrap();
        assert_eq!(ids(&window.data), vec!["new"], "the lexically newest journal wins even though it was written first");
    }

    #[test]
    fn a_window_never_begins_mid_row() {
        let body: String = (0..40).map(|i| row(&format!("r{i}"), &"x".repeat(200))).collect();
        let repo = omp_fixture("omp_window_boundary", &[("2026-01-01T00-00-00Z_a.jsonl", &body)]);
        let window = read_omp_window(&repo, "task", "s1", None, Some(1024)).unwrap();
        assert!(window.start > 0, "a 1 KiB window cannot reach the start of an 8 KiB journal");
        assert!(!window.data.is_empty());
        // The proof: every returned line parses. A mid-row start would produce a fragment.
        let returned = ids(&window.data);
        assert_eq!(returned.last().unwrap(), "r39", "a tail window ends at the last row");
    }

    // Paging backward must tile the file exactly: no gaps, no repeats.
    #[test]
    fn backward_pages_are_disjoint_and_cover_every_row() {
        let body: String = (0..60).map(|i| row(&format!("r{i}"), &"y".repeat(150))).collect();
        let repo = omp_fixture("omp_window_paging", &[("2026-01-01T00-00-00Z_a.jsonl", &body)]);
        let mut seen: Vec<String> = Vec::new();
        let mut cursor = None;
        loop {
            let window = read_omp_window(&repo, "task", "s1", cursor, Some(900)).unwrap();
            let mut page = ids(&window.data);
            page.extend(seen);
            seen = page;
            if window.start == 0 {
                break;
            }
            cursor = Some(window.start);
        }
        let expected: Vec<String> = (0..60).map(|i| format!("r{i}")).collect();
        assert_eq!(seen, expected, "backward paging tiles the journal with no gap and no repeat");
    }

    // The deadlock the review caught: a compaction row can be megabytes. If the boundary scan
    // looks at the window's own terminating newline it returns an empty page, forever.
    #[test]
    fn a_row_larger_than_the_window_still_returns() {
        let body = format!("{}{}", row("small", "a"), row("huge", &"z".repeat(400_000)));
        let repo = omp_fixture("omp_window_huge", &[("2026-01-01T00-00-00Z_a.jsonl", &body)]);
        let window = read_omp_window(&repo, "task", "s1", None, Some(4096)).unwrap();
        // Widening never finds a boundary inside the huge row, so it walks out to the start of the
        // file and returns the whole prefix. What matters is that it TERMINATES and that the
        // oversized row comes back intact rather than as a fragment or an empty page.
        assert_eq!(ids(&window.data), vec!["small", "huge"]);
        assert_eq!(window.start, 0);
        assert!(window.data.len() > 400_000, "the oversized row is returned whole");
    }

    // Past the cap the page stops widening. It then opens mid-row, which the decoder handles by
    // skipping the unparseable leading fragment (see `ompFile.ts`).
    #[test]
    fn a_row_larger_than_the_cap_returns_a_bounded_page() {
        let body = format!("{}{}", row("small", "a"), row("huge", &"z".repeat(OMP_WINDOW_MAX as usize)));
        let repo = omp_fixture("omp_window_capped", &[("2026-01-01T00-00-00Z_a.jsonl", &body)]);
        let window = read_omp_window(&repo, "task", "s1", None, None).unwrap();
        assert!(window.start > 0, "the cap stops the widening short of the file start");
        assert_eq!(window.data.len() as u64, OMP_WINDOW_MAX, "the page is exactly the cap, not the whole prefix");
        assert_eq!(window.length, body.len() as u64);
        fs::remove_dir_all(repo).unwrap();
    }

    // A `.jsonl` symlink in an otherwise valid session dir would let the command read any file the
    // process can, and ship it to the webview. The dir is containment-checked; its children are not.
    #[test]
    fn a_symlinked_scrollback_chunk_is_not_read() {
        // Same class as the journal symlink, and the same delivery: `.alinery/` is inside the
        // repository, so a clone can carry this chunk as a git symlink.
        let (repo, history) = fixture("alinery_history_symlink_chunk");
        fs::create_dir_all(&history).unwrap();
        fs::write(history.join("1"), [1, 2, 3]).unwrap();
        let outside = std::env::temp_dir().join(format!("alinery_history_secret_{}", std::process::id()));
        fs::write(&outside, b"outside the repo").unwrap();
        std::os::unix::fs::symlink(&outside, history.join("2")).unwrap();

        let result = read_session_history(&repo, "task", "s1", Some(0), Some(64)).unwrap();
        assert_eq!(result.data, vec![1, 2, 3], "the symlinked chunk is skipped, not followed");
        fs::remove_file(outside).unwrap();
        fs::remove_dir_all(repo).unwrap();
    }

    #[test]
    fn a_symlinked_scrollback_is_refused_outright() {
        let (repo, history) = fixture("alinery_history_symlink_root");
        let outside = std::env::temp_dir().join(format!("alinery_history_root_secret_{}", std::process::id()));
        fs::write(&outside, b"outside the repo").unwrap();
        std::os::unix::fs::symlink(&outside, &history).unwrap();

        let error = read_session_history(&repo, "task", "s1", Some(0), Some(64)).unwrap_err();
        assert!(error.contains("symlink") || error.contains("escapes"), "unexpected error: {error}");
        fs::remove_file(outside).unwrap();
        fs::remove_dir_all(repo).unwrap();
    }

    #[test]
    fn a_hard_linked_journal_is_neither_chosen_nor_read() {
        // A hard link IS the file, so no path check can place it; only the link count betrays it.
        let repo = omp_fixture("omp_window_hardlink", &[("2026-01-01T00-00-00Z_a.jsonl", &row("real", "hello"))]);
        let outside = std::env::temp_dir().join(format!("omp_window_hardlink_target_{}.jsonl", std::process::id()));
        fs::write(&outside, row("secret", "outside the repo")).unwrap();
        let dir = session_omp_dir(&repo, "task", "s1");
        fs::hard_link(&outside, dir.join("2026-02-01T00-00-00Z_b.jsonl")).unwrap();

        assert_eq!(newest_omp_jsonl(&dir).unwrap().file_name().unwrap(), "2026-01-01T00-00-00Z_a.jsonl");
        let window = read_omp_window(&repo, "task", "s1", None, None).unwrap();
        assert_eq!(ids(&window.data), vec!["real"], "the hard link is skipped, not read");
        fs::remove_file(outside).unwrap();
        fs::remove_dir_all(repo).unwrap();
    }

    #[test]
    fn a_symlinked_journal_is_neither_chosen_nor_read() {
        let repo = omp_fixture("omp_window_symlink", &[("2026-01-01T00-00-00Z_a.jsonl", &row("real", "hello"))]);
        let outside = std::env::temp_dir().join(format!("omp_window_symlink_target_{}.jsonl", std::process::id()));
        fs::write(&outside, row("secret", "outside the repo")).unwrap();
        let dir = session_omp_dir(&repo, "task", "s1");
        // Lexically newest, so it would win the selection if it were accepted at all.
        std::os::unix::fs::symlink(&outside, dir.join("2026-02-01T00-00-00Z_b.jsonl")).unwrap();

        assert_eq!(newest_omp_jsonl(&dir).unwrap().file_name().unwrap(), "2026-01-01T00-00-00Z_a.jsonl");
        let window = read_omp_window(&repo, "task", "s1", None, None).unwrap();
        assert_eq!(ids(&window.data), vec!["real"], "the symlink is skipped, not followed");
        fs::remove_file(outside).unwrap();
        fs::remove_dir_all(repo).unwrap();
    }

    // OMP creates the .omp dir at spawn but writes nothing until its first assistant message.
    #[test]
    fn a_session_with_no_journal_reads_empty_rather_than_erroring() {
        let repo = omp_fixture("omp_window_empty", &[]);
        let window = read_omp_window(&repo, "task", "s1", None, None).unwrap();
        assert_eq!(window.length, 0);
        assert!(window.data.is_empty());
    }

    // validate_owned_session rejects these outright: safe_component("") is None and there is no
    // task.md to read. Root sessions must still be able to show their history.
    #[test]
    fn taskless_root_sessions_are_readable() {
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let repo = std::env::temp_dir().join(format!("omp_window_root_{}_{unique}", std::process::id()));
        fs::create_dir_all(crate::root_sessions_dir(&repo)).unwrap();
        let meta = SessionMeta {
            id: "s9".into(),
            ..Default::default()
        };
        fs::write(session_meta_path(&repo, "", "s9"), serde_json::to_vec(&meta).unwrap()).unwrap();
        let dir = session_omp_dir(&repo, "", "s9");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("2026-01-01T00-00-00Z_a.jsonl"), row("root", "hello")).unwrap();

        let window = read_omp_window(&repo, "", "s9", None, None).unwrap();
        assert_eq!(ids(&window.data), vec!["root"]);
    }

    fn fixture(name: &str) -> (PathBuf, PathBuf) {
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let repo = std::env::temp_dir().join(format!("{name}_{}_{}_{}", std::process::id(), unique, COUNTER.fetch_add(1, Ordering::Relaxed)));
        let slug = "task";
        let task = Task {
            name: slug.into(),
            slug: slug.into(),
            branch: slug.into(),
            worktree: repo.join("worktree").display().to_string(),
            has_worktree: true,
            playbook: "superdevelop".into(),
            ..Default::default()
        };
        let task_path = task_dir(&repo, slug);
        let sessions = sessions_dir(&repo, slug);
        fs::create_dir_all(&sessions).unwrap();
        fs::write(task_path.join("task.md"), toml::to_string(&task).unwrap()).unwrap();
        let meta = SessionMeta {
            id: "s1".into(),
            archived: true,
            ..Default::default()
        };
        fs::write(session_meta_path(&repo, slug, "s1"), serde_json::to_vec(&meta).unwrap()).unwrap();
        let history = sessions.join("s1.scrollback");
        (repo, history)
    }

    #[test]
    fn raw_history_is_lossless_and_paged_across_numeric_chunks() {
        let (repo, history) = fixture("alinery_history_chunks");
        fs::create_dir_all(&history).unwrap();
        fs::write(history.join("10"), [6, 0xff, 8]).unwrap();
        fs::write(history.join("0002"), [3, 4, 5]).unwrap();
        fs::write(history.join("1"), [0, 1, 2]).unwrap();
        fs::write(history.join("ignore.txt"), [99]).unwrap();

        let result = read_session_history(&repo, "task", "s1", Some(2), Some(5)).unwrap();
        assert_eq!(result.mode, HistoryMode::Raw);
        assert_eq!(result.data, vec![2, 3, 4, 5, 6]);
        assert_eq!(result.offset, Some(2));
        assert_eq!(result.limit, Some(5));
        assert_eq!(result.length, Some(9));
        assert_eq!(result.next_offset, Some(7));
        assert_eq!(result.eof, Some(false));

        let beyond = read_session_history(&repo, "task", "s1", Some(20), Some(HISTORY_WINDOW_MAX + 1)).unwrap();
        assert!(beyond.data.is_empty());
        assert_eq!(beyond.limit, Some(HISTORY_WINDOW_MAX));
        assert_eq!(beyond.next_offset, Some(20));
        assert_eq!(beyond.eof, Some(true));
        fs::remove_dir_all(repo).unwrap();
    }

    #[test]
    fn screen_history_reconstructs_numeric_chunks() {
        let (repo, history) = fixture("alinery_history_numeric_screen");
        fs::create_dir_all(&history).unwrap();
        fs::write(history.join("1"), b"first\r\n").unwrap();
        fs::write(history.join("0002"), b"second").unwrap();
        fs::write(history.join("ignore.txt"), b"hidden").unwrap();

        let result = read_session_history(&repo, "task", "s1", None, None).unwrap();
        let screen = String::from_utf8_lossy(&result.data);
        assert!(screen.contains("first"));
        assert!(screen.contains("second"));
        assert!(!screen.contains("hidden"));
        fs::remove_dir_all(repo).unwrap();
    }

    #[test]
    fn history_requires_paired_bounds_and_task_owned_metadata() {
        let (repo, _) = fixture("alinery_history_validation");
        assert!(read_session_history(&repo, "task", "s1", Some(0), None).unwrap_err().contains("together"));
        assert!(read_session_history(&repo, "task", "s1", None, Some(1)).unwrap_err().contains("together"));
        assert!(read_session_history(&repo, "../task", "s1", None, None).unwrap_err().contains("invalid"));
        assert!(read_session_history(&repo, "task", "../s1", None, None).unwrap_err().contains("invalid"));
        assert!(read_session_history(&repo, "task", "missing", None, None).is_err());
        fs::remove_dir_all(repo).unwrap();
    }

    #[test]
    fn screen_history_reconstructs_archived_session_without_changing_meta() {
        let (repo, history) = fixture("alinery_history_screen");
        fs::write(&history, b"first\r\nsecond").unwrap();
        let meta_path = session_meta_path(&repo, "task", "s1");
        let before = fs::read(&meta_path).unwrap();
        let result = read_session_history(&repo, "task", "s1", None, None).unwrap();
        assert_eq!(result.mode, HistoryMode::Screen);
        assert!(String::from_utf8_lossy(&result.data).contains("second"));
        assert_eq!(fs::read(meta_path).unwrap(), before);
        assert!(result.offset.is_none() && result.limit.is_none() && result.length.is_none());
        fs::remove_dir_all(repo).unwrap();
    }
}
