//! Rolling process log next to `app.toml` (`logs/alinery.log`).

use std::fmt::Write;
use std::fs::{self, OpenOptions};
use std::io::{self, Write as IoWrite};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::lockfile::try_lock_exclusive;
use crate::{log_lock_path, log_path, logs_dir};

const ROTATE_BYTES: u64 = 1_000_000;
const LINE_CAP: usize = 4096;
const LOCK_ATTEMPTS: usize = 10;
const LOCK_SLEEP: Duration = Duration::from_millis(50);
const TRUNCATED: &str = " …truncated";

pub fn append_info(app_config: &Path, message: &str) {
    append_line(app_config, "info", message);
}

pub fn append_exception(app_config: &Path, message: &str) {
    append_line(app_config, "exception", message);
}

pub fn process_label() -> &'static str {
    static LABEL: LazyLock<&'static str> = LazyLock::new(|| {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .map(|n| label_for(&n))
            .unwrap_or("other")
    });
    *LABEL
}

pub fn quote_log_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    escape_value(value, &mut out);
    out.push('"');
    out
}

fn is_log_control(c: char) -> bool {
    let n = c as u32;
    n <= 0x1f || n == 0x7f || (0x80..=0x9f).contains(&n)
}

fn push_escaped_char(c: char, out: &mut String, in_quotes: bool) {
    match c {
        '\\' if in_quotes => out.push_str("\\\\"),
        '"' if in_quotes => out.push_str("\\\""),
        '\n' => out.push_str("\\n"),
        '\r' => out.push_str("\\r"),
        '\t' => out.push_str("\\t"),
        c if is_log_control(c) => {
            let _ = write!(out, "\\x{:02x}", c as u32);
        }
        other => out.push(other),
    }
}

fn escape_value(value: &str, out: &mut String) {
    for c in value.chars() {
        push_escaped_char(c, out, true);
    }
}

pub fn format_rfc3339_utc(at: SystemTime) -> String {
    let secs = at.duration_since(UNIX_EPOCH).unwrap_or(Duration::ZERO).as_secs();
    let days = (secs / 86_400) as i64;
    let sod = secs % 86_400;
    let (y, m, d) = civil_from_days(days);
    let h = sod / 3600;
    let mi = (sod % 3600) / 60;
    let s = sod % 60;
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// Howard Hinnant `civil_from_days`. `days` is days since 1970-01-01 (Unix epoch).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    if m <= 2 {
        y += 1;
    }
    (y, m, d)
}

pub(crate) fn label_for(file_name: &str) -> &'static str {
    if file_name == "alineryd" || file_name.starts_with("alineryd-") {
        "alineryd"
    } else if file_name == "alinery-mcp" || file_name.starts_with("alinery-mcp-") {
        "alinery-mcp"
    } else if file_name == "alinery-runner" || file_name.starts_with("alinery-runner-") {
        "alinery-runner"
    } else if matches!(file_name, "alinery" | "alinery Dev" | "Alinery" | "Alinery Dev") {
        "alinery-app"
    } else {
        "other"
    }
}

fn sanitize_log_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        push_escaped_char(c, &mut out, false);
    }
    out
}

fn cap_line(mut line: String) -> String {
    if line.len() <= LINE_CAP {
        return line;
    }
    let max = LINE_CAP - TRUNCATED.len();
    let mut cut = max;
    while cut > 0 && !line.is_char_boundary(cut) {
        cut -= 1;
    }
    line.truncate(cut);
    line.push_str(TRUNCATED);
    line
}

fn acquire_lock(path: &Path) -> Option<crate::lockfile::LockFile> {
    for _ in 0..LOCK_ATTEMPTS {
        match try_lock_exclusive(path) {
            Ok(Some(lock)) => return Some(lock),
            Ok(None) => thread::sleep(LOCK_SLEEP),
            Err(_) => return None,
        }
    }
    None
}

fn rotated_path(log: &Path, n: u8) -> PathBuf {
    let mut name = log.as_os_str().to_os_string();
    name.push(format!(".{n}"));
    PathBuf::from(name)
}

fn ignore_not_found(result: io::Result<()>) -> Result<(), ()> {
    match result {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(()),
    }
}

fn rotate_logs(log: &Path) -> Result<(), ()> {
    ignore_not_found(fs::remove_file(rotated_path(log, 4)))?;
    ignore_not_found(fs::rename(rotated_path(log, 3), rotated_path(log, 4)))?;
    ignore_not_found(fs::rename(rotated_path(log, 2), rotated_path(log, 3)))?;
    ignore_not_found(fs::rename(rotated_path(log, 1), rotated_path(log, 2)))?;
    ignore_not_found(fs::rename(log, rotated_path(log, 1)))
}

fn append_line(app_config: &Path, level: &str, message: &str) {
    let ts = format_rfc3339_utc(SystemTime::now());
    let pid = std::process::id();
    let label = process_label();
    let assembled = format!("{ts} {level:<9} pid={pid} proc={label} {message}");
    let line = cap_line(sanitize_log_text(&assembled));
    let dir = logs_dir(app_config);
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let Some(_lock) = acquire_lock(&log_lock_path(app_config)) else {
        return;
    };
    let path = log_path(app_config);
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() + line.len() as u64 + 1 > ROTATE_BYTES && rotate_logs(&path).is_err() {
            return;
        }
    }
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) else {
        return;
    };
    let _ = file.write_all(line.as_bytes());
    let _ = file.write_all(b"\n");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lockfile::try_lock_exclusive;
    use crate::{log_lock_path, log_path};
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn tmp_app_config(label: &str) -> (PathBuf, PathBuf) {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("alinery-log-{label}-{n}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let app_config = dir.join("app.toml");
        (dir, app_config)
    }

    fn decode_quoted(token: &str) -> String {
        assert!(token.starts_with('"') && token.ends_with('"') && token.len() >= 2, "quoted token: {token}");
        let inner = &token[1..token.len() - 1];
        let mut out = String::new();
        let mut chars = inner.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '\\' {
                match chars.next() {
                    Some('\\') => out.push('\\'),
                    Some('"') => out.push('"'),
                    Some('n') => out.push('\n'),
                    Some('r') => out.push('\r'),
                    Some(other) => {
                        out.push('\\');
                        out.push(other);
                    }
                    None => out.push('\\'),
                }
            } else {
                out.push(c);
            }
        }
        out
    }

    fn data_log_files(dir: &Path) -> Vec<PathBuf> {
        let logs = dir.join("logs");
        let Ok(entries) = fs::read_dir(&logs) else {
            return Vec::new();
        };
        let mut files: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n == "alinery.log" || n.starts_with("alinery.log."))
                    && !p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with(".lock"))
            })
            .collect();
        files.sort();
        files
    }

    #[test]
    fn format_rfc3339_utc_vectors() {
        assert_eq!(format_rfc3339_utc(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        assert_eq!(format_rfc3339_utc(UNIX_EPOCH + Duration::from_secs(951_782_400)), "2000-02-29T00:00:00Z");
        assert_eq!(format_rfc3339_utc(UNIX_EPOCH + Duration::from_secs(1_709_164_800)), "2024-02-29T00:00:00Z");
        assert_eq!(format_rfc3339_utc(UNIX_EPOCH + Duration::from_secs(2_147_483_648)), "2038-01-19T03:14:08Z");
        let before = UNIX_EPOCH.checked_sub(Duration::from_secs(1)).expect("pre-epoch");
        assert_eq!(format_rfc3339_utc(before), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn label_for_maps_sidecar_prefixes() {
        assert_eq!(label_for("alineryd"), "alineryd");
        assert_eq!(label_for("alineryd-aarch64-apple-darwin"), "alineryd");
        assert_eq!(label_for("alineryd"), "alineryd");
        assert_eq!(label_for("alineryd-x86_64-apple-darwin"), "alineryd");
        assert_eq!(label_for("alinery-mcp"), "alinery-mcp");
        assert_eq!(label_for("alinery-mcp-x86_64-apple-darwin"), "alinery-mcp");
        assert_eq!(label_for("alinery-mcp"), "alinery-mcp");
        assert_eq!(label_for("alinery-runner"), "alinery-runner");
        assert_eq!(label_for("alinery-runner-aarch64-apple-darwin"), "alinery-runner");
        assert_eq!(label_for("alinery"), "alinery-app");
        assert_eq!(label_for("alinery Dev"), "alinery-app");
        assert_eq!(label_for("alinery"), "alinery-app");
        assert_eq!(label_for("Alinery"), "alinery-app");
        assert_eq!(label_for("Alinery Dev"), "alinery-app");
        assert_eq!(label_for("alinery"), "alinery-app");
        assert_eq!(label_for("not-a-alinery-bin"), "other");
    }

    #[test]
    fn quote_log_value_escapes_once() {
        let input = "a\\b\"c\nd";
        let quoted = quote_log_value(input);
        assert!(quoted.starts_with('"') && quoted.ends_with('"'), "must wrap in quotes: {quoted}");
        assert!(!quoted.contains("\\\\\\\\"), "double-escaped backslash: {quoted}");
        assert_eq!(decode_quoted(&quoted), input);
    }

    #[test]
    fn sanitize_does_not_reescape_backslashes() {
        let out = sanitize_log_text("keep\\slash\nand\rmore");
        assert!(out.contains('\\'), "backslash must survive: {out}");
        assert!(!out.contains('\n'), "raw newline must be encoded: {out}");
        assert!(!out.contains('\r'), "raw CR must be encoded: {out}");
        assert_eq!(out, "keep\\slash\\nand\\rmore");
    }

    #[test]
    fn quote_and_append_encode_terminal_controls() {
        let input = "\x1b]52;c;SECRET\x07\t\u{9d}";
        assert_eq!(quote_log_value(input), "\"\\x1b]52;c;SECRET\\x07\\t\\x9d\"");

        let (dir, app_config) = tmp_app_config("controls");
        append_info(&app_config, &format!("endpoint={}", quote_log_value(input)));
        append_info(&app_config, "raw-esc=\x1b]0;title\x07");
        let path = log_path(&app_config);
        let bytes = fs::read(&path).expect("alinery.log");
        assert_eq!(bytes.last().copied(), Some(b'\n'));
        for (i, b) in bytes.iter().enumerate() {
            if *b == b'\n' {
                continue;
            }
            assert!(*b >= 0x20 && *b != 0x7f, "raw control 0x{b:02x} at byte {i}");
        }
        let text = String::from_utf8(bytes).expect("utf8 log");
        assert!(text.contains("\\x1b]52;c;SECRET\\x07\\t\\x9d"), "{text}");
        assert!(text.contains("raw-esc=\\x1b]0;title\\x07"), "{text}");
        assert!(!text.contains('\u{9d}'), "C1 scalar must not reach the file: {text}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn line_over_4096_is_truncated_not_split() {
        let (dir, app_config) = tmp_app_config("cap");
        append_info(&app_config, &"x".repeat(5000));
        let text = fs::read_to_string(log_path(&app_config)).expect("alinery.log");
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 1, "must be one physical line, got {}: {text}", lines.len());
        let line = lines[0];
        assert!(line.len() <= 4096, "capped line is {} bytes", line.len());
        assert!(line.ends_with(" …truncated"), "missing suffix: {line}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rotate_at_one_mb_plus_one() {
        let (dir, app_config) = tmp_app_config("rotate-1mb");
        let logs = dir.join("logs");
        fs::create_dir_all(&logs).unwrap();
        fs::write(logs.join("alinery.log"), vec![b'a'; 1_000_000]).unwrap();
        append_info(&app_config, "rotated");
        let active = fs::read_to_string(logs.join("alinery.log")).expect("active");
        assert!(active.contains("rotated"), "active should be the new line: {active}");
        assert!(active.len() < 1_000_000, "must not append onto the 1MB file: {}", active.len());
        assert!(logs.join("alinery.log.1").exists(), "rotated generation .1 missing");
        assert!(!logs.join("alinery.log.5").exists(), "must not keep a sixth data file");
        assert!(data_log_files(&dir).len() <= 5, "at most 5 data files");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rotate_drops_dot_four_and_preserves_order() {
        let (dir, app_config) = tmp_app_config("rotate-order");
        let logs = dir.join("logs");
        fs::create_dir_all(&logs).unwrap();
        fs::write(logs.join("alinery.log.4"), "gen4\n").unwrap();
        fs::write(logs.join("alinery.log.3"), "gen3\n").unwrap();
        fs::write(logs.join("alinery.log.2"), "gen2\n").unwrap();
        fs::write(logs.join("alinery.log.1"), "gen1\n").unwrap();
        fs::write(logs.join("alinery.log"), vec![b'0'; 1_000_000]).unwrap();
        append_info(&app_config, "gen-new");
        assert!(!logs.join("alinery.log.4").exists() || fs::read_to_string(logs.join("alinery.log.4")).unwrap() != "gen4\n");
        let four = fs::read_to_string(logs.join("alinery.log.4")).unwrap_or_default();
        assert_eq!(four, "gen3\n", "former .3 must shift to .4");
        assert_eq!(fs::read_to_string(logs.join("alinery.log.3")).unwrap(), "gen2\n");
        assert_eq!(fs::read_to_string(logs.join("alinery.log.2")).unwrap(), "gen1\n");
        let one = fs::read_to_string(logs.join("alinery.log.1")).unwrap();
        assert_eq!(one.len(), 1_000_000, "former active becomes .1");
        assert!(one.bytes().all(|b| b == b'0'));
        let active = fs::read_to_string(logs.join("alinery.log")).unwrap();
        assert!(active.contains("gen-new"));
        assert!(!active.contains("gen4"), "oldest generation must be dropped");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn lock_file_is_not_rotated() {
        let (dir, app_config) = tmp_app_config("lock-marker");
        let logs = dir.join("logs");
        fs::create_dir_all(&logs).unwrap();
        fs::write(logs.join("alinery.log"), vec![b'a'; 1_000_000]).unwrap();
        append_info(&app_config, "ping");
        assert!(log_lock_path(&app_config).exists(), "marker must remain at alinery.log.lock");
        assert!(!logs.join("alinery.log.lock.1").exists(), "must not rotate the lock marker");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn contended_lock_drops_the_line() {
        let (dir, app_config) = tmp_app_config("contend");
        let logs = dir.join("logs");
        fs::create_dir_all(&logs).unwrap();
        let _held = try_lock_exclusive(&log_lock_path(&app_config)).expect("open").expect("hold marker");
        let before = logs.join("alinery.log").exists();
        let before_bytes = fs::read(logs.join("alinery.log")).unwrap_or_default();
        append_info(&app_config, "must-drop");
        let after_exists = logs.join("alinery.log").exists();
        let after_bytes = fs::read(logs.join("alinery.log")).unwrap_or_default();
        assert_eq!(before, after_exists);
        assert_eq!(before_bytes, after_bytes);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn two_threads_two_fds_do_not_tear() {
        let (dir, app_config) = tmp_app_config("threads");
        let logs = dir.join("logs");
        fs::create_dir_all(&logs).unwrap();
        {
            let mut f = OpenOptions::new().create(true).write(true).truncate(true).open(logs.join("alinery.log")).unwrap();
            f.write_all(&vec![b'z'; 900_000]).unwrap();
            f.write_all(b"\n").unwrap();
        }
        let app_config = Arc::new(app_config);
        let handles: Vec<_> = (0..2)
            .map(|t| {
                let app_config = Arc::clone(&app_config);
                std::thread::spawn(move || {
                    for i in 0..40 {
                        append_info(&app_config, &format!("thread{t}-{i}"));
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().expect("thread");
        }
        let mut lines = Vec::new();
        for path in data_log_files(&dir) {
            if let Ok(text) = fs::read_to_string(&path) {
                for line in text.lines() {
                    if line.bytes().all(|b| b == b'z') {
                        continue;
                    }
                    assert!(regex_prefix(line), "torn or malformed line in {}: {line}", path.display());
                    lines.push(line.to_string());
                }
            }
        }
        assert!(!lines.is_empty(), "expected appended lines");
        assert!(data_log_files(&dir).len() <= 5, "rotate must not create a sixth data file");
        let _ = fs::remove_dir_all(&dir);
    }

    fn regex_prefix(line: &str) -> bool {
        let b = line.as_bytes();
        if b.len() < 21 {
            return false;
        }
        // YYYY-MM-DDTHH:MM:SSZ
        b[4] == b'-'
            && b[7] == b'-'
            && b[10] == b'T'
            && b[13] == b':'
            && b[16] == b':'
            && b[19] == b'Z'
            && b[20] == b' '
            && b[0..4].iter().all(u8::is_ascii_digit)
            && b[5..7].iter().all(u8::is_ascii_digit)
            && b[8..10].iter().all(u8::is_ascii_digit)
            && b[11..13].iter().all(u8::is_ascii_digit)
            && b[14..16].iter().all(u8::is_ascii_digit)
            && b[17..19].iter().all(u8::is_ascii_digit)
    }

    #[test]
    fn append_info_line_format() {
        let (dir, app_config) = tmp_app_config("fmt");
        append_info(&app_config, "hello");
        let text = fs::read_to_string(log_path(&app_config)).expect("alinery.log");
        let line = text.lines().next().expect("line");
        assert!(regex_prefix(line), "timestamp prefix: {line}");
        assert!(line.contains(" info      pid="), "info padded to 9: {line}");
        assert!(line.ends_with(" hello"), "{line}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn append_exception_uses_exception_level() {
        let (dir, app_config) = tmp_app_config("exc");
        append_exception(&app_config, "boom");
        let text = fs::read_to_string(log_path(&app_config)).expect("alinery.log");
        let line = text.lines().next().expect("line");
        assert!(line.contains(" exception pid="), "exception is 9 chars: {line}");
        assert!(line.ends_with(" boom"), "{line}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn process_label_is_other_under_cargo_test() {
        assert_eq!(process_label(), "other");
    }
}
