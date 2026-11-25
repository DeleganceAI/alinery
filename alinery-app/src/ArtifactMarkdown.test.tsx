import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ArtifactComment, type ArtifactCommentAnchor, ArtifactMarkdown } from "./ArtifactMarkdown";

const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: mermaidMocks,
}));

vi.mock("./WindowChrome", () => ({ WindowControls: () => null }));

function leaveMermaidErrorNodes(id: string): void {
  const wrap = document.createElement("div");
  wrap.id = `d${id}`;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.id = id;
  svg.setAttribute("viewBox", "0 0 2412 512");
  svg.setAttribute("role", "graphics-document");
  svg.setAttribute("aria-roledescription", "error");
  const title = document.createElementNS("http://www.w3.org/2000/svg", "text");
  title.textContent = "Syntax error in text";
  svg.appendChild(title);
  wrap.appendChild(svg);
  document.body.appendChild(wrap);
}

function leftoverMermaidNodes(): Element[] {
  return [...document.querySelectorAll("[id^='artifact-mermaid'], [id^='dartifact-mermaid'], [id^='iartifact-mermaid']")];
}

const REJECTED_FENCE = "```mermaid\nthis is not mermaid\n```";

const TEXT = "A commentable paragraph.";
const COMMENTS: ArtifactComment[] = [];

function commentableBlock(): HTMLElement {
  const block = document.querySelector<HTMLElement>(".commentable-md-block");
  if (!block) throw new Error("commentable markdown block was not rendered");
  return block;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ArtifactMarkdown draft updates", () => {
  it("preserves the markdown DOM node for equal draft IDs and updates it when membership changes", () => {
    const onAddComment = vi.fn((_anchor: ArtifactCommentAnchor) => {});
    const onDiagramZoomOpenChange = vi.fn((_open: boolean) => {});
    const { rerender } = render(
      <ArtifactMarkdown text={TEXT} comments={COMMENTS} draftAnchorIds={[]} onAddComment={onAddComment} onDiagramZoomOpenChange={onDiagramZoomOpenChange} />,
    );

    fireEvent.click(commentableBlock());
    expect(onAddComment).toHaveBeenCalledOnce();
    const anchorId = onAddComment.mock.calls[0][0].anchor_id;

    rerender(<ArtifactMarkdown text={TEXT} comments={COMMENTS} draftAnchorIds={[anchorId]} onAddComment={onAddComment} onDiagramZoomOpenChange={onDiagramZoomOpenChange} />);
    const draftedBlock = commentableBlock();
    expect(draftedBlock.classList.contains("has-draft")).toBe(true);
    expect(draftedBlock.querySelector(".comment-draft-badge")?.textContent).toBe("Draft");

    rerender(<ArtifactMarkdown text={TEXT} comments={COMMENTS} draftAnchorIds={[anchorId]} onAddComment={onAddComment} onDiagramZoomOpenChange={onDiagramZoomOpenChange} />);
    const unchangedBlock = commentableBlock();
    expect(unchangedBlock).toBe(draftedBlock);
    expect(draftedBlock.isConnected).toBe(true);
    expect(unchangedBlock.classList.contains("has-draft")).toBe(true);
    expect(unchangedBlock.querySelector(".comment-draft-badge")?.textContent).toBe("Draft");

    rerender(
      <ArtifactMarkdown text={TEXT} comments={COMMENTS} draftAnchorIds={[`${anchorId}:different`]} onAddComment={onAddComment} onDiagramZoomOpenChange={onDiagramZoomOpenChange} />,
    );
    const changedBlock = commentableBlock();
    expect(changedBlock.classList.contains("has-draft")).toBe(false);
    expect(changedBlock.querySelector(".comment-draft-badge")).toBeNull();

    rerender(
      <ArtifactMarkdown
        text={TEXT}
        comments={COMMENTS}
        draftAnchorIds={[anchorId, `${anchorId}:different`]}
        onAddComment={onAddComment}
        onDiagramZoomOpenChange={onDiagramZoomOpenChange}
      />,
    );
    const expandedBlock = commentableBlock();
    expect(expandedBlock.classList.contains("has-draft")).toBe(true);
    expect(expandedBlock.querySelector(".comment-draft-badge")?.textContent).toBe("Draft");
  });

  it("treats an omitted draft ID list like an empty list", () => {
    const { rerender } = render(<ArtifactMarkdown text={TEXT} />);
    const originalBlock = commentableBlock();

    rerender(<ArtifactMarkdown text={TEXT} draftAnchorIds={[]} />);

    expect(commentableBlock()).toBe(originalBlock);
    expect(originalBlock.isConnected).toBe(true);
  });

  it("marks a commented block with a count that opens its thread, with no popover and no composer", () => {
    const onAddComment = vi.fn((_anchor: ArtifactCommentAnchor) => {});
    const onOpenThread = vi.fn((_anchorId: string) => {});
    const { rerender } = render(<ArtifactMarkdown text={TEXT} comments={[]} draftAnchorIds={[]} onAddComment={onAddComment} onOpenThread={onOpenThread} />);

    fireEvent.click(commentableBlock());
    const anchor = onAddComment.mock.calls[0][0];
    onAddComment.mockClear();
    const comment: ArtifactComment = { id: "c1", artifact: "artifact.md", ...anchor, body: "Existing review note", created_at_ms: 1 };
    // A comment on selected text belongs to the block its selection starts in.
    const onText: ArtifactComment = { ...comment, id: "c2", anchor_id: `text:abc@${anchor.anchor_id}`, anchor_kind: "text", anchor_excerpt: "commentable" };

    rerender(<ArtifactMarkdown text={TEXT} comments={[comment, onText]} draftAnchorIds={[]} onAddComment={onAddComment} onOpenThread={onOpenThread} />);

    expect(commentableBlock().textContent).not.toContain("Existing review note");
    fireEvent.click(screen.getByRole("button", { name: "2 comments" }));
    expect(onOpenThread).toHaveBeenCalledWith(anchor.anchor_id);
    expect(onAddComment).not.toHaveBeenCalled();
  });

  it("offers a comment on exactly the selected text", async () => {
    const onAddComment = vi.fn((_anchor: ArtifactCommentAnchor) => {});
    render(
      <article>
        <ArtifactMarkdown text={"# Title\n\nFirst line here.\n"} comments={[]} draftAnchorIds={[]} onAddComment={onAddComment} />
      </article>,
    );
    const paragraph = screen.getByText("First line here.");
    const range = document.createRange();
    range.setStart(paragraph.firstChild as Text, 6);
    range.setEnd(paragraph.firstChild as Text, 10);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.mouseUp(paragraph);

    fireEvent.click(await screen.findByRole("button", { name: "Comment" }));
    expect(onAddComment).toHaveBeenCalledWith(expect.objectContaining({ anchor_kind: "text", anchor_excerpt: "line", line_start: 3, line_end: 3 }));
    expect(onAddComment.mock.calls[0][0].anchor_id).toMatch(/^text:[0-9a-f]{8}\.0@p:3-3:/);
    // A repeated phrase: the id says which occurrence in the block was selected.
    const text = paragraph.firstChild as Text;
    const second = document.createRange();
    second.setStart(text, text.data.lastIndexOf("e"));
    second.setEnd(text, text.data.lastIndexOf("e") + 1);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(second);
    fireEvent.mouseUp(paragraph);
    fireEvent.click(await screen.findByRole("button", { name: "Comment" }));
    expect(onAddComment.mock.calls[1][0].anchor_id).toMatch(/^text:[0-9a-f]{8}\.2@p:3-3:/);
    // The click that ends a selection is not a comment on the whole block.
    onAddComment.mockClear();
    fireEvent.click(paragraph);
    expect(onAddComment).not.toHaveBeenCalled();
    window.getSelection()?.removeAllRanges();
  });
});

describe("ArtifactMarkdown mermaid leftovers", () => {
  afterEach(() => {
    for (const node of leftoverMermaidNodes()) node.remove();
  });

  it("does not leave mermaid error nodes on document.body", async () => {
    mermaidMocks.render.mockImplementation(async (id: string) => {
      leaveMermaidErrorNodes(id);
      throw new Error("UnknownDiagramError");
    });

    render(<ArtifactMarkdown text={REJECTED_FENCE} />);

    await waitFor(() => expect(document.querySelector(".mermaid-error")).toBeTruthy());
    expect(document.querySelector(".mermaid-error")?.textContent).toContain("Could not render Mermaid diagram.");
    expect(mermaidMocks.initialize).toHaveBeenCalledWith(expect.objectContaining({ suppressErrorRendering: true }));
    expect(leftoverMermaidNodes()).toEqual([]);
  });

  it("removes mermaid temp nodes if the render is cancelled mid-flight", async () => {
    let rejectRender!: (reason: unknown) => void;
    mermaidMocks.render.mockImplementation((id: string) => {
      leaveMermaidErrorNodes(id);
      return new Promise((_, reject) => {
        rejectRender = reject;
      });
    });

    const { unmount } = render(<ArtifactMarkdown text={REJECTED_FENCE} />);
    await waitFor(() => expect(mermaidMocks.render).toHaveBeenCalled());
    expect(leftoverMermaidNodes().length).toBeGreaterThan(0);

    unmount();
    expect(leftoverMermaidNodes()).toEqual([]);

    rejectRender(new Error("UnknownDiagramError"));
    await Promise.resolve();
    expect(leftoverMermaidNodes()).toEqual([]);
  });
});
