import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_STATE_ART, pickEmptyStateArt, resetEmptyStateArtPick } from "./emptyStateArt";

afterEach(() => {
  resetEmptyStateArtPick();
  vi.restoreAllMocks();
});

describe("EMPTY_STATE_ART", () => {
  it("bundles the 15 voted keepers plus the original desk lock", () => {
    expect(EMPTY_STATE_ART).toHaveLength(16);
    for (const url of EMPTY_STATE_ART) {
      expect(typeof url).toBe("string");
      expect(url.length).toBeGreaterThan(0);
    }
  });
});

describe("pickEmptyStateArt", () => {
  it("returns a catalog member", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(EMPTY_STATE_ART).toContain(pickEmptyStateArt());
  });

  it("maps a high random draw onto the last catalog member", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    expect(pickEmptyStateArt()).toBe(EMPTY_STATE_ART[EMPTY_STATE_ART.length - 1]);
  });

  it("does not return previous when the catalog has more than one image", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const previous = EMPTY_STATE_ART[0];
    const next = pickEmptyStateArt(previous);
    expect(next).not.toBe(previous);
    expect(EMPTY_STATE_ART).toContain(next);
  });

  it("may return the only image when the catalog has length 1", () => {
    const only = "only.webp";
    expect(pickEmptyStateArt(only, [only])).toBe(only);
    expect(pickEmptyStateArt(undefined, [only])).toBe(only);
  });
});
