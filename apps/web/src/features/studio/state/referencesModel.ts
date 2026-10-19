import type {
  ReferenceEdge,
  ReferenceEdgeStatus,
  ReferenceNode,
  StudioReferences,
} from "../../../api/types";
import type { StudioSearch } from "../location";

const HOP_LABELS = ["Embedded in a Task", "One hop further"];

/** The map's columns, left to right: the Tasks, each inlined level, and the level left as text. */
export function referenceColumnLabels(depth: number): string[] {
  const inlined = Array.from(
    { length: depth },
    (_, index) => HOP_LABELS[index] ?? `${index} hops further`,
  );
  return ["Tasks", ...inlined, "Too deep"];
}

/** Where the map puts each node: a column, the band of files no Task reaches, or the list below. */
export type ReferenceMapView = {
  columns: ReferenceNode[][];
  band: ReferenceNode[];
  /** Reached only past the drawn columns: listed, not drawn. */
  deeper: ReferenceNode[];
};

/** The hop a node is met at: in the filtered agent's runs, or from the nearest Task. */
export function nodeHop(node: ReferenceNode, agentId?: string): number | null {
  return agentId ? (node.hops[agentId] ?? null) : node.depth;
}

const byLabel = (left: ReferenceNode, right: ReferenceNode) =>
  left.label.localeCompare(right.label);

/**
 * The nodes the map shows. With an agent, only what its run meets, and its own notes in the band
 * when its run does not meet them.
 */
export function referenceMapView(data: StudioReferences, agentId?: string): ReferenceMapView {
  const view: ReferenceMapView = {
    columns: referenceColumnLabels(data.depth).map(() => []),
    band: [],
    deeper: [],
  };
  for (const node of [...data.nodes].sort(byLabel)) placeNode(view, node, agentId);
  return view;
}

function placeNode(view: ReferenceMapView, node: ReferenceNode, agentId?: string): void {
  const hop = nodeHop(node, agentId);
  if (hop === null) {
    if (!agentId || node.agent_id === agentId) view.band.push(node);
    return;
  }
  const column = view.columns[hop];
  if (column) column.push(node);
  else view.deeper.push(node);
}

/** The ids the map shows, in any place. */
export function shownIds(view: ReferenceMapView): Set<string> {
  return new Set([...view.columns.flat(), ...view.band, ...view.deeper].map((node) => node.id));
}

/** The agents whose runs inline a file into their prompt. */
export function reachedAgents(node: ReferenceNode, depth: number): string[] {
  return Object.entries(node.hops)
    .filter(([, hop]) => hop >= 1 && hop <= depth)
    .map(([agentId]) => agentId);
}

/** Whether a Task inlines more note text than one run may hold. */
export function isOverBudget(node: ReferenceNode, budget: number): boolean {
  return (node.inlined_bytes ?? 0) > budget;
}

export type ReferenceStandouts = {
  /** Links that do not resolve. */
  broken: ReferenceNode[];
  /** Tasks that inline more note text than one run may hold. */
  overBudget: ReferenceNode[];
  /** Notes inlined into more than one agent's prompt. */
  shared: ReferenceNode[];
  /** Notes reached only past the inlined levels, so no run gets their text. */
  tooDeep: ReferenceNode[];
  /** Files in the guild's state that nothing embeds or names. */
  unpointed: ReferenceNode[];
};

/** What deserves a look among the nodes the map shows. */
export function referenceStandouts(
  data: StudioReferences,
  shown: ReadonlySet<string>,
): ReferenceStandouts {
  const nodes = data.nodes.filter((node) => shown.has(node.id));
  const pointed = new Set(data.edges.map((edge) => edge.to));
  const isFile = (node: ReferenceNode) => node.kind === "note" || node.kind === "table";
  return {
    broken: nodes.filter((node) => node.kind === "unresolved"),
    overBudget: nodes.filter((node) => node.kind === "task" && isOverBudget(node, data.budget)),
    shared: nodes.filter(
      (node) => node.kind === "note" && reachedAgents(node, data.depth).length > 1,
    ),
    tooDeep: nodes.filter((node) => node.kind === "note" && (node.depth ?? -1) > data.depth),
    unpointed: nodes.filter((node) => isFile(node) && node.in_state && !pointed.has(node.id)),
  };
}

export type StandoutGroup = { title: string; rows: Array<{ node: ReferenceNode; meta: string }> };

/** What stands out, as titled groups of rows, leaving out the empty ones. */
export function standoutGroups(
  data: StudioReferences,
  shown: ReadonlySet<string>,
): StandoutGroup[] {
  const standouts = referenceStandouts(data, shown);
  const holders = (node: ReferenceNode) =>
    referenceLinks(data, node.id)
      .in.map((link) => link.node?.label ?? link.id)
      .join(", ");
  const groups: StandoutGroup[] = [
    {
      title: "Broken embeds",
      rows: [
        ...standouts.broken.map((node) => ({
          node,
          meta: `${node.reason ?? "does not resolve"} · in ${holders(node)}`,
        })),
        ...standouts.overBudget.map((node) => ({
          node,
          meta: `inlines ${formatSize(node.inlined_bytes ?? 0)}, over the ${formatSize(data.budget)} budget`,
        })),
      ],
    },
    {
      title: "Shared by several prompts",
      rows: standouts.shared.map((node) => ({
        node,
        meta: `inlined for ${reachedAgents(node, data.depth).length} agents`,
      })),
    },
    {
      title: "Too deep to be inlined",
      rows: standouts.tooDeep.map((node) => ({ node, meta: `${node.depth} hops from a Task` })),
    },
    {
      title: "Nothing points here",
      rows: standouts.unpointed.map((node) => ({ node, meta: node.level ?? "" })),
    },
  ];
  return groups.filter((group) => group.rows.length);
}

const linkLabels: Record<ReferenceEdgeStatus, string> = {
  inlined: "embed",
  too_deep: "embed · stays text",
  unreached: "embed · no Task reaches it",
  broken: "embed · does not resolve",
  named: "named, not embedded",
};

/** How a link reads in a list: an embed and what becomes of it, or a name. */
export function linkLabel(edge: ReferenceEdge): string {
  return linkLabels[edge.status];
}

export type ReferenceLink = { edge: ReferenceEdge; node: ReferenceNode | undefined; id: string };

/** What a node embeds or names, and what embeds or names it. */
export function referenceLinks(
  data: StudioReferences,
  id: string,
): { out: ReferenceLink[]; in: ReferenceLink[] } {
  const byId = new Map(data.nodes.map((node) => [node.id, node]));
  return {
    out: data.edges
      .filter((edge) => edge.from === id)
      .map((edge) => ({ edge, id: edge.to, node: byId.get(edge.to) })),
    in: data.edges
      .filter((edge) => edge.to === id)
      .map((edge) => ({ edge, id: edge.from, node: byId.get(edge.from) })),
  };
}

export type TaskPull = { node: ReferenceNode; hop: number; inlined: boolean };

/** Everything a Task's runs meet through its embeds, nearest first: inlined, then left as text. */
export function taskPulls(data: StudioReferences, task: ReferenceNode): TaskPull[] {
  const agentId = task.agent_id ?? "";
  return data.nodes
    .flatMap((node) => {
      const hop = node.hops[agentId];
      return hop !== undefined && hop > 0 ? [{ node, hop, inlined: hop <= data.depth }] : [];
    })
    .sort((left, right) => left.hop - right.hop || byLabel(left.node, right.node));
}

/** The node, what it pulls in through embeds, what pulls it in, and what it names or is named by. */
export function litIds(data: StudioReferences, id: string): Set<string> {
  const embeds = data.edges.filter((edge) => edge.kind === "embed");
  const lit = new Set([id, ...followEmbeds(embeds, id, "from"), ...followEmbeds(embeds, id, "to")]);
  for (const edge of data.edges) {
    if (edge.kind === "name" && (edge.from === id || edge.to === id))
      [edge.from, edge.to].forEach((end) => lit.add(end));
  }
  return lit;
}

function followEmbeds(embeds: ReferenceEdge[], start: string, side: "from" | "to"): string[] {
  const other = side === "from" ? "to" : "from";
  const seen = new Set<string>();
  let frontier = [start];
  while (frontier.length) {
    frontier = embeds
      .filter(
        (edge) => frontier.includes(edge[side]) && !seen.has(edge[other]) && edge[other] !== start,
      )
      .map((edge) => edge[other]);
    frontier.forEach((id) => seen.add(id));
  }
  return [...seen];
}

/** What a box says under its name: a Task's budget, a file's level and size, or why a link fails. */
export function referenceMeta(node: ReferenceNode, data: StudioReferences): string {
  if (node.kind === "task")
    return `${formatSize(node.inlined_bytes ?? 0)} of ${formatSize(data.budget)} inlined`;
  if (node.kind === "unresolved") return node.reason ?? "does not resolve";
  return [node.level, node.kind === "note" ? formatSize(node.bytes) : "table"]
    .filter(Boolean)
    .join(" · ");
}

/** Where State's list opens a file: a note by its path, under its agent when it has one; a table by its id. */
export function stateListLocation(node: ReferenceNode): StudioSearch | null {
  if (node.kind === "table" && node.collection_id) {
    return { section: "state", tab: "list", kind: "tables", item: node.collection_id };
  }
  if (node.kind !== "note") return null;
  return {
    section: "state",
    ...(node.agent_id ? { agent: node.agent_id } : {}),
    tab: "list",
    kind: "notes",
    item: node.id,
  };
}

/** A size in bytes as people read it. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

// ---------------------------------------------------------------------------
// Layout.

export type PlacedReference = { node: ReferenceNode; x: number; y: number; w: number; h: number };

export type PlacedReferenceLink = { edge: ReferenceEdge; path: string };

export type ReferenceLayout = {
  width: number;
  height: number;
  columnX: number[];
  /** Where the band's label sits; null when the band is empty. */
  bandY: number | null;
  nodes: PlacedReference[];
  links: PlacedReferenceLink[];
};

const BOX_W = 184;
const BOX_H = 40;
const ROW = 52;
const LABEL = 28;
const BAND_GAP = 28;
const BAND_SPACING = 16;
const MIN_GAP = 48;

/**
 * The columns side by side across `width` (at least wide enough for every box), each headed by its
 * label, then the band of unreached files in rows below. A link runs from the right side of its
 * holder to the left side of a box further right, and otherwise from top or bottom.
 */
export function layoutReferences(
  view: ReferenceMapView,
  data: StudioReferences,
  width: number,
): ReferenceLayout {
  const count = view.columns.length;
  const gap = Math.max(MIN_GAP, Math.floor((width - count * BOX_W) / Math.max(1, count - 1)));
  const columnX = view.columns.map((_, index) => index * (BOX_W + gap));
  const totalWidth = (columnX[count - 1] ?? 0) + BOX_W;
  const placed = view.columns.flatMap((column, index) =>
    column.map((node, row) => box(node, columnX[index] ?? 0, LABEL + row * ROW)),
  );
  const tallest = Math.max(1, ...view.columns.map((column) => column.length));
  const bandY = view.band.length ? LABEL + tallest * ROW + BAND_GAP : null;
  const band = bandY === null ? [] : placeBand(view.band, totalWidth, bandY + LABEL);
  const nodes = [...placed, ...band];
  const bottom = Math.max(...nodes.map((node) => node.y + node.h), LABEL + BOX_H);
  return {
    width: totalWidth,
    height: bottom + 4,
    columnX,
    bandY,
    nodes,
    links: placeLinks(data.edges, nodes),
  };
}

function box(node: ReferenceNode, x: number, y: number): PlacedReference {
  return { node, x, y, w: BOX_W, h: BOX_H };
}

function placeBand(nodes: ReferenceNode[], width: number, top: number): PlacedReference[] {
  const perRow = Math.max(1, Math.floor((width + BAND_SPACING) / (BOX_W + BAND_SPACING)));
  return nodes.map((node, index) =>
    box(node, (index % perRow) * (BOX_W + BAND_SPACING), top + Math.floor(index / perRow) * ROW),
  );
}

function placeLinks(edges: ReferenceEdge[], nodes: PlacedReference[]): PlacedReferenceLink[] {
  const byId = new Map(nodes.map((node) => [node.node.id, node]));
  return edges.flatMap((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    return from && to ? [{ edge, path: linkPath(from, to) }] : [];
  });
}

/** A curve between two boxes: side to side when the target is further right, else top to bottom. */
export function linkPath(from: PlacedReference, to: PlacedReference): string {
  if (to.x > from.x + from.w / 2) {
    const [x1, y1, x2, y2] = [from.x + from.w, from.y + from.h / 2, to.x, to.y + to.h / 2];
    const middle = (x1 + x2) / 2;
    return `M${x1},${y1} C${middle},${y1} ${middle},${y2} ${x2},${y2}`;
  }
  const down = to.y >= from.y;
  const [x1, y1] = [from.x + from.w / 2, down ? from.y + from.h : from.y];
  const [x2, y2] = [to.x + to.w / 2, down ? to.y : to.y + to.h];
  const bend = (y2 - y1) / 2;
  return `M${x1},${y1} C${x1},${y1 + bend} ${x2},${y2 - bend} ${x2},${y2}`;
}
