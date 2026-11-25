import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactCommentsPanel } from "./ArtifactCommentsPanel";
import type { ArtifactComment } from "./ArtifactMarkdown";

vi.mock("./WindowChrome", () => ({ WindowControls: () => null }));

afterEach(cleanup);

const anchor = { anchor_id: "p:3-3:aa", anchor_kind: "p", anchor_label: "Ship it.", anchor_excerpt: "Ship it.", line_start: 3, line_end: 3 };
const later = { ...anchor, anchor_id: "p:9-9:bb", anchor_excerpt: "Later block.", line_start: 9, line_end: 9 };
const comment = (id: string, at: typeof anchor, body: string, created_at_ms: number, author?: string): ArtifactComment => ({
  id,
  artifact: "a.md",
  ...at,
  body,
  created_at_ms,
  author,
});

function panel(props: Partial<Parameters<typeof ArtifactCommentsPanel>[0]> = {}) {
  return (
    <ArtifactCommentsPanel
      comments={[]}
      active={null}
      body=""
      canSave={false}
      placeholder="Add a comment..."
      inputRef={createRef<HTMLTextAreaElement>()}
      focused={null}
      onBodyChange={() => {}}
      onKeyDown={() => {}}
      onSave={() => {}}
      onDiscard={() => {}}
      onClose={() => {}}
      {...props}
    />
  );
}

describe("ArtifactCommentsPanel", () => {
  it("groups comments at one anchor into a thread in document order, replies oldest first", () => {
    const onOpen = vi.fn();
    render(
      panel({
        comments: [comment("c3", later, "On the later block", 5), comment("c2", anchor, "A reply", 20, "sam@example.com"), comment("c1", anchor, "The first word", 10)],
        onOpen,
      }),
    );
    const threads = document.querySelectorAll<HTMLElement>(".comment-thread");
    expect([...threads].map((thread) => thread.dataset.thread)).toEqual(["p:3-3:aa", "p:9-9:bb"]);
    const bodies = [...threads[0].querySelectorAll(".comment-body")].map((body) => body.textContent);
    expect(bodies).toEqual(["The first word", "A reply"]);
    expect(threads[0].querySelectorAll(".comment-entry.reply").length).toBe(1);
    expect(within(threads[0]).getByText("You")).toBeDefined();
    expect(within(threads[0]).getByText("sam")).toBeDefined();

    fireEvent.click(within(threads[0]).getByRole("button", { name: "Reply" }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ anchor_id: "p:3-3:aa" }));
  });

  it("writes inside the thread it replies to, and gives a new anchor its own card", () => {
    const { rerender } = render(panel({ comments: [comment("c1", anchor, "The first word", 10)], active: anchor, body: "x", canSave: true }));
    expect(within(document.querySelector<HTMLElement>(".comment-thread") as HTMLElement).getByPlaceholderText("Reply...")).toBeDefined();

    rerender(panel({ comments: [comment("c1", anchor, "The first word", 10)], active: later }));
    const threads = document.querySelectorAll<HTMLElement>(".comment-thread");
    expect(threads.length).toBe(2);
    expect(within(threads[1]).getByPlaceholderText("Add a comment...")).toBeDefined();
    expect(within(threads[1]).getByText("Later block.")).toBeDefined();
  });

  it("lists a draft left on another anchor, to resume or discard", () => {
    const onOpen = vi.fn();
    const onDiscardDraft = vi.fn();
    render(panel({ drafts: [{ ...later, body: "half a thought" }], onOpen, onDiscardDraft }));
    expect(screen.getByText("half a thought")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ anchor_id: "p:9-9:bb" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onDiscardDraft).toHaveBeenCalledWith("p:9-9:bb");
  });
});
