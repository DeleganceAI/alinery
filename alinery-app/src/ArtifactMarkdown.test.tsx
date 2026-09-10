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

  it("renders existing comment counts as named buttons tied to the note without opening the composer", () => {
    const onAddComment = vi.fn((_anchor: ArtifactCommentAnchor) => {});
    const { rerender } = render(<ArtifactMarkdown text={TEXT} comments={[]} draftAnchorIds={[]} onAddComment={onAddComment} />);

    fireEvent.click(commentableBlock());
    const anchor = onAddComment.mock.calls[0][0];
    onAddComment.mockClear();
    const comment: ArtifactComment = {
      id: "c1",
      artifact: "artifact.md",
      ...anchor,
      body: "Existing review note",
      created_at_ms: 1,
    };

    rerender(<ArtifactMarkdown text={TEXT} comments={[comment]} draftAnchorIds={[]} onAddComment={onAddComment} />);

    const count = screen.getByRole("button", { name: "1 comment" });
    const noteId = count.getAttribute("aria-describedby");
    const note = noteId ? document.getElementById(noteId) : null;
    expect(note?.getAttribute("role")).toBe("note");
    expect(note?.textContent).toContain("Existing review note");

    count.focus();
    fireEvent.focusIn(count);
    expect(document.activeElement).toBe(count);
    expect(count.getAttribute("aria-expanded")).toBe("true");
    expect(commentableBlock().classList.contains("comments-open")).toBe(true);
    fireEvent.click(count);
    expect(count.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(count, { key: "Escape" });
    expect(count.getAttribute("aria-expanded")).toBe("false");
    expect(commentableBlock().classList.contains("comments-open")).toBe(false);
    expect(onAddComment).not.toHaveBeenCalled();
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
