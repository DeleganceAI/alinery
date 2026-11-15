import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskSpecsPin } from "./TaskSpecsPin";

const sync = vi.hoisted(() => ({ readTaskSpecs: vi.fn(), repinTaskSpecs: vi.fn() }));
vi.mock("../sync/specs", () => sync);

beforeEach(() => {
  sync.readTaskSpecs.mockReset();
  sync.repinTaskSpecs.mockReset();
});
afterEach(cleanup);

describe("TaskSpecsPin", () => {
  it("shows the pinned commit and re-pins on request", async () => {
    sync.readTaskSpecs
      .mockResolvedValueOnce({ commit: "abcdef0123", files: ["requirements.md", "tooling.md"], headFiles: 2 })
      .mockResolvedValueOnce({ commit: "1234567abc", files: ["tooling.md"], headFiles: 1 });
    sync.repinTaskSpecs.mockResolvedValue({ commit: "1234567abc", files: ["tooling.md"] });
    render(<TaskSpecsPin repo="/r" slug="t" />);
    expect(await screen.findByText("2 files @ abcdef0")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Re-pin to HEAD" }));
    await waitFor(() => expect(sync.repinTaskSpecs).toHaveBeenCalledWith("/r", "t"));
    expect(await screen.findByText("1 file @ 1234567")).toBeTruthy();
  });

  it("offers to apply files committed after the task started", async () => {
    sync.readTaskSpecs.mockResolvedValue({ commit: "abcdef0123", files: [], headFiles: 3 });
    render(<TaskSpecsPin repo="/r" slug="t" />);
    expect(await screen.findByText("none applied (3 committed since)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply HEAD" })).toBeTruthy();
  });

  it("renders nothing without any requirement files, and nothing when the daemon cannot answer", async () => {
    sync.readTaskSpecs.mockResolvedValueOnce({ commit: "", files: [], headFiles: 0 });
    const { container } = render(<TaskSpecsPin repo="/r" slug="t" />);
    await waitFor(() => expect(sync.readTaskSpecs).toHaveBeenCalled());
    expect(container.textContent).toBe("");
    cleanup();
    sync.readTaskSpecs.mockRejectedValueOnce(new Error("unreachable"));
    const again = render(<TaskSpecsPin repo="/r" slug="t" />);
    await waitFor(() => expect(sync.readTaskSpecs).toHaveBeenCalledTimes(2));
    expect(again.container.textContent).toBe("");
  });

  it("shows a refused re-pin", async () => {
    sync.readTaskSpecs.mockResolvedValue({ commit: "abcdef0123", files: ["tooling.md"], headFiles: 1 });
    sync.repinTaskSpecs.mockRejectedValue(new Error("cannot pin: no commit yet"));
    render(<TaskSpecsPin repo="/r" slug="t" />);
    fireEvent.click(await screen.findByRole("button", { name: "Re-pin to HEAD" }));
    expect((await screen.findByRole("alert")).textContent).toContain("cannot pin");
  });
});
