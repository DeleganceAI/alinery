import type { DaemonStatus } from "./types";
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
}: {
  view: string;
  daemon: DaemonStatus;
  mcp: McpStatus;
  showHints?: boolean;
  version?: string;
  gridViewName?: string;
  gridViewShortcut?: string;
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
