import { createContext, type ReactNode, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatContextUsage } from "../chat/format";
import { applySendPlan, commandOutputText, planChatSend } from "../chat/send";
import { type McpServerRow, type ProvidersDialogTab, parseMcpListOutput } from "../chat/slash";
import type { SessionChatStatus } from "../chat/types";
import {
  appendOptimisticAbort,
  appendOptimisticUser,
  type ChatTranscriptState,
  carryOver,
  emptyTranscript,
  matchingSendFailure,
  matchingSendSuccess,
  needsUiReply,
  type PendingUi,
  settleRefusedSend,
} from "../chatTranscript";
import * as ipc from "../ipc";
import { compactCommand, getStateCommand, promptCommand, setAutoCompactionCommand } from "../ompRpc";
import type { SessionTerminalIo } from "../SessionTerminal";
import { type ObservationDisplayKind, observationDisplayKind } from "../sessionAttention";
import { isTurnActive } from "../sessionMessage";
import type { ChatThread, SessionObservation } from "../types";
import { ChatMcpDialog } from "./ChatMcpDialog";
import { ChatToolsDialog } from "./ChatToolsDialog";
import {
  abortTurnCommand,
  applyChatValue,
  applyModelCommand,
  applyPlainSend,
  attachHandshake,
  chatTerminalIo,
  olderPageState,
  parseChatLine,
  queueRefreshCommand,
  readJournalThrough,
  sendCommand,
  sendNowCommand,
} from "./chatSession";
import { ProviderSetupDialog } from "./ProviderSetupDialog";
import { useChatUiReplies } from "./useChatUiReplies";

export function threadLabel(thread: ChatThread): string {
  if (thread.name) return thread.name;
  return `Chat ${thread.session.id.slice(0, 8)}`;
}

export function threadKey(thread: ChatThread): string {
  return `${thread.repo_path}:${thread.session.id}`;
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const NO_TRANSCRIPT = emptyTranscript();

/**
 * The RPC link to a thread's OMP. `offline` is a thread with no process to talk to
 * (never started, exited, or in its terminal): its history is readable and that is not an error.
 */
type Connection = { state: "connecting" } | { state: "ready" } | { state: "offline" } | { state: "failed"; detail: string };

/**
 * Busy comes from the turn itself (live transcript first, then the observation poll), the same
 * predicate task sessions use, and decides whether a send queues. The displayed kind is the observed
 * one; the transcript only moves it to Running in the gap before the poll sees the turn, and a
 * booting OMP (process up, agent not yet `ready`) has no turn, so a new thread reads Idle.
 */
export function chatActivity(
  observation: SessionObservation | null,
  transcript: ChatTranscriptState,
): { status: SessionChatStatus; turnActive: boolean; kind: ObservationDisplayKind } {
  const raw = observation ? observationDisplayKind(observation) : null;
  // OMP that died mid-turn never sends turn_end, and the daemon keeps its last agent state: neither is a running turn.
  const exited = observation?.state ? observation.state.process.state === "exited" : raw === "exited";
  const turnActive = !exited && isTurnActive({ pendingTurn: transcript.pendingTurn, turnOpen: transcript.turnOpen, agentState: observation?.state?.agent?.state });
  const status: SessionChatStatus = raw === "waiting_for_approval" ? "waiting_approval" : turnActive ? "running" : "idle";
  // Nothing observed yet is Loading, never Idle.
  if (raw === null) return { status, turnActive, kind: "loading" };
  const quiet = raw === "loading" || raw === "starting" || raw === "idle";
  return { status, turnActive, kind: quiet ? (turnActive ? "busy" : "idle") : raw };
}

function interruptedWithoutJournal(thread: ChatThread, transcript: ChatTranscriptState): boolean {
  return thread.session.ended_at != null && thread.session.harness_resume_token.length === 0 && transcript.entries.length === 0;
}

export type ChatThreadSnapshot = {
  transcript: ChatTranscriptState;
  observation: SessionObservation | null;
  connection: Connection;
  activity: ReturnType<typeof chatActivity>;
  draft: string;
  sending: boolean;
  error: string;
  loadingOlder: boolean;
  processLive: boolean;
  inTerminal: boolean;
  terminalIo: SessionTerminalIo | undefined;
  statusKind: ObservationDisplayKind;
  contextUsage: string | null;
  modelLabel: string;
  blocked: boolean;
  disconnected: string | null;
  sendNowEnabled: boolean;
  prompt: PendingUi | undefined;
  providersDialog: { tab: ProvidersDialogTab; preselect: string } | null;
  toolsOpen: boolean;
  mcpDialog: { rows: McpServerRow[]; empty: boolean } | null;
};

type ChatThreadApi = {
  send: (who: symbol, override?: string) => void;
  sendNow: (who: symbol) => void;
  abort: () => void;
  reconnect: () => void;
  loadOlder: () => void;
  setObserved: (value: SessionObservation) => void;
  setDraft: (value: string) => void;
  setProvidersDialog: (value: { tab: ProvidersDialogTab; preselect: string } | null) => void;
  setToolsOpen: (value: boolean) => void;
  setMcpDialog: (value: { rows: McpServerRow[]; empty: boolean } | null) => void;
  approve: (id: string, allow: boolean) => void;
  reply: (id: string, value: string) => void;
  cancelUi: (id: string) => void;
};

const IDLE_ACTIVITY = chatActivity(null, NO_TRANSCRIPT);

const EMPTY_SNAPSHOT: ChatThreadSnapshot = {
  transcript: NO_TRANSCRIPT,
  observation: null,
  connection: { state: "connecting" },
  activity: IDLE_ACTIVITY,
  draft: "",
  sending: false,
  error: "",
  loadingOlder: false,
  processLive: false,
  inTerminal: false,
  terminalIo: undefined,
  statusKind: "loading",
  contextUsage: null,
  modelLabel: "Model",
  blocked: false,
  disconnected: null,
  sendNowEnabled: false,
  prompt: undefined,
  providersDialog: null,
  toolsOpen: false,
  mcpDialog: null,
};

const NO_API: ChatThreadApi = {
  send: () => {},
  sendNow: () => {},
  abort: () => {},
  reconnect: () => {},
  loadOlder: () => {},
  setObserved: () => {},
  setDraft: () => {},
  setProvidersDialog: () => {},
  setToolsOpen: () => {},
  setMcpDialog: () => {},
  approve: () => {},
  reply: () => {},
  cancelUi: () => {},
};

type Verdict = { text: string; entryId: string | null; refused: boolean };

type Sub = {
  id: symbol;
  active: boolean;
  isFocused: () => boolean;
  onReload: () => Promise<void> | void;
  onResumeRefresh: () => Promise<void> | void;
  onRebind: (key: string) => void;
};

type Entry = {
  key: string;
  thread?: ChatThread;
  subs: Map<symbol, Sub>;
  draft: string;
  verdicts: Map<string, Verdict>;
  autoCompaction: boolean;
  kick?: () => void;
  snapshot: ChatThreadSnapshot;
  listeners: Set<() => void>;
  api: ChatThreadApi;
};

type Registry = {
  entries: Map<string, Entry>;
  host: () => void;
  error: string;
  errorListeners: Set<() => void>;
  setError: (next: string | ((current: string) => string)) => void;
  listenError: (fn: () => void) => () => void;
  sendingKey: string | null;
  setSending: (key: string | null) => void;
  pendingPrompt: { key: string; text: string } | null;
  pendingFocus: string | null;
  focusListeners: Set<() => void>;
  requestOpen: (key: string) => void;
  takeFocus: () => string | null;
  listenFocus: (fn: () => void) => () => void;
  retain: (thread: ChatThread, sub: Sub) => () => void;
  noteThread: (thread: ChatThread) => void;
  subFor: (key: string, id: symbol) => Sub | undefined;
  setAutoCompaction: (key: string, value: boolean) => void;
  touch: (entry: Entry) => void;
  moveDraft: (from: string, to: string, fallback: string) => void;
};

function createEntry(key: string): Entry {
  return {
    key,
    subs: new Map(),
    draft: "",
    verdicts: new Map(),
    autoCompaction: true,
    snapshot: EMPTY_SNAPSHOT,
    listeners: new Set(),
    api: NO_API,
  };
}

function createRegistry(): Registry {
  const registry: Registry = {
    entries: new Map(),
    host: () => {},
    error: "",
    errorListeners: new Set(),
    sendingKey: null,
    pendingPrompt: null,
    pendingFocus: null,
    focusListeners: new Set(),
    setError: () => {},
    listenError: () => () => {},
    setSending: () => {},
    requestOpen: () => {},
    takeFocus: () => null,
    listenFocus: () => () => {},
    retain: () => () => {},
    noteThread: () => {},
    subFor: () => undefined,
    setAutoCompaction: () => {},
    touch: () => {},
    moveDraft: () => {},
  };

  const ensure = (key: string) => {
    let entry = registry.entries.get(key);
    if (!entry) {
      entry = createEntry(key);
      registry.entries.set(key, entry);
    }
    return entry;
  };

  registry.touch = (entry) => {
    const draft = entry.draft;
    const base = entry.snapshot;
    const agent = base.observation?.state?.agent?.state;
    const pendingUiReply = base.transcript.pendingUi.some((request) => needsUiReply(request.method));
    entry.snapshot = {
      ...base,
      draft,
      sending: registry.sendingKey === entry.key,
      error: registry.error,
      blocked: registry.error === "cannot continue",
      disconnected: base.connection.state === "failed" && !base.inTerminal ? base.connection.detail : null,
      // The composer reads this off the snapshot. A keystroke updates the draft without re-rendering the owner.
      sendNowEnabled:
        base.connection.state === "ready" &&
        base.activity.status === "running" &&
        agent !== "waiting_for_input" &&
        agent !== "waiting_for_approval" &&
        !pendingUiReply &&
        draft.trim().length > 0,
    };
    for (const listener of entry.listeners) listener();
  };

  registry.setError = (next) => {
    const value = typeof next === "function" ? next(registry.error) : next;
    if (value === registry.error) return;
    registry.error = value;
    for (const listener of registry.errorListeners) listener();
    for (const entry of registry.entries.values()) registry.touch(entry);
  };

  registry.listenError = (fn) => {
    registry.errorListeners.add(fn);
    return () => registry.errorListeners.delete(fn);
  };

  registry.setSending = (key) => {
    registry.sendingKey = key;
    for (const entry of registry.entries.values()) registry.touch(entry);
  };

  registry.requestOpen = (key) => {
    registry.pendingFocus = key;
    for (const listener of registry.focusListeners) listener();
  };

  registry.takeFocus = () => {
    const key = registry.pendingFocus;
    registry.pendingFocus = null;
    return key;
  };

  registry.listenFocus = (fn) => {
    registry.focusListeners.add(fn);
    return () => registry.focusListeners.delete(fn);
  };

  registry.noteThread = (thread) => {
    const entry = registry.entries.get(threadKey(thread));
    if (entry) entry.thread = thread;
  };

  registry.subFor = (key, id) => registry.entries.get(key)?.subs.get(id);

  registry.setAutoCompaction = (key, value) => {
    const entry = registry.entries.get(key);
    if (!entry || entry.autoCompaction === value) return;
    entry.autoCompaction = value;
    entry.kick?.();
  };

  registry.moveDraft = (from, to, fallback) => {
    const src = ensure(from);
    const text = src.draft || fallback;
    src.draft = "";
    const dest = ensure(to);
    dest.draft = text;
    registry.touch(src);
    registry.touch(dest);
  };

  registry.retain = (thread, sub) => {
    const key = threadKey(thread);
    const entry = ensure(key);
    entry.thread = thread;
    entry.subs.set(sub.id, sub);
    registry.host();
    return () => {
      entry.subs.delete(sub.id);
      registry.host();
    };
  };

  return registry;
}

export const ChatSessionContext = createContext<Registry | null>(null);

export function ChatSessionProvider({ children }: { children: ReactNode }) {
  const registry = useRef<Registry | null>(null);
  if (!registry.current) registry.current = createRegistry();
  const reg = registry.current;
  const [tick, setTick] = useState(0);
  // Assigned during render so a child's retain effect, which runs before this effect, can wake the host.
  reg.host = () => setTick((n) => n + 1);
  useEffect(() => {
    return () => {
      reg.host = () => {};
      reg.entries.clear();
      reg.pendingPrompt = null;
      reg.sendingKey = null;
      reg.error = "";
      reg.pendingFocus = null;
    };
  }, [reg]);
  return (
    <ChatSessionContext.Provider value={reg}>
      {children}
      <ChatSessionHost registry={reg} tick={tick} />
    </ChatSessionContext.Provider>
  );
}

function ChatSessionHost({ registry, tick }: { registry: Registry; tick: number }) {
  void tick;
  const live = [...registry.entries.values()].filter((entry) => entry.subs.size > 0 && entry.thread);
  return (
    <>
      {live.map((entry) => (
        <ChatThreadController key={entry.key} entry={entry} />
      ))}
    </>
  );
}

export function useChatRegistry(): Registry {
  const registry = useContext(ChatSessionContext);
  if (!registry) throw new Error("ChatSessionProvider missing");
  return registry;
}

export type ChatThreadOptions = {
  active: boolean;
  autoCompaction: boolean;
  isFocused: (key: string) => boolean;
  onReload: () => Promise<void> | void;
  onResumeRefresh: () => Promise<void> | void;
  onRebind: (key: string) => void;
};

export type ChatThreadHandle = ChatThreadSnapshot & {
  setDraft: (value: string) => void;
  setError: (next: string | ((current: string) => string)) => void;
  send: (override?: string) => void;
  sendNow: () => void;
  abort: () => void;
  reconnect: () => void;
  loadOlder: () => void;
  setObserved: (value: SessionObservation) => void;
  setProvidersDialog: (value: { tab: ProvidersDialogTab; preselect: string } | null) => void;
  setToolsOpen: (value: boolean) => void;
  setMcpDialog: (value: { rows: McpServerRow[]; empty: boolean } | null) => void;
  approve: (id: string, allow: boolean) => void;
  reply: (id: string, value: string) => void;
  cancelUi: (id: string) => void;
};

/**
 * One live OMP attach per thread. Chat and the pinned window both call this; the first subscriber
 * starts the connection and the last one detaches it. A second attach's detach drops the first.
 */
export function useChatThread(thread: ChatThread | null, opts: ChatThreadOptions): ChatThreadHandle {
  const registry = useChatRegistry();
  const subId = useRef(Symbol());
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const key = thread ? threadKey(thread) : null;
  if (thread) registry.noteThread(thread);

  const sub = key ? registry.subFor(key, subId.current) : undefined;
  if (sub && key) {
    sub.active = opts.active;
    sub.isFocused = () => optsRef.current.isFocused(key);
    sub.onReload = () => optsRef.current.onReload();
    sub.onResumeRefresh = () => optsRef.current.onResumeRefresh();
    sub.onRebind = (next) => optsRef.current.onRebind(next);
  }

  // `thread` is read when the key changes. A later list refresh updates `entry.thread` and must not reattach.
  // biome-ignore lint/correctness/useExhaustiveDependencies: key is the retain identity.
  useEffect(() => {
    if (!thread || !key) return;
    const created: Sub = {
      id: subId.current,
      active: optsRef.current.active,
      isFocused: () => optsRef.current.isFocused(key),
      onReload: () => optsRef.current.onReload(),
      onResumeRefresh: () => optsRef.current.onResumeRefresh(),
      onRebind: (next) => optsRef.current.onRebind(next),
    };
    return registry.retain(thread, created);
  }, [registry, key]);

  useEffect(() => {
    if (!key) return;
    registry.setAutoCompaction(key, optsRef.current.autoCompaction);
  }, [registry, key, opts.autoCompaction]);

  const [trackedKey, setTrackedKey] = useState(key);
  const [snap, setSnap] = useState(EMPTY_SNAPSHOT);
  if (key !== trackedKey) {
    setTrackedKey(key);
    setSnap(key ? (registry.entries.get(key)?.snapshot ?? EMPTY_SNAPSHOT) : EMPTY_SNAPSHOT);
  }

  useEffect(() => {
    if (!key) return;
    const entry = registry.entries.get(key);
    if (!entry) return;
    setSnap(entry.snapshot);
    const pull = () => setSnap(entry.snapshot);
    entry.listeners.add(pull);
    return () => {
      entry.listeners.delete(pull);
    };
  }, [registry, key]);

  const [error, setErrorState] = useState(registry.error);
  useEffect(() => registry.listenError(() => setErrorState(registry.error)), [registry]);

  const entry = key ? registry.entries.get(key) : undefined;
  const api = entry?.api ?? NO_API;
  const disconnected = snap.connection.state === "failed" && !snap.inTerminal ? snap.connection.detail : null;
  return {
    ...snap,
    error,
    blocked: error === "cannot continue",
    disconnected,
    setDraft: (value) => {
      if (!entry) return;
      entry.draft = value;
      registry.touch(entry);
    },
    setError: registry.setError,
    send: (override) => {
      if (key) api.send(subId.current, override);
    },
    sendNow: () => {
      if (key) api.sendNow(subId.current);
    },
    abort: () => api.abort(),
    reconnect: () => api.reconnect(),
    loadOlder: () => api.loadOlder(),
    setObserved: (value) => api.setObserved(value),
    setProvidersDialog: (value) => api.setProvidersDialog(value),
    setToolsOpen: (value) => api.setToolsOpen(value),
    setMcpDialog: (value) => api.setMcpDialog(value),
    approve: (id, allow) => api.approve(id, allow),
    reply: (id, value) => api.reply(id, value),
    cancelUi: (id) => api.cancelUi(id),
  };
}

function entryIsActive(entry: Entry): boolean {
  for (const sub of entry.subs.values()) if (sub.active) return true;
  return false;
}

/**
 * The single attach for one thread. Chat and the pinned window are subscribers; this is the owner.
 * Dialogs opened by a slash command render here so the two windows don't each open one.
 */
function ChatThreadController({ entry }: { entry: Entry }) {
  const registry = useChatRegistry();
  const thread = entry.thread as ChatThread;
  const repo = thread.repo_path;
  const id = thread.session.id;
  const key = entry.key;
  const [epoch, setEpoch] = useState(0);
  const [transcript, setTranscript] = useState<ChatTranscriptState>(NO_TRANSCRIPT);
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;
  const [observation, setObservation] = useState<SessionObservation | null>(null);
  const [connection, setConnection] = useState<Connection>({ state: "connecting" });
  const [providersDialog, setProvidersDialog] = useState<{ tab: ProvidersDialogTab; preselect: string } | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [mcpDialog, setMcpDialog] = useState<{ rows: McpServerRow[]; empty: boolean } | null>(null);
  const mcpListWait = useRef(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [autoCompaction, setAutoCompactionState] = useState(entry.autoCompaction);
  const autoCompactionRef = useRef(autoCompaction);
  autoCompactionRef.current = entry.autoCompaction;
  const compactionPushed = useRef("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    entry.kick = () => setAutoCompactionState(entry.autoCompaction);
    return () => {
      if (entry.kick) entry.kick = undefined;
    };
  }, [entry]);

  const updateTranscript = useCallback((update: (current: ChatTranscriptState) => ChatTranscriptState) => {
    setTranscript(update);
  }, []);

  // The thread object is read at the start of the run. A later list refresh must not restart the attach.
  // biome-ignore lint/correctness/useExhaustiveDependencies: epoch, repo, and id are the attach identity.
  useEffect(() => {
    const threadNow = entry.thread ?? thread;
    compactionPushed.current = `${key}:${autoCompactionRef.current}`;
    const attachId = ipc.nextAttachId();
    const claimed = registry.pendingPrompt?.key === key ? registry.pendingPrompt : null;
    const through = transcriptRef.current.fileStart;
    let cancelled = false;
    registry.setError((current) => (current === "cannot continue" ? "" : current));
    setConnection({ state: "connecting" });
    let endedSeen = false;
    const ended = () => {
      if (cancelled || endedSeen) return;
      endedSeen = true;
      setConnection({ state: "offline" });
      for (const sub of entry.subs.values()) void Promise.resolve(sub.onReload()).catch(() => {});
    };
    const stopClosed = ipc.onStreamClosed(
      id,
      attachId,
      () => {
        ipc.chatSessionStatus(repo, id).then(
          (next) => {
            if (cancelled || next.transport === "pty") return;
            if (next.transport === "rpc" && next.lifecycle.state === "live") setEpoch((value) => value + 1);
            else ended();
          },
          () => {
            if (!cancelled) setEpoch((value) => value + 1);
          },
        );
      },
      () => {
        if (!cancelled) setConnection({ state: "failed", detail: "The live connection closed repeatedly, so automatic reconnection stopped. Reconnect to try again." });
      },
    );
    const observe = () => {
      if (!entryIsActive(entry)) return;
      ipc
        .chatSessionStatus(repo, id)
        .then((next) => {
          if (cancelled) return;
          setObservation(next);
          if (threadNow.session.ended_at == null && (next.lifecycle.state === "exited" || next.lifecycle.state === "live_exited")) ended();
        })
        .catch(() => {});
    };
    observe();
    const timer = window.setInterval(observe, 1500);
    const dropClaim = (message: string) => {
      if (!claimed || registry.pendingPrompt !== claimed) return;
      registry.pendingPrompt = null;
      registry.setSending(null);
      registry.setError(message);
    };
    readJournalThrough((end, want) => ipc.readChatOmp({ repoPath: repo, id, end, want }), through)
      .then(
        (next) => {
          if (cancelled) return;
          setTranscript((current) => carryOver(current, next));
          if (interruptedWithoutJournal(threadNow, next)) registry.setError("cannot continue");
        },
        () => {
          if (cancelled) return;
          setTranscript((current) => current ?? emptyTranscript());
          if (threadNow.session.ended_at != null && threadNow.session.harness_resume_token.length === 0) registry.setError("cannot continue");
        },
      )
      .then(async () => {
        if (cancelled) return;
        if (threadNow.session.started_at == null || threadNow.session.ended_at != null || threadNow.session.archived) {
          setConnection({ state: "offline" });
          dropClaim("Ava is not running in this thread, so the message was not sent. It is still in the composer.");
          return;
        }
        try {
          await ipc.chatRpcAttach({
            repoPath: repo,
            id,
            attachId,
            streamToken: 1,
            onLine: (line) => {
              if (cancelled) return;
              const value = parseChatLine(line);
              updateTranscript((current) => applyChatValue(current, value));
              for (const [commandId, awaiting] of entry.verdicts) {
                const refused = matchingSendFailure(value, commandId);
                if (refused !== null) {
                  awaiting.refused = true;
                  entry.verdicts.delete(commandId);
                  const draft = entry.draft;
                  const restore = draft.trim() === "" || draft === awaiting.text;
                  if (restore) {
                    entry.draft = awaiting.text;
                    registry.touch(entry);
                  }
                  updateTranscript((current) => settleRefusedSend(current, awaiting.entryId, awaiting.text, restore));
                  registry.setError(`Not sent: ${refused}`);
                  break;
                }
                if (matchingSendSuccess(value, commandId)) {
                  entry.verdicts.delete(commandId);
                  break;
                }
              }
              if (mcpListWait.current) {
                const listed = commandOutputText(value);
                if (listed !== null) {
                  mcpListWait.current = false;
                  const parsed = parseMcpListOutput(listed);
                  setMcpDialog(parsed === "empty" ? { rows: [], empty: true } : { rows: parsed, empty: false });
                }
              }
              const refresh = queueRefreshCommand(value);
              if (refresh) ipc.chatRpcWrite(repo, id, refresh).catch(() => {});
            },
          });
          if (cancelled) {
            ipc.chatDetach(repo, id, attachId).catch(() => {});
            return;
          }
          for (const command of attachHandshake(autoCompactionRef.current)) {
            await ipc.chatRpcWrite(repo, id, command);
          }
        } catch (cause) {
          if (cancelled) return;
          const detail = errorMessage(cause);
          const offline = detail === "unknown-session" || detail === "wrong-transport";
          setConnection(offline ? { state: "offline" } : { state: "failed", detail });
          dropClaim(offline ? "Ava is not running in this thread, so the message was not sent. It is still in the composer." : `Not sent: ${detail}`);
          return;
        }
        if (cancelled) return;
        setConnection({ state: "ready" });
        if (!claimed) return;
        try {
          await writeSend(claimed.text, sendCommand(claimed.text, false), (current) => applyPlainSend(current, claimed.text, false));
        } catch (cause) {
          if (!cancelled) dropClaim(`Not sent: ${errorMessage(cause)}`);
          return;
        }
        if (registry.pendingPrompt === claimed) registry.pendingPrompt = null;
        if (registry.sendingKey === key) registry.setSending(null);
      });
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      stopClosed();
      ipc.chatDetach(repo, id, attachId).catch(() => {});
    };
  }, [epoch, repo, id]);

  async function writeSend(text: string, command: { id: string; type: string }, addRow: (current: ChatTranscriptState) => { state: ChatTranscriptState; entryId: string }) {
    const verdict: Verdict = { text, entryId: null, refused: false };
    const judged = command.type === "prompt" || command.type === "follow_up" || command.type === "abort_and_prompt";
    if (judged) entry.verdicts.set(command.id, verdict);
    try {
      await ipc.chatRpcWrite(repo, id, command);
    } catch (cause) {
      entry.verdicts.delete(command.id);
      throw cause;
    }
    if (verdict.refused || !alive.current) return;
    updateTranscript((current) => {
      const added = addRow(current);
      verdict.entryId = added.entryId;
      return added.state;
    });
    if (entry.draft === text) {
      entry.draft = "";
      registry.touch(entry);
    }
  }

  async function send(who: symbol, override?: string) {
    const currentThread = entry.thread;
    if (!currentThread || registry.sendingKey === key) return;
    const text = override ?? entry.draft;
    if (!text.trim()) return;
    const sub = () => entry.subs.get(who);
    registry.setError("");
    if (currentThread.session.ended_at != null || currentThread.session.archived) {
      registry.setSending(key);
      try {
        const successor = await ipc.resumeChatThread(repo, id);
        const next = `${repo}:${successor.id}`;
        const refresh = sub()?.onResumeRefresh;
        const rebind = sub()?.onRebind;
        // Checked before the list refresh: that refresh drops the ended row, and flushing it
        // re-renders with nothing selected. The user's selection has not moved.
        if (!sub()?.isFocused()) {
          registry.setSending(null);
          return;
        }
        registry.moveDraft(key, next, text);
        registry.pendingPrompt = { key: next, text };
        registry.setSending(next);
        await refresh?.();
        rebind?.(next);
      } catch (cause) {
        registry.setSending(null);
        registry.setError(errorMessage(cause));
      }
      return;
    }
    if (currentThread.session.started_at == null) {
      registry.setSending(key);
      try {
        const started = await ipc.startChatThread(repo, id);
        if (started.start === "failed") {
          registry.setSending(null);
          registry.setError(started.errors?.[0]?.message ?? "start failed");
          return;
        }
        await sub()?.onReload();
        if (!sub()?.isFocused()) {
          registry.setSending(null);
          return;
        }
        registry.pendingPrompt = { key, text };
        setEpoch((value) => value + 1);
      } catch (cause) {
        registry.setSending(null);
        registry.setError(errorMessage(cause));
      }
      return;
    }
    if (connection.state !== "ready") {
      registry.setError(
        connection.state === "failed" ? "Not connected to Ava, so nothing was sent. Reconnect, then send again." : "Still connecting to Ava. Send again in a moment.",
      );
      return;
    }
    const busy = activity.turnActive;
    const plan = planChatSend(text, transcript.commands, busy);
    const dispatch = plan.dispatch;
    if (dispatch.kind === "open-providers") {
      if (entry.draft === text) {
        entry.draft = "";
        registry.touch(entry);
      }
      setProvidersDialog({ tab: dispatch.tab, preselect: dispatch.args });
      return;
    }
    if (dispatch.kind === "hatch") {
      updateTranscript((current) => applySendPlan(current, text, plan).state);
      if (entry.draft === text) {
        entry.draft = "";
        registry.touch(entry);
      }
      return;
    }
    const command =
      dispatch.kind === "compact"
        ? compactCommand(dispatch.customInstructions)
        : dispatch.kind === "get-tools"
          ? getStateCommand()
          : dispatch.kind === "mcp-list"
            ? promptCommand("/mcp list")
            : sendCommand(text, busy);
    if (dispatch.kind === "mcp-list") mcpListWait.current = true;
    registry.setSending(key);
    try {
      await writeSend(text, command, (current) => applySendPlan(current, text, plan));
      if (dispatch.kind === "get-tools") setToolsOpen(true);
    } catch (cause) {
      if (dispatch.kind === "mcp-list") mcpListWait.current = false;
      registry.setError(errorMessage(cause));
    } finally {
      if (registry.sendingKey === key) registry.setSending(null);
    }
  }

  async function sendNow(who: symbol) {
    void who;
    const text = entry.draft;
    if (!text.trim()) return;
    registry.setError("");
    try {
      await writeSend(text, sendNowCommand(text), (current) => {
        const state = appendOptimisticUser(current, text, "prompt");
        return { state, entryId: state.entries[state.entries.length - 1]?.id ?? "" };
      });
    } catch (cause) {
      registry.setError(errorMessage(cause));
    }
  }

  function abort() {
    updateTranscript((current) => appendOptimisticAbort(current));
    ipc.chatRpcWrite(repo, id, abortTurnCommand()).catch((cause: unknown) => registry.setError(String(cause)));
  }

  const activity = chatActivity(observation, transcript);
  const processLive = observation?.state?.process.state === "alive";
  const ui = useChatUiReplies({
    repo,
    id,
    live: processLive,
    transcript,
    setTranscript: updateTranscript,
    onError: (message) => registry.setError(message),
  });
  const inTerminal = processLive && observation?.transport === "pty";
  const terminalIo = useMemo(() => chatTerminalIo(repo, id), [repo, id]);
  const agentState = observation?.state?.agent?.state;
  const pendingUiReply = transcript.pendingUi.some((request) => needsUiReply(request.method));
  const sendNowEnabled =
    connection.state === "ready" &&
    activity.status === "running" &&
    agentState !== "waiting_for_input" &&
    agentState !== "waiting_for_approval" &&
    !pendingUiReply &&
    entry.draft.trim().length > 0;

  const olderBusy = useRef(false);
  const loadOlder = useCallback(() => {
    const from = transcriptRef.current.fileStart;
    if (olderBusy.current || from == null || from === 0) return;
    olderBusy.current = true;
    setLoadingOlder(true);
    ipc
      .readChatOmp({ repoPath: repo, id, end: from })
      .then((buffer) => {
        if (alive.current) updateTranscript((current) => olderPageState(current, buffer));
      })
      .catch(() => undefined)
      .finally(() => {
        olderBusy.current = false;
        if (alive.current) setLoadingOlder(false);
      });
  }, [repo, id, updateTranscript]);

  useEffect(() => {
    if (!processLive) return;
    const pushed = `${key}:${autoCompaction}`;
    if (compactionPushed.current === pushed) return;
    compactionPushed.current = pushed;
    ipc.chatRpcWrite(repo, id, setAutoCompactionCommand(autoCompaction)).catch(() => {});
  }, [autoCompaction, processLive, repo, id, key]);

  entry.api = {
    send: (who, override) => {
      void send(who, override);
    },
    sendNow: (who) => {
      void sendNow(who);
    },
    abort,
    reconnect: () => setEpoch((value) => value + 1),
    loadOlder,
    setObserved: (value) => setObservation(value),
    setDraft: (value) => {
      entry.draft = value;
      registry.touch(entry);
    },
    setProvidersDialog,
    setToolsOpen,
    setMcpDialog,
    approve: ui.approve,
    reply: ui.reply,
    cancelUi: ui.cancel,
  };

  const view: ChatThreadSnapshot = {
    transcript,
    observation,
    connection,
    activity,
    draft: entry.draft,
    sending: registry.sendingKey === key,
    error: registry.error,
    loadingOlder,
    processLive,
    inTerminal,
    terminalIo,
    statusKind: activity.kind,
    contextUsage: formatContextUsage(transcript.sessionMeta.contextUsage?.tokens, transcript.sessionMeta.contextUsage?.contextWindow),
    modelLabel: transcript.sessionMeta.model || thread.session.model || "Model",
    blocked: registry.error === "cannot continue",
    disconnected: connection.state === "failed" && !inTerminal ? connection.detail : null,
    sendNowEnabled,
    prompt: ui.prompt,
    providersDialog,
    toolsOpen,
    mcpDialog,
  };

  useLayoutEffect(() => {
    entry.snapshot = {
      ...view,
      draft: entry.draft,
      sending: registry.sendingKey === key,
      error: registry.error,
    };
    for (const listener of entry.listeners) listener();
  });

  return (
    <>
      {providersDialog ? (
        <ProviderSetupDialog
          mode="manual"
          initialTab={providersDialog.tab}
          preselect={providersDialog.preselect}
          onPick={(model) => {
            const slash = model.indexOf("/");
            ipc.chatRpcWrite(repo, id, applyModelCommand(model.slice(0, slash), model.slice(slash + 1))).catch((cause: unknown) => registry.setError(String(cause)));
          }}
          onClose={() => setProvidersDialog(null)}
        />
      ) : null}
      {toolsOpen ? <ChatToolsDialog tools={transcript.sessionMeta.dumpTools ?? []} onClose={() => setToolsOpen(false)} /> : null}
      {mcpDialog ? (
        <ChatMcpDialog
          rows={mcpDialog.rows}
          empty={mcpDialog.empty}
          onPrompt={(message) => {
            setMcpDialog(null);
            const who = entry.subs.keys().next().value;
            if (who) void send(who, message);
          }}
          onClose={() => setMcpDialog(null)}
        />
      ) : null}
    </>
  );
}
