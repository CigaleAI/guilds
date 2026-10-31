import type { ActivityMap, MapLink, MapNode } from "./activityModel";

/** Where the activity map draws its boxes and links. Pure: no DOM. */

/**
 * Each agent's column: an agent mostly woken by routines or the operator sits in the first; one
 * mostly woken by other agents sits one column past the agent that wakes it most.
 */
export function agentColumns(map: ActivityMap): Map<string, number> {
  const agentIds = new Set(map.agents.map((agent) => agent.id));
  const inbound = (id: string) => map.links.filter((link) => link.to === id && link.from !== id);
  const column = new Map<string, number>();
  for (const agent of map.agents) {
    const links = inbound(agent.id);
    const fromAgents = links
      .filter((link) => agentIds.has(link.from))
      .reduce((sum, link) => sum + link.count, 0);
    const fromSources = links
      .filter((link) => !agentIds.has(link.from))
      .reduce((sum, link) => sum + link.count, 0);
    if (fromSources >= fromAgents) column.set(agent.id, 1);
  }
  for (let pass = 0; pass < map.agents.length; pass += 1) {
    for (const agent of map.agents) {
      if (column.has(agent.id)) continue;
      const main = inbound(agent.id)
        .filter((link) => agentIds.has(link.from) && column.has(link.from))
        .sort((left, right) => right.count - left.count)[0];
      if (main) column.set(agent.id, (column.get(main.from) ?? 0) + 1);
    }
  }
  for (const agent of map.agents) if (!column.has(agent.id)) column.set(agent.id, 1);
  return column;
}

/** The map's box sizes, the rows the boxes sit in, and the narrowest gap between columns. */
const MAP_BOXES = {
  sourceWidth: 208,
  sourceHeight: 44,
  agentWidth: 168,
  agentHeight: 50,
  sourceRow: 54,
  agentRow: 86,
  minGap: 72,
} as const;

/** A box with its top-left corner and size. */
export type PlacedMapNode = MapNode & { x: number; y: number; w: number; h: number };

/**
 * A link as an SVG path with its stroke width and the anchor of its count. A `loop` runs back to an
 * earlier or the same column, under the boxes.
 */
export type PlacedMapLink = MapLink & {
  path: string;
  width: number;
  label: { x: number; y: number };
  loop: boolean;
  fromAgent: boolean;
};

export type MapLayout = {
  width: number;
  height: number;
  nodes: PlacedMapNode[];
  links: PlacedMapLink[];
};

/** A link the layout draws, with the two boxes it runs between. */
type DrawnLink = { link: MapLink; from: PlacedMapNode; to: PlacedMapNode };

type Point = { x: number; y: number };

/** A cubic Bézier curve: where it starts and ends, and the two control points it bends toward. */
type CubicCurve = { start: Point; startControl: Point; endControl: Point; end: Point };

/** The point a fraction `t` of the way along a curve. */
function cubicAt(curve: CubicCurve, t: number): Point {
  const { start, startControl, endControl, end } = curve;
  const u = 1 - t;
  return {
    x:
      u * u * u * start.x +
      3 * u * u * t * startControl.x +
      3 * u * t * t * endControl.x +
      t * t * t * end.x,
    y:
      u * u * u * start.y +
      3 * u * u * t * startControl.y +
      3 * u * t * t * endControl.y +
      t * t * t * end.y,
  };
}

const round = (value: number) => Math.round(value * 10) / 10;

/** A curve as an SVG path, to a tenth of a pixel. */
function curvePath({ start, startControl, endControl, end }: CubicCurve): string {
  return `M${round(start.x)},${round(start.y)} C${round(startControl.x)},${round(startControl.y)} ${round(endControl.x)},${round(endControl.y)} ${round(end.x)},${round(end.y)}`;
}

/**
 * Sources in a column on the left, each beside the agent it wakes most; agents in columns to the
 * right, filling `width` and growing past it only to keep the narrowest gap. Links run left to
 * right between the side ports of their boxes, spread along each side; links back to an earlier or
 * the same column loop under the boxes, the shortest innermost. A link is 1.5 to 9 px wide by how
 * often it happened.
 */
export function layoutActivityMap(map: ActivityMap, width: number): MapLayout {
  const { sourceWidth, sourceHeight, agentWidth, agentHeight, sourceRow, agentRow, minGap } =
    MAP_BOXES;
  const column = agentColumns(map);
  const columns = Math.max(1, ...column.values());
  const gap = Math.max(
    minGap,
    Math.floor((width - sourceWidth - columns * agentWidth - 8) / columns),
  );
  const columnX = (index: number) => sourceWidth + gap + (index - 1) * (agentWidth + gap);
  const totalWidth = columnX(columns) + agentWidth + 8;

  const byColumn = new Map<number, MapNode[]>();
  for (const agent of map.agents) {
    const index = column.get(agent.id) ?? 1;
    byColumn.set(index, [...(byColumn.get(index) ?? []), agent]);
  }
  const tallest = Math.max(1, ...[...byColumn.values()].map((list) => list.length));
  const body = Math.max(map.sources.length * sourceRow, tallest * agentRow);
  const top = 6;
  const placed = new Map<string, PlacedMapNode>();
  for (const [index, list] of byColumn) {
    const offset = top + (body - list.length * agentRow) / 2 + (agentRow - agentHeight) / 2;
    list.forEach((agent, position) =>
      placed.set(agent.id, {
        ...agent,
        x: columnX(index),
        y: offset + position * agentRow,
        w: agentWidth,
        h: agentHeight,
      }),
    );
  }
  const targetY = (source: MapNode) => {
    const main = map.links
      .filter((link) => link.from === source.id)
      .sort((left, right) => right.count - left.count)[0];
    return placed.get(main?.to ?? source.agentId ?? "")?.y ?? 0;
  };
  const sources = [...map.sources].sort(
    (left, right) => targetY(left) - targetY(right) || right.count - left.count,
  );
  const sourceOffset =
    top + (body - sources.length * sourceRow) / 2 + (sourceRow - sourceHeight) / 2;
  sources.forEach((source, position) =>
    placed.set(source.id, {
      ...source,
      x: 0,
      y: sourceOffset + position * sourceRow,
      w: sourceWidth,
      h: sourceHeight,
    }),
  );

  const drawn = map.links.flatMap((link): DrawnLink[] => {
    const from = placed.get(link.from);
    const to = placed.get(link.to);
    return from && to ? [{ link, from, to }] : [];
  });
  const isForward = ({ from, to }: DrawnLink) => from.kind !== "agent" || from.x < to.x;
  const forward = drawn.filter(isForward);
  const loops = drawn
    .filter((item) => !isForward(item))
    .sort((left, right) => Math.abs(left.from.x - left.to.x) - Math.abs(right.from.x - right.to.x));
  const ports = (side: "in" | "out") => {
    const bySide = new Map<PlacedMapNode, DrawnLink[]>();
    for (const item of forward) {
      const box = side === "in" ? item.to : item.from;
      bySide.set(box, [...(bySide.get(box) ?? []), item]);
    }
    const at = new Map<string, number>();
    for (const [box, links] of bySide) {
      const other = (item: DrawnLink) => (side === "in" ? item.from : item.to).y;
      links.sort((left, right) => other(left) - other(right));
      const room = box.h - 14;
      links.forEach(({ link }, position) =>
        at.set(
          link.id,
          box.y + 7 + (links.length === 1 ? room / 2 : (room * position) / (links.length - 1)),
        ),
      );
    }
    return at;
  };
  const inPort = ports("in");
  const outPort = ports("out");
  const maxCount = Math.max(1, ...drawn.map(({ link }) => link.count));
  const strokeOf = (count: number) => round(1.5 + 7.5 * (count / maxCount));
  const loopBase = top + body + 8;

  const links: PlacedMapLink[] = [];
  for (const { link, from, to } of forward) {
    const start = { x: from.x + from.w, y: outPort.get(link.id) ?? from.y + from.h / 2 };
    const end = { x: to.x - 2, y: inPort.get(link.id) ?? to.y + to.h / 2 };
    const bend = (end.x - start.x) / 2;
    const curve = {
      start,
      startControl: { x: start.x + bend, y: start.y },
      endControl: { x: end.x - bend, y: end.y },
      end,
    };
    const label = cubicAt(curve, 0.5);
    links.push({
      ...link,
      path: curvePath(curve),
      width: strokeOf(link.count),
      label: { x: round(label.x), y: round(label.y) },
      loop: false,
      fromAgent: from.kind === "agent",
    });
  }
  loops.forEach(({ link, from, to }, position) => {
    const depth = loopBase + 18 + position * 20;
    const start = { x: from.x + from.w * 0.62, y: from.y + from.h };
    const end = { x: to.x + to.w * 0.38, y: to.y + to.h + 2 };
    const curve = {
      start,
      startControl: { x: start.x, y: depth },
      endControl: { x: end.x, y: depth },
      end,
    };
    const label = cubicAt(curve, 0.5);
    links.push({
      ...link,
      path: curvePath(curve),
      width: strokeOf(link.count),
      label: { x: round(label.x), y: round(label.y) },
      loop: true,
      fromAgent: true,
    });
  });
  const height = loops.length ? loopBase + 18 + (loops.length - 1) * 20 + 22 : top + body + 6;
  return { width: totalWidth, height, nodes: [...placed.values()], links };
}
