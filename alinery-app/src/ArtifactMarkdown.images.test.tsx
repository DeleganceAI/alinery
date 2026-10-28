import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ArtifactMarkdown, attachmentNameFor } from "./ArtifactMarkdown";

// Repro for #159. Same ipc seam the Attachments tab uses (AttachmentPreview.tsx).
const ipc = vi.hoisted(() => ({
  readAttachmentImage: vi.fn(async (_taskSlug: string, _name: string, _nodeId?: string) => new ArrayBuffer(1)),
}));
vi.mock("./ipc", () => ipc);
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: vi.fn() } }));
vi.mock("./WindowChrome", () => ({ WindowControls: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:artifact-image"), revokeObjectURL: vi.fn() });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("resolves a relative attachment image against the artifact's directory", async () => {
  // Proposed props: taskSlug (owner of the attachments dir) + artifactPath (artifact name relative to artifacts/).
  render(<ArtifactMarkdown text={"# Report\n\n![qa](attachments/qa-checker-640x360.png)"} taskSlug="task" artifactPath="03-report.md" />);
  await waitFor(() => expect(ipc.readAttachmentImage).toHaveBeenCalledWith("task", "qa-checker-640x360.png", undefined));
  await waitFor(() => expect(screen.getByRole("img", { name: "qa" }).getAttribute("src")).toBe("blob:artifact-image"));
});

it("resolves ../attachments from a nested artifact", async () => {
  render(<ArtifactMarkdown text="![qa](../attachments/shot.png)" taskSlug="task" artifactPath="research/findings.md" />);
  await waitFor(() => expect(ipc.readAttachmentImage).toHaveBeenCalledWith("task", "shot.png", undefined));
});

it("leaves absolute http(s) images untouched", () => {
  render(<ArtifactMarkdown text="![remote](https://example.com/a.png)" taskSlug="task" artifactPath="03-report.md" />);
  expect(screen.getByRole("img", { name: "remote" }).getAttribute("src")).toBe("https://example.com/a.png");
  expect(ipc.readAttachmentImage).not.toHaveBeenCalled();
});

it("keeps the alt text and reports the reason when the attachment cannot be read", async () => {
  ipc.readAttachmentImage.mockRejectedValueOnce(new Error("File unavailable"));
  render(<ArtifactMarkdown text="![qa](attachments/gone.png)" taskSlug="task" artifactPath="03-report.md" />);
  await waitFor(() => expect(screen.getByRole("img", { name: "qa" }).getAttribute("title")).toContain("File unavailable"));
  expect(screen.getByRole("img", { name: "qa" }).hasAttribute("src")).toBe(false);
});

it("resolves only attachments/<name> under the artifact's directory", () => {
  expect(attachmentNameFor("03-report.md", "attachments/a%20b.png")).toBe("a b.png");
  expect(attachmentNameFor("", "./attachments/x.png")).toBe("x.png");
  expect(attachmentNameFor("research/findings.md", "../attachments/x.png")).toBe("x.png");
  expect(attachmentNameFor("research/findings.md", "attachments/x.png")).toBeNull();
  expect(attachmentNameFor("03-report.md", "attachments/../../x.png")).toBeNull();
  expect(attachmentNameFor("03-report.md", "attachments/sub/x.png")).toBeNull();
  expect(attachmentNameFor("03-report.md", "/abs/attachments/x.png")).toBeNull();
  expect(attachmentNameFor("03-report.md", "https://example.com/attachments/x.png")).toBeNull();
  expect(attachmentNameFor("03-report.md", "attachments/%E0%A4%A.png")).toBeNull();
});
