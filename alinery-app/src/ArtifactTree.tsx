import { useState } from "react";
import { AttachmentPreview } from "./AttachmentPreview";
import { classifyAttachment } from "./chat/attachments";
import * as ipc from "./ipc";
import type { ArtifactTreeNode } from "./types";

export function isDirectOwnedArtifactNode(node: ArtifactTreeNode): boolean {
  return node.kind === "owned" && node.source === "owned" && node.children.length === 0;
}

function nodeChain(nodes: ArtifactTreeNode[], id: string): ArtifactTreeNode[] {
  for (const node of nodes) {
    if (node.id === id) return [node];
    const chain = nodeChain(node.children, id);
    if (chain.length > 0) return [node, ...chain];
  }
  return [];
}

/**
 * Where a tree-sourced (parent, live child or snapshot) artifact's relative images resolve: its path under its
 * namespace root, the nearest folder owned by a different task than its parent, and that root's attachment node ids,
 * so a snapshot reads its own copy. Owned artifacts resolve by path instead (undefined). A node missing from the
 * tree yields no ids, so its images stay untouched.
 */
export function treeArtifactImages(nodes: ArtifactTreeNode[], node: ArtifactTreeNode | null) {
  if (!node || node.source === "owned") return undefined;
  const chain = nodeChain(nodes, node.id);
  let root = 0;
  for (let index = 1; index < chain.length - 1; index += 1) {
    if (chain[index].owner_task_slug !== chain[index - 1].owner_task_slug) root = index;
  }
  // Attachments sit one level down, in the root's "Attachments" folder (artifact_tree.rs attachment_folder).
  const attachments = chain.length > 1 ? chain[root].children.flatMap((child) => child.children).filter((child) => child.kind === "attachment") : [];
  return {
    artifactPath: chain
      .slice(root + 1)
      .map((item) => item.label)
      .join("/"),
    attachmentNodeIds: new Map(attachments.map((attachment) => [attachment.label, attachment.id])),
  };
}

const sourceLabels: Partial<Record<ArtifactTreeNode["source"], string>> = {
  parent_context: "Parent",
  active_child: "Live",
  snapshot: "Snapshot",
};

function ArtifactTreeRow({
  node,
  taskSlug,
  depth,
  selectedId,
  collapsed,
  onToggle,
  onSelect,
  onError,
}: {
  node: ArtifactTreeNode;
  taskSlug: string;
  depth: number;
  selectedId?: string;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onSelect: (node: ArtifactTreeNode) => void;
  onError: (error: string) => void;
}) {
  const folder = node.kind === "subtask_folder";
  const isCollapsed = collapsed.has(node.id);
  const badge = sourceLabels[node.source];
  if (node.kind === "attachment" && classifyAttachment({ name: node.label }) === "image") {
    return (
      <div style={{ paddingLeft: `${depth * 16}px` }}>
        <AttachmentPreview taskSlug={taskSlug} name={node.label} nodeId={node.id}>
          {badge && <span className={`artifact-source-badge ${node.source}`}>{badge}</span>}
        </AttachmentPreview>
      </div>
    );
  }
  return (
    <>
      <button
        type="button"
        className={`artifactitem artifact-tree-row${selectedId === node.id ? " selected" : ""}${node.kind === "attachment" ? " attachment" : ""}`}
        style={{ paddingLeft: `${10 + depth * 16}px` }}
        title={node.label}
        onClick={() => {
          if (folder) {
            onToggle(node.id);
          } else if (node.kind === "attachment") {
            ipc
              .artifactNodePath(taskSlug, node.id)
              .then(ipc.revealItemInDir)
              .catch((error) => onError(String(error)));
          } else {
            onSelect(node);
          }
        }}
      >
        <span className="artifact-tree-chevron" aria-hidden="true">
          {folder ? (isCollapsed ? "›" : "⌄") : ""}
        </span>
        <span className="artifactitem-name">{node.label}</span>
        {badge && <span className={`artifact-source-badge ${node.source}`}>{badge}</span>}
      </button>
      {folder &&
        !isCollapsed &&
        node.children.map((child) => (
          <ArtifactTreeRow
            key={child.id}
            node={child}
            taskSlug={taskSlug}
            depth={depth + 1}
            selectedId={selectedId}
            collapsed={collapsed}
            onToggle={onToggle}
            onSelect={onSelect}
            onError={onError}
          />
        ))}
    </>
  );
}

export function ArtifactTree({
  taskSlug,
  nodes,
  selectedId,
  onSelect,
  onError,
}: {
  taskSlug: string;
  nodes: ArtifactTreeNode[];
  selectedId?: string;
  onSelect: (node: ArtifactTreeNode) => void;
  onError: (error: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (nodes.length === 0) return <div className="dim">No artifacts yet.</div>;
  return (
    <div className="artifact-tree">
      {nodes.map((node) => (
        <ArtifactTreeRow
          key={node.id}
          node={node}
          taskSlug={taskSlug}
          depth={0}
          selectedId={selectedId}
          collapsed={collapsed}
          onToggle={toggle}
          onSelect={onSelect}
          onError={onError}
        />
      ))}
    </div>
  );
}
