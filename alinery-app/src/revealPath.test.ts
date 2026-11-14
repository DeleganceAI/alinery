import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ipc from "./ipc";
import { revealActionLabel, revealPath, setRevealRepo } from "./revealPath";

vi.mock("./ipc", async () => {
  const { mockIpc } = await vi.importActual<typeof import("./test/mockIpc")>("./test/mockIpc");
  return mockIpc({ revealItemInDir: vi.fn() });
});

const writeText = vi.fn();
beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  vi.mocked(ipc.revealItemInDir).mockResolvedValue();
  writeText.mockResolvedValue(undefined);
});
afterEach(() => {
  setRevealRepo("");
  vi.clearAllMocks();
});

describe("revealPath", () => {
  it("shows a local file in the file manager", async () => {
    setRevealRepo("/Users/me/repo");
    expect(revealActionLabel()).toBe("Show in folder");
    await revealPath("/Users/me/repo/.alinery/a.png");
    expect(ipc.revealItemInDir).toHaveBeenCalledWith("/Users/me/repo/.alinery/a.png");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("copies the host path for a remote repo instead of asking this machine to reveal it", async () => {
    setRevealRepo("alinery+ssh://box-a1b2c3/srv/app");
    expect(revealActionLabel()).toBe("Copy path on host");
    await revealPath("/srv/app/.alinery/tasks/t/artifacts/attachments/a.png");
    expect(writeText).toHaveBeenCalledWith("/srv/app/.alinery/tasks/t/artifacts/attachments/a.png");
    expect(ipc.revealItemInDir).not.toHaveBeenCalled();
  });
});
