import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ArtifactTree, isDirectOwnedArtifactNode, treeArtifactImages } from "./ArtifactTree";
import type { ArtifactTreeNode } from "./types";

const ipcMocks = vi.hoisted(() => ({
  artifactNodePath: vi.fn(() => Promise.resolve("/tmp/evidence.png")),
  revealItemInDir: vi.fn(),
  readAttachmentImage: vi.fn(() => new Promise<ArrayBuffer>(() => {})),
}));

vi.mock("./ipc", () => ipcMocks);

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
    const html = renderToStaticMarkup(<ArtifactTree taskSlug="task" nodes={nodes} onSelect={() => {}} onError={() => {}} />);
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

  it("derives a tree artifact's image path and attachment ids from its namespace root", () => {
    const node = (id: string, kind: ArtifactTreeNode["kind"], label: string, owner: string, source: ArtifactTreeNode["source"], children: ArtifactTreeNode[] = []) => ({
      id,
      kind,
      label,
      owner_task_slug: owner,
      source,
      children,
    });
    const parentReport = node("parent-report", "referenced", "01-report.md", "parent", "parent_context");
    const findings = node("snapshot-findings", "referenced", "findings.md", "child", "snapshot");
    const tree = [
      node("parent", "subtask_folder", "Parent context", "parent", "parent_context", [
        node("parent-attachments", "subtask_folder", "Attachments", "parent", "parent_context", [node("parent-shot", "attachment", "shot.png", "parent", "parent_context")]),
        parentReport,
        node("snapshot", "subtask_folder", "child", "child", "snapshot", [
          node("snapshot-attachments", "subtask_folder", "Attachments", "child", "snapshot", [node("snapshot-shot", "attachment", "shot.png", "child", "snapshot")]),
          node("snapshot-research", "subtask_folder", "research", "child", "snapshot", [findings]),
        ]),
      ]),
    ];

    expect(treeArtifactImages(tree, parentReport)).toEqual({ artifactPath: "01-report.md", attachmentNodeIds: new Map([["shot.png", "parent-shot"]]) });
    expect(treeArtifactImages(tree, findings)).toEqual({ artifactPath: "research/findings.md", attachmentNodeIds: new Map([["shot.png", "snapshot-shot"]]) });
    expect(treeArtifactImages(tree, { ...findings, id: "gone" })?.attachmentNodeIds.size).toBe(0);
    expect(treeArtifactImages(tree, nodes[2])).toBeUndefined();
    expect(treeArtifactImages(tree, null)).toBeUndefined();
  });

  it("resolves attachment nodes through the opaque backend ID before reveal", async () => {
    render(<ArtifactTree taskSlug="task" nodes={nodes} onSelect={() => {}} onError={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Show evidence.png in folder" }));
    await waitFor(() => expect(ipcMocks.artifactNodePath).toHaveBeenCalledWith("task", "attachment"));
    expect(ipcMocks.revealItemInDir).toHaveBeenCalledWith("/tmp/evidence.png");
  });
});
