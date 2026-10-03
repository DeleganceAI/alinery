import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { buildTaskRunGraph } from "./runGraphModel";
import { TaskRunGraph } from "./TaskRunGraph";
import type { ArtifactOccurrence, SessionDisplayMeta } from "./types";
import { executionRecord, executionReply } from "./views/executionTestFixture";

vi.mock("./ipc", async () => {
  // The hoisted factory runs before static imports when shared.tsx imports the IPC boundary.
  const { mockIpc } = await import("./test/mockIpc");
  return mockIpc();
});

const session = (id: string, overrides: Partial<SessionDisplayMeta> = {}): SessionDisplayMeta => ({
  id,
  name: id,
  worktree: "/work",
  created: 1,
  archived: false,
  phase: "worker",
  harness: "omp",
  model: "",
  playbook: "retained",
  generic: false,
  harness_resume_token: "",
  ...overrides,
});
const execution = (id: string, inputs: Record<string, string[]> = {}) =>
  executionRecord({
    id,
    owner_session_id: id,
    candidate: { ...executionRecord().candidate, inputs },
  });
const occurrence = (id: string, producer: string | null, path = `${id}.md`): ArtifactOccurrence => ({
  id,
  producer_execution_id: producer,
  selector: "result-*.md",
  logical_path: "result.md",
  relative_path: path,
  depth: 1,
  discriminator: 1,
  context_id: "root",
  collection_ids: [],
});

afterEach(cleanup);

it("preserves branch and convergence bindings, including all recorded wildcard members but not reserved outputs", () => {
  const state = executionReply([
    execution("root", { "request.md": ["seed"] }),
    execution("left", { "result.md": ["shared"] }),
    execution("right", { "result.md": ["shared"] }),
    execution("join", { "result-*.md": ["left-result", "right-result"] }),
  ]).state;
  state.occurrences = Object.fromEntries(
    [occurrence("seed", null), occurrence("shared", "root"), occurrence("left-result", "left"), occurrence("right-result", "right"), occurrence("final", "join")].map((item) => [
      item.id,
      item,
    ]),
  );
  const graph = buildTaskRunGraph(
    ["root", "left", "right", "join", "auxiliary"].map((id) => session(id)),
    state,
  );
  expect(graph.connections.map(({ from, to, artifacts }) => [from, to, artifacts.map((item) => item.id)])).toEqual([
    ["source:seed", "session:root", ["seed"]],
    ["session:root", "session:left", ["shared"]],
    ["session:root", "session:right", ["shared"]],
    ["session:left", "session:join", ["left-result"]],
    ["session:right", "session:join", ["right-result"]],
    ["session:join", "artifact:final", ["final"]],
  ]);
  expect(graph.nodes.has("session:auxiliary")).toBe(true);
});

it("keeps repeated paths distinct and attributes accepted outputs to the current owner, never the prior attempt", () => {
  const producer = execution("producer");
  producer.owner_session_id = "recovered";
  producer.previous_session_ids = ["old"];
  const state = executionReply([producer, execution("consumer", { "result-*.md": ["first", "second"] })]).state;
  state.occurrences = { first: occurrence("first", "producer", "nested/result.md"), second: occurrence("second", "producer", "nested/result.md") };
  const sessions = [session("old", { name: "Worker" }), session("recovered", { name: "Worker", resume_of: "old" }), session("consumer")];
  const graph = buildTaskRunGraph(sessions, state);
  expect(graph.connections.map(({ from, to, artifacts, resumed }) => [from, to, artifacts.map((item) => item.id), resumed])).toEqual([
    ["session:recovered", "session:consumer", ["first", "second"], false],
    ["session:old", "session:recovered", [], true],
  ]);
  const onOpenArtifact = vi.fn();
  const onOpenSession = vi.fn();
  render(<TaskRunGraph sessions={sessions} state={state} onOpenArtifact={onOpenArtifact} onOpenSession={onOpenSession} />);
  const graphRegion = within(screen.getByRole("region", { name: "Task run graph" }));
  expect(graphRegion.getAllByRole("button", { name: /^Open artifact / }).map((button) => button.textContent)).toEqual(["result.md", "result.md"]);
  fireEvent.click(graphRegion.getByRole("button", { name: "Open artifact nested/result.md, occurrence first" }));
  fireEvent.click(graphRegion.getByRole("button", { name: "Open artifact nested/result.md, occurrence second" }));
  expect(onOpenArtifact.mock.calls).toEqual([["nested/result.md"], ["nested/result.md"]]);
  for (const button of graphRegion.getAllByRole("button", { name: "Open session Worker" })) fireEvent.click(button);
  expect(onOpenSession.mock.calls.map(([item]) => item.id).sort()).toEqual(["old", "recovered"]);
});

it("does not reconstruct filtered or missing producers, or expand collections beyond bound occurrence IDs", () => {
  const hidden = execution("hidden");
  hidden.previous_session_ids = ["visible-old"];
  const consumer = execution("consumer", { "result-*.md": ["hidden-result", "missing-result", "unavailable-occurrence"] });
  consumer.candidate.complete_collection_id = "collection";
  const state = executionReply([hidden, consumer]).state;
  state.collections = {
    collection: {
      id: "collection",
      context_id: "root",
      selector: "result-*.md",
      producer_step: "worker",
      source_collection_id: null,
      expected_execution_ids: [],
      member_occurrence_ids: ["hidden-result", "missing-result", "not-bound"],
      membership_closed: true,
    },
  };
  state.occurrences = {
    "hidden-result": occurrence("hidden-result", "hidden"),
    "missing-result": occurrence("missing-result", "missing"),
    "not-bound": occurrence("not-bound", "hidden"),
  };
  const graph = buildTaskRunGraph([session("visible-old"), session("consumer")], state);
  expect([...graph.nodes.values()].filter((node) => "session" in node).map((node) => node.key)).toEqual(["session:consumer", "session:visible-old"]);
  expect(graph.connections.map(({ from, to, artifacts }) => [from, to, artifacts.map((item) => item.id)])).toEqual([
    ["source:hidden-result", "session:consumer", ["hidden-result"]],
    ["source:missing-result", "session:consumer", ["missing-result"]],
    ["source:not-bound", "artifact:not-bound", ["not-bound"]],
  ]);
});

it("keeps isolated sessions navigable without execution state and does not reorder them with attention sorting", () => {
  const first = session("first", { created: 1, generic: true });
  const second = session("second", { created: 2 });
  const onOpenSession = vi.fn();
  const { rerender } = render(<TaskRunGraph sessions={[second, first]} state={null} onOpenArtifact={vi.fn()} onOpenSession={onOpenSession} />);
  fireEvent.click(screen.getByRole("button", { name: "Open session first" }));
  expect(onOpenSession).toHaveBeenCalledWith(first);
  expect(screen.queryByRole("button", { name: /Open artifact/ })).toBeNull();
  const before = buildTaskRunGraph([second, first], null);
  const after = buildTaskRunGraph([first, second], null);
  expect([...before.nodes.keys()]).toEqual([...after.nodes.keys()]);
  rerender(<TaskRunGraph sessions={[]} state={null} onOpenArtifact={vi.fn()} onOpenSession={onOpenSession} />);
  expect(screen.getByText("No sessions yet.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Open session/ })).toBeNull();
});
