import { expect, it } from "vitest";
import { GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH, layoutDefinitionGraph } from "./playbookGraphLayout";

it("lays out onboarding flow from left to right with connected, bounded nodes", () => {
  const layout = layoutDefinitionGraph(
    ["a", "b", "c"],
    [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ],
    undefined,
    undefined,
    undefined,
    true,
    "horizontal",
  );
  const [a, b, c] = layout.nodes;
  expect(b.x).toBeGreaterThanOrEqual(a.x + GRAPH_NODE_WIDTH);
  expect(c.x).toBeGreaterThanOrEqual(b.x + GRAPH_NODE_WIDTH);
  expect(layout.width).toBeGreaterThanOrEqual(c.x + GRAPH_NODE_WIDTH);
  expect(layout.height).toBeGreaterThanOrEqual(a.y + GRAPH_NODE_HEIGHT);
  expect(layout.edges[0].paths[0]).toContain(`M ${a.x + GRAPH_NODE_WIDTH} ${a.y + GRAPH_NODE_HEIGHT / 2}`);
});
