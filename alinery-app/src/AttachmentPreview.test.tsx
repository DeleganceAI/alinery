import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AttachmentPreview } from "./AttachmentPreview";

const ipc = vi.hoisted(() => ({
  revealItemInDir: vi.fn(async (_path: string) => {}),
}));
const reads = vi.hoisted(() => ({
  attachment: vi.fn<(repo: string, taskSlug: string, name: string) => Promise<Uint8Array>>(),
  node: vi.fn<(repo: string, taskSlug: string, nodeId: string) => Promise<Uint8Array>>(),
}));
vi.mock("./ipc", () => ipc);
vi.mock("./sync/tasks", async (actual) => ({ ...(await actual<typeof import("./sync/tasks")>()), readAttachmentBytes: reads.attachment }));
vi.mock("./sync/artifacts", async (actual) => ({ ...(await actual<typeof import("./sync/artifacts")>()), readNodeBytes: reads.node }));

beforeEach(() => {
  vi.clearAllMocks();
  let imageId = 0;
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => `blob:preview-${++imageId}`), revokeObjectURL: vi.fn() });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("does not display an earlier attachment when its image finishes loading after a switch", async () => {
  let finishEarlier!: (bytes: Uint8Array) => void;
  reads.attachment.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishEarlier = resolve;
      }),
  );
  reads.attachment.mockResolvedValueOnce(new Uint8Array(1));
  const { rerender } = render(<AttachmentPreview taskSlug="first" name="first.png" repoPath="/repo" />);
  rerender(<AttachmentPreview taskSlug="second" name="second.png" repoPath="/repo" />);
  const image = await screen.findByRole("img", { name: "second.png" });
  await act(async () => finishEarlier(new Uint8Array(2)));
  expect(screen.queryByRole("img", { name: "first.png" })).toBeNull();
  expect(screen.getByRole("img", { name: "second.png" })).toBe(image);
  expect(image.getAttribute("src")).toBe("blob:preview-1");
});

it("keeps the original file accessible if image loading fails", async () => {
  reads.attachment.mockRejectedValueOnce(new Error("File unavailable"));
  render(<AttachmentPreview taskSlug="task" name="broken.png" repoPath="/repo" />);
  expect(await screen.findByText(/File unavailable/)).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Show broken.png in folder" })));
  expect(ipc.revealItemInDir).toHaveBeenCalledWith("/repo/.alinery/tasks/task/artifacts/attachments/broken.png");
});

it("reports images the browser cannot decode instead of leaving a broken thumbnail", async () => {
  reads.attachment.mockResolvedValueOnce(new Uint8Array(1));
  render(<AttachmentPreview taskSlug="task" name="corrupt.png" repoPath="/repo" />);
  fireEvent.error(await screen.findByRole("img", { name: "corrupt.png" }));
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("could not be decoded");
});

it("reads a tree node's image by its node id", async () => {
  reads.node.mockResolvedValueOnce(new Uint8Array(1));
  render(<AttachmentPreview taskSlug="task" name="evidence.png" nodeId="n1" repoPath="/repo" revealBelow="tasks/child/artifacts/attachments/evidence.png" />);
  expect(await screen.findByRole("img", { name: "evidence.png" })).toBeTruthy();
  expect(reads.node).toHaveBeenCalledWith("/repo", "task", "n1");
  expect(reads.attachment).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Show evidence.png in folder" })));
  expect(ipc.revealItemInDir).toHaveBeenCalledWith("/repo/.alinery/tasks/child/artifacts/attachments/evidence.png");
});
