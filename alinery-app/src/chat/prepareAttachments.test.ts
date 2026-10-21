import { describe, expect, it, vi } from "vitest";
import type { DraftAttachment } from "./attachments";
import { chatThreadAttachmentDir, taskAttachmentDir } from "./attachments";
import { type ChatAttachmentStore, prepareChatAttachments } from "./prepareAttachments";

function store(trailerDir: string, extra: Partial<ChatAttachmentStore> = {}): ChatAttachmentStore {
  return {
    stat: async (path) => ({ name: path.split("/").pop() ?? path, bytes: 4 }),
    copy: async (paths) => ({ copied: paths.map((path) => path.split("/").pop() ?? path), failures: [] }),
    writeBytes: async (fileName) => fileName,
    readImage: async () => ({ mime_type: "image/png", data: "aa" }),
    trailerDir,
    ...extra,
  };
}

const notes: DraftAttachment = {
  id: "f1",
  kind: "file",
  name: "notes.pdf",
  mimeType: "application/pdf",
  bytes: 4,
  sourcePath: "/tmp/notes.pdf",
};

const shot: DraftAttachment = {
  id: "i1",
  kind: "image",
  name: "shot.png",
  mimeType: "image/png",
  bytes: 4,
  previewUrl: "blob:shot",
};

describe("prepareChatAttachments", () => {
  it("copies a file into the task dir and leaves images unread", async () => {
    const dir = taskAttachmentDir("/repo", "task");
    const copy = vi.fn(async () => ({ copied: ["notes.pdf"], failures: [] as string[] }));
    const readImage = vi.fn(async () => ({ mime_type: "image/png", data: "aa" }));
    const prepared = await prepareChatAttachments(store(dir, { copy, readImage }), "see", [notes]);
    expect(copy).toHaveBeenCalledWith(["/tmp/notes.pdf"]);
    expect(readImage).not.toHaveBeenCalled();
    expect(prepared.message).toBe(`see\n\nAttached file: ${dir}/notes.pdf`);
    expect(prepared.images).toEqual([]);
  });

  it("writes a pasted image and attaches it on a chat-thread path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ arrayBuffer: async () => new Uint8Array([1, 2]).buffer })),
    );
    const dir = chatThreadAttachmentDir("/repo", "s-live");
    const writeBytes = vi.fn(async (fileName: string) => fileName);
    const readImage = vi.fn(async () => ({ mime_type: "image/png", data: "aa" }));
    const prepared = await prepareChatAttachments(store(dir, { writeBytes, readImage }), "", [shot]);
    expect(writeBytes).toHaveBeenCalledWith("shot.png", [1, 2]);
    expect(readImage).toHaveBeenCalledWith("shot.png");
    expect(prepared.message).toBe("");
    expect(prepared.images).toEqual([{ type: "image", data: "aa", mimeType: "image/png" }]);
    vi.unstubAllGlobals();
  });

  it("refuses a file that grew past the cap and does not copy it", async () => {
    const copy = vi.fn();
    await expect(
      prepareChatAttachments(store("/tmp", { stat: async () => ({ name: "big.png", bytes: 5 * 1024 * 1024 + 1 }), copy }), "", [
        { ...shot, sourcePath: "/tmp/big.png", previewUrl: undefined },
      ]),
    ).rejects.toThrow(/5 MiB/);
    expect(copy).not.toHaveBeenCalled();
  });

  it("retries a copied attachment after its original source disappears", async () => {
    const prepared = await prepareChatAttachments(store("/copied"), "see", [notes]);
    const unavailableSource = store("/copied", {
      stat: async () => {
        throw new Error("source disappeared");
      },
      copy: async () => {
        throw new Error("source disappeared");
      },
    });
    const retried = await prepareChatAttachments(unavailableSource, "retry", prepared.copied);
    expect(retried.message).toBe("retry\n\nAttached file: /copied/notes.pdf");
  });

  it("surfaces a copy failure", async () => {
    await expect(prepareChatAttachments(store("/tmp", { copy: async () => ({ copied: [], failures: ["notes.pdf — disk full"] }) }), "", [notes])).rejects.toThrow("disk full");
  });
});
