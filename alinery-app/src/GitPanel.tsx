import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { InlineStatus } from "./shared";
import { type GitDiffTarget, type WorktreeLog, worktreeDiffForRepo, worktreeLogForRepo } from "./sync/git";

/** A diff tab's key and label, shared by the list that opens it and the tab strip that names it. */
export function gitDiffTab(target: GitDiffTarget, subject = ""): { key: string; name: string; label: string } {
  const name = target.kind === "commit" ? `${target.oid.slice(0, 7)} ${subject}`.trim() : target.kind === "staged" ? "Staged changes" : "Uncommitted changes";
  return { key: target.kind === "commit" ? `diff:${target.oid}` : `diff:${target.kind}`, name, label: name };
}

/**
 * The Git side tab of a task: uncommitted and staged changes when there are any, then the branch's own commits. Read only.
 * A click opens one as a temporary diff tab, a double click keeps it. Refresh reads again; nothing here polls.
 */
export function GitPanel({ repoPath, taskSlug, onOpen }: { repoPath: string; taskSlug: string; onOpen: (target: GitDiffTarget, subject: string, keep: boolean) => void }) {
  const [log, setLog] = useState<WorktreeLog | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    let alive = true;
    setError("");
    worktreeLogForRepo(repoPath, taskSlug).then(
      (next) => alive && setLog(next),
      (e) => alive && setError(String(e instanceof Error ? e.message : e)),
    );
    return () => {
      alive = false;
    };
  }, [repoPath, taskSlug]);
  useEffect(load, [load]);

  const row = (target: GitDiffTarget, title: string, meta: string, subject = title) => (
    <button key={gitDiffTab(target).key} type="button" className="git-row" title={title} onClick={(e) => onOpen(target, subject, e.detail >= 2)}>
      <span className="git-row-title">{title}</span>
      <span className="git-row-meta">{meta}</span>
    </button>
  );
  const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;

  return (
    <div className="git-pane">
      <div className="git-pane-head">
        <span className="git-pane-base">{log ? (log.base ? `Commits since ${log.base}` : "Latest commits") : "Loading…"}</span>
        <button type="button" className="btn ghost small" title="Refresh" aria-label="Refresh" onClick={load}>
          <RefreshCw size={13} aria-hidden="true" />
        </button>
      </div>
      {error && (
        <InlineStatus tone="error" detail={error}>
          Couldn't read the branch.
        </InlineStatus>
      )}
      {log && (
        <div className="git-list" role="list" aria-label="Branch changes">
          {log.uncommitted > 0 && row({ kind: "uncommitted" }, "Uncommitted changes", files(log.uncommitted))}
          {log.staged > 0 && row({ kind: "staged" }, "Staged changes", files(log.staged))}
          {log.commits.map((c) =>
            row({ kind: "commit", oid: c.oid }, c.subject || "(no message)", `${c.oid.slice(0, 7)} · ${c.author} · ${new Date(c.time_ms).toLocaleString()}`, c.subject),
          )}
          {log.commits.length === 0 && log.staged === 0 && log.uncommitted === 0 && <div className="dim">No changes on this branch yet.</div>}
          {log.truncated && <div className="dim">Older commits are not shown.</div>}
        </div>
      )}
    </div>
  );
}

type DiffFile = { path: string; lines: string[]; added: number; removed: number };

/** Splits a unified diff into what comes before the first file (a commit's header) and one entry per file. */
export function splitPatch(patch: string): { header: string; files: DiffFile[] } {
  const lines = patch.split("\n");
  const first = lines.findIndex((l) => l.startsWith("diff --git "));
  const header = (first < 0 ? lines : lines.slice(0, first)).join("\n").trim();
  const files: DiffFile[] = [];
  for (const line of first < 0 ? [] : lines.slice(first)) {
    if (line.startsWith("diff --git ")) {
      // `diff --git a/x b/x`: the b side names the file as it is now.
      files.push({ path: line.replace(/^diff --git a\/.* b\//, ""), lines: [line], added: 0, removed: 0 });
      continue;
    }
    const file = files[files.length - 1];
    file.lines.push(line);
    if (line.startsWith("+") && !line.startsWith("+++")) file.added++;
    else if (line.startsWith("-") && !line.startsWith("---")) file.removed++;
  }
  return { header, files };
}

const lineClass = (line: string) =>
  line.startsWith("@@")
    ? "diff-hunk"
    : line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git") || line.startsWith("index ")
      ? "diff-meta"
      : line.startsWith("+")
        ? "diff-add"
        : line.startsWith("-")
          ? "diff-del"
          : "";

/** A diff tab's body: the commit header, then each file with its added and removed counts and its hunks. */
export function GitDiffView({ repoPath, taskSlug, target }: { repoPath: string; taskSlug: string; target: GitDiffTarget }) {
  const [reply, setReply] = useState<{ patch: string; truncated: boolean } | null>(null);
  const [error, setError] = useState("");
  const key = gitDiffTab(target).key;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key names the target
  useEffect(() => {
    let alive = true;
    setReply(null);
    setError("");
    worktreeDiffForRepo(repoPath, taskSlug, target).then(
      (r) => alive && setReply(r),
      (e) => alive && setError(String(e instanceof Error ? e.message : e)),
    );
    return () => {
      alive = false;
    };
  }, [repoPath, taskSlug, key]);

  if (error)
    return (
      <InlineStatus tone="error" detail={error}>
        Couldn't read the diff.
      </InlineStatus>
    );
  if (!reply) return <div className="dim git-diff-loading">Loading…</div>;
  const { header, files } = splitPatch(reply.patch);
  return (
    <div className="git-diff">
      {header && <pre className="git-diff-header">{header}</pre>}
      {files.length === 0 && <div className="dim">No changes.</div>}
      {files.map((file) => (
        <section className="git-diff-file" key={file.path} aria-label={file.path}>
          <h4 className="git-diff-file-head mono">
            <span>{file.path}</span>
            <span className="diff-add">+{file.added}</span>
            <span className="diff-del">−{file.removed}</span>
          </h4>
          <pre className="git-diff-lines">
            {file.lines.slice(1).map((line, n) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines of a fixed patch
              <span key={n} className={lineClass(line)}>
                {line}
                {"\n"}
              </span>
            ))}
          </pre>
        </section>
      ))}
      {reply.truncated && <div className="dim">The diff is too large to show in full.</div>}
    </div>
  );
}
