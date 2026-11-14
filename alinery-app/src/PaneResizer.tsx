import { ChevronRight } from "lucide-react";
import type { ArtifactPaneCollapse, useArtifactPaneWidth } from "./useArtifactPaneWidth";

/**
 * The divider beside a side pane. Collapsed, it stays as a thin rail with a button that reopens the pane; it stays
 * the same element so a drag that snapped the pane shut can pull it back open.
 */
export function PaneResizer({ props, collapse }: { props: ReturnType<typeof useArtifactPaneWidth>[1]; collapse: ArtifactPaneCollapse }) {
  return (
    <div className={`artifact-resizer${collapse.collapsed ? " collapsed" : ""}`} {...props}>
      {collapse.collapsed && (
        <button
          type="button"
          className="pane-reopen"
          aria-label="Show side panel"
          title="Show side panel"
          onPointerDown={(ev) => ev.stopPropagation()}
          onClick={() => collapse.setCollapsed(false)}
        >
          <ChevronRight size={12} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
