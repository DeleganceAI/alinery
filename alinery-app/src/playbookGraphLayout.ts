export const GRAPH_NODE_WIDTH = 176;
export const GRAPH_NODE_HEIGHT = 64;

interface Connection {
  from: string;
  to: string;
  label?: string;
}

/** Keep only essential DAG ordering pairs; cyclic graphs retain every original connection. */
export function reduceFlowConnections<T extends { from: string; to: string }>(connections: T[]): T[] {
  const unique = new Map<string, T>();
  const outgoing = new Map<string, T[]>();
  for (const connection of connections) {
    const pair = JSON.stringify([connection.from, connection.to]);
    if (unique.has(pair)) continue;
    unique.set(pair, connection);
    const links = outgoing.get(connection.from);
    if (links) links.push(connection);
    else outgoing.set(connection.from, [connection]);
  }

  const visiting = new Set<string>();
  const descendants = new Map<string, Set<string>>();
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return false;
    if (descendants.has(key)) return true;
    visiting.add(key);
    const reachable = new Set<string>();
    for (const link of outgoing.get(key) ?? []) {
      if (!visit(link.to)) return false;
      reachable.add(link.to);
      for (const descendant of descendants.get(link.to) ?? []) reachable.add(descendant);
    }
    visiting.delete(key);
    descendants.set(key, reachable);
    return true;
  };
  for (const key of outgoing.keys()) {
    if (!visit(key)) return connections;
  }

  return [...unique.values()].filter((connection) => !outgoing.get(connection.from)?.some((other) => descendants.get(other.to)?.has(connection.to)));
}

export interface DefinitionGraphLayout {
  nodes: { key: string; id: string; instance: number | null; x: number; y: number }[];
  edges: {
    from: string;
    to: string;
    paths: string[];
    feedback: boolean;
    label: string;
    labelX: number;
    labelY: number;
    labelWidth: number;
    labelHeight: number;
  }[];
  ellipses: { key: string; x: number; y: number }[];
  width: number;
  height: number;
}

const PADDING = 24;
const COLUMN_GAP = 40;
const ELLIPSIS_GAP = 72;
const TRACK_GAP = 14;
const LABEL_GAP = 12;
const LABEL_PADDING = 12;
const LABEL_LINE_HEIGHT = 16;
const LABEL_CHARACTER_WIDTH = 7.3;
const LABEL_MAX_WIDTH = 240;

function measureLabel(label: string) {
  if (!label) return { width: 0, height: 0 };
  const lines = label.split("\n");
  const width = Math.min(LABEL_MAX_WIDTH, Math.max(...lines.map((line) => line.length)) * LABEL_CHARACTER_WIDTH + LABEL_PADDING);
  const charactersPerLine = Math.max(1, Math.floor((width - LABEL_PADDING) / LABEL_CHARACTER_WIDTH));
  const lineCount = lines.reduce((count, line) => count + Math.max(1, Math.ceil(line.length / charactersPerLine)), 0);
  return { width, height: lineCount * LABEL_LINE_HEIGHT + LABEL_PADDING };
}

/** Layer canonical dependencies; repeated boxes illustrate multiplicity, not execution cardinality. */
export function layoutDefinitionGraph(keys: string[], connections: Connection[], repeatedKeys: ReadonlySet<string> = new Set()): DefinitionGraphLayout {
  const combined = new Map<string, { from: string; to: string; labels: Set<string> }>();
  for (const connection of connections) {
    const pair = JSON.stringify([connection.from, connection.to]);
    let link = combined.get(pair);
    if (!link) {
      link = { from: connection.from, to: connection.to, labels: new Set() };
      combined.set(pair, link);
    }
    for (const label of connection.label?.split("\n") ?? []) {
      if (label) link.labels.add(label);
    }
  }
  const links = [...combined.values()].map(({ from, to, labels }) => ({ from, to, label: [...labels].join("\n") }));
  const outgoing: Record<string, (typeof links)[number][]> = Object.fromEntries(keys.map((key) => [key, []]));
  const incoming: Record<string, number> = Object.fromEntries(keys.map((key) => [key, 0]));
  for (const link of links) {
    outgoing[link.from].push(link);
    incoming[link.to]++;
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const feedback = new Set<(typeof links)[number]>();
  const order: string[] = [];
  const visit = (key: string) => {
    if (visited.has(key)) return;
    visiting.add(key);
    for (const link of outgoing[key]) {
      if (visiting.has(link.to)) feedback.add(link);
      else visit(link.to);
    }
    visiting.delete(key);
    visited.add(key);
    order.push(key);
  };
  // Prefer actual roots; source order only breaks ties, never creates a connection.
  keys.filter((key) => incoming[key] === 0).forEach(visit);
  keys.forEach(visit);

  const ranks: Record<string, number> = Object.fromEntries(keys.map((key) => [key, 0]));
  for (const key of order.reverse()) {
    for (const link of outgoing[key]) {
      if (!feedback.has(link)) ranks[link.to] = Math.max(ranks[link.to], ranks[key] + 1);
    }
  }
  const layers: string[][] = [];
  for (const key of keys) {
    const rank = ranks[key];
    layers[rank] ??= [];
    layers[rank].push(key);
  }

  const groupWidth = (key: string) => (repeatedKeys.has(key) ? GRAPH_NODE_WIDTH * 3 + COLUMN_GAP + ELLIPSIS_GAP : GRAPH_NODE_WIDTH);
  const layerWidths = layers.map((layer) => layer.reduce((width, key) => width + groupWidth(key), 0) + (layer.length - 1) * COLUMN_GAP);
  const routes = links.map((link) => {
    const isFeedback = feedback.has(link);
    return {
      ...link,
      feedback: isFeedback,
      side: isFeedback ? -1 : ranks[link.to] > ranks[link.from] + 1 ? 1 : 0,
      ...measureLabel(link.label),
      labelX: 0,
      gapY: 0,
      track: 0,
    };
  });
  const contentWidth = Math.max(GRAPH_NODE_WIDTH, ...layerWidths, ...routes.filter((route) => !route.side).map((route) => route.width));
  const leftRoutes = routes.filter((route) => route.side === -1);
  const rightRoutes = routes.filter((route) => route.side === 1);
  const leftLabelWidth = Math.max(0, ...leftRoutes.map((route) => route.width));
  const rightLabelWidth = Math.max(0, ...rightRoutes.map((route) => route.width));
  // Side labels share a column rather than making every long dependency a label-wide lane.
  const gutter = (count: number, labelWidth: number) => (count ? 24 + labelWidth + LABEL_GAP + count * TRACK_GAP : 0);
  const leftGutter = gutter(leftRoutes.length, leftLabelWidth);
  const rightGutter = gutter(rightRoutes.length, rightLabelWidth);
  const contentX = PADDING + leftGutter;
  const groups: Record<string, { x: number; centers: number[] }> = Object.create(null);
  for (const [rank, layer] of layers.entries()) {
    let x = contentX + (contentWidth - layerWidths[rank]) / 2;
    for (const key of layer) {
      groups[key] = {
        x,
        centers: repeatedKeys.has(key)
          ? [x + GRAPH_NODE_WIDTH / 2, x + GRAPH_NODE_WIDTH * 1.5 + COLUMN_GAP, x + GRAPH_NODE_WIDTH * 2.5 + COLUMN_GAP + ELLIPSIS_GAP]
          : [x + GRAPH_NODE_WIDTH / 2],
      };
      x += groupWidth(key) + COLUMN_GAP;
    }
  }
  leftRoutes.forEach((route, index) => {
    route.track = PADDING + (leftRoutes.length - index - 1) * TRACK_GAP;
    route.labelX = contentX - 24 - route.width;
  });
  rightRoutes.forEach((route, index) => {
    route.track = contentX + contentWidth + 24 + rightLabelWidth + LABEL_GAP + index * TRACK_GAP;
    route.labelX = contentX + contentWidth + 24;
  });
  for (const route of routes) {
    if (route.side) continue;
    const fromCenter = groups[route.from].x + groupWidth(route.from) / 2;
    const toCenter = groups[route.to].x + groupWidth(route.to) / 2;
    route.labelX = Math.max(contentX, Math.min(contentX + contentWidth - route.width, (fromCenter + toCenter - route.width) / 2));
  }

  // Pack labels in the gap after their source rank. Overlapping horizontal spans get
  // separate rows; side labels can share rows with ordinary dependency labels.
  const gapHeights = layers.map(() => 64);
  const labelsByRank = layers.map(() => [] as (typeof routes)[number][]);
  for (const route of routes) {
    const placed = labelsByRank[ranks[route.from]];
    let y = 16;
    if (route.height) {
      for (const other of placed) {
        if (route.labelX < other.labelX + other.width + LABEL_GAP && route.labelX + route.width + LABEL_GAP > other.labelX) {
          y = Math.max(y, other.gapY + other.height + LABEL_GAP);
        }
      }
      placed.push(route);
    }
    route.gapY = y;
    gapHeights[ranks[route.from]] = Math.max(gapHeights[ranks[route.from]], y + route.height + 28);
  }
  // Center the packed label rows, leaving a clear arrival strip above the next rank.
  for (const [rank, placed] of labelsByRank.entries()) {
    const usedHeight = Math.max(0, ...placed.map((route) => route.gapY + route.height - 16));
    const offset = Math.max(0, (gapHeights[rank] - usedHeight) / 2 - 16);
    for (const route of placed) route.gapY += offset;
  }
  const rankY: number[] = [];
  let nextY = PADDING + (leftRoutes.length ? 16 : 0);
  for (let rank = 0; rank < layers.length; rank++) {
    rankY.push(nextY);
    nextY += GRAPH_NODE_HEIGHT + gapHeights[rank];
  }
  const ids = new Set(keys);
  const nodes = layers.flatMap((layer, rank) =>
    layer.flatMap((key) =>
      groups[key].centers.map((center, index) => {
        const instance = repeatedKeys.has(key) ? index + 1 : null;
        let id = key;
        if (instance !== null) {
          id = `${key}::illustration:${instance}`;
          while (ids.has(id)) id += ":";
          ids.add(id);
        }
        return { key, id, instance, x: center - GRAPH_NODE_WIDTH / 2, y: rankY[rank] };
      }),
    ),
  );
  const ellipses = keys
    .filter((key) => repeatedKeys.has(key))
    .map((key) => ({
      key,
      x: groups[key].x + GRAPH_NODE_WIDTH * 2 + COLUMN_GAP + ELLIPSIS_GAP / 2,
      y: rankY[ranks[key]] + GRAPH_NODE_HEIGHT / 2,
    }));
  const edges = routes.map((route) => {
    const from = groups[route.from].centers;
    const to = groups[route.to].centers;
    const startY = rankY[ranks[route.from]] + GRAPH_NODE_HEIGHT;
    const endY = rankY[ranks[route.to]];
    const labelY = startY + route.gapY;
    const middleY = labelY + route.height / 2;
    const labelCenter = route.labelX + route.width / 2;
    const paths: string[] = [];
    // When both ends repeat, pair illustrative instances rather than claiming an all-to-all join.
    for (let index = 0; index < Math.max(from.length, to.length); index++) {
      const startX = from[index % from.length];
      const endX = to[index % to.length];
      if (route.side) {
        const arrivalY = endY - 12;
        paths.push(`M ${startX} ${startY} L ${startX} ${middleY} L ${route.track} ${middleY} L ${route.track} ${arrivalY} L ${endX} ${arrivalY} L ${endX} ${endY}`);
      } else {
        paths.push(`M ${startX} ${startY} C ${startX} ${middleY}, ${labelCenter} ${middleY}, ${labelCenter} ${middleY} C ${endX} ${middleY}, ${endX} ${middleY}, ${endX} ${endY}`);
      }
    }
    return {
      from: route.from,
      to: route.to,
      paths,
      feedback: route.feedback,
      label: route.label,
      labelX: route.labelX,
      labelY,
      labelWidth: route.width,
      labelHeight: route.height,
    };
  });
  const lastRank = layers.length - 1;
  const bottomRoutes = lastRank < 0 ? [] : routes.filter((route) => ranks[route.from] === lastRank);
  const bottomSpace = Math.max(0, ...bottomRoutes.map((route) => route.gapY + route.height + 12));
  return {
    nodes,
    edges,
    ellipses,
    width: PADDING * 2 + leftGutter + contentWidth + rightGutter,
    height: (lastRank < 0 ? PADDING + GRAPH_NODE_HEIGHT : rankY[lastRank] + GRAPH_NODE_HEIGHT + bottomSpace) + PADDING,
  };
}
