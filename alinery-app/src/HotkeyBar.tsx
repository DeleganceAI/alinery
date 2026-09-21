import { MousePointer2, Pencil, SquareDashedMousePointer } from "lucide-react";
import { lodLabel, toolLabel } from "./canvas/camera";
import type { CanvasStatus, DaemonStatus } from "./types";
import { type McpStatus, mcpFooterLabel } from "./useMcpStatus";

type Hint = [string, string];

// Context-sensitive hint sets, declarative and kept in sync with the real hotkey map (§6.2).
const HINTS: Record<string, Hint[]> = {
  kanban: [
    ["⌘K", "Search"],
    ["⌘N", "Create"],
    ["⌘E", "Archive"],
    ["⌘D", "Duplicate"],
    ["j / k", "Down/up"],
    ["h / l", "Columns"],
    ["↵", "Open"],
    ["⌘G", "Appearance"],
  ],
  grid: [
    ["⌘K", "Search"],
    ["⌘N", "Create"],
    ["⌘E", "Archive"],
    ["j / k", "Down/up"],
    ["h / l", "Tasks"],
    ["↵", "Open"],
  ],
  list: [
    ["⌘K", "Search"],
    ["⌘N", "Create"],
    ["⌘E", "Archive"],
    ["⌘D", "Duplicate"],
    ["j / k", "Down/up"],
    ["↵", "Open"],
    ["⌘1–5, 7–9", "Views"],
    ["⌘G", "Appearance"],
  ],
  settings: [
    ["⌘K", "Search"],
    ["⌘1–5, 7–9", "Views"],
    ["⌘G", "Appearance"],
    ["esc", "Back"],
  ],
  create: [
    ["⌘↵", "Create"],
    ["esc", "Back"],
    ["⌘K", "Search"],
  ],
  task: [
    ["⌘K", "Search"],
    ["⌘E", "Archive"],
    ["⌘D", "Duplicate"],
    ["esc", "Back"],
  ],
  // Orbitron: no `esc Back` row. Esc cancels a gesture there and never leaves the view,
  // so advertising it as "Back" would be a lie that costs the user their place.
  canvas: [
    ["⌘⇧O", "Exit"],
    ["⌘N", "Create"],
    ["⌘E", "Archive"],
    ["d e a n", "Tools"],
    ["0", "Fit"],
    ["esc", "Cancel"],
  ],
  session: [
    ["⌘K", "Search"],
    ["esc", "Back"],
  ],
};

export function HotkeyBar({
  view,
  daemon,
  mcp,
  showHints = true,
  version = "",
  gridViewName,
  gridViewShortcut,
  canvas,
}: {
  view: string;
  daemon: DaemonStatus;
  mcp: McpStatus;
  showHints?: boolean;
  version?: string;
  gridViewName?: string;
  gridViewShortcut?: string;
  /** Present only while Orbitron is showing: its mode and zoom tier, folded in beside the brand. */
  canvas?: CanvasStatus | null;
}) {
  const baseHints = HINTS[view] ?? HINTS.kanban;
  const hints = view === "grid" && gridViewName && gridViewShortcut ? [...baseHints, [gridViewShortcut, gridViewName] satisfies Hint] : baseHints;
  const duplicateHint = view === "kanban" || view === "list" || view === "task";
  // Dot severity mirrors the visible text: accent while work runs, calm green when
  // idle-but-alive, red if unreachable (§6.2a). The label always carries the state.
  const dotClass = !daemon.reachable ? "down" : daemon.busy > 0 || daemon.waiting_for_input > 0 || daemon.waiting_for_approval > 0 ? "busy" : "ok";
  const mcpLabel = mcpFooterLabel(mcp);
  const daemonStatus = !daemon.reachable ? "Offline" : `${daemon.alive} live session${daemon.alive === 1 ? "" : "s"}`;
  const mcpStatus = !mcp.repo ? "No repository" : mcpLabel ? mcpLabel.replace(/^MCP /, "") : "Unavailable";
  const buildStatus = daemon.build_drift ? "Older build" : daemon.reachable ? "Current" : "Not connected";

  return (
    <footer>
      <div className="fstat">
        <span className={`live ${dotClass}`} aria-hidden="true" />
        <span className={`footer-brand ${dotClass}`}>
          <span>Alinery</span>
          <span className="footer-status-tooltip" id="footer-status-tooltip" role="tooltip">
            <span>
              <b>Daemon</b>
              {daemonStatus}
            </span>
            <span>
              <b>MCP server</b>
              {mcpStatus}
            </span>
            <span>
              <b>Daemon build</b>
              {buildStatus}
            </span>
          </span>
        </span>
        {version && <span className="footer-version">v{version}</span>}
        {canvas && (
          <>
            <span className="sep">·</span>
            <span className="fcanvas">
              <ToolIcon tool={canvas.tool} />
              {toolLabel(canvas.tool)}
            </span>
            <span className="sep">·</span>
            <span className="fcanvas">
              <TierBar tier={canvas.tier} />
              {lodLabel(canvas.tier)}
            </span>
          </>
        )}
      </div>
      {showHints && (
        <div className="keys">
          {hints.map(([key, label]) =>
            key === "⌘D" && !duplicateHint ? null : (
              <span className="keyhint" key={key + label}>
                <b>{key}</b>
                {label}
              </span>
            ),
          )}
        </div>
      )}
    </footer>
  );
}

/** The same glyph the canvas toolbar uses for that tool, so the footer names what is lit up there. */
function ToolIcon({ tool }: { tool: CanvasStatus["tool"] }) {
  const Glyph = tool === "draw" ? Pencil : tool === "edit" ? SquareDashedMousePointer : MousePointer2;
  return <Glyph size={13} strokeWidth={1.5} aria-hidden="true" />;
}

/**
 * The POC's zoom-detail meter: three rising bars, lit up to the current tier. Decorative —
 * the tier's name is the text beside it — but it is the part that reads at a glance, which is
 * why zooming felt unindicated once it was gone.
 */
function TierBar({ tier }: { tier: CanvasStatus["tier"] }) {
  return (
    <span className="tierbar" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <i className={i <= tier ? "on" : undefined} key={i} />
      ))}
    </span>
  );
}
