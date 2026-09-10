import type { ArtifactTreeNode } from "./types";

export type ArtifactPaneTab = "playbook" | "attachments";

export function artifactPaneItems<T extends { name: string; attachment?: boolean }>(items: T[], tab: ArtifactPaneTab): T[] {
  if (tab === "attachments") return items.filter((item) => item.attachment);
  return items.filter((item) => !item.attachment);
}

export function artifactPaneTreeNodes(nodes: ArtifactTreeNode[], tab: ArtifactPaneTab): ArtifactTreeNode[] {
  return nodes.flatMap((node) => {
    if (node.kind === "subtask_folder") {
      const children = artifactPaneTreeNodes(node.children, tab);
      if (children.length > 0) return [{ ...node, children }];
      return node.children.length === 0 && tab === "playbook" ? [node] : [];
    }
    const matches = node.kind === "attachment" ? tab === "attachments" : tab === "playbook";
    return matches ? [node] : [];
  });
}
