// The community import registry (plan S4.10), ported from the app's `community_playbooks.rs`: which community playbooks this
// repository downloaded, at what version, and whether the local copy still matches what was imported. The registry is
// `community-imports.toml` beside the playbooks it describes (the repository's `.alinery/playbooks/`, or the machine's global
// library for a download kept for every repository), so its read-modify-write runs under that library's lock. Beside it,
// `community-published.toml` links the person's own listings to the playbook each was published from. The shell downloads a package with this machine's account and stages it; these functions put it where the host that
// owns the repository keeps its playbooks. A refusal the person can act on is a result, not a throw.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { type DocDiagnostic, parsePlaybookDocument, validPlaybookKey } from "playbook-engine/src/playbook-md.ts";
import { writeAtomic } from "../platform/fs.ts";
import { deletePlaybook, type Ref, type Roots, SaveFailure, savePlaybook, withGlobalLibraryLock, withRepoLibraryLock } from "./playbookLibrary.ts";

export type ImportRecord = {
  id: string;
  label: string;
  playbook_key: string;
  local_scope: string;
  local_key: string;
  imported_version: number;
  local_sha256: string;
  imported_at: string;
};

export type Outcome =
  | { kind: "saved"; reference: Ref; importedVersion: number; localSha256: string }
  | { kind: "conflict"; localKey: string }
  | { kind: "already_downloaded" }
  | { kind: "edited" }
  | { kind: "invalid"; diagnostics: DocDiagnostic[] }
  | { kind: "failed"; message: string };

export type Package = { document: string; version: number; label: string; playbookKey: string };

/** Where a download can live: this repository, or the machine's library for every repository. */
export type LocalScope = "repo" | "global";
const SCOPES: LocalScope[] = ["repo", "global"];
const libraryDir = (roots: Roots, scope: LocalScope) => (scope === "repo" ? `${roots.repoDir}/.alinery/playbooks` : `${roots.globalConfigDir}/playbooks`);
const usable = (roots: Roots, scope: LocalScope) => scope === "global" || roots.repoDir !== "";
const registryAt = (roots: Roots, scope: LocalScope) => `${libraryDir(roots, scope)}/community-imports.toml`;
const playbookPath = (roots: Roots, scope: LocalScope, key: string) => `${libraryDir(roots, scope)}/${key}/playbook.md`;
const locked = <T>(roots: Roots, scope: LocalScope, mutate: () => T) => (scope === "repo" ? withRepoLibraryLock(roots, mutate) : withGlobalLibraryLock(roots, mutate));
export const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

const FIELDS = ["id", "label", "playbook_key", "local_scope", "local_key", "imported_version", "local_sha256", "imported_at"] as const;
const NOT_FOUND = "Playbook not found.";

/** A canonical publication id: 36 characters, lowercase hex in the 8-4-4-4-12 groups. */
export const publicationId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);

const utcNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/** core `read_community_imports`: no file is no records; a file that is not exactly this shape is an error naming it. */
function readRegistry(path: string): ImportRecord[] {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`read ${path}: ${(e as Error).message}`);
  }
  const invalid = () => new Error(`invalid ${path}`);
  let value: unknown;
  try {
    value = Bun.TOML.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalid();
  }
  const file = value as Record<string, unknown>;
  if (typeof file !== "object" || file === null || Object.keys(file).some((k) => k !== "import")) throw invalid();
  const list = file.import ?? [];
  if (!Array.isArray(list)) throw invalid();
  return list.map((entry) => {
    const r = entry as Record<string, unknown>;
    if (typeof r !== "object" || r === null || Object.keys(r).some((k) => !(FIELDS as readonly string[]).includes(k))) throw invalid();
    for (const f of FIELDS) {
      const v = r[f];
      if (f === "imported_version" ? typeof v !== "number" && typeof v !== "bigint" : typeof v !== "string") throw invalid();
    }
    return { ...(r as ImportRecord), imported_version: Number(r.imported_version) };
  });
}

function writeRegistry(path: string, records: ImportRecord[]): void {
  writeAtomic(path, Bun.TOML.stringify({ import: records }));
}

/** Every record in both registries; one that cannot be read throws, naming its file. */
function allRecords(roots: Roots): ImportRecord[] {
  return SCOPES.filter((scope) => usable(roots, scope)).flatMap((scope) => readRegistry(registryAt(roots, scope)));
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The registry write runs under the library lock, so concurrent imports cannot each read one list and drop the other's record. */
function recordImport(roots: Roots, scope: LocalScope, record: ImportRecord): Promise<void> {
  return locked(roots, scope, () => {
    const path = registryAt(roots, scope);
    const records = readRegistry(path).filter((r) => r.id !== record.id && r.local_key !== record.local_key);
    records.push(record);
    writeRegistry(path, records);
  });
}

/** Drops the records `drop` picks from one registry, if any; the file is rewritten only when one went. */
async function forget(roots: Roots, scope: LocalScope, drop: (r: ImportRecord) => boolean): Promise<void> {
  try {
    readRegistry(registryAt(roots, scope));
    await locked(roots, scope, () => {
      const path = registryAt(roots, scope);
      if (!existsSync(path)) return;
      const records = readRegistry(path);
      const kept = records.filter((r) => !drop(r));
      if (kept.length !== records.length) writeRegistry(path, kept);
    });
  } catch (e) {
    if (e instanceof SaveFailure) throw e;
    throw new SaveFailure({ kind: "io", message: messageOf(e) });
  }
}

/** A playbook's record goes before its definition does. A registry that cannot be read stops the delete (`forget_import_before_delete`). */
export const forgetImportBeforeDelete = (roots: Roots, key: string, scope: LocalScope = "repo") => forget(roots, scope, (r) => r.local_key === key);

/** Keep as mine: the record goes and the file stays, so the playbook is no longer a download. An unknown id is nothing to do. */
export async function forgetImport(roots: Roots, id: string): Promise<void> {
  for (const scope of SCOPES) if (usable(roots, scope)) await forget(roots, scope, (r) => r.id === id);
}

const readFileOrNull = (path: string): Buffer | null => {
  try {
    return lstatSync(path).isFile() ? readFileSync(path) : null;
  } catch {
    return null;
  }
};

async function restoreOrDelete(roots: Roots, scope: LocalScope, key: string, previous: Buffer | null): Promise<void> {
  try {
    if (previous) {
      writeAtomic(playbookPath(roots, scope, key), previous);
      return;
    }
    await deletePlaybook(roots, { scope, key });
  } catch {}
}

async function save(roots: Roots, scope: LocalScope, key: string, document: string, previous: Buffer | null): Promise<{ sourceText: string } | Outcome> {
  try {
    const saved = await savePlaybook(roots, { scope, key }, document, true, previous);
    return { sourceText: saved.source_text };
  } catch (e) {
    if (!(e instanceof SaveFailure)) return { kind: "failed", message: messageOf(e) };
    const err = e.error;
    if (err.kind === "invalid") return { kind: "invalid", diagnostics: err.diagnostics };
    if (err.kind === "conflict") return { kind: "conflict", localKey: err.source.reference.key };
    return { kind: "failed", message: err.kind === "io" ? err.message : e.message };
  }
}

async function finish(roots: Roots, scope: LocalScope, pkg: Package, key: string, id: string, sourceText: string, previous: Buffer | null): Promise<Outcome> {
  const localSha256 = sha256(sourceText);
  const record: ImportRecord = { id, label: pkg.label, playbook_key: pkg.playbookKey, local_scope: scope, local_key: key, imported_version: pkg.version, local_sha256: localSha256, imported_at: utcNow() };
  try {
    await recordImport(roots, scope, record);
  } catch (e) {
    await restoreOrDelete(roots, scope, key, previous);
    return { kind: "failed", message: messageOf(e) };
  }
  return { kind: "saved", reference: { scope, key }, importedVersion: pkg.version, localSha256 };
}

const unusable = (pkg: Package) => !Number.isSafeInteger(pkg.version) || pkg.version < 1;

export async function importCommunityPlaybook(roots: Roots, id: string, pkg: Package, overwrite: boolean, scope: LocalScope = "repo"): Promise<Outcome> {
  if (!publicationId(id) || unusable(pkg)) return { kind: "failed", message: NOT_FOUND };
  if (!usable(roots, scope)) return { kind: "failed", message: "repo-scoped playbooks require an active repository" };
  let records: ImportRecord[];
  try {
    records = allRecords(roots);
  } catch (e) {
    return { kind: "failed", message: messageOf(e) };
  }
  if (records.some((r) => r.id === id)) return { kind: "already_downloaded" };
  const parsed = parsePlaybookDocument(pkg.document);
  if (!parsed.document) return { kind: "invalid", diagnostics: parsed.diagnostics };
  const key = parsed.document.key;
  const previous = readFileOrNull(playbookPath(roots, scope, key));
  if (previous && !overwrite) return { kind: "conflict", localKey: key };
  const saved = await save(roots, scope, key, pkg.document, previous);
  if (!("sourceText" in saved)) return saved;
  return finish(roots, scope, pkg, key, id, saved.sourceText, previous);
}

export async function updateCommunityImport(roots: Roots, id: string, pkg: Package, overwriteEdited: boolean): Promise<Outcome> {
  if (!publicationId(id) || unusable(pkg)) return { kind: "failed", message: NOT_FOUND };
  let record: ImportRecord | undefined;
  try {
    record = allRecords(roots).find((r) => r.id === id);
  } catch (e) {
    return { kind: "failed", message: messageOf(e) };
  }
  if (!record) return { kind: "failed", message: NOT_FOUND };
  const scope: LocalScope = record.local_scope === "global" ? "global" : "repo";
  const previous = validPlaybookKey(record.local_key) ? readFileOrNull(playbookPath(roots, scope, record.local_key)) : null;
  if (previous && sha256(previous) !== record.local_sha256 && !overwriteEdited) return { kind: "edited" };
  const parsed = parsePlaybookDocument(pkg.document);
  if (!parsed.document) return { kind: "invalid", diagnostics: parsed.diagnostics };
  const saved = await save(roots, scope, record.local_key, pkg.document, previous);
  if (!("sourceText" in saved)) {
    // The local copy changed while the package was in flight: the person has not approved replacing that edit, so it is the same
    // question the check before the download asks.
    return saved.kind === "conflict" ? { kind: "edited" } : saved;
  }
  return finish(roots, scope, pkg, record.local_key, id, saved.sourceText, previous);
}

/** What the registry says, with what the local files say about each record (the `playbook/_/community` row). */
export type RegistryRow = ImportRecord & { local_missing: boolean; locally_edited: boolean };

export function registryRows(roots: Roots): { rows: RegistryRow[]; error: string } {
  let records: ImportRecord[];
  try {
    records = allRecords(roots);
  } catch (e) {
    return { rows: [], error: messageOf(e) };
  }
  return {
    error: "",
    rows: records.map((r) => {
      const scope: LocalScope = r.local_scope === "global" ? "global" : "repo";
      const bytes = validPlaybookKey(r.local_key) ? readFileOrNull(playbookPath(roots, scope, r.local_key)) : null;
      return { ...r, local_missing: bytes === null, locally_edited: bytes !== null && sha256(bytes) !== r.local_sha256 };
    }),
  };
}

// ---- the person's own listings --------------------------------------------------------------------------------------

export type Publication = { id: string; reference: { scope: LocalScope; key: string } };
const publishedAt = (roots: Roots, scope: LocalScope) => `${libraryDir(roots, scope)}/community-published.toml`;

/** No file is no links; a file that is not `[[publication]]` rows of `id` and `key` is an error naming it. */
function readPublished(path: string): { id: string; key: string }[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`read ${path}: ${messageOf(e)}`);
  }
  let file: Record<string, unknown>;
  try {
    file = Bun.TOML.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`invalid ${path}`);
  }
  const list = file.publication ?? [];
  if (!Array.isArray(list) || list.some((r) => typeof r?.id !== "string" || typeof r?.key !== "string")) throw new Error(`invalid ${path}`);
  return list.map((r) => ({ id: r.id, key: r.key }));
}

/** Every link in both scopes; a file that cannot be read is left out (the rows then fall back to matching by key). */
export function publications(roots: Roots): Publication[] {
  return SCOPES.filter((scope) => usable(roots, scope)).flatMap((scope) => {
    try {
      return readPublished(publishedAt(roots, scope)).map((r) => ({ id: r.id, reference: { scope, key: r.key } }));
    } catch {
      return [];
    }
  });
}

/** Links listing `id` to `reference`, replacing any other link of that id or of that playbook; `null` only forgets the id. */
export async function recordPublication(roots: Roots, id: string, reference: Ref | null): Promise<void> {
  if (!publicationId(id)) throw new SaveFailure({ kind: "io", message: NOT_FOUND });
  if (reference && (reference.scope === "bundled" || !validPlaybookKey(reference.key) || !usable(roots, reference.scope)))
    throw new SaveFailure({ kind: "io", message: `cannot link a listing to ${reference.scope}/${reference.key}` });
  for (const scope of SCOPES) {
    if (!usable(roots, scope)) continue;
    const target = reference?.scope === scope ? reference.key : null;
    const path = publishedAt(roots, scope);
    if (target === null && !existsSync(path)) continue;
    try {
      await locked(roots, scope, () => {
        const rows = readPublished(path).filter((r) => r.id !== id && r.key !== target);
        if (target !== null) rows.push({ id, key: target });
        writeAtomic(path, Bun.TOML.stringify({ publication: rows }));
      });
    } catch (e) {
      if (e instanceof SaveFailure) throw e;
      throw new SaveFailure({ kind: "io", message: messageOf(e) });
    }
  }
}
