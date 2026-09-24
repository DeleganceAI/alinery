import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { LiveSubagent } from "../chat/subagents";
import { SubagentDrawer } from "./SubagentDrawer";

afterEach(cleanup);

const card = (over: Partial<LiveSubagent> = {}): LiveSubagent => ({
  id: "sa-1",
  name: "Explore",
  status: "running",
  preview: "Search the repo",
  ...over,
});

describe("SubagentDrawer", () => {
  // The drawer only ever holds live cards, so a hardcoded "running" in the header asserted a
  // status it never checked — and would mislabel the card the moment a live state changes.
  it("counts live subagents without claiming they are running", () => {
    const { container } = render(<SubagentDrawer agents={[card()]} />);
    expect(container.querySelector(".chat-sub-label")?.textContent).toBe("subagents · 1");
  });

  it("shows the activity label in the status chip", () => {
    const { container } = render(<SubagentDrawer agents={[card({ activity: "using read" })]} />);
    expect(container.querySelector(".chat-sub-status")?.textContent).toBe("using read");
  });

  // Before the first progress frame the card has no activity. "working" is the honest label;
  // the lifecycle status it used to print is a constant that carries no information.
  it("falls back to working before the first progress frame", () => {
    const { container } = render(<SubagentDrawer agents={[card()]} />);
    expect(container.querySelector(".chat-sub-status")?.textContent).toBe("working");
  });
});
