import { ArrowUp, CornerDownLeft, Paperclip, Square } from "lucide-react";
import { type ClipboardEvent, type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DraftAttachment } from "./chat/attachments";
import { groupCommands, matchCommands, parseSlash } from "./chat/commands";
import { formatComposerStats } from "./chat/format";
import { type ChatCommand, type SessionChatStatus, SOURCE_LABEL } from "./chat/types";
import { sessionMessageMetrics } from "./sessionMessage";

const LINE = 20;
const MAX_LINES = 8;

export type ChatComposerProps = {
  body: string;
  status: SessionChatStatus;
  catalog: ChatCommand[];
  sending?: boolean;
  showHints?: boolean;
  /** History view: the same composer shell, inert. A finished session has nothing to send to. */
  readOnly?: boolean;
  onBodyChange: (body: string) => void;
  onCompositionChange?: (composing: boolean) => void;
  onSend: (text: string) => void;
  onAbort: () => void;
  onSendNow?: () => void;
  sendNowEnabled?: boolean;
  canAbort?: boolean;
  queuedCount?: number;
  attachments?: DraftAttachment[];
  dropping?: boolean;
  onAttach?: () => void;
  onRemoveAttachment?: (id: string) => void;
  onClear?: () => void;
  onPasteFiles?: (files: File[]) => void;
};

export function ChatComposer({
  body,
  status,
  catalog,
  sending = false,
  showHints = true,
  readOnly = false,
  onBodyChange,
  onCompositionChange,
  onSend,
  onAbort,
  onSendNow,
  sendNowEnabled = false,
  canAbort,
  queuedCount,
  attachments,
  dropping = false,
  onAttach,
  onRemoveAttachment,
  onClear,
  onPasteFiles,
}: ChatComposerProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);
  const running = status === "running";
  const waiting = status === "waiting_approval";
  const abortEnabled = canAbort ?? running;

  const metrics = sessionMessageMetrics(body);

  const slash = body.startsWith("/");
  const matches = slash ? matchCommands(body, catalog) : [];
  const palette = open && slash;

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "0px";
    const cap = LINE * MAX_LINES;
    const next = Math.min(Math.max(el.scrollHeight, LINE), cap);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > cap + 1 ? "auto" : "hidden";
  }, [body]);

  useEffect(() => {
    setActive(0);
    setOpen(slash);
  }, [slash, body]);

  function submit() {
    const raw = body.trim();
    if (readOnly || waiting || sending || metrics.overLimit) return;
    if (!raw && (attachments?.length ?? 0) === 0) return;
    onSend(raw);
    setOpen(false);
  }

  function clearDraft() {
    if (onClear) onClear();
    else onBodyChange("");
  }

  function paste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (readOnly) return;
    const data = e.clipboardData;
    if (!data) return;
    const taken: File[] = [];
    const items = data.items;
    if (items) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item) continue;
        if (item.kind !== "file" && !item.type.startsWith("image/")) continue;
        const file = item.getAsFile();
        if (file) taken.push(file);
      }
    }
    if (taken.length === 0) taken.push(...Array.from(data.files ?? []));
    if (taken.length === 0) return;
    e.preventDefault();
    onPasteFiles?.(taken);
  }

  function fill(cmd: ChatCommand) {
    const next = cmd.input ? `/${cmd.name} ` : `/${cmd.name}`;
    onBodyChange(next);
    setOpen(false);
    ta.current?.focus();
  }

  function run(cmd: ChatCommand) {
    if (cmd.input) {
      fill(cmd);
      return;
    }
    onSend(`/${cmd.name}`);
    setOpen(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (!readOnly && e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      const start = e.currentTarget.selectionStart;
      const end = e.currentTarget.selectionEnd;
      const lineBreak = body.indexOf("\n", start);
      const killEnd = start === end ? (lineBreak === -1 ? body.length : lineBreak) : end;
      onBodyChange(`${body.slice(0, start)}${body.slice(killEnd)}`);
      requestAnimationFrame(() => ta.current?.setSelectionRange(start, start));
      return;
    }
    if (palette) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => Math.min(i + 1, Math.max(matches.length - 1, 0)));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const cmd = matches[active];
        if (cmd) fill(cmd);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const cmd = matches[active];
        const parsed = parseSlash(body);
        if (cmd && parsed && parsed.name.toLowerCase() === cmd.name.toLowerCase() && !parsed.args && !cmd.input) {
          run(cmd);
        } else {
          submit();
        }
        return;
      }
    }
    if (e.key === "Escape") {
      if (abortEnabled && running && !readOnly) {
        e.preventDefault();
        onAbort();
      } else if (body) {
        onBodyChange("");
      }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  const mode = readOnly ? "readonly" : waiting ? "wait" : running ? "queue" : "prompt";
  const placeholder = readOnly ? "This session has ended — history only" : waiting ? "Waiting on approval…" : running ? "Send after this turn…" : "Message or /command";
  const sendDisabled = readOnly || waiting || sending || metrics.overLimit || (body.trim().length === 0 && (attachments?.length ?? 0) === 0);
  const sendNowDisabled = !sendNowEnabled || sending || readOnly;
  const sendLabel = running ? "Queue" : "Send";
  const staged = attachments ?? [];
  const images = staged.filter((a) => a.kind === "image");
  const files = staged.filter((a) => a.kind === "file");

  return (
    <div className="chat-composer">
      {palette ? <CommandList matches={matches} active={active} onPick={fill} onHover={setActive} /> : null}

      {metrics.large ? (
        <div className="session-message-large" role="status">
          <strong>{metrics.overLimit ? "Oversized draft preserved" : "Large draft preserved"}</strong>
          <span>
            {metrics.utf8Bytes.toLocaleString()} UTF-8 bytes are held in memory but not rendered, keeping Alinery responsive.
            {!metrics.overLimit && " Send remains available; delivery may take longer."}
          </span>
          {/* The text area is gone at this size, so Send and Clear are the only way out of a
              pasted-in wall of text. Without them the draft is unsendable and unclearable. */}
          <div className="session-message-large-actions">
            <button type="button" className="btn session-message-clear" onClick={clearDraft}>
              Clear large draft
            </button>
            {onSendNow ? (
              <button type="button" className="btn small" onClick={onSendNow} disabled={sendNowDisabled} aria-label="Send now">
                Send now
              </button>
            ) : null}
            <button type="button" className="btn primary small" onClick={submit} disabled={sendDisabled} aria-label={sendLabel}>
              {sendLabel}
            </button>
          </div>
        </div>
      ) : (
        <div className={`chat-composer-box${waiting ? " wait" : ""}${dropping ? " drop" : ""}`} data-mode={mode}>
          {images.length > 0 ? (
            <div className="chat-composer-images">
              {images.map((a) => (
                <div key={a.id} className="chat-composer-thumb">
                  {a.previewUrl ? <img src={a.previewUrl} alt="" /> : a.name}
                  <button type="button" aria-label={`Remove ${a.name}`} onClick={() => onRemoveAttachment?.(a.id)}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {files.length > 0 ? (
            <div className="chat-composer-files">
              {files.map((a) => (
                <div key={a.id} className="chat-composer-chip">
                  {a.name}
                  <button type="button" aria-label={`Remove ${a.name}`} onClick={() => onRemoveAttachment?.(a.id)}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="chat-composer-row">
            {!readOnly ? (
              <button type="button" className="btn ghost small" onClick={() => onAttach?.()} aria-label="Attach files">
                <Paperclip className="chat-composer-icon" />
              </button>
            ) : null}
            <span className="chat-composer-prompt" aria-hidden>
              ›
            </span>
            <textarea
              ref={ta}
              className="chat-composer-field"
              value={body}
              rows={1}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              placeholder={placeholder}
              aria-label={placeholder}
              readOnly={readOnly}
              disabled={readOnly}
              onChange={(e) => onBodyChange(e.currentTarget.value)}
              onKeyDown={onKeyDown}
              onPaste={paste}
              onCompositionStart={() => onCompositionChange?.(true)}
              onCompositionEnd={() => onCompositionChange?.(false)}
              onFocus={() => {
                if (slash) setOpen(true);
              }}
            />
            {staged.length > 0 && !readOnly ? (
              <button type="button" className="btn ghost small" onClick={clearDraft}>
                Clear
              </button>
            ) : null}
            {abortEnabled && running && !readOnly ? (
              <button type="button" className="btn ghost small chat-composer-abort" onClick={onAbort} aria-label="Abort turn" title="Esc abort">
                <Square className="chat-composer-icon" fill="currentColor" />
              </button>
            ) : null}
            {onSendNow ? (
              <button type="button" className="btn ghost small" onClick={onSendNow} disabled={sendNowDisabled} aria-label="Send now">
                Send now
              </button>
            ) : null}
            <button type="button" className="btn primary small chat-composer-send" onClick={submit} disabled={sendDisabled} aria-label={sendLabel} title="Enter send">
              <ArrowUp className="chat-composer-icon" strokeWidth={2.2} />
            </button>
          </div>
        </div>
      )}

      <div className="chat-composer-hints">
        {showHints ? (
          palette ? (
            <>
              <Hint keys={[<Kbd key="up">↑</Kbd>, <Kbd key="down">↓</Kbd>]} label="move" />
              <Hint keys={[<Kbd key="tab">tab</Kbd>]} label="fill" />
              <Hint
                keys={[
                  <Kbd key="enter">
                    <CornerDownLeft className="chat-composer-icon" strokeWidth={2} />
                  </Kbd>,
                ]}
                label="run"
              />
              <Hint keys={[<Kbd key="esc">esc</Kbd>]} label="close" />
            </>
          ) : (
            <>
              <Hint
                keys={[
                  <Kbd key="enter">
                    <CornerDownLeft className="chat-composer-icon" strokeWidth={2} />
                  </Kbd>,
                ]}
                label="send"
              />
              <Hint
                keys={[
                  <Kbd key="shift">⇧</Kbd>,
                  <Kbd key="enter">
                    <CornerDownLeft className="chat-composer-icon" strokeWidth={2} />
                  </Kbd>,
                ]}
                label="line"
              />
              <Hint keys={[<Kbd key="slash">/</Kbd>]} label="commands" />
              <Hint keys={[<Kbd key="tab">tab</Kbd>]} label="complete" />
              <Hint keys={[<Kbd key="esc">esc</Kbd>]} label={running ? "abort" : "clear"} />
            </>
          )
        ) : null}
        {queuedCount != null && queuedCount > 0 ? <span className="dim">{queuedCount} queued</span> : null}
        <span className={`chat-composer-context${metrics.overLimit ? " over" : ""}`}>{formatComposerStats(metrics.codePoints)}</span>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="chat-kbd">{children}</kbd>;
}

function Hint({ keys, label }: { keys: ReactNode[]; label: string }) {
  return (
    <span className="chat-hint">
      <span className="chat-hint-keys">{keys}</span>
      <span>{label}</span>
    </span>
  );
}

function CommandList({ matches, active, onPick, onHover }: { matches: ChatCommand[]; active: number; onPick: (cmd: ChatCommand) => void; onHover: (i: number) => void }) {
  const list = useRef<HTMLDivElement>(null);
  const groups = groupCommands(matches);
  const flat = matches;

  useEffect(() => {
    const el = list.current?.querySelector(`[data-i="${active}"]`);
    if (el && "scrollIntoView" in el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [active]);

  return (
    <div ref={list} className="chat-cmd-menu" role="listbox" aria-label="Available commands">
      {matches.length === 0 ? (
        <div className="chat-cmd-empty">Unknown /name is sent as a prompt. Not invented as a local command.</div>
      ) : (
        groups.map((g) => (
          <div key={g.group} className="chat-cmd-group">
            <div className="chat-cmd-group-label">{SOURCE_LABEL[g.group as keyof typeof SOURCE_LABEL] ?? g.group}</div>
            {g.items.map((cmd) => {
              const i = flat.indexOf(cmd);
              return (
                <button
                  key={cmd.name}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  data-i={i}
                  className={`chat-cmd-item${i === active ? " active" : ""}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => onHover(i)}
                  onClick={() => onPick(cmd)}
                >
                  <span className="chat-cmd-name">/{cmd.name}</span>
                  <span className="chat-cmd-hint">{cmd.input?.hint ?? ""}</span>
                  <span className="chat-cmd-desc">{cmd.description ?? ""}</span>
                </button>
              );
            })}
          </div>
        ))
      )}
    </div>
  );
}

export function chatComposerLineCap(): { line: number; max: number } {
  return { line: LINE, max: LINE * MAX_LINES };
}
