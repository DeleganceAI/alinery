import { assert, expect, it } from "vitest";
import { artifactLineage } from "./executionLineage";
import { executionRecord, executionReply } from "./views/executionTestFixture";

const noLinks = { producers: [], consumers: [], assigned: [], producerInputs: [], consumerOutputs: [] };

function consumer(id: string, inputs: string[]) {
  const record = executionRecord({ id });
  record.candidate.inputs = { "roll.md": inputs };
  return record;
}

it("follows exact occurrences at the open path through fan-out, including repeated publications and collection inputs", () => {
  const recorded = executionRecord({ id: "record" });
  const revised = executionRecord({ id: "revision" });
  const routed = consumer("route", ["roll-v1"]);
  const reviewed = consumer("review", ["roll-v1", "roll-v2", "other-roll"]);
  const other = consumer("other-round", ["other-roll"]);
  const sibling = consumer("sibling", []);
  sibling.parent_execution_ids = [recorded.id];
  const state = executionReply([recorded, revised, routed, reviewed, other, sibling]).state;
  const base = state.occurrences?.["input-a"];
  assert.isDefined(base);
  state.occurrences = {
    "roll-v1": { ...base, id: "roll-v1", relative_path: "1-roll-1/roll.md", producer_execution_id: recorded.id },
    "roll-v2": { ...base, id: "roll-v2", relative_path: "1-roll-1/roll.md", producer_execution_id: revised.id },
    "other-roll": { ...base, id: "other-roll", relative_path: "3-roll-2/roll.md", producer_execution_id: other.id },
  };
  expect(artifactLineage(state, "1-roll-1/roll.md")).toEqual({ ...noLinks, producers: [recorded, revised], consumers: [routed, reviewed] });
  expect(artifactLineage(state, "roll.md")).toEqual(noLinks);
});

it("moves a file into the center with the producers' bound inputs and the consumers' published or pending outputs on its sides", () => {
  const producer = consumer("roll", ["input-a", "input-a", "missing"]);
  const next = consumer("route", ["roll"]);
  next.outputs = [{ relative_path: "2-route/notes/*.md", selector: "notes/*.md", discriminator: 0 }];
  const finished = consumer("review", ["roll"]);
  finished.receipt_id = "accepted";
  const state = executionReply([producer, next, finished]).state;
  const seed = state.occurrences?.["input-a"];
  assert.isDefined(seed);
  state.occurrences = {
    "input-a": seed,
    roll: { ...seed, id: "roll", relative_path: "1-roll/roll.md", producer_execution_id: producer.id },
    result: { ...seed, id: "result", relative_path: "2-route/notes/first.md", producer_execution_id: next.id },
    review: { ...seed, id: "review", relative_path: "2-review/review.md", producer_execution_id: finished.id },
  };
  const files = ["2-route/notes/first.md", "2-route/notes/draft.md", "2-route/notes/draft.md", "other/notes/no.md", finished.outputs[0].relative_path];
  expect(artifactLineage(state, "1-roll/roll.md", files)).toEqual({
    producers: [producer],
    consumers: [next, finished],
    assigned: [],
    producerInputs: [seed.relative_path],
    consumerOutputs: [
      { path: "2-route/notes/first.md", assigned: false },
      { path: "2-review/review.md", assigned: false },
      { path: "2-route/notes/draft.md", assigned: true },
    ],
  });
});

it("shows the session that consumes a seed and gives no producing session to a seed", () => {
  const first = consumer("first", ["input-a"]);
  const state = executionReply([first]).state;
  const path = state.occurrences?.["input-a"].relative_path;
  assert.isDefined(path);
  first.outputs = [{ relative_path: path, selector: "request.md", discriminator: 1 }];
  expect(artifactLineage(state, path)).toEqual({ ...noLinks, consumers: [first] });
});

it("distinguishes an unpublished assignment from publication and matches its full output directory", () => {
  const output = { relative_path: "1-draft-1/notes/*.md", selector: "notes/*.md", discriminator: 0 };
  const drafting = executionRecord({ id: "draft", outputs: [output] });
  const finished = executionRecord({ id: "partial", receipt_id: "accepted", outputs: [output] });
  const next = consumer("queued", []);
  next.parent_execution_ids = [drafting.id];
  const state = executionReply([drafting, finished, next]).state;
  const seed = state.occurrences?.["input-a"];
  assert.isDefined(seed);
  expect(artifactLineage(state, "1-draft-1/notes/first.md")).toEqual({ ...noLinks, assigned: [drafting], producerInputs: [seed.relative_path] });
  expect(artifactLineage(state, "notes/first.md")).toEqual(noLinks);
});

it("has no relationships before execution data arrives or with a history-only state", () => {
  expect(artifactLineage(undefined, "roll.md")).toEqual(noLinks);
  expect(artifactLineage({ ...executionReply().state, executions: undefined, occurrences: undefined }, "roll.md")).toEqual(noLinks);
});
