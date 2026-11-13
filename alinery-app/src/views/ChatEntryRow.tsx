import { memo, type ReactNode, useState } from "react";
import { ChatMarkdown, CopyChatMessageButton } from "../chat/CopyMessage";
import { type ChatStampParts, formatChatStamp, formatIso } from "../chat/format";
import { type Actor, type ChatEntry, type ChatEntryType, TYPE_LABEL, whoLabel, whoLane } from "../chat/types";

function kindFace(type: ChatEntryType): string {
  if (type === "prompt" || type === "follow_up") return "chat-face-strong";
  if (type === "slash" || type === "harness") return "chat-face-meta";
  if (type === "error" || type === "abort") return "chat-face-danger";
  return "";
}

function Status({ children, tone }: { children: ReactNode; tone?: "ok" | "bad" | "wait" }) {
  return <span className={`chat-status${tone ? ` chat-status-${tone}` : ""}`}>{children}</span>;
}

function stampFor(at: number | undefined, parts: ChatStampParts): string {
  if (at == null) return "";
  return formatChatStamp(at, parts);
}

function copyTextForEntry(entry: ChatEntry): string {
  switch (entry.type) {
    case "prompt":
    case "follow_up": {
      const attachments = entry.attachments?.map((item) => `Attached ${item.kind}: ${item.name}`) ?? [];
      return [entry.text, ...attachments].filter(Boolean).join("\n");
    }
    case "slash":
      return `/${entry.name}${entry.args ? ` ${entry.args}` : ""}`;
    case "thinking":
    case "text":
    case "tool_result":
    case "error":
    case "abort":
      return entry.text;
    case "tool_call":
      return [entry.target, entry.args, entry.detail].filter(Boolean).join("\n");
    case "subagent_status":
      return [entry.role, entry.summary].filter(Boolean).join("\n");
    case "approval":
      return [entry.action, entry.detail, entry.scope].filter(Boolean).join("\n");
    case "turn_marker":
      return `Turn ${entry.turn} ${entry.phase}${entry.stopReason ? ` · ${entry.stopReason}` : ""}`;
    case "harness":
      return [entry.event, entry.text].filter(Boolean).join("\n");
    case "redacted_thinking":
      return "";
  }
}

function Msg({
  at,
  actor,
  type,
  kicker,
  stamp,
  showActorLabels = false,
  reply = false,
  narration = false,
  copyText,
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
  /** Agent text the agent kept working past: read as a quiet aside, with no label. */
  narration?: boolean;
  /** Raw message text; when set, a copy button is shown inside the bubble. */
  copyText?: string;
  children?: ReactNode;
}) {
  const lane = whoLane(actor);
  const mine = lane === "you";
  const who = whoLabel(actor);
  const when = stampFor(at, stamp);
  const showMeta = !narration && (Boolean(when) || showActorLabels);
  return (
    <article
      className={`chat-msg chat-msg-${lane}${mine ? " chat-msg-mine" : ""}${reply ? " chat-msg-reply" : ""}${narration ? " chat-msg-narration" : ""}`}
      aria-label={`${when} ${who} ${TYPE_LABEL[type]}`.trim()}
    >
      {showMeta ? (
        <div className="chat-msg-meta">
          {showActorLabels ? <span className="chat-msg-who">{who}</span> : null}
          {when && at != null ? (
            <time className="chat-msg-time" dateTime={formatIso(at)} title={new Date(at).toLocaleString()}>
              {when}
            </time>
          ) : null}
        </div>
      ) : null}
      <div className={`chat-msg-body ${kindFace(type)}`.trim()}>
        {kicker ? <div className="chat-msg-kicker">{kicker}</div> : null}
        {children}
        {copyText ? (
          <div className="chat-msg-copy-row">
            <CopyChatMessageButton text={copyText} />
          </div>
        ) : null}
      </div>
    </article>
  );
}

/** A prompt longer than this folds to its first lines (a pasted brief would otherwise push the conversation off screen). */
const FOLD_LINES = 6;
const FOLD_CHARS = 600;

function UserRowBody({ entry }: { entry: Extract<ChatEntry, { type: "prompt" | "follow_up" }> }) {
  const images = entry.attachments?.filter((item) => item.kind === "image") ?? [];
  const files = entry.attachments?.filter((item) => item.kind === "file") ?? [];
  const lines = entry.text.split("\n").length;
  const long = lines > FOLD_LINES || entry.text.length > FOLD_CHARS;
  const [folded, setFolded] = useState(true);
  return (
    <>
      {entry.text ? <p className={`chat-text-body${long && folded ? " folded" : ""}`}>{entry.text}</p> : null}
      {long ? (
        <button type="button" className="chat-fold-toggle" aria-expanded={!folded} onClick={() => setFolded((v) => !v)}>
          {folded ? `Show all · ${lines} ${lines === 1 ? "line" : "lines"}` : "Show less"}
        </button>
      ) : null}
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
  narration = false,
  showDate = true,
  showTime = true,
  showActorLabels = false,
  showBlockCopyButtons = true,
  showCopyButton = true,
}: {
  entry: ChatEntry;
  onApprove?: (id: string, allow: boolean) => void;
  /** Agent text followed by more work in its turn (see `journalItems`). */
  narration?: boolean;
  showDate?: boolean;
  showTime?: boolean;
  showActorLabels?: boolean;
  showBlockCopyButtons?: boolean;
  showCopyButton?: boolean;
}) {
  const stamp: ChatStampParts = { date: showDate, time: showTime };
  const copyText = showCopyButton ? copyTextForEntry(entry) : "";

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
        <Msg at={entry.at} actor={entry.actor} type="approval" stamp={stamp} showActorLabels={showActorLabels} copyText={copyText} kicker={<Status tone="wait">waiting</Status>}>
          <p className="chat-msg-title">{entry.action}</p>
          {entry.detail ? (
            entry.detailFormat === "plain" ? (
              <p className="chat-msg-muted">{entry.detail}</p>
            ) : (
              <div className="chat-msg-muted">
                <ChatMarkdown text={entry.detail} showBlockCopyButtons={showBlockCopyButtons} preserveLineBreaks />
              </div>
            )
          ) : null}
          {entry.scope ? <p className="chat-work-meta">{entry.scope}</p> : null}
          <div className="chat-msg-actions">
            <button type="button" className="btn primary small" disabled={entry.disabled} onClick={() => onApprove?.(entry.requestId, true)}>
              {entry.allowLabel ?? "Allow"}
            </button>
            <button type="button" className="btn ghost small" disabled={entry.disabled || entry.denyDisabled} onClick={() => onApprove?.(entry.requestId, false)}>
              {entry.denyLabel ?? "Deny"}
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
          copyText={copyText}
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
        <Msg at={entry.at} actor={entry.actor} type={entry.type} stamp={stamp} showActorLabels={showActorLabels} copyText={copyText}>
          <p>{entry.text}</p>
        </Msg>
      );
    case "prompt":
      // A refused send is the only copy of the text once the composer has moved on, so Copy stays even when the setting hides it.
      return (
        <Msg
          at={entry.at}
          actor={entry.actor}
          type={entry.type}
          stamp={stamp}
          showActorLabels={showActorLabels}
          copyText={entry.failed ? copyTextForEntry(entry) : copyText}
          kicker={entry.failed ? <Status tone="bad">not sent</Status> : undefined}
        >
          <UserRowBody entry={entry} />
        </Msg>
      );
    case "follow_up":
      return (
        <Msg
          at={entry.at}
          actor={entry.actor}
          type="follow_up"
          stamp={stamp}
          showActorLabels={showActorLabels}
          copyText={copyText}
          kicker={<Status tone="wait">queued · after this turn</Status>}
        >
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
          copyText={showCopyButton && !entry.streaming ? entry.text : undefined}
          reply
          narration={narration}
          kicker={entry.streaming ? <Status tone="wait">live</Status> : undefined}
        >
          {entry.streaming ? (
            <p className="chat-text-body">
              {entry.text}
              <span className="chat-caret" aria-hidden />
            </p>
          ) : (
            <ChatMarkdown text={entry.text} showBlockCopyButtons={showBlockCopyButtons} />
          )}
        </Msg>
      );
    case "harness":
      return (
        <Msg
          at={entry.at}
          actor={entry.actor}
          type="harness"
          stamp={stamp}
          copyText={copyText}
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
