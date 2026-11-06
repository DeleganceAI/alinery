import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactCommentAnchor } from "./ArtifactMarkdown";
import { deleteCommentDraft, saveCommentDraft, useTaskArtifacts } from "./sync/artifacts";

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
  return saveCommentDraft({
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

/**
 * The drafts of one task: the daemon's rows, kept current by its stream (another window's draft shows up here with no poll),
 * with what this window is typing laid over them until the daemon has it.
 */
export function useArtifactCommentDrafts(repoPath: string, taskSlug: string) {
  const live = useTaskArtifacts(repoPath, taskSlug).drafts;
  const liveRef = useRef(live);
  liveRef.current = live;
  // A key in `local` is one this window is editing (a draft) or deleting (null): it wins over the daemon's row.
  const localRef = useRef(new Map<string, ArtifactCommentDraft | null>());
  const [localVersion, setLocalVersion] = useState(0);
  const [draftError, setDraftError] = useState("");
  const timersRef = useRef(new Map<string, number>());
  const pendingRef = useRef(new Map<string, PendingDraft>());
  const inFlightRef = useRef(new Map<string, Promise<void>>());

  const setLocal = useCallback((key: string, draft: ArtifactCommentDraft | null) => {
    localRef.current.set(key, draft);
    setLocalVersion((v) => v + 1);
  }, []);
  /** The daemon has this window's last word on the key: its own row speaks again. */
  const settleLocal = useCallback((key: string) => {
    if (pendingRef.current.has(key) || timersRef.current.has(key) || inFlightRef.current.has(key)) return;
    if (localRef.current.delete(key)) setLocalVersion((v) => v + 1);
  }, []);

  const drafts = useMemo(() => {
    void localVersion;
    const local = localRef.current;
    const kept = live.filter((draft) => !local.has(draftKey(draft.artifact, draft.anchor_id)));
    return [...kept, ...[...local.values()].filter((draft): draft is ArtifactCommentDraft => draft !== null)];
  }, [live, localVersion]);

  const persistPending = useCallback(
    (key: string) => {
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
        .then(
          () => settleLocal(key),
          () => {},
        );
      return current;
    },
    [settleLocal],
  );

  useEffect(() => {
    localRef.current = new Map();
    setLocalVersion((v) => v + 1);
    setDraftError("");
    return () => {
      for (const key of pendingRef.current.keys()) void persistPending(key).catch(() => {});
    };
  }, [persistPending, repoPath, taskSlug]);

  const discardDraft = useCallback(
    (artifact: string, anchorId: string) => {
      const key = draftKey(artifact, anchorId);
      const timer = timersRef.current.get(key);
      if (timer !== undefined) window.clearTimeout(timer);
      timersRef.current.delete(key);
      pendingRef.current.delete(key);
      setLocal(key, null);

      const previous = inFlightRef.current.get(key) ?? Promise.resolve();
      const deletion = previous
        .catch(() => {})
        .then(() => deleteCommentDraft(repoPath, taskSlug, artifact, anchorId))
        .catch((error) => {
          setDraftError(String(error));
          throw error;
        });
      inFlightRef.current.set(key, deletion);
      void deletion
        .finally(() => {
          if (inFlightRef.current.get(key) === deletion) inFlightRef.current.delete(key);
        })
        .then(
          () => settleLocal(key),
          () => {},
        );
      return deletion;
    },
    [repoPath, setLocal, settleLocal, taskSlug],
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
      setLocal(key, next);
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
    [discardDraft, persistPending, repoPath, setLocal, taskSlug],
  );

  const getDraft = useCallback((artifact: string, anchorId: string) => {
    const key = draftKey(artifact, anchorId);
    if (localRef.current.has(key)) return localRef.current.get(key) ?? undefined;
    return liveRef.current.find((draft) => draft.artifact === artifact && draft.anchor_id === anchorId);
  }, []);

  return { drafts, draftError, updateDraft, discardDraft, getDraft };
}
