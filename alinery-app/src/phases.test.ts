import { describe, expect, it } from "vitest";
import { kanbanColumnIndex, kanbanColumnKey, phaseLabel } from "./phases";
import type { Phase } from "./types";

describe("kanbanColumnIndex", () => {
  it("maps each known phase to its column", () => {
    expect(kanbanColumnIndex("")).toBe(0);
    expect(kanbanColumnIndex("research")).toBe(1);
    expect(kanbanColumnIndex("design")).toBe(1);
    expect(kanbanColumnIndex("structure")).toBe(2);
    expect(kanbanColumnIndex("tdd")).toBe(3);
    expect(kanbanColumnIndex("implementation")).toBe(3);
    expect(kanbanColumnIndex("review")).toBe(4);
  });

  // `Math.max(0, findIndex)` turns "not found" (-1) into column 0. A phase from a custom
  // playbook that nothing here knows about therefore lands in "Todo / Draft" rather than
  // being reported. Pinning it so the fallback is a decision, not an accident: if this
  // ever needs to be "last column" or "own column", this is the test that will say so.
  it("puts an unknown phase in the first column", () => {
    expect(kanbanColumnIndex("not-a-real-phase")).toBe(0);
    expect(kanbanColumnKey("not-a-real-phase")).toBe("todo-draft");
  });
});

describe("kanbanColumnKey", () => {
  it("returns the column key for a known phase", () => {
    expect(kanbanColumnKey("design")).toBe("research-design");
    expect(kanbanColumnKey("tdd")).toBe("implementation");
  });
});

describe("phaseLabel", () => {
  const phases: Phase[] = [{ key: "design", title: "Custom Design Title" } as Phase];

  it("prefers a title supplied by the playbook", () => {
    expect(phaseLabel("design", phases)).toBe("Custom Design Title");
  });

  it("falls back to the built-in title when the playbook does not name the phase", () => {
    expect(phaseLabel("design")).toBe("Design");
    expect(phaseLabel("", [])).toBe("Draft");
  });

  it("falls back to the raw key when nothing knows the phase", () => {
    expect(phaseLabel("bespoke-phase", [])).toBe("bespoke-phase");
  });
});
