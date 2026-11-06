import { create } from "@bufbuild/protobuf";
import type { ServiceImpl } from "@connectrpc/connect";
import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import { ErrorDetailSchema } from "alinery-proto/alinery/v1/common_pb";
import { type Entity, PlaybookLibrarySchema, PlaybookPickerSchema, PlaybookSchema } from "alinery-proto/alinery/v1/entities_pb";
import type { PlaybookService } from "alinery-proto/alinery/v1/playbooks_pb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { daemonTransport } from "../daemon/transport";
import { cursor, daemonHarness, entity, scriptedSync, snapshot, untilAborted } from "../test/daemonHarness";
import { deletePlaybookSource, listPlaybookCatalog, NoLibraryHost, PlaybookRefusal, readPlaybook, savePlaybookPickerPreferences, savePlaybookSource } from "./playbooks";

vi.mock("../daemon/transport", () => ({ daemonTransport: vi.fn() }));
const ipcMocks = vi.hoisted(() => ({ readAppConfig: vi.fn(), forgetCommunityImport: vi.fn() }));
vi.mock("../ipc", () => ipcMocks);

beforeEach(() => {
  ipcMocks.readAppConfig.mockResolvedValue({ active_repo: "/a", known_repos: ["/a", "/b"] });
  ipcMocks.forgetCommunityImport.mockResolvedValue(undefined);
});
afterEach(() => vi.resetAllMocks());

const ref = (scope: string, key: string) => ({ scope, key });
const playbookRow = (scope: string, key: string, title: string, extra: object = {}): Entity =>
  entity(`playbook/${scope}/${key}`, { case: "playbook", value: create(PlaybookSchema, { reference: ref(scope, key), title, ...extra }) });

const rows: Entity[] = [
  playbookRow("repo", "zeta", "Zeta", { path: "/a/.alinery/playbooks/zeta/playbook.md", modifiedAtMs: 5n }),
  playbookRow("global", "alpha", "Alpha"),
  playbookRow("bundled", "superdevelop", "SuperDevelop"),
  playbookRow("bundled", "broken", "", { diagnostics: [{ code: "unknown_field", message: "unknown field `step.mode`", field: "step.mode", line: 4, severity: "error" }] }),
  entity("playbook/_/picker", {
    case: "playbookPicker",
    value: create(PlaybookPickerSchema, {
      order: [ref("repo", "zeta")],
      entries: [{ reference: ref("repo", "zeta"), preferred: true, hidden: false, collapsed: false, badge: "b", lastImportedAtMs: 9n }],
    }),
  }),
  entity("playbook/_/picker-global", { case: "playbookPicker", value: create(PlaybookPickerSchema, { order: [ref("global", "alpha")] }) }),
  entity("playbook/_/library", {
    case: "playbookLibrary",
    value: create(PlaybookLibrarySchema, { diagnostics: [{ code: "unreadable_dir", message: "cannot read /x", severity: "error" }] }),
  }),
];

function serve(playbooks: Partial<ServiceImpl<typeof PlaybookService>> = {}, library: Entity[] = rows) {
  const h = scriptedSync(async function* (_req, _call, signal) {
    yield snapshot(library, 1);
    await untilAborted(signal);
  });
  vi.mocked(daemonTransport).mockReturnValue(daemonHarness({ sync: h.sync, playbooks }).transport as Transport);
}

const definition = { version: 2, key: "zeta", title: "Zeta", description: "", defaultModel: "", defaultHarness: "omp", step: [], preamble: "", sectionOrder: [] };
const read = (revision: bigint) => ({ reference: ref("repo", "zeta"), path: "/p", definition, sourceText: "+++\n+++\n", modifiedAtMs: 5n, revision });

it("a repository's catalog is every row, scope-ordered, with its picker and the scan's problems", async () => {
  serve();
  const catalog = await listPlaybookCatalog("/a");
  expect(catalog.candidates.map((c) => `${c.source.reference.scope}/${c.source.reference.key}`)).toEqual(["bundled/broken", "bundled/superdevelop", "global/alpha", "repo/zeta"]);
  expect(catalog.candidates[0].diagnostics).toEqual([{ code: "unknown_field", message: "unknown field `step.mode`", line: 4, field: "step.mode", severity: "error" }]);
  expect(catalog.candidates[3]).toMatchObject({ source: { path: "/a/.alinery/playbooks/zeta/playbook.md" }, title: "Zeta", modified_at_ms: 5 });
  expect(catalog.picker_preferences.order).toEqual([ref("repo", "zeta")]);
  expect(catalog.picker_preferences.entries[0]).toMatchObject({ preferred: true, badge: "b", color: null, last_imported_at_ms: 9 });
  expect(catalog.diagnostics.map((d) => d.code)).toEqual(["unreadable_dir"]);
});

it("with no repository the catalog is the machine's: no repo playbooks, the global picker, asked of the first local repository", async () => {
  ipcMocks.readAppConfig.mockResolvedValue({ active_repo: "alinery+ssh://h/srv/r", known_repos: ["alinery+ssh://h/srv/r", "/b"] });
  serve();
  const catalog = await listPlaybookCatalog();
  expect(catalog.candidates.map((c) => c.source.reference.scope)).toEqual(["bundled", "bundled", "global"]);
  expect(catalog.picker_preferences.order).toEqual([ref("global", "alpha")]);
  expect(vi.mocked(daemonTransport)).toHaveBeenCalledWith("/b");
});

it("with no local repository there is nobody to ask", async () => {
  ipcMocks.readAppConfig.mockResolvedValue({ active_repo: "", known_repos: ["alinery+ssh://h/srv/r"] });
  await expect(listPlaybookCatalog()).rejects.toBeInstanceOf(NoLibraryHost);
});

it("a save that replaces a file sends the revision the window read; a new file sends none", async () => {
  const saves: { expected: bigint; overwrite: boolean }[] = [];
  serve({
    readPlaybook: () => read(7n) as never,
    savePlaybook: (request) => {
      saves.push({ expected: request.expectedRevision, overwrite: request.overwrite });
      return { applied: { cursor: cursor(1) }, saved: { ...read(9n), reference: request.target } } as never;
    },
  });
  await savePlaybookSource({ target: ref("repo", "fresh") as never, source: "s", overwrite: false }, "/a");
  await readPlaybook(ref("repo", "zeta") as never, "/a");
  await savePlaybookSource({ target: ref("repo", "zeta") as never, source: "s", overwrite: true }, "/a");
  await savePlaybookSource({ target: ref("repo", "zeta") as never, source: "s", overwrite: true }, "/a");
  expect(saves).toEqual([
    { expected: 0n, overwrite: false },
    { expected: 7n, overwrite: true },
    { expected: 9n, overwrite: true },
  ]);
});

it("a stale save is a PlaybookRefusal telling the person to reopen; a library refusal keeps its tagged fields", async () => {
  const tagged = (code: Code, message: string, error: object) =>
    new ConnectError(message, code, undefined, [{ desc: ErrorDetailSchema, value: create(ErrorDetailSchema, { fields: { error: JSON.stringify(error) } }) }]);
  let refuse: ConnectError = tagged(Code.Aborted, "playbook/repo/zeta changed since revision 7 (now 9)", { kind: "stale" });
  serve({ savePlaybook: () => Promise.reject(refuse) as never });
  const stale = await savePlaybookSource({ target: ref("repo", "zeta") as never, source: "s", overwrite: true }, "/a").catch((e) => e);
  expect(stale).toBeInstanceOf(PlaybookRefusal);
  expect(stale.message).toContain("changed since revision 7");
  expect(stale.message).toContain("Reopen the playbook");
  refuse = tagged(Code.InvalidArgument, "invalid playbook", {
    kind: "invalid",
    diagnostics: [{ code: "unknown_field", message: "x", line: 1, field: "step.mode", severity: "error" }],
  });
  const invalid = await savePlaybookSource({ target: ref("repo", "zeta") as never, source: "s", overwrite: false }, "/a").catch((e) => e);
  expect(invalid).toMatchObject({ kind: "invalid", diagnostics: [{ field: "step.mode" }] });
});

it("deleting a repository playbook forgets its community import first, and a failure there stops the delete", async () => {
  const order: string[] = [];
  serve({
    deletePlaybook: () => {
      order.push("delete");
      return { applied: { cursor: cursor(1) } } as never;
    },
  });
  ipcMocks.forgetCommunityImport.mockImplementation(async () => void order.push("forget"));
  await deletePlaybookSource(ref("repo", "zeta") as never, "/a");
  await deletePlaybookSource(ref("global", "alpha") as never, "/a");
  expect(order).toEqual(["forget", "delete", "delete"]);
  expect(ipcMocks.forgetCommunityImport).toHaveBeenCalledWith("/a", "zeta");

  ipcMocks.forgetCommunityImport.mockRejectedValue("community import registry unreadable");
  await expect(deletePlaybookSource(ref("repo", "zeta") as never, "/a")).rejects.toBe("community import registry unreadable");
  expect(order).toEqual(["forget", "delete", "delete"]);
});

it("picker preferences from a window with no repository go to the global file", async () => {
  const sent: { global: boolean; order: number; entry: string | undefined }[] = [];
  serve({
    savePicker: (request) => {
      sent.push({ global: request.global, order: request.order.length, entry: request.entries[0]?.badge });
      return { applied: { cursor: cursor(1) } } as never;
    },
  });
  const prefs = {
    order: [ref("global", "alpha") as never],
    entries: [{ reference: ref("global", "alpha") as never, preferred: true, hidden: false, collapsed: false, badge: "x", color: null, last_imported_at_ms: null }],
  };
  await savePlaybookPickerPreferences(prefs, "/a");
  await savePlaybookPickerPreferences(prefs);
  expect(sent).toEqual([
    { global: false, order: 1, entry: "x" },
    { global: true, order: 1, entry: "x" },
  ]);
});
