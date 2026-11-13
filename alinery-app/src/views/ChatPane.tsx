import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { chatMaxWidthCss } from "../appearance";
import { formatDuration } from "../chat/format";
import { type JournalItem, journalItems } from "../chat/journalRows";
import { collectLiveSubagents } from "../chat/subagents";
import type { ChatEntry, SessionChatStatus } from "../chat/types";
import { type ChatPrefs, chatActivityLabel, DEFAULT_CHAT_VISIBILITY, visibleChatEntries, workRailDefaultExpanded } from "../chat/visibility";
import { RunningIndicator } from "../Indicators";
import { ChatEntryRow } from "./ChatEntryRow";
import { ChatWorkStrip } from "./ChatWorkStrip";
import { SubagentDrawer } from "./SubagentDrawer";

function ChatPaneImpl({
  entries,
  status = "idle",
  onApprove,
  visibility = DEFAULT_CHAT_VISIBILITY,
  onLoadOlder,
  loadingOlder = false,
  atStart = true,
}: {
  entries: ChatEntry[];
  status?: SessionChatStatus;
  onApprove?: (id: string, allow: boolean) => void;
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
  const shown = useMemo(() => visibleChatEntries(entries, visibility), [entries, visibility]);
  const activity = chatActivityLabel(status, shown);
  const items = useMemo(() => journalItems(shown, status !== "idle"), [shown, status]);
  const stepOpen = useCallback((entry: ChatEntry) => workRailDefaultExpanded(entry, visibility), [visibility]);

  useEffect(() => {
    stick.current = visibility.autoScroll;
  }, [visibility.autoScroll]);

  const scrollToEnd = useCallback(() => {
    const el = scroller.current;
    if (!el || !stick.current || !visibility.autoScroll) return;
    el.scrollTop = el.scrollHeight;
  }, [visibility.autoScroll]);

  useEffect(() => {
    scrollToEnd();
  }, [shown, activity, scrollToEnd]);

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
        </ol>
      </div>
      {activity ? (
        <div className="chat-activity" role="status" data-testid="chat-activity" aria-live="polite">
          <RunningIndicator running={status === "running"} />
          <span>{activity}</span>
        </div>
      ) : null}
    </div>
  );
}

/** The marker the row puts on the journal's spine (see `.chat-journal-item` in theme.css). */
function nodeOf(item: JournalItem): string {
  if (item.kind === "work") return item.live ? "live" : "work";
  if (item.kind === "turn") return "turn";
  return item.role;
}

export const ChatPane = memo(ChatPaneImpl);
