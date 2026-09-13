/** Caps duplicated from `task.rs` (`MAX_CHAT_IMAGE_BYTES`, `MAX_ATTACHMENT_BYTES`). No FFI share. */
export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_CHAT_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_CHAT_ATTACHMENTS = 8;
export const MAX_CHAT_IMAGES = 4;

const VISION_MIME: Record<string, true> = {
  "image/png": true,
  "image/jpeg": true,
  "image/gif": true,
  "image/webp": true,
};
const VISION_EXT: Record<string, true> = {
  png: true,
  jpg: true,
  jpeg: true,
  gif: true,
  webp: true,
};
const TRAILER_LINE = /^Attached file: (.+)$/;

export type DraftAttachment = {
  id: string;
  kind: "image" | "file";
  name: string;
  mimeType: string;
  bytes: number;
  previewUrl?: string;
  sourcePath?: string;
  copiedName?: string;
};

export type UserRowAttachment = {
  kind: "image" | "file";
  name: string;
  mimeType?: string;
  src?: string;
};

export type StageIncoming = {
  name: string;
  mimeType?: string;
  bytes: number;
};

export type StageResult = { ok: true } | { ok: false; reason: string };

export function classifyAttachment(input: { mimeType?: string; name: string }): "image" | "file" {
  if (input.mimeType) {
    return VISION_MIME[input.mimeType.toLowerCase()] ? "image" : "file";
  }
  const dot = input.name.lastIndexOf(".");
  if (dot < 0 || dot === input.name.length - 1) return "file";
  return VISION_EXT[input.name.slice(dot + 1).toLowerCase()] ? "image" : "file";
}

export function isHttpUrl(value: string): boolean {
  const lower = value.trim().toLowerCase();
  return lower.startsWith("http://") || lower.startsWith("https://");
}

export function canStage(existing: Pick<DraftAttachment, "kind" | "bytes">[], incoming: StageIncoming[]): StageResult[] {
  let total = existing.length;
  let images = existing.filter((item) => item.kind === "image").length;
  return incoming.map((item) => {
    const kind = classifyAttachment(item);
    if (kind === "image" && item.bytes > MAX_CHAT_IMAGE_BYTES) {
      return { ok: false, reason: `Image ${item.name} exceeds 5 MiB` };
    }
    if (kind === "file" && item.bytes > MAX_CHAT_FILE_BYTES) {
      return { ok: false, reason: `File ${item.name} exceeds 25 MiB` };
    }
    if (total >= MAX_CHAT_ATTACHMENTS) {
      return { ok: false, reason: "At most 8 attachments per turn" };
    }
    if (kind === "image" && images >= MAX_CHAT_IMAGES) {
      return { ok: false, reason: "At most 4 images per turn" };
    }
    total += 1;
    if (kind === "image") images += 1;
    return { ok: true };
  });
}

export function buildPromptMessage(caption: string, copiedFiles: { name: string }[], repoPath: string, slug: string): string {
  if (copiedFiles.length === 0) return caption;
  const lines = copiedFiles.map((file) => `Attached file: ${repoPath}/.alinery/tasks/${slug}/artifacts/attachments/${file.name}`);
  if (caption.length === 0) return lines.join("\n");
  return `${caption}\n\n${lines.join("\n")}`;
}

export function parseFileTrailers(text: string): { caption: string; files: { path: string; name: string }[] } {
  const files: { path: string; name: string }[] = [];
  const captionLines: string[] = [];
  for (const line of text.split("\n")) {
    const match = TRAILER_LINE.exec(line);
    if (match) {
      const path = match[1] ?? line;
      const slash = path.lastIndexOf("/");
      files.push({ path, name: slash >= 0 ? path.slice(slash + 1) : path });
    } else {
      captionLines.push(line);
    }
  }
  return { caption: captionLines.join("\n").replace(/^\n+/, "").replace(/\n+$/, ""), files };
}

export function draftToRowAttachments(attachments: DraftAttachment[]): UserRowAttachment[] {
  return attachments.map((item) => ({
    kind: item.kind,
    name: item.name,
    mimeType: item.mimeType,
    ...(item.previewUrl ? { src: item.previewUrl } : {}),
  }));
}

export function revokeDraftPreviewUrls(attachments: DraftAttachment[]): void {
  for (const item of attachments) {
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  }
}
