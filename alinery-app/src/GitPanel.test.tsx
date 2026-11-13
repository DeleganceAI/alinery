import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockIpc } from "./test/mockIpc";

const mocks = vi.hoisted(() => ({
  log: vi.fn(),
  diff: vi.fn(),
}));
vi.mock("./ipc", () => mockIpc({}));
vi.mock("./sync/git", () => ({ worktreeLogForRepo: mocks.log, worktreeDiffForRepo: mocks.diff }));

import { GitDiffView, GitPanel, splitPatch } from "./GitPanel";

afterEach(cleanup);

const PATCH = [
  "commit abc",
  "Author: t",
  "",
  "    bump a",
  "",
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1..2 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-export const a = 1;",
  "+export const a = 2;",
  "diff --git a/new.ts b/new.ts",
  "--- /dev/null",
  "+++ b/new.ts",
  "@@ -0,0 +1,2 @@",
  "+n",
  "+m",
  "",
].join("\n");

describe("splitPatch", () => {
  it("keeps the commit header apart and counts each file's added and removed lines", () => {
    const { header, files } = splitPatch(PATCH);
    expect(header).toContain("bump a");
    expect(files.map((f) => [f.path, f.added, f.removed])).toEqual([
      ["src/a.ts", 1, 1],
      ["new.ts", 2, 0],
    ]);
  });
});

describe("GitPanel", () => {
  it("lists changes before commits and opens each, kept on a double click", async () => {
    mocks.log.mockResolvedValue({ commits: [{ oid: "a".repeat(40), subject: "bump a", author: "t", time_ms: 0 }], base: "main", truncated: false, staged: 1, uncommitted: 2 });
    const onOpen = vi.fn();
    render(<GitPanel repoPath="/repo" taskSlug="task" onOpen={onOpen} />);
    expect(await screen.findByText("Commits since main")).toBeDefined();
    const rows = screen.getAllByRole("button").filter((b) => b.classList.contains("git-row"));
    expect(rows.map((r) => r.title)).toEqual(["Uncommitted changes", "Staged changes", "bump a"]);
    expect(screen.getByText("2 files")).toBeDefined();
    fireEvent.click(rows[2]);
    expect(onOpen).toHaveBeenLastCalledWith({ kind: "commit", oid: "a".repeat(40) }, "bump a", false);
    fireEvent.click(rows[0], { detail: 2 });
    expect(onOpen).toHaveBeenLastCalledWith({ kind: "uncommitted" }, "Uncommitted changes", true);

    mocks.log.mockResolvedValue({ commits: [], base: "main", truncated: false, staged: 0, uncommitted: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("No changes on this branch yet.")).toBeDefined();
  });

  it("shows a diff as one section per file", async () => {
    mocks.diff.mockResolvedValue({ patch: PATCH, truncated: false });
    render(<GitDiffView repoPath="/repo" taskSlug="task" target={{ kind: "commit", oid: "abc1234" }} />);
    const section = await screen.findByRole("region", { name: "src/a.ts" });
    expect(section.querySelector(".diff-add")?.textContent).toBe("+1");
    expect(section.querySelector(".git-diff-lines .diff-del")?.textContent).toBe("-export const a = 1;\n");
    expect(screen.getByRole("region", { name: "new.ts" })).toBeDefined();
    expect(mocks.diff).toHaveBeenCalledWith("/repo", "task", { kind: "commit", oid: "abc1234" });
    await waitFor(() => expect(document.querySelector(".git-diff-header")?.textContent).toContain("bump a"));
  });
});
