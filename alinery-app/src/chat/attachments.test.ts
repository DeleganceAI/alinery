import { describe, expect, it } from "vitest";
import {
  buildPromptMessage,
  canStage,
  classifyAttachment,
  isHttpUrl,
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_FILE_BYTES,
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_IMAGES,
  parseFileTrailers,
} from "./attachments";

describe("classifyAttachment", () => {
  it("treats png/jpeg/gif/webp as images by MIME", () => {
    expect(classifyAttachment({ mimeType: "image/png", name: "a" })).toBe("image");
    expect(classifyAttachment({ mimeType: "image/jpeg", name: "a" })).toBe("image");
    expect(classifyAttachment({ mimeType: "image/gif", name: "a" })).toBe("image");
    expect(classifyAttachment({ mimeType: "image/webp", name: "a" })).toBe("image");
  });

  it("treats png/jpeg/gif/webp as images by extension when MIME is missing", () => {
    expect(classifyAttachment({ name: "shot.PNG" })).toBe("image");
    expect(classifyAttachment({ name: "shot.jpg" })).toBe("image");
    expect(classifyAttachment({ name: "shot.jpeg" })).toBe("image");
    expect(classifyAttachment({ name: "shot.gif" })).toBe("image");
    expect(classifyAttachment({ name: "shot.webp" })).toBe("image");
  });

  it("treats svg/heic/pdf/zip/mp4/unknown as files, never silent image converts", () => {
    expect(classifyAttachment({ mimeType: "image/svg+xml", name: "icon.svg" })).toBe("file");
    expect(classifyAttachment({ name: "photo.heic" })).toBe("file");
    expect(classifyAttachment({ mimeType: "application/pdf", name: "notes.pdf" })).toBe("file");
    expect(classifyAttachment({ name: "archive.zip" })).toBe("file");
    expect(classifyAttachment({ mimeType: "video/mp4", name: "clip.mp4" })).toBe("file");
    expect(classifyAttachment({ name: "mystery" })).toBe("file");
  });
});

describe("isHttpUrl", () => {
  it("skips http(s) strings used as attachment paths", () => {
    expect(isHttpUrl("https://example.com/a.png")).toBe(true);
    expect(isHttpUrl("http://example.com/a.png")).toBe(true);
    expect(isHttpUrl("/tmp/a.png")).toBe(false);
    expect(isHttpUrl("shot.png")).toBe(false);
  });
});

describe("canStage", () => {
  const image = (name: string, bytes: number) => ({ name, mimeType: "image/png", bytes });
  const file = (name: string, bytes: number) => ({ name, mimeType: "application/pdf", bytes });

  it("rejects an image over 5 MiB and keeps a sibling that passed", () => {
    const result = canStage([], [image("ok.png", 10), image("big.png", MAX_CHAT_IMAGE_BYTES + 1)]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ ok: true });
    expect(result[1]).toMatchObject({ ok: false });
    expect(result[1] && result[1].ok === false && result[1].reason.length).toBeGreaterThan(0);
  });

  it("rejects a file over 25 MiB", () => {
    const result = canStage([], [file("huge.pdf", MAX_CHAT_FILE_BYTES + 1)]);
    expect(result[0]).toMatchObject({ ok: false });
  });

  it("rejects a 9th attachment and a 5th image", () => {
    const eightFiles = Array.from({ length: MAX_CHAT_ATTACHMENTS }, (_, i) => file(`n${i}.pdf`, 10));
    const ninth = canStage(
      eightFiles.map((item, i) => ({
        id: String(i),
        kind: "file" as const,
        name: item.name,
        mimeType: item.mimeType,
        bytes: item.bytes,
      })),
      [file("too-many.pdf", 10)],
    );
    expect(ninth[0]).toMatchObject({ ok: false });

    const fourImages = Array.from({ length: MAX_CHAT_IMAGES }, (_, i) => ({
      id: String(i),
      kind: "image" as const,
      name: `i${i}.png`,
      mimeType: "image/png",
      bytes: 10,
    }));
    const fifth = canStage(fourImages, [image("fifth.png", 10)]);
    expect(fifth[0]).toMatchObject({ ok: false });
  });
});

describe("buildPromptMessage / parseFileTrailers", () => {
  const repo = "/repo";
  const slug = "task";
  const line = (name: string) => `Attached file: ${repo}/.alinery/tasks/${slug}/artifacts/attachments/${name}`;

  it("returns the caption as-is when there are no files", () => {
    expect(buildPromptMessage("", [], repo, slug)).toBe("");
    expect(buildPromptMessage("hello", [], repo, slug)).toBe("hello");
  });

  it("joins files-only and caption-plus-files with a blank line before trailers", () => {
    expect(buildPromptMessage("", [{ name: "a.pdf" }], repo, slug)).toBe(line("a.pdf"));
    expect(buildPromptMessage("hello", [{ name: "a.pdf" }, { name: "b.pdf" }], repo, slug)).toBe(`hello\n\n${line("a.pdf")}\n${line("b.pdf")}`);
  });

  it("round-trips trailer lines and leaves unrelated body text", () => {
    const assembled = buildPromptMessage("keep me", [{ name: "a.pdf" }, { name: "b.pdf" }], repo, slug);
    expect(parseFileTrailers(assembled)).toEqual({
      caption: "keep me",
      files: [
        { path: `${repo}/.alinery/tasks/${slug}/artifacts/attachments/a.pdf`, name: "a.pdf" },
        { path: `${repo}/.alinery/tasks/${slug}/artifacts/attachments/b.pdf`, name: "b.pdf" },
      ],
    });
    expect(parseFileTrailers("just text")).toEqual({ caption: "just text", files: [] });
    expect(parseFileTrailers("Not a trailer: Attached file: /nope.pdf\nAttached file: /repo/.alinery/tasks/task/artifacts/attachments/real.pdf")).toEqual({
      caption: "Not a trailer: Attached file: /nope.pdf",
      files: [{ path: "/repo/.alinery/tasks/task/artifacts/attachments/real.pdf", name: "real.pdf" }],
    });
  });
});
