import { Archive, ChevronDown, ChevronRight, FolderGit2, GitBranch, LayoutGrid, MessageSquare, PanelLeftClose, Pencil, Pin, PinOff, Plus, Trash2, X } from "lucide-react";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ChatComposer } from "../ChatComposer";
import type { ChatPrefs } from "../chat/visibility";
import { emptyTranscript, NEXT_TURN_MODEL_TITLE, NEXT_TURN_THINKING_TITLE } from "../chatTranscript";
import { askConfirm, confirmDanger } from "../confirm";
import { ORB_STATE } from "../Indicators";
import * as ipc from "../ipc";
import { MainTabs } from "../MainTabs";
import { NameEditor } from "../NameEditor";
import { PaneResizer } from "../PaneResizer";
import { repoDisplayPath } from "../remoteRepo";
import { SessionTerminal } from "../SessionTerminal";
import type { ObservationDisplayKind } from "../sessionAttention";
import { Checkbox, Dialog, InlineStatus, LoadingState, obsLabel, StatusMarker } from "../shared";
import {
  archiveChatThread,
  createChatThread,
  enableCanvas,
  removeChatWorktree,
  resumeChatThread,
  setChatPinned,
  setChatModel,
  setChatThinkingLevel,
  useCanvas,
  useChatThreads,
  useOpenChatRepos,
} from "../sync/chat";
import { useSessionObservations } from "../sync/sessionObservation";
import { renameSession } from "../sync/sessions";
import { toast } from "../toast";
import type { AppearancePrefs, ChatThread, SessionObservation } from "../types";
import { useArtifactPaneWidth } from "../useArtifactPaneWidth";
import { ChatCanvas } from "./ChatCanvas";
import { ChatModelBar } from "./ChatModelBar";
import { ChatPane } from "./ChatPane";
import { ChatSessionContext, ChatSessionProvider, chatActivity, errorMessage, threadKey, threadLabel, useChatRegistry, useChatThread } from "./chatThreadSession";

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
        Reading again when you return to this window.
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

function ChatViewBody({
  active = true,
  terminalFontSize,
  visibility,
  knownRepos = [],
  canvasAllowed = false,
  linkKey = "",
  appearance,
  onAppearanceChange,
}: {
  active?: boolean;
  terminalFontSize: number;
  visibility: ChatPrefs;
  knownRepos?: string[];
  /** Settings' Thread canvas: off hides every canvas here (the files and the agent's tools stay). */
  canvasAllowed?: boolean;
  /** Changes when the active repo's daemon link does: a daemon that attaches after the view opened makes its repo usable here. */
  linkKey?: string;
  /** The thread list's width is the side panel width the task and session views use. */
  appearance: AppearancePrefs;
  onAppearanceChange: (next: AppearancePrefs) => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [railWidth, railResizerProps, railCollapse] = useArtifactPaneWidth(appearance, onAppearanceChange, "left", window.innerWidth <= 900);
  const collapsed = railCollapse.collapsed;
  const setCollapsed = railCollapse.setCollapsed;
  // The threads open as tabs, in the order they were opened; the selected thread is the active tab.
  const [openKeys, setOpenKeys] = useState<string[]>([]);
  useEffect(() => {
    if (selectedKey) setOpenKeys((keys) => (keys.includes(selectedKey) ? keys : [...keys, selectedKey]));
  }, [selectedKey]);
  const [creating, setCreating] = useState(false);
  // null until the first read: the thread list waits for it rather than loading twice.
  const { repos: openRepos, error: reposError } = useOpenChatRepos(active, `${knownRepos.join("\n")}\n${linkKey}`);
  const dirs = openRepos ?? [];
  const threads = useChatThreads(openRepos ?? undefined, showArchived);
  const [pickedRepo, setRepoPath] = useState("");
  const [createWorktree, setCreateWorktree] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(() => new Set());
  const selectedKeyRef = useRef(selectedKey);
  selectedKeyRef.current = selectedKey;
  // An explicit pick (the select or a repo's "+") stays the target after its repo closes: the form
  // says so and will not create, rather than quietly retarget another repo. No pick follows the
  // first open repo.
  const repoPath = pickedRepo || (dirs[0] ?? "");
  const pickClosed = pickedRepo !== "" && !dirs.includes(pickedRepo);

  // Every live thread in the rail, from one chat-scope stream per repo.
  const liveRefs = useMemo(
    () =>
      threads
        .filter((thread) => !thread.session.archived && thread.session.ended_at == null)
        .map((thread) => ({ repo_path: thread.repo_path, task_slug: "", id: thread.session.id })),
    [threads],
  );
  const railObservations = useSessionObservations(liveRefs, active);

  const selected = useMemo(() => threads.find((thread) => threadKey(thread) === selectedKey) ?? null, [threads, selectedKey]);
  const selectionKey = selected ? threadKey(selected) : null;
  const threadTabs = openKeys.flatMap((key) => {
    const thread = threads.find((t) => threadKey(t) === key);
    return thread ? [{ key, name: threadLabel(thread), mode: "preview" as const }] : [];
  });
  const closeThreadTab = (key: string) => {
    const at = threadTabs.findIndex((tab) => tab.key === key);
    setOpenKeys((keys) => keys.filter((k) => k !== key));
    if (key === selectedKey) setSelectedKey(threadTabs[at - 1]?.key ?? threadTabs[at + 1]?.key ?? null);
  };
  const canvas = useCanvas(canvasAllowed && selected ? selected.repo_path : "", selected?.session.id ?? "");
  const registry = useChatRegistry();
  useEffect(() => {
    const take = () => {
      const focus = registry.takeFocus();
      if (focus) setSelectedKey(focus);
    };
    take();
    return registry.listenFocus(take);
  }, [registry]);

  const chat = useChatThread(selected, {
    active,
    autoCompaction: visibility.autoCompaction,
    isFocused: (key) => selectedKeyRef.current === key,
    // The rail follows the chat-scope stream, and every write waits for it to catch up, so there is nothing to reload.
    onReload: async () => {},
    onResumeRefresh: async () => flushSync(() => setShowArchived(false)),
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
  const sendNowEnabled = chat.sendNowEnabled;
  const statusKind = activity.kind;
  const processLive = chat.processLive;
  const inTerminal = chat.inTerminal;
  const showCanvas = Boolean(canvasAllowed && canvas && selected && !inTerminal);
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
  const selectedId = selected?.session.id;
  const selectedRepo = selected?.repo_path;
  // A reconnect keeps a half-typed rename. Switching threads does not. The ids are the trigger, not values the effect reads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: selected thread identity.
  useEffect(() => {
    setRenaming(false);
  }, [selectedId, selectedRepo]);

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
        await archiveChatThread(repo, id, false);
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
        await archiveChatThread(repo, id, choice === "remove");
      }
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  function togglePin(thread: ChatThread) {
    setChatPinned(thread.repo_path, thread.session.id, !thread.session.pinned).catch((cause: unknown) => setError(String(cause)));
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
      await removeChatWorktree(selected.repo_path, selected.session.id);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function resume(thread: ChatThread) {
    setError("");
    try {
      const successorId = await resumeChatThread(thread.repo_path, thread.session.id);
      setShowArchived(false);
      setSelectedKey(`${thread.repo_path}:${successorId}`);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function createThread() {
    if (!repoPath || pickClosed) return;
    setError("");
    try {
      const reply = await createChatThread({ repoPath, createWorktree });
      setCreating(false);
      setCreateWorktree(false);
      setShowArchived(false);
      setSelectedKey(`${repoPath}:${reply.session.id}`);
      if (reply.start === "failed") setError(reply.errors?.[0]?.message ?? "start failed");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  function pickModel(model: string) {
    if (!selected) return;
    void setChatModel(selected.repo_path, selected.session.id, model).then(
      (controls) => chat.applyControls(controls),
      (cause: unknown) => setError(String(cause)),
    );
  }

  function pickThinking(level: string) {
    if (!selected) return;
    void setChatThinkingLevel(selected.repo_path, selected.session.id, level).then(
      (controls) => chat.applyControls(controls),
      (cause: unknown) => setError(String(cause)),
    );
  }

  async function turnOnCanvas(thread: ChatThread) {
    const ok = await confirmDanger(
      "Turn on the canvas for this thread?",
      "Ava gets up to four panels beside the chat for charts, tables, documents and small pages. Once on, the canvas cannot be turned off for this thread.",
      "Turn on",
    );
    if (!ok) return;
    try {
      await enableCanvas(thread.repo_path, thread.session.id);
    } catch (e) {
      toast.error(errorMessage(e));
    }
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
      data-canvas={showCanvas ? "on" : undefined}
      style={{ ["--chat-col-max" as string]: visibility.maxWidth === "none" ? "100%" : `${visibility.maxWidth}px`, ["--artifact-width" as string]: `${railWidth}px` }}
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
                              data-open={openKeys.includes(key) ? "true" : undefined}
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
                setShowArchived(!showArchived);
              }}
            >
              {showArchived ? "Hide archived" : "Show archived"}
            </button>
          </div>
        </aside>
      )}
      <PaneResizer props={railResizerProps} collapse={railCollapse} />
      {showCanvas && selected && canvas ? <ChatCanvas repo={selected.repo_path} threadId={selected.session.id} canvas={canvas} /> : null}
      <section className="chat-main">
        {threadTabs.length > 0 && <MainTabs tabs={threadTabs} active={selectedKey ?? ""} onSelect={setSelectedKey} onClose={closeThreadTab} />}
        <header className="chat-titlebar">
          <div className="chat-titlebar-identity">
            {selected && renaming ? (
              <NameEditor
                value={selected.name ?? ""}
                label="Thread name"
                onCancel={() => setRenaming(false)}
                onSave={async (name) => {
                  await renameSession({ repoPath: selected.repo_path, taskSlug: "", sessionId: selected.session.id, name });
                  setRenaming(false);
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
                {canvasAllowed && !canvas && !inTerminal ? (
                  <button type="button" className="chat-icon-btn" aria-label="Turn on the canvas" title="Turn on the canvas" onClick={() => void turnOnCanvas(selected)}>
                    <LayoutGrid size={16} aria-hidden="true" />
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
          <ChatPane entries={transcript.entries} status={activity.status} visibility={visibility} atStart={transcript.fileStart === 0} />
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
        {/* No composer without a thread: drafts are per thread, so the box would swallow every keystroke. */}
        {inTerminal || !selected ? null : (
          <ChatModelBar
            model={modelLabel}
            title={activity.turnActive ? NEXT_TURN_MODEL_TITLE : undefined}
            thinkingTitle={activity.turnActive ? NEXT_TURN_THINKING_TITLE : undefined}
            thinking={transcript.sessionMeta.thinking}
            thinkingLevels={transcript.sessionMeta.thinkingLevels}
            thinkingDisabledReason={connection.state === "ready" && processLive ? null : "Ava is not running in this thread, so its thinking level cannot change"}
            onPickModel={pickModel}
            onPickThinking={pickThinking}
            onProviders={() => chat.setProvidersDialog({ tab: "models", preselect: "" })}
          />
        )}
        {inTerminal || !selected ? null : (
          <ChatComposer
            body={body}
            status={activity.status}
            catalog={transcript.commands}
            sending={sending}
            showHints={false}
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
              <span className="field-select">
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
            {repoPath ? <p className="dsc chat-dialog-path">{repoDisplayPath(repoPath)}</p> : null}
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

export function ChatView(props: Parameters<typeof ChatViewBody>[0]) {
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
