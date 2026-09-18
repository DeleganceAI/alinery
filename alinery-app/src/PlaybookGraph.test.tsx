import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
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
afterEach(cleanup);

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
  expect(seedInspector.getByText("Inherits playbook default: provider/planning-model")).toBeTruthy();
  expect(seedInspector.getByText("Inherits playbook default: default-harness")).toBeTruthy();
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
  expect(workerRegion.textContent).toContain("Coding stepYes");
  expect(workerRegion.textContent).toContain("Automatic completion by defaultNo");
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

it("illustrates wildcard workers converging into one collector with artifact labels", () => {
  const worker = {
    ...step("square", [], ["result-square.md"]),
    inputs: [{ path: "request-*.md", mode: "each" as const }],
    prompt: "Square the assigned request.",
  };
  render(<PlaybookGraph variant="definition" title="Squares" steps={[step("seed", ["ticket.md"], ["request-*.md"]), worker, step("collect", ["result-*.md"], ["final.md"])]} />);
  const examples = screen.getAllByRole("button", { name: /^Inspect square — example/ });
  expect(examples).toHaveLength(3);
  expect(screen.getAllByRole("button", { name: "Inspect collect" })).toHaveLength(1);
  const connections = within(screen.getByRole("group", { name: "Artifact dependency connections" }));
  expect(connections.getByText("request-*.md")).toBeTruthy();
  expect(connections.getByText("result-square.md")).toBeTruthy();
  fireEvent.click(examples[1]);
  expect(screen.getByLabelText("square prompt").textContent).toBe(worker.prompt);
  for (const example of examples) expect(example.getAttribute("aria-pressed")).toBe("true");
});
