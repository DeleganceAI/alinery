// ArtifactService (plan S4.5): the writes of review comments and the two halves of a review handoff. The read side is the
// task scope (`artifact/`, `attachment/`, `comment/`, `comment_draft/`, `review_pending/` and `artifact_tree/` rows, built
// by `ArtifactProjector`) and BlobService for bodies. Every write is deduplicated on its MutationMeta, and the rows it changed
// are in the store before it answers, so the reply's cursor covers them.
import { existsSync } from "node:fs";
import { realpathSync } from "node:fs";
import { Code, type ServiceImpl } from "@connectrpc/connect";
import { Capability } from "alinery-proto/alinery/v1/admin_pb";
import type { ArtifactService, Provenance as WireProvenance, PreparedAction as WireAction } from "alinery-proto/alinery/v1/artifacts_pb";
import type { ExecutionRecords } from "../domain/artifactList.ts";
import { artifactFilePath, validateArtifactFilename } from "../domain/artifactFiles.ts";
import {
  addComment,
  archiveComments,
  clearPending,
  type CommentInput,
  deleteDraft,
  finalizeSessionMessageActions,
  loadComments,
  type PreparedAction,
  prepareCommentsPrompt,
  prepareReviewApproval,
  type Provenance,
  saveDraft,
} from "../domain/artifactComments.ts";
import type { ArtifactProjector } from "../domain/artifactProjector.ts";
import { evidenceMarkdown, evidencePrompt, nextOutboundSidecarName, nextReviewHandoffArtifactName, recordJson, recordSidecarName, writeArtifactFile } from "../domain/handoff.ts";
import type { Json } from "../domain/sessionOps.ts";
import { readTaskChecked, safeComponent } from "../domain/taskFiles.ts";
import { DomainError, withTaskMutation } from "../platform/lock.ts";
import type { Sender } from "../platform/telemetry.ts";
import type { Dedupe } from "../sync/dedupe.ts";
import type { Store } from "../sync/store.ts";
import { requireCapability } from "./auth.ts";
import { domain, fail, metaOf } from "./errors.ts";
import { metaRel, ranOrFail, started } from "./sessions.ts";

export type ArtifactDeps = {
  repo: string;
  projector: ArtifactProjector;
  refresh: (rel: string) => Promise<void>;
  telemetry: Sender;
  /** `getTaskExecution`: the retained state and playbook definition of a task, or `{ error }`. */
  taskExecution: (slug: string) => Json;
  /** `create_execution_session`. */
  createSession: (request: Json) => Promise<Json>;
};

/** The retained execution records of an engine-v2 task, for the artifact list (undefined when the task has none). */
export function executionRecords(taskExecution: (slug: string) => Json): (slug: string) => ExecutionRecords | undefined {
  return (slug) => {
    const out = taskExecution(slug);
    return out.state ? (out.state as ExecutionRecords) : undefined;
  };
}

const wireInput = (c: { anchorId: string; anchorKind: string; anchorLabel: string; anchorExcerpt: string; lineStart: number; lineEnd: number; body: string } | undefined): CommentInput => {
  if (!c) throw new DomainError("invalid_argument", "a comment is required");
  return { anchor_id: c.anchorId, anchor_kind: c.anchorKind, anchor_label: c.anchorLabel, anchor_excerpt: c.anchorExcerpt, line_start: c.lineStart, line_end: c.lineEnd, body: c.body };
};

function fromWire(p: WireProvenance): Provenance {
  const k = p.kind;
  if (k.case === "artifactComments") return { type: "artifact_comments", items: k.value.items.map((i) => ({ artifact: i.artifact, review: i.review, comments_hash: i.commentsHash })) };
  if (k.case === "reviewApproval") return { type: "review_approval", review_artifact: k.value.reviewArtifact };
  throw new DomainError("invalid_argument", "a provenance names what it promises");
}

function toWire(a: PreparedAction): Pick<WireAction, "text"> & { provenance: { kind: WireProvenance["kind"] } } {
  const p = a.provenance;
  const kind: WireProvenance["kind"] =
    p.type === "artifact_comments"
      ? { case: "artifactComments", value: { $typeName: "alinery.v1.ArtifactCommentsProvenance", items: p.items.map((i) => ({ $typeName: "alinery.v1.PreparedSnapshot" as const, artifact: i.artifact, review: i.review, commentsHash: i.comments_hash })) } }
      : { case: "reviewApproval", value: { $typeName: "alinery.v1.ReviewApprovalProvenance", reviewArtifact: p.review_artifact } };
  return { text: a.text, provenance: { kind } };
}

export function artifactService(d: ArtifactDeps, dedupe: Dedupe, store: Store): ServiceImpl<typeof ArtifactService> {
  const applied = () => ({ cursor: store.cursor() });
  const once = <T>(meta: Parameters<typeof metaOf>[0], fn: () => Promise<T>) => dedupe.once(metaOf(meta), () => domain(fn));
  const task = (slug: string) => {
    if (safeComponent(slug) !== slug) throw new DomainError("invalid_argument", "invalid task slug");
    readTaskChecked(d.repo, slug);
  };
  /** The files a write changed are in the store, and so are the task's rows, before the reply. */
  const settle = async (slug: string, ...names: string[]) => {
    for (const name of names) await d.refresh(`tasks/${slug}/artifacts/${name}`);
    await d.refresh(`tasks/${slug}/artifact-comment-drafts.json`);
    d.projector.project(slug);
  };
  /** A write that names `expected_revision` is checked against the draft row as the files are now. */
  const checkDraft = (slug: string, artifact: string, anchor: string, expected: bigint) => {
    if (expected === 0n) return;
    d.projector.project(slug);
    const row = store.get(`comment_draft/${slug}/${artifact}/${anchor}`);
    if (row?.revision !== expected) throw fail(Code.Aborted, "aborted", `the comment draft changed since revision ${expected} (now ${row?.revision ?? 0n})`);
  };
  return {
    addComment: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return once(req.meta, async () => {
        task(req.taskSlug);
        const before = new Set(loadComments(d.repo, req.taskSlug, req.artifact).map((c) => c.id));
        const comments = addComment(d.repo, req.taskSlug, req.artifact, wireInput(req.comment));
        await settle(req.taskSlug, req.artifact);
        d.telemetry.record(() => ({ event: "artifact.comment_add", source: "alineryd" }));
        return { applied: applied(), commentId: comments.find((c) => !before.has(c.id))?.id ?? "" };
      });
    },
    saveCommentDraft: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return once(req.meta, async () => {
        task(req.taskSlug);
        const input = wireInput(req.comment);
        checkDraft(req.taskSlug, req.artifact, input.anchor_id, req.expectedRevision);
        saveDraft(d.repo, req.taskSlug, req.artifact, input);
        await settle(req.taskSlug);
        return { applied: applied() };
      });
    },
    deleteCommentDraft: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return once(req.meta, async () => {
        task(req.taskSlug);
        checkDraft(req.taskSlug, req.artifact, req.anchorId, req.expectedRevision);
        deleteDraft(d.repo, req.taskSlug, req.artifact, req.anchorId);
        await settle(req.taskSlug);
        return { applied: applied() };
      });
    },
    sendReview: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return once(req.meta, async () => {
        task(req.taskSlug);
        const review = archiveComments(d.repo, req.taskSlug, req.artifact);
        await settle(req.taskSlug, req.artifact, review);
        d.telemetry.record(() => ({ event: "artifact.review_send", source: "alineryd" }));
        return { applied: applied(), review };
      });
    },
    clearReviewPending: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return once(req.meta, async () => {
        task(req.taskSlug);
        clearPending(d.repo, req.taskSlug, req.artifact);
        await settle(req.taskSlug);
        return { applied: applied() };
      });
    },
    prepareCommentsPrompt: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return once(req.meta, async () => {
        task(req.taskSlug);
        const action = prepareCommentsPrompt(d.repo, req.taskSlug, req.artifacts);
        await settle(req.taskSlug, ...req.artifacts);
        return { applied: applied(), action: toWire(action) };
      });
    },
    prepareReviewApproval: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return once(req.meta, async () => {
        task(req.taskSlug);
        return { applied: applied(), action: toWire(prepareReviewApproval(d.repo, req.taskSlug, req.reviewArtifact)) };
      });
    },
    finalizeMessageActions: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return once(req.meta, async () => {
        task(req.taskSlug);
        finalizeSessionMessageActions(d.repo, req.sessionId, req.taskSlug, req.actions.map(fromWire));
        await settle(req.taskSlug);
        return { applied: applied() };
      });
    },
    installReviewHandoff: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return once(req.meta, async () => {
        const slug = req.targetSlug.trim();
        const sourceSlug = req.sourceSlug.trim();
        if (safeComponent(sourceSlug) !== sourceSlug || safeComponent(slug) !== slug || !sourceSlug || !slug) throw new DomainError("invalid_argument", "source and target task identities are required");
        const sameRepo = (() => {
          try {
            return realpathSync(req.sourceRepoPath) === realpathSync(d.repo);
          } catch {
            return req.sourceRepoPath === d.repo;
          }
        })();
        if (sourceSlug === slug && sameRepo) throw new DomainError("invalid_argument", "review handoff source and target must be different tasks");
        if (readTaskChecked(d.repo, slug).archived === true) throw new DomainError("failed_precondition", "archived tasks cannot participate in review handoff");
        const retained = d.taskExecution(slug);
        const steps = ((retained.definition as Json | undefined)?.step ?? []) as { key: string }[];
        const phase = req.targetPhase.trim();
        if (!steps.some((s) => s.key === phase)) throw new DomainError("failed_precondition", "choose an explicit step from the target task's retained playbook");
        const sourceArtifact = validateArtifactFilename(req.sourceArtifact.trim());
        const target = await withTaskMutation(d.repo, "install review evidence", () => {
          const name = nextReviewHandoffArtifactName(d.repo, slug);
          return { name, path: writeArtifactFile(d.repo, slug, name, evidenceMarkdown(req.sourceRepoPath, sourceSlug, sourceArtifact, req.sourceText)) };
        });
        await settle(slug, target.name);
        let reply: Json;
        try {
          reply = ranOrFail(
            await d.createSession({
              task_slug: slug,
              target: { kind: "primary", step_key: phase, execution_id: null, input_occurrence_ids: null },
              launch_override: { harness: req.harness, model: req.model },
              prompt_extra: evidencePrompt(req.promptExtra, target.path),
              handoff_artifact: target.name,
              start: req.start,
            }),
          );
        } catch (e) {
          throw new DomainError("failed_precondition", `review handoff evidence retained at ${target.path} for target ${slug}; session creation outcome must be inspected before retrying: ${(e as Error).message}`);
        }
        const session = reply.session as Json;
        await d.refresh(metaRel(slug, String(session.id)));
        await d.refresh(`tasks/${slug}/execution.json`);
        const record = {
          version: 2,
          direction: "inbound",
          source_repo_path: req.sourceRepoPath,
          target_repo_path: d.repo,
          source_task: sourceSlug,
          source_session: req.sourceSession,
          source_artifact: sourceArtifact,
          target_task: slug,
          target_artifact: target.name,
          target_session: String(session.id),
          target_phase: String(session.phase ?? phase),
          created_at_ms: Date.now(),
        };
        const errors: { stage: string; code: string; message: string }[] = [];
        try {
          writeArtifactFile(d.repo, slug, recordSidecarName(target.name, "inbound"), recordJson(record));
        } catch (e) {
          errors.push({ stage: "inbound_handoff_record", code: "handoff_record_failed", message: (e as Error).message });
        }
        await settle(slug, target.name);
        d.telemetry.record(() => ({ event: "artifact.review_handoff", source: "alineryd", targetPhase: record.target_phase, harness: String(session.harness ?? "") }));
        return {
          applied: applied(),
          targetArtifact: target.name,
          started: started(reply),
          record: {
            version: record.version,
            direction: record.direction,
            sourceRepoPath: record.source_repo_path,
            targetRepoPath: record.target_repo_path,
            sourceTask: record.source_task,
            sourceSession: record.source_session,
            sourceArtifact: record.source_artifact,
            targetTask: record.target_task,
            targetArtifact: record.target_artifact,
            targetSession: record.target_session,
            targetPhase: record.target_phase,
            createdAtMs: BigInt(record.created_at_ms),
          },
          errors,
        };
      });
    },
    recordOutboundHandoff: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return once(req.meta, async () => {
        const slug = req.sourceSlug.trim();
        task(slug);
        const r = req.record;
        if (!r || r.direction !== "outbound" || r.sourceTask !== slug) throw new DomainError("invalid_argument", "an outbound record names this task as its source");
        const artifact = validateArtifactFilename(r.sourceArtifact);
        if (!existsSync(artifactFilePath(d.repo, slug, artifact))) throw new DomainError("not_found", `no such artifact: ${artifact}`);
        const name = await withTaskMutation(d.repo, "record outbound review handoff", () => {
          const next = nextOutboundSidecarName(d.repo, slug, artifact);
          writeArtifactFile(
            d.repo,
            slug,
            next,
            recordJson({
              version: r.version,
              direction: r.direction,
              source_repo_path: r.sourceRepoPath,
              target_repo_path: r.targetRepoPath,
              source_task: r.sourceTask,
              source_session: r.sourceSession,
              source_artifact: r.sourceArtifact,
              target_task: r.targetTask,
              target_artifact: r.targetArtifact,
              target_session: r.targetSession,
              target_phase: r.targetPhase,
              created_at_ms: Number(r.createdAtMs),
            }),
          );
          return next;
        });
        await settle(slug, name);
        return { applied: applied() };
      });
    },
  };
}
