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
import { IdleDot, RunningIndicator } from "../Indicators";
import * as ipc from "../ipc";
import { NameEditor } from "../NameEditor";
import { setAutoCompactionCommand } from "../ompRpc";
import { SessionTerminal } from "../SessionTerminal";
import { type ObservationDisplayKind, observationDisplayKind } from "../sessionAttention";
import { isTurnActive, OMP_INTERRUPT_DATA } from "../sessionMessage";
import { Checkbox, Dialog, obsLabel } from "../shared";
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

function repoBase(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
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

/**
 * Busy comes from the turn itself (live transcript first, then the observation poll), the same
 * predicate task sessions use. A booting OMP (process up, agent not yet `ready`) has no turn, so a
 * new thread reads Idle rather than Loading/Working.
 */
function chatActivity(observation: SessionObservation | null, transcript: ChatTranscriptState): { status: SessionChatStatus; turnActive: boolean; kind: ObservationDisplayKind } {
  const raw = observation ? observationDisplayKind(observation) : "idle";
  // OMP that died mid-turn never sends turn_end, and the daemon keeps its last agent state: neither is a running turn.
  const exited = observation?.state ? observation.state.process.state === "exited" : raw === "exited";
  const turnActive = !exited && isTurnActive({ pendingTurn: transcript.pendingTurn, turnOpen: transcript.turnOpen, agentState: observation?.state?.agent?.state });
  const status: SessionChatStatus = raw === "waiting_for_approval" ? "waiting_approval" : turnActive ? "running" : "idle";
  const quiet = raw === "loading" || raw === "starting" || raw === "idle";
  const kind: ObservationDisplayKind = quiet ? (turnActive ? "busy" : "idle") : raw;
  return { status, turnActive, kind };
}

/** `session_list_statuses` keys a root session as `repo::id` (empty task slug). */
function railKey(thread: ChatThread): string {
  return `${thread.repo_path}::${thread.session.id}`;
}

/** The rail shows the orb while a turn runs and a green dot while OMP is up and waiting; nothing once it has exited. */
function railState(observation: SessionObservation | null | undefined, turnActive: boolean): "working" | "idle" | null {
  const process = observation?.state?.process.state;
  if (process !== "alive" && process !== "starting") return null;
  return turnActive ? "working" : "idle";
}

function interruptedWithoutJournal(thread: ChatThread, transcript: ChatTranscriptState): boolean {
  return thread.session.ended_at != null && thread.session.harness_resume_token.length === 0 && transcript.entries.length === 0;
}

export function ChatView({ knownRepos, terminalFontSize, visibility }: { knownRepos: string[]; terminalFontSize: number; visibility: ChatPrefs }) {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(() => window.innerWidth <= 900);
  const [creating, setCreating] = useState(false);
  const [repoPath, setRepoPath] = useState(knownRepos.find((path) => path.length > 0) ?? "");
  const [createWorktree, setCreateWorktree] = useState(false);
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [observation, setObservation] = useState<SessionObservation | null>(null);
  const [transcript, setTranscript] = useState<ChatTranscriptState>(emptyTranscript());
  const [renaming, setRenaming] = useState(false);
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(() => new Set());
  const [modelOpen, setModelOpen] = useState(false);
  const [railObservations, setRailObservations] = useState<Record<string, SessionObservation>>({});
  const pendingPrompt = useRef<string | null>(null);
  // A fresh attach id per run: a re-run for the same thread (back from Terminal) must not let the
  // previous run's fire-and-forget detach drop the new attach, which shares the daemon's id space.
  const attachSeq = useRef(0);
  const selectionRef = useRef("");
  const [attachEpoch, setAttachEpoch] = useState(0);
  const [hatchBusy, setHatchBusy] = useState(false);
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

  const selected = useMemo(() => threads.find((thread) => `${thread.repo_path}:${thread.session.id}` === selectedKey) ?? null, [threads, selectedKey]);

  const selectedId = selected?.session.id;
  const selectedRepo = selected?.repo_path;
  useEffect(() => {
    setObservation(null);
    if (!selected || !selectedRepo || !selectedId) {
      setTranscript(emptyTranscript());
      return;
    }
    const repo = selectedRepo;
    const id = selectedId;
    selectionRef.current = `${repo}:${id}`;
    compactionPushed.current = `${repo}:${id}:${autoCompactionRef.current}`;
    const attachId = ++attachSeq.current;
    // A send that resumed this thread: its row and turn claim belong on the journal loaded below.
    const resumed = pendingPrompt.current;
    let cancelled = false;
    setRenaming(false);
    setModelOpen(false);
    setError((current) => (current === "cannot continue" ? "" : current));
    // Polled like a task session's status: OMP's `ready` and every turn end land after this runs.
    // A failed read keeps the last observation; null would read Idle mid-turn.
    const observe = () => {
      ipc
        .chatSessionStatus(repo, id)
        .then((next) => {
          if (!cancelled) setObservation(next);
        })
        .catch(() => {});
    };
    observe();
    const timer = window.setInterval(observe, 1500);
    // Attach only once the journal is in, as task sessions do: the handshake replies (commands,
    // state, models) must land on the journal-built transcript, not be replaced by it.
    ipc
      .readChatOmp({ repoPath: repo, id })
      .then(
        (buffer) => {
          if (cancelled) return;
          const next = journalState(buffer);
          setTranscript(resumed ? applyPlainSend(next, resumed, false) : next);
          if (interruptedWithoutJournal(selected, next)) setError("cannot continue");
        },
        () => {
          if (cancelled) return;
          setTranscript(resumed ? applyPlainSend(emptyTranscript(), resumed, false) : emptyTranscript());
          if (selected.session.ended_at != null && selected.session.harness_resume_token.length === 0) setError("cannot continue");
        },
      )
      .then(async () => {
        if (cancelled) return;
        await ipc.chatRpcAttach({
          repoPath: repo,
          id,
          attachId,
          streamToken: 1,
          onLine: (line) => {
            if (cancelled) return;
            const value = parseChatLine(line);
            setTranscript((current) => applyChatValue(current, value));
            const refresh = queueRefreshCommand(value);
            if (refresh) ipc.chatRpcWrite(repo, id, refresh).catch(() => {});
          },
        });
        if (cancelled) return;
        for (const command of attachHandshake(autoCompactionRef.current)) {
          await ipc.chatRpcWrite(repo, id, command);
        }
        if (!resumed || cancelled) return;
        pendingPrompt.current = null;
        await ipc.chatRpcWrite(repo, id, sendCommand(resumed, false));
      })
      .catch((cause: unknown) => {
        if (!resumed || cancelled) return;
        pendingPrompt.current = null;
        setTranscript((current) => ({ ...current, pendingTurn: false }));
        setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      ipc.chatDetach(repo, id, attachId).catch(() => {});
    };
  }, [selectedId, selectedRepo, attachEpoch]);

  const activity = chatActivity(observation, transcript);
  // OMP titles a thread a few seconds after a turn ends (the first message, then every 10th), so the
  // rail and title bar pick the new name up from the list once the turn has settled.
  const turnWasActive = useRef(false);
  useEffect(() => {
    if (activity.turnActive) {
      turnWasActive.current = true;
      return;
    }
    if (!turnWasActive.current) return;
    turnWasActive.current = false;
    const timers = [3000, 9000].map((delay) => window.setTimeout(() => void reload().catch(() => {}), delay));
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [activity.turnActive]);
  const statusKind = activity.kind;
  const processLive = observation?.state?.process.state === "alive";
  const uiReplies = useChatUiReplies({
    repo: selectedRepo ?? null,
    id: selectedId ?? null,
    live: processLive,
    transcript,
    setTranscript,
    onError: setError,
  });
  const uiPrompt = uiReplies.prompt;
  const pendingUiReply = transcript.pendingUi.some((request) => needsUiReply(request.method));
  const agentState = observation?.state?.agent?.state;
  const sendNowEnabled = activity.status === "running" && agentState !== "waiting_for_input" && agentState !== "waiting_for_approval" && !pendingUiReply && body.trim().length > 0;

  // Older rows come off the journal on demand, as in a task session. A page that lands after the
  // reader moved to another thread is dropped.
  const olderBusy = useRef(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;
  const loadOlder = useCallback(() => {
    const from = transcriptRef.current.fileStart;
    if (olderBusy.current || from == null || from === 0 || !selectedRepo || !selectedId) return;
    olderBusy.current = true;
    setLoadingOlder(true);
    ipc
      .readChatOmp({ repoPath: selectedRepo, id: selectedId, end: from })
      .then((buffer) => {
        if (selectionRef.current === `${selectedRepo}:${selectedId}`) setTranscript((current) => olderPageState(current, buffer));
      })
      .catch(() => undefined)
      .finally(() => {
        olderBusy.current = false;
        setLoadingOlder(false);
      });
  }, [selectedRepo, selectedId]);
  // The handshake pushes the setting on every attach; `compactionPushed` keeps the effect below to
  // real toggles instead of repeating it when the poll first reports the process alive.
  const autoCompactionRef = useRef(visibility.autoCompaction);
  autoCompactionRef.current = visibility.autoCompaction;
  const compactionPushed = useRef("");
  const selectedRepoPath = selected?.repo_path;
  const selectedSessionId = selected?.session.id;
  useEffect(() => {
    if (!processLive || !selectedRepoPath || !selectedSessionId) return;
    const key = `${selectedRepoPath}:${selectedSessionId}:${visibility.autoCompaction}`;
    if (compactionPushed.current === key) return;
    compactionPushed.current = key;
    ipc.chatRpcWrite(selectedRepoPath, selectedSessionId, setAutoCompactionCommand(visibility.autoCompaction)).catch(() => {});
  }, [visibility.autoCompaction, processLive, selectedRepoPath, selectedSessionId]);
  const inTerminal = processLive && observation?.transport === "pty";
  const terminalIo = useMemo(() => (selectedRepo && selectedId ? chatTerminalIo(selectedRepo, selectedId) : undefined), [selectedRepo, selectedId]);

  /**
   * The escape hatch: restart this thread's OMP on the same journal in its terminal UI, or back
   * into chat. Click-only, never automatic — it replaces the live process.
   */
  async function hatch() {
    if (!selected || hatchBusy) return;
    const repo = selected.repo_path;
    const id = selected.session.id;
    const target = inTerminal ? "rpc" : "pty";
    setError("");
    try {
      if (activity.turnActive) {
        if (!(await confirmStopAndSwitch(target))) return;
        await (inTerminal ? ipc.chatPtyWrite(repo, id, OMP_INTERRUPT_DATA) : ipc.chatRpcWrite(repo, id, abortTurnCommand())).catch(() => {});
      }
      setHatchBusy(true);
      await ipc.chatRestate(repo, id, target);
      setObservation(await ipc.chatSessionStatus(repo, id));
      // Back in chat: re-read the journal (turns typed in the terminal) and reattach RPC.
      if (target === "rpc") setAttachEpoch((epoch) => epoch + 1);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setHatchBusy(false);
    }
  }

  async function archiveSelected() {
    if (!selected) return;
    const repo = selected.repo_path;
    const id = selected.session.id;
    const base = repoBase(repo);
    setError("");
    try {
      if (selected.checkout) {
        const accepted = await confirmDanger(
          "Archive chat",
          `This stops the live Ava process for ${base} if it is running. The conversation is kept and can be resumed. The repository checkout is not deleted.`,
          "Archive",
        );
        if (!accepted) return;
        await ipc.archiveChatThread(repo, id, false);
      } else {
        const choice = await askConfirm({
          title: "Archive chat",
          cancelKey: "cancel",
          defaultKey: "archive",
          body: `This stops the live Ava process for ${base} if it is running. The conversation is kept and can be resumed either way. Worktree: ${selected.session.worktree}. Archive keeps the worktree. Archive and remove worktree runs git worktree remove --force and discards uncommitted work in that worktree only. After remove, resume opens in the repository checkout on the branch checked out at resume time, not on the deleted worktree's branch.`,
          choices: [
            { key: "archive", label: "Archive" },
            { key: "remove", label: "Archive and remove worktree", tone: "danger" },
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

  async function removeWorktree() {
    if (!selected || selected.checkout) return;
    setError("");
    try {
      const accepted = await confirmDanger("Remove worktree", `Remove ${selected.session.worktree}. Uncommitted work in that worktree is discarded.`, "Remove worktree");
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

  async function send() {
    if (!selected || !body.trim()) return;
    const text = body;
    setBody("");
    setError("");
    try {
      const repo = selected.repo_path;
      const id = selected.session.id;
      if (selected.session.ended_at != null || selected.session.archived) {
        const successor = await ipc.resumeChatThread(repo, id);
        const rows = await ipc.listChatThreads(false);
        setShowArchived(false);
        setThreads(rows);
        pendingPrompt.current = text;
        setSelectedKey(`${repo}:${successor.id}`);
        return;
      }
      if (selected.session.started_at == null) {
        const started = await ipc.startChatThread(repo, id);
        if (started.start === "failed") {
          setError(started.errors?.[0]?.message ?? "start failed");
          return;
        }
      }
      const busy = activity.turnActive;
      const plan = planChatSend(text, transcript.commands, busy);
      const dispatch = plan.dispatch;
      if (dispatch.kind === "open-providers" && dispatch.tab === "models") {
        setModelOpen(true);
        return;
      }
      if (dispatch.kind === "hatch" || dispatch.kind === "open-providers") {
        // Terminal-only in OMP: nothing to write over RPC. The notice points at the terminal button.
        const notice = dispatch.kind === "hatch" ? dispatch.reason : `/${text.slice(1).split(/\s+/)[0]} runs in OMP's terminal. Use the terminal button in the title bar.`;
        setTranscript((current) => applySendPlan(current, text, { ...plan, notice }).state);
        return;
      }
      setTranscript((current) => applySendPlan(current, text, plan).state);
      await ipc.chatRpcWrite(repo, id, sendCommand(text, busy));
    } catch (cause) {
      setTranscript((current) => ({ ...current, pendingTurn: false }));
      setError(errorMessage(cause));
    }
  }

  async function sendNow() {
    if (!selected || !body.trim()) return;
    const text = body;
    setError("");
    try {
      await ipc.chatRpcWrite(selected.repo_path, selected.session.id, sendNowCommand(text));
      // Only after the write lands, as task sessions do: a failed Send now keeps the draft and adds no row.
      setBody((current) => (current === text ? "" : current));
      setTranscript((current) => appendOptimisticUser(current, text, "prompt"));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  function abort() {
    if (!selected) return;
    setTranscript((current) => appendOptimisticAbort(current));
    ipc.chatRpcWrite(selected.repo_path, selected.session.id, abortTurnCommand()).catch((cause: unknown) => setError(String(cause)));
  }

  const modelLabel = transcript.sessionMeta.model || selected?.session.model || "Model";
  const blocked = error === "cannot continue";
  const groups = repoGroups(dirs, threads);

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
                      <span className="chat-repo-name">{repoBase(path)}</span>
                      <span className="chat-repo-count">{rows.length}</span>
                    </button>
                    <button
                      type="button"
                      className="chat-icon-btn chat-repo-add"
                      aria-label={`New thread in ${repoBase(path)}`}
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
                        const key = `${thread.repo_path}:${thread.session.id}`;
                        const polled = railObservations[railKey(thread)];
                        const state =
                          key === selectedKey
                            ? railState(observation ?? polled, activity.turnActive)
                            : railState(polled, isTurnActive({ agentState: polled?.state?.agent?.state }));
                        return (
                          <li key={key} className="chat-thread">
                            <button
                              type="button"
                              className="chat-thread-btn"
                              aria-current={key === selectedKey ? "true" : undefined}
                              data-archived={thread.session.archived ? "true" : undefined}
                              title={state === "working" ? "Working" : state === "idle" ? "Idle" : undefined}
                              onClick={() => setSelectedKey(key)}
                            >
                              <span className="chat-thread-state" aria-hidden="true">
                                {state === "working" ? <RunningIndicator /> : state === "idle" ? <IdleDot /> : null}
                              </span>
                              <span className="chat-thread-name">{threadLabel(thread)}</span>
                              {thread.session.pinned ? <Pin size={12} aria-hidden="true" className="chat-thread-pin" /> : null}
                            </button>
                            {showArchived && thread.session.archived ? (
                              <button type="button" className="btn ghost small chat-thread-resume" onClick={() => resume(thread)}>
                                Resume
                              </button>
                            ) : null}
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
                <span className="chat-meta-item">
                  <FolderGit2 size={13} aria-hidden="true" />
                  {repoBase(selected.repo_path)}
                </span>
                <span className="chat-meta-item">
                  <GitBranch size={13} aria-hidden="true" />
                  {selected.branch_label}
                  {selected.checkout ? <span className="chat-meta-tag">checkout</span> : <span className="chat-meta-tag">worktree</span>}
                </span>
                <span className="chat-state" data-kind={statusKind}>
                  <span className="chat-state-dot" aria-hidden="true" />
                  {obsLabel(statusKind)}
                </span>
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
                  onClick={() => {
                    ipc
                      .setChatPinned(selected.repo_path, selected.session.id, !selected.session.pinned)
                      .then(() => reload())
                      .catch((cause: unknown) => setError(String(cause)));
                  }}
                >
                  {selected.session.pinned ? <PinOff size={16} aria-hidden="true" /> : <Pin size={16} aria-hidden="true" />}
                </button>
                {selected.checkout ? null : (
                  <button type="button" className="chat-icon-btn" aria-label="Remove worktree" title="Remove worktree" onClick={() => void removeWorktree()}>
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
                <button type="button" className="chat-icon-btn" aria-label="Archive" title="Archive" onClick={archiveSelected}>
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
            showHints={visibility.showComposerHints}
            allowAttach={false}
            onBodyChange={setBody}
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
                      {repoBase(path)}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} aria-hidden="true" />
              </span>
            </label>
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
