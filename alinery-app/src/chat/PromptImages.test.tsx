import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserRowAttachment } from "./attachments";
import { PromptImageReaderContext, PromptImages } from "./PromptImages";

vi.mock("../WindowChrome", () => ({ WindowControls: () => null }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const shot: UserRowAttachment = { kind: "image", name: "shot.png", mimeType: "image/png", src: "data:image/png;base64,aa" };

describe("PromptImages", () => {
  it("shows nothing when the prompt carried no images", () => {
    const { container } = render(<PromptImages images={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("lays the images out in one row under the text, each opening larger", () => {
    const { container } = render(<PromptImages images={[shot, { ...shot, name: "second.png" }]} />);
    const row = container.querySelector(".chat-prompt-images");
    expect(row?.getAttribute("aria-label")).toBe("2 attached images");
    expect(row?.querySelectorAll("button.chat-prompt-image")).toHaveLength(2);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open shot.png" }));
    const dialog = screen.getByRole("dialog", { name: "shot.png" });
    expect(within(dialog).getByRole("img", { name: "shot.png" }).getAttribute("src")).toBe(shot.src);
  });

  it("reads an image the row knows only by name back from the daemon", async () => {
    const read = vi.fn().mockResolvedValue({ mime_type: "image/jpeg", data: "bb" });
    const { container } = render(
      <PromptImageReaderContext.Provider value={{ scope: "thread:/r/s-a", read }}>
        <PromptImages images={[{ kind: "image", name: "pasted.jpg", mimeType: "image/jpeg" }]} />
      </PromptImageReaderContext.Provider>,
    );
    expect(read).toHaveBeenCalledWith("pasted.jpg");
    await waitFor(() => expect(container.querySelector(".chat-prompt-image img")?.getAttribute("src")).toBe("data:image/jpeg;base64,bb"));
  });

  it("serves a remounted tile from the cache instead of reading the image again", async () => {
    const read = vi.fn().mockResolvedValue({ mime_type: "image/jpeg", data: "bb" });
    const source = { scope: "thread:/r/cache", read };
    const first = render(
      <PromptImageReaderContext.Provider value={source}>
        <PromptImages images={[{ kind: "image", name: "pasted.jpg", mimeType: "image/jpeg" }]} />
      </PromptImageReaderContext.Provider>,
    );
    await waitFor(() => expect(first.container.querySelector(".chat-prompt-image img")).toBeTruthy());
    first.unmount();
    const second = render(
      <PromptImageReaderContext.Provider value={source}>
        <PromptImages images={[{ kind: "image", name: "pasted.jpg", mimeType: "image/jpeg" }]} />
      </PromptImageReaderContext.Provider>,
    );
    await waitFor(() => expect(second.container.querySelector(".chat-prompt-image img")?.getAttribute("src")).toBe("data:image/jpeg;base64,bb"));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reads the same name in another scope as a different image", async () => {
    const read = vi.fn().mockResolvedValue({ mime_type: "image/jpeg", data: "bb" });
    const { container } = render(
      <PromptImageReaderContext.Provider value={{ scope: "thread:/r/other", read }}>
        <PromptImages images={[{ kind: "image", name: "pasted.jpg", mimeType: "image/jpeg" }]} />
      </PromptImageReaderContext.Provider>,
    );
    await waitFor(() => expect(container.querySelector(".chat-prompt-image img")?.getAttribute("src")).toBe("data:image/jpeg;base64,bb"));
    expect(read).toHaveBeenCalledWith("pasted.jpg");
  });

  it("does not guess a name it was never given", async () => {
    const read = vi.fn().mockResolvedValue({ mime_type: "image/png", data: "bb" });
    render(
      <PromptImageReaderContext.Provider value={{ scope: "thread:/r/s-a", read }}>
        <PromptImages images={[{ kind: "image", name: "", mimeType: "image/png" }]} />
      </PromptImageReaderContext.Provider>,
    );
    expect(read).not.toHaveBeenCalled();
    expect(screen.getByRole("img", { name: "Attached image (not available)" })).toBeTruthy();
  });

  it("copies the expanded image to the clipboard as PNG", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { write } });
    const png = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ blob: async () => png }));
    const written: Record<string, Promise<Blob> | Blob>[] = [];
    vi.stubGlobal(
      "ClipboardItem",
      class {
        readonly items: Record<string, Promise<Blob> | Blob>;
        constructor(items: Record<string, Promise<Blob> | Blob>) {
          this.items = items;
          written.push(items);
        }
      },
    );

    render(<PromptImages images={[shot]} />);
    fireEvent.click(screen.getByRole("button", { name: "Open shot.png" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy image" }));

    // The write starts inside the click, with the blob on its way as a promise: awaiting it first would
    // lose the user gesture in the desktop app's WKWebView.
    expect(write).toHaveBeenCalledTimes(1);
    expect(written[0]?.["image/png"]).toBeInstanceOf(Promise);
    await expect(written[0]?.["image/png"]).resolves.toBe(png);
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied image" })).toBeTruthy());
  });

  it("reports a clipboard that refuses images instead of claiming a copy", async () => {
    const write = vi.fn().mockRejectedValue(new Error("no image clipboard"));
    vi.stubGlobal("navigator", { clipboard: { write } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ blob: async () => new Blob([new Uint8Array([1])], { type: "image/png" }) }));
    vi.stubGlobal("ClipboardItem", class {});

    render(<PromptImages images={[shot]} />);
    fireEvent.click(screen.getByRole("button", { name: "Open shot.png" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy image" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Could not copy the image" })).toBeTruthy());
  });
});
