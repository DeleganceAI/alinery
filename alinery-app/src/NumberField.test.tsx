import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NumberField } from "./NumberField";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** A field wired to real state, so a commit re-renders it the way Settings does. */
function Harness({ initial, min = 1, max = 100, delay }: { initial: number; min?: number; max?: number; delay?: number }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <NumberField value={value} min={min} max={max} label="Limit" delay={delay} onChange={setValue} />
      <output>{value}</output>
    </>
  );
}

const field = () => screen.getByRole("spinbutton", { name: "Limit" }) as HTMLInputElement;
const saved = () => document.querySelector("output")?.textContent;

describe("NumberField", () => {
  it("lets the whole value be cleared and retyped instead of snapping to the bounds", () => {
    vi.useFakeTimers();
    render(<Harness initial={100} />);
    const input = field();
    act(() => input.focus());

    // Backspace from 100 all the way to nothing: no clamp may put a digit back.
    for (const text of ["10", "1", ""]) {
      fireEvent.change(input, { target: { value: text } });
      expect(input.value).toBe(text);
    }
    // Typing "30" passes through "3" and never lands on the maximum.
    for (const text of ["3", "30"]) {
      fireEvent.change(input, { target: { value: text } });
      expect(input.value).toBe(text);
    }
    expect(saved()).toBe("100"); // nothing has been written mid-typing

    act(() => vi.advanceTimersByTime(700));
    expect(saved()).toBe("30");
    expect(input.value).toBe("30");
  });

  it("saves once typing pauses, so leaving without a blur keeps the edit", () => {
    vi.useFakeTimers();
    render(<Harness initial={80} />);
    const input = field();
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "4" } });
    act(() => vi.advanceTimersByTime(400));
    expect(saved()).toBe("80"); // still within the pause
    fireEvent.change(input, { target: { value: "45" } });
    act(() => vi.advanceTimersByTime(700));
    expect(saved()).toBe("45");
  });

  it("clamps an out-of-range draft when it commits, not while it is being typed", () => {
    vi.useFakeTimers();
    render(<Harness initial={100} />);
    const input = field();
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "130" } });
    expect(input.value).toBe("130");
    act(() => vi.advanceTimersByTime(700));
    expect(saved()).toBe("100");
    // The typed text stays until the field is left, then shows what was saved.
    expect(input.value).toBe("130");
    act(() => input.blur());
    expect(input.value).toBe("100");
  });

  it("keeps the saved value when the field is left empty or half-typed", () => {
    render(<Harness initial={30} />);
    const input = field();
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "" } });
    act(() => input.blur());
    expect(saved()).toBe("30");
    expect(input.value).toBe("30");

    act(() => input.focus());
    fireEvent.change(input, { target: { value: "-" } });
    act(() => input.blur());
    expect(saved()).toBe("30");
    expect(input.value).toBe("30");
  });

  it("commits on Enter and leaves the field showing the saved number", () => {
    render(<Harness initial={10} />);
    const input = field();
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "250" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(saved()).toBe("100");
    expect(input.value).toBe("100");
    expect(document.activeElement).not.toBe(input);
  });

  it("saves a pending edit when the section unmounts", () => {
    const onChange = vi.fn();
    const { unmount } = render(<NumberField value={80} min={1} max={100} label="Limit" onChange={onChange} />);
    const input = field();
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "55" } });
    unmount();
    expect(onChange).toHaveBeenCalledWith(55);
  });
});
