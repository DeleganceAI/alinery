// The community import registry (plan S4.10), ported from the app's `community_playbooks.rs`: which community playbooks this
// repository downloaded, at what version, and whether the local copy still matches what was imported. The registry is
// `.alinery/playbooks/community-imports.toml`, beside the playbooks it describes, so its read-modify-write runs under the repository
// library's lock. The shell downloads a package with this machine's account and stages it; these functions put it where the host that
// owns the repository keeps its playbooks. A refusal the person can act on is a result, not a throw.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { type DocDiagnostic, parsePlaybookDocument, validPlaybookKey } from "playbook-engine/src/playbook-md.ts";
import { writeAtomic } from "../platform/fs.ts";
import { deletePlaybook, type Ref, type Roots, SaveFailure, savePlaybook, withRepoLibraryLock } from "./playbookLibrary.ts";

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

export const registryPath = (repo: string) => `${repo}/.alinery/playbooks/community-imports.toml`;
const playbookPath = (repo: string, key: string) => `${repo}/.alinery/playbooks/${key}/playbook.md`;
export const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

const FIELDS = ["id", "label", "playbook_key", "local_scope", "local_key", "imported_version", "local_sha256", "imported_at"] as const;
const NOT_FOUND = "Playbook not found.";

/** A canonical publication id: 36 characters, lowercase hex in the 8-4-4-4-12 groups. */
export const publicationId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);

const utcNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/** core `read_community_imports`: no file is no records; a file that is not exactly this shape is an error naming it. */
export function readRegistry(repo: string): ImportRecord[] {
  const path = registryPath(repo);
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

function writeRegistry(repo: string, records: ImportRecord[]): void {
  writeAtomic(registryPath(repo), Bun.TOML.stringify({ import: records }));
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The registry write runs under the library lock, so concurrent imports cannot each read one list and drop the other's record. */
function recordImport(roots: Roots, record: ImportRecord): Promise<void> {
  return withRepoLibraryLock(roots, () => {
    const records = readRegistry(roots.repoDir).filter((r) => r.id !== record.id && r.local_key !== record.local_key);
    records.push(record);
    writeRegistry(roots.repoDir, records);
  });
}

/** A repo playbook's record goes before its definition does. A registry that cannot be read stops the delete (`forget_import_before_delete`). */
export async function forgetImportBeforeDelete(roots: Roots, key: string): Promise<void> {
  try {
    readRegistry(roots.repoDir);
    await withRepoLibraryLock(roots, () => {
      if (!existsSync(registryPath(roots.repoDir))) return;
      const records = readRegistry(roots.repoDir);
      const kept = records.filter((r) => r.local_key !== key);
      if (kept.length !== records.length) writeRegistry(roots.repoDir, kept);
    });
  } catch (e) {
    if (e instanceof SaveFailure) throw e;
    throw new SaveFailure({ kind: "io", message: messageOf(e) });
  }
}

const readFileOrNull = (path: string): Buffer | null => {
  try {
    return lstatSync(path).isFile() ? readFileSync(path) : null;
  } catch {
    return null;
  }
};

async function restoreOrDelete(roots: Roots, key: string, previous: Buffer | null): Promise<void> {
  try {
    if (previous) {
      writeAtomic(playbookPath(roots.repoDir, key), previous);
      return;
    }
    await deletePlaybook(roots, { scope: "repo", key });
  } catch {}
}

async function save(roots: Roots, key: string, document: string, previous: Buffer | null): Promise<{ sourceText: string } | Outcome> {
  try {
    const saved = await savePlaybook(roots, { scope: "repo", key }, document, true, previous);
    return { sourceText: saved.source_text };
  } catch (e) {
    if (!(e instanceof SaveFailure)) return { kind: "failed", message: messageOf(e) };
    const err = e.error;
    if (err.kind === "invalid") return { kind: "invalid", diagnostics: err.diagnostics };
    if (err.kind === "conflict") return { kind: "conflict", localKey: err.source.reference.key };
    return { kind: "failed", message: err.kind === "io" ? err.message : e.message };
  }
}

async function finish(roots: Roots, pkg: Package, key: string, id: string, sourceText: string, previous: Buffer | null): Promise<Outcome> {
  const localSha256 = sha256(sourceText);
  const record: ImportRecord = { id, label: pkg.label, playbook_key: pkg.playbookKey, local_scope: "repo", local_key: key, imported_version: pkg.version, local_sha256: localSha256, imported_at: utcNow() };
  try {
    await recordImport(roots, record);
  } catch (e) {
    await restoreOrDelete(roots, key, previous);
    return { kind: "failed", message: messageOf(e) };
  }
  return { kind: "saved", reference: { scope: "repo", key }, importedVersion: pkg.version, localSha256 };
}

const unusable = (pkg: Package) => !Number.isSafeInteger(pkg.version) || pkg.version < 1;

export async function importCommunityPlaybook(roots: Roots, id: string, pkg: Package, overwrite: boolean): Promise<Outcome> {
  if (!publicationId(id) || unusable(pkg)) return { kind: "failed", message: NOT_FOUND };
  let records: ImportRecord[];
  try {
    records = readRegistry(roots.repoDir);
  } catch (e) {
    return { kind: "failed", message: messageOf(e) };
  }
  if (records.some((r) => r.id === id)) return { kind: "already_downloaded" };
  const parsed = parsePlaybookDocument(pkg.document);
  if (!parsed.document) return { kind: "invalid", diagnostics: parsed.diagnostics };
  const key = parsed.document.key;
  const previous = readFileOrNull(playbookPath(roots.repoDir, key));
  if (previous && !overwrite) return { kind: "conflict", localKey: key };
  const saved = await save(roots, key, pkg.document, previous);
  if (!("sourceText" in saved)) return saved;
  return finish(roots, pkg, key, id, saved.sourceText, previous);
}

export async function updateCommunityImport(roots: Roots, id: string, pkg: Package, overwriteEdited: boolean): Promise<Outcome> {
  if (!publicationId(id) || unusable(pkg)) return { kind: "failed", message: NOT_FOUND };
  let record: ImportRecord | undefined;
  try {
    record = readRegistry(roots.repoDir).find((r) => r.id === id);
  } catch (e) {
    return { kind: "failed", message: messageOf(e) };
  }
  if (!record) return { kind: "failed", message: NOT_FOUND };
  const previous = validPlaybookKey(record.local_key) ? readFileOrNull(playbookPath(roots.repoDir, record.local_key)) : null;
  if (previous && sha256(previous) !== record.local_sha256 && !overwriteEdited) return { kind: "edited" };
  const parsed = parsePlaybookDocument(pkg.document);
  if (!parsed.document) return { kind: "invalid", diagnostics: parsed.diagnostics };
  const saved = await save(roots, record.local_key, pkg.document, previous);
  if (!("sourceText" in saved)) {
    // The local copy changed while the package was in flight: the person has not approved replacing that edit, so it is the same
    // question the check before the download asks.
    return saved.kind === "conflict" ? { kind: "edited" } : saved;
  }
  return finish(roots, pkg, record.local_key, id, saved.sourceText, previous);
}

/** What the registry says, with what the local files say about each record (the `playbook/_/community` row). */
export type RegistryRow = ImportRecord & { local_missing: boolean; locally_edited: boolean };

export function registryRows(repo: string): { rows: RegistryRow[]; error: string } {
  let records: ImportRecord[];
  try {
    records = readRegistry(repo);
  } catch (e) {
    return { rows: [], error: messageOf(e) };
  }
  return {
    error: "",
    rows: records.map((r) => {
      const bytes = validPlaybookKey(r.local_key) ? readFileOrNull(playbookPath(repo, r.local_key)) : null;
      return { ...r, local_missing: bytes === null, locally_edited: bytes !== null && sha256(bytes) !== r.local_sha256 };
    }),
  };
}
