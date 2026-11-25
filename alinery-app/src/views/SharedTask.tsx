import { ArrowLeft, MessageSquare } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ArtifactCommentsPanel, CommentsPanelToggle, focusCommentOpener, useCommentsPanel } from "../ArtifactCommentsPanel";
import { type ArtifactCommentAnchor, ArtifactMarkdown } from "../ArtifactMarkdown";
import { CopyArtifactButton } from "../chat/CopyMessage";
import { ListToolbar } from "../ListToolbar";
import { MainTabs, type OpenTab, useOpenTabs } from "../MainTabs";
import { PaneResizer } from "../PaneResizer";
import { PullCommentsButton } from "../PullCommentsButton";
import { EmptyState, formatAbsolute, formatAge, InlineStatus, useMinuteNow } from "../shared";
import { type SharedTask, sharedArtifactComments } from "../sharedTask";
import type { AppearancePrefs, TeamCommentAnchor, TeamShare, TeamShareDetail } from "../types";
import { useArtifactPaneWidth } from "../useArtifactPaneWidth";
import "./TaskList.css";

function onActivate(event: KeyboardEvent<HTMLElement>, run: () => void) {
  if ((event.key !== "Enter" && event.key !== " ") || event.target !== event.currentTarget) return;
  event.preventDefault();
  run();
}

function ShareStatus({ share }: { share: TeamShare }) {
  return (
    <span className="pill" title={share.last_sync_error || undefined}>
      {share.online ? "Online" : "Offline"}
    </span>
  );
}

/** A teammate's daemon as the Tasks list shows a repository: read-only, newest first. */
export function SharedTaskList({
  share,
  tasks,
  loaded,
  onBack,
  onOpen,
  onRefresh,
}: {
  share: TeamShare;
  tasks: SharedTask[];
  loaded: boolean;
  onBack: () => void;
  onOpen: (task: SharedTask) => void;
  onRefresh: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const now = useMinuteNow();
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visible = tasks
    .filter((task) => terms.every((term) => [task.name, task.branch, task.playbook].join("\n").toLowerCase().includes(term)))
    .sort((a, b) => (b.updated || b.created) - (a.updated || a.created) || a.slug.localeCompare(b.slug));
  const heading = (
    <>
      <button type="button" className="btn ghost small" onClick={onBack}>
        <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" /> Team
      </button>
      <h1 className="view-title">{share.name}</h1>
      <ShareStatus share={share} />
      <PullCommentsButton onPull={() => onRefresh().then(() => undefined)} title="Pull the latest tasks, artifacts and comments" />
    </>
  );
  return (
    <section className="listwrap collection-view task-list-view">
      <ListToolbar
        label="Tasks"
        heading={heading}
        query={query}
        onQueryChange={setQuery}
        shown={visible.length}
        total={tasks.length}
        filtered={terms.length > 0}
        onReset={() => setQuery("")}
      />
      {share.last_sync_error && <InlineStatus tone="warning">{share.last_sync_error}</InlineStatus>}
      {!loaded ? null : tasks.length === 0 ? (
        <div className="list list-empty">
          <EmptyState title="No tasks shared yet." hint="Tasks appear here once this daemon syncs." />
        </div>
      ) : visible.length === 0 ? (
        <div className="list list-empty">
          <EmptyState title="No tasks match this search." hint={`Clear the search to show all ${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}.`} />
        </div>
      ) : (
        <div className="list task-table-wrap">
          <table className="task-table sticky-head">
            <thead>
              <tr>
                <th scope="col" className="task-col-name name-col">
                  Name
                </th>
                <th scope="col" className="task-col-playbook">
                  Playbook
                </th>
                <th scope="col" className="task-col-sessions num-col">
                  Artifacts
                </th>
                <th scope="col" className="task-col-sessions num-col">
                  Comments
                </th>
                <th scope="col" className="task-col-created age-col">
                  Created
                </th>
                <th scope="col" className="task-col-updated age-col">
                  Updated
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((task) => {
                const updated = task.updated || task.created;
                return (
                  <tr
                    key={task.slug}
                    className={`${task.slug === selected ? "sel" : ""}${task.archived ? " row-archived" : ""}`}
                    tabIndex={0}
                    onFocus={() => setSelected(task.slug)}
                    onKeyDown={(event) => onActivate(event, () => onOpen(task))}
                    onClick={() => onOpen(task)}
                  >
                    <td className="task-col-name task-name-cell">
                      <span className="task-name-line" title={task.name}>
                        <span className="task-name-text">{task.name}</span>
                        {task.archived && <span className="pill task-archived">Archived</span>}
                        {task.draft && <span className="pill">Draft</span>}
                      </span>
                      <span className="task-subline">{task.branch || task.slug}</span>
                    </td>
                    <td className="task-col-playbook">
                      <span className="task-playbook" title={task.playbook}>
                        {task.playbook}
                      </span>
                    </td>
                    <td className="task-col-sessions num-col">{task.artifacts.length}</td>
                    <td className="task-col-sessions num-col">{task.commentCount}</td>
                    <td className="age-cell task-col-created age-col" title={task.created ? formatAbsolute(task.created) : undefined}>
                      {task.created ? formatAge(task.created, now) : "—"}
                    </td>
                    <td className="age-cell task-col-updated age-col" title={updated ? formatAbsolute(updated) : undefined}>
                      {updated ? formatAge(updated, now) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** A shared task as the session view shows one, cut down to its playbook artifacts. A click on a block opens a
 *  comment there, as on a local artifact; the comment goes to the accounts service, not into the owner's files. */
export function SharedTaskView({
  share,
  task,
  detail,
  appearance,
  onAppearanceChange,
  onBack,
  onComment,
  onRefresh,
}: {
  share: TeamShare;
  task: SharedTask;
  detail: TeamShareDetail;
  appearance: AppearancePrefs;
  onAppearanceChange: (next: AppearancePrefs) => void;
  onBack: () => void;
  onComment: (filename: string, body: string, anchor: TeamCommentAnchor) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const tabs = useOpenTabs<OpenTab>(`${share.id}\0${task.slug}`);
  const [width, resizerProps, collapse] = useArtifactPaneWidth(appearance, onAppearanceChange, "left");
  const [anchor, setAnchor] = useState<ArtifactCommentAnchor | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const commentsPanel = useCommentsPanel();
  const current = tabs.current;
  const filename = current?.name ?? "";
  const artifact = task.artifacts.find((row) => row.filename === filename);
  const text = artifact?.body ?? "";
  const comments = useMemo(() => sharedArtifactComments(detail.comments, task.slug, filename), [detail.comments, task.slug, filename]);
  const countFor = (name: string) => detail.comments.filter((row) => row.task_slug === task.slug && row.filename === name).length;

  const open = (name: string, keep = false) => {
    setAnchor(null);
    setDraft("");
    tabs.open({ key: name, name, mode: "preview" }, keep);
  };
  // The newest artifact opens with the task, as there is no conversation to show in its place.
  const latest = task.artifacts[task.artifacts.length - 1]?.filename;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per task, never over a tab the user chose
  useEffect(() => {
    if (latest) open(latest);
  }, [share.id, task.slug]);

  const openComment = useCallback((next: ArtifactCommentAnchor) => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    flushSync(() => {
      setAnchor(next);
      setDraft("");
    });
    inputRef.current?.focus();
  }, []);

  const save = () => {
    const body = draft.trim();
    if (!anchor || !filename || !body || busy) return;
    setBusy(true);
    onComment(filename, body, anchor)
      .then(() => {
        setAnchor(null);
        setDraft("");
        setError("");
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="sessionview">
      <div className="sessionhd">
        <button type="button" className="btn ghost small" onClick={onBack}>
          <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" /> Back
        </button>
        <div className="session-identity">
          <strong className="editable-name-text" title={task.name}>
            {task.name}
          </strong>
          <div className="session-context">
            <span className="session-task" title={share.name}>
              <span className="session-task-label">Daemon:</span> {share.name}
            </span>
          </div>
        </div>
        <span className="pill">{task.playbook}</span>
        <ShareStatus share={share} />
        <span className="session-path dim mono">{task.branch || task.slug}</span>
      </div>
      <div className={`sessionbody${collapse.collapsed ? " pane-collapsed" : ""}`} style={{ ["--artifact-width" as string]: `${width}px` }}>
        <aside className="artifactpane">
          <div className="artifacthead">
            <div className="artifacttabs" role="group" aria-label="Artifact category">
              <button type="button" aria-pressed="true" className="artifacttab on">
                Playbook
              </button>
            </div>
            <PullCommentsButton onPull={() => onRefresh().then(() => undefined)} title="Pull the latest tasks, artifacts and comments" />
            <span className="pill">{task.artifacts.length}</span>
          </div>
          <div className="artifactlist">
            {task.artifacts.length === 0 && <div className="dim">No playbook artifacts yet.</div>}
            {task.artifacts.map((row) => {
              const name = row.filename ?? "";
              const count = countFor(name);
              return (
                <div
                  key={name}
                  className={`artifactitem${name === filename ? " selected" : ""}`}
                  title={name}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => onActivate(event, () => open(name, true))}
                  onClick={(event) => open(name, event.detail >= 2)}
                >
                  <span className="artifactitem-name">{name}</span>
                  {count > 0 && (
                    <span className="artifact-comment-count" title={`${count} comment${count === 1 ? "" : "s"}`} aria-label={`${count} comment${count === 1 ? "" : "s"}`}>
                      <MessageSquare size={12} strokeWidth={2} aria-hidden="true" />
                      <span>{count}</span>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </aside>
        <PaneResizer props={resizerProps} collapse={collapse} />
        <main className="session-main">
          <MainTabs tabs={tabs.tabs} active={tabs.active} onSelect={tabs.select} onClose={tabs.close} />
          <div className="session-main-body">
            {current && artifact ? (
              <div className="artifactpane task-artifact-view session-artifact-view">
                <div className="artifacthead">
                  <div className="artifacttitle mono" title={filename}>
                    {filename}
                  </div>
                  <div className="btn-group">
                    <CopyArtifactButton text={text} />
                    <CommentsPanelToggle
                      open={commentsPanel.open || Boolean(anchor)}
                      count={comments.length}
                      // A comment here is not autosaved, so the panel stays while one is being written.
                      onToggle={anchor ? undefined : () => commentsPanel.setOpen(!commentsPanel.open)}
                    />
                    <button
                      type="button"
                      className={`btn ghost small${current.mode === "preview" ? " on" : ""}`}
                      aria-pressed={current.mode === "preview"}
                      onClick={() => tabs.setMode("preview")}
                    >
                      Preview
                    </button>
                    <button
                      type="button"
                      className={`btn ghost small${current.mode === "raw" ? " on" : ""}`}
                      aria-pressed={current.mode === "raw"}
                      onClick={() => tabs.setMode("raw")}
                    >
                      Raw
                    </button>
                  </div>
                </div>
                {error && (
                  <InlineStatus tone="error" detail={error}>
                    The comment was not saved.
                  </InlineStatus>
                )}
                <div className="artifact-review">
                  <div className="artifactviewer">
                    {current.mode === "raw" ? (
                      <pre className="artifactraw">{text}</pre>
                    ) : (
                      <article className="md artifactmd">
                        <ArtifactMarkdown text={text} artifactPath={filename} comments={comments} onAddComment={openComment} onOpenThread={commentsPanel.openThread} />
                      </article>
                    )}
                  </div>
                  {(commentsPanel.open || anchor) && (
                    <ArtifactCommentsPanel
                      comments={comments}
                      active={anchor}
                      body={draft}
                      canSave={!busy && Boolean(draft.trim())}
                      placeholder={`Comment for ${share.name}...`}
                      inputRef={inputRef}
                      focused={commentsPanel.focused}
                      onBodyChange={setDraft}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                          event.preventDefault();
                          save();
                        }
                        if (event.key === "Escape") {
                          event.preventDefault();
                          focusCommentOpener(openerRef.current);
                        }
                      }}
                      onSave={save}
                      onDiscard={() => {
                        setAnchor(null);
                        setDraft("");
                      }}
                      onOpen={openComment}
                      onClose={anchor ? undefined : () => commentsPanel.setOpen(false)}
                    />
                  )}
                </div>
              </div>
            ) : (
              <div className="list list-empty session-artifact-view">
                <EmptyState
                  title={task.artifacts.length ? "Open an artifact." : "No playbook artifacts yet."}
                  hint={task.artifacts.length ? "Choose one from Playbook to read and comment on it." : undefined}
                />
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
