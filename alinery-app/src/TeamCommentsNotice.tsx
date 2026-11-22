import { useEffect, useRef } from "react";
import { repoName } from "./shared";
import { REPO_SCOPE, useEntity, useScope } from "./sync/hooks";
import { toast } from "./toast";

const TEAM_COMMENTS_KEY = "daemon/_/team-comments";

/**
 * A toast when the open repository's daemon saves teammates' comments. The daemon counts them since it started. The first
 * count a repository shows is the baseline, so opening a repo never announces comments that were already there.
 */
export function TeamCommentsNotice({ repo }: { repo: string }) {
  const replica = useScope(repo, REPO_SCOPE);
  const entity = useEntity(replica, TEAM_COMMENTS_KEY);
  const seen = useRef<{ repo: string; total: number } | null>(null);
  const total = entity?.value.case === "teamComments" ? entity.value.value.total : null;
  useEffect(() => {
    if (total === null) return;
    const before = seen.current?.repo === repo ? seen.current.total : null;
    seen.current = { repo, total };
    if (before !== null && total > before) toast.info(`${repoName(repo)} got new comments`);
  }, [repo, total]);
  return null;
}
