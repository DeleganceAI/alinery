import { describe, expect, it } from "vitest";
import { libraryRows, lineDiff, SIGNAL_STATES, statusOf } from "./playbookLibrary";
import type { CommunityImportRow, CommunitySummary, DownloadStatusRow, PlaybookCandidate } from "./types";

const candidate = (scope: "bundled" | "global" | "repo", key: string, broken = false, body_sha256?: string, path: string | null = null): PlaybookCandidate => ({
  source: { reference: { scope, key }, path },
  title: key,
  description: null,
  modified_at_ms: null,
  diagnostics: broken ? [{ field: "steps", message: "bad" } as never] : [],
  ...(body_sha256 ? { body_sha256 } : {}),
});
const imported = (localKey: string, overrides: Partial<CommunityImportRow> = {}): CommunityImportRow => ({
  id: `id-${localKey}`,
  label: "ada",
  playbookKey: localKey,
  localKey,
  importedVersion: 2,
  ...overrides,
});
const status = (localKey: string, overrides: Partial<DownloadStatusRow> = {}): DownloadStatusRow => ({
  id: `id-${localKey}`,
  label: "ada",
  playbookKey: localKey,
  localKey,
  title: null,
  description: null,
  importedVersion: 2,
  remoteVersion: 2,
  updateAvailable: false,
  remoteMissing: false,
  localMissing: false,
  locallyEdited: false,
  error: null,
  ...overrides,
});
const listing = (playbookKey: string, overrides: Partial<CommunitySummary> = {}): CommunitySummary =>
  ({ id: `pub-${playbookKey}`, label: "me", playbookKey, title: playbookKey, description: "", version: 3, bodySha256: "aaa", stepCount: 4, ...overrides }) as CommunitySummary;

const one = (inputs: Partial<Parameters<typeof libraryRows>[0]>) => libraryRows({ candidates: [], imports: [], downloads: null, mine: null, published: [], ...inputs });

describe("libraryRows", () => {
  it("names a built-in by origin Alinery and range All repos", () => {
    const [row] = one({ candidates: [candidate("bundled", "superdevelop")] });
    expect([row.origin.kind, row.range, row.state]).toEqual(["alinery", "All repos", "builtin"]);
    expect(statusOf(row)).toEqual({ label: "Built in", tone: "dim" });
  });

  it("reads your own playbook against your listings", () => {
    const candidates = [candidate("global", "a"), candidate("repo", "b", false, "same"), candidate("repo", "c", false, "new"), candidate("repo", "d")];
    const mine = [listing("b", { bodySha256: "same" }), listing("c", { bodySha256: "old" }), listing("d")];
    const rows = one({ candidates, mine });
    expect(rows.map((row) => row.state)).toEqual(["private", "live", "changed", "live"]);
    expect(rows.map((row) => statusOf(row).label)).toEqual(["Not published", "Live · v3", "Changes not published", "Live · v3"]);
    expect(rows[0].range).toBe("All repos");
    expect(rows[1].range).toBe("This repo");
  });

  it("says only Yours while your listings are unknown", () => {
    expect(one({ candidates: [candidate("repo", "a")] })[0].state).toBe("yours");
  });

  it("walks a download through every state", () => {
    const keys = ["checking", "synced", "edited", "update", "diverged", "withdrawn"];
    const rows = one({
      candidates: keys.map((key) => candidate("repo", key)),
      imports: keys.map((key) => imported(key)),
      downloads: [
        status("synced"),
        status("edited", { locallyEdited: true }),
        status("update", { remoteVersion: 4, updateAvailable: true }),
        status("diverged", { remoteVersion: 4, updateAvailable: true, locallyEdited: true }),
        status("withdrawn", { remoteMissing: true }),
      ],
    });
    expect(rows.map((row) => row.state)).toEqual(["downloaded", "synced", "edited", "update", "diverged", "withdrawn"]);
    expect(rows.map((row) => statusOf(row).label)).toEqual(["v2", "v2 · current", "Edited · v2", "v2 → v4", "Edited · update waiting", "Withdrawn by author"]);
    expect(rows[0].origin).toEqual({ kind: "download", label: "ada", id: "id-checking" });
    expect(rows.filter((row) => SIGNAL_STATES.has(row.state)).map((row) => row.state)).toEqual(["update", "diverged", "withdrawn"]);
  });

  it("trusts the registry's edit mark before the community answers", () => {
    expect(one({ candidates: [candidate("repo", "x")], imports: [imported("x", { locallyEdited: true })] })[0].state).toBe("edited");
  });

  it("marks an unreadable playbook whatever its origin", () => {
    const rows = one({ candidates: [candidate("bundled", "a", true), candidate("repo", "b", true)], imports: [imported("b")], mine: [] });
    expect(rows.map((row) => [row.state, statusOf(row).tone])).toEqual([
      ["broken", "bad"],
      ["broken", "bad"],
    ]);
  });

  it("lists your publications that have no copy here", () => {
    const rows = one({ candidates: [candidate("repo", "kept")], imports: [imported("dl", { id: "pub-dl" })], mine: [listing("kept"), listing("gone"), listing("dl")] });
    expect(rows.map((row) => [row.id, row.state])).toEqual([
      ["repo/kept", "live"],
      ["listing:pub-gone", "remote"],
    ]);
    expect(statusOf(rows[1]).label).toBe("Live · v3 · not here");
  });
});

describe("links and origins", () => {
  it("gives a listing to the copy it was published from, and the other copy of that key stays unpublished", () => {
    const rows = one({
      candidates: [candidate("global", "review"), candidate("repo", "review")],
      mine: [listing("review")],
      published: [{ id: "pub-review", reference: { scope: "global", key: "review" } }],
    });
    expect(rows.map((row) => [row.id, row.state])).toEqual([
      ["global/review", "live"],
      ["repo/review", "private"],
    ]);
  });

  it("matches an unlinked listing by key once, and never claims a linked one by key", () => {
    const rows = one({
      candidates: [candidate("global", "a"), candidate("repo", "a"), candidate("repo", "b")],
      mine: [listing("a"), listing("b", { id: "pub-b" })],
      published: [{ id: "pub-b", reference: { scope: "global", key: "gone" } }],
    });
    expect(rows.map((row) => [row.id, row.state])).toEqual([
      ["global/a", "live"],
      ["repo/a", "private"],
      ["repo/b", "private"],
      ["listing:pub-b", "remote"],
    ]);
  });

  it("reads a committed playbook as Team, read-only", () => {
    const [row] = one({ candidates: [candidate("repo", "release", false, undefined, "/work/app/alinery/playbooks/release.md")], mine: [listing("release")] });
    expect([row.origin.kind, row.state, statusOf(row).label]).toEqual(["team", "team", "Team · read-only"]);
    expect(row.publication).toBeNull();
  });

  it("finds a download kept for every repository in the global scope", () => {
    const rows = one({ candidates: [candidate("global", "x"), candidate("repo", "x")], imports: [imported("x", { localScope: "global" })] });
    expect(rows.map((row) => [row.id, row.origin.kind, row.range])).toEqual([
      ["global/x", "download", "All repos"],
      ["repo/x", "mine", "This repo"],
    ]);
  });
});

it("diffs lines: what only your copy has is del, what only theirs has is add", () => {
  expect(lineDiff("a\nb\nc", "a\nB\nc\nd").map(({ kind, text }) => [kind, text])).toEqual([
    ["same", "a"],
    ["del", "b"],
    ["add", "B"],
    ["same", "c"],
    ["add", "d"],
  ]);
  expect(lineDiff("same", "same")).toEqual([{ at: 0, kind: "same", text: "same" }]);
});
