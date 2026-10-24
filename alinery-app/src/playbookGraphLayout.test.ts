import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { type DefinitionGraphLayout, GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH, layoutDefinitionGraph, reduceFlowConnections } from "./playbookGraphLayout";

type Rectangle = { x: number; y: number; width: number; height: number };

function expectSeparated(rectangles: Rectangle[]) {
  for (const [index, rectangle] of rectangles.entries()) {
    for (const other of rectangles.slice(index + 1)) {
      expect(
        rectangle.x + rectangle.width <= other.x || other.x + other.width <= rectangle.x || rectangle.y + rectangle.height <= other.y || other.y + other.height <= rectangle.y,
      ).toBe(true);
    }
  }
}

function expectBounded(layout: DefinitionGraphLayout) {
  const rectangles = [
    ...layout.nodes.map((node) => ({ ...node, width: GRAPH_NODE_WIDTH, height: GRAPH_NODE_HEIGHT })),
    ...layout.edges.filter((edge) => edge.label).map((edge) => ({ x: edge.labelX, y: edge.labelY, width: edge.labelWidth, height: edge.labelHeight })),
  ];
  expectSeparated(rectangles);
  for (const rectangle of rectangles) {
    expect(rectangle.x).toBeGreaterThanOrEqual(0);
    expect(rectangle.y).toBeGreaterThanOrEqual(0);
    expect(rectangle.x + rectangle.width).toBeLessThanOrEqual(layout.width);
    expect(rectangle.y + rectangle.height).toBeLessThanOrEqual(layout.height);
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
}

it("reserves nonoverlapping space for zoom-compensated multiline artifact targets", () => {
  const layout = layoutDefinitionGraph(
    ["producer", "left", "right", "join"],
    [
      { from: "producer", to: "left", label: "result.md · first\nresult.md · second\nlong-artifact-filename-with-many-words-to-wrap-across-lines.md" },
      { from: "producer", to: "right", label: "right.md" },
      { from: "left", to: "join", label: "left-result.md" },
      { from: "right", to: "join", label: "right-result.md" },
    ],
    undefined,
    96,
  );
  expectBounded(layout);
  expect(layout.edges[0].labelHeight).toBeGreaterThanOrEqual(4 * 96);
  expect(layout.edges.every((edge) => edge.labelWidth >= 96)).toBe(true);
});

it("fans a wildcard request into three illustrative instances and merges their results without changing canonical dependencies", () => {
  const layout = layoutDefinitionGraph(
    ["seed", "square", "collect"],
    [
      { from: "seed", to: "square", label: "request-*.md" },
      { from: "square", to: "collect", label: "result-square.md" },
    ],
    new Set(["square"]),
  );
  const byKey = Object.fromEntries(layout.nodes.map((node) => [node.key, node]));
  const seed = byKey.seed;
  const collect = byKey.collect;
  const squares = layout.nodes.filter((node) => node.key === "square");
  expect(squares.map((node) => node.instance)).toEqual([1, 2, 3]);
  expect(new Set(layout.nodes.map((node) => node.id)).size).toBe(layout.nodes.length);
  expect(seed.instance).toBeNull();
  expect(collect.instance).toBeNull();
  expect(squares.every((node) => node.y === squares[0].y && node.y > seed.y && node.y < collect.y)).toBe(true);
  expect(layout.ellipses).toHaveLength(1);
  expect(layout.ellipses[0].x).toBeGreaterThan(squares[1].x + GRAPH_NODE_WIDTH);
  expect(layout.ellipses[0].x).toBeLessThan(squares[2].x);
  expect(layout.edges.map(({ from, to, label }) => ({ from, to, label }))).toEqual([
    { from: "seed", to: "square", label: "request-*.md" },
    { from: "square", to: "collect", label: "result-square.md" },
  ]);
  const [fanout, merge] = layout.edges;
  expect(fanout.paths).toHaveLength(3);
  expect(merge.paths).toHaveLength(3);
  for (const [index, square] of squares.entries()) {
    expect(fanout.paths[index].endsWith(`${square.x + GRAPH_NODE_WIDTH / 2} ${square.y}`)).toBe(true);
    expect(merge.paths[index].startsWith(`M ${square.x + GRAPH_NODE_WIDTH / 2} ${square.y + GRAPH_NODE_HEIGHT} `)).toBe(true);
    expect(merge.paths[index].endsWith(`${collect.x + GRAPH_NODE_WIDTH / 2} ${collect.y}`)).toBe(true);
  }
  for (const edge of layout.edges) {
    const from = byKey[edge.from];
    const to = byKey[edge.to];
    expect(edge.labelY).toBeGreaterThan(from.y + GRAPH_NODE_HEIGHT);
    expect(edge.labelY + edge.labelHeight).toBeLessThan(to.y);
  }
  expectBounded(layout);
});

it("pairs representative repeated groups without fictional all-to-all edges and preserves every distinct same-pair artifact label", () => {
  const layout = layoutDefinitionGraph(
    ["request", "result"],
    [
      { from: "request", to: "result", label: "requests/request-*.md" },
      { from: "request", to: "result", label: "context.md\nreview.md" },
      { from: "request", to: "result", label: "context.md" },
    ],
    new Set(["request", "result"]),
  );
  expect(layout.edges).toHaveLength(1);
  expect(layout.edges[0].label).toBe("requests/request-*.md\ncontext.md\nreview.md");
  expect(layout.edges[0].paths).toHaveLength(3);
  const from = layout.nodes.filter((node) => node.key === "request");
  const to = layout.nodes.filter((node) => node.key === "result");
  for (const [index, path] of layout.edges[0].paths.entries()) {
    expect(path.startsWith(`M ${from[index].x + GRAPH_NODE_WIDTH / 2} ${from[index].y + GRAPH_NODE_HEIGHT} `)).toBe(true);
    expect(path.endsWith(`${to[index].x + GRAPH_NODE_WIDTH / 2} ${to[index].y}`)).toBe(true);
  }
  expectBounded(layout);
});

it("keeps numerous bypass labels, feedback, self-loops and disconnected nodes bounded and separate", () => {
  const stages = ["purpose", "principles", "vision", "brainstorm", "organize", "actions"];
  const links = stages.slice(1).map((to, index) => ({ from: stages[index], to, label: `${stages[index]}.md` }));
  for (let from = 0; from < stages.length - 2; from++) {
    for (let to = from + 2; to < stages.length; to++) {
      links.push({ from: stages[from], to: stages[to], label: `planning/${stages[from]}/context-for-${stages[to]}.md\nshared-context.md` });
    }
  }
  links.push({ from: "actions", to: "purpose", label: "reconsider.md" }, { from: "organize", to: "organize", label: "revise-organization.md" });
  const layout = layoutDefinitionGraph([...stages, "disconnected"], links, new Set(["brainstorm", "organize"]));
  expect(layout.edges.map(({ from, to, label }) => ({ from, to, label }))).toEqual(links);
  expect(layout.edges.filter((edge) => edge.feedback).map((edge) => [edge.from, edge.to])).toEqual([
    ["actions", "purpose"],
    ["organize", "organize"],
  ]);
  const byKey = Object.fromEntries(layout.nodes.map((node) => [node.key, node]));
  for (let index = 1; index < stages.length; index++) {
    expect(byKey[stages[index]].y).toBeGreaterThan(byKey[stages[index - 1]].y);
  }
  expectBounded(layout);
});

it("reduces the bundled PRIMED artifact graph from fifteen links to five regardless of source order", () => {
  // Read the bundled fixture's inline TOML fields, not a second hand-maintained definition.
  const frontmatter = readFileSync("src-tauri/playbooks/primed-feature-development/playbook.md", "utf8").split("+++")[1];
  const steps = frontmatter
    .split("[[step]]")
    .slice(1)
    .map((block) => {
      const paths = (field: string) => Array.from((block.match(new RegExp(`^${field} = (.+)$`, "m"))?.[1] ?? "").matchAll(/path = "([^"]+)"/g), (match) => match[1]);
      const key = block.match(/^key = "([^"]+)"$/m)?.[1];
      if (!key) throw new Error("Bundled PRIMED step is missing its key");
      return { key, inputs: paths("inputs"), outputs: paths("outputs") };
    });
  const connectionsFor = (ordered: typeof steps) =>
    ordered.flatMap((from) => ordered.flatMap((to) => from.outputs.filter((path) => to.inputs.includes(path)).map((label) => ({ from: from.key, to: to.key, label }))));
  const connections = connectionsFor(steps);
  const expected = [
    ["probe-the-question", "research-the-problem"],
    ["research-the-problem", "identify-the-direction"],
    ["identify-the-direction", "map-the-plan"],
    ["map-the-plan", "establish-the-test-contract"],
    ["establish-the-test-contract", "develop-the-change"],
  ];
  expect(connections).toHaveLength(15);
  expect(reduceFlowConnections(connections).map(({ from, to }) => [from, to])).toEqual(expected);
  const shuffled = connectionsFor([steps[4], steps[1], steps[5], steps[0], steps[3], steps[2]]);
  expect(
    reduceFlowConnections(shuffled)
      .map(({ from, to }) => [from, to])
      .sort(),
  ).toEqual([...expected].sort());
});

it("preserves both diamond branches and disconnected components while removing a transitive shortcut", () => {
  const connections = [
    { from: "root", to: "join" },
    { from: "right", to: "join" },
    { from: "root", to: "left" },
    { from: "left", to: "join" },
    { from: "root", to: "right" },
    { from: "separate", to: "leaf" },
  ];
  const reduced = reduceFlowConnections(connections);
  expect(reduced).toEqual(connections.slice(1));
  const layout = layoutDefinitionGraph(["join", "right", "isolated", "leaf", "root", "left", "separate"], reduced);
  const byKey = Object.fromEntries(layout.nodes.map((node) => [node.key, node]));
  expect(byKey.left.y).toBe(byKey.right.y);
  expect(byKey.root.y).toBeLessThan(byKey.left.y);
  expect(byKey.join.y).toBeGreaterThan(byKey.left.y);
  expect(byKey.separate.y).toBeLessThan(byKey.leaf.y);
  expect(byKey.isolated.instance).toBeNull();
  expectBounded(layout);
});

it("deduplicates ordering pairs without changing retained connection objects or artifact metadata", () => {
  const connections = [
    { from: "a", to: "b", label: "first.md", artifact: { required: true } },
    { from: "a", to: "b", label: "second.md", artifact: { required: false } },
    { from: "a", to: "c", label: "first.md", artifact: { required: true } },
    { from: "b", to: "c", label: "first.md", artifact: { required: false } },
  ];
  const original = structuredClone(connections);
  for (const connection of connections) {
    Object.freeze(connection.artifact);
    Object.freeze(connection);
  }
  Object.freeze(connections);
  const reduced = reduceFlowConnections(connections);
  expect(reduced).toEqual([connections[0], connections[3]]);
  expect(reduced[0]).toBe(connections[0]);
  expect(reduced[1]).toBe(connections[3]);
  expect(connections).toEqual(original);
});

it.each([
  { name: "return edge", cycle: [{ from: "c", to: "a", label: "return.md" }] },
  { name: "two-node cycle", cycle: [{ from: "b", to: "a", label: "return.md" }] },
  { name: "self-loop", cycle: [{ from: "b", to: "b", label: "revise.md" }] },
  {
    name: "disconnected cycle",
    cycle: [
      { from: "x", to: "y", label: "out.md" },
      { from: "y", to: "x", label: "back.md" },
    ],
  },
])("retains every original connection when there is a $name", ({ cycle }) => {
  const connections = [
    { from: "a", to: "b", label: "first.md" },
    { from: "b", to: "c", label: "second.md" },
    { from: "a", to: "c", label: "shortcut.md" },
    { from: "a", to: "b", label: "duplicate.md" },
    ...cycle,
  ];
  expect(reduceFlowConnections(connections)).toEqual(connections);
});

it("keeps wildcard fan-out and merge illustrations when reduced ordering links are unlabelled", () => {
  const connections = [
    { from: "seed", to: "square", label: "request-*.md" },
    { from: "seed", to: "collect", label: "context.md" },
    { from: "square", to: "collect", label: "result-square.md" },
  ];
  const layout = layoutDefinitionGraph(
    ["collect", "square", "seed"],
    reduceFlowConnections(connections).map(({ from, to }) => ({ from, to })),
    new Set(["square"]),
  );
  expect(layout.nodes.filter((node) => node.key === "square").map((node) => node.instance)).toEqual([1, 2, 3]);
  expect(layout.edges.map(({ from, to, label, paths }) => ({ from, to, label, paths: paths.length }))).toEqual([
    { from: "seed", to: "square", label: "", paths: 3 },
    { from: "square", to: "collect", label: "", paths: 3 },
  ]);
  expect(layout.ellipses).toHaveLength(1);
  expectBounded(layout);
});

it("handles graphs without ordering connections", () => {
  expect(reduceFlowConnections([])).toEqual([]);
});

it("lays out horizontal flows with stacked fan-out and correctly directed return paths", () => {
  const keys = ["seed", "worker", "collect", "finish"];
  const links = [
    { from: "seed", to: "worker" },
    { from: "worker", to: "collect" },
    { from: "collect", to: "finish" },
    { from: "seed", to: "finish" },
    { from: "finish", to: "seed" },
  ];
  const repeated = new Set(["worker"]);
  const layout = layoutDefinitionGraph(keys, links, repeated, undefined, undefined, true, "horizontal");
  expectBounded(layout);
  const workers = layout.nodes.filter((node) => node.key === "worker");
  expect(workers.map((node) => node.instance)).toEqual([1, 2, 3]);
  expect(workers.every((node) => node.x === workers[0].x)).toBe(true);
  expect(workers[1].y).toBeGreaterThan(workers[0].y + GRAPH_NODE_HEIGHT);
  expect(layout.ellipses[0].y).toBeGreaterThan(workers[1].y + GRAPH_NODE_HEIGHT);
  expect(layout.ellipses[0].y).toBeLessThan(workers[2].y);
  const first = Object.fromEntries(layout.nodes.map((node) => [node.key, node]));
  expect(first.seed.x).toBeLessThan(first.worker.x);
  expect(first.worker.x).toBeLessThan(first.collect.x);
  expect(first.collect.x).toBeLessThan(first.finish.x);
  expect(layout.edges.map(({ from, to }) => ({ from, to }))).toEqual(links);
  expect(layout.edges.filter((edge) => edge.feedback).map(({ from, to }) => ({ from, to }))).toEqual([{ from: "finish", to: "seed" }]);
  for (const edge of layout.edges) {
    const from = layout.nodes.filter((node) => node.key === edge.from);
    const to = layout.nodes.filter((node) => node.key === edge.to);
    edge.paths.forEach((path, index) => {
      const source = from[index % from.length];
      const destination = to[index % to.length];
      expect(path.startsWith(`M ${source.x + GRAPH_NODE_WIDTH} ${source.y + GRAPH_NODE_HEIGHT / 2} `)).toBe(true);
      expect(path.endsWith(`${destination.x} ${destination.y + GRAPH_NODE_HEIGHT / 2}`)).toBe(true);
    });
  }
});

it("keeps labeled dependency layouts vertical even when horizontal flow is requested", () => {
  const links = [{ from: "seed", to: "worker", label: "requests/request-*.md" }];
  expect(layoutDefinitionGraph(["seed", "worker"], links, new Set(["worker"]), undefined, undefined, true, "horizontal")).toEqual(
    layoutDefinitionGraph(["seed", "worker"], links, new Set(["worker"]), undefined, undefined, true),
  );
});

it("respects custom node heights across the horizontal axis", () => {
  const heights = new Map([["worker", 120]]);
  const layout = layoutDefinitionGraph(["seed", "worker"], [{ from: "seed", to: "worker" }], new Set(["worker"]), undefined, heights, true, "horizontal");
  const rectangles = layout.nodes.map((node) => ({ ...node, width: GRAPH_NODE_WIDTH, height: heights.get(node.key) ?? GRAPH_NODE_HEIGHT }));
  expectSeparated(rectangles);
  for (const rectangle of rectangles) {
    expect(rectangle.x + rectangle.width).toBeLessThanOrEqual(layout.width);
    expect(rectangle.y + rectangle.height).toBeLessThanOrEqual(layout.height);
  }
  const workers = layout.nodes.filter((node) => node.key === "worker");
  layout.edges[0].paths.forEach((path, index) => {
    expect(path.endsWith(`${workers[index].x} ${workers[index].y + 60}`)).toBe(true);
  });
});

it("compacts an eight-step flow without losing fan-out, bypass or return connections", () => {
  const keys = ["frame", "plan", "gather", "dispatch", "read", "consolidate", "synthesize", "continue"];
  const links = [...keys.slice(1).map((to, index) => ({ from: keys[index], to })), ...keys.slice(3).map((to) => ({ from: "frame", to })), { from: "continue", to: "plan" }];
  const repeated = new Set(["gather", "read"]);
  const regular = layoutDefinitionGraph(keys, links, repeated);
  const compact = layoutDefinitionGraph(keys, links, repeated, undefined, undefined, true);
  expect(compact.height).toBeLessThanOrEqual(800);
  expect(compact.height).toBeLessThan(regular.height);
  expect(compact.nodes.map(({ id, instance }) => ({ id, instance }))).toEqual(regular.nodes.map(({ id, instance }) => ({ id, instance })));
  expect(compact.edges.map(({ from, to, paths, feedback }) => ({ from, to, count: paths.length, feedback }))).toEqual(
    regular.edges.map(({ from, to, paths, feedback }) => ({ from, to, count: paths.length, feedback })),
  );
  expectBounded(compact);

  const labeled = links.map((link) => ({ ...link, label: "artifact.md" }));
  expect(layoutDefinitionGraph(keys, labeled, repeated, undefined, undefined, true)).toEqual(layoutDefinitionGraph(keys, labeled, repeated));
});

it("keeps producer output footers clear of edges and later ranks, including terminal outputs", () => {
  const heights = new Map([
    ["root", 144],
    ["left", 216],
    ["join", 168],
  ]);
  const layout = layoutDefinitionGraph(
    ["root", "left", "right", "join"],
    [
      { from: "root", to: "left" },
      { from: "root", to: "right" },
      { from: "left", to: "join" },
      { from: "right", to: "join" },
    ],
    undefined,
    undefined,
    heights,
  );
  const nodes = Object.fromEntries(layout.nodes.map((node) => [node.key, node]));
  expect(nodes.left.y).toBe(nodes.right.y);
  expect(nodes.left.y).toBeGreaterThan(nodes.root.y + 144);
  expect(nodes.join.y).toBeGreaterThan(nodes.left.y + 216);
  expect(layout.height).toBeGreaterThan(nodes.join.y + 168);
  for (const edge of layout.edges) {
    const from = nodes[edge.from];
    expect(edge.paths[0].startsWith(`M ${from.x + GRAPH_NODE_WIDTH / 2} ${from.y + (heights.get(edge.from) ?? GRAPH_NODE_HEIGHT)} `)).toBe(true);
  }
});
