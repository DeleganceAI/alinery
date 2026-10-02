import { Archive, ChevronDown, ChevronRight, FolderGit2, GitBranch, MessageSquare, PanelLeftClose, PanelLeftOpen, Pencil, Pin, PinOff, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChatComposer } from "../ChatComposer";
import { appendOptimisticAbort, appendOptimisticUser, type ChatTranscriptState, emptyTranscript } from "../chatTranscript";
import { askConfirm, confirmDanger } from "../confirm";
import * as ipc from "../ipc";
import { NameEditor } from "../NameEditor";
import { observationDisplayKind } from "../sessionAttention";
import { Checkbox, Dialog, obsLabel } from "../shared";
import type { ChatThread, SessionObservation } from "../types";
import { ChatModelDialog } from "./ChatModelDialog";
import { ChatPane } from "./ChatPane";
import { abortTurnCommand, applyChatLine, applyModelCommand, attachHandshake, journalState, sendCommand } from "./chatSession";

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

function composerStatus(observation: SessionObservation | null): "idle" | "running" | "waiting_approval" {
  if (!observation) return "idle";
  const kind = observationDisplayKind(observation);
  if (kind === "busy" || kind === "starting" || kind === "loading" || kind === "unsupported") return "running";
  if (kind === "waiting_for_approval") return "waiting_approval";
  return "idle";
}

function interruptedWithoutJournal(thread: ChatThread, transcript: ChatTranscriptState): boolean {
  return thread.session.ended_at != null && thread.session.harness_resume_token.length === 0 && transcript.entries.length === 0;
}

export function ChatView({ knownRepos }: { knownRepos: string[] }) {
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
  const pendingPrompt = useRef<string | null>(null);
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

  const selected = useMemo(() => threads.find((thread) => `${thread.repo_path}:${thread.session.id}` === selectedKey) ?? null, [threads, selectedKey]);

  const selectedId = selected?.session.id;
  const selectedRepo = selected?.repo_path;
  useEffect(() => {
    if (!selected || !selectedRepo || !selectedId) {
      setTranscript(emptyTranscript());
      return;
    }
    const repo = selectedRepo;
    const id = selectedId;
    const attachId = 1;
    let cancelled = false;
    setRenaming(false);
    setModelOpen(false);
    setError((current) => (current === "cannot continue" ? "" : current));
    ipc
      .chatSessionStatus(repo, id)
      .then((next) => {
        if (!cancelled) setObservation(next);
      })
      .catch(() => {
        if (!cancelled) setObservation(null);
      });
    ipc
      .readChatOmp({ repoPath: repo, id })
      .then((buffer) => {
        if (cancelled) return;
        const next = journalState(buffer);
        setTranscript(next);
        if (interruptedWithoutJournal(selected, next)) setError("cannot continue");
      })
      .catch(() => {
        if (cancelled) return;
        setTranscript(emptyTranscript());
        if (selected.session.ended_at != null && selected.session.harness_resume_token.length === 0) setError("cannot continue");
      });
    ipc
      .chatRpcAttach({
        repoPath: repo,
        id,
        attachId,
        streamToken: 1,
        onLine: (line) => {
          if (!cancelled) setTranscript((current) => applyChatLine(current, line));
        },
      })
      .then(async () => {
        if (cancelled) return;
        for (const command of attachHandshake()) {
          await ipc.chatRpcWrite(repo, id, command);
        }
        const pending = pendingPrompt.current;
        if (!pending || cancelled) return;
        pendingPrompt.current = null;
        await ipc.chatRpcWrite(repo, id, sendCommand(pending, false, false));
      })
      .catch(() => {
        if (pendingPrompt.current) {
          pendingPrompt.current = null;
          setError("daemon not connected");
        }
      });
    return () => {
      cancelled = true;
      ipc.chatDetach(repo, id, attachId).catch(() => {});
    };
  }, [selectedId, selectedRepo]);

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
        setTranscript((current) => appendOptimisticUser(current, text, "prompt"));
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
      const running = composerStatus(observation) === "running";
      const hasTurn = transcript.messages.length > 0 || selected.session.started_at != null;
      const command = sendCommand(text, running, hasTurn);
      setTranscript((current) => appendOptimisticUser(current, text, hasTurn || running ? "follow_up" : "prompt"));
      await ipc.chatRpcWrite(repo, id, command);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  function abort() {
    if (!selected) return;
    setTranscript((current) => appendOptimisticAbort(current));
    ipc.chatRpcWrite(selected.repo_path, selected.session.id, abortTurnCommand()).catch((cause: unknown) => setError(String(cause)));
  }

  const statusKind = observation ? observationDisplayKind(observation) : "idle";
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
    <div className="chat-view" data-testid="chat-view" data-rail={collapsed ? "closed" : "open"}>
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
                        return (
                          <li key={key} className="chat-thread">
                            <button
                              type="button"
                              className="chat-thread-btn"
                              aria-current={key === selectedKey ? "true" : undefined}
                              data-archived={thread.session.archived ? "true" : undefined}
                              onClick={() => setSelectedKey(key)}
                            >
                              {thread.session.pinned ? <Pin size={12} aria-hidden="true" className="chat-thread-pin" /> : null}
                              <span className="chat-thread-name">{threadLabel(thread)}</span>
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
            {selected ? (
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
                <button type="button" className="btn ghost small chat-model-btn" onClick={() => setModelOpen(true)} title="Change model">
                  <span className="chat-model-label">{modelLabel}</span>
                  <ChevronDown size={14} aria-hidden="true" />
                </button>
                <span className="chat-titlebar-sep" aria-hidden="true" />
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
                <button type="button" className="chat-icon-btn" aria-label="Archive" title="Archive" onClick={archiveSelected}>
                  <Archive size={16} aria-hidden="true" />
                </button>
              </>
            ) : null}
          </div>
        </header>
        {selected ? (
          <ChatPane entries={transcript.entries} status={composerStatus(observation)} />
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
        <ChatComposer
          body={body}
          status={composerStatus(observation)}
          catalog={[]}
          allowAttach={false}
          onBodyChange={setBody}
          onSend={() => {
            void send();
          }}
          onAbort={abort}
        />
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
