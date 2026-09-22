import { expect, it } from "vitest";
import { type DefinitionGraphLayout, GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH, layoutDefinitionGraph } from "./playbookGraphLayout";

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
