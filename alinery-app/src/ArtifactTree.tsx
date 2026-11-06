import { useState } from "react";
import { AttachmentPreview } from "./AttachmentPreview";
import { classifyAttachment } from "./chat/attachments";
import { revealPath } from "./revealPath";
import { alineryFilePath } from "./sync/artifacts";
import type { ArtifactTreeNode } from "./types";

export function isDirectOwnedArtifactNode(node: ArtifactTreeNode): boolean {
  return node.kind === "owned" && node.source === "owned" && node.children.length === 0;
}

const sourceLabels: Partial<Record<ArtifactTreeNode["source"], string>> = {
  parent_context: "Parent",
  active_child: "Live",
  snapshot: "Snapshot",
};

function ArtifactTreeRow({
  node,
  taskSlug,
  repoPath,
  depth,
  selectedId,
  collapsed,
  onToggle,
  onSelect,
  onError,
}: {
  node: ArtifactTreeNode;
  taskSlug: string;
  repoPath: string;
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
        <AttachmentPreview taskSlug={taskSlug} name={node.label} nodeId={node.id} repoPath={repoPath} revealBelow={node.reveal_path}>
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
            if (node.reveal_path) revealPath(alineryFilePath(repoPath, node.reveal_path)).catch((error) => onError(String(error)));
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
            repoPath={repoPath}
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
  repoPath,
  nodes,
  selectedId,
  onSelect,
  onError,
}: {
  taskSlug: string;
  repoPath: string;
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
          repoPath={repoPath}
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
