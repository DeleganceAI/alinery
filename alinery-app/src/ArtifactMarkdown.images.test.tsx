import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ArtifactMarkdown, attachmentNameFor } from "./ArtifactMarkdown";

// Same daemon read path the Attachments tab uses (AttachmentPreview.tsx): BlobService through src/sync.
const reads = vi.hoisted(() => ({
  attachment: vi.fn(async (_repo: string, _taskSlug: string, _name: string) => new Uint8Array(1)),
  node: vi.fn(async (_repo: string, _taskSlug: string, _nodeId: string) => new Uint8Array(1)),
}));
vi.mock("./sync/tasks", async (actual) => ({ ...(await actual<typeof import("./sync/tasks")>()), readAttachmentBytes: reads.attachment }));
vi.mock("./sync/artifacts", async (actual) => ({ ...(await actual<typeof import("./sync/artifacts")>()), readNodeBytes: reads.node }));
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
  render(<ArtifactMarkdown text={"# Report\n\n![qa](attachments/qa-checker-640x360.png)"} repoPath="/repo" taskSlug="task" artifactPath="03-report.md" />);
  await waitFor(() => expect(reads.attachment).toHaveBeenCalledWith("/repo", "task", "qa-checker-640x360.png"));
  await waitFor(() => expect(screen.getByRole("img", { name: "qa" }).getAttribute("src")).toBe("blob:artifact-image"));
});

it("reads a remote repo's attachment through its daemon by the remote repo key", async () => {
  const repo = "alinery+ssh://host/srv/project";
  render(<ArtifactMarkdown text="![qa](attachments/shot.png)" repoPath={repo} taskSlug="task" artifactPath="03-report.md" />);
  await waitFor(() => expect(reads.attachment).toHaveBeenCalledWith(repo, "task", "shot.png"));
  await waitFor(() => expect(screen.getByRole("img", { name: "qa" }).getAttribute("src")).toBe("blob:artifact-image"));
});

it("resolves ../attachments from a nested artifact", async () => {
  render(<ArtifactMarkdown text="![qa](../attachments/shot.png)" repoPath="/repo" taskSlug="task" artifactPath="research/findings.md" />);
  await waitFor(() => expect(reads.attachment).toHaveBeenCalledWith("/repo", "task", "shot.png"));
});

it("reads a tree artifact's attachment by node id and leaves names outside its tree untouched", async () => {
  const repo = "alinery+ssh://host/srv/project";
  const attachmentNodeIds = new Map([["shot.png", "snapshot-shot"]]);
  render(
    <ArtifactMarkdown
      text={"![qa](../attachments/shot.png)\n\n![gone](../attachments/gone.png)"}
      repoPath={repo}
      taskSlug="task"
      artifactPath="research/findings.md"
      attachmentNodeIds={attachmentNodeIds}
    />,
  );
  await waitFor(() => expect(reads.node).toHaveBeenCalledWith(repo, "task", "snapshot-shot"));
  expect(reads.node).toHaveBeenCalledTimes(1);
  expect(reads.attachment).not.toHaveBeenCalled();
  expect(screen.getByRole("img", { name: "gone" }).getAttribute("src")).toBe("../attachments/gone.png");
});

it("leaves absolute http(s) images untouched", () => {
  render(<ArtifactMarkdown text="![remote](https://example.com/a.png)" repoPath="/repo" taskSlug="task" artifactPath="03-report.md" />);
  expect(screen.getByRole("img", { name: "remote" }).getAttribute("src")).toBe("https://example.com/a.png");
  expect(reads.attachment).not.toHaveBeenCalled();
});

it("keeps the alt text and reports the reason when the attachment cannot be read", async () => {
  reads.attachment.mockRejectedValueOnce(new Error("File unavailable"));
  render(<ArtifactMarkdown text="![qa](attachments/gone.png)" repoPath="/repo" taskSlug="task" artifactPath="03-report.md" />);
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
