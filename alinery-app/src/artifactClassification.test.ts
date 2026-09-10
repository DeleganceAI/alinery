import { describe, expect, it } from "vitest";
import { artifactPaneItems, artifactPaneTreeNodes } from "./artifactClassification";
import type { ArtifactTreeNode } from "./types";

describe("artifactPaneItems", () => {
  const items = [
    { name: "00-ticket.md" },
    { name: "potential-wiki-changes-001.md" },
    { name: "potential-wiki-changes-001.page-x.comments.md" },
    { name: "potential-wiki-changes-001.page-x.review-002.md" },
    { name: "diagram.png", attachment: true },
    { name: "potential-wiki-changes-002.md", attachment: true },
  ];

  it("keeps every retained non-attachment in Playbook", () => {
    expect(artifactPaneItems(items, "playbook").map((item) => item.name)).toEqual([
      "00-ticket.md",
      "potential-wiki-changes-001.md",
      "potential-wiki-changes-001.page-x.comments.md",
      "potential-wiki-changes-001.page-x.review-002.md",
    ]);
  });

  it("uses attachment metadata instead of filename shape", () => {
    expect(artifactPaneItems(items, "attachments").map((item) => item.name)).toEqual(["diagram.png", "potential-wiki-changes-002.md"]);
    expect(artifactPaneItems(items, "playbook").map((item) => item.name)).not.toContain("potential-wiki-changes-002.md");
  });

  it("puts every item in exactly one tab", () => {
    const total = (["playbook", "attachments"] as const).reduce((count, tab) => count + artifactPaneItems(items, tab).length, 0);
    expect(total).toBe(items.length);
  });
});

describe("artifactPaneTreeNodes", () => {
  const tree: ArtifactTreeNode[] = [
    {
      id: "parent",
      kind: "subtask_folder",
      label: "Parent context",
      owner_task_slug: "parent",
      source: "parent_context",
      children: [
        { id: "playbook", kind: "referenced", label: "potential-wiki-changes-001.md", owner_task_slug: "parent", source: "parent_context", children: [] },
        {
          id: "attachments",
          kind: "subtask_folder",
          label: "Attachments",
          owner_task_slug: "parent",
          source: "parent_context",
          children: [
            {
              id: "proposal-attachment",
              kind: "attachment",
              label: "potential-wiki-changes-002.md",
              owner_task_slug: "parent",
              source: "parent_context",
              children: [],
            },
          ],
        },
      ],
    },
  ];
  const labels = (nodes: ArtifactTreeNode[]): string[] => nodes.flatMap((node) => [node.label, ...labels(node.children)]);

  it("retains folder ancestry and partitions by node kind", () => {
    expect(labels(artifactPaneTreeNodes(tree, "playbook"))).toEqual(["Parent context", "potential-wiki-changes-001.md"]);
    expect(labels(artifactPaneTreeNodes(tree, "attachments"))).toEqual(["Parent context", "Attachments", "potential-wiki-changes-002.md"]);
    expect(tree[0].children).toHaveLength(2);
  });
});
