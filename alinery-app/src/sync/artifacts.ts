// A task's artifacts and review comments (plan S4.5). The list, the attachments, the comments, the comment drafts, the
// waiting-for-review marks and the tree are rows of the task scope, so a view that shows them subscribes instead of polling;
// the bodies are BlobService reads; the writes are ArtifactService calls that answer once this window's replica has them.
// What `list_artifacts_with_metadata`, `add_artifact_comment_for_repo`, `send_review_handoff` and their twenty neighbours
// answered is answered here; the shapes are the ones the views have always read.
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { ArtifactService, type Provenance as WireProvenance } from "alinery-proto/alinery/v1/artifacts_pb";
import { BlobRefSchema } from "alinery-proto/alinery/v1/blobs_pb";
import type { Cursor } from "alinery-proto/alinery/v1/common_pb";
import type { Artifact, Attachment, Comment, CommentDraft, Entity, HandoffRecord, ArtifactTreeNode as TreeNodeProto } from "alinery-proto/alinery/v1/entities_pb";
import { type Scope, ScopeSchema } from "alinery-proto/alinery/v1/sync_pb";
import { useMemo } from "react";
import { daemonTransport } from "../daemon/transport";
import { parseRemoteRepo, sameMachine } from "../remoteRepo";
import type {
  ArtifactComment,
  ArtifactCommentDraft,
  ArtifactListItem,
  ArtifactReviewPendingStatus,
  ArtifactTreeNode,
  PreparedSessionMessageAction,
  ReviewHandoffRecord,
  ReviewHandoffResult,
  SessionMessageActionProvenance,
  SessionMeta,
} from "../types";
import { whenReaches } from "./execution";
import { acquireScope, useEntities, useScope } from "./hooks";
import { newMutationMeta } from "./mutation";
import { readBlob } from "./tasks";

/** The client, replaceable by a test (a fake transport stands in for the daemon). */
export const artifactApi = {
  artifacts: (repo: string) => createClient(ArtifactService, daemonTransport(repo)),
};

/** A write over a row that moved on: the view should show the newer values and say so. */
export class ArtifactConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactConflict";
  }
}

async function call<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    const err = ConnectError.from(e);
    if (err.code === Code.Aborted) throw new ArtifactConflict(err.rawMessage);
    throw new Error(err.rawMessage);
  }
}

export const taskScope = (slug: string): Scope => create(ScopeSchema, { kind: { case: "task", value: { slug } } });

/** The path a repo key names on its own machine: a remote key's host path, a local key as it is. */
const machinePath = (repoKey: string) => parseRemoteRepo(repoKey)?.path ?? repoKey;

// ---- rows to the shapes the views read ------------------------------------------------------------------

const handoffOf = (h: HandoffRecord): ReviewHandoffRecord => ({
  version: h.version,
  direction: h.direction,
  source_repo_path: h.sourceRepoPath,
  target_repo_path: h.targetRepoPath,
  source_task: h.sourceTask,
  source_session: h.sourceSession,
  source_artifact: h.sourceArtifact,
  target_task: h.targetTask,
  target_artifact: h.targetArtifact,
  target_session: h.targetSession,
  target_phase: h.targetPhase,
  created_at_ms: Number(h.createdAtMs),
});

export const itemOfArtifact = (a: Artifact): ArtifactListItem => ({
  name: a.name,
  modified_at_ms: a.modifiedAtMs === undefined ? null : Number(a.modifiedAtMs),
  playbook_step: a.playbookStep,
  session_id: a.sessionId,
  handoffs: a.handoffs.map(handoffOf),
  attachment: false,
  execution_id: a.executionId ?? null,
  step_key: a.stepKey ?? null,
  logical_path: a.logicalPath ?? null,
  depth: a.depth === undefined ? null : Number(a.depth),
  discriminator: a.discriminator === undefined ? null : Number(a.discriminator),
  accepted: a.accepted ?? null,
});

export const itemOfAttachment = (a: Attachment): ArtifactListItem => ({
  name: a.name,
  modified_at_ms: a.modifiedAtMs === undefined ? null : Number(a.modifiedAtMs),
  playbook_step: "",
  session_id: "",
  handoffs: [],
  attachment: true,
  execution_id: null,
  step_key: null,
  logical_path: null,
  depth: null,
  discriminator: null,
  accepted: null,
});

const commentOf = (c: Comment): ArtifactComment => ({
  id: c.id,
  artifact: c.artifact,
  anchor_id: c.anchorId,
  anchor_kind: c.anchorKind,
  anchor_label: c.anchorLabel,
  anchor_excerpt: c.anchorExcerpt,
  line_start: c.lineStart,
  line_end: c.lineEnd,
  body: c.body,
  created_at_ms: Number(c.createdAtMs),
});

const draftOf = (d: CommentDraft): ArtifactCommentDraft => ({
  artifact: d.artifact,
  anchor_id: d.anchorId,
  anchor_kind: d.anchorKind,
  anchor_label: d.anchorLabel,
  anchor_excerpt: d.anchorExcerpt,
  line_start: d.lineStart,
  line_end: d.lineEnd,
  body: d.body,
  artifact_hash: d.artifactHash,
  updated_at_ms: Number(d.updatedAtMs),
  stale: d.stale,
});

const treeOf = (n: TreeNodeProto): ArtifactTreeNode => ({
  id: n.id,
  kind: n.kind as ArtifactTreeNode["kind"],
  label: n.label,
  owner_task_slug: n.ownerTaskSlug,
  source: n.source as ArtifactTreeNode["source"],
  children: n.children.map(treeOf),
  ...(n.revealPath ? { reveal_path: n.revealPath } : {}),
});

export type TaskArtifacts = {
  /** The stream has its first snapshot: an empty list is then really empty. */
  ready: boolean;
  items: ArtifactListItem[];
  tree: ArtifactTreeNode[];
  comments: ArtifactComment[];
  drafts: ArtifactCommentDraft[];
  pending: ArtifactReviewPendingStatus[];
};

const NONE: TaskArtifacts = { ready: false, items: [], tree: [], comments: [], drafts: [], pending: [] };

/** Everything the artifact panes show for one task, kept current by the daemon's task-scope stream. */
export function useTaskArtifacts(repo: string, slug: string): TaskArtifacts {
  const replica = useScope(slug ? repo : "", taskScope(slug));
  const rows = useEntities(replica);
  const ready = replica?.ready ?? false;
  return useMemo(() => (replica && slug ? rowsToArtifacts(rows, ready) : NONE), [replica, rows, ready, slug]);
}

export function rowsToArtifacts(rows: Entity[], ready: boolean): TaskArtifacts {
  const artifacts: Artifact[] = [];
  const attachments: Attachment[] = [];
  const out: TaskArtifacts = { ready, items: [], tree: [], comments: [], drafts: [], pending: [] };
  for (const e of rows) {
    const v = e.value;
    if (v.case === "artifact") artifacts.push(v.value);
    else if (v.case === "attachment") attachments.push(v.value);
    else if (v.case === "comment") out.comments.push(commentOf(v.value));
    else if (v.case === "commentDraft") out.drafts.push(draftOf(v.value));
    else if (v.case === "reviewPending") out.pending.push({ artifact: v.value.artifact, review: v.value.review });
    else if (v.case === "artifactTree" && v.value.slug) out.tree = v.value.nodes.map(treeOf);
  }
  artifacts.sort((a, b) => a.position - b.position);
  attachments.sort((a, b) => a.position - b.position);
  out.items = [...artifacts.map(itemOfArtifact), ...attachments.map(itemOfAttachment)];
  out.comments.sort((a, b) => a.line_start - b.line_start || a.created_at_ms - b.created_at_ms);
  return out;
}

// ---- bodies ---------------------------------------------------------------------------------------------

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** An artifact's text (`read_artifact_for_repo`). */
export async function readArtifactText(repo: string, taskSlug: string, name: string): Promise<string> {
  return call(async () => decode(await readBlob(repo, create(BlobRefSchema, { target: { case: "artifact", value: { taskSlug, name } } }))));
}

/** A tree node's text (`read_task_artifact_node`). */
export async function readNodeText(repo: string, taskSlug: string, nodeId: string): Promise<string> {
  return call(async () => decode(await readBlob(repo, create(BlobRefSchema, { target: { case: "artifactNode", value: { taskSlug, nodeId } } }))));
}

/** The viewer shows at most this much of a worktree file. */
export const WORKTREE_FILE_MAX_BYTES = 1024 * 1024;

/** A worktree file's text for the viewer; a file past the cap or with a NUL byte (binary) is an error that says so. */
export async function readWorktreeText(repo: string, taskSlug: string, path: string): Promise<string> {
  const bytes = await call(() => readBlob(repo, create(BlobRefSchema, { target: { case: "worktreeFile", value: { taskSlug, path } } }), WORKTREE_FILE_MAX_BYTES));
  if (bytes.length > WORKTREE_FILE_MAX_BYTES) throw new Error("larger than 1 MB, not shown");
  if (bytes.subarray(0, 8192).includes(0)) throw new Error("binary file, not shown");
  return decode(bytes);
}

/** A tree node's bytes, for an attachment image shown in the tree. */
export async function readNodeBytes(repo: string, taskSlug: string, nodeId: string): Promise<Uint8Array> {
  return call(() => readBlob(repo, create(BlobRefSchema, { target: { case: "artifactNode", value: { taskSlug, nodeId } } })));
}

/** A file an execution kept when it started or finished (O27), as the bytes it saw. */
export async function readStepObject(repo: string, taskSlug: string, executionId: string, sha256: string): Promise<Uint8Array> {
  return call(() => readBlob(repo, create(BlobRefSchema, { target: { case: "stepObject", value: { taskSlug, executionId, sha256 } } })));
}

// ---- where a file is, for "show in folder" -------------------------------------------------------------

/** A file below `.alinery/` on the repo's own machine: a remote repo's host path, so it can be copied, never opened here. */
export const alineryFilePath = (repo: string, below: string) => `${machinePath(repo)}/.alinery/${below}`;

export const attachmentFilePath = (repo: string, taskSlug: string, name: string) => alineryFilePath(repo, `tasks/${taskSlug}/artifacts/attachments/${name}`);

// ---- writes ---------------------------------------------------------------------------------------------

/** Runs a write, then waits (briefly) for this window's replica to pass the cursor it answered with, so a read right after shows the change. */
async function written<T extends { applied?: { cursor?: Cursor } }>(repo: string, slug: string, f: () => Promise<T>): Promise<T> {
  const { replica, release } = acquireScope(repo, taskScope(slug));
  try {
    const reply = await call(f);
    await whenReaches(replica, reply.applied?.cursor, 3000);
    return reply;
  } finally {
    release();
  }
}

export type CommentAnchorInput = { anchorId: string; anchorKind: string; anchorLabel: string; anchorExcerpt: string; lineStart: number; lineEnd: number; body: string };
const inputOf = (a: CommentAnchorInput) => ({ ...a });

export async function addComment(a: { repoPath: string; taskSlug: string; artifact: string } & CommentAnchorInput): Promise<string> {
  const { repoPath, taskSlug, artifact, ...comment } = a;
  const reply = await written(repoPath, taskSlug, () => artifactApi.artifacts(repoPath).addComment({ meta: newMutationMeta(), taskSlug, artifact, comment: inputOf(comment) }));
  return reply.commentId;
}

export async function saveCommentDraft(a: { repoPath: string; taskSlug: string; artifact: string } & CommentAnchorInput, expectedRevision?: bigint): Promise<void> {
  const { repoPath, taskSlug, artifact, ...comment } = a;
  await written(repoPath, taskSlug, () =>
    artifactApi.artifacts(repoPath).saveCommentDraft({ meta: newMutationMeta(), taskSlug, artifact, comment: inputOf(comment), expectedRevision: expectedRevision ?? 0n }),
  );
}

export async function deleteCommentDraft(repo: string, taskSlug: string, artifact: string, anchorId: string, expectedRevision?: bigint): Promise<void> {
  await written(repo, taskSlug, () =>
    artifactApi.artifacts(repo).deleteCommentDraft({ meta: newMutationMeta(), taskSlug, artifact, anchorId, expectedRevision: expectedRevision ?? 0n }),
  );
}

/** Sends the comments as a review file without a session; answers the review file's name. */
export async function sendReview(repo: string, taskSlug: string, artifact: string): Promise<string> {
  return (await written(repo, taskSlug, () => artifactApi.artifacts(repo).sendReview({ meta: newMutationMeta(), taskSlug, artifact }))).review;
}

export async function clearReviewPending(repo: string, taskSlug: string, artifact: string): Promise<void> {
  await written(repo, taskSlug, () => artifactApi.artifacts(repo).clearReviewPending({ meta: newMutationMeta(), taskSlug, artifact }));
}

function provenanceOf(p: WireProvenance | undefined): SessionMessageActionProvenance {
  const k = p?.kind;
  if (k?.case === "artifactComments")
    return { type: "artifact_comments", items: k.value.items.map((i) => ({ artifact: i.artifact, review: i.review, comments_hash: i.commentsHash })) };
  if (k?.case === "reviewApproval") return { type: "review_approval", review_artifact: k.value.reviewArtifact };
  throw new Error("the daemon returned no provenance");
}

const wireProvenance = (p: SessionMessageActionProvenance) =>
  p.type === "artifact_comments"
    ? { kind: { case: "artifactComments" as const, value: { items: p.items.map((i) => ({ artifact: i.artifact, review: i.review, commentsHash: i.comments_hash })) } } }
    : { kind: { case: "reviewApproval" as const, value: { reviewArtifact: p.review_artifact } } };

export async function prepareCommentsPrompt(repo: string, taskSlug: string, artifacts: string[]): Promise<PreparedSessionMessageAction> {
  const reply = await written(repo, taskSlug, () => artifactApi.artifacts(repo).prepareCommentsPrompt({ meta: newMutationMeta(), taskSlug, artifacts }));
  return { text: reply.action?.text ?? "", provenance: provenanceOf(reply.action?.provenance) };
}

export async function prepareReviewApproval(repo: string, taskSlug: string, reviewArtifact: string): Promise<PreparedSessionMessageAction> {
  const reply = await call(() => artifactApi.artifacts(repo).prepareReviewApproval({ meta: newMutationMeta(), taskSlug, reviewArtifact }));
  return { text: reply.action?.text ?? "", provenance: provenanceOf(reply.action?.provenance) };
}

/** The message went to the session: finalize what its prompts carried. */
export async function finalizeMessageActions(repo: string, sessionId: string, taskSlug: string, actions: SessionMessageActionProvenance[]): Promise<void> {
  await written(repo, taskSlug, () => artifactApi.artifacts(repo).finalizeMessageActions({ meta: newMutationMeta(), sessionId, taskSlug, actions: actions.map(wireProvenance) }));
}

// ---- review handoff ---------------------------------------------------------------------------------------

/**
 * Two daemons, one handoff (the plan, S4.5): the source's daemon gives its artifact's text, the target's installs it with the
 * session, and the source's records the outbound half. A failure of that last write is listed with the others; the
 * target already has its session.
 */
export async function sendReviewHandoff(a: {
  sourceRepoPath: string;
  targetRepoPath: string;
  sourceSlug: string;
  sourceSession: string;
  sourceArtifact: string;
  targetSlug: string;
  targetPhase: string;
  harness: string;
  model: string;
  promptExtra: string;
}): Promise<ReviewHandoffResult> {
  // The artifact is copied between two repositories on one machine, and the target's own daemon starts the session.
  if (!sameMachine(a.sourceRepoPath, a.targetRepoPath)) throw new Error("A review handoff needs both tasks on the same machine; these repositories are on different machines.");
  const text = await readArtifactText(a.sourceRepoPath, a.sourceSlug, a.sourceArtifact);
  const installed = await call(() =>
    artifactApi.artifacts(a.targetRepoPath).installReviewHandoff({
      meta: newMutationMeta(),
      sourceRepoPath: machinePath(a.sourceRepoPath),
      sourceSlug: a.sourceSlug,
      sourceSession: a.sourceSession,
      sourceArtifact: a.sourceArtifact,
      sourceText: text,
      targetRepoPath: machinePath(a.targetRepoPath),
      targetSlug: a.targetSlug,
      targetPhase: a.targetPhase,
      harness: a.harness,
      model: a.model,
      promptExtra: a.promptExtra,
      start: true,
    }),
  );
  const record = installed.record;
  if (!record || !installed.started?.session) throw new Error("the daemon returned no handoff");
  const target = handoffOf(record);
  const source: ReviewHandoffRecord = { ...target, direction: "outbound" };
  const errors = [...installed.started.errors, ...installed.errors].map((e) => ({ stage: e.stage, code: e.code, message: e.message }));
  try {
    await written(a.sourceRepoPath, a.sourceSlug, () =>
      artifactApi.artifacts(a.sourceRepoPath).recordOutboundHandoff({
        meta: newMutationMeta(),
        sourceSlug: a.sourceSlug,
        record: { ...record, direction: "outbound" },
      }),
    );
  } catch (e) {
    errors.push({ stage: "outbound_handoff_record", code: "handoff_record_failed", message: e instanceof Error ? e.message : String(e) });
  }
  return {
    target_repo_path: a.targetRepoPath,
    start: installed.started.start,
    errors,
    target_artifact: installed.targetArtifact,
    target_session: installed.started.session as unknown as SessionMeta,
    source_record: source,
    target_record: target,
  };
}
