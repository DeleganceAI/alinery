// The playbook library from the daemon (plan S4.6): the catalog is the `playbook/*` rows of the repo scope, one definition is a
// unary read, validate and render are unary, and a write carries `expected_revision` (the row this window last saw). These keep the
// names and shapes the views already use (`listPlaybookCatalog`, `readPlaybook`, ...), so a view changed only where it imported them.
//
// Which daemon: the repository the call names. With none, the library is the machine's (bundled and global), and the daemon asked is
// the active local repository's, else the first local one the app knows; with no local repository there is nobody to ask.
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import type { Cursor } from "alinery-proto/alinery/v1/common_pb";
import { ErrorDetailSchema } from "alinery-proto/alinery/v1/common_pb";
import type { Entity, PlaybookDiagnostic } from "alinery-proto/alinery/v1/entities_pb";
import { type PlaybookDefinition, PlaybookDefinitionSchema, PlaybookService, type ReadPlaybookResponse } from "alinery-proto/alinery/v1/playbooks_pb";
import { daemonTransport } from "../daemon/transport";
import * as ipc from "../ipc";
import { isRemoteRepo } from "../remoteRepo";
import type {
  InputSelector,
  NormalizedPlaybook,
  PickerPreference,
  PickerPreferences,
  PlaybookCandidate,
  PlaybookCatalog,
  PlaybookRef,
  PlaybookValidation,
  PlaybookValidationError,
  SavePlaybookRequest,
  ScopedPlaybook,
} from "../types";
import { whenReaches } from "./execution";
import { acquireScope, REPO_SCOPE } from "./hooks";
import { newMutationMeta } from "./mutation";
import type { Replica } from "./replica";

const PICKER_KEY = "playbook/_/picker";
const GLOBAL_PICKER_KEY = "playbook/_/picker-global";
const LIBRARY_KEY = "playbook/_/library";
const rowKey = (ref: PlaybookRef) => `playbook/${ref.scope}/${ref.key}`;

/** There is no repository to ask: the library lives in a daemon and the app has no local repository open or known. */
export class NoLibraryHost extends Error {
  constructor() {
    super("Open a repository to read the playbook library.");
    this.name = "NoLibraryHost";
  }
}

async function libraryHost(repoPath?: string): Promise<{ host: string; global: boolean }> {
  if (repoPath) return { host: repoPath, global: false };
  const config = await ipc.readAppConfig();
  const local = [config.active_repo, ...config.known_repos].find((repo) => repo && !isRemoteRepo(repo));
  if (!local) throw new NoLibraryHost();
  return { host: local, global: true };
}

export const diagnostic = (d: PlaybookDiagnostic): PlaybookValidationError => ({
  code: d.code,
  message: d.message,
  line: d.line ?? null,
  field: d.field ?? null,
  severity: d.severity,
});

const SCOPE_ORDER = { bundled: 0, global: 1, repo: 2 } as const;
export const refOf = (r: { scope: string; key: string } | undefined): PlaybookRef => ({ scope: (r?.scope || "bundled") as PlaybookRef["scope"], key: r?.key ?? "" });

function pickerOf(e: Entity | undefined): { preferences: PickerPreferences; error: string } {
  if (e?.value.case !== "playbookPicker") return { preferences: { order: [], entries: [] }, error: "" };
  const p = e.value.value;
  return {
    error: p.error,
    preferences: {
      order: p.order.map(refOf),
      entries: p.entries.map(
        (x): PickerPreference => ({
          reference: refOf(x.reference),
          preferred: x.preferred,
          hidden: x.hidden,
          collapsed: x.collapsed,
          badge: x.badge ?? null,
          color: x.color ?? null,
          last_imported_at_ms: x.lastImportedAtMs === undefined ? null : Number(x.lastImportedAtMs),
        }),
      ),
    },
  };
}

/** `load_playbook_catalog` from the rows: with no repository, the bundled and global candidates and the global picker. */
export function catalogOf(rows: Entity[], global: boolean): PlaybookCatalog {
  const candidates: PlaybookCandidate[] = [];
  let library: PlaybookDiagnostic[] = [];
  let hidden: { key: string; title: string }[] = [];
  let picker: Entity | undefined;
  for (const e of rows) {
    if (e.key === LIBRARY_KEY && e.value.case === "playbookLibrary") {
      library = e.value.value.diagnostics;
      hidden = e.value.value.hidden.map((h) => ({ key: h.key, title: h.title }));
    } else if (e.key === (global ? GLOBAL_PICKER_KEY : PICKER_KEY)) picker = e;
    else if (e.value.case === "playbook") {
      const p = e.value.value;
      const reference = refOf(p.reference);
      if (global && reference.scope === "repo") continue;
      candidates.push({
        source: { reference, path: p.path ?? null },
        title: p.title ?? null,
        description: p.description ?? null,
        modified_at_ms: p.modifiedAtMs === undefined ? null : Number(p.modifiedAtMs),
        diagnostics: p.diagnostics.map(diagnostic),
        ...(p.bodySha256 ? { body_sha256: p.bodySha256 } : {}),
        steps: p.steps.map((s) => ({
          key: s.key,
          title: s.title,
          short: "",
          is_coding_step: s.isCodingStep,
          auto_advance_default: s.autoAdvanceDefault,
          inputs: s.inputs.map((i) => ({ path: i.path, mode: i.mode as InputSelector["mode"] })),
          outputs: s.outputs.map((o) => ({ path: o.path })),
          model: "",
          harness: "",
          prompt: "",
        })),
      });
    }
  }
  candidates.sort(
    (a, b) =>
      SCOPE_ORDER[a.source.reference.scope] - SCOPE_ORDER[b.source.reference.scope] ||
      (a.source.reference.key < b.source.reference.key ? -1 : a.source.reference.key > b.source.reference.key ? 1 : 0),
  );
  const { preferences, error } = pickerOf(picker);
  const diagnostics = library.map(diagnostic);
  if (error) diagnostics.push({ code: "picker_preferences", message: error, line: null, field: null, severity: "error" });
  return { candidates, picker_preferences: preferences, diagnostics, hidden };
}

function definitionOf(d: PlaybookDefinition | undefined): NormalizedPlaybook {
  return {
    version: d?.version ?? 2,
    key: d?.key ?? "",
    title: d?.title ?? "",
    description: d?.description ?? "",
    default_model: d?.defaultModel ?? "",
    default_harness: d?.defaultHarness ?? "",
    step: (d?.step ?? []).map((s) => ({
      key: s.key,
      title: s.title,
      short: s.short,
      is_coding_step: s.isCodingStep,
      auto_advance_default: s.autoAdvanceDefault,
      inputs: s.inputs.map((i) => ({ path: i.path, mode: i.mode as "single" | "each" | "complete" })),
      outputs: s.outputs.map((o) => (o.required ? { path: o.path, required: true } : { path: o.path })),
      model: s.model,
      harness: s.harness,
      prompt: s.prompt,
    })),
    preamble: d?.preamble ?? "",
    section_order: d?.sectionOrder ?? [],
  };
}

function definitionToWire(d: NormalizedPlaybook): PlaybookDefinition {
  return create(PlaybookDefinitionSchema, {
    version: d.version,
    key: d.key,
    title: d.title,
    description: d.description,
    defaultModel: d.default_model,
    defaultHarness: d.default_harness,
    step: d.step.map((s) => ({
      key: s.key,
      title: s.title,
      short: s.short,
      isCodingStep: s.is_coding_step,
      autoAdvanceDefault: s.auto_advance_default,
      inputs: s.inputs,
      outputs: s.outputs.map((o) => ({ path: o.path, required: o.required ?? false })),
      model: s.model,
      harness: s.harness,
      prompt: s.prompt,
    })),
    preamble: d.preamble,
    sectionOrder: d.section_order,
  });
}

const scopedOf = (r: ReadPlaybookResponse): ScopedPlaybook => ({
  source: { reference: refOf(r.reference), path: r.path ?? null },
  definition: definitionOf(r.definition),
  source_text: r.sourceText,
  modified_at_ms: r.modifiedAtMs === undefined ? null : Number(r.modifiedAtMs),
});

/** A refusal in the shape the views read: the library's tagged error (`kind`, `diagnostics`, ...) with the daemon's message. */
export class PlaybookRefusal extends Error {
  /** `kind` and the rest of the library's tagged error, when the daemon sent one. */
  [field: string]: unknown;
}
export function refused(e: unknown): never {
  const err = ConnectError.from(e);
  const text = err.findDetails(ErrorDetailSchema)[0]?.fields.error;
  let tagged: Record<string, unknown> = {};
  try {
    tagged = text ? JSON.parse(text) : {};
  } catch {}
  const message = err.code === Code.Aborted ? `${err.rawMessage}. Reopen the playbook to see the newer version.` : err.rawMessage;
  throw Object.assign(new PlaybookRefusal(message), tagged);
}

export const client = (host: string) => createClient(PlaybookService, daemonTransport(host));

function ready(replica: Replica, host: string, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (replica.ready) return resolve();
    let off = () => {};
    const timer = setTimeout(() => (off(), reject(new Error(`the daemon for ${host} did not answer`))), timeoutMs);
    off = replica.listen(() => {
      if (!replica.ready) return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });
}

/** `f` with the host's replica, ready, held until it is done. */
export async function withReplica<T>(host: string, f: (replica: Replica) => Promise<T> | T): Promise<T> {
  const { replica, release } = acquireScope(host, REPO_SCOPE);
  try {
    await ready(replica, host);
    return await f(replica);
  } finally {
    release();
  }
}

export async function listPlaybookCatalog(repoPath?: string): Promise<PlaybookCatalog> {
  const { host, global } = await libraryHost(repoPath);
  return withReplica(host, (replica) => catalogOf(replica.all(), global));
}

// The revision of each definition as this window last read or wrote it: what a save that replaces the file sends back, so a file that
// changed since the person opened it is refused (ABORTED) instead of overwritten. A catalog read does not update it: opening is what counts.
const seen = new Map<string, bigint>();
const seenKey = (host: string, ref: PlaybookRef) => `${host}\u0000${rowKey(ref)}`;

export async function readPlaybook(reference: PlaybookRef, repoPath?: string): Promise<ScopedPlaybook> {
  const { host } = await libraryHost(repoPath);
  const reply = await client(host).readPlaybook({ reference }).catch(refused);
  seen.set(seenKey(host, reference), reply.revision);
  return scopedOf(reply);
}

export async function validatePlaybookSource(source: string, repoPath?: string): Promise<PlaybookValidation> {
  const { host } = await libraryHost(repoPath);
  const reply = await client(host).validatePlaybook({ source });
  return { definition: reply.definition ? definitionOf(reply.definition) : null, diagnostics: reply.diagnostics.map(diagnostic) };
}

export async function renderPlaybookSource(definition: NormalizedPlaybook, repoPath?: string): Promise<string> {
  const { host } = await libraryHost(repoPath);
  return (await client(host).renderPlaybook({ definition: definitionToWire(definition) })).source;
}

/** A write, then a wait (briefly) for this window's replica to pass the cursor it answered with, so a read right after shows the change. */
export async function written<T extends { applied?: { cursor?: Cursor } }>(host: string, send: () => Promise<T>): Promise<T> {
  const { replica, release } = acquireScope(host, REPO_SCOPE);
  try {
    await ready(replica, host);
    const reply = await send().catch(refused);
    await whenReaches(replica, reply.applied?.cursor, 3000);
    return reply;
  } finally {
    release();
  }
}

export async function savePlaybookSource(request: SavePlaybookRequest, repoPath?: string): Promise<ScopedPlaybook> {
  const { host } = await libraryHost(repoPath);
  const reply = await written(host, () =>
    client(host).savePlaybook({
      meta: newMutationMeta(),
      target: request.target,
      source: request.source,
      overwrite: request.overwrite,
      // Replacing a file replaces the one the person was looking at; a newer one is refused instead of lost (0: not read here, no check).
      expectedRevision: request.overwrite ? (seen.get(seenKey(host, request.target)) ?? 0n) : 0n,
    }),
  );
  if (!reply.saved) throw new Error("the daemon saved the playbook but did not return it");
  seen.set(seenKey(host, request.target), reply.saved.revision);
  return scopedOf(reply.saved);
}

export async function deletePlaybookSource(reference: PlaybookRef, repoPath?: string): Promise<void> {
  const { host } = await libraryHost(repoPath);
  // A repo playbook leaves the daemon's community import registry before its definition does (a registry it cannot read stops the delete).
  await written(host, () => client(host).deletePlaybook({ meta: newMutationMeta(), reference, expectedRevision: seen.get(seenKey(host, reference)) ?? 0n }));
  seen.delete(seenKey(host, reference));
}

/** Brings back a built-in the person removed (its global tombstone goes). */
export async function restoreBundledPlaybook(key: string, repoPath?: string): Promise<void> {
  const { host } = await libraryHost(repoPath);
  await written(host, () => client(host).restoreBundledPlaybook({ meta: newMutationMeta(), key }));
}

export async function savePlaybookPickerPreferences(preferences: PickerPreferences, repoPath?: string): Promise<void> {
  const { host, global } = await libraryHost(repoPath);
  // Preferences are saved whole from the catalog the page holds and are last-writer-wins here (0: no check); the service can check a revision.
  await written(host, () =>
    client(host).savePicker({
      meta: newMutationMeta(),
      global,
      order: preferences.order,
      entries: preferences.entries.map((e) => ({
        reference: e.reference,
        preferred: e.preferred ?? false,
        hidden: e.hidden,
        collapsed: e.collapsed,
        badge: e.badge ?? undefined,
        color: e.color ?? undefined,
        lastImportedAtMs: e.last_imported_at_ms === null ? undefined : BigInt(e.last_imported_at_ms),
      })),
    }),
  );
}
