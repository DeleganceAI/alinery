import { describe, expect, it } from "vitest";
import { matchSettings, SETTINGS_GROUPS, visibleGroups } from "./settingsIndex";

const shown = (query: string, groups = SETTINGS_GROUPS) => [...(matchSettings(groups, query) ?? [])];

describe("matchSettings", () => {
  it("is off for a blank query", () => {
    expect(matchSettings(SETTINGS_GROUPS, "   ")).toBeNull();
  });

  it("finds a group by a word its label does not say", () => {
    expect(shown("dark mode")).toEqual(["appearance"]);
  });

  it("keeps only the matching part, with its group", () => {
    expect(shown("backup")).toEqual(["data", "data.backup"]);
  });

  it("keeps every part of a group matched by its own name", () => {
    expect(shown("system")).toEqual(expect.arrayContaining(["system", "system.updates", "system.sessions", "system.misc", "system.experimental"]));
  });

  it("needs every word, in any order and case, across a part and its group", () => {
    expect(shown("GROK key")).toEqual(["system", "system.experimental"]);
    expect(shown("grok github")).toEqual([]);
  });

  it("never offers the Chat view part while Chat is off", () => {
    expect(shown("chat view", visibleGroups(false))).not.toContain("views.chat");
    expect(shown("chat view", visibleGroups(true))).toContain("views.chat");
  });
});
