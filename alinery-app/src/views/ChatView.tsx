import {
  Archive,
  Brain,
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
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ChatComposer } from "../ChatComposer";
import { requireWritten } from "../chat/send";
import type { ChatPrefs } from "../chat/visibility";
import { emptyTranscript } from "../chatTranscript";
import { askConfirm, confirmDanger, confirmStopAndSwitch } from "../confirm";
import { ORB_STATE } from "../Indicators";
import * as ipc from "../ipc";
import { NameEditor } from "../NameEditor";
import { setThinkingLevelCommand } from "../ompRpc";
import { SessionTerminal } from "../SessionTerminal";
import type { ObservationDisplayKind } from "../sessionAttention";
import { OMP_INTERRUPT_DATA } from "../sessionMessage";
import { Checkbox, Dialog, InlineStatus, LoadingState, obsLabel, StatusMarker } from "../shared";
import { toast } from "../toast";
import type { ChatThread, SessionObservation } from "../types";
import { ChatExtensionPrompt } from "./ChatExtensionPrompt";
import { ChatPane } from "./ChatPane";
import { abortTurnCommand } from "./chatSession";
import { ChatSessionContext, ChatSessionProvider, chatActivity, errorMessage, threadKey, threadLabel, useChatRegistry, useChatThread } from "./chatThreadSession";
import { ThinkingSelect } from "./ThinkingSelect";

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

/**
 * Loading, a failed read, and nothing open each read differently: `repos` is null until a read
 * succeeds, and a failed refresh keeps the last list. The read gives no reason a repo is missing,
 * so the empty copy names none.
 */
function OpenReposNotice({ repos, error, className }: { repos: string[] | null; error: string; className: string }) {
  if (error) {
    return (
      <InlineStatus tone="error" detail={error}>
        {repos === null ? "Couldn't read which repositories are open in this window." : "Couldn't refresh which repositories are open in this window. Showing the last list read."}{" "}
        Retrying every few seconds.
      </InlineStatus>
    );
  }
  if (repos === null) return <LoadingState label="Loading repositories" state={ORB_STATE} />;
  if (repos.length > 0) return null;
  return <p className={className}>No repositories are currently available to Chat in this window. Open or check one in the repo switcher.</p>;
}

const NO_TRANSCRIPT = emptyTranscript();

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

const RESUME_IN_CHECKOUT = "The conversation is kept. Continuing it later opens in the repository checkout, on whatever branch is checked out then, not on this worktree's branch.";

function ChatViewBody({ active = true, terminalFontSize, visibility }: { active?: boolean; terminalFontSize: number; visibility: ChatPrefs }) {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(() => window.innerWidth <= 900);
  const [creating, setCreating] = useState(false);
  // null until the first read: the thread list waits for it rather than loading twice.
  const [openRepos, setOpenRepos] = useState<string[] | null>(null);
  const [reposError, setReposError] = useState("");
  const dirs = openRepos ?? [];
  const [pickedRepo, setRepoPath] = useState("");
  const [createWorktree, setCreateWorktree] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(() => new Set());
  const [railObservations, setRailObservations] = useState<Record<string, SessionObservation>>({});
  const [hatchBusy, setHatchBusy] = useState(false);
  // Hidden behind another tab the view stays mounted; its pollers skip their ticks.
  const activeRef = useRef(active);
  activeRef.current = active;
  const selectedKeyRef = useRef(selectedKey);
  selectedKeyRef.current = selectedKey;
  const showArchivedRef = useRef(showArchived);
  showArchivedRef.current = showArchived;
  const reposKey = openRepos?.join("\n");
  // An explicit pick (the select or a repo's "+") stays the target after its repo closes: the form
  // says so and will not create, rather than quietly retarget another repo. No pick follows the
  // first open repo.
  const repoPath = pickedRepo || (dirs[0] ?? "");
  const pickClosed = pickedRepo !== "" && !dirs.includes(pickedRepo);

  const reload = async (archived = showArchived) => {
    const rows = await ipc.listChatThreads(archived);
    setThreads(rows);
    return rows;
  };

  // Chat follows the app's open repos: a repo closed at the top level, held by another Alinery,
  // or without a connected daemon drops out with its threads. Polled while visible; the thread
  // list reloads only when that set changes.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const poll = () => {
      ipc
        .listChatRepos()
        .then((next) => {
          if (cancelled) return;
          setReposError("");
          setOpenRepos((prev) => (prev?.join("\n") === next.join("\n") ? prev : next));
        })
        .catch((cause: unknown) => {
          if (!cancelled) setReposError(errorMessage(cause));
        });
    };
    poll();
    const timer = window.setInterval(poll, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reposKey is the trigger; the open-repo set changed.
  useEffect(() => {
    if (reposKey === undefined) return;
    let cancelled = false;
    ipc
      .listChatThreads(showArchivedRef.current)
      .then((rows) => {
        if (!cancelled) setThreads(rows);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [reposKey]);

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
  const registry = useChatRegistry();
  useEffect(() => {
    const take = () => {
      const focus = registry.takeFocus();
      if (focus) setSelectedKey(focus);
    };
    take();
    return registry.listenFocus(take);
  }, [registry]);

  const commitThreads = (archived: boolean, resetArchived: boolean) =>
    ipc.listChatThreads(archived).then((rows) => {
      flushSync(() => {
        if (resetArchived) setShowArchived(false);
        setThreads(rows);
      });
    });

  const chat = useChatThread(selected, {
    active,
    autoCompaction: visibility.autoCompaction,
    isFocused: (key) => selectedKeyRef.current === key,
    onReload: () => commitThreads(showArchivedRef.current, false),
    onResumeRefresh: () => commitThreads(false, true),
    onRebind: (key) => {
      flushSync(() => {
        setShowArchived(false);
        setSelectedKey(key);
      });
    },
  });
  const { transcript, observation, connection, activity } = chat;
  const error = chat.error;
  const setError = chat.setError;
  const body = chat.draft;
  const sending = chat.sending;
  const loadingOlder = chat.loadingOlder;
  const loadOlder = chat.loadOlder;
  const uiPrompt = chat.prompt;
  const sendNowEnabled = chat.sendNowEnabled;
  const statusKind = activity.kind;
  const processLive = chat.processLive;
  const inTerminal = chat.inTerminal;
  const terminalIo = chat.terminalIo;
  const contextUsage = chat.contextUsage;
  const modelLabel = chat.modelLabel;
  const blocked = chat.blocked;
  const disconnected = chat.disconnected;
  const send = (override?: string) => {
    chat.send(override);
  };
  const sendNow = () => {
    chat.sendNow();
  };
  const abort = () => {
    chat.abort();
  };
  const [dropping, setDropping] = useState(false);
  const inTerminalRef = useRef(inTerminal);
  inTerminalRef.current = inTerminal;
  const stagePathsRef = useRef(chat.stagePaths);
  stagePathsRef.current = chat.stagePaths;
  useEffect(() => {
    if (!active || !selectionKey) return;
    const un = ipc.getCurrentWebview().onDragDropEvent((event) => {
      if (inTerminalRef.current) return;
      if (event.payload.type === "enter" || event.payload.type === "over") {
        setDropping(true);
        return;
      }
      if (event.payload.type === "leave") {
        setDropping(false);
        return;
      }
      const { paths } = event.payload;
      setDropping(false);
      stagePathsRef.current(paths);
    });
    return () => {
      un.then((finish) => finish());
    };
  }, [active, selectionKey]);
  const turnWasActive = useRef(false);
  const selectedId = selected?.session.id;
  const selectedRepo = selected?.repo_path;
  // A reconnect keeps a half-typed rename. Switching threads does not. The ids are the trigger, not values the effect reads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: selected thread identity.
  useEffect(() => {
    turnWasActive.current = false;
    setRenaming(false);
  }, [selectedId, selectedRepo]);

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

  /**
   * The escape hatch: restart this thread's OMP on the same journal in its terminal UI, or back
   * into chat. Click-only, never automatic — it replaces the live process.
   */
  async function hatch() {
    if (!selected || !selectionKey || hatchBusy) return;
    const repo = selected.repo_path;
    const id = selected.session.id;
    const target = inTerminal ? "rpc" : "pty";
    setError("");
    try {
      if (activity.turnActive) {
        if (!(await confirmStopAndSwitch(target))) return;
        requireWritten(await (inTerminal ? ipc.chatPtyWrite(repo, id, OMP_INTERRUPT_DATA, crypto.randomUUID()) : ipc.chatRpcWrite(repo, id, abortTurnCommand())));
      }
      setHatchBusy(true);
      await ipc.chatRestate(repo, id, target);
      const next = await ipc.chatSessionStatus(repo, id);
      chat.setObserved(next);
      // Back in chat: re-read the journal (turns typed in the terminal) and reattach RPC.
      if (target === "rpc") chat.reconnect();
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
    if (!repoPath || pickClosed) return;
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

  function pickThinking(level: string) {
    if (!selected) return;
    ipc
      .chatRpcWrite(selected.repo_path, selected.session.id, setThinkingLevelCommand(level))
      .then(requireWritten)
      .catch((cause: unknown) => setError(String(cause)));
  }

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
            {/* Shown paths, not the open set: a closed repo's group stays until its threads reload, and "none available" must not sit above it. */}
            <OpenReposNotice repos={openRepos === null ? null : repoPaths} error={reposError} className="chat-rail-empty" />
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
                {inTerminal || !transcript.sessionMeta.thinking ? null : (
                  <span className="chat-meta-item">
                    <Brain size={13} aria-hidden="true" />
                    <ThinkingSelect
                      level={transcript.sessionMeta.thinking}
                      levels={transcript.sessionMeta.thinkingLevels}
                      disabledReason={connection.state === "ready" && processLive ? null : "Ava is not running in this thread, so its thinking level cannot change"}
                      onPick={pickThinking}
                    />
                  </span>
                )}
                {contextUsage ? (
                  <span className="chat-meta-item" title="Context used / available">
                    {contextUsage}
                  </span>
                ) : null}
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
                    <button type="button" className="btn ghost small chat-model-btn" onClick={() => chat.setProvidersDialog({ tab: "models", preselect: "" })} title="Change model">
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
            onApprove={chat.approve}
            onLoadOlder={loadOlder}
            loadingOlder={loadingOlder}
            atStart={transcript.fileStart === 0}
          />
        ) : (
          <div className="chat-blank">
            <MessageSquare size={28} aria-hidden="true" />
            <p className="chat-blank-title">No thread selected</p>
            <p className="chat-blank-hint">Choose a thread on the left, or start a new one.</p>
            <button type="button" className="btn small chat-new-btn" onClick={() => startThreadIn("")}>
              <Plus size={14} aria-hidden="true" />
              Start a new chat
            </button>
          </div>
        )}
        {disconnected !== null ? (
          <div className="chat-banner" role="alert">
            <span>
              Lost the connection to Ava in this thread. Replies and approvals will not show until it reconnects. <span className="chat-banner-detail">{disconnected}</span>
            </span>
            <button type="button" className="btn small" onClick={() => chat.reconnect()}>
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
          <ChatExtensionPrompt request={uiPrompt} onSubmit={(value) => void chat.reply(uiPrompt.id, value)} onCancel={() => void chat.cancelUi(uiPrompt.id)} />
        ) : null}
        {/* No composer without a thread: drafts are per thread, so the box would swallow every keystroke. */}
        {inTerminal || !selected ? null : (
          <ChatComposer
            body={body}
            status={activity.status}
            catalog={transcript.commands}
            sending={sending}
            showHints={visibility.showComposerHints}
            attachments={chat.attachments}
            dropping={dropping}
            onAttach={() => {
              void ipc
                .pickAttachmentFilesDialog()
                .then((paths) => chat.stagePaths(paths))
                .catch((error: unknown) => toast.error(String(error)));
            }}
            onRemoveAttachment={(id) => chat.removeAttachment(id)}
            onClear={() => chat.clearComposer()}
            onPasteFiles={chat.stageBlobs}
            onBodyChange={(next) => {
              if (selectionKey) chat.setDraft(next);
            }}
            onSend={() => {
              send();
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
            <OpenReposNotice repos={openRepos} error={reposError} className="dsc" />
            <label className="chat-dialog-field">
              <span>Repository</span>
              <span className="chat-select">
                <select value={repoPath} onChange={(event) => setRepoPath(event.target.value)}>
                  {pickClosed ? (
                    <option value={pickedRepo} disabled>
                      {repoLabel(pickedRepo, dirs)} (not open)
                    </option>
                  ) : null}
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
            {pickClosed ? (
              <p className="dsc field-error" role="alert">
                {repoLabel(pickedRepo, dirs)} is not open in this window. Open it again{dirs.length > 0 ? ", or choose another repository" : ""}.
              </p>
            ) : null}
            <Checkbox checked={createWorktree} onChange={setCreateWorktree} label="New worktree and branch" />
          </div>
          <div className="mfoot chat-new-foot">
            <button type="button" className="btn ghost" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button type="button" className="btn" onClick={() => void createThread()} disabled={!repoPath || pickClosed} data-autofocus>
              Create
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

export function ChatView(props: { active?: boolean; terminalFontSize: number; visibility: ChatPrefs }) {
  const existing = useContext(ChatSessionContext);
  if (!existing) {
    return (
      <ChatSessionProvider>
        <ChatViewBody {...props} />
      </ChatSessionProvider>
    );
  }
  return <ChatViewBody {...props} />;
}
