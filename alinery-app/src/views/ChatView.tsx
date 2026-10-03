import {
  Archive,
  ChevronDown,
  ChevronRight,
  FolderGit2,
  GitBranch,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pin,
  PinOff,
  Plus,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatComposer } from "../ChatComposer";
import { applySendPlan, planChatSend } from "../chat/send";
import type { SessionChatStatus } from "../chat/types";
import type { ChatPrefs } from "../chat/visibility";
import { appendOptimisticAbort, appendOptimisticUser, type ChatTranscriptState, emptyTranscript, needsUiReply } from "../chatTranscript";
import { askConfirm, confirmDanger, confirmStopAndSwitch } from "../confirm";
import * as ipc from "../ipc";
import { NameEditor } from "../NameEditor";
import { setAutoCompactionCommand } from "../ompRpc";
import { SessionTerminal } from "../SessionTerminal";
import { type ObservationDisplayKind, observationDisplayKind } from "../sessionAttention";
import { isTurnActive, OMP_INTERRUPT_DATA } from "../sessionMessage";
import { Checkbox, Dialog, obsLabel, StatusMarker } from "../shared";
import type { ChatThread, SessionObservation } from "../types";
import { ChatExtensionPrompt } from "./ChatExtensionPrompt";
import { ChatModelDialog } from "./ChatModelDialog";
import { ChatPane } from "./ChatPane";
import {
  abortTurnCommand,
  applyChatValue,
  applyModelCommand,
  applyPlainSend,
  attachHandshake,
  chatTerminalIo,
  journalState,
  olderPageState,
  parseChatLine,
  queueRefreshCommand,
  sendCommand,
  sendNowCommand,
} from "./chatSession";
import { useChatUiReplies } from "./useChatUiReplies";

function threadLabel(thread: ChatThread): string {
  if (thread.name) return thread.name;
  return `Chat ${thread.session.id.slice(0, 8)}`;
}

function threadKey(thread: ChatThread): string {
  return `${thread.repo_path}:${thread.session.id}`;
}

/** The shortest path tail that tells this repo apart from every other one shown: `alinery`, or `work/alinery` beside `oss/alinery`. */
export function repoLabel(path: string, all: string[]): string {
  const parts = path.split("/").filter(Boolean);
  const others = all.filter((other) => other !== path).map((other) => other.split("/").filter(Boolean));
  for (let n = 1; n <= parts.length; n += 1) {
    const tail = parts.slice(-n).join("/");
    if (!others.some((other) => other.slice(-n).join("/") === tail)) return tail;
  }
  return path;
}

/** Threads under their repo, known repos first (empty ones too, so a thread can start there), pinned first within a repo. */
function repoGroups(repos: string[], threads: ChatThread[]): { path: string; rows: ChatThread[] }[] {
  const order = [...repos];
  for (const thread of threads) if (!order.includes(thread.repo_path)) order.push(thread.repo_path);
  return order.map((path) => ({
    path,
    rows: threads.filter((thread) => thread.repo_path === path).sort((a, b) => Number(Boolean(b.session.pinned)) - Number(Boolean(a.session.pinned))),
  }));
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const NO_TRANSCRIPT = emptyTranscript();

/** A value read for one thread. Shown only while that thread is the selected one, so nothing from A is visible or actionable once B is picked. */
type Keyed<T> = { key: string; value: T };

/**
 * The RPC link to the selected thread's OMP. `offline` is a thread with no process to talk to
 * (never started, exited, or in its terminal): its history is readable and that is not an error.
 */
type Link = { state: "connecting" } | { state: "ready" } | { state: "offline" } | { state: "failed"; detail: string };

/**
 * Busy comes from the turn itself (live transcript first, then the observation poll), the same
 * predicate task sessions use, and decides whether a send queues. The displayed kind is the observed
 * one; the transcript only moves it to Running in the gap before the poll sees the turn, and a
 * booting OMP (process up, agent not yet `ready`) has no turn, so a new thread reads Idle.
 */
function chatActivity(observation: SessionObservation | null, transcript: ChatTranscriptState): { status: SessionChatStatus; turnActive: boolean; kind: ObservationDisplayKind } {
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

/** `session_list_statuses` keys a root session as `repo::id` (empty task slug). */
function railKey(thread: ChatThread): string {
  return `${thread.repo_path}::${thread.session.id}`;
}

/** An unselected row reads the same as the title bar, from its observation alone; an ended thread is not polled and reads Exited. */
function railKind(thread: ChatThread, polled: SessionObservation | undefined): ObservationDisplayKind {
  if (polled) return chatActivity(polled, NO_TRANSCRIPT).kind;
  return thread.session.ended_at != null || thread.session.started_at == null ? "exited" : "loading";
}

/** Whether archiving would stop a process. Unknown (not polled yet) counts as running, so the dialog never under-discloses. */
function mayBeRunning(thread: ChatThread, observation: SessionObservation | undefined | null): boolean {
  const process = observation?.state?.process.state;
  if (process) return process === "alive" || process === "starting";
  return thread.session.started_at != null && thread.session.ended_at == null;
}

function interruptedWithoutJournal(thread: ChatThread, transcript: ChatTranscriptState): boolean {
  return thread.session.ended_at != null && thread.session.harness_resume_token.length === 0 && transcript.entries.length === 0;
}

/** Drops a thread's draft only if it is still the text that was sent: an edit made meanwhile stays. */
function clearDraft(key: string, text: string) {
  return (current: Record<string, string>) => {
    if (current[key] !== text) return current;
    const { [key]: _sent, ...rest } = current;
    return rest;
  };
}

const RESUME_IN_CHECKOUT = "The conversation is kept. Continuing it later opens in the repository checkout, on whatever branch is checked out then, not on this worktree's branch.";

export function ChatView({ active = true, knownRepos, terminalFontSize, visibility }: { active?: boolean; knownRepos: string[]; terminalFontSize: number; visibility: ChatPrefs }) {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(() => window.innerWidth <= 900);
  const [creating, setCreating] = useState(false);
  const [repoPath, setRepoPath] = useState(knownRepos.find((path) => path.length > 0) ?? "");
  const [createWorktree, setCreateWorktree] = useState(false);
  // Per thread, so a half-written message stays with the thread it was written for.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sendingKey, setSendingKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [observed, setObserved] = useState<Keyed<SessionObservation> | null>(null);
  const [loaded, setLoaded] = useState<Keyed<ChatTranscriptState> | null>(null);
  const [link, setLink] = useState<Keyed<Link> | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(() => new Set());
  const [modelOpen, setModelOpen] = useState(false);
  const [railObservations, setRailObservations] = useState<Record<string, SessionObservation>>({});
  // A send that had to start or resume its thread first. It is delivered after that thread's
  // handshake and only to that thread; selecting any other thread cancels it, and its text stays
  // in the thread's composer.
  const pendingPrompt = useRef<{ key: string; text: string } | null>(null);
  // A fresh attach id per run: a re-run for the same thread (back from Terminal) must not let the
  // previous run's fire-and-forget detach drop the new attach, which shares the daemon's id space.
  const attachSeq = useRef(0);
  const [attachEpoch, setAttachEpoch] = useState(0);
  const [hatchBusy, setHatchBusy] = useState(false);
  // Hidden behind another tab the view stays mounted; its pollers skip their ticks.
  const activeRef = useRef(active);
  activeRef.current = active;
  const selectedKeyRef = useRef(selectedKey);
  selectedKeyRef.current = selectedKey;
  const dirs = knownRepos.filter((path) => path.length > 0);

  const reload = async (archived = showArchived) => {
    const rows = await ipc.listChatThreads(archived);
    setThreads(rows);
    return rows;
  };

  useEffect(() => {
    let cancelled = false;
    ipc
      .listChatThreads(false)
      .then((rows) => {
        if (!cancelled) setThreads(rows);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // One batched read for every live thread in the rail, not a poller per row. The selected thread
  // also has its own 1.5s poll and live transcript, which the rail prefers for that row.
  const liveRefs = useMemo(
    () =>
      threads
        .filter((thread) => !thread.session.archived && thread.session.ended_at == null)
        .map((thread) => ({ repo_path: thread.repo_path, task_slug: "", id: thread.session.id })),
    [threads],
  );
  useEffect(() => {
    if (liveRefs.length === 0) return;
    let cancelled = false;
    const poll = () => {
      if (!activeRef.current) return;
      ipc
        .sessionListStatuses(liveRefs)
        .then((next) => {
          if (!cancelled) setRailObservations(next);
        })
        .catch(() => {});
    };
    poll();
    const timer = window.setInterval(poll, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [liveRefs]);

  const selected = useMemo(() => threads.find((thread) => threadKey(thread) === selectedKey) ?? null, [threads, selectedKey]);
  const selectionKey = selected ? threadKey(selected) : null;
  const transcript = loaded && loaded.key === selectionKey ? loaded.value : NO_TRANSCRIPT;
  const observation = observed && observed.key === selectionKey ? observed.value : null;
  const connection: Link = link && link.key === selectionKey ? link.value : { state: "connecting" };
  /** Applies only while `key`'s transcript is the loaded one: a reply that lands after a switch is dropped. */
  const updateTranscript = useCallback((key: string, update: (current: ChatTranscriptState) => ChatTranscriptState) => {
    setLoaded((current) => (current?.key === key ? { key, value: update(current.value) } : current));
  }, []);

  // The handshake pushes the setting on every attach; `compactionPushed` keeps the effect below to
  // real toggles instead of repeating it when the poll first reports the process alive.
  const autoCompactionRef = useRef(visibility.autoCompaction);
  autoCompactionRef.current = visibility.autoCompaction;
  const compactionPushed = useRef("");
  const turnWasActive = useRef(false);

  const selectedId = selected?.session.id;
  const selectedRepo = selected?.repo_path;
  useEffect(() => {
    if (!selected || !selectedRepo || !selectedId) return;
    const repo = selectedRepo;
    const id = selectedId;
    const key = `${repo}:${id}`;
    compactionPushed.current = `${key}:${autoCompactionRef.current}`;
    turnWasActive.current = false;
    const attachId = ++attachSeq.current;
    if (pendingPrompt.current && pendingPrompt.current.key !== key) {
      pendingPrompt.current = null;
      setSendingKey(null);
    }
    const claimed = pendingPrompt.current;
    let cancelled = false;
    setRenaming(false);
    setModelOpen(false);
    setError((current) => (current === "cannot continue" ? "" : current));
    setLink({ key, value: { state: "connecting" } });
    // Polled like a task session's status: OMP's `ready` and every turn end land after this runs.
    // A failed read keeps the last observation; null would read Loading mid-turn.
    const observe = () => {
      if (!activeRef.current) return;
      ipc
        .chatSessionStatus(repo, id)
        .then((next) => {
          if (!cancelled) setObserved({ key, value: next });
        })
        .catch(() => {});
    };
    observe();
    const timer = window.setInterval(observe, 1500);
    const dropClaim = (message: string) => {
      if (!claimed || pendingPrompt.current !== claimed) return;
      pendingPrompt.current = null;
      setSendingKey(null);
      setError(message);
    };
    // Attach only once the journal is in, as task sessions do: the handshake replies (commands,
    // state, models) must land on the journal-built transcript, not be replaced by it.
    ipc
      .readChatOmp({ repoPath: repo, id })
      .then(
        (buffer) => {
          if (cancelled) return;
          const next = journalState(buffer);
          setLoaded({ key, value: next });
          if (interruptedWithoutJournal(selected, next)) setError("cannot continue");
        },
        () => {
          if (cancelled) return;
          setLoaded({ key, value: emptyTranscript() });
          if (selected.session.ended_at != null && selected.session.harness_resume_token.length === 0) setError("cannot continue");
        },
      )
      .then(async () => {
        if (cancelled) return;
        // Never started, ended or archived: there is no process, only history. Not a broken link.
        if (selected.session.started_at == null || selected.session.ended_at != null || selected.session.archived) {
          setLink({ key, value: { state: "offline" } });
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
              updateTranscript(key, (current) => applyChatValue(current, value));
              const refresh = queueRefreshCommand(value);
              if (refresh) ipc.chatRpcWrite(repo, id, refresh).catch(() => {});
            },
          });
          if (cancelled) return;
          for (const command of attachHandshake(autoCompactionRef.current)) {
            await ipc.chatRpcWrite(repo, id, command);
          }
        } catch (cause) {
          if (cancelled) return;
          const detail = errorMessage(cause);
          const offline = detail === "unknown-session" || detail === "wrong-transport";
          setLink({ key, value: offline ? { state: "offline" } : { state: "failed", detail } });
          dropClaim(offline ? "Ava is not running in this thread, so the message was not sent. It is still in the composer." : `Not sent: ${detail}`);
          return;
        }
        if (cancelled) return;
        setLink({ key, value: { state: "ready" } });
        if (!claimed) return;
        try {
          await ipc.chatRpcWrite(repo, id, sendCommand(claimed.text, false));
        } catch (cause) {
          if (!cancelled) dropClaim(`Not sent: ${errorMessage(cause)}`);
          return;
        }
        if (pendingPrompt.current === claimed) pendingPrompt.current = null;
        setSendingKey((current) => (current === key ? null : current));
        updateTranscript(key, (current) => applyPlainSend(current, claimed.text, false));
        setDrafts(clearDraft(key, claimed.text));
      });
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      ipc.chatDetach(repo, id, attachId).catch(() => {});
    };
  }, [selectedId, selectedRepo, attachEpoch]);

  const activity = chatActivity(observation, transcript);
  // A thread is titled by its own model after a turn ends (the first message, then every 10th), and the
  // reply can take a while on a slow or thinking model. So the open thread's name is re-read every 3s
  // for up to a minute after each turn, and the list is reloaded once when it changes.
  useEffect(() => {
    if (activity.turnActive) {
      turnWasActive.current = true;
      return;
    }
    if (!turnWasActive.current || !selected) return;
    turnWasActive.current = false;
    const repo = selected.repo_path;
    const id = selected.session.id;
    const before = selected.name ?? null;
    let ticks = 0;
    const timer = window.setInterval(() => {
      if (!activeRef.current) return;
      ticks += 1;
      if (ticks > 20) {
        window.clearInterval(timer);
        return;
      }
      ipc
        .chatThreadName(repo, id)
        .then((name) => {
          if ((name ?? null) === before) return;
          window.clearInterval(timer);
          return reload();
        })
        .catch(() => {});
    }, 3000);
    return () => window.clearInterval(timer);
  }, [activity.turnActive]);
  const statusKind = activity.kind;
  const processLive = observation?.state?.process.state === "alive";
  const setSelectedTranscript = useCallback(
    (update: (current: ChatTranscriptState) => ChatTranscriptState) => {
      if (selectionKey) updateTranscript(selectionKey, update);
    },
    [selectionKey, updateTranscript],
  );
  const uiReplies = useChatUiReplies({
    repo: selectedRepo ?? null,
    id: selectedId ?? null,
    live: processLive,
    transcript,
    setTranscript: setSelectedTranscript,
    onError: setError,
  });
  const uiPrompt = uiReplies.prompt;
  const body = selectionKey ? (drafts[selectionKey] ?? "") : "";
  const sending = selectionKey !== null && sendingKey === selectionKey;
  const pendingUiReply = transcript.pendingUi.some((request) => needsUiReply(request.method));
  const agentState = observation?.state?.agent?.state;
  const sendNowEnabled =
    connection.state === "ready" &&
    activity.status === "running" &&
    agentState !== "waiting_for_input" &&
    agentState !== "waiting_for_approval" &&
    !pendingUiReply &&
    body.trim().length > 0;

  // Older rows come off the journal on demand, as in a task session. A page that lands after the
  // reader moved to another thread is dropped by the keyed update.
  const olderBusy = useRef(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;
  const loadOlder = useCallback(() => {
    const from = transcriptRef.current.fileStart;
    if (olderBusy.current || from == null || from === 0 || !selectedRepo || !selectedId) return;
    const key = `${selectedRepo}:${selectedId}`;
    olderBusy.current = true;
    setLoadingOlder(true);
    ipc
      .readChatOmp({ repoPath: selectedRepo, id: selectedId, end: from })
      .then((buffer) => updateTranscript(key, (current) => olderPageState(current, buffer)))
      .catch(() => undefined)
      .finally(() => {
        olderBusy.current = false;
        setLoadingOlder(false);
      });
  }, [selectedRepo, selectedId, updateTranscript]);
  useEffect(() => {
    if (!processLive || !selectedRepo || !selectedId) return;
    const key = `${selectedRepo}:${selectedId}:${visibility.autoCompaction}`;
    if (compactionPushed.current === key) return;
    compactionPushed.current = key;
    ipc.chatRpcWrite(selectedRepo, selectedId, setAutoCompactionCommand(visibility.autoCompaction)).catch(() => {});
  }, [visibility.autoCompaction, processLive, selectedRepo, selectedId]);
  const inTerminal = processLive && observation?.transport === "pty";
  const terminalIo = useMemo(() => (selectedRepo && selectedId ? chatTerminalIo(selectedRepo, selectedId) : undefined), [selectedRepo, selectedId]);

  /**
   * The escape hatch: restart this thread's OMP on the same journal in its terminal UI, or back
   * into chat. Click-only, never automatic — it replaces the live process.
   */
  async function hatch() {
    if (!selected || !selectionKey || hatchBusy) return;
    const repo = selected.repo_path;
    const id = selected.session.id;
    const key = selectionKey;
    const target = inTerminal ? "rpc" : "pty";
    setError("");
    try {
      if (activity.turnActive) {
        if (!(await confirmStopAndSwitch(target))) return;
        await (inTerminal ? ipc.chatPtyWrite(repo, id, OMP_INTERRUPT_DATA) : ipc.chatRpcWrite(repo, id, abortTurnCommand())).catch(() => {});
      }
      setHatchBusy(true);
      await ipc.chatRestate(repo, id, target);
      const next = await ipc.chatSessionStatus(repo, id);
      setObserved({ key, value: next });
      // Back in chat: re-read the journal (turns typed in the terminal) and reattach RPC.
      if (target === "rpc") setAttachEpoch((epoch) => epoch + 1);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setHatchBusy(false);
    }
  }

  const groups = repoGroups(dirs, threads);
  const repoPaths = groups.map((group) => group.path);
  const repoName = (path: string) => repoLabel(path, repoPaths);

  async function archiveThread(thread: ChatThread) {
    const repo = thread.repo_path;
    const id = thread.session.id;
    const running = mayBeRunning(thread, threadKey(thread) === selectionKey ? observation : railObservations[railKey(thread)]);
    const subject = `Archive “${threadLabel(thread)}” in ${repoName(repo)}.`;
    const stops = running ? " Its Ava process is still running, and archiving stops it." : "";
    setError("");
    try {
      if (thread.checkout) {
        const accepted = await confirmDanger(
          "Archive chat",
          `${subject}${stops} The conversation is kept and can be resumed. The repository checkout is not touched.`,
          running ? "Stop and archive" : "Archive",
        );
        if (!accepted) return;
        await ipc.archiveChatThread(repo, id, false);
      } else {
        const choice = await askConfirm({
          title: "Archive chat",
          cancelKey: "cancel",
          body: `${subject}${stops} The conversation is kept and can be resumed either way. Worktree: ${thread.session.worktree}. Archive keeps the worktree. Removing it runs git worktree remove --force and discards uncommitted work in that worktree only. ${RESUME_IN_CHECKOUT}`,
          choices: [
            { key: "archive", label: running ? "Stop and archive" : "Archive" },
            { key: "remove", label: running ? "Stop, archive and remove worktree" : "Archive and remove worktree", tone: "danger" },
            { key: "cancel", label: "Cancel", tone: "ghost" },
          ],
        });
        if (choice === "cancel") return;
        await ipc.archiveChatThread(repo, id, choice === "remove");
      }
      await reload();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  function togglePin(thread: ChatThread) {
    ipc
      .setChatPinned(thread.repo_path, thread.session.id, !thread.session.pinned)
      .then(() => reload())
      .catch((cause: unknown) => setError(String(cause)));
  }

  async function removeWorktree() {
    if (!selected || selected.checkout) return;
    setError("");
    try {
      const accepted = await confirmDanger(
        "Remove worktree",
        `Remove the worktree of “${threadLabel(selected)}” in ${repoName(selected.repo_path)}: ${selected.session.worktree}. git worktree remove --force discards uncommitted work in that worktree. ${RESUME_IN_CHECKOUT}`,
        "Remove worktree",
      );
      if (!accepted) return;
      await ipc.removeChatWorktree(selected.repo_path, selected.session.id);
      await reload();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function resume(thread: ChatThread) {
    setError("");
    try {
      const successor = await ipc.resumeChatThread(thread.repo_path, thread.session.id);
      setShowArchived(false);
      const rows = await ipc.listChatThreads(false);
      setThreads(rows);
      setSelectedKey(`${thread.repo_path}:${successor.id}`);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function createThread() {
    if (!repoPath) return;
    setError("");
    try {
      const reply = await ipc.createChatThread({ repoPath, createWorktree });
      setCreating(false);
      setCreateWorktree(false);
      await reload(false);
      setShowArchived(false);
      setSelectedKey(`${repoPath}:${reply.session.id}`);
      if (reply.start === "failed") setError(reply.errors?.[0]?.message ?? "start failed");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  /**
   * The draft stays in the composer until the write lands, so a failed send loses nothing. A thread
   * with no process is started or resumed first, and the text goes out after that thread's handshake.
   */
  async function send() {
    if (!selected || !selectionKey || sending) return;
    const key = selectionKey;
    const text = drafts[key] ?? "";
    if (!text.trim()) return;
    const repo = selected.repo_path;
    const id = selected.session.id;
    setError("");
    if (selected.session.ended_at != null || selected.session.archived) {
      setSendingKey(key);
      try {
        const successor = await ipc.resumeChatThread(repo, id);
        const next = `${repo}:${successor.id}`;
        // The text moves to the successor, the thread it now belongs to.
        setDrafts((current) => {
          const { [key]: moved, ...rest } = current;
          return { ...rest, [next]: moved ?? text };
        });
        const rows = await ipc.listChatThreads(false);
        setShowArchived(false);
        setThreads(rows);
        if (selectedKeyRef.current !== key) {
          // The reader moved on while it resumed: nothing is sent, and the text waits in the successor.
          setSendingKey(null);
          return;
        }
        pendingPrompt.current = { key: next, text };
        setSendingKey(next);
        setSelectedKey(next);
      } catch (cause) {
        setSendingKey(null);
        setError(errorMessage(cause));
      }
      return;
    }
    if (selected.session.started_at == null) {
      setSendingKey(key);
      try {
        const started = await ipc.startChatThread(repo, id);
        if (started.start === "failed") {
          setSendingKey(null);
          setError(started.errors?.[0]?.message ?? "start failed");
          return;
        }
        await reload();
        if (selectedKeyRef.current !== key) {
          setSendingKey(null);
          return;
        }
        pendingPrompt.current = { key, text };
        // The first attach found no process; this one runs the handshake and then delivers the text.
        setAttachEpoch((epoch) => epoch + 1);
      } catch (cause) {
        setSendingKey(null);
        setError(errorMessage(cause));
      }
      return;
    }
    if (connection.state !== "ready") {
      setError(connection.state === "failed" ? "Not connected to Ava, so nothing was sent. Reconnect, then send again." : "Still connecting to Ava. Send again in a moment.");
      return;
    }
    const busy = activity.turnActive;
    const plan = planChatSend(text, transcript.commands, busy);
    const dispatch = plan.dispatch;
    if (dispatch.kind === "open-providers" && dispatch.tab === "models") {
      setDrafts(clearDraft(key, text));
      setModelOpen(true);
      return;
    }
    if (dispatch.kind === "hatch" || dispatch.kind === "open-providers") {
      // Terminal-only in OMP: nothing to write over RPC. The notice points at the terminal button.
      const notice = dispatch.kind === "hatch" ? dispatch.reason : `/${text.slice(1).split(/\s+/)[0]} runs in OMP's terminal. Use the terminal button in the title bar.`;
      updateTranscript(key, (current) => applySendPlan(current, text, { ...plan, notice }).state);
      setDrafts(clearDraft(key, text));
      return;
    }
    setSendingKey(key);
    try {
      await ipc.chatRpcWrite(repo, id, sendCommand(text, busy));
      updateTranscript(key, (current) => applySendPlan(current, text, plan).state);
      setDrafts(clearDraft(key, text));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSendingKey((current) => (current === key ? null : current));
    }
  }

  async function sendNow() {
    if (!selected || !selectionKey || !body.trim()) return;
    const key = selectionKey;
    const text = body;
    setError("");
    try {
      await ipc.chatRpcWrite(selected.repo_path, selected.session.id, sendNowCommand(text));
      // Only after the write lands, as task sessions do: a failed Send now keeps the draft and adds no row.
      setDrafts(clearDraft(key, text));
      updateTranscript(key, (current) => appendOptimisticUser(current, text, "prompt"));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  function abort() {
    if (!selected || !selectionKey) return;
    updateTranscript(selectionKey, (current) => appendOptimisticAbort(current));
    ipc.chatRpcWrite(selected.repo_path, selected.session.id, abortTurnCommand()).catch((cause: unknown) => setError(String(cause)));
  }

  const modelLabel = transcript.sessionMeta.model || selected?.session.model || "Model";
  const blocked = error === "cannot continue";
  const disconnected = connection.state === "failed" && !inTerminal ? connection.detail : null;

  function startThreadIn(path: string) {
    setRepoPath(path);
    setCreating(true);
  }

  function toggleRepo(path: string) {
    setCollapsedRepos((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <div
      className="chat-view"
      data-testid="chat-view"
      data-rail={collapsed ? "closed" : "open"}
      data-link={selected ? connection.state : undefined}
      style={{ ["--chat-col-max" as string]: visibility.maxWidth === "none" ? "100%" : `${visibility.maxWidth}px` }}
    >
      {collapsed ? null : (
        <aside className="chat-rail" data-testid="chat-rail" aria-label="Threads">
          <div className="chat-rail-head">
            <span className="chat-rail-title">Threads</span>
            <div className="chat-rail-head-actions">
              <button type="button" className="btn small chat-new-btn" onClick={() => setCreating(true)}>
                <Plus size={14} aria-hidden="true" />
                New thread
              </button>
              <button type="button" className="chat-icon-btn" aria-label="Collapse threads" title="Collapse threads" onClick={() => setCollapsed(true)}>
                <PanelLeftClose size={16} aria-hidden="true" />
              </button>
            </div>
          </div>
          <div className="chat-rail-scroll">
            {groups.length === 0 ? <p className="chat-rail-empty">No repositories yet.</p> : null}
            {groups.map(({ path, rows }) => {
              const open = !collapsedRepos.has(path);
              return (
                <section key={path} className="chat-repo">
                  <div className="chat-repo-head">
                    <button type="button" className="chat-repo-toggle" aria-expanded={open} onClick={() => toggleRepo(path)} title={path}>
                      <ChevronRight size={14} aria-hidden="true" className="chat-repo-chevron" />
                      <FolderGit2 size={14} aria-hidden="true" />
                      <span className="chat-repo-name">{repoName(path)}</span>
                      <span className="chat-repo-count">{rows.length}</span>
                    </button>
                    <button
                      type="button"
                      className="chat-icon-btn chat-repo-add"
                      aria-label={`New thread in ${repoName(path)}`}
                      title="New thread here"
                      onClick={() => startThreadIn(path)}
                    >
                      <Plus size={14} aria-hidden="true" />
                    </button>
                  </div>
                  {open ? (
                    <ul className="chat-thread-list">
                      {rows.length === 0 ? <li className="chat-thread-none">No threads</li> : null}
                      {rows.map((thread) => {
                        const key = threadKey(thread);
                        const archived = Boolean(thread.session.archived);
                        const kind = key === selectionKey ? statusKind : railKind(thread, railObservations[railKey(thread)]);
                        return (
                          <li key={key} className="chat-thread">
                            <button
                              type="button"
                              className="chat-thread-btn"
                              aria-current={key === selectedKey ? "true" : undefined}
                              data-archived={archived ? "true" : undefined}
                              aria-label={archived ? threadLabel(thread) : `${threadLabel(thread)}, ${obsLabel(kind)}`}
                              onClick={() => setSelectedKey(key)}
                            >
                              <span className="chat-thread-name">{threadLabel(thread)}</span>
                              <span className="chat-thread-trail">
                                {thread.session.pinned ? <Pin size={12} aria-hidden="true" className="chat-thread-pin" /> : null}
                                {archived ? null : <StatusMarker kind={kind} />}
                              </span>
                            </button>
                            {showArchived && archived ? (
                              <button type="button" className="btn ghost small chat-thread-resume" onClick={() => resume(thread)}>
                                Resume
                              </button>
                            ) : (
                              <span className="chat-thread-actions">
                                <button
                                  type="button"
                                  className={`chat-icon-btn${thread.session.pinned ? " on" : ""}`}
                                  aria-label={`${thread.session.pinned ? "Unpin" : "Pin"} ${threadLabel(thread)}`}
                                  title={thread.session.pinned ? "Unpin" : "Pin"}
                                  onClick={() => togglePin(thread)}
                                >
                                  {thread.session.pinned ? <PinOff size={13} aria-hidden="true" /> : <Pin size={13} aria-hidden="true" />}
                                </button>
                                <button
                                  type="button"
                                  className="chat-icon-btn"
                                  aria-label={`Archive ${threadLabel(thread)}`}
                                  title="Archive"
                                  onClick={() => void archiveThread(thread)}
                                >
                                  <Archive size={13} aria-hidden="true" />
                                </button>
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </section>
              );
            })}
          </div>
          <div className="chat-rail-foot">
            <button
              type="button"
              className={`btn ghost small${showArchived ? " on" : ""}`}
              aria-pressed={showArchived}
              onClick={() => {
                const next = !showArchived;
                setShowArchived(next);
                ipc
                  .listChatThreads(next)
                  .then(setThreads)
                  .catch((cause: unknown) => setError(String(cause)));
              }}
            >
              {showArchived ? "Hide archived" : "Show archived"}
            </button>
          </div>
        </aside>
      )}
      <section className="chat-main">
        <header className="chat-titlebar">
          {collapsed ? (
            <button type="button" className="chat-icon-btn" aria-label="Show threads" title="Show threads" onClick={() => setCollapsed(false)}>
              <PanelLeftOpen size={16} aria-hidden="true" />
            </button>
          ) : null}
          <div className="chat-titlebar-identity">
            {selected && renaming ? (
              <NameEditor
                value={selected.name ?? ""}
                label="Thread name"
                onCancel={() => setRenaming(false)}
                onSave={async (name) => {
                  await ipc.renameSession({ repoPath: selected.repo_path, taskSlug: "", sessionId: selected.session.id, name });
                  setRenaming(false);
                  await reload();
                }}
              />
            ) : (
              <div className="chat-titlebar-name">
                <h1>{selected ? threadLabel(selected) : "Ava"}</h1>
                {selected ? (
                  <button type="button" className="chat-icon-btn" aria-label="Rename thread" title="Rename" onClick={() => setRenaming(true)}>
                    <Pencil size={14} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            )}
            {selected && !visibility.showMeta ? null : selected ? (
              <div className="chat-titlebar-meta">
                <span className="chat-meta-item" title={selected.repo_path}>
                  <FolderGit2 size={13} aria-hidden="true" />
                  {repoName(selected.repo_path)}
                </span>
                <span className="chat-meta-item">
                  <GitBranch size={13} aria-hidden="true" />
                  {selected.branch_label}
                  {selected.checkout ? <span className="chat-meta-tag">checkout</span> : <span className="chat-meta-tag">worktree</span>}
                </span>
                {disconnected !== null ? <StatusMarker kind="failed" label="Disconnected" title={disconnected} /> : <StatusMarker kind={statusKind} />}
              </div>
            ) : (
              <div className="chat-titlebar-meta">Pick a thread or start a new one.</div>
            )}
          </div>
          <div className="chat-titlebar-actions">
            {selected ? (
              <>
                {inTerminal ? null : (
                  <>
                    <button type="button" className="btn ghost small chat-model-btn" onClick={() => setModelOpen(true)} title="Change model">
                      <span className="chat-model-label">{modelLabel}</span>
                      <ChevronDown size={14} aria-hidden="true" />
                    </button>
                    <span className="chat-titlebar-sep" aria-hidden="true" />
                  </>
                )}
                <button
                  type="button"
                  className={`chat-icon-btn${selected.session.pinned ? " on" : ""}`}
                  aria-label={selected.session.pinned ? "Unpin" : "Pin"}
                  title={selected.session.pinned ? "Unpin" : "Pin"}
                  onClick={() => togglePin(selected)}
                >
                  {selected.session.pinned ? <PinOff size={16} aria-hidden="true" /> : <Pin size={16} aria-hidden="true" />}
                </button>
                {selected.checkout ? null : (
                  <button
                    type="button"
                    className="chat-icon-btn"
                    aria-label="Remove worktree"
                    title={processLive ? "Ava is running in this worktree. Archive the thread to remove it." : "Remove worktree"}
                    disabled={processLive}
                    onClick={() => void removeWorktree()}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                )}
                {processLive || hatchBusy ? (
                  <button
                    type="button"
                    className={`chat-icon-btn${inTerminal ? " on" : ""}`}
                    aria-pressed={inTerminal}
                    aria-label={inTerminal ? "Back to chat" : "Open in Terminal"}
                    title={inTerminal ? "Back to chat" : "Open in OMP terminal"}
                    disabled={hatchBusy}
                    onClick={() => void hatch()}
                  >
                    {inTerminal ? <MessageSquare size={16} aria-hidden="true" /> : <SquareTerminal size={16} aria-hidden="true" />}
                  </button>
                ) : null}
                <button type="button" className="chat-icon-btn" aria-label="Archive" title="Archive" onClick={() => void archiveThread(selected)}>
                  <Archive size={16} aria-hidden="true" />
                </button>
              </>
            ) : null}
          </div>
        </header>
        {selected && inTerminal ? (
          <div className="terminal-frame chat-terminal">
            <SessionTerminal
              key={selected.session.id}
              sessionId={selected.session.id}
              cwd={selected.session.worktree}
              taskSlug=""
              phase=""
              harness="omp"
              model=""
              intent="attach"
              terminalFontSize={terminalFontSize}
              io={terminalIo}
            />
          </div>
        ) : selected ? (
          <ChatPane
            entries={transcript.entries}
            status={activity.status}
            visibility={visibility}
            onApprove={uiReplies.approve}
            onLoadOlder={loadOlder}
            loadingOlder={loadingOlder}
            atStart={transcript.fileStart === 0}
          />
        ) : (
          <div className="chat-blank">
            <MessageSquare size={28} aria-hidden="true" />
            <p className="chat-blank-title">No thread selected</p>
            <p className="chat-blank-hint">Choose a thread on the left, or start one in a repository.</p>
          </div>
        )}
        {disconnected !== null ? (
          <div className="chat-banner" role="alert">
            <span>
              Lost the connection to Ava in this thread. Replies and approvals will not show until it reconnects. <span className="chat-banner-detail">{disconnected}</span>
            </span>
            <button type="button" className="btn small" onClick={() => setAttachEpoch((epoch) => epoch + 1)}>
              Reconnect
            </button>
          </div>
        ) : null}
        {error ? (
          <div className="chat-banner" role="alert">
            <span>{error}</span>
            {blocked ? (
              <button type="button" className="btn small" onClick={() => setCreating(true)}>
                New thread
              </button>
            ) : null}
          </div>
        ) : null}
        {!inTerminal && uiPrompt ? (
          <ChatExtensionPrompt request={uiPrompt} onSubmit={(value) => void uiReplies.reply(uiPrompt.id, value)} onCancel={() => void uiReplies.cancel(uiPrompt.id)} />
        ) : null}
        {inTerminal ? null : (
          <ChatComposer
            body={body}
            status={activity.status}
            catalog={transcript.commands}
            sending={sending}
            showHints={visibility.showComposerHints}
            allowAttach={false}
            onBodyChange={(next) => {
              if (selectionKey) setDrafts((current) => ({ ...current, [selectionKey]: next }));
            }}
            onSend={() => {
              void send();
            }}
            onAbort={abort}
            onSendNow={sendNowEnabled ? () => void sendNow() : undefined}
            sendNowEnabled={sendNowEnabled}
            queuedCount={transcript.sessionMeta.queuedMessageCount}
          />
        )}
      </section>
      {creating ? (
        <Dialog onClose={() => setCreating(false)} ariaLabel="New thread" className="chat-new-dialog">
          <div className="mh">
            <span className="mt">New thread</span>
            <button type="button" className="x" aria-label="Close" title="Close" onClick={() => setCreating(false)}>
              <X size={14} strokeWidth={1.5} aria-hidden="true" />
            </button>
          </div>
          <div className="mb chat-new-body">
            {dirs.length === 0 ? <p className="dsc">No repositories yet. Add one from the repo switcher first.</p> : null}
            <label className="chat-dialog-field">
              <span>Repository</span>
              <span className="chat-select">
                <select value={repoPath} onChange={(event) => setRepoPath(event.target.value)}>
                  {dirs.map((path) => (
                    <option key={path} value={path}>
                      {repoLabel(path, dirs)}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} aria-hidden="true" />
              </span>
            </label>
            {repoPath ? <p className="dsc chat-dialog-path">{repoPath}</p> : null}
            <Checkbox checked={createWorktree} onChange={setCreateWorktree} label="New worktree and branch" />
          </div>
          <div className="mfoot chat-new-foot">
            <button type="button" className="btn ghost" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button type="button" className="btn" onClick={() => void createThread()} disabled={!repoPath} data-autofocus>
              Create
            </button>
          </div>
        </Dialog>
      ) : null}
      {modelOpen && selected ? (
        <ChatModelDialog
          tab="models"
          models={transcript.sessionMeta.models ?? []}
          current={transcript.sessionMeta.model ?? selected.session.model}
          loginProviders={transcript.sessionMeta.loginProviders ?? []}
          modelRoles={{}}
          onTabChange={() => {}}
          onApplyModel={(provider, modelId) => {
            ipc.chatRpcWrite(selected.repo_path, selected.session.id, applyModelCommand(provider, modelId)).catch((cause: unknown) => setError(String(cause)));
            setModelOpen(false);
          }}
          onLogin={() => {}}
          onHatchTerminalLogin={() => {}}
          onAssignRole={() => {}}
          onClose={() => setModelOpen(false)}
        />
      ) : null}
    </div>
  );
}
