// Backups of a repository's `.alinery/` data (plan S4.9), ported from alinery-core `backup.rs`: a curated set of files in one
// zip, written and read with the host's `zip` and `unzip` (O11 b, platform/zip.ts). The layout is the one Rust wrote, which
// the Rust reader (the MCP tool's) still reads: `backup-meta.json` at the root, then each curated file named relative to
// `.alinery/`. Two rules the rest leans on, both from the Rust file:
//   * `CURATED` is the one list of what is backed up, and restore replaces exactly that set, so nothing replaced was unsaved.
//   * `meta.repo_path`, not the file name, says which repository an archive belongs to.
import { randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { writeAtomic } from "../platform/fs.ts";
import { unzipInto, unzipNames, unzipText, unzipTypes, zipAdd, zipAddRoot } from "../platform/zip.ts";
import { currentGlobal, effectiveSettings, emptyOverrides, parseOverrides } from "./settings.ts";

export const BACKUP_SCHEMA_VERSION = 1;
/** The archive-root name of the metadata sidecar. Never extracted back into `.alinery/`. */
export const BACKUP_META_NAME = "backup-meta.json";
/**
 * Everything under `.alinery/` that is durable alinery data. Deliberately excluded: `worktrees/` (git-backed, holds
 * uncommitted user work), sockets, lock files and `tmp/` (runtime only). `sessions/` is the root (taskless) session store.
 */
export const CURATED = ["tasks", "sessions", "config.toml", "harnesses.toml", "playbooks.toml", "playbooks"];

export type BackupTrigger = "manual" | "pre_archive" | "post_artifact_change" | "post_push_commit" | "mcp";
export type BackupSettings = {
  destination: string;
  enabled: boolean;
  retention: number;
  triggerPreArchive: boolean;
  triggerPostArtifactChange: boolean;
  triggerPostPushCommit: boolean;
};
/** `BackupMeta`, as serde writes it. */
export type BackupMeta = {
  repo_name: string;
  repo_path: string;
  created_at: number;
  schema_version: number;
  alinery_version: string;
  trigger: BackupTrigger;
  included_dirs: string[];
};
export type BackupListItem = { id: string; path: string; created_at: number; trigger: string; size_bytes: number; alinery_version: string };
export type Report = (progress: { done: number; total: number; label: string }) => void;

const alineryDir = (repo: string) => join(repo, ".alinery");
const nowSecs = () => Math.floor(Date.now() / 1000);

/** backup.rs `backup_settings_in`: the global defaults in `app.toml` under the repository's own `config.toml`. Read where the repository lives. */
export function backupSettings(repo: string, appConfig: string): BackupSettings {
  let overrides = emptyOverrides();
  try {
    overrides = parseOverrides(readFileSync(join(alineryDir(repo), "config.toml"), "utf8")) ?? overrides;
  } catch {
    /* no config.toml: every field inherits */
  }
  const b = effectiveSettings(currentGlobal(appConfig), overrides).backup;
  return {
    destination: b?.destination ?? "",
    enabled: b?.enabled ?? false,
    retention: b?.retention ?? 1,
    triggerPreArchive: b?.triggerPreArchive ?? false,
    triggerPostArtifactChange: b?.triggerPostArtifactChange ?? false,
    triggerPostPushCommit: b?.triggerPostPushCommit ?? false,
  };
}

/** Filesystem-safe form of a repository directory name, for the archive's name and the cheap prefix filter in `listBackups`. */
function sanitizeRepoName(name: string): string {
  const cleaned = [...name].map((c) => (/^[A-Za-z0-9\-_.]$/.test(c) ? c : "_")).join("");
  const trimmed = cleaned.replace(/^\.+|\.+$/g, "");
  return trimmed === "" ? "repo" : trimmed;
}

const repoDirName = (repo: string) => basename(repo) || "repo";

/**
 * `validate_backup_destination`: an existing writable directory that is not `.alinery/` or inside it. Both sides are resolved, so
 * a symlink into `.alinery/` is refused too. Returns the resolved path.
 */
export function validateDestination(repo: string, dest: string): string {
  if (dest === "") throw new Error("backup destination is not set");
  let st;
  try {
    st = statSync(dest);
  } catch (e) {
    throw new Error(`${dest}: ${(e as Error).message}`);
  }
  if (!st.isDirectory()) throw new Error(`${dest} is not a directory`);
  const resolved = realpathSync(dest);
  let inside: string | undefined;
  try {
    inside = realpathSync(alineryDir(repo));
  } catch {
    /* an absent `.alinery/` contains nothing */
  }
  if (inside !== undefined && (resolved === inside || resolved.startsWith(`${inside}/`))) throw new Error(`backup destination must be outside ${inside}`);
  // Permission bits do not tell the whole story (read-only mounts, ACLs, sandboxes), so probe with a real file.
  const probe = join(resolved, `.alinery-backup-probe.${process.pid}.${Date.now()}`);
  try {
    closeSync(openSync(probe, "wx"));
  } catch (e) {
    throw new Error(`${resolved} is not writable: ${(e as Error).message}`);
  }
  rmSync(probe, { force: true });
  return resolved;
}

/** `backup_feature_ready`: on, with a destination that is usable now. */
export function featureReady(settings: BackupSettings, repo: string): boolean {
  if (!settings.enabled || settings.destination === "") return false;
  try {
    validateDestination(repo, settings.destination);
    return true;
  } catch {
    return false;
  }
}

/** `should_publish`: should this automatic trigger make a backup. Manual and MCP backups never ask; they report their own result. */
export function shouldPublish(settings: BackupSettings, repo: string, trigger: BackupTrigger): boolean {
  if (!featureReady(settings, repo)) return false;
  switch (trigger) {
    case "pre_archive":
      return settings.triggerPreArchive;
    case "post_artifact_change":
      return settings.triggerPostArtifactChange;
    case "post_push_commit":
      return settings.triggerPostPushCommit;
    default:
      return false;
  }
}

/** Every regular file under `root`, named `prefix/...`. A symlink is skipped, not followed: following one could reach outside the tree the archive claims to describe. */
function collect(root: string, prefix: string, out: string[]) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const rel = `${prefix}/${e.name}`;
    if (e.isDirectory()) collect(join(root, e.name), rel, out);
    else if (e.isFile()) out.push(rel);
  }
}

/** Every curated file present, named relative to `.alinery/`, in order. A name with a newline cannot go on `zip`'s list and is skipped. */
export function curatedFiles(alinery: string): string[] {
  const out: string[] = [];
  for (const name of CURATED) {
    let st;
    try {
      st = lstatSync(join(alinery, name));
    } catch {
      continue;
    }
    if (st.isDirectory()) collect(join(alinery, name), name, out);
    else if (st.isFile()) out.push(name);
  }
  return out.filter((n) => !n.includes("\n")).sort();
}

/** First free `<stem>.zip`, `<stem>-2.zip`, ...: two backups in one second must not replace each other. */
function uniqueZipPath(dest: string, stem: string): string {
  const exists = (p: string) => {
    try {
      lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };
  const first = join(dest, `${stem}.zip`);
  if (!exists(first)) return first;
  for (let n = 2; n < 1000; n++) {
    const candidate = join(dest, `${stem}-${n}.zip`);
    if (!exists(candidate)) return candidate;
  }
  return join(dest, `${stem}-${nowSecs()}.zip`);
}

/**
 * Makes a backup in the destination and prunes to the retention count. Written under a temporary name and renamed, so a
 * crashed run never leaves a half-written archive that `listBackups` would show. Returns the archive's meta and path.
 */
export async function createBackup(repo: string, settings: BackupSettings, trigger: BackupTrigger, version: string, report: Report = () => {}): Promise<BackupMeta & { path: string }> {
  if (!settings.enabled) throw new Error("backup is disabled for this repository");
  const dest = validateDestination(repo, settings.destination);
  const alinery = alineryDir(repo);
  try {
    if (!statSync(alinery).isDirectory()) throw new Error();
  } catch {
    throw new Error(`${alinery} does not exist`);
  }
  const files = curatedFiles(alinery);
  const meta: BackupMeta = {
    repo_name: repoDirName(repo),
    repo_path: realpathSync(repo),
    created_at: nowSecs(),
    schema_version: BACKUP_SCHEMA_VERSION,
    alinery_version: version,
    trigger,
    included_dirs: CURATED.filter((n) => {
      try {
        lstatSync(join(alinery, n));
        return true;
      } catch {
        return false;
      }
    }).sort(),
  };
  const final = uniqueZipPath(dest, `${sanitizeRepoName(meta.repo_name)}-${meta.created_at}-v${version}`);
  // A name ending in `.zip`, so `zip` does not append one; it starts with a dot, so no listing sees it.
  const tmp = join(dest, `.${basename(final, ".zip")}.${process.pid}.${randomUUID().slice(0, 8)}.tmp.zip`);
  const scratch = mkdtempSync(join(tmpdir(), "alinery-backup-"));
  try {
    report({ done: 0, total: files.length, label: "Writing the archive" });
    const metaFile = join(scratch, BACKUP_META_NAME);
    writeAtomic(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
    await zipAddRoot(tmp, metaFile);
    await zipAdd(tmp, alinery, files);
    renameSync(tmp, final);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  report({ done: files.length, total: files.length, label: "Pruning old backups" });
  await enforceRetention(repo, settings);
  return { ...meta, path: final };
}

/** `backup-meta.json` out of an archive, without extracting anything else. */
export async function readBackupMeta(zip: string): Promise<BackupMeta> {
  const body = await unzipText(zip, BACKUP_META_NAME);
  try {
    return JSON.parse(body) as BackupMeta;
  } catch (e) {
    throw new Error(`${zip}: ${(e as Error).message}`);
  }
}

/** Backups of `repo`, newest first. Unreadable, foreign and meta-less files in the destination are skipped: it is the user's folder, not ours alone. */
export async function listBackups(repo: string, settings: BackupSettings): Promise<BackupListItem[]> {
  const dest = validateDestination(repo, settings.destination);
  const repoPath = realpathSync(repo);
  const prefix = `${sanitizeRepoName(repoDirName(repo))}-`;
  const names = readdirSync(dest).filter((n) => n.startsWith(prefix) && n.endsWith(".zip"));
  const found: BackupListItem[] = [];
  // A few at a time: each is one `unzip` child, and a destination can hold hundreds.
  for (let i = 0; i < names.length; i += 8) {
    await Promise.all(
      names.slice(i, i + 8).map(async (name) => {
        const path = join(dest, name);
        try {
          const st = statSync(path);
          if (!st.isFile()) return;
          const meta = await readBackupMeta(path);
          if (meta.repo_path !== repoPath) return;
          found.push({ id: name, path, created_at: meta.created_at, trigger: meta.trigger, size_bytes: st.size, alinery_version: meta.alinery_version });
        } catch {
          /* not one of ours */
        }
      }),
    );
  }
  // Same-second archives tie on created_at; the file name suffix (`-2`, `-3`) breaks it.
  return found.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** Deletes the oldest of this repository's archives until at most `retention` remain; another repository's archives in a shared destination are never counted. */
export async function enforceRetention(repo: string, settings: BackupSettings): Promise<void> {
  for (const item of (await listBackups(repo, settings)).slice(settings.retention)) {
    try {
      rmSync(item.path);
    } catch (e) {
      throw new Error(`prune ${item.path}: ${(e as Error).message}`);
    }
  }
}

/** A backup may only be restored into the repository it was taken from. */
export async function verifyBackup(repo: string, zip: string): Promise<BackupMeta> {
  const meta = await readBackupMeta(zip);
  const expected = realpathSync(repo);
  if (meta.repo_path !== expected) throw new Error(`this backup belongs to ${meta.repo_path}, not ${expected}`);
  return meta;
}

/** `safe_entry_path`: an entry name that stays inside the extraction root, or undefined. An archive is untrusted input: a person can be handed a `.zip` and restore it. */
export function safeEntryPath(name: string): string | undefined {
  if (name.startsWith("/") || name.startsWith("\\")) return undefined;
  const out: string[] = [];
  for (const part of name.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return undefined;
    out.push(part);
  }
  return out.length === 0 ? undefined : out.join("/");
}

/** Everything under `dir` must be a plain file or directory. */
function requirePlain(dir: string) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) requirePlain(join(dir, e.name));
    else if (!e.isFile()) throw new Error(`unsafe archive entry rejected: ${e.name} is not a plain file`);
  }
}

/**
 * Replaces the curated set of `repo` with an archive's, while no daemon runs (the caller stopped it: it owns the sessions
 * that hold this data). Identity first: a foreign archive costs nothing. Then every entry is checked before anything is
 * extracted, the archive is unpacked into a new directory under `.alinery/tmp/`, and only then is the old set moved aside and
 * the new one renamed into place, so a failure at any step leaves the old data (a restore that cleared first would not).
 */
export async function restoreBackup(repo: string, zip: string): Promise<BackupMeta> {
  const meta = await verifyBackup(repo, zip);
  // A symlink entry cannot be seen by a name check, and Debian's unzip would leave an escaping link inside the target.
  const types = await unzipTypes(zip);
  if (types.some((t) => t !== "-" && t !== "d")) throw new Error("unsafe archive entry rejected: the archive holds a link or a special file");
  for (const name of await unzipNames(zip)) {
    if (name === BACKUP_META_NAME) continue;
    const rel = safeEntryPath(name);
    if (rel === undefined) throw new Error(`unsafe archive entry rejected: ${name}`);
    if (!CURATED.includes(rel.split("/")[0] as string)) throw new Error(`unsafe archive entry rejected: ${name} is not part of a backup`);
  }
  const alinery = alineryDir(repo);
  const stage = join(alinery, "tmp", `restore-${randomUUID()}`);
  const old = `${stage}-old`;
  mkdirSync(stage, { recursive: true });
  mkdirSync(old, { recursive: true });
  const placed: string[] = [];
  const moved: string[] = [];
  try {
    await unzipInto(zip, stage, BACKUP_META_NAME);
    requirePlain(stage);
    for (const name of CURATED) {
      try {
        lstatSync(join(alinery, name));
      } catch {
        continue;
      }
      renameSync(join(alinery, name), join(old, name));
      moved.push(name);
    }
    for (const name of readdirSync(stage)) {
      renameSync(join(stage, name), join(alinery, name));
      placed.push(name);
    }
  } catch (e) {
    for (const name of placed) rmSync(join(alinery, name), { recursive: true, force: true });
    for (const name of moved) renameSync(join(old, name), join(alinery, name));
    throw e;
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(old, { recursive: true, force: true });
  }
  return meta;
}
