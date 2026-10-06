import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThinkingSelect } from "./ThinkingSelect";

afterEach(cleanup);

const LEVELS = ["off", "low", "high"];

describe("ThinkingSelect", () => {
  it("renders nothing without a level", () => {
    const { container } = render(<ThinkingSelect level={undefined} levels={LEVELS} disabledReason={null} onPick={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });

  it.each([[undefined], [[]]])("shows the level as plain text when the model offers no list (%j)", (levels) => {
    const { container } = render(<ThinkingSelect level="high" levels={levels} disabledReason={null} onPick={vi.fn()} />);
    expect(container.textContent).toBe("high");
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("lists the levels with the current one selected", () => {
    render(<ThinkingSelect level="low" levels={LEVELS} disabledReason={null} onPick={vi.fn()} />);
    const select = screen.getByRole("combobox", { name: "Thinking level" }) as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(LEVELS);
    expect(select.value).toBe("low");
    expect(select.disabled).toBe(false);
    expect(select.title).toBe("Change thinking level");
  });

  it("reports a pick and leaves the shown level to the caller", () => {
    const onPick = vi.fn();
    render(<ThinkingSelect level="low" levels={LEVELS} disabledReason={null} onPick={onPick} />);
    const select = screen.getByRole("combobox", { name: "Thinking level" }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "high" } });
    expect(onPick).toHaveBeenCalledExactlyOnceWith("high");
    expect(select.value).toBe("low");
  });

  it("is disabled with the reason as its title", () => {
    render(<ThinkingSelect level="low" levels={LEVELS} disabledReason="Not running" onPick={vi.fn()} />);
    const select = screen.getByRole("combobox", { name: "Thinking level" }) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.title).toBe("Not running");
  });

  it("still shows a level the model's list does not name", () => {
    render(<ThinkingSelect level="xhigh" levels={LEVELS} disabledReason={null} onPick={vi.fn()} />);
    const select = screen.getByRole("combobox", { name: "Thinking level" }) as HTMLSelectElement;
    expect(select.value).toBe("xhigh");
    expect([...select.options].map((option) => option.value)).toEqual([...LEVELS, "xhigh"]);
  });

  it("rerenders through every shape without an error", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container, rerender } = render(<ThinkingSelect level="high" levels={undefined} disabledReason={null} onPick={vi.fn()} />);
    for (const levels of [LEVELS, [], LEVELS]) {
      rerender(<ThinkingSelect level="high" levels={levels} disabledReason={null} onPick={vi.fn()} />);
      expect(container.querySelector("select") !== null).toBe(levels.length > 0);
    }
    rerender(<ThinkingSelect level={undefined} levels={LEVELS} disabledReason={null} onPick={vi.fn()} />);
    expect(container.innerHTML).toBe("");
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
