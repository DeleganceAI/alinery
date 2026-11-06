import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactCommentAnchor } from "./ArtifactMarkdown";
import { fakeArtifacts } from "./test/artifactHooks";
import { type ArtifactCommentDraft, useArtifactCommentDrafts } from "./useArtifactCommentDrafts";

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

vi.mock("./sync/artifacts", async (actual) => (await import("./test/artifactHooks")).artifactHooks(await actual()));

beforeEach(() => {
  vi.useFakeTimers();
  fakeArtifacts.reset();
});

const liveDraft = (over: Partial<ArtifactCommentDraft> = {}): ArtifactCommentDraft => ({
  ...anchor(),
  artifact: "02-research.md",
  body: "from elsewhere",
  artifact_hash: "h",
  updated_at_ms: 1,
  stale: false,
  ...over,
});

describe("drafts the daemon holds", () => {
  it("shows a draft another window saved, with no poll", () => {
    const { result } = renderHook(() => useArtifactCommentDrafts("/repo-a", "task-x"));
    expect(result.current.drafts).toEqual([]);
    act(() => fakeArtifacts.set("task-x", { drafts: [liveDraft()] }));
    expect(result.current.drafts.map((d) => d.body)).toEqual(["from elsewhere"]);
    expect(result.current.getDraft("02-research.md", "a1")?.body).toBe("from elsewhere");
  });

  it("lets what is being typed win over the daemon's row until it is saved, then the row speaks again", async () => {
    fakeArtifacts.set("task-x", { drafts: [liveDraft()] });
    const { result } = renderHook(() => useArtifactCommentDrafts("/repo-a", "task-x"));
    act(() => result.current.updateDraft("02-research.md", anchor(), "mine"));
    expect(result.current.drafts.map((d) => d.body)).toEqual(["mine"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(result.current.drafts.map((d) => d.body)).toEqual(["mine"]);
    act(() => fakeArtifacts.set("task-x", { drafts: [liveDraft({ body: "newer elsewhere" })] }));
    expect(result.current.drafts.map((d) => d.body)).toEqual(["newer elsewhere"]);
  });
});

describe("a draft still inside its debounce window", () => {
  it("flushes on unmount against the repository it was typed under", async () => {
    const { result, unmount } = renderHook(() => useArtifactCommentDrafts("/repo-a", "task-x"));

    act(() => {
      result.current.updateDraft("02-research.md", anchor(), "half-typed");
    });
    // Still debounced: nothing written yet.
    expect(fakeArtifacts.saveDraft).not.toHaveBeenCalled();

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fakeArtifacts.saveDraft).toHaveBeenCalledTimes(1);
    expect(fakeArtifacts.saveDraft).toHaveBeenCalledWith(
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

    expect(fakeArtifacts.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ repoPath: "/repo-a", body: "typed" }));
  });
});

describe("switching repository with the same task slug", () => {
  it("flushes the pending draft to the old repo", async () => {
    const { result, rerender } = renderHook(({ repo }: { repo: string }) => useArtifactCommentDrafts(repo, "task-x"), { initialProps: { repo: "/repo-a" } });

    act(() => {
      result.current.updateDraft("02-research.md", anchor(), "half-typed");
    });
    rerender({ repo: "/repo-b" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // The queued draft carries repo A, not whichever repository is active at flush time.
    expect(fakeArtifacts.saveDraft).toHaveBeenCalledTimes(1);
    expect(fakeArtifacts.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ repoPath: "/repo-a", body: "half-typed" }));
  });
});

describe("discarding a draft", () => {
  it("deletes it from the repository the hook was rendered for", async () => {
    const { result } = renderHook(() => useArtifactCommentDrafts("/repo-a", "task-x"));

    await act(async () => {
      await result.current.discardDraft("02-research.md", "a1");
    });

    expect(fakeArtifacts.deleteDraft).toHaveBeenCalledWith("/repo-a", "task-x", "02-research.md", "a1");
  });
});
