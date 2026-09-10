import { X } from "lucide-react";
import type { McpServerRow } from "../chat/slash";
import { Dialog } from "../shared";

export function ChatMcpDialog({ rows, empty, onPrompt, onClose }: { rows: McpServerRow[]; empty: boolean; onPrompt: (message: string) => void; onClose: () => void }) {
  return (
    <Dialog onClose={onClose} ariaLabel="MCP servers" className="chat-mcp-dialog">
      <div className="mh">
        <span className="mt">MCP servers</span>
        <button type="button" className="x" aria-label="Close" title="Close" onClick={onClose}>
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
      <div className="mb">
        <p className="dim">List from /mcp list. OAuth verbs stay on Terminal.</p>
        {empty ? <p className="dim">No MCP servers configured.</p> : null}
        <ul className="chat-model-list">
          {rows.map((row) => (
            <li key={row.name} className="chat-mcp-row">
              <div>
                <span className="chat-cmd-name">{row.name}</span>
                <span className="chat-work-meta">
                  {row.type} · {row.enabled ? "enabled" : "disabled"} · {row.location}
                </span>
              </div>
              <button type="button" className="btn ghost small" onClick={() => onPrompt(row.enabled ? `/mcp disable ${row.name}` : `/mcp enable ${row.name}`)}>
                {row.enabled ? "Disable" : "Enable"}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="mfoot">
        <button type="button" className="btn ghost small" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}
