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
 * 350 by 600 until dragged or resized. The place, the size, and the selected tab are remembered
 * across launches. Reopening lands at the bottom of that tab.
 */
export const QUICK_CHAT_WIDTH = 350;
export const QUICK_CHAT_HEIGHT = 600;
export const QUICK_CHAT_MIN_WIDTH = 280;
export const QUICK_CHAT_MIN_HEIGHT = 360;
export const QUICK_CHAT_MARGIN = 16;

const POSITION_KEY = "alinery.quickChat.position";
const SIZE_KEY = "alinery.quickChat.size";
const TAB_KEY = "alinery.quickChat.tab";

const CORNERS = ["nw", "ne", "sw", "se"] as const;
type Corner = (typeof CORNERS)[number];
const RESIZE_LABEL: Record<Corner, string> = {
  nw: "Resize from top left",
  ne: "Resize from top right",
  sw: "Resize from bottom left",
  se: "Resize from bottom right",
};

type Point = { x: number; y: number };
type Size = { width: number; height: number };
type Box = Point & Size;
type Viewport = { width: number; height: number };
type Gesture = "move" | Corner;

function viewport(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

function minSize(frame: Viewport): Size {
  return {
    width: Math.min(QUICK_CHAT_MIN_WIDTH, Math.max(0, frame.width)),
    height: Math.min(QUICK_CHAT_MIN_HEIGHT, Math.max(0, frame.height)),
  };
}

function clampBox(box: Box, frame: Viewport): Box {
  const min = minSize(frame);
  const width = Math.round(Math.min(Math.max(box.width, min.width), Math.max(min.width, frame.width)));
  const height = Math.round(Math.min(Math.max(box.height, min.height), Math.max(min.height, frame.height)));
  const maxX = Math.max(0, frame.width - width);
  const maxY = Math.max(0, frame.height - height);
  return {
    width,
    height,
    x: Math.round(Math.min(Math.max(box.x, 0), maxX)),
    y: Math.round(Math.min(Math.max(box.y, 0), maxY)),
  };
}

/** Bottom-right, inset by the margin, at the default size. A viewport smaller than the window pins to the origin. */
function defaultBox(frame: Viewport): Box {
  return clampBox(
    {
      x: frame.width - QUICK_CHAT_WIDTH - QUICK_CHAT_MARGIN,
      y: frame.height - QUICK_CHAT_HEIGHT - QUICK_CHAT_MARGIN,
      width: QUICK_CHAT_WIDTH,
      height: QUICK_CHAT_HEIGHT,
    },
    frame,
  );
}

function placedBox(point: Point | null, size: Size | null, frame: Viewport): Box {
  const width = size?.width ?? QUICK_CHAT_WIDTH;
  const height = size?.height ?? QUICK_CHAT_HEIGHT;
  return clampBox(
    {
      x: point?.x ?? frame.width - width - QUICK_CHAT_MARGIN,
      y: point?.y ?? frame.height - height - QUICK_CHAT_MARGIN,
      width,
      height,
    },
    frame,
  );
}

function sameBox(a: Box, b: Box): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** The edge opposite the dragged corner stays put, and the window does not cross the screen. */
function resizeFromCorner(start: Box, dx: number, dy: number, corner: Corner, frame: Viewport): Box {
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  const growE = corner === "ne" || corner === "se";
  const growS = corner === "sw" || corner === "se";
  const min = minSize(frame);
  const maxW = Math.max(min.width, growE ? frame.width - start.x : right);
  const maxH = Math.max(min.height, growS ? frame.height - start.y : bottom);
  const width = Math.min(Math.max(start.width + (growE ? dx : -dx), min.width), maxW);
  const height = Math.min(Math.max(start.height + (growS ? dy : -dy), min.height), maxH);
  return clampBox({ x: growE ? start.x : right - width, y: growS ? start.y : bottom - height, width, height }, frame);
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

function readStoredSize(): Size | null {
  try {
    const raw = localStorage.getItem(SIZE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { width?: unknown; height?: unknown };
    if (typeof parsed.width !== "number" || typeof parsed.height !== "number" || !Number.isFinite(parsed.width) || !Number.isFinite(parsed.height)) return null;
    return { width: parsed.width, height: parsed.height };
  } catch {
    return null;
  }
}

function writeStoredSize(size: Size) {
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify(size));
  } catch {
    // A storage failure must not stop the window from resizing.
  }
}

function clearStoredSize() {
  try {
    localStorage.removeItem(SIZE_KEY);
  } catch {
    // The in-memory size still returns to the default.
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
  // null keeps the default corner for the current size, including when the viewport resizes.
  const [point, setPoint] = useState<Point | null>(readStoredPosition);
  // null keeps 350 by 600.
  const [size, setSize] = useState<Size | null>(readStoredSize);
  const [frame, setFrame] = useState(viewport);
  const [gesture, setGesture] = useState<Gesture | null>(null);
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

  const box = placedBox(point, size, frame);
  const atDefault = sameBox(box, defaultBox(frame));
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
    if (!gesture) return;
    const previous = document.body.style.cursor;
    document.body.style.cursor = gesture === "move" ? "grabbing" : gesture === "nw" || gesture === "se" ? "nwse-resize" : "nesw-resize";
    return () => {
      document.body.style.cursor = previous;
    };
  }, [gesture]);

  if (!open) return null;

  const repos = pinned.map((thread) => thread.repo_path);
  const paneVisibility = { ...visibility, maxWidth: "none" as const };

  const selectTab = (key: string) => {
    setTab(key);
    writeStoredTab(key);
  };

  const resetToDefault = () => {
    setPoint(null);
    setSize(null);
    clearStoredPosition();
    clearStoredSize();
  };

  // A gesture keeps an explicit box while the pointer is down. Releasing on the default corner and size
  // drops the stored override so the window follows the viewport again.
  const remember = (next: Box, persist: boolean) => {
    const frameNow = frameRef.current;
    const clamped = clampBox(next, frameNow);
    if (!persist) {
      setPoint({ x: clamped.x, y: clamped.y });
      setSize({ width: clamped.width, height: clamped.height });
      return;
    }
    const nextSize = clamped.width === QUICK_CHAT_WIDTH && clamped.height === QUICK_CHAT_HEIGHT ? null : { width: clamped.width, height: clamped.height };
    const anchored = placedBox(null, nextSize, frameNow);
    const nextPoint = clamped.x === anchored.x && clamped.y === anchored.y ? null : { x: clamped.x, y: clamped.y };
    setPoint(nextPoint);
    setSize(nextSize);
    if (nextPoint) writeStoredPosition(nextPoint);
    else clearStoredPosition();
    if (nextSize) writeStoredSize(nextSize);
    else clearStoredSize();
  };

  const onBarPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("button, .quick-chat-resize")) return;
    event.preventDefault();
    const origin = box;
    const startX = event.clientX;
    const startY = event.clientY;
    const moved = (ev: PointerEvent) =>
      clampBox({ x: origin.x + ev.clientX - startX, y: origin.y + ev.clientY - startY, width: origin.width, height: origin.height }, frameRef.current);
    setGesture("move");
    startDrag(event, {
      onMove: (ev) => {
        const next = moved(ev);
        setPoint({ x: next.x, y: next.y });
      },
      onComplete: (ev) => {
        setGesture(null);
        remember(moved(ev), true);
      },
    });
  };

  const onResizePointerDown = (corner: Corner) => (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const origin = box;
    const startX = event.clientX;
    const startY = event.clientY;
    const resized = (ev: PointerEvent) => resizeFromCorner(origin, ev.clientX - startX, ev.clientY - startY, corner, frameRef.current);
    setGesture(corner);
    startDrag(event, {
      onMove: (ev) => remember(resized(ev), false),
      onComplete: (ev) => {
        setGesture(null);
        remember(resized(ev), true);
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
      className={gesture === "move" ? "quick-chat is-moving" : "quick-chat"}
      data-testid="quick-chat"
      aria-label="Ava"
      onScrollCapture={releasePinIfScrolledAway}
      style={{ width: box.width, height: box.height, left: box.x, top: box.y }}
    >
      <header className="quick-chat-bar" onPointerDown={onBarPointerDown}>
        <span className="quick-chat-title">Ava</span>
        <div className="quick-chat-actions">
          {atDefault ? null : (
            <button type="button" className="chat-icon-btn" aria-label="Reset to default" title="Default" onClick={resetToDefault}>
              <ArrowDownRight size={16} aria-hidden="true" />
            </button>
          )}
          <button type="button" className="chat-icon-btn" aria-label="Hide pinned chats" title="Hide" onClick={onHide}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>
      {CORNERS.map((corner) => (
        <button key={corner} type="button" className={`quick-chat-resize ${corner}`} aria-label={RESIZE_LABEL[corner]} onPointerDown={onResizePointerDown(corner)} />
      ))}
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
