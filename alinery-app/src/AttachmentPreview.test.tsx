import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AttachmentPreview } from "./AttachmentPreview";

const ipc = vi.hoisted(() => ({
  readAttachmentImage: vi.fn<(taskSlug: string, name: string, nodeId?: string) => Promise<ArrayBuffer>>(),
  attachmentPath: vi.fn(async () => "/repo/task/attachments/broken.png"),
  revealItemInDir: vi.fn(async () => {}),
}));
vi.mock("./ipc", () => ipc);

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
  let finishEarlier!: (bytes: ArrayBuffer) => void;
  ipc.readAttachmentImage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishEarlier = resolve;
      }),
  );
  ipc.readAttachmentImage.mockResolvedValueOnce(new ArrayBuffer(1));
  const { rerender } = render(<AttachmentPreview taskSlug="first" name="first.png" />);
  rerender(<AttachmentPreview taskSlug="second" name="second.png" />);
  const image = await screen.findByRole("img", { name: "second.png" });
  await act(async () => finishEarlier(new ArrayBuffer(2)));
  expect(screen.queryByRole("img", { name: "first.png" })).toBeNull();
  expect(screen.getByRole("img", { name: "second.png" })).toBe(image);
  expect(image.getAttribute("src")).toBe("blob:preview-1");
});

it("keeps the original file accessible if image loading fails", async () => {
  ipc.readAttachmentImage.mockRejectedValueOnce(new Error("File unavailable"));
  render(<AttachmentPreview taskSlug="task" name="broken.png" />);
  expect(await screen.findByText(/File unavailable/)).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Show broken.png in folder" })));
  expect(ipc.revealItemInDir).toHaveBeenCalledWith("/repo/task/attachments/broken.png");
});

it("reports images the browser cannot decode instead of leaving a broken thumbnail", async () => {
  ipc.readAttachmentImage.mockResolvedValueOnce(new ArrayBuffer(1));
  render(<AttachmentPreview taskSlug="task" name="corrupt.png" />);
  fireEvent.error(await screen.findByRole("img", { name: "corrupt.png" }));
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("could not be decoded");
});
