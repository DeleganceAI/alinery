import { describe, expect, it } from "vitest";
import { ACTOR, whoLabel } from "./types";

describe("whoLabel", () => {
  it("keeps assistant rows labeled Agent", () => {
    expect(whoLabel(ACTOR.agent)).toBe("Agent");
    expect(whoLabel(ACTOR.you)).toBe("You");
    expect(whoLabel(ACTOR.alinery)).toBe("Alinery");
  });
});
