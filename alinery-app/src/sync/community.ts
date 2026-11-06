// The community library's imports (plan S4.10). The registry of what a repository downloaded is the daemon's `playbook/_/community`
// row, and importing, updating and forgetting are its `PlaybookService` calls, so a repository on another machine keeps its own.
// This machine's account does the network half through `ipc`: a package is downloaded here, staged with the repository's daemon
// (`BlobService`), and named in the import call. These keep the names and result shapes the library view already reads.
import { CommunityImportOutcome, type CommunityImportResult } from "alinery-proto/alinery/v1/playbooks_pb";
import * as ipc from "../ipc";
import type { CommunityImportRow, DownloadStatusRow, ImportResult, PlaybookRef, PlaybookValidationError, PublishResult, UpdateResult } from "../types";
import { newMutationMeta } from "./mutation";
import { client, diagnostic, PlaybookRefusal, readPlaybook, refOf, refused, withReplica, written } from "./playbooks";
import { upload } from "./tasks";

const COMMUNITY_KEY = "playbook/_/community";

type Registry = { imports: { id: string; label: string; playbookKey: string; localKey: string; importedVersion: number; localMissing: boolean; locallyEdited: boolean }[] };

/** The repository's registry as its daemon holds it; a registry the daemon could not read rejects with the reason. */
async function registryOf(repo: string): Promise<Registry> {
  return withReplica(repo, (replica) => {
    const e = replica.get(COMMUNITY_KEY);
    if (e?.value.case !== "playbookCommunity") return { imports: [] };
    if (e.value.value.error) throw new Error(e.value.value.error);
    return { imports: e.value.value.imports.map((i) => ({ ...i, importedVersion: Number(i.importedVersion) })) };
  });
}

export async function listCommunityImports(args: { repoPath: string }): Promise<{ imports: CommunityImportRow[] }> {
  const { imports } = await registryOf(args.repoPath);
  return { imports: imports.map((i) => ({ id: i.id, label: i.label, playbookKey: i.playbookKey, localKey: i.localKey, importedVersion: i.importedVersion })) };
}

/** What the daemon says about each local copy, beside what the library says about its publication. */
export async function communityDownloadStatus(args: { repoPath: string }): Promise<{ rows: DownloadStatusRow[] }> {
  const { imports } = await registryOf(args.repoPath);
  const remote = new Map((await ipc.communityRemoteStatus(imports.map((i) => i.id))).map((r) => [r.id, r]));
  return {
    rows: imports.map((i) => {
      const r = remote.get(i.id);
      return {
        id: i.id,
        label: i.label,
        playbookKey: i.playbookKey,
        localKey: i.localKey,
        title: r?.title ?? null,
        description: r?.description ?? null,
        importedVersion: i.importedVersion,
        remoteVersion: r?.remoteVersion ?? null,
        updateAvailable: r?.remoteVersion != null && r.remoteVersion > i.importedVersion,
        remoteMissing: r?.remoteMissing ?? false,
        localMissing: i.localMissing,
        locallyEdited: i.locallyEdited,
        error: r?.error ?? null,
      };
    }),
  };
}

type Outcome = Extract<ImportResult, { kind: "saved" | "invalid" | "failed" }> | { kind: "conflict"; localKey: string } | { kind: "already_downloaded" } | { kind: "edited" };

function outcomeOf(result: CommunityImportResult | undefined): Outcome {
  switch (result?.outcome) {
    case CommunityImportOutcome.SAVED:
      return { kind: "saved", reference: refOf(result.reference), importedVersion: Number(result.importedVersion), localSha256: result.localSha256 };
    case CommunityImportOutcome.CONFLICT:
      return { kind: "conflict", localKey: result.localKey };
    case CommunityImportOutcome.ALREADY_DOWNLOADED:
      return { kind: "already_downloaded" };
    case CommunityImportOutcome.EDITED:
      return { kind: "edited" };
    case CommunityImportOutcome.INVALID:
      return { kind: "invalid", diagnostics: result.diagnostics.map(diagnostic) };
    default:
      return { kind: "failed", message: result?.message || "the daemon did not say what happened" };
  }
}

/** Downloads the package here and stages it with the repository's daemon; `null` is a result to hand back as it is. */
async function stage(
  repo: string,
  id: string,
): Promise<{ upload: { uploadId: string; version: bigint; label: string; playbookKey: string } } | { stop: { kind: "needs_account" } | { kind: "failed"; message: string } }> {
  const source = await ipc.downloadCommunitySource(id);
  if (source.kind === "needs_account") return { stop: source };
  if (source.kind === "failed") return { stop: source };
  const staged = await upload(repo, { kind: "staged" }, `${id}.md`, new TextEncoder().encode(source.document));
  return { upload: { uploadId: staged.uploadId, version: BigInt(source.version), label: source.label, playbookKey: source.playbookKey } };
}

async function run(repo: string, id: string, send: (pkg: { uploadId: string; version: bigint; label: string; playbookKey: string }) => Promise<CommunityImportResult | undefined>) {
  try {
    const staged = await stage(repo, id);
    if ("stop" in staged) return staged.stop;
    return outcomeOf(await send(staged.upload));
  } catch (e) {
    return { kind: "failed" as const, message: e instanceof Error ? e.message : String(e) };
  }
}

export function importCommunityPlaybook(args: { id: string; repoPath: string; overwrite: boolean }): Promise<ImportResult> {
  return run(
    args.repoPath,
    args.id,
    async (pkg) =>
      (
        await written(args.repoPath, () =>
          client(args.repoPath).importCommunityPlaybook({ meta: newMutationMeta(), id: args.id, package: pkg, overwrite: args.overwrite }).catch(refused),
        )
      ).result,
  ) as Promise<ImportResult>;
}

export function updateCommunityImport(args: { id: string; repoPath: string; overwriteEdited: boolean }): Promise<UpdateResult> {
  return run(
    args.repoPath,
    args.id,
    async (pkg) =>
      (
        await written(args.repoPath, () =>
          client(args.repoPath).updateCommunityImport({ meta: newMutationMeta(), id: args.id, package: pkg, overwriteEdited: args.overwriteEdited }).catch(refused),
        )
      ).result,
  ) as Promise<UpdateResult>;
}

/** Publishes a playbook as the repository's daemon holds it; a definition that does not validate never leaves this machine. */
export async function publishCommunityPlaybook(args: { reference: PlaybookRef; repoPath: string; label?: string }): Promise<PublishResult> {
  let loaded: Awaited<ReturnType<typeof readPlaybook>>;
  try {
    loaded = await readPlaybook(args.reference, args.repoPath);
  } catch (e) {
    if (e instanceof PlaybookRefusal && e.kind === "invalid" && Array.isArray(e.diagnostics))
      return {
        kind: "invalid",
        diagnostics: (e.diagnostics as PlaybookValidationError[]).map((d) => ({
          code: d.code,
          message: d.message,
          line: d.line ?? null,
          field: d.field ?? null,
          severity: d.severity,
        })),
      };
    return { kind: "failed", message: e instanceof Error ? e.message : String(e), code: "" };
  }
  return ipc.publishCommunityPlaybook({ source: loaded.source_text, key: loaded.definition.key, ...(args.label === undefined ? {} : { label: args.label }) });
}
