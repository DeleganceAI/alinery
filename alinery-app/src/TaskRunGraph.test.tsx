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

it("zooms out to one percent with buttons and wheel, and resets from the lower bound", () => {
  render(<TaskRunGraph sessions={[session("worker")]} state={null} onOpenSession={vi.fn()} onOpenArtifact={vi.fn()} />);
  const zoomOut = screen.getByRole("button", { name: "Zoom out run graph" }) as HTMLButtonElement;
  const zoom = screen.getByLabelText("Run graph zoom");
  for (let click = 0; click < 30; click++) fireEvent.click(zoomOut);
  expect(zoom.textContent).toBe("1%");
  expect(zoomOut.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Reset view" }));
  expect(zoom.textContent).toBe("100%");
  expect(zoomOut.disabled).toBe(false);
  fireEvent.wheel(screen.getByRole("region", { name: "Run graph canvas" }), { deltaY: 10000, clientX: 100, clientY: 100 });
  expect(zoom.textContent).toBe("1%");
  expect(zoomOut.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Zoom in run graph" }));
  expect(zoomOut.disabled).toBe(false);
});

it("highlights only the hovered occurrence's arrows and restores keyboard focus highlighting on leave", () => {
  const state = executionReply([
    execution("root"),
    execution("left", { input: ["first"] }),
    execution("right", { input: ["first"] }),
    execution("other", { input: ["second"] }),
  ]).state;
  state.occurrences = {
    first: occurrence("first", "root", "result.md"),
    second: occurrence("second", "root", "result.md"),
  };
  const { container } = render(
    <TaskRunGraph sessions={["root", "left", "right", "other"].map((id) => session(id))} state={state} onOpenSession={vi.fn()} onOpenArtifact={vi.fn()} />,
  );
  const paths = Array.from(container.querySelectorAll("g .task-run-path"), (path) => path.getAttribute("d"));
  const highlightedPaths = () => Array.from(container.querySelectorAll(".task-run-path.highlighted"), (path) => path.getAttribute("d"));
  const first = screen.getByRole("button", { name: "Open artifact result.md, occurrence first" });
  const second = screen.getByRole("button", { name: "Open artifact result.md, occurrence second" });
  expect(highlightedPaths()).toEqual([]);
  fireEvent.mouseEnter(first);
  expect(highlightedPaths()).toEqual(paths.slice(0, 2));
  fireEvent.focus(first);
  fireEvent.mouseLeave(first);
  fireEvent.mouseEnter(second);
  expect(highlightedPaths()).toEqual(paths.slice(2));
  fireEvent.mouseLeave(second);
  expect(highlightedPaths()).toEqual(paths.slice(0, 2));
  fireEvent.blur(first);
  expect(highlightedPaths()).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Artifact dependencies" }));
  fireEvent.mouseEnter(screen.getByRole("button", { name: "Open artifact result.md, occurrence first" }));
  expect(highlightedPaths()).toEqual(Array.from(container.querySelectorAll("g .task-run-path"), (path) => path.getAttribute("d")));
});

it("enters keyboard panning from the toolbar and returns on Escape without stealing child keys", () => {
  render(<TaskRunGraph sessions={[session("worker")]} state={null} onOpenSession={vi.fn()} onOpenArtifact={vi.fn()} />);
  const pan = screen.getByRole("button", { name: "Pan run graph" });
  const canvas = screen.getByRole("region", { name: "Run graph canvas" });
  fireEvent.click(pan);
  expect(document.activeElement).toBe(canvas);
  expect(fireEvent.keyDown(canvas, { key: "ArrowRight" })).toBe(false);
  fireEvent.keyDown(canvas, { key: "Escape" });
  expect(document.activeElement).toBe(pan);

  const child = screen.getByRole("button", { name: "Open session worker" });
  child.focus();
  expect(fireEvent.keyDown(child, { key: "ArrowRight" })).toBe(true);
  fireEvent.keyDown(child, { key: "Escape" });
  expect(document.activeElement).toBe(child);
});

it.each([false, true])("orders keyboard traversal through sessions and their published artifacts (fork: %s)", (fork) => {
  const records = [execution("root"), execution("left", { input: ["shared"] })];
  const publications = [occurrence("shared", "root")];
  if (fork) {
    records.push(execution("right", { input: ["shared"] }), execution("join", { input: ["left-result", "right-result"] }));
    publications.push(occurrence("left-result", "left"), occurrence("right-result", "right"));
  }
  const state = executionReply(records).state;
  state.occurrences = Object.fromEntries(publications.map((item) => [item.id, item]));
  render(<TaskRunGraph sessions={records.map((item) => session(item.id))} state={state} onOpenSession={vi.fn()} onOpenArtifact={vi.fn()} />);
  const controls = within(screen.getByRole("region", { name: "Run graph canvas" })).getAllByRole("button");
  expect(controls.map((button) => button.getAttribute("aria-label"))).toEqual(
    fork
      ? [
          "Open session root",
          "Open artifact shared.md, occurrence shared",
          "Open session left",
          "Open artifact left-result.md, occurrence left-result",
          "Open session right",
          "Open artifact right-result.md, occurrence right-result",
          "Open session join",
        ]
      : ["Open session root", "Open artifact shared.md, occurrence shared", "Open session left"],
  );
  expect(controls.every((button) => button.tabIndex === 0)).toBe(true);
});

it("defaults to reduced session flow and shows a shared artifact once with every consumer", () => {
  const state = executionReply([
    execution("root", { ticket: ["ticket"] }),
    execution("left", { ticket: ["ticket"], context: ["context"] }),
    execution("right", { ticket: ["ticket"], context: ["context"] }),
    execution("join", { ticket: ["ticket"], context: ["context"], result: ["left-result", "right-result"] }),
  ]).state;
  state.occurrences = Object.fromEntries(
    [occurrence("ticket", null, "00-ticket.md"), occurrence("context", "root"), occurrence("left-result", "left"), occurrence("right-result", "right")].map((item) => [
      item.id,
      item,
    ]),
  );
  const onOpenArtifact = vi.fn();
  render(<TaskRunGraph sessions={["root", "left", "right", "join"].map((id) => session(id))} state={state} onOpenSession={vi.fn()} onOpenArtifact={onOpenArtifact} />);
  expect(screen.getByRole("button", { name: "Flow" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.getAllByRole("button", { name: "Open artifact 00-ticket.md, occurrence ticket" })).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: "Open artifact context.md, occurrence context" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Open artifact 00-ticket.md, occurrence ticket" }));
  fireEvent.click(within(screen.getByRole("group", { name: "Artifacts published by root" })).getByRole("button", { name: "Open artifact context.md, occurrence context" }));
  expect(onOpenArtifact.mock.calls).toEqual([["00-ticket.md"], ["context.md"]]);
  expect(screen.getAllByRole("listitem").map((edge) => edge.getAttribute("aria-label"))).toEqual([
    "Ordering: root → left",
    "Ordering: root → right",
    "Ordering: left → join",
    "Ordering: right → join",
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Artifact dependencies" }));
  const selector = screen.getByRole("combobox", { name: "Artifact occurrence" });
  expect(within(selector).getAllByRole("option", { name: "00-ticket.md · ticket" })).toHaveLength(1);
  expect(screen.getAllByRole("listitem").map((edge) => edge.getAttribute("aria-label"))).toEqual([
    "Artifact: Seed input → root",
    "Artifact: Seed input → left",
    "Artifact: Seed input → right",
    "Artifact: Seed input → join",
  ]);
  fireEvent.change(selector, { target: { value: "context" } });
  expect(screen.getAllByRole("listitem").map((edge) => edge.getAttribute("aria-label"))).toEqual(["Artifact: root → left", "Artifact: root → right", "Artifact: root → join"]);
  fireEvent.wheel(screen.getByRole("region", { name: "Run graph canvas" }), { deltaY: 10000 });
  expect(screen.getByLabelText("Run graph zoom").textContent).toBe("1%");
  expect(screen.getByRole("button", { name: "Open artifact context.md, occurrence context" })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Flow" }));
  expect(screen.getByLabelText("Run graph zoom").textContent).toBe("100%");
  expect(screen.getAllByRole("listitem")).toHaveLength(4);
});

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

it("reveals seed provenance and missing-producer warnings on artifact selection", () => {
  const state = executionReply([execution("worker", { "ticket.md": ["ticket"], "prior.md": ["prior"] })]).state;
  state.occurrences = {
    ticket: occurrence("ticket", null, "00-ticket.md"),
    prior: occurrence("prior", "missing", "1-prior.md"),
  };
  const onOpenArtifact = vi.fn();
  render(<TaskRunGraph sessions={[session("worker")]} state={state} onOpenArtifact={onOpenArtifact} onOpenSession={vi.fn()} />);
  expect(screen.queryByText("Seed input")).toBeNull();
  expect(screen.queryByText("External artifact")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Artifact dependencies" }));
  expect(screen.getByText("Seed input")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Open artifact 00-ticket.md, occurrence ticket" }));
  expect(onOpenArtifact).toHaveBeenCalledExactlyOnceWith("00-ticket.md");
  expect(screen.getByRole("button", { name: "Open session worker" })).toBeDefined();
  fireEvent.change(screen.getByRole("combobox", { name: "Artifact occurrence" }), { target: { value: "prior" } });
  expect(screen.getByText("Producer not shown")).toBeDefined();
});

it("keeps unconsumed output openable and reveals its consumer when it becomes bound", () => {
  const producer = execution("producer");
  const state = executionReply([producer]).state;
  state.occurrences = { result: occurrence("result", producer.id, "2-result.md") };
  const onOpenArtifact = vi.fn();
  const onOpenSession = vi.fn();
  const { rerender } = render(<TaskRunGraph sessions={[session("producer")]} state={state} onOpenArtifact={onOpenArtifact} onOpenSession={onOpenSession} />);
  expect(screen.queryByText("Published artifact")).toBeNull();
  expect(screen.queryByText("Not yet consumed")).toBeNull();
  expect(screen.getAllByRole("button", { name: /^Open session / })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Open artifact 2-result.md, occurrence result" }));
  expect(onOpenArtifact).toHaveBeenCalledExactlyOnceWith("2-result.md");
  fireEvent.click(screen.getByRole("button", { name: "Artifact dependencies" }));
  expect(screen.getByText("Not yet consumed")).toBeDefined();

  const consumer = execution("consumer", { "result.md": ["result"] });
  rerender(
    <TaskRunGraph
      sessions={[session("producer"), session("consumer")]}
      state={{ ...state, executions: { ...state.executions, [consumer.id]: consumer } }}
      onOpenArtifact={onOpenArtifact}
      onOpenSession={onOpenSession}
    />,
  );
  expect(within(screen.getByRole("list", { name: "Displayed connections" })).getByText("producer → consumer")).toBeDefined();
  expect(screen.queryByText("Not yet consumed")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open session consumer" }));
  expect(onOpenSession.mock.lastCall?.[0].id).toBe("consumer");
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
  expect(graphRegion.getByRole("listitem", { name: "Resumed session (not an artifact): Worker → Worker" })).toBeDefined();
  const outputs = within(screen.getByRole("group", { name: "Artifacts published by Worker" }));
  expect(outputs.getAllByRole("button").map((button) => button.textContent)).toEqual(["result.md", "result.md"]);
  fireEvent.click(screen.getByRole("button", { name: "Artifact dependencies" }));
  const selector = screen.getByRole("combobox", { name: "Artifact occurrence" });
  expect(
    within(selector)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["nested/result.md · first", "nested/result.md · second"]);
  fireEvent.click(graphRegion.getByRole("button", { name: "Open artifact nested/result.md, occurrence first" }));
  fireEvent.change(selector, { target: { value: "second" } });
  fireEvent.click(graphRegion.getByRole("button", { name: "Open artifact nested/result.md, occurrence second" }));
  expect(onOpenArtifact.mock.calls).toEqual([["nested/result.md"], ["nested/result.md"]]);
  fireEvent.click(screen.getByRole("button", { name: "Flow" }));
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
