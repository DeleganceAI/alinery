import { Bot } from "lucide-react";
import { formatDuration, formatTinyTime } from "../chat/format";
import type { LiveSubagent } from "../chat/subagents";
import { RunningIndicator } from "../Indicators";

export function SubagentDrawer({ agents }: { agents: LiveSubagent[] }) {
  if (agents.length === 0) return null;
  return (
    <div className="chat-sub-drawer">
      <p className="chat-sub-label">subagents · {agents.length} running</p>
      <div className="chat-sub-row">
        {agents.map((agent) => (
          <article key={agent.id} className="chat-sub-card">
            <header className="chat-sub-head">
              <Bot className="chat-rail-icon" strokeWidth={1.5} aria-hidden />
              <span className="chat-sub-name">{agent.name}</span>
              {agent.role ? <span className="chat-work-meta">{agent.role}</span> : null}
              <span className="chat-sub-status">
                <RunningIndicator />
                {agent.status}
              </span>
            </header>
            <p className="chat-sub-preview">{agent.preview}</p>
            <p className="chat-work-meta">
              {agent.at != null ? formatTinyTime(agent.at) : ""}
              {agent.tools != null ? ` · ${agent.tools} tools` : ""}
              {agent.durationMs != null ? ` · ${formatDuration(agent.durationMs)}` : ""}
            </p>
          </article>
        ))}
      </div>
    </div>
  );
}
