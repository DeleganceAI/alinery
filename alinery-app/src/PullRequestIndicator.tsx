import { CircleAlert, GitMerge, GitPullRequest, GitPullRequestClosed } from "lucide-react";
import type { KeyboardEvent } from "react";
import * as ipc from "./ipc";
import { toast } from "./toast";
import type { PullRequestSnapshot } from "./types";

export function PullRequestIndicator({ snapshot, compact = false }: { snapshot?: PullRequestSnapshot; compact?: boolean }) {
  if (!snapshot || (!snapshot.pr && !snapshot.error)) return null;
  const { pr, error } = snapshot;
  if (!pr) {
    const label = `Pull request status unavailable: ${error}`;
    return (
      <span className={`pull-request-indicator unavailable${compact ? " compact" : ""}`} role="img" aria-label={label} title={label}>
        <CircleAlert size={compact ? 14 : 16} aria-hidden="true" />
        {!compact && <span>PR status unavailable</span>}
      </span>
    );
  }

  const Icon = pr.state === "merged" ? GitMerge : pr.state === "closed" ? GitPullRequestClosed : GitPullRequest;
  const stateLabel = pr.state[0].toUpperCase() + pr.state.slice(1);
  const text = `PR #${pr.number} · ${stateLabel}`;
  const label = error ? `${text} (stale; refresh failed: ${error})` : text;
  const open = () => {
    void ipc.openUrl(pr.url).catch((cause: unknown) => toast(String(cause), "error"));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLAnchorElement>) => {
    event.stopPropagation();
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!event.repeat) open();
    }
  };

  return (
    <a
      href={pr.url}
      className={`pull-request-indicator ${pr.state}${compact ? " compact" : ""}${error ? " stale" : ""}`}
      title={label}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
        open();
      }}
      onKeyDown={onKeyDown}
      onKeyUp={(event) => {
        event.stopPropagation();
        if (event.key === "Enter" || event.key === " ") event.preventDefault();
      }}
    >
      <Icon size={compact ? 14 : 16} aria-hidden="true" />
      {!compact && (
        <span>
          {text}
          {error ? " · stale" : ""}
        </span>
      )}
    </a>
  );
}
