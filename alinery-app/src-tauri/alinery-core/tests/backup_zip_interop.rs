//! The daemon writes backups with the host's Info-ZIP `zip` (plan S4.9, O11 b); `alinery-mcp` still reads and writes them
//! with the `zip` crate until S5.1. An archive of 70,000 files is past what a library that writes no zip64 can hold
//! (65,535 entries), so this is the case that would show a reader and the tool disagreeing.
//!
//! The archive is built here with the tool and the flags the daemon uses (`vinculum-daemon/src/platform/zip.ts`). A second
//! test reads an archive the daemon's own code made: `ALINERY_TS_ARCHIVE=<file> cargo test ... ts_made_archive`, where the file
//! comes from `ALINERY_KEEP_BACKUP=<file> bun test src/domain/backup.test.ts` (it skips without the variable).
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use alinery_core::{extract_backup_into, read_backup_meta, BACKUP_META_NAME};

const DIRS: usize = 70;
const PER_DIR: usize = 1000;

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("alinery-zip-interop-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn have_zip() -> bool {
    Command::new("zip").arg("-v").output().map(|o| o.status.success()).unwrap_or(false)
}

/// Every file under `dir`, relative, sorted.
fn tree(dir: &Path) -> Vec<String> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<String>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(base, &path, out);
            } else {
                out.push(path.strip_prefix(base).unwrap().to_string_lossy().into_owned());
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out.sort();
    out
}

#[test]
fn rust_reads_a_70000_file_archive_written_with_the_host_zip() {
    if !have_zip() {
        eprintln!("skipped: no zip on this machine");
        return;
    }
    let root = temp("host");
    let repo = fs::canonicalize(&root).unwrap().join("repo");
    let alinery = repo.join(".alinery");
    let mut names = Vec::new();
    for d in 0..DIRS {
        let dir = alinery.join("tasks/bulk").join(format!("d{d}"));
        fs::create_dir_all(&dir).unwrap();
        for f in 0..PER_DIR {
            fs::write(dir.join(format!("f{f}.md")), format!("{d}-{f}")).unwrap();
            names.push(format!("tasks/bulk/d{d}/f{f}.md"));
        }
    }
    let meta = format!(
        r#"{{"repo_name":"repo","repo_path":{:?},"created_at":1700000000,"schema_version":1,"alinery_version":"9.9.9","trigger":"manual","included_dirs":["tasks"]}}"#,
        repo.to_string_lossy()
    );
    let staging = root.join("meta");
    fs::create_dir_all(&staging).unwrap();
    fs::write(staging.join(BACKUP_META_NAME), meta).unwrap();
    let archive = root.join("repo-v1.zip");

    assert!(Command::new("zip").args(["-q", "-j", "-X"]).arg(&archive).arg(staging.join(BACKUP_META_NAME)).status().unwrap().success());
    let mut add = Command::new("zip").args(["-q", "-X", "-D", "-nw"]).arg(&archive).arg("-@").current_dir(&alinery).stdin(Stdio::piped()).spawn().unwrap();
    add.stdin.take().unwrap().write_all(format!("{}\n", names.join("\n")).as_bytes()).unwrap();
    assert!(add.wait().unwrap().success());

    let meta = read_backup_meta(&archive).unwrap();
    assert_eq!((meta.repo_name.as_str(), meta.alinery_version.as_str()), ("repo", "9.9.9"));
    let target = root.join("restored");
    extract_backup_into(&archive, &target, Some(&repo)).unwrap();
    let got = tree(&target);
    assert_eq!(got.len(), DIRS * PER_DIR, "every file came back");
    assert_eq!(fs::read_to_string(target.join("tasks/bulk/d69/f999.md")).unwrap(), "69-999");
    assert_eq!(got, tree(&alinery));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn rust_reads_an_archive_the_daemon_made() {
    let Ok(archive) = std::env::var("ALINERY_TS_ARCHIVE") else {
        eprintln!("skipped: ALINERY_TS_ARCHIVE is not set");
        return;
    };
    let archive = PathBuf::from(archive);
    let meta = read_backup_meta(&archive).unwrap();
    let target = temp("ts");
    extract_backup_into(&archive, &target, None).unwrap();
    let files = tree(&target);
    assert!(files.len() > 70_000, "the archive holds the whole repository: {} files", files.len());
    assert!(files.iter().any(|f| f == "tasks/bulk/d69/f999.md"));
    assert_eq!(fs::read_to_string(target.join("tasks/bulk/d69/f999.md")).unwrap(), "69-999");
    assert!(!meta.repo_path.is_empty());
    fs::remove_dir_all(target).unwrap();
}
