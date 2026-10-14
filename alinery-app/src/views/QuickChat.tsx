import { ArrowDownRight, MessageSquare, X } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, type UIEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ChatComposer } from "../ChatComposer";
import type { ChatPrefs } from "../chat/visibility";
import * as ipc from "../ipc";
import type { ChatThread } from "../types";
import { usePointerDrag } from "../usePointerDrag";
import { ChatExtensionPrompt } from "./ChatExtensionPrompt";
import { ChatPane } from "./ChatPane";
import { repoLabel } from "./ChatView";
import { threadKey, threadLabel, useChatRegistry, useChatThread } from "./chatThreadSession";

/**
 * 350 by 600. Drag the title bar to move it; the place and the selected tab are remembered
 * across launches. Reopening lands at the bottom of that tab. Resize is still a follow-up.
 */
export const QUICK_CHAT_WIDTH = 350;
export const QUICK_CHAT_HEIGHT = 600;
export const QUICK_CHAT_MARGIN = 16;

const POSITION_KEY = "alinery.quickChat.position";
const TAB_KEY = "alinery.quickChat.tab";

type Point = { x: number; y: number };
type Viewport = { width: number; height: number };

function viewport(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

function clampPosition(point: Point, size: Viewport): Point {
  const maxX = Math.max(0, size.width - QUICK_CHAT_WIDTH);
  const maxY = Math.max(0, size.height - QUICK_CHAT_HEIGHT);
  return {
    x: Math.min(Math.max(0, point.x), maxX),
    y: Math.min(Math.max(0, point.y), maxY),
  };
}

/** Bottom-right, inset by the margin. A viewport smaller than the window pins to the origin. */
function defaultPosition(size: Viewport): Point {
  return clampPosition({ x: size.width - QUICK_CHAT_WIDTH - QUICK_CHAT_MARGIN, y: size.height - QUICK_CHAT_HEIGHT - QUICK_CHAT_MARGIN }, size);
}

function readStoredPosition(): Point | null {
  try {
    const raw = localStorage.getItem(POSITION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
    if (typeof parsed.x !== "number" || typeof parsed.y !== "number" || !Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return null;
    return { x: parsed.x, y: parsed.y };
  } catch {
    return null;
  }
}

function writeStoredPosition(point: Point) {
  try {
    localStorage.setItem(POSITION_KEY, JSON.stringify(point));
  } catch {
    // A storage failure must not stop the window from moving.
  }
}

function clearStoredPosition() {
  try {
    localStorage.removeItem(POSITION_KEY);
  } catch {
    // The in-memory spot still returns to the corner.
  }
}

function readStoredTab(): string | null {
  try {
    return localStorage.getItem(TAB_KEY) || null;
  } catch {
    return null;
  }
}

function writeStoredTab(key: string) {
  try {
    localStorage.setItem(TAB_KEY, key);
  } catch {
    // The tab still changes for this launch.
  }
}

export function QuickChat({ open, visibility, onOpenInChat, onHide }: { open: boolean; visibility: ChatPrefs; onOpenInChat: () => void; onHide: () => void }) {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [tab, setTab] = useState<string | null>(readStoredTab);
  // null keeps the default corner, including when the viewport resizes. A drag stores a fixed point.
  const [point, setPoint] = useState<Point | null>(readStoredPosition);
  const [frame, setFrame] = useState(viewport);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const pinToEnd = useRef(true);
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const { start: startDrag } = usePointerDrag();
  const pinned = threads.filter((thread) => thread.session.pinned && !thread.session.archived);
  const resolved = pinned.find((thread) => threadKey(thread) === tab) ?? pinned[0] ?? null;
  const resolvedKey = resolved ? threadKey(resolved) : null;
  const registry = useChatRegistry();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const poll = () => {
      ipc
        .listChatThreads(false)
        .then((rows) => {
          if (!cancelled) setThreads(rows);
        })
        .catch(() => {});
    };
    poll();
    const timer = window.setInterval(poll, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open]);

  const commit = () =>
    ipc.listChatThreads(false).then((rows) => {
      flushSync(() => setThreads(rows));
    });

  const chat = useChatThread(open ? resolved : null, {
    active: open,
    autoCompaction: visibility.autoCompaction,
    isFocused: (key) => resolvedKey === key,
    onReload: commit,
    onResumeRefresh: commit,
    onRebind: (key) => {
      flushSync(() => setTab(key));
      writeStoredTab(key);
    },
  });

  const placed = clampPosition(point ?? defaultPosition(frame), frame);
  // The journal usually arrives a frame after the pane. Stay armed until there is something to land on,
  // then stop so a later message follows the auto-scroll setting instead of this reopen.
  useLayoutEffect(() => {
    if (!open) {
      pinToEnd.current = true;
      return;
    }
    // The list mounts with the selected tab, which can happen before the journal replaces the empty entries.
    if (!pinToEnd.current || resolvedKey === null) return;
    const list = rootRef.current?.querySelector<HTMLElement>(".chat-list");
    if (!list) return;
    list.scrollTop = list.scrollHeight;
    if (!pinToEnd.current) return;
    if (list.scrollHeight > list.clientHeight || chat.transcript.entries.length > 0) pinToEnd.current = false;
  }, [open, resolvedKey, chat.transcript.entries]);

  useEffect(() => {
    const onResize = () => setFrame(viewport());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const previous = document.body.style.cursor;
    document.body.style.cursor = "grabbing";
    return () => {
      document.body.style.cursor = previous;
    };
  }, [dragging]);

  if (!open) return null;

  const repos = pinned.map((thread) => thread.repo_path);
  const paneVisibility = { ...visibility, maxWidth: "none" as const };

  const selectTab = (key: string) => {
    setTab(key);
    writeStoredTab(key);
  };

  const resetPlace = () => {
    setPoint(null);
    clearStoredPosition();
  };

  const onBarPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("button")) return;
    event.preventDefault();
    const origin = placed;
    const startX = event.clientX;
    const startY = event.clientY;
    const moved = (ev: PointerEvent) => clampPosition({ x: origin.x + ev.clientX - startX, y: origin.y + ev.clientY - startY }, frameRef.current);
    setDragging(true);
    startDrag(event, {
      onMove: (ev) => setPoint(moved(ev)),
      onComplete: (ev) => {
        setDragging(false);
        const next = moved(ev);
        setPoint(next);
        writeStoredPosition(next);
      },
    });
  };

  const releasePinIfScrolledAway = (event: UIEvent<HTMLElement>) => {
    if (!pinToEnd.current) return;
    const list = event.target;
    if (!(list instanceof HTMLElement) || !list.classList.contains("chat-list")) return;
    if (list.scrollHeight - list.scrollTop - list.clientHeight >= 72) pinToEnd.current = false;
  };

  return (
    <section
      ref={rootRef}
      className={dragging ? "quick-chat is-dragging" : "quick-chat"}
      data-testid="quick-chat"
      aria-label="Ava"
      onScrollCapture={releasePinIfScrolledAway}
      style={{ width: QUICK_CHAT_WIDTH, height: QUICK_CHAT_HEIGHT, left: placed.x, top: placed.y }}
    >
      <header className="quick-chat-bar" onPointerDown={onBarPointerDown}>
        <span className="quick-chat-title">Ava</span>
        <div className="quick-chat-actions">
          <button type="button" className="chat-icon-btn" aria-label="Move to bottom right" title="Bottom right" onClick={resetPlace}>
            <ArrowDownRight size={16} aria-hidden="true" />
          </button>
          <button type="button" className="chat-icon-btn" aria-label="Hide pinned chats" title="Hide" onClick={onHide}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>
      {pinned.length === 0 ? (
        <div className="quick-chat-empty">
          <MessageSquare size={22} aria-hidden="true" />
          <p>No pinned chats</p>
          <p className="quick-chat-empty-hint">Pin a chat from the Chat tab and it shows up here.</p>
        </div>
      ) : (
        <>
          <div className="quick-chat-tabs" role="tablist" aria-label="Pinned chats">
            {pinned.map((thread) => {
              const key = threadKey(thread);
              const label = threadLabel(thread);
              const repo = repoLabel(thread.repo_path, repos);
              return (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  className="quick-chat-tab"
                  aria-selected={key === resolvedKey}
                  title={`${label} · ${repo}`}
                  onClick={() => selectTab(key)}
                >
                  <span className="quick-chat-tab-name">{label}</span>
                  <span className="quick-chat-tab-repo" aria-hidden="true">
                    {repo}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="quick-chat-body">
            {chat.inTerminal ? (
              <div className="quick-chat-empty">
                <p>This thread is open in the terminal.</p>
              </div>
            ) : (
              <ChatPane
                entries={chat.transcript.entries}
                status={chat.activity.status}
                visibility={paneVisibility}
                onApprove={chat.approve}
                onLoadOlder={chat.loadOlder}
                loadingOlder={chat.loadingOlder}
                atStart={chat.transcript.fileStart === 0}
              />
            )}
            {chat.disconnected !== null ? (
              <div className="chat-banner" role="alert">
                <span>Lost the connection to Ava in this thread.</span>
                <button type="button" className="btn small" onClick={() => chat.reconnect()}>
                  Reconnect
                </button>
              </div>
            ) : null}
            {chat.error ? (
              <div className="chat-banner" role="alert">
                <span>{chat.error}</span>
              </div>
            ) : null}
            {!chat.inTerminal && chat.prompt ? (
              <ChatExtensionPrompt
                request={chat.prompt}
                onSubmit={(value) => {
                  const id = chat.prompt?.id;
                  if (id) void chat.reply(id, value);
                }}
                onCancel={() => {
                  const id = chat.prompt?.id;
                  if (id) void chat.cancelUi(id);
                }}
              />
            ) : null}
            {chat.inTerminal || !resolved ? null : (
              <ChatComposer
                body={chat.draft}
                status={chat.activity.status}
                catalog={chat.transcript.commands}
                sending={chat.sending}
                showHints={visibility.showComposerHints}
                allowAttach={false}
                onBodyChange={chat.setDraft}
                onSend={() => {
                  chat.send();
                }}
                onAbort={chat.abort}
                onSendNow={chat.sendNowEnabled ? () => chat.sendNow() : undefined}
                sendNowEnabled={chat.sendNowEnabled}
                queuedCount={chat.transcript.sessionMeta.queuedMessageCount}
              />
            )}
            {resolved && resolvedKey ? (
              <div className="quick-chat-foot">
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={() => {
                    registry.requestOpen(resolvedKey);
                    onOpenInChat();
                  }}
                >
                  Open in Chat
                </button>
              </div>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
