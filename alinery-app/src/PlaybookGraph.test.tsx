import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlaybookGraph } from "./PlaybookGraph";
import { GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH, layoutDefinitionGraph } from "./playbookGraphLayout";
import type { NormalizedStep } from "./types";

const step = (key: string, inputs: string[], outputs: string[]): NormalizedStep => ({
  key,
  title: key,
  short: key,
  inputs: inputs.map((path) => ({ path, mode: path.includes("*") ? "complete" : "single" })),
  outputs: outputs.map((path) => ({ path })),
  model: "",
  harness: "",
  prompt: "",
  is_coding_step: false,
  auto_advance_default: false,
});

const denseSteps = [
  step("seed", [], ["request.md", "context.md"]),
  step("plan", ["request.md", "context.md"], ["plan.md"]),
  step("build", ["request.md", "plan.md"], ["build.md"]),
  step("review", ["request.md", "context.md", "plan.md", "build.md"], ["review.md", "notes.md"]),
];

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("defaults to reduced Flow without losing any authored inspector dependencies", () => {
  render(<PlaybookGraph variant="definition" title="Dense" steps={denseSteps} />);
  const modes = within(screen.getByRole("group", { name: "Graph display mode" }));
  expect(modes.getByRole("button", { name: "Flow" }).getAttribute("aria-pressed")).toBe("true");
  expect(modes.getByRole("button", { name: "Artifact dependencies" }).getAttribute("aria-pressed")).toBe("false");
  expect(screen.queryByRole("button", { name: "Focus connections" })).toBeNull();
  const flow = screen.getByRole("group", { name: "Flow ordering connections" });
  expect(Array.from(flow.querySelectorAll("g[aria-label]"), (edge) => edge.getAttribute("aria-label"))).toEqual([
    "seed to plan: ordering",
    "plan to build: ordering",
    "build to review: ordering",
  ]);
  expect(flow.querySelector("foreignObject")).toBeNull();
  expect(screen.getByRole("region", { name: "seed definition" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Inspect review" }));
  const inspector = within(screen.getByRole("region", { name: "review definition" }));
  expect(
    within(inspector.getByRole("list", { name: "review inputs" }))
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["request.mdsingle", "context.mdsingle", "plan.mdsingle", "build.mdsingle"]);
  expect(
    within(inspector.getByRole("list", { name: "review outputs" }))
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["review.md", "notes.md"]);
  fireEvent.click(inspector.getByText("Connections (4)"));
  const connections = within(inspector.getByRole("list", { name: "review connections" })).getAllByRole("listitem");
  expect(connections.map((item) => item.getAttribute("aria-label"))).toEqual([
    "seed to review: single",
    "seed to review: single",
    "plan to review: single",
    "build to review: single",
  ]);
  expect(connections.map((item) => item.querySelector("code")?.textContent)).toEqual([
    "request.md → request.md",
    "context.md → context.md",
    "plan.md → plan.md",
    "build.md → build.md",
  ]);
  fireEvent.click(modes.getByRole("button", { name: "Artifact dependencies" }));
  const dependencies = within(screen.getByRole("group", { name: "Artifact dependency connections" }));
  expect(dependencies.getByLabelText("seed to review: request.md → request.md (single); context.md → context.md (single)")).toBeTruthy();
  expect(
    within(inspector.getByRole("list", { name: "review connections" }))
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(connections.map((item) => item.textContent));
});

it("preserves selection and camera across mode switches and focuses edges without moving nodes", () => {
  mockCanvasDimensions();
  render(<PlaybookGraph variant="definition" title="Dense" steps={denseSteps} />);
  const viewport = screen.getByRole("region", { name: "Dependency graph canvas" });
  fireEvent.click(screen.getByRole("button", { name: "Inspect plan" }));
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  fireEvent.pointerDown(viewport, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: 160, clientY: 130, pointerId: 1 });
  fireEvent.pointerUp(window, { clientX: 160, clientY: 130, pointerId: 1 });
  const chosenCamera = camera(viewport);
  fireEvent.click(screen.getByRole("button", { name: "Artifact dependencies" }));
  expect(screen.getByRole("button", { name: "Artifact dependencies" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "Flow" }).getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByRole("button", { name: "Inspect plan" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("region", { name: "plan definition" })).toBeTruthy();
  expect(camera(viewport)).toEqual(chosenCamera);
  const nodes = within(screen.getByRole("group", { name: "Graph steps" }));
  const positions = () =>
    nodes.getAllByRole("button").map((node) => ({
      name: node.getAttribute("aria-label"),
      left: node.style.left,
      top: node.style.top,
    }));
  const beforeFocus = positions();
  const dependencies = screen.getByRole("group", { name: "Artifact dependency connections" });
  const edgeNames = () => Array.from(dependencies.querySelectorAll("g[aria-label]"), (edge) => edge.getAttribute("aria-label"));
  const allEdges = edgeNames();
  expect(allEdges).toHaveLength(6);
  const focus = screen.getByRole("button", { name: "Focus connections" });
  expect(focus.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(focus);
  expect(focus.getAttribute("aria-pressed")).toBe("true");
  expect(edgeNames()).toEqual([
    "seed to plan: request.md → request.md (single); context.md → context.md (single)",
    "plan to build: plan.md → plan.md (single)",
    "plan to review: plan.md → plan.md (single)",
  ]);
  expect(positions()).toEqual(beforeFocus);
  expect(camera(viewport)).toEqual(chosenCamera);
  fireEvent.click(focus);
  expect(edgeNames()).toEqual(allEdges);
  expect(positions()).toEqual(beforeFocus);
  expect(camera(viewport)).toEqual(chosenCamera);
  fireEvent.click(screen.getByRole("button", { name: "Flow" }));
  expect(screen.getByRole("group", { name: "Flow ordering connections" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Focus connections" })).toBeNull();
  expect(screen.getByRole("button", { name: "Inspect plan" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("region", { name: "plan definition" })).toBeTruthy();
  expect(camera(viewport)).toEqual(chosenCamera);
});

it("discloses labels only for hovered endpoints, hovered edges, or explicit selection", () => {
  render(
    <PlaybookGraph
      variant="definition"
      title="Chain"
      steps={[step("seed", [], ["request.md"]), step("plan", ["request.md"], ["plan.md"]), step("build", ["plan.md"], ["build.md"]), step("review", ["build.md"], [])]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Artifact dependencies" }));
  const graph = screen.getByRole("group", { name: "Artifact dependency connections" });
  const labels = within(graph);
  expect(screen.getByRole("region", { name: "seed definition" })).toBeTruthy();
  expect(graph.querySelector("foreignObject")).toBeNull();
  const plan = screen.getByRole("button", { name: "Inspect plan" });
  fireEvent.mouseEnter(plan);
  expect(labels.getByText("request.md")).toBeTruthy();
  expect(labels.getByText("plan.md")).toBeTruthy();
  expect(labels.queryByText("build.md")).toBeNull();
  fireEvent.mouseLeave(plan);
  expect(graph.querySelector("foreignObject")).toBeNull();
  const review = screen.getByRole("button", { name: "Inspect review" });
  fireEvent.mouseEnter(review);
  expect(labels.getByText("build.md")).toBeTruthy();
  expect(labels.queryByText("request.md")).toBeNull();
  fireEvent.mouseLeave(review);
  const edge = labels.getByLabelText("seed to plan: request.md → request.md (single)");
  fireEvent.mouseEnter(edge);
  expect(labels.getByText("request.md")).toBeTruthy();
  expect(labels.queryByText("plan.md")).toBeNull();
  expect(labels.queryByText("build.md")).toBeNull();
  fireEvent.mouseLeave(edge);
  expect(graph.querySelector("foreignObject")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Inspect build" }));
  expect(labels.getByText("plan.md")).toBeTruthy();
  expect(labels.getByText("build.md")).toBeTruthy();
  expect(labels.queryByText("request.md")).toBeNull();
  fireEvent.mouseEnter(edge);
  expect(labels.getByText("request.md")).toBeTruthy();
  fireEvent.mouseLeave(edge);
  expect(labels.queryByText("request.md")).toBeNull();
  expect(labels.getByText("plan.md")).toBeTruthy();
  expect(labels.getByText("build.md")).toBeTruthy();
});

it("lets compact graphs select and focus connections without an implicit initial selection", () => {
  mockCanvasDimensions();
  render(<PlaybookGraph variant="definition" showInspector={false} title="Compact" steps={denseSteps} />);
  const nodes = within(screen.getByRole("group", { name: "Graph steps" }));
  for (const node of nodes.getAllByRole("button")) expect(node.getAttribute("aria-pressed")).toBe("false");
  expect(screen.queryByRole("region", { name: / definition$/ })).toBeNull();
  expect(screen.queryByRole("separator")).toBeNull();
  expect(screen.getByRole("group", { name: "Flow ordering connections" }).querySelector("g[aria-label] path.selected")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Artifact dependencies" }));
  const dependencies = screen.getByRole("group", { name: "Artifact dependency connections" });
  expect(dependencies.querySelector("foreignObject")).toBeNull();
  expect(dependencies.querySelector("g[aria-label] path.selected")).toBeNull();
  const viewport = screen.getByRole("region", { name: "Dependency graph canvas" });
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  const chosenCamera = camera(viewport);
  const positions = nodes.getAllByRole("button").map((node) => node.getAttribute("style"));
  fireEvent.click(nodes.getByRole("button", { name: "Highlight build" }));
  expect(nodes.getByRole("button", { name: "Highlight build" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Focus connections" }));
  expect(screen.getByRole("button", { name: "Focus connections" }).getAttribute("aria-pressed")).toBe("true");
  expect(Array.from(dependencies.querySelectorAll("g[aria-label]"), (edge) => edge.getAttribute("aria-label"))).toEqual([
    "seed to build: request.md → request.md (single)",
    "plan to build: plan.md → plan.md (single)",
    "build to review: build.md → build.md (single)",
  ]);
  expect(nodes.getAllByRole("button").map((node) => node.getAttribute("style"))).toEqual(positions);
  expect(camera(viewport)).toEqual(chosenCamera);
  expect(screen.queryByRole("region", { name: / definition$/ })).toBeNull();
});

it("retains every cyclic and self-loop relationship in Flow", () => {
  render(
    <PlaybookGraph
      variant="definition"
      title="Cycle"
      steps={[step("seed", ["build.md"], ["request.md"]), step("plan", ["request.md"], ["plan.md"]), step("build", ["request.md", "plan.md", "build.md"], ["build.md"])]}
    />,
  );
  const graph = screen.getByRole("group", { name: "Flow ordering connections" });
  expect(Array.from(graph.querySelectorAll("g[aria-label]"), (edge) => edge.getAttribute("aria-label"))).toEqual([
    "seed to plan: ordering",
    "seed to build: ordering",
    "plan to build: ordering",
    "build to seed: ordering",
    "build to build: ordering",
  ]);
  expect(graph.querySelector("foreignObject")).toBeNull();
});

it("renders shuffled selector forks, joins, cycles and concurrent active counts without document-neighbor edges", () => {
  render(
    <PlaybookGraph
      title="Numbers"
      steps={[
        step("join", ["sum.md", "product.md"], ["done.md"]),
        step("sum", ["numbers.md"], ["sum.md"]),
        step("continue", ["done.md"], ["ticket.md"]),
        step("seed", ["ticket.md"], ["numbers.md"]),
        step("product", ["numbers.md"], ["product.md"]),
      ]}
      countsByStep={{ sum: 2, product: 1 }}
    />,
  );
  const relationships = within(screen.getByRole("list", { name: "Artifact dependencies" }));
  expect(relationships.getAllByRole("listitem")).toHaveLength(6);
  for (const name of ["seed to sum: single", "seed to product: single", "sum to join: single", "product to join: single", "join to continue: single", "continue to seed: single"]) {
    expect(relationships.getByRole("listitem", { name })).toBeTruthy();
  }
  expect(relationships.queryByRole("listitem", { name: "sum to continue: single" })).toBeNull();
  expect(screen.getByLabelText("sum: 2 active sessions")).toBeTruthy();
  expect(screen.getByLabelText("product: 1 active sessions")).toBeTruthy();
});

it("relates wildcard families only within the declared directory", () => {
  render(
    <PlaybookGraph
      title="Families"
      steps={[
        step("fanout", [], ["a/request-*.md"]),
        step("worker", ["a/request-*.md"], ["a/result-*.md"]),
        step("merge", ["a/result-*.md"], ["summary.md"]),
        step("unrelated", ["b/result-*.md"], ["other.md"]),
      ]}
    />,
  );
  const relationships = within(screen.getByRole("list", { name: "Artifact dependencies" }));
  expect(relationships.getAllByRole("listitem")).toHaveLength(2);
  expect(relationships.getByRole("listitem", { name: "fanout to worker: complete" })).toBeTruthy();
  expect(relationships.getByRole("listitem", { name: "worker to merge: complete" })).toBeTruthy();
});

it("inspects authored definitions and navigates selector connections without execution state", () => {
  const seed = { ...step("seed", [], ["requests/request-*.md"]), title: "Prepare requests", prompt: "Prepare every request.\nKeep the original instructions." };
  const worker: NormalizedStep = {
    ...step("worker", [], ["results/result-*.md"]),
    title: "Implement request",
    short: "Code",
    inputs: [
      { path: "requests/request-*.md", mode: "each" },
      { path: "context.md", mode: "single" },
      { path: "reviews/*.md", mode: "complete" },
    ],
    model: "provider/coding-model",
    harness: "omp",
    is_coding_step: true,
    prompt: "Read the request in full.\n\nImplement it without changing the requirements.",
  };
  render(
    <PlaybookGraph
      variant="definition"
      title="Requests"
      steps={[seed, worker]}
      defaultModel="provider/planning-model"
      defaultHarness="default-harness"
      countsByStep={{ seed: 3, worker: 2 }}
      selectedAutoAdvance={["seed", "worker"]}
    />,
  );

  const seedInspector = within(screen.getByRole("region", { name: "Prepare requests definition" }));
  expect(seedInspector.getByLabelText("Prepare requests prompt").textContent).toBe(seed.prompt);
  expect(screen.queryByLabelText(/active sessions/)).toBeNull();
  expect(screen.queryByText("Automatic")).toBeNull();

  const workerNode = screen.getByRole("button", { name: "Inspect Implement request — example 2" });
  workerNode.focus();
  expect(document.activeElement).toBe(workerNode);
  fireEvent.click(workerNode);
  expect(workerNode.getAttribute("aria-pressed")).toBe("true");
  const workerRegion = screen.getByRole("region", { name: "Implement request definition" });
  const inspector = within(workerRegion);
  expect(inspector.getByText("worker")).toBeTruthy();
  expect(inspector.getByText("Code")).toBeTruthy();
  expect(inspector.getByText("provider/coding-model")).toBeTruthy();
  expect(inspector.getByText("omp")).toBeTruthy();
  expect(inspector.getByLabelText("Implement request prompt").textContent).toBe(worker.prompt);
  const inputs = within(inspector.getByRole("list", { name: "Implement request inputs" })).getAllByRole("listitem");
  expect(inputs.map((item) => item.textContent)).toEqual(["requests/request-*.mdeach", "context.mdsingle", "reviews/*.mdcomplete"]);
  expect(within(inspector.getByRole("list", { name: "Implement request outputs" })).getByText("results/result-*.md")).toBeTruthy();
  expect(inspector.queryByRole("textbox")).toBeNull();

  fireEvent.click(inspector.getByText("Connections (1)"));
  const connection = within(screen.getByRole("listitem", { name: "Prepare requests to Implement request: each" }));
  fireEvent.click(connection.getByRole("button", { name: "Prepare requests" }));
  expect(screen.getByRole("button", { name: "Inspect Prepare requests" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("region", { name: "Prepare requests definition" })).toBeTruthy();
});

it("keeps definition selection across refreshes and falls back when the selected step disappears", () => {
  const seed = step("seed", [], ["request.md"]);
  const worker = { ...step("worker", ["request.md"], ["result.md"]), prompt: "Original prompt" };
  const { rerender } = render(<PlaybookGraph variant="definition" title="Requests" steps={[seed, worker]} />);
  fireEvent.click(screen.getByRole("button", { name: "Inspect worker" }));

  rerender(<PlaybookGraph variant="definition" title="Requests" steps={[seed, { ...worker, prompt: "Updated prompt" }]} />);
  expect(screen.getByRole("button", { name: "Inspect worker" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByLabelText("worker prompt").textContent).toBe("Updated prompt");

  rerender(<PlaybookGraph variant="definition" title="Requests" steps={[seed]} />);
  expect(screen.getByRole("button", { name: "Inspect seed" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.queryByRole("region", { name: "worker definition" })).toBeNull();
  expect(screen.getByRole("region", { name: "seed definition" })).toBeTruthy();
});

it("draws selector-derived directed connections and keeps dependency details in the selected inspector", () => {
  render(
    <PlaybookGraph
      variant="definition"
      title="Numbers"
      steps={[
        step("seed", ["ticket.md"], ["numbers.md"]),
        step("sum", ["numbers.md"], ["sum.md"]),
        step("product", ["numbers.md"], ["product.md"]),
        step("join", ["sum.md", "product.md"], ["ticket.md"]),
      ]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Artifact dependencies" }));
  const connections = within(screen.getByRole("group", { name: "Artifact dependency connections" }));
  for (const name of [
    "seed to sum: numbers.md → numbers.md (single)",
    "seed to product: numbers.md → numbers.md (single)",
    "sum to join: sum.md → sum.md (single)",
    "product to join: product.md → product.md (single)",
    "join to seed: ticket.md → ticket.md (single)",
  ]) {
    expect(connections.getByLabelText(name)).toBeTruthy();
  }
  expect(connections.queryByLabelText(/sum to product/)).toBeNull();
  expect(screen.queryByRole("list", { name: "Artifact dependencies" })).toBeNull();
  const inspector = within(screen.getByRole("region", { name: "seed definition" }));
  fireEvent.click(inspector.getByText("Connections (3)"));
  const dependencies = within(inspector.getByRole("list", { name: "seed connections" }));
  expect(dependencies.getAllByRole("listitem").map((item) => item.getAttribute("aria-label"))).toEqual(["seed to sum: single", "seed to product: single", "join to seed: single"]);
});

it("lays out fork/join layers with bounded return and self-loop routes without overlapping nodes", () => {
  const links = [
    { from: "seed", to: "sum" },
    { from: "seed", to: "product" },
    { from: "sum", to: "join" },
    { from: "product", to: "join" },
    { from: "join", to: "seed" },
    { from: "join", to: "join" },
    { from: "seed", to: "join" },
  ];
  const layout = layoutDefinitionGraph(["seed", "join", "product", "sum", "isolated"], [...links, links[0]]);
  const nodes = Object.fromEntries(layout.nodes.map((node) => [node.key, node]));
  expect(nodes.sum.y).toBe(nodes.product.y);
  expect(nodes.seed.y).toBeLessThan(nodes.sum.y);
  expect(nodes.sum.y).toBeLessThan(nodes.join.y);
  expect(layout.edges.map(({ from, to }) => ({ from, to }))).toEqual(links);
  expect(layout.edges.filter((edge) => edge.feedback).map(({ from, to }) => ({ from, to }))).toEqual([
    { from: "join", to: "seed" },
    { from: "join", to: "join" },
  ]);
  for (const [index, node] of layout.nodes.entries()) {
    expect(node.x).toBeGreaterThanOrEqual(0);
    expect(node.y).toBeGreaterThanOrEqual(0);
    expect(node.x + GRAPH_NODE_WIDTH).toBeLessThanOrEqual(layout.width);
    expect(node.y + GRAPH_NODE_HEIGHT).toBeLessThanOrEqual(layout.height);
    for (const other of layout.nodes.slice(index + 1)) {
      expect(Math.abs(node.x - other.x) >= GRAPH_NODE_WIDTH || Math.abs(node.y - other.y) >= GRAPH_NODE_HEIGHT).toBe(true);
    }
  }
  for (const edge of layout.edges) {
    for (const path of edge.paths) {
      const coordinates = Array.from(path.matchAll(/-?\d+(?:\.\d+)?/g), (match) => Number(match[0]));
      for (let index = 0; index < coordinates.length; index += 2) {
        expect(coordinates[index]).toBeGreaterThanOrEqual(0);
        expect(coordinates[index]).toBeLessThanOrEqual(layout.width);
        expect(coordinates[index + 1]).toBeGreaterThanOrEqual(0);
        expect(coordinates[index + 1]).toBeLessThanOrEqual(layout.height);
      }
    }
  }
});

it("keeps wildcard illustrations in Flow and discloses artifact labels in dependencies", () => {
  const worker = {
    ...step("square", [], ["result-square.md"]),
    inputs: [{ path: "request-*.md", mode: "each" as const }],
    prompt: "Square the assigned request.",
  };
  render(<PlaybookGraph variant="definition" title="Squares" steps={[step("seed", ["ticket.md"], ["request-*.md"]), worker, step("collect", ["result-*.md"], ["final.md"])]} />);
  const examples = screen.getAllByRole("button", { name: /^Inspect square — example/ });
  expect(examples).toHaveLength(3);
  expect(screen.getAllByRole("button", { name: "Inspect collect" })).toHaveLength(1);
  const flow = within(screen.getByRole("group", { name: "Flow ordering connections" }));
  expect(flow.getByLabelText("seed to square: ordering")).toBeTruthy();
  expect(flow.getByLabelText("square to collect: ordering")).toBeTruthy();
  expect(flow.queryByText("request-*.md")).toBeNull();
  expect(flow.queryByText("result-square.md")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Artifact dependencies" }));
  const connections = within(screen.getByRole("group", { name: "Artifact dependency connections" }));
  expect(connections.queryByText("request-*.md")).toBeNull();
  expect(connections.queryByText("result-square.md")).toBeNull();
  fireEvent.mouseEnter(examples[1]);
  expect(connections.getByText("request-*.md")).toBeTruthy();
  expect(connections.getByText("result-square.md")).toBeTruthy();
  fireEvent.mouseLeave(examples[1]);
  fireEvent.click(examples[1]);
  expect(screen.getByLabelText("square prompt").textContent).toBe(worker.prompt);
  for (const example of examples) expect(example.getAttribute("aria-pressed")).toBe("true");
});

it("resizes the graph with keyboard controls while keeping both panes available", () => {
  render(<PlaybookGraph variant="definition" title="Review" steps={[step("inspect", [], ["result.md"])]} />);
  const divider = screen.getByRole("separator", { name: "Resize graph and description" });
  const initial = Number(divider.getAttribute("aria-valuenow"));
  fireEvent.keyDown(divider, { key: "ArrowLeft" });
  expect(Number(divider.getAttribute("aria-valuenow"))).toBeLessThan(initial);
  fireEvent.keyDown(divider, { key: "ArrowRight" });
  expect(Number(divider.getAttribute("aria-valuenow"))).toBe(initial);
  fireEvent.keyDown(divider, { key: "Home" });
  expect(divider.getAttribute("aria-valuenow")).toBe(divider.getAttribute("aria-valuemin"));
  fireEvent.keyDown(divider, { key: "ArrowLeft" });
  expect(divider.getAttribute("aria-valuenow")).toBe(divider.getAttribute("aria-valuemin"));
  fireEvent.keyDown(divider, { key: "End" });
  expect(divider.getAttribute("aria-valuenow")).toBe(divider.getAttribute("aria-valuemax"));
  expect(screen.getByRole("region", { name: "inspect definition" })).toBeTruthy();
});

it("stops resizing on pointer cancellation without losing the chosen width", () => {
  render(<PlaybookGraph variant="definition" title="Review" steps={[step("inspect", [], ["result.md"])]} />);
  const divider = screen.getByRole("separator", { name: "Resize graph and description" });
  const container = divider.parentElement as HTMLElement;
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue({ width: 1000 } as DOMRect);
  const initial = Number(divider.getAttribute("aria-valuenow"));
  fireEvent.pointerDown(divider, { button: 0, clientX: 650, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: 450, pointerId: 1 });
  const chosen = divider.getAttribute("aria-valuenow");
  expect(Number(chosen)).toBeLessThan(initial);
  fireEvent.pointerCancel(window, { clientX: 0, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: 900, pointerId: 1 });
  fireEvent.pointerUp(window, { clientX: 900, pointerId: 1 });
  expect(divider.getAttribute("aria-valuenow")).toBe(chosen);
});

// JSDOM has no layout: these are the unzoomed, UI-scaled graph dimensions.
function mockCanvasDimensions() {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("playbook-definition-viewport") ? 600 : 1000;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("playbook-definition-viewport") ? 400 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("playbook-definition-canvas") ? 1000 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("playbook-definition-canvas") ? 500 : 0;
  });
}

function camera(viewport: HTMLElement) {
  const stage = viewport.querySelector<HTMLElement>(".playbook-definition-stage");
  const canvas = viewport.querySelector<HTMLElement>(".playbook-definition-canvas");
  if (!stage || !canvas) throw new Error("Graph canvas is not mounted");
  const [tx, ty] = stage.style.transform.slice("translate(".length, -1).split(",").map(Number.parseFloat);
  return { tx, ty, scale: Number(canvas.style.zoom) };
}

it("anchors wheel zoom under the pointer and fits using unzoomed dimensions", () => {
  mockCanvasDimensions();
  render(<PlaybookGraph variant="definition" title="Review" steps={[step("inspect", [], ["result.md"])]} />);
  const viewport = screen.getByRole("region", { name: "Dependency graph canvas" });
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 50, 600, 400));
  const before = camera(viewport);
  const point = { x: 210 - 100, y: 150 - 50 };
  expect(fireEvent.wheel(viewport, { deltaY: -120, clientX: 210, clientY: 150 })).toBe(false);
  const after = camera(viewport);
  expect(after.scale).toBeGreaterThan(before.scale);
  expect((point.x - after.tx) / after.scale).toBeCloseTo((point.x - before.tx) / before.scale);
  expect((point.y - after.ty) / after.scale).toBeCloseTo((point.y - before.ty) / before.scale);

  fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }));
  expect(camera(viewport).scale).toBe(1);
  expect(screen.getByLabelText("Graph zoom").textContent).toBe("100%");
  fireEvent.click(screen.getByRole("button", { name: "Fit graph" }));
  const fitted = camera(viewport);
  expect(fitted.tx).toBeGreaterThanOrEqual(16);
  expect(fitted.ty).toBeGreaterThanOrEqual(16);
  expect(fitted.tx + 1000 * fitted.scale).toBeLessThanOrEqual(584);
  expect(fitted.ty + 500 * fitted.scale).toBeLessThanOrEqual(384);
  expect(fitted.scale).toBeCloseTo(before.scale);
});

it("preserves node selection and inspector content after zoom and background panning", () => {
  mockCanvasDimensions();
  const worker = { ...step("worker", ["request.md"], ["result.md"]), prompt: "Keep this inspector independent of the graph camera." };
  render(<PlaybookGraph variant="definition" title="Review" steps={[step("seed", [], ["request.md"]), worker]} />);
  const viewport = screen.getByRole("region", { name: "Dependency graph canvas" });
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  const zoomed = camera(viewport);
  fireEvent.pointerDown(viewport, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: 160, clientY: 130, pointerId: 1 });
  fireEvent.pointerUp(window, { clientX: 160, clientY: 130, pointerId: 1 });
  expect(camera(viewport)).toEqual({ ...zoomed, tx: zoomed.tx + 60, ty: zoomed.ty + 30 });
  const panned = camera(viewport);
  fireEvent.pointerMove(window, { clientX: 400, clientY: 300, pointerId: 1 });
  expect(camera(viewport)).toEqual(panned);

  const node = screen.getByRole("button", { name: "Inspect worker" });
  fireEvent.pointerDown(node, { button: 0, clientX: 160, clientY: 130, pointerId: 2 });
  fireEvent.pointerMove(window, { clientX: 200, clientY: 150, pointerId: 2 });
  fireEvent.pointerUp(window, { clientX: 200, clientY: 150, pointerId: 2 });
  fireEvent.click(node);
  expect(node.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByLabelText("worker prompt").textContent).toBe(worker.prompt);
  expect(camera(viewport)).toEqual(panned);
  expect(screen.getByLabelText("Graph zoom").textContent).toBe(`${Math.round(panned.scale * 100)}%`);
});

it("reveals keyboard-focused nodes without intercepting their keys", () => {
  mockCanvasDimensions();
  render(<PlaybookGraph variant="definition" title="Review" steps={[step("inspect", [], ["result.md"])]} />);
  const viewport = screen.getByRole("region", { name: "Dependency graph canvas" });
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 400));
  fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }));
  const node = screen.getByRole("button", { name: "Inspect inspect" });
  vi.spyOn(node, "getBoundingClientRect").mockImplementation(() => {
    const { tx, ty, scale } = camera(viewport);
    return new DOMRect(tx + 800 * scale, ty + 450 * scale, GRAPH_NODE_WIDTH * scale, GRAPH_NODE_HEIGHT * scale);
  });
  fireEvent.focus(node);
  const rect = node.getBoundingClientRect();
  expect(rect.left).toBeGreaterThanOrEqual(16);
  expect(rect.top).toBeGreaterThanOrEqual(16);
  expect(rect.right).toBeLessThanOrEqual(584);
  expect(rect.bottom).toBeLessThanOrEqual(384);
  const revealed = camera(viewport);
  expect(fireEvent.keyDown(node, { key: "+" })).toBe(true);
  expect(fireEvent.keyDown(node, { key: "ArrowRight" })).toBe(true);
  expect(camera(viewport)).toEqual(revealed);
  fireEvent.click(screen.getByRole("button", { name: "Pan graph" }));
  expect(document.activeElement).toBe(viewport);
  expect(fireEvent.keyDown(viewport, { key: "+" })).toBe(false);
  expect(camera(viewport).scale).toBeCloseTo(revealed.scale * 1.25);
  const zoomed = camera(viewport);
  fireEvent.keyDown(viewport, { key: "ArrowRight" });
  expect(camera(viewport).tx).toBe(zoomed.tx - 40);
  fireEvent.keyDown(viewport, { key: "Escape" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Pan graph" }));
});

it("attaches canvas gestures after empty and execution views without reducing the execution list", () => {
  mockCanvasDimensions();
  const steps = denseSteps;
  const { rerender } = render(<PlaybookGraph variant="definition" title="Review" steps={[]} />);
  expect(screen.queryByRole("region", { name: "Dependency graph canvas" })).toBeNull();
  rerender(<PlaybookGraph variant="definition" title="Review" steps={steps} />);
  const viewport = screen.getByRole("region", { name: "Dependency graph canvas" });
  expect(fireEvent.wheel(viewport, { deltaY: -120, clientX: 100, clientY: 100 })).toBe(false);
  const zoomed = camera(viewport);
  rerender(<PlaybookGraph variant="definition" title="Review" steps={steps.map((entry) => ({ ...entry }))} />);
  expect(camera(viewport)).toEqual(zoomed);
  rerender(<PlaybookGraph variant="execution" title="Review" steps={steps} countsByStep={{ build: 2 }} selectedAutoAdvance={["review"]} />);
  expect(screen.queryByRole("group", { name: "Graph zoom controls" })).toBeNull();
  expect(screen.queryByRole("group", { name: "Graph display mode" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Focus connections" })).toBeNull();
  const dependencies = within(screen.getByRole("list", { name: "Artifact dependencies" })).getAllByRole("listitem");
  expect(dependencies.map((item) => item.getAttribute("aria-label"))).toEqual([
    "seed to plan: single",
    "seed to plan: single",
    "seed to build: single",
    "seed to review: single",
    "seed to review: single",
    "plan to build: single",
    "plan to review: single",
    "build to review: single",
  ]);
  expect(dependencies.map((item) => item.querySelector("code")?.textContent)).toEqual([
    "request.md → request.md",
    "context.md → context.md",
    "request.md → request.md",
    "request.md → request.md",
    "context.md → context.md",
    "plan.md → plan.md",
    "plan.md → plan.md",
    "build.md → build.md",
  ]);
  expect(screen.getByLabelText("build: 2 active sessions")).toBeTruthy();
  expect(screen.getByTitle("Completion automatically authorized")).toBeTruthy();
  expect(fireEvent.wheel(viewport, { deltaY: -120, clientX: 100, clientY: 100 })).toBe(true);
  rerender(<PlaybookGraph variant="definition" title="Review" steps={steps} />);
  expect(fireEvent.wheel(screen.getByRole("region", { name: "Dependency graph canvas" }), { deltaY: -120, clientX: 100, clientY: 100 })).toBe(false);
});
