// The playbook library (plan S4.6), ported from alinery-core `playbook_library.rs`: three scopes of definitions
// (bundled, compiled in; global, `<app config dir>/playbooks/<key>/playbook.md`; repo, `.alinery/playbooks/<key>/playbook.md`
// and the maintainers' committed files under `alinery/playbooks/`), the catalog of them, save and delete, and the picker
// preferences. Files are the registry; picker data is presentation, never definition lookup. The parser is the engine's
// (`playbook-md.ts`); this file only finds, reads and writes the files.
//
// Shapes follow the Rust serde JSON (snake_case, `null` for None) because the conformance cases compare them as that.
// A path is built by plain concatenation, never `path.join`: a key like `../x` must stay visible as the unsafe key it is.
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { type DocDiagnostic, type PlaybookDocument, parsePlaybookDocument, renderPlaybookMd, validPlaybookKey } from "playbook-engine/src/playbook-md.ts";
import { writeAtomic } from "../platform/fs.ts";
import { waitForLock } from "../platform/lock.ts";
import { BUNDLED_PLAYBOOKS } from "./bundledPlaybooks.ts";

export type Scope = "bundled" | "global" | "repo";
export type Ref = { scope: Scope; key: string };
/** `repoDir` is "" for global library management with no repository. */
export type Roots = { globalConfigDir: string; repoDir: string };
export type Source = { reference: Ref; path: string | null };
export type Scoped = { source: Source; definition: PlaybookDocument; source_text: string; modified_at_ms: number | null };
export type Candidate = { source: Source; title: string | null; description: string | null; modified_at_ms: number | null; diagnostics: DocDiagnostic[] };
export type PickerPreference = { reference: Ref; preferred: boolean; hidden: boolean; collapsed: boolean; badge: string | null; color: string | null; last_imported_at_ms: number | null };
export type PickerPreferences = { order: Ref[]; entries: PickerPreference[] };
export type Catalog = { candidates: Candidate[]; picker_preferences: PickerPreferences; diagnostics: DocDiagnostic[] };
export type LoadError = { kind: "unknown"; source: Source } | { kind: "invalid"; source: Source; diagnostics: DocDiagnostic[] } | { kind: "io"; source: Source; message: string };
export type SaveError =
  | { kind: "read_only"; reference: Ref }
  | { kind: "invalid"; diagnostics: DocDiagnostic[] }
  | { kind: "conflict"; source: Source }
  | { kind: "unknown"; source: Source }
  | { kind: "io"; message: string };

export class LoadFailure extends Error {
  constructor(readonly error: LoadError) {
    super(loadMessage(error));
  }
}
export class SaveFailure extends Error {
  constructor(readonly error: SaveError) {
    super(saveMessage(error));
  }
}
/** A failure with only a message: the Rust `Result<_, String>` paths. */
class Msg extends Error {}
const msg = (m: string): never => {
  throw new Msg(m);
};

const diag = (code: string, message: string, field: string | null = null): DocDiagnostic => ({ code, message, line: null, field, severity: "error" });
const diagnosticText = (ds: DocDiagnostic[]) => ds.map((d) => `; ${d.code}: ${d.message}`).join("");
const named = (s: Source) => `${s.reference.scope}/${s.reference.key}`;

function loadMessage(e: LoadError): string {
  if (e.kind === "unknown") return `unknown playbook ${named(e.source)}`;
  if (e.kind === "io") return `playbook ${named(e.source)}: ${e.message}`;
  return `invalid playbook ${named(e.source)}${diagnosticText(e.diagnostics)}`;
}
function saveMessage(e: SaveError): string {
  switch (e.kind) {
    case "read_only":
      return `bundled playbook ${e.reference.key} is read-only; save a global or repo copy`;
    case "conflict":
      return `playbook ${named(e.source)} already exists; explicit overwrite is required`;
    case "unknown":
      return `unknown playbook ${named(e.source)}`;
    case "io":
      return e.message;
    case "invalid":
      return `invalid playbook${diagnosticText(e.diagnostics)}`;
  }
}

/** core `app_config_dir_of`: the stable app config dir, not the directory of a development instance's `app.toml`. */
export function appConfigDirOf(appConfig: string): string {
  const dir = dirname(appConfig);
  const up = dirname(dir);
  return basename(up) === "instances" ? dirname(up) : dir;
}

const join = (base: string, ...parts: string[]) => [base, ...parts].reduce((a, b) => (a.endsWith("/") ? a + b : `${a}/${b}`));
const noRepo = (roots: Roots) => roots.repoDir === "";
const notFound = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";
const lstatOrNull = (path: string) => {
  try {
    return lstatSync(path);
  } catch (e) {
    if (notFound(e)) return null;
    throw e;
  }
};
const modifiedAt = (path: string): number | null => {
  try {
    return Math.floor(statSync(path).mtimeMs);
  } catch {
    return null;
  }
};
const ioText = (what: string, path: string, e: unknown) => `${what} ${path}: ${(e as Error)?.message ?? e}`;

function root(roots: Roots, scope: Scope): string | null {
  if (scope === "bundled") return null;
  if (scope === "global") return join(roots.globalConfigDir, "playbooks");
  return noRepo(roots) ? null : join(roots.repoDir, ".alinery/playbooks");
}
function sourceFor(roots: Roots, ref: Ref): Source {
  const base = root(roots, ref.scope);
  return { reference: ref, path: base === null ? null : join(base, ref.key, "playbook.md") };
}
const invalidKey = (key: string) => diag("invalid_key", `unsafe playbook key ${JSON.stringify(key)}`, "key");

/** core `validate_playbook_for_storage`: valid, a safe directory name, and the key its directory says. */
export function validateForStorage(pathKey: string, source: string): { ok: PlaybookDocument } | { errors: DocDiagnostic[] } {
  const parsed = parsePlaybookDocument(source);
  const safe = validPlaybookKey(pathKey);
  if (!parsed.document) return { errors: safe ? parsed.diagnostics : [...parsed.diagnostics, invalidKey(pathKey)] };
  if (!safe) return { errors: [invalidKey(pathKey)] };
  if (parsed.document.key !== pathKey) {
    return { errors: [diag("storage_key_mismatch", `directory key ${JSON.stringify(pathKey)} does not match declared key ${JSON.stringify(parsed.document.key)}`, "key")] };
  }
  return { ok: parsed.document };
}

// The explicit root is trusted. Everything beneath it that the library owns must be a real directory or file,
// never a link into another scope or arbitrary data.
function checkedDirectory(path: string, create: boolean): void {
  let st: ReturnType<typeof lstatSync> | null;
  try {
    st = lstatOrNull(path);
  } catch (e) {
    return msg(ioText("read", path, e));
  }
  if (st) {
    if (st.isDirectory() && !st.isSymbolicLink()) return;
    return msg(`${path} is not a regular directory`);
  }
  if (!create) return msg(ioText("read", path, new Error("No such file or directory")));
  try {
    mkdirSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return checkedDirectory(path, false);
    return msg(ioText("create", path, e));
  }
}

function checkedRoot(roots: Roots, scope: Scope, create: boolean): string {
  if (scope === "repo" && noRepo(roots)) return msg("repo-scoped playbooks require an active repository");
  if (scope === "bundled") return msg("bundled library is read-only");
  const base = scope === "global" ? roots.globalConfigDir : roots.repoDir;
  if (create) {
    try {
      mkdirSync(base, { recursive: true });
    } catch (e) {
      return msg(ioText("create", base, e));
    }
  }
  let path = base;
  if (scope === "repo") {
    path = join(path, ".alinery");
    checkedDirectory(path, create);
  }
  path = join(path, "playbooks");
  checkedDirectory(path, create);
  return path;
}

/** true for a regular file, false for none; a link or anything else is an error. */
function checkLeaf(path: string): boolean {
  let st: ReturnType<typeof lstatSync> | null;
  try {
    st = lstatOrNull(path);
  } catch (e) {
    return msg(ioText("read", path, e));
  }
  if (!st) return false;
  if (st.isFile() && !st.isSymbolicLink()) return true;
  return msg(`${path} is not a regular file`);
}

// Bundled bytes are compiled in. Global tombstones keep a deletion effective across repositories and upgrades.
function bundledDeleted(roots: Roots, key: string): boolean {
  const path = root(roots, "global") as string;
  if (lstatOrNull(path) === null) return false;
  checkedRoot(roots, "global", false);
  return checkLeaf(join(path, `.deleted-bundled-${key}`));
}

const committedRoot = (repo: string) => join(repo, "alinery", "playbooks");
const compareComponents = (a: string, b: string): number => {
  const [x, y] = [a.split("/"), b.split("/")];
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return x.length - y.length;
};
const compareStrings = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Maintainer-owned v2 files. The declared key is the identity; the filename is not. Links are skipped so one cannot
// escape the directory or claim a key twice.
function committedClaims(repo: string): [string, string][] {
  if (repo === "") return [];
  const top = committedRoot(repo);
  const st = lstatOrNull(top);
  if (!st) return [];
  if (st.isSymbolicLink() || !st.isDirectory()) return msg(`${top} is not a regular directory`);
  const found: [string, string][] = [];
  const pending = [top];
  while (pending.length) {
    const dir = pending.pop() as string;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return msg(ioText("read", dir, e));
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
        } catch {
          continue;
        }
        const parsed = parsePlaybookDocument(text);
        if (parsed.document && validPlaybookKey(parsed.document.key)) found.push([parsed.document.key, path]);
      }
    }
  }
  return found.sort((a, b) => compareStrings(a[0], b[0]) || compareComponents(a[1], b[1]));
}

const duplicateKey = (key: string, paths: string[]) => diag("duplicate_key", `repo/${key} is declared by ${paths.join("; ")}; not selecting one`, "key");

type RepoClaim = { kind: "missing" } | { kind: "library" } | { kind: "committed"; path: string } | { kind: "duplicate"; paths: string[] };
function repoClaim(roots: Roots, key: string): RepoClaim {
  const library = join(root(roots, "repo") as string, key, "playbook.md");
  let paths: string[] = [];
  if (checkLeaf(library)) paths.push(library);
  for (const [found, path] of committedClaims(roots.repoDir)) if (found === key) paths.push(path);
  paths = [...new Set(paths.sort(compareComponents))];
  if (paths.length === 0) return { kind: "missing" };
  if (paths.length === 1) return paths[0] === library ? { kind: "library" } : { kind: "committed", path: paths[0] };
  return { kind: "duplicate", paths };
}

function readRegularFile(path: string): { text: string; modified: number | null } {
  if (!checkLeaf(path)) return msg(`${path} is not a regular file`);
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path)), modified: modifiedAt(path) };
  } catch (e) {
    return msg(ioText("read", path, e));
  }
}

function scoped(source: Source, key: string, text: string, modified: number | null): Scoped {
  const checked = validateForStorage(key, text);
  if ("errors" in checked) throw new LoadFailure({ kind: "invalid", source, diagnostics: checked.errors });
  return { source, definition: checked.ok, source_text: text, modified_at_ms: modified };
}

/** core `resolve_playbook`: throws `LoadFailure`. */
export function resolvePlaybook(roots: Roots, ref: Ref): Scoped {
  const source = sourceFor(roots, ref);
  const io = (e: unknown): never => {
    throw new LoadFailure({ kind: "io", source, message: e instanceof Msg ? e.message : String(e) });
  };
  if (!validPlaybookKey(ref.key)) throw new LoadFailure({ kind: "invalid", source, diagnostics: [invalidKey(ref.key)] });
  if (ref.scope === "repo" && noRepo(roots)) return io(new Msg("repo-scoped playbooks require an active repository"));
  if (ref.scope === "repo") {
    let claim: RepoClaim;
    try {
      claim = repoClaim(roots, ref.key);
    } catch (e) {
      return io(e);
    }
    if (claim.kind === "duplicate") throw new LoadFailure({ kind: "invalid", source, diagnostics: [duplicateKey(ref.key, claim.paths)] });
    if (claim.kind === "committed") {
      let read: { text: string; modified: number | null };
      try {
        read = readRegularFile(claim.path);
      } catch (e) {
        return io(e);
      }
      return scoped({ reference: ref, path: claim.path }, ref.key, read.text, read.modified);
    }
  }
  let text: string;
  let modified: number | null = null;
  if (ref.scope === "bundled") {
    const bundled = BUNDLED_PLAYBOOKS.find(([key]) => key === ref.key);
    if (!bundled) throw new LoadFailure({ kind: "unknown", source });
    let deleted: boolean;
    try {
      deleted = bundledDeleted(roots, ref.key);
    } catch (e) {
      return io(e);
    }
    if (deleted) throw new LoadFailure({ kind: "unknown", source });
    text = bundled[1];
  } else {
    const path = source.path as string;
    try {
      // Check parents before probing the leaf; never traverse a scope link.
      const expectedRoot = root(roots, ref.scope) as string;
      const directory = dirname(path);
      let absent = lstatOrNull(expectedRoot) === null;
      if (!absent) {
        checkedRoot(roots, ref.scope, false);
        absent = lstatOrNull(directory) === null;
      }
      if (!absent) {
        checkedDirectory(directory, false);
        absent = !checkLeaf(path);
      }
      if (absent) throw new LoadFailure({ kind: "unknown", source });
      text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
      modified = modifiedAt(path);
    } catch (e) {
      if (e instanceof LoadFailure) throw e;
      return io(e instanceof Msg ? e : new Msg(ioText("read", path, e)));
    }
  }
  return scoped(source, ref.key, text, modified);
}

const SCOPE_ORDER: Record<Scope, number> = { bundled: 0, global: 1, repo: 2 };
const compareRefs = (a: Ref, b: Ref) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || compareStrings(a.key, b.key);

/** core `load_playbook_catalog`: never throws; what cannot be read becomes a diagnostic. `resolved` sees each definition that parsed
 * (the projector takes its steps and hash from it without a second read; the conformance shape stays the Rust one). */
export function loadCatalog(roots: Roots, resolved?: (found: Scoped) => void): Catalog {
  const references: Ref[] = BUNDLED_PLAYBOOKS.map(([key]) => ({ scope: "bundled", key }));
  const diagnostics: DocDiagnostic[] = [];
  for (const scope of ["global", "repo"] as const) {
    const path = root(roots, scope);
    if (path === null || lstatOrNull(path) === null) continue;
    try {
      checkedRoot(roots, scope, false);
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(path, { withFileTypes: true });
      } catch (e) {
        return msg(ioText("read", path, e));
      }
      for (const entry of entries) {
        // Legacy flat prompts and picker/lock files are not candidates.
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (lstatOrNull(join(path, entry.name, "playbook.md")) !== null || entry.isSymbolicLink()) references.push({ scope, key: entry.name });
      }
    } catch (e) {
      diagnostics.push(diag("library_io", e instanceof Msg ? e.message : String(e)));
    }
  }
  if (!noRepo(roots)) {
    try {
      const seen = new Set(references.filter((r) => r.scope === "repo").map((r) => r.key));
      for (const [key] of committedClaims(roots.repoDir)) if (!seen.has(key)) (seen.add(key), references.push({ scope: "repo", key }));
    } catch (e) {
      diagnostics.push(diag("library_io", e instanceof Msg ? e.message : String(e)));
    }
  }
  references.sort(compareRefs);
  const candidates: Candidate[] = [];
  for (const reference of references) {
    const source = sourceFor(roots, reference);
    try {
      const found = resolvePlaybook(roots, reference);
      resolved?.(found);
      candidates.push({ source: found.source, title: found.definition.title, description: found.definition.description, modified_at_ms: found.modified_at_ms, diagnostics: [] });
    } catch (e) {
      if (!(e instanceof LoadFailure)) throw e;
      const error = e.error;
      if (error.kind === "unknown" && reference.scope === "bundled") continue;
      const ds =
        error.kind === "invalid" ? error.diagnostics : error.kind === "io" ? [diag("library_io", error.message)] : [diag("unknown_playbook", "playbook disappeared during discovery")];
      candidates.push({ source, title: null, description: null, modified_at_ms: source.path === null ? null : modifiedAt(source.path), diagnostics: ds });
    }
  }
  let picker_preferences: PickerPreferences = { order: [], entries: [] };
  try {
    picker_preferences = loadPicker(roots);
  } catch (e) {
    diagnostics.push(diag("picker_preferences", e instanceof Msg ? e.message : String(e)));
  }
  return { candidates, picker_preferences, diagnostics };
}

// ---- writes ---------------------------------------------------------------------------------------------------------

const queue = new Map<string, Promise<unknown>>(); // serializes the writers of one process, as the Rust thread mutex does
const LOCK_WAIT_MS = 30_000;

/** The library's mutation lock: a process queue, then the flock on `<root>/.mutation.lock` (the same file the Rust writers take). */
async function withLibraryLock<T>(roots: Roots, scope: Scope, mutate: (root: string) => T): Promise<T> {
  const previous = queue.get("library") ?? Promise.resolve();
  const run = previous
    .catch(() => {})
    .then(async () => {
      let base: string;
      let lock: Awaited<ReturnType<typeof waitForLock>>;
      try {
        base = checkedRoot(roots, scope, true);
        const lockPath = join(base, ".mutation.lock");
        checkLeaf(lockPath);
        lock = await waitForLock(lockPath, LOCK_WAIT_MS);
        if (!lock) return msg(`playbook library busy: ${lockPath}`);
      } catch (e) {
        throw new SaveFailure({ kind: "io", message: e instanceof Msg ? e.message : String(e) });
      }
      try {
        return mutate(base);
      } finally {
        lock.release();
      }
    });
  queue.set("library", run);
  return run;
}

/** The machine's library lock, for a read-modify-write of a file beside the global playbooks. */
export const withGlobalLibraryLock = <T>(roots: Roots, mutate: () => T): Promise<T> => withLibraryLock(roots, "global", () => mutate());

/** core `with_repo_library_lock`: `mutate` runs under the repository library's lock, so a read-modify-write of a file beside the playbooks is whole. */
export const withRepoLibraryLock = <T>(roots: Roots, mutate: () => T): Promise<T> => withLibraryLock(roots, "repo", () => mutate());

const ioSave = (e: unknown): never => {
  if (e instanceof SaveFailure) throw e;
  throw new SaveFailure({ kind: "io", message: e instanceof Msg ? e.message : String(e) });
};

/**
 * core `save_playbook`. `overwrite: false` refuses an existing file (conflict). `expected` is the file's bytes as the caller last saw
 * them (`null`: none), re-checked under the lock; omitted, nothing is checked. Throws `SaveFailure`.
 */
export async function savePlaybook(roots: Roots, target: Ref, sourceText: string, overwrite: boolean, expected?: Uint8Array | null): Promise<Scoped> {
  if (target.scope === "bundled") throw new SaveFailure({ kind: "read_only", reference: target });
  const checked = validateForStorage(target.key, sourceText);
  if ("errors" in checked) throw new SaveFailure({ kind: "invalid", diagnostics: checked.errors });
  const canonical = renderPlaybookMd(checked.ok);
  const source = sourceFor(roots, target);
  return withLibraryLock(roots, target.scope, (base) => {
    try {
      const directory = join(base, target.key);
      const path = join(directory, "playbook.md");
      const exists = checkLeaf(path);
      if (target.scope === "repo" && !exists) {
        const paths = committedClaims(roots.repoDir)
          .filter(([key]) => key === target.key)
          .map(([, p]) => p);
        if (paths.length) throw new SaveFailure({ kind: "invalid", diagnostics: [duplicateKey(target.key, paths)] });
      }
      checkedDirectory(directory, true);
      if (exists && !overwrite) throw new SaveFailure({ kind: "conflict", source });
      // What the caller saw before its network work (`save_playbook_if_unchanged`): a file that appeared, vanished or changed is a conflict.
      if (expected !== undefined) {
        const now = exists ? readFileSync(path) : null;
        if (expected === null ? now !== null : now === null || Buffer.compare(now, expected) !== 0) throw new SaveFailure({ kind: "conflict", source });
      }
      writeAtomic(path, canonical);
      return { source, definition: checked.ok, source_text: canonical, modified_at_ms: modifiedAt(path) };
    } catch (e) {
      return ioSave(e);
    }
  });
}

/** core `delete_playbook`. A bundled playbook is hidden by a tombstone in the global scope; a file's directory is removed only if empty. */
export async function deletePlaybook(roots: Roots, ref: Ref): Promise<void> {
  if (!validPlaybookKey(ref.key)) throw new SaveFailure({ kind: "invalid", diagnostics: [invalidKey(ref.key)] });
  const source = sourceFor(roots, ref);
  if (ref.scope === "bundled") {
    if (!BUNDLED_PLAYBOOKS.some(([key]) => key === ref.key)) throw new SaveFailure({ kind: "unknown", source });
    return withLibraryLock(roots, "global", (base) => {
      try {
        const path = join(base, `.deleted-bundled-${ref.key}`);
        checkLeaf(path);
        writeAtomic(path, "");
      } catch (e) {
        ioSave(e);
      }
    });
  }
  return withLibraryLock(roots, ref.scope, (base) => {
    try {
      const directory = join(base, ref.key);
      if (lstatOrNull(directory) === null) throw new SaveFailure({ kind: "unknown", source });
      checkedDirectory(directory, false);
      const path = join(directory, "playbook.md");
      if (!checkLeaf(path)) throw new SaveFailure({ kind: "unknown", source });
      rmSync(path);
      // Only remove an empty directory. Never recursively delete user material.
      try {
        rmdirSync(directory);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOTEMPTY" && (e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    } catch (e) {
      ioSave(e);
    }
  });
}

/** The bundled playbooks a global tombstone hides, with the title each ships with. */
export function hiddenBundled(roots: Roots): { key: string; title: string }[] {
  return BUNDLED_PLAYBOOKS.filter(([key]) => {
    try {
      return bundledDeleted(roots, key);
    } catch {
      return false;
    }
  }).map(([key, text]) => ({ key, title: parsePlaybookDocument(text).document?.title ?? key }));
}

/** Undoes `deletePlaybook` of a bundled playbook: its tombstone goes. No tombstone is nothing to do. */
export async function restoreBundled(roots: Roots, key: string): Promise<void> {
  if (!BUNDLED_PLAYBOOKS.some(([k]) => k === key)) throw new SaveFailure({ kind: "unknown", source: sourceFor(roots, { scope: "bundled", key }) });
  return withLibraryLock(roots, "global", (base) => {
    try {
      const path = join(base, `.deleted-bundled-${key}`);
      if (checkLeaf(path)) rmSync(path);
    } catch (e) {
      ioSave(e);
    }
  });
}

// ---- picker preferences ---------------------------------------------------------------------------------------------

const SCOPES = new Set<string>(["bundled", "global", "repo"]);
const refId = (r: Ref) => `${r.scope}\u0000${r.key}`;

function validatePreferences(p: PickerPreferences): void {
  const order = new Set<string>();
  for (const r of p.order) if (!validPlaybookKey(r.key) || order.has(refId(r)) || !order.add(refId(r))) msg("picker order contains an invalid or duplicate scoped reference");
  const entries = new Set<string>();
  for (const e of p.entries) {
    if (!validPlaybookKey(e.reference.key) || entries.has(refId(e.reference)) || !entries.add(refId(e.reference))) msg("picker metadata contains an invalid or duplicate scoped reference");
    if (e.last_imported_at_ms !== null && e.reference.scope !== "global") msg("last-imported metadata applies only to global playbooks");
  }
}

// serde with `deny_unknown_fields`: an unknown key, a wrong type or a missing required field refuses the file.
type Obj = Record<string, unknown>;
function strict(value: unknown, what: string, fields: string[]): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return msg(`invalid type: expected ${what} table`);
  for (const key of Object.keys(value)) if (!fields.includes(key)) msg(`unknown field \`${key}\`, expected one of ${fields.map((f) => `\`${f}\``).join(", ")}`);
  return value as Obj;
}
function decodeRef(value: unknown): Ref {
  const o = strict(value, "playbook reference", ["scope", "key"]);
  if (typeof o.scope !== "string" || !SCOPES.has(o.scope)) return msg("unknown variant of playbook scope");
  if (typeof o.key !== "string") return msg("missing field `key`");
  return { scope: o.scope as Scope, key: o.key };
}
function flag(o: Obj, key: string): boolean {
  if (o[key] === undefined) return false;
  return typeof o[key] === "boolean" ? (o[key] as boolean) : msg(`invalid type: ${key} must be a boolean`);
}
function optionalString(o: Obj, key: string): string | null {
  if (o[key] === undefined || o[key] === null) return null;
  return typeof o[key] === "string" ? (o[key] as string) : msg(`invalid type: ${key} must be a string`);
}
/** serde `PickerPreferences` over parsed TOML or JSON: unknown keys, wrong types and missing required fields refuse the value. */
export function decodePickerPreferences(value: unknown): PickerPreferences {
  const o = strict(value, "picker preferences", ["order", "entries"]);
  const list = (v: unknown, what: string): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : msg(`invalid type: ${what} must be an array`));
  return {
    order: list(o.order, "order").map(decodeRef),
    entries: list(o.entries, "entries").map((entry) => {
      const e = strict(entry, "picker entry", ["reference", "preferred", "hidden", "collapsed", "badge", "color", "last_imported_at_ms"]);
      if (e.reference === undefined) return msg("missing field `reference`");
      const at = e.last_imported_at_ms;
      if (at !== undefined && at !== null && !((typeof at === "number" && Number.isSafeInteger(at) && at >= 0) || typeof at === "bigint")) msg("invalid type: last_imported_at_ms must be an unsigned integer");
      return {
        reference: decodeRef(e.reference),
        preferred: flag(e, "preferred"),
        hidden: flag(e, "hidden"),
        collapsed: flag(e, "collapsed"),
        badge: optionalString(e, "badge"),
        color: optionalString(e, "color"),
        last_imported_at_ms: at === undefined || at === null ? null : Number(at),
      };
    }),
  };
}

const pickerScope = (roots: Roots): Scope => (noRepo(roots) ? "global" : "repo");

/** core `load_picker_preferences`: a repository's own file, or the global one when there is no repository. Throws a plain message. */
export function loadPicker(roots: Roots): PickerPreferences {
  const empty: PickerPreferences = { order: [], entries: [] };
  const scope = pickerScope(roots);
  if (scope === "repo") {
    const directory = join(roots.repoDir, ".alinery");
    if (lstatOrNull(directory) === null) return empty;
    checkedDirectory(directory, false);
  }
  const path = join(root(roots, scope) as string, "picker.toml");
  if (lstatOrNull(dirname(path)) === null) return empty;
  checkedRoot(roots, scope, false);
  if (!checkLeaf(path)) return empty;
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return msg(ioText("parse", path, e));
  }
  let preferences: PickerPreferences;
  try {
    preferences = decodePickerPreferences(parsed);
  } catch (e) {
    return msg(ioText("parse", path, e));
  }
  validatePreferences(preferences);
  return preferences;
}

const pickerToml = (p: PickerPreferences): string =>
  Bun.TOML.stringify({
    order: p.order.map((r) => ({ scope: r.scope, key: r.key })),
    entries: p.entries.map((e) => ({
      preferred: e.preferred,
      hidden: e.hidden,
      collapsed: e.collapsed,
      ...(e.badge === null ? {} : { badge: e.badge }),
      ...(e.color === null ? {} : { color: e.color }),
      ...(e.last_imported_at_ms === null ? {} : { last_imported_at_ms: e.last_imported_at_ms }),
      reference: { scope: e.reference.scope, key: e.reference.key },
    })),
  });

/** core `save_picker_preferences`. Throws `SaveFailure`. */
export async function savePicker(roots: Roots, preferences: PickerPreferences): Promise<void> {
  try {
    validatePreferences(preferences);
  } catch (e) {
    return ioSave(e);
  }
  const text = pickerToml(preferences);
  return withLibraryLock(roots, pickerScope(roots), (base) => {
    try {
      const path = join(base, "picker.toml");
      checkLeaf(path);
      writeAtomic(path, text);
    } catch (e) {
      ioSave(e);
    }
  });
}
