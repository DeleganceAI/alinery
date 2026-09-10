import { X } from "lucide-react";
import type { DumpTool } from "../chatTranscript";
import { Dialog } from "../shared";

export function ChatToolsDialog({ tools, onClose }: { tools: DumpTool[]; onClose: () => void }) {
  return (
    <Dialog onClose={onClose} ariaLabel="Tools this turn" className="chat-tools-dialog">
      <div className="mh">
        <span className="mt">Tools this turn</span>
        <button type="button" className="x" aria-label="Close" title="Close" onClick={onClose}>
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
      <div className="mb">
        <p className="dim">Active agent tools from get_state. Toggling OMP built-ins needs Terminal.</p>
        {tools.length === 0 ? <p className="dim">No tools in the current dump.</p> : null}
        <ul className="chat-model-list">
          {tools.map((tool) => (
            <li key={tool.name} className="chat-tool-row">
              <span className="chat-cmd-name">{tool.name}</span>
              {tool.description ? <span className="chat-cmd-desc">{tool.description}</span> : null}
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
