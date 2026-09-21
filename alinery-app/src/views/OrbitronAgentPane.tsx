import { Bot, X } from "lucide-react";
import { type ReactNode, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import type { ModeApply } from "../canvas/host-tools";
import { RunningIndicator, StateIcon } from "../Indicators";
import * as ipc from "../ipc";
import { EmptyState, InlineStatus } from "../shared";
import type { CanvasEditMode, HostToolCall, OrbitronAgentEvent, OrbitronAgentStatus } from "../types";
import { atBottom, canSend, gateKind, MODE_LABELS, parseHostToolCall, resizeAgentPane, statusLabel, summarizeHostTool } from "./orbitron-agent";
import { XaiKeyDialog } from "./XaiKeyDialog";

const MCP_OFF = "Task and session tools are off. You can chat, but the agent cannot read tasks, sessions, or artifacts until MCP is enabled in Settings.";

/**
 * Product chat for the Orbitron manager. Talks only through ipc.ts. Board writes consult
 * CanvasEditMode via onHostTool / applyBoardToolForMode. Never raw invoke/fetch.
 *
 * The transcript is attributed turns rather than chat bubbles: DESIGN.md's AI patterns are
 * explicit that this app is not a chat application, so the user's words sit in an inset block
 * and the agent's reply is plain prose on the panel. The asymmetry is what separates them —
 * two mirrored bubbles would be one container per line for no added meaning.
 */
export function OrbitronAgentPane({
  onClose,
  repoPath,
  mode,
  onModeChange,
  onHostTool,
  mcpEnabled,
  pendingCall,
  onAccept,
  onReject,
  width,
  onWidthChange,
}: {
  onClose: () => void;
  repoPath: string;
  mode: CanvasEditMode;
  onModeChange: (mode: CanvasEditMode) => void;
  onHostTool: (call: HostToolCall, id: string) => Promise<ModeApply>;
  mcpEnabled: boolean;
  pendingCall: HostToolCall | null;
  onAccept: () => void;
  onReject: () => void;
  /** Owned by the board, which also steps its chrome aside by this much. */
  width: number;
  onWidthChange: (width: number) => void;
}) {
  const [gate, setGate] = useState<"omp" | "key" | null | "loading">("loading");
  const [status, setStatus] = useState<OrbitronAgentStatus>("idle");
  const [messages, setMessages] = useState<{ id: number; role: "user" | "assistant"; text: string }[]>([]);
  const nextId = useRef(1);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [noticeMcp, setNoticeMcp] = useState(!mcpEnabled);
  const started = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Whether the reader was at the bottom the last time they scrolled — the transcript
  // follows new text only then, so reading back through a long reply is not interrupted.
  const wasAtBottom = useRef(true);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    let alive = true;
    ipc
      .orbitronAgentAvailability()
      .then((a) => {
        if (!alive) return;
        const kind = gateKind(a);
        setGate(kind);
        setNoticeMcp(!a.mcpEnabled);
        if (kind) return;
        if (started.current) return;
        started.current = true;
        const onEvent = new ipc.Channel<OrbitronAgentEvent>();
        onEvent.onmessage = (event) => {
          if (event.type === "status") setStatus(event.status);
          else if (event.type === "message") {
            setMessages((cur) => {
              const last = cur[cur.length - 1];
              if (event.role === "assistant" && last?.role === "assistant" && !event.done) {
                return [...cur.slice(0, -1), { ...last, text: last.text + event.text }];
              }
              const id = nextId.current++;
              return [...cur, { id, role: event.role, text: event.text }];
            });
          } else if (event.type === "hostToolCall") {
            const call = parseHostToolCall(event.toolName, event.arguments);
            if (!call) {
              void ipc.orbitronHostToolResult({ repoPath, id: event.id, result: "Unknown board tool.", isError: true });
              return;
            }
            void onHostTool(call, event.id);
          } else if (event.type === "error") setError(event.message);
        };
        void ipc.startOrbitronAgent({ repoPath, onEvent });
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [onHostTool, repoPath]);

  const send = () => {
    const text = draft.trim();
    if (!text || !canSend({ status, gate: gate === "loading" ? null : gate })) return;
    setMessages((cur) => [...cur, { id: nextId.current++, role: "user", text }]);
    setDraft("");
    void ipc.sendOrbitronAgentPrompt({
      repoPath,
      text,
      streamingBehavior: status === "thinking" ? "followUp" : undefined,
    });
  };

  // Follow the newest text only if the reader was already at the bottom when they last
  // scrolled. Streaming into a transcript someone is reading further up must not yank them
  // back down (DESIGN.md §Component behavior rules).
  useEffect(() => {
    const box = scrollRef.current;
    if (box && wasAtBottom.current) box.scrollTop = box.scrollHeight;
  }, [messages, status, pendingCall]);

  // Pointer drag on the pane's leading edge. The pane is right-docked, so leftward is wider.
  // A drag that ends narrower than the minimum closes the pane — the commit is on release,
  // because a transcript is worth more than the pixel the pointer happened to cross.
  const startResize = (ev: ReactPointerEvent) => {
    const startX = ev.clientX;
    const startWidth = width;
    let shouldClose = false;
    const move = (moveEv: PointerEvent) => {
      const next = resizeAgentPane(startWidth + startX - moveEv.clientX, window.innerWidth);
      shouldClose = next.close;
      setClosing(next.close);
      onWidthChange(next.width);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setClosing(false);
      if (shouldClose) onClose();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (gate === "omp") {
    return (
      <AgentShell closing={closing} onClose={onClose} onResize={startResize}>
        <div className="orbitron-agent-body">
          <EmptyState title="OMP required" hint="The Orbitron agent needs the bundled OMP binary." />
        </div>
      </AgentShell>
    );
  }

  if (gate === "key") {
    return <XaiKeyDialog onClose={onClose} onSaved={() => setGate(null)} />;
  }

  return (
    <AgentShell closing={closing} onClose={onClose} onResize={startResize}>
      <div className="orbitron-agent-modes" role="group" aria-label="Canvas edit mode">
        {MODE_LABELS.map((entry) => (
          <button
            key={entry.mode}
            type="button"
            className={mode === entry.mode ? "btn small" : "btn ghost small"}
            onClick={() => {
              onModeChange(entry.mode);
              void ipc.setOrbitronAgentMode({ repoPath, mode: entry.mode });
            }}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {noticeMcp && <p className="orbitron-agent-notice">{MCP_OFF}</p>}
      <div
        className="orbitron-agent-body orbitron-agent-transcript"
        ref={scrollRef}
        onScroll={(e) => {
          wasAtBottom.current = atBottom(e.currentTarget);
        }}
      >
        {messages.length === 0 && !pendingCall && !error && (
          <EmptyState title="No messages yet." hint="Ask about the board. In Auto Edit or Request Approval the agent can change it too." />
        )}
        {messages.map((msg) => (
          <article key={msg.id} className={`orbitron-turn ${msg.role}`}>
            <div className="orbitron-turn-who">{msg.role === "user" ? "You" : "Agent"}</div>
            <div className="orbitron-turn-text">{msg.text}</div>
          </article>
        ))}
        {pendingCall && (
          <div className="orbitron-agent-card">
            {/* Waiting for approval is one of the two states blocked on a person, so it gets
                the chip treatment and the warning color from DESIGN.md §Session indicators. */}
            <div className="orbitron-agent-wait">
              <StateIcon state="waiting_for_approval" />
              Waiting for approval
            </div>
            <p className="orbitron-agent-ask">{summarizeHostTool(pendingCall)}</p>
            <div className="orbitron-agent-decide">
              <button type="button" className="btn small" onClick={onAccept}>
                Accept
              </button>
              <button type="button" className="btn ghost small" onClick={onReject}>
                Reject
              </button>
            </div>
          </div>
        )}
        {/* Activity is the last thing in the transcript rather than a permanent status row:
            an always-visible "Idle" is chrome that never says anything. */}
        {status !== "idle" && (
          <div className="orbitron-agent-activity" role="status">
            <RunningIndicator />
            <span>{statusLabel(status)}</span>
          </div>
        )}
        {error && <InlineStatus tone="error">{error}</InlineStatus>}
      </div>
      <div className="orbitron-agent-composer">
        <textarea
          className="field-input"
          aria-label="Message"
          value={draft}
          disabled={!canSend({ status, gate: gate === "loading" ? null : gate })}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={status === "compacting" ? "Compacting…" : "Ask about the board…"}
        />
        <button type="button" className="btn small" disabled={!canSend({ status, gate: gate === "loading" ? null : gate }) || !draft.trim()} onClick={send}>
          Send
        </button>
      </div>
    </AgentShell>
  );
}

/**
 * Pane chrome: the title bar, and the drag handle on the leading edge. Both gates and the
 * chat render through here, so the handle exists in every state the pane can be in — a pane
 * you cannot resize because it is showing a message would be a different pane.
 */
function AgentShell({ closing, onClose, onResize, children }: { closing: boolean; onClose: () => void; onResize: (ev: ReactPointerEvent) => void; children: ReactNode }) {
  return (
    <aside className={closing ? "orbitron-agent is-closing" : "orbitron-agent"} aria-label="Agent">
      <div className="orbitron-agent-grip" onPointerDown={onResize} />
      <div className="orbitron-panel-hd">
        <span className="orbitron-panel-title">
          <Bot size={14} strokeWidth={1.5} aria-hidden="true" /> Agent
        </span>
        <button type="button" className="x" aria-label="Close agent pane" onClick={onClose}>
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
      {children}
    </aside>
  );
}
