import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ArtifactTree, isDirectOwnedArtifactNode } from "./ArtifactTree";
import type { ArtifactTreeNode } from "./types";

const ipcMocks = vi.hoisted(() => ({
  revealItemInDir: vi.fn(),
}));

vi.mock("./ipc", () => ipcMocks);
vi.mock("./sync/artifacts", async (actual) => ({
  ...(await actual<typeof import("./sync/artifacts")>()),
  readNodeBytes: () => new Promise<Uint8Array>(() => {}),
}));

const nodes: ArtifactTreeNode[] = [
  {
    id: "parent",
    kind: "subtask_folder",
    label: "Parent context",
    owner_task_slug: "parent",
    source: "parent_context",
    children: [
      {
        id: "parent-file",
        kind: "referenced",
        label: "01-parent.md",
        owner_task_slug: "parent",
        source: "parent_context",
        children: [],
      },
    ],
  },
  {
    id: "snapshot",
    kind: "subtask_folder",
    label: "child",
    owner_task_slug: "child",
    source: "snapshot",
    children: [
      {
        id: "attachment",
        kind: "attachment",
        label: "evidence.png",
        owner_task_slug: "child",
        source: "snapshot",
        children: [],
        reveal_path: "tasks/child/artifacts/attachments/evidence.png",
      },
    ],
  },
  {
    id: "owned",
    kind: "owned",
    label: "06-implementation.md",
    owner_task_slug: "task",
    source: "owned",
    children: [],
  },
];

describe("ArtifactTree", () => {
  it("renders recursive ownership sources and attachments", () => {
    const html = renderToStaticMarkup(<ArtifactTree taskSlug="task" repoPath="/repo" nodes={nodes} onSelect={() => {}} onError={() => {}} />);
    expect(html).toContain("Parent context");
    expect(html).toContain("01-parent.md");
    expect(html).toContain("Snapshot");
    expect(html).toContain("evidence.png");
    expect(html).toContain("06-implementation.md");
  });

  it("marks only direct owned files as writable playbook artifacts", () => {
    expect(isDirectOwnedArtifactNode(nodes[2])).toBe(true);
    expect(isDirectOwnedArtifactNode(nodes[0].children[0])).toBe(false);
    expect(isDirectOwnedArtifactNode(nodes[1].children[0])).toBe(false);
  });

  it("reveals an attachment node at the path the daemon gave, below the repo's .alinery", async () => {
    render(<ArtifactTree taskSlug="task" repoPath="/repo" nodes={nodes} onSelect={() => {}} onError={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Show evidence.png in folder" }));
    await waitFor(() => expect(ipcMocks.revealItemInDir).toHaveBeenCalledWith("/repo/.alinery/tasks/child/artifacts/attachments/evidence.png"));
  });
});
