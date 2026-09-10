import { describe, expect, it } from "vitest";
import { deriveModelRows, modelMatches } from "./modelFavorites";

describe("modelMatches", () => {
  it("matches every whitespace-separated token in any order", () => {
    expect(modelMatches("claude-sonnet-4-5", "sonnet 4")).toBe(true);
    expect(modelMatches("claude-sonnet-4-5", "4 sonnet")).toBe(true);
    expect(modelMatches("claude-sonnet-4-5", "sonnet opus")).toBe(false);
  });

  it("is case-insensitive and treats empty or whitespace-only queries as match-all", () => {
    expect(modelMatches("Claude-Opus", "opus")).toBe(true);
    expect(modelMatches("anything", "")).toBe(true);
    expect(modelMatches("anything", "   ")).toBe(true);
  });
});

describe("deriveModelRows", () => {
  it("filters first, then stably promotes matching favorites", () => {
    expect(deriveModelRows(["claude-opus", "claude-sonnet", "anthropic-sonnet", "claude-haiku"], ["anthropic-sonnet"], "sonnet")).toEqual([
      { model: "anthropic-sonnet", favorite: true },
      { model: "claude-sonnet", favorite: false },
    ]);
  });

  it("uses the same stable partition for empty and whitespace-only queries", () => {
    const expected = [
      { model: "sonnet", favorite: true },
      { model: "opus", favorite: false },
      { model: "haiku", favorite: false },
    ];

    expect(deriveModelRows(["opus", "sonnet", "haiku"], ["sonnet"], "")).toEqual(expected);
    expect(deriveModelRows(["opus", "sonnet", "haiku"], ["sonnet"], "   ")).toEqual(expected);
  });

  it("uses exact case-sensitive favorite membership", () => {
    expect(deriveModelRows(["Opus", "opus"], ["opus"], "")).toEqual([
      { model: "opus", favorite: true },
      { model: "Opus", favorite: false },
    ]);
  });

  it("preserves duplicate discovered rows and applies shared membership", () => {
    expect(deriveModelRows(["sonnet", "opus", "sonnet"], ["sonnet"], "")).toEqual([
      { model: "sonnet", favorite: true },
      { model: "sonnet", favorite: true },
      { model: "opus", favorite: false },
    ]);
  });

  it("does not synthesize rows for favorites missing from discovery", () => {
    expect(deriveModelRows(["opus"], ["missing"], "")).toEqual([{ model: "opus", favorite: false }]);
    expect(deriveModelRows([], ["missing"], "")).toEqual([]);
  });
});
