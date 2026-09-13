import { Bot, Brain, Cable, CircleAlert, CircleStop, FileOutput, type LucideIcon, MessageSquare, Navigation, Reply, ShieldAlert, Terminal, Wrench } from "lucide-react";
import { memo, type ReactNode, useEffect, useState } from "react";
import { type ChatStampParts, formatChatStamp, formatDuration, formatIso } from "../chat/format";
import { type Actor, type ChatEntry, type ChatEntryType, TYPE_LABEL, whoLabel, whoLane } from "../chat/types";

const KIND_ICON: Record<ChatEntryType, LucideIcon> = {
  prompt: MessageSquare,
  follow_up: Navigation,
  slash: Terminal,
  thinking: Brain,
  redacted_thinking: Brain,
  text: Reply,
  tool_call: Wrench,
  tool_result: FileOutput,
  subagent_status: Bot,
  approval: ShieldAlert,
  turn_marker: Cable,
  error: CircleAlert,
  abort: CircleStop,
  harness: Cable,
};

function kindFace(type: ChatEntryType): string {
  if (type === "prompt" || type === "follow_up") return "chat-face-strong";
  if (type === "slash" || type === "harness") return "chat-face-meta";
  if (type === "error" || type === "abort") return "chat-face-danger";
  return "";
}

function Status({ children, tone }: { children: ReactNode; tone?: "ok" | "bad" | "wait" }) {
  return <span className={`chat-status${tone ? ` chat-status-${tone}` : ""}`}>{children}</span>;
}

function isWork(entry: ChatEntry) {
  if (entry.type === "thinking" || entry.type === "redacted_thinking" || entry.type === "tool_call" || entry.type === "tool_result" || entry.type === "subagent_status") {
    return true;
  }
  return entry.actor.kind === "subagent";
}

function workIcon(entry: ChatEntry): LucideIcon {
  if (entry.type === "tool_call") return Wrench;
  if (entry.type === "tool_result") return FileOutput;
  if (entry.type === "thinking" || entry.type === "redacted_thinking") return Brain;
  if (entry.type === "subagent_status" || entry.actor.kind === "subagent") return Bot;
  return KIND_ICON[entry.type];
}

function workLabel(entry: ChatEntry): string {
  if (entry.type === "thinking") {
    const who = entry.actor.kind === "subagent" ? entry.actor.name : "Agent";
    if (entry.streaming) return `${who} thinking`;
    if (entry.aborted) return `${who} thought · aborted`;
    if (entry.durationMs != null) return `${who} thought · ${formatDuration(entry.durationMs)}`;
    return `${who} thought`;
  }
  if (entry.type === "redacted_thinking") {
    const who = entry.actor.kind === "subagent" ? entry.actor.name : "Agent";
    return `${who} thought · redacted`;
  }
  if (entry.type === "tool_call") {
    const who = entry.actor.kind === "subagent" ? entry.actor.name : "Agent";
    const err = entry.status === "error" || entry.status === "denied" ? ` · ${entry.status}` : "";
    return `${who} used ${entry.tool}${err}`;
  }
  if (entry.type === "tool_result") {
    const who = entry.actor.kind === "subagent" ? entry.actor.name : "Agent";
    return `${who} got ${entry.tool}`;
  }
  if (entry.type === "subagent_status") {
    const dur = entry.durationMs != null ? ` · ${formatDuration(entry.durationMs)}` : "";
    return `${entry.agent} ${entry.status}${dur}`;
  }
  if (entry.actor.kind === "subagent" && entry.type === "harness") {
    return `${entry.actor.name} · ${entry.event}`;
  }
  if (entry.actor.kind === "subagent" && entry.type === "text") {
    return `${entry.actor.name} said`;
  }
  return TYPE_LABEL[entry.type];
}

function workBody(entry: ChatEntry): ReactNode {
  switch (entry.type) {
    case "thinking":
      return (
        <pre className="chat-work-pre italic">
          {entry.text}
          {entry.streaming ? <span className="chat-caret" aria-hidden /> : null}
        </pre>
      );
    case "tool_call":
      return (
        <div className="chat-work-meta">
          {entry.target ? <div>{entry.target}</div> : null}
          {entry.args ? <div>args {entry.args}</div> : null}
          {entry.detail ? <div className="chat-work-detail">{entry.detail}</div> : null}
          <div className="chat-work-detail">
            {entry.status}
            {entry.durationMs != null ? ` · ${formatDuration(entry.durationMs)}` : ""}
          </div>
        </div>
      );
    case "tool_result":
      return <pre className="chat-work-pre chat-work-meta">{entry.text}</pre>;
    case "subagent_status":
      return (
        <div>
          {entry.role ? <p className="chat-work-meta">{entry.role}</p> : null}
          <p>{entry.summary}</p>
          <p className="chat-work-meta">
            {entry.tools != null ? `${entry.tools} tools` : ""}
            {entry.tools != null && entry.durationMs != null ? " · " : ""}
            {entry.durationMs != null ? formatDuration(entry.durationMs) : ""}
          </p>
        </div>
      );
    case "harness":
      return <pre className="chat-work-pre chat-work-meta">{entry.text}</pre>;
    case "text":
      return <p className="chat-text-body">{entry.text}</p>;
    default:
      return null;
  }
}

function hasWorkBody(entry: ChatEntry) {
  if (entry.type === "redacted_thinking") return false;
  return workBody(entry) != null;
}

function stampFor(at: number | undefined, parts: ChatStampParts): string {
  if (at == null) return "";
  return formatChatStamp(at, parts);
}

function WorkRail({
  entry,
  defaultExpanded = false,
  autoCollapseThinking = false,
  stamp,
}: {
  entry: ChatEntry;
  defaultExpanded?: boolean;
  autoCollapseThinking?: boolean;
  stamp: ChatStampParts;
}) {
  const live = (entry.type === "thinking" && Boolean(entry.streaming) && !entry.aborted) || (entry.type === "tool_call" && entry.status === "running");
  const [open, setOpen] = useState(live || defaultExpanded);
  useEffect(() => {
    if (live) {
      setOpen(true);
      return;
    }
    if (autoCollapseThinking && entry.type === "thinking" && !defaultExpanded) {
      setOpen(false);
    }
  }, [live, autoCollapseThinking, entry.type, defaultExpanded]);
  const Icon = workIcon(entry);
  const expandable = hasWorkBody(entry);
  const when = stampFor(entry.at, stamp);

  return (
    <div className="chat-rail">
      <button
        type="button"
        className="chat-rail-line"
        onClick={() => expandable && setOpen((v) => !v)}
        aria-expanded={expandable ? open : undefined}
        aria-label={`${when} ${workLabel(entry)}`.trim()}
      >
        <Icon className="chat-rail-icon" strokeWidth={1.5} aria-hidden />
        <span className="chat-rail-copy">{workLabel(entry)}</span>
        {when && entry.at != null ? (
          <time className="chat-rail-time" dateTime={formatIso(entry.at)}>
            {when}
          </time>
        ) : null}
        {expandable ? <span className="chat-rail-action">{open ? "hide" : "details"}</span> : null}
      </button>
      {expandable ? (
        <div className={`chat-rail-fold${open ? " open" : ""}`}>
          <div className="chat-rail-fold-inner">
            {/* Built only while open. The wrappers stay so the grid-template-rows transition still
                animates, but a collapsed rail contributes no body to the DOM — and tool output is
                the bulk of a real journal. */}
            <div className="chat-rail-panel">{open ? workBody(entry) : null}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Msg({
  at,
  actor,
  type,
  kicker,
  stamp,
  showActorLabels = false,
  reply = false,
  children,
}: {
  at?: number;
  actor: Actor;
  type: ChatEntryType;
  kicker?: ReactNode;
  stamp: ChatStampParts;
  showActorLabels?: boolean;
  /** Marks agent text replies so bubble CSS can target them without touching other Msg skins. */
  reply?: boolean;
  children?: ReactNode;
}) {
  const lane = whoLane(actor);
  const mine = lane === "you";
  const Icon = KIND_ICON[type];
  const who = whoLabel(actor);
  const when = stampFor(at, stamp);
  const showMeta = Boolean(when) || showActorLabels;
  return (
    <article className={`chat-msg chat-msg-${lane}${mine ? " chat-msg-mine" : ""}${reply ? " chat-msg-reply" : ""}`} aria-label={`${when} ${who} ${TYPE_LABEL[type]}`.trim()}>
      {showMeta ? (
        <div className="chat-msg-meta">
          {when && at != null ? (
            <time className="chat-msg-time" dateTime={formatIso(at)} title={new Date(at).toLocaleString()}>
              {when}
            </time>
          ) : null}
          {showActorLabels ? (
            <>
              <Icon className="chat-msg-kind-icon" strokeWidth={1.5} aria-hidden />
              <span className="chat-msg-who">{who}</span>
            </>
          ) : null}
        </div>
      ) : null}
      <div className={`chat-msg-body ${kindFace(type)}`.trim()}>
        {kicker ? <div className="chat-msg-kicker">{kicker}</div> : null}
        {children}
      </div>
    </article>
  );
}

function UserRowBody({ entry }: { entry: Extract<ChatEntry, { type: "prompt" | "follow_up" }> }) {
  const images = entry.attachments?.filter((item) => item.kind === "image") ?? [];
  const files = entry.attachments?.filter((item) => item.kind === "file") ?? [];
  return (
    <>
      {entry.text ? <p className="chat-text-body">{entry.text}</p> : null}
      {images.length > 0 ? (
        <div className="chat-entry-thumbs">
          {images.map((item) => (item.src ? <img key={`${item.name}:${item.src}`} alt={item.name} src={item.src} /> : <span key={item.name}>{item.name}</span>))}
        </div>
      ) : null}
      {files.length > 0 ? (
        <div className="chat-entry-chips">
          {files.map((item) => (
            <span key={item.name}>{item.name}</span>
          ))}
        </div>
      ) : null}
    </>
  );
}

function ChatEntryRowImpl({
  entry,
  onApprove,
  defaultExpanded,
  autoCollapseThinking,
  showDate = true,
  showTime = true,
  showActorLabels = false,
}: {
  entry: ChatEntry;
  onApprove?: (id: string, allow: boolean) => void;
  defaultExpanded?: boolean;
  autoCollapseThinking?: boolean;
  showDate?: boolean;
  showTime?: boolean;
  showActorLabels?: boolean;
}) {
  const stamp: ChatStampParts = { date: showDate, time: showTime };
  if (isWork(entry)) return <WorkRail entry={entry} defaultExpanded={defaultExpanded} autoCollapseThinking={autoCollapseThinking} stamp={stamp} />;

  switch (entry.type) {
    case "turn_marker": {
      const when = stampFor(entry.at, stamp);
      return (
        <div className="chat-turn">
          <div className="chat-turn-rule" />
          <div className="chat-turn-copy">
            {when && entry.at != null ? <time dateTime={formatIso(entry.at)}>{when}</time> : null}
            <span>
              Turn {entry.turn} {entry.phase}
              {entry.stopReason ? ` · ${entry.stopReason}` : ""}
            </span>
          </div>
          <div className="chat-turn-rule" />
        </div>
      );
    }
    case "approval":
      return (
        <Msg at={entry.at} actor={entry.actor} type="approval" stamp={stamp} showActorLabels={showActorLabels} kicker={<Status tone="wait">waiting</Status>}>
          <p className="chat-msg-title">{entry.action}</p>
          {entry.detail ? <p className="chat-msg-muted">{entry.detail}</p> : null}
          {entry.scope ? <p className="chat-work-meta">{entry.scope}</p> : null}
          <div className="chat-msg-actions">
            <button type="button" className="btn primary small" onClick={() => onApprove?.(entry.requestId, true)}>
              Allow
            </button>
            <button type="button" className="btn ghost small" onClick={() => onApprove?.(entry.requestId, false)}>
              Deny
            </button>
          </div>
        </Msg>
      );
    case "slash":
      return (
        <Msg
          at={entry.at}
          actor={entry.actor}
          type="slash"
          stamp={stamp}
          showActorLabels={showActorLabels}
          kicker={
            <>
              <span className="chat-work-meta chat-face-strong">/{entry.name}</span>
              {entry.local != null ? <Status>{entry.local ? "local" : "turn"}</Status> : null}
            </>
          }
        >
          {entry.args ? <p className="chat-work-meta">{entry.args}</p> : null}
        </Msg>
      );
    case "error":
    case "abort":
      return (
        <Msg at={entry.at} actor={entry.actor} type={entry.type} stamp={stamp} showActorLabels={showActorLabels}>
          <p>{entry.text}</p>
        </Msg>
      );
    case "prompt":
      return (
        <Msg at={entry.at} actor={entry.actor} type={entry.type} stamp={stamp} showActorLabels={showActorLabels}>
          <UserRowBody entry={entry} />
        </Msg>
      );
    case "follow_up":
      return (
        <Msg at={entry.at} actor={entry.actor} type="follow_up" stamp={stamp} showActorLabels={showActorLabels} kicker={<Status tone="wait">queued · after this turn</Status>}>
          <UserRowBody entry={entry} />
        </Msg>
      );

    case "text":
      return (
        <Msg
          at={entry.at}
          actor={entry.actor}
          type="text"
          stamp={stamp}
          showActorLabels={showActorLabels}
          reply
          kicker={entry.streaming ? <Status tone="wait">live</Status> : undefined}
        >
          <p className="chat-text-body">
            {entry.text}
            {entry.streaming ? <span className="chat-caret" aria-hidden /> : null}
          </p>
        </Msg>
      );
    case "harness":
      return (
        <Msg
          at={entry.at}
          actor={entry.actor}
          type="harness"
          stamp={stamp}
          showActorLabels={showActorLabels}
          kicker={<span className="chat-work-meta chat-face-strong">{entry.event}</span>}
        >
          {entry.text ? <pre className="chat-work-pre chat-work-meta">{entry.text}</pre> : null}
        </Msg>
      );
    default:
      return null;
  }
}

// Memoized so a live turn re-renders only the rows it touches. Every prop is a primitive or a
// stable callback from SessionView, so the default shallow compare is enough.
export const ChatEntryRow = memo(ChatEntryRowImpl);
