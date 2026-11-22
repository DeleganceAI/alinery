import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PullCommentsButton } from "./PullCommentsButton";

const info = vi.hoisted(() => vi.fn());
vi.mock("./toast", () => ({ toast: { info, error: vi.fn() } }));

describe("PullCommentsButton", () => {
  it("pulls once, shows the answer, and is usable again", async () => {
    const onPull = vi.fn(() => Promise.resolve("2 new comments."));
    render(<PullCommentsButton onPull={onPull} />);
    const button = screen.getByRole("button", { name: "Pull the latest comments" }) as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    await waitFor(() => expect(info).toHaveBeenCalledWith("2 new comments."));
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(onPull).toHaveBeenCalledTimes(1);
  });
});
