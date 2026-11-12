// GitService (plan S4.7): the git work a task does, run by the daemon so a local and a remote repository answer the same
// calls. A write that changes task.md re-reads it into the store before the reply, so the reply's cursor already covers it.
// Each write that reaches outside the repository (commit, push, remove a worktree) records a usage event, as the shell did.
import type { ServiceImpl } from "@connectrpc/connect";
import { Capability } from "alinery-proto/alinery/v1/admin_pb";
import type { GitService } from "alinery-proto/alinery/v1/git_pb";
import { commitWorktree, originUrl, pullRequestInputs, pushAndCompareUrl, recordDiscoveredPullRequest, removeWorktree, setPrUrl, taskSourceBranches } from "../domain/gitActions.ts";
import { listWorktreeFiles } from "../domain/worktreeFiles.ts";
import type { Sender } from "../platform/telemetry.ts";
import type { Dedupe } from "../sync/dedupe.ts";
import type { Store } from "../sync/store.ts";
import { requireCapability } from "./auth.ts";
import { domain, metaOf } from "./errors.ts";

export type GitDeps = {
  repo: string;
  /** A commit or a push queues the automatic backup (S4.9). */
  backups?: { publish(trigger: "post_push_commit"): void };
  refresh: (rel: string) => Promise<void>;
  telemetry: Sender;
};

export function gitService(d: GitDeps, dedupe: Dedupe, store: Store): ServiceImpl<typeof GitService> {
  const applied = async (slug: string) => {
    await d.refresh(`tasks/${slug}/task.md`);
    return { cursor: store.cursor() };
  };
  return {
    taskSourceBranches: (req, ctx) => {
      requireCapability(ctx, Capability.VIEW);
      return domain(async () => {
        const found = await taskSourceBranches(d.repo, req.selectedBaseRef);
        const ref = (fullRef: string, name: string) => ({ fullRef, name });
        const head = found.head;
        return {
          branches: found.branches,
          head: { head: head.kind === "detached" ? { case: "detachedOid" as const, value: head.oid } : { case: head.kind, value: ref(head.fullRef, head.name) } },
          selected: found.selected,
        };
      });
    },
    removeWorktree: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return dedupe.once(metaOf(req.meta), () =>
        domain(async () => {
          await removeWorktree(d.repo, req.slug);
          d.telemetry.record(() => ({ event: "git.worktree_remove", source: "alineryd" }));
          return { applied: await applied(req.slug) };
        }),
      );
    },
    pushAndCompareUrl: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return dedupe.once(metaOf(req.meta), () =>
        domain(async () => {
          const compareUrl = await pushAndCompareUrl(d.repo, req.slug);
          d.telemetry.record(() => ({ event: "git.push", source: "alineryd" }));
          d.backups?.publish("post_push_commit");
          return { compareUrl, applied: await applied(req.slug) };
        }),
      );
    },
    setPrUrl: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return dedupe.once(metaOf(req.meta), () =>
        domain(async () => {
          await setPrUrl(d.repo, req.slug, req.url);
          return { applied: await applied(req.slug) };
        }),
      );
    },
    commitWorktree: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return dedupe.once(metaOf(req.meta), () =>
        domain(async () => {
          await commitWorktree(d.repo, req.slug, req.message);
          d.telemetry.record(() => ({ event: "git.commit", source: "alineryd" }));
          d.backups?.publish("post_push_commit");
          return { applied: await applied(req.slug) };
        }),
      );
    },
    taskPullRequestInputs: (req, ctx) => {
      requireCapability(ctx, Capability.VIEW);
      return domain(async () => {
        const inputs = await pullRequestInputs(d.repo, req.slug);
        return { prUrl: inputs.prUrl, branch: inputs.branch, originUrl: inputs.originUrl };
      });
    },
    recordDiscoveredPullRequest: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return dedupe.once(metaOf(req.meta), () =>
        domain(async () => {
          await recordDiscoveredPullRequest(d.repo, req.slug, req.branch, req.previousUrl, req.url);
          return { applied: await applied(req.slug) };
        }),
      );
    },
    listWorktreeFiles: (req, ctx) => {
      requireCapability(ctx, Capability.VIEW);
      return domain(() => listWorktreeFiles(d.repo, req.slug));
    },
    gitOriginUrl: (_req, ctx) => {
      requireCapability(ctx, Capability.VIEW);
      return domain(async () => ({ originUrl: await originUrl(d.repo) }));
    },
  };
}
