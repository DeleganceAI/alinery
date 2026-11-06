// What a host needs while no daemon runs (plan S5.2, O15 b), ported from alinery-core `repo_service.rs`, `git.rs` (the folder
// classifier) and `daemon_client.rs` (`wait_for_daemon_gone`, `daemon_command`). Each function takes plain values and either
// returns or throws an Error whose message is the sentence the shell shows; `serve.ts` is the wire around them.
import { closeSync, type Dirent, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { applyCredentialChanges } from "../credentials.ts";
import { restoreBackup, verifyBackup } from "../domain/backup.ts";
import { laneLockPath, laneSockets, socketReachable, validateLane } from "../domain/ownership.ts";
import { git } from "../platform/git.ts";
import { writeOwnerOnly } from "../platform/fs.ts";
import { tryLockExclusive, type LockHandle } from "../platform/lock.ts";
import { spawnDetached } from "../platform/process.ts";

/** Directory listings stop here so a huge directory cannot stall the browse dialog. */
export const LIST_DIR_CAP = 2000;

const DID_NOT_SAY = "Git did not say why.";
const NOT_A_WORK_TREE = "This folder is a Git repository, but not a working tree. Alinery will not initialize a new repository here.";
const HAS_GIT_ENTRY = "This folder already has a Git entry that is not a usable checkout. Alinery will not initialize over it.";

const spoken = (detail: string) => detail.trim() || DID_NOT_SAY;
const withDetail = (sentence: string, detail: string) => `${sentence}\n${spoken(detail)}`;
const couldntInitialize = (path: string, detail: string) => `Couldn't initialize Git in ${path}.\n${spoken(detail)}`;

export type FolderClass = { kind: "checkout"; path: string } | { kind: "absent"; path: string } | { kind: "refused"; message: string };
export type InitResult = { kind: "initialized" | "already_checkout"; root: string };

type Probe = { ok: true; value: string } | { ok: false; rejected: boolean; detail: string };

/** One `git rev-parse` question. `rejected` is git running and saying no; otherwise git could not answer at all. */
async function revParse(path: string, flag: "--show-toplevel" | "--git-dir"): Promise<Probe> {
  if (path === "") return { ok: false, rejected: false, detail: "repo path is empty" };
  let result: Awaited<ReturnType<typeof git>>;
  try {
    result = await git(path, ["rev-parse", flag]);
  } catch (error) {
    return { ok: false, rejected: false, detail: `git rev-parse: ${(error as Error).message}` };
  }
  if (result.code !== 0) return { ok: false, rejected: true, detail: spoken(result.stderr) };
  const out = result.stdout.trim();
  if (out === "") return { ok: false, rejected: false, detail: flag === "--git-dir" ? "git returned an empty git dir" : `git returned an empty repo root for ${path}` };
  if (flag === "--git-dir") return { ok: true, value: out };
  try {
    return { ok: true, value: realpathSync(out) };
  } catch (error) {
    return { ok: false, rejected: false, detail: `canonicalize ${out}: ${(error as Error).message}` };
  }
}

/**
 * `classify_folder`: what a picked folder is, before any init or open. A failed `--show-toplevel` is not safe to init (a bare
 * repo and a checkout's `.git` directory both fail it, and `git init` there nests another repository), so only a folder with no
 * git entry at all is `absent`.
 */
export async function classifyFolder(path: string): Promise<FolderClass> {
  if (path === "") throw new Error(couldntInitialize(path, "repo path is empty"));
  // statSync follows symlinks, so a symlink to a directory is that directory; a broken one is missing.
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    throw new Error(couldntInitialize(path, "folder does not exist"));
  }
  if (!stat.isDirectory()) throw new Error(couldntInitialize(path, "path is not a directory"));

  const top = await revParse(path, "--show-toplevel");
  if (top.ok) return { kind: "checkout", path: top.value };
  if (!top.rejected) throw new Error(couldntInitialize(path, top.detail));

  // `--git-dir` before the filesystem check: a bare repo and a picked `.git` directory have no `.git` child.
  const gitDir = await revParse(path, "--git-dir");
  if (gitDir.ok) return { kind: "refused", message: withDetail(NOT_A_WORK_TREE, top.detail) };
  if (!gitDir.rejected) throw new Error(couldntInitialize(path, gitDir.detail));
  if (lstatExists(join(path, ".git"))) {
    return { kind: "refused", message: withDetail(HAS_GIT_ENTRY, top.detail !== DID_NOT_SAY ? top.detail : gitDir.detail) };
  }
  try {
    return { kind: "absent", path: realpathSync(path) };
  } catch (error) {
    throw new Error(couldntInitialize(path, `canonicalize ${path}: ${(error as Error).message}`));
  }
}

/** `symlink_metadata`, so a broken `.git` symlink still counts as an entry. */
function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `init_absent_folder`: re-classifies immediately before writing, so a folder that became a working tree while the confirm was
 * open is `already_checkout` and is not initialized again. A root that does not match the canonical directory is left alone.
 */
export async function initFolder(path: string): Promise<InitResult> {
  const class_ = await classifyFolder(path);
  if (class_.kind === "checkout") return { kind: "already_checkout", root: class_.path };
  if (class_.kind === "refused") throw new Error(class_.message);
  const canonical = class_.path;
  let init: Awaited<ReturnType<typeof git>>;
  try {
    init = await git(canonical, ["init"]);
  } catch (error) {
    throw new Error(couldntInitialize(canonical, `git init: ${(error as Error).message}`));
  }
  if (init.code !== 0) throw new Error(couldntInitialize(canonical, init.stderr));
  const top = await revParse(canonical, "--show-toplevel");
  if (!top.ok) throw new Error(couldntInitialize(canonical, top.detail));
  if (top.value !== canonical) throw new Error(couldntInitialize(canonical, `working tree root is ${top.value}, not ${canonical}`));
  return { kind: "initialized", root: top.value };
}

export type DirEntry = { name: string; git: boolean; symlink: boolean };
export type DirListing = { path: string; entries: DirEntry[]; truncated: boolean };

const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** Subdirectories of `path`, sorted by name (bytes, as Rust sorted them). Files are not listed: this feeds a folder picker. */
export function listDir(path: string, showHidden: boolean): DirListing {
  let names: Dirent[];
  try {
    names = readdirSync(path, { withFileTypes: true });
  } catch (error) {
    throw new Error(`read ${path}: ${(error as Error).message}`);
  }
  const entries: DirEntry[] = [];
  for (const entry of names) {
    if (!showHidden && entry.name.startsWith(".")) continue;
    const full = join(path, entry.name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      /* a broken link or a vanished entry is not a folder */
    }
    if (!isDir) continue;
    entries.push({ name: entry.name, git: existsSync(join(full, ".git")), symlink: entry.isSymbolicLink() });
  }
  entries.sort((a, b) => byteOrder(a.name, b.name));
  return { path, entries: entries.slice(0, LIST_DIR_CAP), truncated: entries.length > LIST_DIR_CAP };
}

/** Atomic, owner-only write; parent directories are created. */
export function writeFile(path: string, contents: string): void {
  const slash = path.lastIndexOf("/");
  if (slash <= 0) throw new Error(`${path} has no parent directory`);
  const parent = path.slice(0, slash);
  try {
    mkdirSync(parent, { recursive: true });
  } catch (error) {
    throw new Error(`create ${parent}: ${(error as Error).message}`);
  }
  writeOwnerOnly(path, contents);
}

/** Delete a file this app wrote earlier. A missing file is not an error. */
export function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`remove ${path}: ${(error as Error).message}`);
  }
}

/** The credential merge (credential_sync.rs `apply`). `set` values are each credential as JSON text. */
export async function syncCredentials(path: string, set: Record<string, string>, remove: string[], eraseOauth: boolean): Promise<string[]> {
  const parsed: Parameters<typeof applyCredentialChanges>[1] = {};
  for (const [provider, text] of Object.entries(set)) {
    try {
      parsed[provider] = JSON.parse(text);
    } catch {
      throw new Error(`the credential for ${provider} is not JSON`);
    }
  }
  return applyCredentialChanges(path, parsed, remove, eraseOauth);
}

/** The repo's GUI lock, which `claim_repo` holds locally: `<repo>/.alinery/.alinery-app.lock`. */
export const appLockPath = (repo: string) => join(repo, ".alinery", ".alinery-app.lock");

/** The repos this service process holds. The kernel lets every lock go when the process (the ssh channel) dies. */
export class Claims {
  private readonly held = new Map<string, LockHandle>();

  /** True when this process now holds the repo (or already did); false when another process does. */
  claim(repo: string): boolean {
    if (this.held.has(repo)) return true;
    try {
      mkdirSync(join(repo, ".alinery"), { recursive: true });
    } catch (error) {
      throw new Error(`prepare repository lock for ${repo}: ${(error as Error).message}`);
    }
    let lock: LockHandle | null;
    try {
      lock = tryLockExclusive(appLockPath(repo));
    } catch (error) {
      throw new Error(`lock repository ${repo}: ${(error as Error).message}`);
    }
    if (!lock) return false;
    this.held.set(repo, lock);
    return true;
  }

  release(repo: string): void {
    this.held.get(repo)?.release();
    this.held.delete(repo);
  }
}

/** The backup is checked before anything is stopped, so a refused archive costs the host no live session. */
export async function backupVerify(repo: string, archive: string): Promise<void> {
  await verifyBackup(repo, archive);
}

export async function backupRestore(repo: string, archive: string): Promise<void> {
  await restoreBackup(repo, archive);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `wait_for_daemon_gone` for the default lane: return once nothing answers on the daemon's socket and its process lock can be
 * taken. 5 s, because a daemon waits up to about 1.5 s for its job children before it exits. It stops nothing itself.
 */
export async function waitDaemonGone(repo: string, lane = "", budget = { attempts: 100, intervalMs: 50 }): Promise<void> {
  validateLane(lane);
  const root = join(repo, ".alinery");
  let rootStat: ReturnType<typeof lstatSync>;
  try {
    rootStat = lstatSync(root);
  } catch (error) {
    throw new Error(String((error as Error).message));
  }
  if (!rootStat.isDirectory()) throw new Error("cannot establish daemon exit: invalid ownership directory");
  const lockPath = laneLockPath(repo, lane);
  const sockets = laneSockets(repo, lane);
  for (let attempt = 0; attempt < budget.attempts; attempt++) {
    let before: ReturnType<typeof lstatSync> | undefined;
    try {
      before = lstatSync(lockPath);
      if (!before.isFile()) throw new Error("cannot establish daemon exit: invalid process lock path");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error instanceof Error && error.message.startsWith("cannot") ? error : new Error(`cannot establish daemon exit: ${error}`);
      before = undefined;
    }
    let reachable = false;
    for (const socketPath of sockets) {
      try {
        reachable = (await socketReachable(socketPath)) || reachable;
      } catch (error) {
        // A connection reset is the daemon closing its listener under the probe: it is still going, so look again.
        if (!String((error as Error).message).includes("ECONNRESET")) throw new Error(`cannot establish daemon exit: ${(error as Error).message}`);
        reachable = true;
      }
    }
    if (!reachable) {
      const lease = tryLockExclusive(lockPath);
      if (lease) {
        try {
          const after = lstatSync(lockPath);
          if (!after.isFile() || (before && (before.dev !== after.dev || before.ino !== after.ino))) throw new Error("cannot establish daemon exit: process lock changed");
        } finally {
          lease.release();
        }
        return;
      }
    }
    await sleep(budget.intervalMs);
  }
  throw new Error(`daemon for ${repo} lane ${JSON.stringify(lane)} has not released its socket and process lock`);
}

export type SpawnDaemonParams = {
  repo: string;
  appConfig: string;
  binary: string;
  buildId: string;
  namespace: string;
  log: string;
  launch: "direct" | "systemd_run";
  unit: string;
  rpcSecretFile: string;
  appVersion: string;
};

/** `login_shell_path`: a full $PATH from the user's `$SHELL -ilc`, the process's own PATH when the shell will not say. */
export async function loginShellPath(env: Record<string, string | undefined> = process.env): Promise<string> {
  const shell = env.SHELL || "/bin/sh";
  try {
    const child = Bun.spawn([shell, "-ilc", "echo -n $PATH"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: env as Record<string, string> });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code === 0 && out.trim() !== "") return out.trim();
  } catch {
    /* fall through */
  }
  return env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin";
}

/** The Grok key from the host's own `app.toml`; the daemon takes it from XAI_API_KEY. */
export function grokKey(appConfigPath: string): string {
  try {
    const config = Bun.TOML.parse(readFileSync(appConfigPath, "utf8")) as { global?: { experiments?: { grok_api_key?: unknown } } };
    const key = config.global?.experiments?.grok_api_key;
    return typeof key === "string" ? key.trim() : "";
  } catch {
    return "";
  }
}

/** The one recipe for launching the daemon on a host (`daemon_command`): its arguments, login-shell PATH, the Grok key, null stdio. */
export function daemonArguments(p: SpawnDaemonParams): string[] {
  const args = ["--repo", p.repo, "--app-config", p.appConfig, "--build-id", p.buildId, "--app-version", p.appVersion];
  if (p.namespace !== "") args.push("--socket-namespace", p.namespace);
  if (p.rpcSecretFile !== "") args.push("--rpc-secret-file", p.rpcSecretFile);
  return args;
}

/** Start the daemon so it outlives the ssh session that asked: its own session (setsid) or a transient systemd user unit. */
export async function spawnDaemon(p: SpawnDaemonParams, env: Record<string, string | undefined> = process.env): Promise<void> {
  const logDir = p.log.slice(0, p.log.lastIndexOf("/"));
  try {
    mkdirSync(logDir, { recursive: true });
  } catch (error) {
    throw new Error(`create ${logDir}: ${(error as Error).message}`);
  }
  let log: number;
  try {
    log = openSync(p.log, "a");
  } catch (error) {
    throw new Error(`open ${p.log}: ${(error as Error).message}`);
  }
  try {
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) if (value !== undefined) childEnv[key] = value;
    childEnv.PATH = await loginShellPath(env);
    delete childEnv.ALINERY_HOST_EXECUTABLE;
    const grok = grokKey(p.appConfig);
    if (grok !== "") childEnv.XAI_API_KEY = grok;
    const args = daemonArguments(p);
    if (p.launch === "direct") {
      let child: Bun.Subprocess;
      try {
        child = spawnDetached([p.binary, ...args], { env: childEnv, stdin: "ignore", stdout: log, stderr: log });
      } catch (error) {
        throw new Error(`spawn ${p.binary}: ${(error as Error).message}`);
      }
      // A daemon that lives on is not waited for, and must not keep this service's event loop alive after the channel closes.
      child.unref();
      return;
    }
    if (p.unit === "") throw new Error("systemd_run needs a unit name");
    // Only what the recipe sets travels to the unit; the unit's own environment is the user manager's, not this ssh session's.
    const setenv = Object.entries({ PATH: childEnv.PATH, ...(grok !== "" ? { XAI_API_KEY: grok } : {}) }).map(([key, value]) => `--setenv=${key}=${value}`);
    const run = Bun.spawn(["systemd-run", "--user", "--collect", "--quiet", `--unit=${p.unit}`, `--working-directory=${p.repo}`, ...setenv, "--", p.binary, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, code] = await Promise.all([new Response(run.stderr).text(), run.exited]);
    if (code !== 0) throw new Error(`systemd-run failed: ${stderr.trim()}`);
  } finally {
    closeSync(log);
  }
}
