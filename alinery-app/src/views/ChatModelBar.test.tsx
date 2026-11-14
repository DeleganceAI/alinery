import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ComposerStats } from "./ChatModelBar";

describe("ComposerStats", () => {
  it("shows used/limit ctx with a meter, and the used count alone when the provider sends no limit", () => {
    const { container, rerender } = render(<ComposerStats usage={{ tokens: 20_000, contextWindow: 120_000 }} events={43} />);
    expect(container.textContent).toBe("20k/120k ctx43 events");
    expect(container.querySelector("meter")?.getAttribute("value")).toBe("20000");
    rerender(<ComposerStats usage={{ tokens: 1_500, contextWindow: 0 }} events={1} />);
    expect(container.textContent).toBe("1.5k/? ctx1 event");
    expect(container.querySelector("meter")).toBeNull();
  });
});
