// A task's artifacts, comments and drafts of src/sync/artifacts.ts, for view tests whose subject is the view, not the stream.
// A test states what the task holds with `fakeArtifacts.set(slug, {...})` (and may call it again: a delta arriving, every mounted
// `useTaskArtifacts` reads again). Bodies come from `fakeArtifacts.texts` / `nodeTexts` / `nodeBytes`. The writes are spies that
// change the stored rows the way the daemon's stream would, so a view that shows the result of a write sees it. The stream itself
// is tested in sync/artifacts.test.tsx.
//
//     vi.mock("../sync/artifacts", async (actual) => (await import("../test/artifactHooks")).artifactHooks(await actual()));
import { useEffect, useState } from "react";
import { vi } from "vitest";
import type * as Artifacts from "../sync/artifacts";
import type { TaskArtifacts } from "../sync/artifacts";
import type { SessionMessageActionProvenance } from "../types";

const EMPTY: TaskArtifacts = { ready: true, items: [], tree: [], comments: [], drafts: [], pending: [] };
const NOT_READY: TaskArtifacts = { ...EMPTY, ready: false };

const rows = new Map<string, TaskArtifacts>();
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of [...listeners]) l();
};
const rowsOf = (slug: string) => rows.get(slug) ?? EMPTY;
const update = (slug: string, patch: Partial<TaskArtifacts>) => {
  rows.set(slug, { ...rowsOf(slug), ...patch, ready: true });
  emit();
};

const missing = (what: string) => Promise.reject(new Error(`no ${what} in fakeArtifacts`));

export const fakeArtifacts = {
  /** What a task holds; a field left out keeps its value. */
  set(slug: string, patch: Partial<Omit<TaskArtifacts, "ready">>) {
    update(slug, patch);
  },
  /** The task's stream has not delivered yet. */
  notReady(slug: string) {
    rows.set(slug, NOT_READY);
    emit();
  },
  get: (slug: string) => rowsOf(slug),
  /** Artifact bodies by name. */
  texts: {} as Record<string, string>,
  /** Tree node bodies by id. */
  nodeTexts: {} as Record<string, string>,
  nodeBytes: {} as Record<string, Uint8Array>,
  readArtifact: vi.fn(async (_repo: string, _slug: string, name: string) => (name in fakeArtifacts.texts ? fakeArtifacts.texts[name] : missing(`artifact ${name}`))),
  readNode: vi.fn(async (_repo: string, _slug: string, id: string) => (id in fakeArtifacts.nodeTexts ? fakeArtifacts.nodeTexts[id] : missing(`node ${id}`))),
  readBytes: vi.fn(async (_repo: string, _slug: string, id: string) => fakeArtifacts.nodeBytes[id] ?? missing(`node bytes ${id}`)),
  addComment: vi.fn(async (a: Parameters<typeof Artifacts.addComment>[0]) => {
    const id = `c${rowsOf(a.taskSlug).comments.length + 1}`;
    update(a.taskSlug, {
      comments: [
        ...rowsOf(a.taskSlug).comments,
        {
          id,
          artifact: a.artifact,
          anchor_id: a.anchorId,
          anchor_kind: a.anchorKind,
          anchor_label: a.anchorLabel,
          anchor_excerpt: a.anchorExcerpt,
          line_start: a.lineStart,
          line_end: a.lineEnd,
          body: a.body,
          created_at_ms: 1,
        },
      ],
    });
    return id;
  }),
  saveDraft: vi.fn(async (a: Parameters<typeof Artifacts.saveCommentDraft>[0]) => {
    const others = rowsOf(a.taskSlug).drafts.filter((d) => !(d.artifact === a.artifact && d.anchor_id === a.anchorId));
    update(a.taskSlug, {
      drafts: [
        ...others,
        {
          artifact: a.artifact,
          anchor_id: a.anchorId,
          anchor_kind: a.anchorKind,
          anchor_label: a.anchorLabel,
          anchor_excerpt: a.anchorExcerpt,
          line_start: a.lineStart,
          line_end: a.lineEnd,
          body: a.body,
          artifact_hash: "",
          updated_at_ms: 1,
          stale: false,
        },
      ],
    });
  }),
  deleteDraft: vi.fn(async (_repo: string, slug: string, artifact: string, anchorId: string) => {
    update(slug, { drafts: rowsOf(slug).drafts.filter((d) => !(d.artifact === artifact && d.anchor_id === anchorId)) });
  }),
  sendReview: vi.fn(async (_repo: string, _slug: string, _artifact: string) => "review.md"),
  clearPending: vi.fn(async (_repo: string, slug: string, artifact: string) => {
    update(slug, { pending: rowsOf(slug).pending.filter((p) => p.artifact !== artifact) });
  }),
  prepareComments: vi.fn(async (_repo: string, _slug: string, artifacts: string[]) => ({
    text: "Address the review comments.",
    provenance: {
      type: "artifact_comments",
      items: artifacts.map((artifact) => ({ artifact, review: `${artifact}.comments.md`, comments_hash: "h" })),
    } as SessionMessageActionProvenance,
  })),
  prepareApproval: vi.fn(async (_repo: string, _slug: string, reviewArtifact: string) => ({
    text: "Approved.",
    provenance: { type: "review_approval", review_artifact: reviewArtifact } as SessionMessageActionProvenance,
  })),
  finalize: vi.fn(async (_repo: string, _sessionId: string, _slug: string, _actions: SessionMessageActionProvenance[]) => {}),
  sendHandoff: vi.fn(async (_a: Parameters<typeof Artifacts.sendReviewHandoff>[0]): Promise<Awaited<ReturnType<typeof Artifacts.sendReviewHandoff>>> => {
    throw new Error("sendHandoff was not stubbed");
  }),
  reset() {
    rows.clear();
    fakeArtifacts.texts = {};
    fakeArtifacts.nodeTexts = {};
    fakeArtifacts.nodeBytes = {};
    for (const spy of [
      fakeArtifacts.readArtifact,
      fakeArtifacts.readNode,
      fakeArtifacts.readBytes,
      fakeArtifacts.addComment,
      fakeArtifacts.saveDraft,
      fakeArtifacts.deleteDraft,
      fakeArtifacts.sendReview,
      fakeArtifacts.clearPending,
      fakeArtifacts.prepareComments,
      fakeArtifacts.prepareApproval,
      fakeArtifacts.finalize,
    ]) {
      spy.mockClear();
    }
    fakeArtifacts.sendHandoff.mockReset().mockRejectedValue(new Error("sendHandoff was not stubbed"));
    emit();
  },
};

export function artifactHooks(actual: typeof Artifacts): typeof Artifacts {
  return {
    ...actual,
    useTaskArtifacts(_repo, slug) {
      const [, tick] = useState(0);
      useEffect(() => {
        const l = () => tick((n) => n + 1);
        listeners.add(l);
        return () => {
          listeners.delete(l);
        };
      }, []);
      return slug ? rowsOf(slug) : NOT_READY;
    },
    readArtifactText: (repo, slug, name) => fakeArtifacts.readArtifact(repo, slug, name),
    readNodeText: (repo, slug, id) => fakeArtifacts.readNode(repo, slug, id),
    readNodeBytes: (repo, slug, id) => fakeArtifacts.readBytes(repo, slug, id),
    addComment: (a) => fakeArtifacts.addComment(a),
    saveCommentDraft: (a) => fakeArtifacts.saveDraft(a),
    deleteCommentDraft: (repo, slug, artifact, anchorId) => fakeArtifacts.deleteDraft(repo, slug, artifact, anchorId),
    sendReview: (repo, slug, artifact) => fakeArtifacts.sendReview(repo, slug, artifact),
    clearReviewPending: (repo, slug, artifact) => fakeArtifacts.clearPending(repo, slug, artifact),
    prepareCommentsPrompt: (repo, slug, artifacts) => fakeArtifacts.prepareComments(repo, slug, artifacts),
    prepareReviewApproval: (repo, slug, artifact) => fakeArtifacts.prepareApproval(repo, slug, artifact),
    finalizeMessageActions: (repo, sessionId, slug, actions) => fakeArtifacts.finalize(repo, sessionId, slug, actions),
    sendReviewHandoff: (a) => fakeArtifacts.sendHandoff(a),
  };
}
