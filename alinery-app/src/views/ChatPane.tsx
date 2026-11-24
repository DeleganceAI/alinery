import { memo, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { chatMaxWidthCss } from "../appearance";
import { formatDuration } from "../chat/format";
import { type JournalItem, journalItems, nudgeInsertionIndex } from "../chat/journalRows";
import { PromptImageReaderContext, type PromptImageSource } from "../chat/PromptImages";
import { collectLiveSubagents } from "../chat/subagents";
import { ACTOR, type ChatEntry, type SessionChatStatus, type WrapUpPrompt } from "../chat/types";
import { type ChatPrefs, chatActivityLabel, DEFAULT_CHAT_VISIBILITY, isChatEntryVisible, visibleChatEntries, workRailDefaultExpanded } from "../chat/visibility";
import { IdleDot, RunningIndicator } from "../Indicators";
import type { SessionCompactionLive } from "../types";
import type { TurnRetryControl } from "../useTurnRetry";
import { ChatEntryRow } from "./ChatEntryRow";
import { ChatWorkStrip } from "./ChatWorkStrip";
import { SubagentDrawer } from "./SubagentDrawer";

function ChatPaneImpl({
  entries: transcript,
  status = "idle",
  stepActivity,
  onApprove,
  turnRetry,
  wrapUpPrompt,
  deliveryNotice,
  compactionState,
  readImage,
  visibility = DEFAULT_CHAT_VISIBILITY,
  onLoadOlder,
  loadingOlder = false,
  atStart = true,
}: {
  entries: ChatEntry[];
  status?: SessionChatStatus;
  stepActivity?: "Ready for review" | "Finishing step…";
  onApprove?: (id: string, allow: boolean) => void;
  turnRetry?: TurnRetryControl;
  wrapUpPrompt?: WrapUpPrompt;
  deliveryNotice?: ReactNode;
  /** Live compaction rows from the session observation. Not part of the transcript, so a frame cannot wipe them. */
  compactionState?: { compactions: SessionCompactionLive[]; failure: { reason: string; error: string } | null };
  /** Where this pane's attached images are read back from: its chat thread's directory, or its task session's. */
  readImage?: PromptImageSource;
  visibility?: ChatPrefs;
  /** Ask the owner for the page of journal rows before the ones currently loaded. */
  onLoadOlder?: () => void;
  loadingOlder?: boolean;
  /** The first prompt of the conversation is loaded — there is nothing older to fetch. */
  atStart?: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(visibility.autoScroll);
  const anchor = useRef<{ id: string; top: number } | null>(null);
  const failedEntryId = turnRetry?.failedEntryId;
  const reason = turnRetry?.reason;
  const entries = useMemo<ChatEntry[]>(() => {
    let rows = transcript;
    if (wrapUpPrompt && !transcript.some((entry) => entry.type === "prompt" && entry.nudgeDeliveryId === wrapUpPrompt.deliveryId)) {
      const { deliveryId, at, text, status } = wrapUpPrompt;
      rows = transcript.slice();
      rows.splice(nudgeInsertionIndex(transcript, wrapUpPrompt), 0, {
        type: "prompt",
        id: deliveryId,
        actor: ACTOR.you,
        at,
        text,
        nudgeDeliveryId: deliveryId,
        nudgeStatus: status,
      });
    }
    // The observation and transcript arrive on separate streams. Use the same row key on either arrival order.
    if (failedEntryId && reason && !transcript.some((entry) => entry.type === "error" && entry.failedEntryId === failedEntryId)) {
      rows = [...rows, { type: "error", id: `f:${failedEntryId}:error`, actor: ACTOR.agent, text: reason, failedEntryId }];
    }
    return rows;
  }, [transcript, wrapUpPrompt, failedEntryId, reason]);
  const shown = useMemo(() => visibleChatEntries(entries, visibility), [entries, visibility]);
  const activity = chatActivityLabel(status, shown) ?? stepActivity;
  const items = useMemo(() => journalItems(entries, status !== "idle", (entry) => isChatEntryVisible(entry, visibility)), [entries, status, visibility]);
  const stepOpen = useCallback((entry: ChatEntry) => workRailDefaultExpanded(entry, visibility), [visibility]);

  useEffect(() => {
    stick.current = visibility.autoScroll;
  }, [visibility.autoScroll]);

  const scrollToEnd = useCallback(() => {
    const el = scroller.current;
    if (!el || !stick.current || !visibility.autoScroll) return;
    el.scrollTop = el.scrollHeight;
  }, [visibility.autoScroll]);

  // Length, reasons, attempts, retry times, and the failure error. A tail that appears below the
  // already-scrolled transcript must follow the reader only while they are stuck to the bottom.
  const compactionTail = compactionState
    ? `${compactionState.compactions.length}:${compactionState.compactions.map((item) => `${item.reason}:${item.attempt}:${item.retryAt ?? ""}`).join(",")}:${compactionState.failure?.error ?? ""}`
    : "";

  useEffect(() => {
    scrollToEnd();
  }, [shown, activity, deliveryNotice, compactionTail, scrollToEnd]);

  const requestOlder = useCallback(() => {
    const el = scroller.current;
    if (!el || atStart || loadingOlder || !onLoadOlder) return;
    // Anchor on a row, not on scrollHeight. The fetch takes a round trip the reader can keep
    // scrolling through, and row heights are only known once rendered, so restoring by a real
    // node's own displacement is the only measure that stays true.
    const first = el.querySelector<HTMLElement>("[data-entry-id]");
    anchor.current = first?.dataset.entryId ? { id: first.dataset.entryId, top: first.offsetTop } : null;
    onLoadOlder();
  }, [atStart, loadingOlder, onLoadOlder]);

  useLayoutEffect(() => {
    const el = scroller.current;
    const saved = anchor.current;
    // Not while the older page is still on its way: a render in between (a reattach rebuilding the
    // rows) would spend the anchor before the rows it measures against have moved.
    if (!el || !saved || loadingOlder) return;
    anchor.current = null;
    const node = el.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(saved.id)}"]`);
    if (!node) return;
    el.scrollTop += node.offsetTop - saved.top;
  }, [shown, loadingOlder]);

  useEffect(() => {
    const el = scroller.current;
    // A first page shorter than the viewport produces no scroll event at all, so onScroll alone
    // can never reach the top of the journal. Keep pulling until it is scrollable or at the start.
    if (el && el.scrollHeight <= el.clientHeight) requestOlder();
  }, [shown, requestOlder]);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    // Ahead of the autoScroll early return: a reader who turned auto-scroll off is exactly the
    // reader most likely to be scrolling back through history.
    if (el.scrollTop < 200) requestOlder();
    if (!visibility.autoScroll) {
      stick.current = false;
      return;
    }
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
  }

  const liveSubs = useMemo(() => collectLiveSubagents(entries), [entries]);

  return (
    <PromptImageReaderContext.Provider value={readImage ?? null}>
      <div
        className="chat-pane"
        data-testid="chat-pane"
        data-density={visibility.railDensity}
        data-actor-labels={visibility.showActorLabels ? "on" : "off"}
        data-agent-bubbles={visibility.showAgentBubbles ? "on" : "off"}
        style={{
          ["--chat-font-size" as string]: `${visibility.fontSize}px`,
          ["--chat-rail-font-size" as string]: `${visibility.railFontSize}px`,
          ["--chat-max-width" as string]: chatMaxWidthCss(visibility.maxWidth),
        }}
      >
        {visibility.showSubagentDrawer ? <SubagentDrawer agents={liveSubs} /> : null}
        <div ref={scroller} onScroll={onScroll} className="chat-list">
          {shown.length === 0 ? <div className="chat-empty">No messages yet</div> : null}
          <ol className="chat-journal">
            {loadingOlder ? <li className="chat-older">Loading earlier messages…</li> : atStart && shown.length > 0 ? <li className="chat-older">Start of conversation</li> : null}
            {items.map((item) => (
              <li key={item.key} className="chat-journal-item" data-node={nodeOf(item)} data-entry-id={item.kind === "turn" ? undefined : item.key}>
                {item.kind === "work" ? (
                  <ChatWorkStrip
                    entries={item.entries}
                    live={item.live}
                    defaultOpen={item.entries.some(stepOpen)}
                    collapseWhenDone={visibility.autoCollapseThinking && !visibility.expandThinking}
                    stepOpen={stepOpen}
                  />
                ) : item.kind === "turn" ? (
                  <div className="chat-turn-end">
                    <span className="chat-turn-rule" />
                    <span className="chat-turn-copy">
                      {[`${item.steps} ${item.steps === 1 ? "step" : "steps"}`, item.durationMs != null ? formatDuration(item.durationMs) : ""].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                ) : (
                  <ChatEntryRow
                    entry={item.entry}
                    turnRetry={item.entry.type === "error" && item.entry.failedEntryId === failedEntryId ? turnRetry : undefined}
                    onApprove={onApprove}
                    narration={item.role === "narration"}
                    showDate={visibility.showDate}
                    showTime={visibility.showTime}
                    showActorLabels={visibility.showActorLabels}
                    showBlockCopyButtons={visibility.showBlockCopyButtons}
                    showCopyButton={visibility.showCopyButtons}
                  />
                )}
              </li>
            ))}
            {deliveryNotice ? (
              <li className="chat-journal-item" data-node="error">
                {deliveryNotice}
              </li>
            ) : null}
            {compactionState?.compactions.map((item, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the wire has no task id and the row has no local state
              <li key={`compaction-${index}`} className="chat-journal-item" data-node="meta">
                <p className="chat-work-meta">
                  {`Compacting context · ${item.reason} · attempt ${item.attempt}`}
                  {item.retryAt !== undefined ? ` · retrying at ${new Date(item.retryAt).toISOString()}` : ""}
                  {item.retryError ? ` · ${item.retryError}` : ""}
                </p>
              </li>
            ))}
            {compactionState?.failure ? (
              <li key="compaction-failure" className="chat-journal-item" data-node="meta">
                <p className="chat-work-meta">{`Compaction failed: ${compactionState.failure.error}. The conversation is unchanged.`}</p>
              </li>
            ) : null}
          </ol>
        </div>
        {activity ? (
          <div className="chat-activity" role="status" data-testid="chat-activity" aria-live="polite">
            {status === "running" ? <RunningIndicator /> : <IdleDot />}
            <span>{activity}</span>
          </div>
        ) : null}
      </div>
    </PromptImageReaderContext.Provider>
  );
}

/** The marker the row puts on the journal's spine (see `.chat-journal-item` in theme.css). */
function nodeOf(item: JournalItem): string {
  if (item.kind === "work") return item.live ? "live" : "work";
  if (item.kind === "turn") return "turn";
  return item.role;
}

export const ChatPane = memo(ChatPaneImpl);
