import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactCommentAnchor } from "./ArtifactMarkdown";
import { mockIpc } from "./test/mockIpc";
import { useArtifactCommentDrafts } from "./useArtifactCommentDrafts";

// Coverage for PR #169 second review, item 1: the draft hook was the one TaskDetail write
// still resolving against the mutable `active_repo()` global. Its debounce (400ms) outlives
// the component, because <TaskDetail> now remounts on `task:${repoPath}:${slug}` and the
// unmount cleanup flushes immediately — so a repo switch inside that window used to write
// repo A's half-typed draft into repo B's task of the same slug.
//
// Every flush is queued off the pending-write chain, so assertions come after a microtask
// drain (`advanceTimersByTimeAsync`), never straight after the synchronous act().

const anchor = (over: Partial<ArtifactCommentAnchor> = {}): ArtifactCommentAnchor => ({
  anchor_id: "a1",
  anchor_kind: "line",
  anchor_label: "Line 3",
  anchor_excerpt: "the excerpt",
  line_start: 3,
  line_end: 3,
  ...over,
});

const mocks = vi.hoisted(() => ({
  listArtifactCommentDraftsForRepo: vi.fn(),
  saveArtifactCommentDraftForRepo: vi.fn(),
  deleteArtifactCommentDraftForRepo: vi.fn(),
}));

vi.mock("./ipc", () =>
  mockIpc({
    listArtifactCommentDraftsForRepo: mocks.listArtifactCommentDraftsForRepo,
    saveArtifactCommentDraftForRepo: mocks.saveArtifactCommentDraftForRepo,
    deleteArtifactCommentDraftForRepo: mocks.deleteArtifactCommentDraftForRepo,
  }),
);

beforeEach(() => {
  vi.useFakeTimers();
  mocks.listArtifactCommentDraftsForRepo.mockReset().mockResolvedValue([]);
  mocks.saveArtifactCommentDraftForRepo.mockReset().mockResolvedValue(undefined);
  mocks.deleteArtifactCommentDraftForRepo.mockReset().mockResolvedValue(undefined);
});

describe("a draft still inside its debounce window", () => {
  it("flushes on unmount against the repository it was typed under", async () => {
    const { result, unmount } = renderHook(() => useArtifactCommentDrafts("/repo-a", "task-x"));

    act(() => {
      result.current.updateDraft("02-research.md", anchor(), "half-typed");
    });
    // Still debounced: nothing written yet.
    expect(mocks.saveArtifactCommentDraftForRepo).not.toHaveBeenCalled();

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mocks.saveArtifactCommentDraftForRepo).toHaveBeenCalledTimes(1);
    expect(mocks.saveArtifactCommentDraftForRepo).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: "/repo-a", taskSlug: "task-x", artifact: "02-research.md", anchorId: "a1", body: "half-typed" }),
    );
  });

  it("writes to the debounce's own repository once the timer fires", async () => {
    const { result } = renderHook(() => useArtifactCommentDrafts("/repo-a", "task-x"));

    act(() => {
      result.current.updateDraft("02-research.md", anchor(), "typed");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(mocks.saveArtifactCommentDraftForRepo).toHaveBeenCalledWith(expect.objectContaining({ repoPath: "/repo-a", body: "typed" }));
  });
});

describe("switching repository with the same task slug", () => {
  it("flushes the pending draft to the old repo and re-hydrates from the new one", async () => {
    const { result, rerender } = renderHook(({ repo }: { repo: string }) => useArtifactCommentDrafts(repo, "task-x"), { initialProps: { repo: "/repo-a" } });

    act(() => {
      result.current.updateDraft("02-research.md", anchor(), "half-typed");
    });
    rerender({ repo: "/repo-b" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // The queued draft carries repo A, not whichever repository is active at flush time.
    expect(mocks.saveArtifactCommentDraftForRepo).toHaveBeenCalledTimes(1);
    expect(mocks.saveArtifactCommentDraftForRepo).toHaveBeenCalledWith(expect.objectContaining({ repoPath: "/repo-a", body: "half-typed" }));
    // And the remount reads repo B's drafts, never repo A's leftovers.
    expect(mocks.listArtifactCommentDraftsForRepo).toHaveBeenLastCalledWith("/repo-b", "task-x");
  });
});

describe("discarding a draft", () => {
  it("deletes it from the repository the hook was rendered for", async () => {
    const { result } = renderHook(() => useArtifactCommentDrafts("/repo-a", "task-x"));

    await act(async () => {
      await result.current.discardDraft("02-research.md", "a1");
    });

    expect(mocks.deleteArtifactCommentDraftForRepo).toHaveBeenCalledWith("/repo-a", "task-x", "02-research.md", "a1");
  });
});
