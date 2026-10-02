import { useEffect, useMemo, useRef, useState } from "react";
import { ChatComposer } from "../ChatComposer";
import { appendOptimisticAbort, appendOptimisticUser, type ChatTranscriptState, emptyTranscript } from "../chatTranscript";
import { askConfirm, confirmDanger } from "../confirm";
import * as ipc from "../ipc";
import { observationDisplayKind } from "../sessionAttention";
import { Dialog, obsLabel } from "../shared";
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
  const [draftName, setDraftName] = useState("");
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
    setDraftName(selected.name ?? "");
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
      let id = selected.session.id;
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

  return (
    <div className="chat-view" data-testid="chat-view">
      {collapsed ? (
        <button type="button" className="btn ghost small" onClick={() => setCollapsed(false)}>
          Show threads
        </button>
      ) : (
        <aside className="chat-rail" data-testid="chat-rail">
          <div className="chat-rail-actions">
            <button type="button" onClick={() => setCreating(true)}>
              New thread
            </button>
            <button type="button" onClick={() => setCollapsed(true)}>
              Collapse threads
            </button>
            <button
              type="button"
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
          <ul>
            {threads.map((thread) => {
              const key = `${thread.repo_path}:${thread.session.id}`;
              return (
                <li key={key}>
                  <button type="button" aria-current={key === selectedKey ? "true" : undefined} onClick={() => setSelectedKey(key)}>
                    {threadLabel(thread)}
                  </button>
                  {showArchived && thread.session.archived ? (
                    <button type="button" onClick={() => resume(thread)}>
                      Resume
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </aside>
      )}
      <section className="chat-main">
        <header>
          <h1>Ava</h1>
          {selected ? (
            <>
              <span>{repoBase(selected.repo_path)}</span>
              <span>{selected.checkout ? `checkout ${selected.branch_label}` : selected.branch_label}</span>
              <button type="button" onClick={() => setModelOpen(true)}>
                {modelLabel}
              </button>
              <span>{obsLabel(statusKind)}</span>
              <button type="button" onClick={archiveSelected}>
                Archive
              </button>
              {selected.checkout ? null : (
                <button type="button" onClick={() => void removeWorktree()}>
                  Remove worktree
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  ipc
                    .setChatPinned(selected.repo_path, selected.session.id, !selected.session.pinned)
                    .then(() => reload())
                    .catch((cause: unknown) => setError(String(cause)));
                }}
              >
                {selected.session.pinned ? "Unpin" : "Pin"}
              </button>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  ipc
                    .renameSession({ repoPath: selected.repo_path, taskSlug: "", sessionId: selected.session.id, name: draftName })
                    .then(() => reload())
                    .catch((cause: unknown) => setError(String(cause)));
                }}
              >
                <input aria-label="Thread name" value={draftName} onChange={(event) => setDraftName(event.target.value)} />
                <button type="submit">Rename</button>
              </form>
            </>
          ) : null}
        </header>
        <ChatPane entries={transcript.entries} status={composerStatus(observation)} />
        {error ? <p role="alert">{error}</p> : null}
        {blocked ? (
          <button type="button" onClick={() => setCreating(true)}>
            New thread
          </button>
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
        <Dialog onClose={() => setCreating(false)} ariaLabel="New thread">
          {dirs.length === 0 ? <p>No repositories.</p> : null}
          <label>
            Repository
            <select value={repoPath} onChange={(event) => setRepoPath(event.target.value)}>
              {dirs.map((path) => (
                <option key={path} value={path}>
                  {repoBase(path)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input type="checkbox" checked={createWorktree} onChange={(event) => setCreateWorktree(event.target.checked)} />
            New worktree and branch
          </label>
          <button type="button" onClick={() => void createThread()} disabled={!repoPath}>
            Create
          </button>
          <button type="button" onClick={() => setCreating(false)}>
            Cancel
          </button>
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
