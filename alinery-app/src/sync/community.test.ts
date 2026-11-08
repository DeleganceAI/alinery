import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ServiceImpl, type Transport } from "@connectrpc/connect";
import { ErrorDetailSchema } from "alinery-proto/alinery/v1/common_pb";
import { PlaybookCommunitySchema } from "alinery-proto/alinery/v1/entities_pb";
import { CommunityImportOutcome, type PlaybookService } from "alinery-proto/alinery/v1/playbooks_pb";
import { afterEach, expect, it, vi } from "vitest";
import { daemonTransport } from "../daemon/transport";
import { cursor, daemonHarness, entity, scriptedSync, snapshot, untilAborted } from "../test/daemonHarness";
import { communityDownloadStatus, importCommunityPlaybook, listCommunityImports, publishCommunityPlaybook, updateCommunityImport } from "./community";

vi.mock("../daemon/transport", () => ({ daemonTransport: vi.fn() }));
const ipcMocks = vi.hoisted(() => ({
  readAppConfig: vi.fn(),
  communityRemoteStatus: vi.fn(),
  downloadCommunitySource: vi.fn(),
  publishCommunityPlaybook: vi.fn(),
}));
vi.mock("../ipc", () => ipcMocks);
const uploads = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock("./tasks", () => uploads);
afterEach(() => vi.resetAllMocks());

const ID = "8c19b367-d20b-4e60-b2ec-df73d8123aa1";
const imp = (id: string, extra: object = {}) => ({
  id,
  label: "nyx",
  playbookKey: "review",
  localKey: "review",
  importedVersion: 3n,
  localSha256: "x",
  importedAt: "now",
  localMissing: false,
  locallyEdited: false,
  ...extra,
});

function serve(playbooks: Partial<ServiceImpl<typeof PlaybookService>> = {}, community = create(PlaybookCommunitySchema, { imports: [imp(ID)] })) {
  const h = scriptedSync(async function* (_req, _call, signal) {
    yield snapshot([entity("playbook/_/community", { case: "playbookCommunity", value: community })], 1);
    await untilAborted(signal);
  });
  vi.mocked(daemonTransport).mockReturnValue(daemonHarness({ sync: h.sync, playbooks }).transport as Transport);
}

it("lists what the daemon's registry says, and a registry it could not read rejects with the reason", async () => {
  serve();
  expect(await listCommunityImports({ repoPath: "/a" })).toEqual({ imports: [{ id: ID, label: "nyx", playbookKey: "review", localKey: "review", importedVersion: 3 }] });
  serve({}, create(PlaybookCommunitySchema, { error: "invalid /a/.alinery/playbooks/community-imports.toml" }));
  await expect(listCommunityImports({ repoPath: "/a" })).rejects.toThrow("invalid /a/.alinery/playbooks/community-imports.toml");
});

it("a download row joins the daemon's view of the local file with the library's view of the publication", async () => {
  const other = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  serve({}, create(PlaybookCommunitySchema, { imports: [imp(ID, { locallyEdited: true }), imp(other, { localMissing: true })] }));
  ipcMocks.communityRemoteStatus.mockResolvedValue([
    { id: ID, title: "Review", description: "d", remoteVersion: 4, remoteMissing: false, error: null },
    { id: other, title: null, description: null, remoteVersion: null, remoteMissing: true, error: null },
  ]);
  const { rows } = await communityDownloadStatus({ repoPath: "/a" });
  expect(ipcMocks.communityRemoteStatus).toHaveBeenCalledWith([ID, other]);
  expect(rows[0]).toMatchObject({ id: ID, title: "Review", importedVersion: 3, remoteVersion: 4, updateAvailable: true, locallyEdited: true, localMissing: false, error: null });
  expect(rows[1]).toMatchObject({ id: other, remoteMissing: true, updateAvailable: false, localMissing: true });
});

it("an import downloads here, stages with the repository's daemon and names the upload", async () => {
  const seen: { id: string; uploadId: string; version: bigint; label: string; playbookKey: string; overwrite: boolean }[] = [];
  ipcMocks.downloadCommunitySource.mockResolvedValue({ kind: "downloaded", document: "+++\n+++\n", version: 3, label: "nyx", playbookKey: "review" });
  uploads.upload.mockResolvedValue({ name: `${ID}.md`, uploadId: "up-1" });
  serve({
    importCommunityPlaybook: (request) => {
      seen.push({ id: request.id, ...request.package, overwrite: request.overwrite } as never);
      return {
        applied: { cursor: cursor(1) },
        result: { outcome: CommunityImportOutcome.SAVED, reference: { scope: "repo", key: "review" }, importedVersion: 3n, localSha256: "abc" },
      } as never;
    },
  });
  expect(await importCommunityPlaybook({ id: ID, repoPath: "/a", overwrite: false })).toEqual({
    kind: "saved",
    reference: { scope: "repo", key: "review" },
    importedVersion: 3,
    localSha256: "abc",
  });
  expect(uploads.upload).toHaveBeenCalledWith("/a", { kind: "staged" }, `${ID}.md`, new TextEncoder().encode("+++\n+++\n"));
  expect(seen[0]).toMatchObject({ id: ID, uploadId: "up-1", version: 3n, label: "nyx", playbookKey: "review", overwrite: false });
});

it("a missing account or a failed download stops before anything is staged", async () => {
  ipcMocks.downloadCommunitySource.mockResolvedValueOnce({ kind: "needs_account" }).mockResolvedValueOnce({ kind: "failed", message: "Playbook not found." });
  serve();
  expect(await importCommunityPlaybook({ id: ID, repoPath: "/a", overwrite: false })).toEqual({ kind: "needs_account" });
  expect(await updateCommunityImport({ id: ID, repoPath: "/a", overwriteEdited: false })).toEqual({ kind: "failed", message: "Playbook not found." });
  expect(uploads.upload).not.toHaveBeenCalled();
});

it("each refusal the person can act on keeps its own kind", async () => {
  ipcMocks.downloadCommunitySource.mockResolvedValue({ kind: "downloaded", document: "d", version: 1, label: "nyx", playbookKey: "review" });
  uploads.upload.mockResolvedValue({ name: "n", uploadId: "u" });
  const outcomes = [
    { outcome: CommunityImportOutcome.CONFLICT, localKey: "review" },
    { outcome: CommunityImportOutcome.ALREADY_DOWNLOADED },
    { outcome: CommunityImportOutcome.EDITED },
    { outcome: CommunityImportOutcome.INVALID, diagnostics: [{ code: "bad", message: "no", severity: "error" }] },
    { outcome: CommunityImportOutcome.FAILED, message: "disk full" },
  ];
  let next = 0;
  serve({
    importCommunityPlaybook: () => ({ applied: { cursor: cursor(1) }, result: outcomes[next++] }) as never,
  });
  const kinds: string[] = [];
  for (let i = 0; i < outcomes.length; i++) kinds.push((await importCommunityPlaybook({ id: ID, repoPath: "/a", overwrite: false })).kind);
  expect(kinds).toEqual(["conflict", "already_downloaded", "edited", "invalid", "failed"]);
});

it("a daemon that refuses the call is a failed result, not a throw", async () => {
  ipcMocks.downloadCommunitySource.mockResolvedValue({ kind: "downloaded", document: "d", version: 1, label: "nyx", playbookKey: "review" });
  uploads.upload.mockResolvedValue({ name: "n", uploadId: "u" });
  serve({
    updateCommunityImport: () => {
      throw new ConnectError("revision is stale", Code.Aborted, undefined, [{ desc: ErrorDetailSchema, value: { fields: {} } }]);
    },
  });
  const result = await updateCommunityImport({ id: ID, repoPath: "/a", overwriteEdited: false });
  expect(result.kind).toBe("failed");
});

it("publishing sends the playbook as the daemon holds it, with its declared key", async () => {
  ipcMocks.publishCommunityPlaybook.mockResolvedValue({ kind: "needs_account" });
  serve({
    readPlaybook: () =>
      ({
        reference: { scope: "repo", key: "review" },
        path: "/p",
        definition: { version: 2, key: "review", title: "R", description: "", defaultModel: "", defaultHarness: "", step: [], preamble: "", sectionOrder: [] },
        sourceText: "+++\nkey\n+++\n",
        revision: 4n,
      }) as never,
  });
  const reference = { scope: "repo" as const, key: "review" };
  expect(await publishCommunityPlaybook({ reference, repoPath: "/a", label: "nyx" })).toEqual({ kind: "needs_account" });
  expect(ipcMocks.publishCommunityPlaybook).toHaveBeenCalledWith({ source: "+++\nkey\n+++\n", key: "review", label: "nyx" });
  await publishCommunityPlaybook({ reference, repoPath: "/a" });
  expect(ipcMocks.publishCommunityPlaybook).toHaveBeenLastCalledWith({ source: "+++\nkey\n+++\n", key: "review" });
});

it("a playbook the daemon calls invalid never leaves this machine", async () => {
  serve({
    readPlaybook: () => {
      throw new ConnectError("invalid playbook", Code.FailedPrecondition, undefined, [
        {
          desc: ErrorDetailSchema,
          value: { fields: { error: JSON.stringify({ kind: "invalid", diagnostics: [{ code: "unknown_field", message: "x", line: 4, field: "step.mode", severity: "error" }] }) } },
        },
      ]);
    },
  });
  const result = await publishCommunityPlaybook({ reference: { scope: "repo", key: "review" }, repoPath: "/a" });
  expect(result).toEqual({ kind: "invalid", diagnostics: [{ code: "unknown_field", message: "x", line: 4, field: "step.mode", severity: "error" }] });
  expect(ipcMocks.publishCommunityPlaybook).not.toHaveBeenCalled();
});
