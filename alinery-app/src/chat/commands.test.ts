import { describe, expect, it } from "vitest";
import { findCommand, groupCommands, matchCommands, parseSlash } from "./commands";
import type { ChatCommand } from "./types";

const catalog: ChatCommand[] = [
  { name: "compact", description: "Compact context", source: "builtin", input: { hint: "[soft|remote]" } },
  { name: "model", aliases: ["models"], description: "Switch model", source: "builtin" },
  { name: "thinking", description: "Set thinking level", source: "builtin" },
  { name: "skill:brave-search", description: "Search the web", source: "skill" },
];

describe("parseSlash", () => {
  it("returns null when the draft is not a slash", () => {
    expect(parseSlash("hello")).toBeNull();
    expect(parseSlash("model")).toBeNull();
  });

  it("splits name and args", () => {
    expect(parseSlash("/model")).toEqual({ name: "model", args: "" });
    expect(parseSlash("/model xai/grok-4.6")).toEqual({ name: "model", args: "xai/grok-4.6" });
    expect(parseSlash("/skill:brave-search find X")).toEqual({ name: "skill:brave-search", args: "find X" });
  });
});

describe("matchCommands", () => {
  it("lists the whole catalog on a bare slash", () => {
    expect(matchCommands("/", catalog).map((c) => c.name)).toEqual(catalog.map((c) => c.name));
  });

  it("does not invent names missing from the catalog", () => {
    expect(matchCommands("/login", catalog)).toEqual([]);
    expect(findCommand("login", catalog)).toBeUndefined();
  });

  it("matches aliases and skills", () => {
    expect(findCommand("models", catalog)?.name).toBe("model");
    expect(matchCommands("/skill", catalog).map((c) => c.name)).toEqual(["skill:brave-search"]);
  });
});

describe("groupCommands", () => {
  it("groups by OMP source, not invented Session/Model buckets", () => {
    expect(groupCommands(catalog).map((g) => g.group)).toEqual(["builtin", "skill"]);
  });
});
