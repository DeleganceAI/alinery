import { useCallback, useEffect, useRef, useState } from "react";
import type { ArtifactCommentAnchor } from "./ArtifactMarkdown";
import * as ipc from "./ipc";

const DRAFT_SAVE_DELAY_MS = 400;

export type ArtifactCommentDraft = ArtifactCommentAnchor & {
  artifact: string;
  body: string;
  artifact_hash: string;
  updated_at_ms: number;
  stale: boolean;
};

// A queued draft keeps the repository it was typed under: the debounce can outlive the
// component (TaskDetail remounts on a repo switch, and the cleanup flushes immediately),
// so writing it against whatever repo is active at flush time would land repo A's draft
// in repo B's task of the same slug.
type PendingDraft = {
  repoPath: string;
  taskSlug: string;
  draft: ArtifactCommentDraft;
};

function draftKey(artifact: string, anchorId: string): string {
  return `${artifact}\u0000${anchorId}`;
}

function saveDraft(pending: PendingDraft): Promise<void> {
  const { repoPath, taskSlug, draft } = pending;
  return ipc.saveArtifactCommentDraftForRepo({
    repoPath,
    taskSlug,
    artifact: draft.artifact,
    anchorId: draft.anchor_id,
    anchorKind: draft.anchor_kind,
    anchorLabel: draft.anchor_label,
    anchorExcerpt: draft.anchor_excerpt,
    lineStart: draft.line_start,
    lineEnd: draft.line_end,
    body: draft.body,
  });
}

export function useArtifactCommentDrafts(repoPath: string, taskSlug: string) {
  const [drafts, setDrafts] = useState<ArtifactCommentDraft[]>([]);
  const [draftError, setDraftError] = useState("");
  const draftsRef = useRef<ArtifactCommentDraft[]>([]);
  const timersRef = useRef(new Map<string, number>());
  const pendingRef = useRef(new Map<string, PendingDraft>());
  const inFlightRef = useRef(new Map<string, Promise<void>>());

  const replaceDrafts = useCallback((update: (current: ArtifactCommentDraft[]) => ArtifactCommentDraft[]) => {
    setDrafts((current) => {
      const next = update(current);
      draftsRef.current = next;
      return next;
    });
  }, []);

  const persistPending = useCallback((key: string) => {
    const timer = timersRef.current.get(key);
    if (timer !== undefined) window.clearTimeout(timer);
    timersRef.current.delete(key);
    const pending = pendingRef.current.get(key);
    if (!pending) return inFlightRef.current.get(key) ?? Promise.resolve();
    pendingRef.current.delete(key);

    const previous = inFlightRef.current.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => saveDraft(pending))
      .catch((error) => {
        setDraftError(String(error));
        throw error;
      });
    inFlightRef.current.set(key, current);
    void current
      .finally(() => {
        if (inFlightRef.current.get(key) === current) inFlightRef.current.delete(key);
      })
      .catch(() => {});
    return current;
  }, []);

  useEffect(() => {
    let alive = true;
    draftsRef.current = [];
    setDrafts([]);
    setDraftError("");
    if (repoPath && taskSlug) {
      ipc
        .listArtifactCommentDraftsForRepo(repoPath, taskSlug)
        .then((stored) => {
          if (!alive) return;
          replaceDrafts((current) => {
            const localKeys = new Set(current.map((draft) => draftKey(draft.artifact, draft.anchor_id)));
            return [...stored.filter((draft) => !localKeys.has(draftKey(draft.artifact, draft.anchor_id))), ...current];
          });
        })
        .catch((error) => {
          if (alive) setDraftError(String(error));
        });
    }

    return () => {
      alive = false;
      for (const key of pendingRef.current.keys()) void persistPending(key).catch(() => {});
    };
  }, [persistPending, replaceDrafts, repoPath, taskSlug]);

  const discardDraft = useCallback(
    (artifact: string, anchorId: string) => {
      const key = draftKey(artifact, anchorId);
      const timer = timersRef.current.get(key);
      if (timer !== undefined) window.clearTimeout(timer);
      timersRef.current.delete(key);
      pendingRef.current.delete(key);
      replaceDrafts((current) => current.filter((draft) => draftKey(draft.artifact, draft.anchor_id) !== key));

      const previous = inFlightRef.current.get(key) ?? Promise.resolve();
      const deletion = previous
        .catch(() => {})
        .then(() => ipc.deleteArtifactCommentDraftForRepo(repoPath, taskSlug, artifact, anchorId))
        .catch((error) => {
          setDraftError(String(error));
          throw error;
        });
      inFlightRef.current.set(key, deletion);
      void deletion
        .finally(() => {
          if (inFlightRef.current.get(key) === deletion) inFlightRef.current.delete(key);
        })
        .catch(() => {});
      return deletion;
    },
    [repoPath, replaceDrafts, taskSlug],
  );

  const updateDraft = useCallback(
    (artifact: string, anchor: ArtifactCommentAnchor, body: string) => {
      if (body === "") {
        void discardDraft(artifact, anchor.anchor_id).catch(() => {});
        return;
      }

      const key = draftKey(artifact, anchor.anchor_id);
      const next: ArtifactCommentDraft = {
        ...anchor,
        artifact,
        body,
        artifact_hash: "",
        updated_at_ms: Date.now(),
        stale: false,
      };
      replaceDrafts((current) => [...current.filter((draft) => draftKey(draft.artifact, draft.anchor_id) !== key), next]);
      pendingRef.current.set(key, { repoPath, taskSlug, draft: next });
      const timer = timersRef.current.get(key);
      if (timer !== undefined) window.clearTimeout(timer);
      timersRef.current.set(
        key,
        window.setTimeout(() => {
          void persistPending(key).catch(() => {});
        }, DRAFT_SAVE_DELAY_MS),
      );
    },
    [discardDraft, persistPending, repoPath, replaceDrafts, taskSlug],
  );

  const getDraft = useCallback((artifact: string, anchorId: string) => draftsRef.current.find((draft) => draft.artifact === artifact && draft.anchor_id === anchorId), []);

  return { drafts, draftError, updateDraft, discardDraft, getDraft };
}
