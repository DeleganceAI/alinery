import type { ImageContent } from "../ompRpc";
import { buildPromptMessage, canStage, type DraftAttachment } from "./attachments";

export type PreparedChatSend = {
  message: string;
  images: ImageContent[];
  copied: DraftAttachment[];
};

/** Where a turn's files are copied and how the model is told to read them. */
export type ChatAttachmentStore = {
  stat(path: string): Promise<{ name: string; bytes: number }>;
  copy(paths: string[]): Promise<{ copied: string[]; failures: string[] }>;
  writeBytes(fileName: string, bytes: number[]): Promise<string>;
  readImage(name: string): Promise<{ mime_type: string; data: string }>;
  trailerDir: string;
};

async function blobBytes(previewUrl: string): Promise<number[]> {
  const response = await fetch(previewUrl);
  return Array.from(new Uint8Array(await response.arrayBuffer()));
}

/** Copy staged files into `store`, then build the prompt trailers and image parts. */
export async function prepareChatAttachments(store: ChatAttachmentStore, caption: string, attachments: DraftAttachment[]): Promise<PreparedChatSend> {
  const restated: DraftAttachment[] = [];
  for (const item of attachments) {
    if (item.sourcePath) {
      const stat = await store.stat(item.sourcePath);
      restated.push({ ...item, name: stat.name, bytes: stat.bytes });
    } else {
      restated.push(item);
    }
  }
  const staged = canStage(
    [],
    restated.map((item) => ({ name: item.name, mimeType: item.mimeType, bytes: item.bytes })),
  );
  const failed = staged.find((item) => item.ok === false);
  if (failed && failed.ok === false) throw new Error(failed.reason);

  const copiedNames = new Map<string, string>();
  const pathItems = restated.filter((item) => item.sourcePath && !item.copiedName);
  const blobItems = restated.filter((item) => !item.sourcePath && item.previewUrl && !item.copiedName);
  for (const item of restated) {
    if (item.copiedName) copiedNames.set(item.id, item.copiedName);
  }
  if (pathItems.length > 0) {
    const result = await store.copy(pathItems.map((item) => item.sourcePath as string));
    if (result.failures.length > 0 || result.copied.length !== pathItems.length) {
      throw new Error(result.failures[0] ?? "Could not copy attachments");
    }
    pathItems.forEach((item, index) => {
      const name = result.copied[index];
      if (name) copiedNames.set(item.id, name);
    });
  }
  for (const item of blobItems) {
    if (!item.previewUrl) continue;
    copiedNames.set(item.id, await store.writeBytes(item.name, await blobBytes(item.previewUrl)));
  }

  const copied = restated.map((item) => ({ ...item, copiedName: copiedNames.get(item.id) ?? item.copiedName }));
  const files = copied.filter((item) => item.kind === "file").map((item) => ({ name: item.copiedName ?? item.name }));
  const images: ImageContent[] = [];
  for (const item of copied) {
    if (item.kind !== "image") continue;
    const name = item.copiedName ?? item.name;
    const image = await store.readImage(name);
    images.push({ type: "image", data: image.data, mimeType: image.mime_type });
  }
  return { message: buildPromptMessage(caption, files, store.trailerDir), images, copied };
}
