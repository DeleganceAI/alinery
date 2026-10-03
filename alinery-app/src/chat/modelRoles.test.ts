import { describe, expect, it } from "vitest";
import { splitModelEffort, withModelEffort } from "./modelRoles";

describe("model reasoning effort suffix", () => {
  it("recognizes only a known final effort and preserves model-id colons", () => {
    expect(splitModelEffort("openrouter/model:free")).toEqual({ model: "openrouter/model:free", effort: "off" });
    expect(splitModelEffort("openrouter/model:free:auto")).toEqual({ model: "openrouter/model:free", effort: "auto" });
    expect(withModelEffort("openrouter/model:free:high", "off")).toBe("openrouter/model:free:off");
    expect(withModelEffort("", "high")).toBe("");
  });
});
