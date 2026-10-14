import { MessageSquare, X } from "lucide-react";
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { ChatComposer } from "../ChatComposer";
import type { ChatPrefs } from "../chat/visibility";
import * as ipc from "../ipc";
import type { ChatThread } from "../types";
import { ChatExtensionPrompt } from "./ChatExtensionPrompt";
import { ChatPane } from "./ChatPane";
import { repoLabel } from "./ChatView";
import { threadKey, threadLabel, useChatRegistry, useChatThread } from "./chatThreadSession";

/**
 * Fixed bottom-right, 350 by 600, until the follow-up: drag and resize, and remembering
 * whether the window is open and where it sits across relaunch.
 */
export const QUICK_CHAT_WIDTH = 350;
export const QUICK_CHAT_HEIGHT = 600;

export function QuickChat({ open, visibility, onOpenInChat, onHide }: { open: boolean; visibility: ChatPrefs; onOpenInChat: () => void; onHide: () => void }) {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [tab, setTab] = useState<string | null>(null);
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
    },
  });

  if (!open) return null;

  const repos = pinned.map((thread) => thread.repo_path);
  const paneVisibility = { ...visibility, maxWidth: "none" as const };

  return (
    <section className="quick-chat" data-testid="quick-chat" aria-label="Pinned chats" style={{ width: QUICK_CHAT_WIDTH, height: QUICK_CHAT_HEIGHT }}>
      <header className="quick-chat-bar">
        <span className="quick-chat-title">Pinned</span>
        <button type="button" className="chat-icon-btn" aria-label="Hide pinned chats" title="Hide" onClick={onHide}>
          <X size={16} aria-hidden="true" />
        </button>
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
                <button key={key} type="button" role="tab" className="quick-chat-tab" aria-selected={key === resolvedKey} title={`${label} · ${repo}`} onClick={() => setTab(key)}>
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
