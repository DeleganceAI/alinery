// PlaybookService (plan S4.6): the playbook library's reads of one whole definition, the two computed answers (validate, render) and the
// writes. The catalog is the `playbook/*` rows (`PlaybookProjector`). A write is serialized with every other writer of the repository,
// checks `expected_revision` against the row as the files are now, and answers after the rows it changed are in the store. A refusal
// carries the library's tagged error as JSON in `ErrorDetail.fields["error"]`, which the frontend turns back into the shape its views read.
import { readFileSync } from "node:fs";
import { Code, type ServiceImpl } from "@connectrpc/connect";
import { Capability } from "alinery-proto/alinery/v1/admin_pb";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { CommunityImportOutcome, type PlaybookDefinition, type PlaybookDefinitionSchema, type PlaybookService, type ReadPlaybookResponseSchema } from "alinery-proto/alinery/v1/playbooks_pb";
import { type PlaybookDocument, parsePlaybookDocument, renderPlaybookMd } from "playbook-engine/src/playbook-md.ts";
import { forgetImportBeforeDelete, importCommunityPlaybook, type Outcome, type Package, updateCommunityImport } from "../domain/communityImports.ts";
import type { BlobStore } from "../domain/blobs.ts";
import { COMMUNITY_KEY, GLOBAL_PICKER_KEY, PICKER_KEY, diagnosticOf, playbookKey, type PlaybookProjector } from "../domain/playbookProjector.ts";
import {
  appConfigDirOf,
  deletePlaybook,
  LoadFailure,
  type LoadError,
  type PickerPreferences,
  type Ref,
  resolvePlaybook,
  type Roots,
  type SaveError,
  SaveFailure,
  savePicker,
  savePlaybook,
  type Scope,
  type Scoped,
} from "../domain/playbookLibrary.ts";
import { withTaskMutation } from "../platform/lock.ts";
import type { Dedupe } from "../sync/dedupe.ts";
import type { Store } from "../sync/store.ts";
import { requireCapability } from "./auth.ts";
import { domain, fail, metaOf } from "./errors.ts";

export type PlaybookDeps = { repo: string; appConfig: string; projector: PlaybookProjector; blobs: BlobStore };

const SCOPES = new Set<string>(["bundled", "global", "repo"]);

function refOf(r: { scope: string; key: string } | undefined): Ref {
  if (!r || !SCOPES.has(r.scope)) throw fail(Code.InvalidArgument, "invalid_argument", `unknown playbook scope ${JSON.stringify(r?.scope ?? "")}`);
  return { scope: r.scope as Scope, key: r.key };
}

export function definitionToWire(d: PlaybookDocument): MessageInitShape<typeof PlaybookDefinitionSchema> {
  return {
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
      inputs: s.inputs.map((i) => ({ path: i.path, mode: i.mode })),
      outputs: s.outputs.map((o) => ({ path: o.path, required: o.required })),
      model: s.model,
      harness: s.harness,
      prompt: s.prompt,
    })),
    preamble: d.preamble,
    sectionOrder: d.section_order,
  };
}

export function definitionFromWire(d: PlaybookDefinition): PlaybookDocument {
  return {
    version: d.version,
    key: d.key,
    title: d.title,
    description: d.description,
    default_model: d.defaultModel,
    default_harness: d.defaultHarness,
    step: d.step.map((s) => ({
      key: s.key,
      title: s.title,
      short: s.short,
      is_coding_step: s.isCodingStep,
      auto_advance_default: s.autoAdvanceDefault,
      inputs: s.inputs.map((i) => ({ path: i.path, mode: i.mode as "single" })),
      outputs: s.outputs.map((o) => ({ path: o.path, required: o.required })),
      model: s.model,
      harness: s.harness,
      prompt: s.prompt,
    })),
    preamble: d.preamble,
    section_order: d.sectionOrder,
  };
}

function readResponse(found: Scoped, revision: bigint): MessageInitShape<typeof ReadPlaybookResponseSchema> {
  return {
    revision,
    reference: { scope: found.source.reference.scope, key: found.source.reference.key },
    path: found.source.path ?? undefined,
    definition: definitionToWire(found.definition),
    sourceText: found.source_text,
    modifiedAtMs: found.modified_at_ms === null ? undefined : BigInt(found.modified_at_ms),
  };
}

const loadCode = (e: LoadError): Code => (e.kind === "unknown" ? Code.NotFound : e.kind === "invalid" ? Code.FailedPrecondition : Code.Internal);
const saveCode = (e: SaveError): Code => {
  switch (e.kind) {
    case "read_only":
      return Code.PermissionDenied;
    case "invalid":
      return Code.InvalidArgument;
    case "conflict":
      return Code.AlreadyExists;
    case "unknown":
      return Code.NotFound;
    case "io":
      return Code.Internal;
  }
};
const detail = (code: Code) => Code[code].replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();

/** A library failure leaves as its gRPC code, with the tagged error as JSON; anything else is left to the caller. */
function refused<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    throw translated(e);
  }
}
function translated(e: unknown): unknown {
  if (e instanceof LoadFailure) return fail(loadCode(e.error), detail(loadCode(e.error)), e.message, { error: JSON.stringify(e.error) });
  if (e instanceof SaveFailure) return fail(saveCode(e.error), detail(saveCode(e.error)), e.message, { error: JSON.stringify(e.error) });
  return e;
}

function outcomeToWire(o: Outcome) {
  const O = CommunityImportOutcome;
  switch (o.kind) {
    case "saved":
      return { outcome: O.SAVED, reference: o.reference, importedVersion: BigInt(o.importedVersion), localSha256: o.localSha256 };
    case "conflict":
      return { outcome: O.CONFLICT, localKey: o.localKey };
    case "already_downloaded":
      return { outcome: O.ALREADY_DOWNLOADED };
    case "edited":
      return { outcome: O.EDITED };
    case "invalid":
      return { outcome: O.INVALID, diagnostics: o.diagnostics.map(diagnosticOf) };
    case "failed":
      return { outcome: O.FAILED, message: o.message };
  }
}

export function playbookService(d: PlaybookDeps, dedupe: Dedupe, store: Store): ServiceImpl<typeof PlaybookService> {
  const roots = (): Roots => ({ globalConfigDir: appConfigDirOf(d.appConfig), repoDir: d.repo });
  const applied = () => ({ cursor: store.cursor() });
  // The row is checked as the files are now, not as the watcher last saw them: refresh first, under the repository's lock.
  const mutate = <T>(op: string, rowKey: string, expected: bigint, change: () => Promise<T>) =>
    domain(() =>
      withTaskMutation(d.repo, op, async () => {
        d.projector.refresh();
        const row = store.get(rowKey);
        if (expected !== 0n && row?.revision !== expected) throw fail(Code.Aborted, "aborted", `${rowKey} changed since revision ${expected} (now ${row?.revision ?? 0n})`);
        try {
          return await change();
        } catch (e) {
          throw translated(e);
        } finally {
          d.projector.refresh();
        }
      }),
    );
  // The staged upload is the playbook document; it is read and released whatever the outcome.
  const community = async (pkg: { uploadId: string; version: bigint; label: string; playbookKey: string } | undefined, run: (p: Package) => Promise<Outcome>) => {
    const staged = pkg ? d.blobs.staged(pkg.uploadId) : undefined;
    if (!pkg || !staged) throw fail(Code.InvalidArgument, "invalid_argument", "the playbook package was not uploaded");
    try {
      const document = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(staged.path));
      const outcome = await run({ document, version: Number(pkg.version), label: pkg.label, playbookKey: pkg.playbookKey });
      d.projector.refresh();
      return { applied: applied(), result: outcomeToWire(outcome) };
    } catch (e) {
      if (e instanceof TypeError) throw fail(Code.InvalidArgument, "invalid_argument", "the playbook package is not UTF-8 text");
      throw e;
    } finally {
      d.blobs.release(pkg.uploadId);
    }
  };
  return {
    readPlaybook: (req, ctx) => {
      requireCapability(ctx, Capability.VIEW);
      return domain(() => {
        const reference = refOf(req.reference);
        const found = refused(() => resolvePlaybook(roots(), reference));
        d.projector.refresh(); // the revision is the row as the files are now
        return readResponse(found, store.get(playbookKey(reference.scope, reference.key))?.revision ?? 0n);
      });
    },
    validatePlaybook: (req, ctx) => {
      requireCapability(ctx, Capability.VIEW);
      const parsed = parsePlaybookDocument(req.source);
      return { definition: parsed.document ? definitionToWire(parsed.document) : undefined, diagnostics: parsed.diagnostics.map(diagnosticOf) };
    },
    renderPlaybook: (req, ctx) => {
      requireCapability(ctx, Capability.VIEW);
      if (!req.definition) throw fail(Code.InvalidArgument, "invalid_argument", "a definition is needed");
      return { source: renderPlaybookMd(definitionFromWire(req.definition)) };
    },
    savePlaybook: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      const target = refOf(req.target);
      return dedupe.once(metaOf(req.meta), () =>
        mutate("save_playbook", playbookKey(target.scope, target.key), req.expectedRevision, async () => {
          const saved = await savePlaybook(roots(), target, req.source, req.overwrite);
          d.projector.refresh();
          return { applied: applied(), saved: readResponse(saved, store.get(playbookKey(target.scope, target.key))?.revision ?? 0n) };
        }),
      );
    },
    deletePlaybook: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      const reference = refOf(req.reference);
      return dedupe.once(metaOf(req.meta), () =>
        mutate("delete_playbook", playbookKey(reference.scope, reference.key), req.expectedRevision, async () => {
          // A repo playbook leaves the community import registry first; a registry that cannot be read stops the delete.
          if (reference.scope === "repo") await forgetImportBeforeDelete(roots(), reference.key);
          await deletePlaybook(roots(), reference);
          d.projector.refresh();
          return { applied: applied() };
        }),
      );
    },
    importCommunityPlaybook: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return dedupe.once(metaOf(req.meta), () =>
        community(req.package, (pkg) => mutate("import_community_playbook", COMMUNITY_KEY, 0n, () => importCommunityPlaybook(roots(), req.id, pkg, req.overwrite))),
      );
    },
    updateCommunityImport: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return dedupe.once(metaOf(req.meta), () =>
        community(req.package, (pkg) => mutate("update_community_import", COMMUNITY_KEY, 0n, () => updateCommunityImport(roots(), req.id, pkg, req.overwriteEdited))),
      );
    },
    savePicker: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      const preferences: PickerPreferences = {
        order: req.order.map(refOf),
        entries: req.entries.map((e) => ({
          reference: refOf(e.reference),
          preferred: e.preferred,
          hidden: e.hidden,
          collapsed: e.collapsed,
          badge: e.badge ?? null,
          color: e.color ?? null,
          last_imported_at_ms: e.lastImportedAtMs === undefined ? null : Number(e.lastImportedAtMs),
        })),
      };
      return dedupe.once(metaOf(req.meta), () =>
        mutate("save_playbook_picker", req.global ? GLOBAL_PICKER_KEY : PICKER_KEY, req.expectedRevision, async () => {
          await savePicker(req.global ? { ...roots(), repoDir: "" } : roots(), preferences);
          d.projector.refresh();
          return { applied: applied() };
        }),
      );
    },
  };
}
