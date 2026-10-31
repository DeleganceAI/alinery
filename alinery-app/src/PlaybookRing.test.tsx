import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { classifyRingEdges, PlaybookRing, promptExcerpt } from "./PlaybookRing";
import type { InputSelector, NormalizedStep } from "./types";

const step = (key: string, inputs: InputSelector[], outputs: string[], auto = true): NormalizedStep => ({
  key,
  title: key,
  short: key,
  is_coding_step: false,
  auto_advance_default: auto,
  inputs,
  outputs: outputs.map((path) => ({ path })),
  model: "",
  harness: "omp",
  prompt: "",
});

const survey = [
  step("frame", [], ["brief.md"]),
  step(
    "plan",
    [
      { path: "brief.md", mode: "single" },
      { path: "ticket.md", mode: "single" },
    ],
    ["plan.md", "request-*.md"],
  ),
  step("gather", [{ path: "request-*.md", mode: "each" }], ["result.md"]),
  step(
    "dispatch",
    [
      { path: "brief.md", mode: "single" },
      { path: "plan.md", mode: "single" },
      { path: "result*.md", mode: "complete" },
    ],
    ["wave.md"],
  ),
  step(
    "draft",
    [
      { path: "brief.md", mode: "single" },
      { path: "wave.md", mode: "single" },
    ],
    ["draft.md"],
  ),
  step(
    "continue",
    [
      { path: "brief.md", mode: "single" },
      { path: "draft.md", mode: "single" },
    ],
    ["ticket.md"],
    false,
  ),
];

describe("classifyRingEdges", () => {
  it("turns a widely read artifact into one rail, a single far read into a chord, and the last step's back edge into the loop", () => {
    const { rails, chords, loop } = classifyRingEdges(survey);
    expect(rails).toEqual([{ from: 0, path: "brief.md", consumers: [3, 4, 5] }]);
    expect(chords).toEqual([{ from: 1, to: 3, path: "plan.md" }]);
    expect(loop).toEqual({ from: 5, to: 1, path: "ticket.md" });
  });

  it("returns nothing for a plain spine", () => {
    const spine = [step("a", [], ["a.md"]), step("b", [{ path: "a.md", mode: "single" }], ["b.md"]), step("c", [{ path: "b.md", mode: "single" }], [])];
    expect(classifyRingEdges(spine)).toEqual({ rails: [], chords: [], loop: null });
  });
});

describe("promptExcerpt", () => {
  it("skips headings, lists, and fences and strips inline markup", () => {
    expect(promptExcerpt("# Title\n\n- a list\n\n```\ncode\n```\n\nRead the `brief` and **decide**.\n\nSecond paragraph.")).toBe("Read the brief and decide.");
  });
  it("cuts long paragraphs at a word boundary", () => {
    expect(promptExcerpt("one two three four five", 9)).toBe("one two…");
  });
});

describe("PlaybookRing", () => {
  it("exposes each step as a button, reports hover, and selects on click", () => {
    const onSelectStep = vi.fn();
    const onHoverStep = vi.fn();
    render(
      <PlaybookRing steps={survey} selectedStepKey="frame" onSelectStep={onSelectStep} onHoverStep={onHoverStep} progress={{ now: 1, max: 6, text: "frame, step 1 of 6" }}>
        <span>centre</span>
      </PlaybookRing>,
    );
    const ring = screen.getByRole("progressbar", { name: "Playbook demo" });
    expect(ring.getAttribute("aria-valuetext")).toBe("frame, step 1 of 6");
    const gather = screen.getByRole("button", { name: "gather" });
    fireEvent.mouseEnter(gather);
    expect(onHoverStep).toHaveBeenCalledWith("gather");
    fireEvent.click(gather);
    expect(onSelectStep).toHaveBeenCalledWith("gather");
    expect(screen.getByText("ticket.md · back to 2")).toBeTruthy();
    expect(screen.getByText("centre")).toBeTruthy();
  });
});
