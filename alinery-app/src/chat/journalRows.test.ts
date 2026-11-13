import { describe, expect, it } from "vitest";
import { journalItems } from "./journalRows";
import { ACTOR, type ChatEntry } from "./types";

const prompt = (id: string, at: number, text = "do it"): ChatEntry => ({ id, at, actor: ACTOR.you, type: "prompt", text });
const say = (id: string, at: number, text = "ok"): ChatEntry => ({ id, at, actor: ACTOR.agent, type: "text", text });
const call = (id: string, at: number, status: "ok" | "running" | "error" = "ok"): ChatEntry => ({ id, at, actor: ACTOR.agent, type: "tool_call", tool: "bash", status });
const result = (id: string, at: number): ChatEntry => ({ id, at, actor: ACTOR.agent, type: "tool_result", tool: "bash", text: "out", status: "ok" });
const think = (id: string, at: number): ChatEntry => ({ id, at, actor: ACTOR.agent, type: "thinking", text: "hm" });

const shape = (entries: ChatEntry[], running = false) =>
  journalItems(entries, running).map((item) =>
    item.kind === "entry" ? `${item.role}:${item.key}` : item.kind === "work" ? `work:${item.entries.map((e) => e.id).join(",")}` : `turn:${item.steps}:${item.durationMs}`,
  );

describe("journalItems", () => {
  it("folds each run of work into one strip, reads text before later work as narration, and closes the turn", () => {
    const entries = [prompt("p", 0), think("t", 1000), call("c1", 2000), result("r1", 3000), say("n", 4000), call("c2", 5000), result("r2", 6000), say("a", 9000)];
    expect(shape(entries)).toEqual(["you:p", "work:t,c1,r1", "narration:n", "work:c2,r2", "answer:a", "turn:3:9000"]);
  });

  it("keeps every text of a turn with no work after it as the answer", () => {
    expect(shape([prompt("p", 0), say("a1", 1), say("a2", 2), prompt("q", 3), say("b", 4)])).toEqual([
      "you:p",
      "answer:a1",
      "answer:a2",
      "turn:0:2",
      "you:q",
      "answer:b",
      "turn:0:1",
    ]);
  });

  it("gives a running last turn no footer, and its trailing text stays the answer until more work arrives", () => {
    expect(shape([prompt("p", 0), call("c", 1, "running")], true)).toEqual(["you:p", "work:c"]);
    expect(journalItems([prompt("p", 0), call("c", 1, "running")], true)[1]).toMatchObject({ kind: "work", live: true });
    expect(shape([prompt("p", 0), call("c", 1), say("a", 2)], true)).toEqual(["you:p", "work:c", "answer:a"]);
  });

  it("gives no footer to a turn without its prompt (an older page not loaded yet) or without an answer", () => {
    expect(shape([call("c", 1), say("a", 2)])).toEqual(["work:c", "answer:a"]);
    expect(shape([prompt("p", 0), call("c", 1)])).toEqual(["you:p", "work:c"]);
  });

  it("splits work around an approval and keeps a queued follow-up inside its turn", () => {
    const approval: ChatEntry = { id: "ap", at: 2, actor: ACTOR.alinery, type: "approval", requestId: "r", action: "push", detail: "" };
    const queued: ChatEntry = { id: "f", at: 3, actor: ACTOR.you, type: "follow_up", text: "then test" };
    expect(shape([prompt("p", 0), call("c1", 1), approval, queued, call("c2", 4), say("a", 5)])).toEqual([
      "you:p",
      "work:c1",
      "wait:ap",
      "you:f",
      "work:c2",
      "answer:a",
      "turn:2:5",
    ]);
  });
});
