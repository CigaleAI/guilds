import type { WakeOutcome } from "@guildsrun/ui";
import type {
  ActivityAgent,
  ActivityMessage,
  ActivityPost,
  ActivityRoutine,
  ActivityToolCall,
  ActivityTrigger,
  ActivityTriggerReason,
  ActivityView,
  ActivityWake,
  ActivityWrite,
  ActivityWriteKind,
} from "../../../api/types/studio";

/**
 * Studio's activity views: the chains of wakes that woke one another, the map of who woke whom, and
 * what each agent took in and put out. Pure: no DOM, no fetch, no clock.
 */

/** Why a message reached the agent it woke, in a word. */
export const reasonLabel: Record<ActivityTriggerReason, string> = {
  tag: "tagged",
  jev: "routed",
  rules: "rules",
  fallback: "fallback",
};

/**
 * Why a message woke an agent, in a word, or null for a wake no message started. A run stores
 * the row that woke it; for an older run the row is found from tags, and the label says so.
 */
export function triggerReasonLabel(trigger: ActivityTrigger): string | null {
  if (trigger.type !== "message") return null;
  const label = reasonLabel[trigger.reason];
  return trigger.inferred ? `${label}, inferred` : label;
}

/** Whose message an operator row is: the viewer's own, or the named person's who posted it. */
export function operatorAuthor(message: ActivityMessage, viewerId: string): string {
  return message.author_user_id && message.author_user_id !== viewerId
    ? `${message.author_name}'s`
    : "your";
}

/** The windows the activity views offer, in hours. */
export const ACTIVITY_WINDOW_HOURS: readonly number[] = [1, 6, 24, 72, 168];
export const ACTIVITY_DEFAULT_HOURS = 24;
/** Wake outcomes in ledger order. */
export const WAKE_BUCKETS: readonly WakeOutcome[] = [
  "posted",
  "wrote",
  "silent",
  "failed",
  "running",
];

/** Map node of the operator's messages in the group chat. */
export const OPERATOR_NODE = "operator";
/** Map node of the operator's direct chats. */
export const DIRECT_NODE = "direct";
/** Map node of a message the ledger does not include. */
export const MESSAGE_NODE = "message";
/** Map node of one routine; a routine the ledger no longer lists is `routine:?`. */
export function routineNode(scheduleId: string | null): string {
  return `routine:${scheduleId ?? "?"}`;
}

/** Tools whose calls a step shows as side effects rather than as plain tool calls. */
const EFFECT_TOOLS = new Set([
  "group_post",
  "memory_write",
  "record_add",
  "record_update",
  "note_write",
  "script_create",
  "script_run",
  "report_issue",
]);

/** A time value the model reads: epoch milliseconds or an ISO string. */
export type TimeValue = number | string | null | undefined;

/** Epoch milliseconds for a number or date string; null when empty or unreadable. */
export function toMs(value: TimeValue): number | null {
  if (value === null || value === undefined || value === "") return null;
  const time = typeof value === "number" ? value : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

/** Lookups the views share. */
export type ActivityIndex = {
  /** Public rows by sequence. */
  messages: ReadonlyMap<number, ActivityMessage>;
  /** Wakes by run id. */
  wakes: ReadonlyMap<string, ActivityWake>;
  /** The run ids each public row started, by the row's sequence. */
  wokenBy: ReadonlyMap<number, readonly string[]>;
  agents: ReadonlyMap<string, ActivityAgent>;
  routines: ReadonlyMap<string, ActivityRoutine>;
};

function triggerSeq(wake: ActivityWake): number | null {
  return wake.trigger.type === "message" ? wake.trigger.seq : null;
}

export function indexActivity(view: ActivityView): ActivityIndex {
  const messages = new Map(view.messages.map((message) => [message.seq, message]));
  const wakes = new Map<string, ActivityWake>();
  const wokenBy = new Map<number, string[]>();
  for (const wake of view.wakes) {
    wakes.set(wake.run_id, wake);
    const seq = triggerSeq(wake);
    if (seq === null) continue;
    const list = wokenBy.get(seq) ?? [];
    list.push(wake.run_id);
    wokenBy.set(seq, list);
  }
  const agents = new Map(view.agents.map((agent) => [agent.id, agent]));
  const routines = new Map(view.routines.map((routine) => [routine.id, routine]));
  return { messages, wakes, wokenBy, agents, routines };
}

/** One outcome per wake for counting: running first, then a post, then a failure, then writes. */
export function wakeBucket(
  wake: Pick<ActivityWake, "running" | "outcome" | "failed">,
): WakeOutcome {
  if (wake.running) return "running";
  if (wake.outcome === "posted") return "posted";
  if (wake.failed) return "failed";
  return wake.outcome === "wrote" ? "wrote" : "silent";
}

export type OutcomeCounts = Record<WakeOutcome, number>;

export function emptyCounts(): OutcomeCounts {
  return { posted: 0, wrote: 0, silent: 0, failed: 0, running: 0 };
}

export function countTotal(counts: Partial<OutcomeCounts>): number {
  return WAKE_BUCKETS.reduce((sum, outcome) => sum + (counts[outcome] ?? 0), 0);
}

/* ---------- Chains ---------- */

/**
 * What started a chain: a routine firing, the operator's message, a direct chat, an agent's post
 * from before the window, or a message the ledger does not include.
 */
export type ChainStart =
  | { kind: "routine"; scheduleId: string | null; at: number }
  | { kind: "operator"; message: ActivityMessage; at: number }
  | { kind: "direct"; at: number }
  | { kind: "earlier"; message: ActivityMessage; at: number }
  | { kind: "unknown"; seq: number | null; at: number };

/** A wake in a chain: the map node that woke it, the post that did, and the wakes its posts woke. */
export type ChainStep = {
  wake: ActivityWake;
  from: string;
  /** The post that woke it; null for the wakes that start the chain. */
  post: ActivityPost | null;
  next: ChainStep[];
};

export type Chain = {
  /** The run id of its first wake. */
  id: string;
  start: ChainStart;
  /** The map node that started it. */
  source: string;
  steps: ChainStep[];
  wakes: number;
  cost: number;
  /** When its last wake ended. */
  end: number;
  /** Every wake in it produced nothing. */
  quiet: boolean;
};

/**
 * Every chain in the window, newest first. A chain starts at a wake no other wake in the window
 * started, and follows each post to the wakes it woke until none are left. A message that woke
 * several agents starts one chain.
 */
export function buildChains(
  view: ActivityView,
  index: ActivityIndex = indexActivity(view),
): Chain[] {
  const seen = new Set<string>();
  const step = (wake: ActivityWake, from: string, post: ActivityPost | null): ChainStep => {
    seen.add(wake.run_id);
    const next: ChainStep[] = [];
    for (const posted of wake.posts) {
      for (const run of index.wokenBy.get(posted.seq) ?? []) {
        const woken = index.wakes.get(run);
        if (woken && !seen.has(run)) next.push(step(woken, wake.agent_id, posted));
      }
    }
    return { wake, from, post, next };
  };
  const parentOf = (wake: ActivityWake): string | null => {
    const seq = triggerSeq(wake);
    const source = seq === null ? null : index.messages.get(seq)?.source_run_id;
    return source && index.wakes.has(source) ? source : null;
  };

  const chains: Chain[] = [];
  const byMessage = new Map<number, Chain>();
  for (const wake of view.wakes) {
    if (parentOf(wake) !== null || seen.has(wake.run_id)) continue;
    const startedAt = toMs(wake.started_at) ?? 0;
    const { trigger } = wake;
    if (trigger.type === "message" && trigger.seq !== null) {
      const existing = byMessage.get(trigger.seq);
      if (existing) {
        existing.steps.push(step(wake, existing.source, null));
        continue;
      }
    }
    let start: ChainStart;
    let source: string;
    if (trigger.type === "routine") {
      start = { kind: "routine", scheduleId: trigger.schedule_id, at: startedAt };
      source = routineNode(trigger.schedule_id);
    } else if (trigger.type === "direct") {
      start = { kind: "direct", at: startedAt };
      source = DIRECT_NODE;
    } else {
      const message = trigger.seq === null ? undefined : index.messages.get(trigger.seq);
      const author = message?.author_agent_id;
      if (message?.author_type === "user") {
        start = { kind: "operator", message, at: toMs(message.created_at) ?? startedAt };
        source = OPERATOR_NODE;
      } else if (message && author && index.agents.has(author)) {
        start = { kind: "earlier", message, at: toMs(message.created_at) ?? startedAt };
        source = author;
      } else {
        start = { kind: "unknown", seq: trigger.seq, at: startedAt };
        source = MESSAGE_NODE;
      }
    }
    const chain: Chain = {
      id: wake.run_id,
      start,
      source,
      steps: [step(wake, source, null)],
      wakes: 0,
      cost: 0,
      end: start.at,
      quiet: true,
    };
    chains.push(chain);
    if (trigger.type === "message" && trigger.seq !== null) byMessage.set(trigger.seq, chain);
  }
  for (const chain of chains) {
    for (const item of chainSteps(chain)) {
      chain.wakes += 1;
      chain.cost += item.wake.cost_usd || 0;
      chain.end = Math.max(chain.end, toMs(item.wake.ended_at) ?? chain.end);
      if (wakeBucket(item.wake) !== "silent") chain.quiet = false;
    }
  }
  return chains.sort((left, right) => right.start.at - left.start.at);
}

/** Every step of a chain, depth first. */
export function chainSteps(chain: Pick<Chain, "steps">): ChainStep[] {
  const out: ChainStep[] = [];
  const walk = (steps: readonly ChainStep[]) => {
    for (const item of steps) {
      out.push(item);
      walk(item.next);
    }
  };
  walk(chain.steps);
  return out;
}

/**
 * A chain as rows: the first follows each wake's first woken wake; every other woken wake starts a
 * branch row. `from` is the step whose post a branch leaves from; a message that woke several
 * agents starts `sibling` rows.
 */
export type ChainLine = {
  lead: "start" | "sibling" | "branch";
  from: ChainStep | null;
  steps: ChainStep[];
};

export function chainLines(chain: Pick<Chain, "steps">): ChainLine[] {
  const lines: ChainLine[] = [];
  const queue: ChainLine[] = chain.steps.map((first, position) => ({
    lead: position === 0 ? "start" : "sibling",
    from: null,
    steps: [first],
  }));
  while (queue.length) {
    const line = queue.shift() as ChainLine;
    lines.push(line);
    let current = line.steps[0];
    while (current?.next.length) {
      const [head, ...rest] = current.next;
      for (const other of rest) queue.push({ lead: "branch", from: current, steps: [other] });
      if (!head) break;
      line.steps.push(head);
      current = head;
    }
  }
  return lines;
}

/* ---------- Map selection ---------- */

/** What the map has selected: one link (`from` woke `to`), or one node. */
export type MapSelection =
  { kind: "link"; from: string; to: string } | { kind: "node"; id: string };

/** Whether a step is one the selection names: that link, or a wake of or from that node. */
export function stepMatches(
  selection: MapSelection,
  item: Pick<ChainStep, "from" | "wake">,
): boolean {
  if (selection.kind === "link")
    return item.from === selection.from && item.wake.agent_id === selection.to;
  return item.wake.agent_id === selection.id || item.from === selection.id;
}

export function chainMatches(chain: Chain, selection: MapSelection | null): boolean {
  if (!selection) return true;
  return chainSteps(chain).some((item) => stepMatches(selection, item));
}

/** The selection a Studio URL carries in `item`: `link:<from>><to>` or `node:<id>`. */
export function selectionFromItem(item: string | undefined): MapSelection | null {
  if (item?.startsWith("link:")) {
    const [from, to] = item.slice(5).split(">");
    return from && to ? { kind: "link", from, to } : null;
  }
  if (item?.startsWith("node:") && item.length > 5) return { kind: "node", id: item.slice(5) };
  return null;
}

export function selectionItem(selection: MapSelection): string {
  return selection.kind === "link"
    ? `link:${selection.from}>${selection.to}`
    : `node:${selection.id}`;
}

export function sameSelection(left: MapSelection | null, right: MapSelection | null): boolean {
  return Boolean(left && right && selectionItem(left) === selectionItem(right));
}

/** Whether a selection still names a link or node of the loaded map. */
export function selectionExists(map: ActivityMap, selection: MapSelection): boolean {
  if (selection.kind === "link") {
    return map.links.some((link) => link.from === selection.from && link.to === selection.to);
  }
  return [...map.sources, ...map.agents].some((node) => node.id === selection.id);
}

/* ---------- Map ---------- */

export type MapNodeKind = "routine" | "operator" | "direct" | "message" | "agent";

/**
 * A box on the map. A source counts the chains it started; an agent counts its wakes by outcome. A
 * routine names the agent it belongs to.
 */
export type MapNode = {
  id: string;
  kind: MapNodeKind;
  count: number;
  counts: OutcomeCounts;
  agentId: string | null;
};

/** "`from` woke `to`" `count` times, by the outcome of the wakes it started. */
export type MapLink = {
  id: string;
  from: string;
  to: string;
  count: number;
  counts: OutcomeCounts;
  cost: number;
};

export type ActivityMap = { sources: MapNode[]; agents: MapNode[]; links: MapLink[] };

function nodeKind(id: string): MapNodeKind {
  if (id.startsWith("routine:")) return "routine";
  if (id === OPERATOR_NODE) return "operator";
  if (id === DIRECT_NODE) return "direct";
  if (id === MESSAGE_NODE) return "message";
  return "agent";
}

/**
 * Who woke whom: every routine of the agents on the map (fired or not), the operator's messages
 * and direct chats when they started a chain, and every agent.
 */
export function buildActivityMap(view: ActivityView, chains: readonly Chain[]): ActivityMap {
  const links = new Map<string, MapLink>();
  const wakes = new Map<string, OutcomeCounts>();
  const started = new Map<string, number>();
  for (const chain of chains) {
    started.set(chain.source, (started.get(chain.source) ?? 0) + 1);
    for (const item of chainSteps(chain)) {
      const id = `${item.from}>${item.wake.agent_id}`;
      let link = links.get(id);
      if (!link) {
        link = {
          id,
          from: item.from,
          to: item.wake.agent_id,
          count: 0,
          counts: emptyCounts(),
          cost: 0,
        };
        links.set(id, link);
      }
      const bucket = wakeBucket(item.wake);
      link.count += 1;
      link.counts[bucket] += 1;
      link.cost += item.wake.cost_usd || 0;
      const counts = wakes.get(item.wake.agent_id) ?? emptyCounts();
      counts[bucket] += 1;
      wakes.set(item.wake.agent_id, counts);
    }
  }
  const agents: MapNode[] = view.agents.map((agent) => {
    const counts = wakes.get(agent.id) ?? emptyCounts();
    return { id: agent.id, kind: "agent", count: countTotal(counts), counts, agentId: agent.id };
  });
  const onMap = new Set(agents.map((agent) => agent.id));
  const sources: MapNode[] = [];
  const addSource = (id: string, agentId: string | null) =>
    sources.push({
      id,
      kind: nodeKind(id),
      count: started.get(id) ?? 0,
      counts: emptyCounts(),
      agentId,
    });
  for (const routine of view.routines) {
    if (onMap.has(routine.agent_id)) addSource(routineNode(routine.id), routine.agent_id);
  }
  for (const id of started.keys()) {
    if (onMap.has(id) || sources.some((source) => source.id === id)) continue;
    addSource(id, null);
  }
  return {
    sources,
    agents,
    links: [...links.values()].filter((link) => onMap.has(link.to)),
  };
}

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

export type MapLayoutOptions = {
  /** The width to fill; the map grows past it only to keep its minimum gaps. */
  width: number;
  sourceWidth?: number;
  sourceHeight?: number;
  agentWidth?: number;
  agentHeight?: number;
  sourceRow?: number;
  agentRow?: number;
  minGap?: number;
};

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

type Point = { x: number; y: number };

function cubicAt(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

const round = (value: number) => Math.round(value * 10) / 10;

/**
 * Sources in a column on the left, each beside the agent it wakes most; agents in columns to the
 * right. Links run left to right between the side ports of their boxes, spread along each side;
 * links back to an earlier or the same column loop under the boxes, the shortest innermost. A link
 * is 1.5 to 9 px wide by how often it happened.
 */
export function layoutActivityMap(
  map: ActivityMap,
  {
    width,
    sourceWidth = 208,
    sourceHeight = 44,
    agentWidth = 168,
    agentHeight = 50,
    sourceRow = 54,
    agentRow = 86,
    minGap = 72,
  }: MapLayoutOptions,
): MapLayout {
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

  const drawn = map.links.filter((link) => placed.has(link.from) && placed.has(link.to));
  const isForward = (link: MapLink) => {
    const from = placed.get(link.from) as PlacedMapNode;
    const to = placed.get(link.to) as PlacedMapNode;
    return from.kind !== "agent" || from.x < to.x;
  };
  const forward = drawn.filter(isForward);
  const loops = drawn
    .filter((link) => !isForward(link))
    .sort(
      (left, right) =>
        Math.abs((placed.get(left.from)?.x ?? 0) - (placed.get(left.to)?.x ?? 0)) -
        Math.abs((placed.get(right.from)?.x ?? 0) - (placed.get(right.to)?.x ?? 0)),
    );
  const ports = (side: "in" | "out") => {
    const bySide = new Map<string, MapLink[]>();
    for (const link of forward) {
      const id = side === "in" ? link.to : link.from;
      bySide.set(id, [...(bySide.get(id) ?? []), link]);
    }
    const at = new Map<string, number>();
    for (const [id, links] of bySide) {
      const box = placed.get(id) as PlacedMapNode;
      const other = (link: MapLink) => placed.get(side === "in" ? link.from : link.to)?.y ?? 0;
      links.sort((left, right) => other(left) - other(right));
      const room = box.h - 14;
      links.forEach((link, position) =>
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
  const maxCount = Math.max(1, ...drawn.map((link) => link.count));
  const strokeOf = (count: number) => round(1.5 + 7.5 * (count / maxCount));
  const loopBase = top + body + 8;

  const links: PlacedMapLink[] = [];
  for (const link of forward) {
    const from = placed.get(link.from) as PlacedMapNode;
    const to = placed.get(link.to) as PlacedMapNode;
    const p0 = { x: from.x + from.w, y: outPort.get(link.id) ?? from.y + from.h / 2 };
    const p3 = { x: to.x - 2, y: inPort.get(link.id) ?? to.y + to.h / 2 };
    const bend = (p3.x - p0.x) / 2;
    const p1 = { x: p0.x + bend, y: p0.y };
    const p2 = { x: p3.x - bend, y: p3.y };
    const label = cubicAt(p0, p1, p2, p3, 0.5);
    links.push({
      ...link,
      path: `M${round(p0.x)},${round(p0.y)} C${round(p1.x)},${round(p1.y)} ${round(p2.x)},${round(p2.y)} ${round(p3.x)},${round(p3.y)}`,
      width: strokeOf(link.count),
      label: { x: round(label.x), y: round(label.y) },
      loop: false,
      fromAgent: from.kind === "agent",
    });
  }
  loops.forEach((link, position) => {
    const from = placed.get(link.from) as PlacedMapNode;
    const to = placed.get(link.to) as PlacedMapNode;
    const depth = loopBase + 18 + position * 20;
    const p0 = { x: from.x + from.w * 0.62, y: from.y + from.h };
    const p3 = { x: to.x + to.w * 0.38, y: to.y + to.h + 2 };
    const p1 = { x: p0.x, y: depth };
    const p2 = { x: p3.x, y: depth };
    const label = cubicAt(p0, p1, p2, p3, 0.5);
    links.push({
      ...link,
      path: `M${round(p0.x)},${round(p0.y)} C${round(p1.x)},${round(p1.y)} ${round(p2.x)},${round(p2.y)} ${round(p3.x)},${round(p3.y)}`,
      width: strokeOf(link.count),
      label: { x: round(label.x), y: round(label.y) },
      loop: true,
      fromAgent: true,
    });
  });
  const height = loops.length ? loopBase + 18 + (loops.length - 1) * 20 + 22 : top + body + 6;
  return { width: totalWidth, height, nodes: [...placed.values()], links };
}

/* ---------- What one wake did ---------- */

/** Writes to one target: how many, by operation, the record ids touched, and the first write. */
export type WriteGroup = {
  kind: ActivityWriteKind;
  target: string;
  count: number;
  operations: Record<string, number>;
  ids: string[];
  first: ActivityWrite;
};

/** The record id at the end of a record's display path; null when the last part is not numeric. */
export function recordIdFromPath(displayPath: string | null | undefined): string | null {
  const last = (displayPath || "").split("/").pop() ?? "";
  return /^\d+$/.test(last) ? last : null;
}

/** Writes grouped by what they touched, in first-write order, with record ids and the first write. */
export function groupWrites(writes: readonly ActivityWrite[] | null | undefined): WriteGroup[] {
  const groups = new Map<string, WriteGroup>();
  for (const write of writes ?? []) {
    const key = `${write.kind}:${write.target}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        kind: write.kind,
        target: write.target,
        count: 0,
        operations: {},
        ids: [],
        first: write,
      };
      groups.set(key, group);
    }
    group.count += 1;
    group.operations[write.operation] = (group.operations[write.operation] ?? 0) + 1;
    const id = write.kind === "record" ? recordIdFromPath(write.display_path) : null;
    if (id && !group.ids.includes(id)) group.ids.push(id);
  }
  return [...groups.values()];
}

/** A value and how often it came up, most frequent first. */
export type Tally = { value: string; count: number };

export function tally(values: readonly string[]): Tally[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count);
}

function argument(args: string, key: string): string | null {
  try {
    const value = (JSON.parse(args) as Record<string, unknown>)[key];
    return typeof value === "string" ? value : null;
  } catch {
    return new RegExp(`"${key}"\\s*:\\s*"([^"]*)`).exec(args)?.[1] ?? null;
  }
}

/**
 * What a wake did, split the way a step shows it: tool calls other than posts, writes, script runs
 * and issue reports; the scripts it ran; the issues it reported; the calls that failed; its writes
 * by record, note and script; and whether it updated its memory.
 */
export type WakeEffects = {
  calls: ActivityToolCall[];
  scriptRuns: Tally[];
  issues: string[];
  failedCalls: ActivityToolCall[];
  records: WriteGroup[];
  notes: WriteGroup[];
  scripts: WriteGroup[];
  /** Repositories a coding wake changed, each with its diffstat. */
  code: ActivityWrite[];
  memory: boolean;
};

export function wakeEffects(wake: ActivityWake): WakeEffects {
  const writes = groupWrites(wake.writes);
  return {
    calls: wake.tool_calls.filter((call) => !EFFECT_TOOLS.has(call.name)),
    scriptRuns: tally(
      wake.tool_calls
        .filter((call) => call.name === "script_run")
        .map((call) => argument(call.arguments, "name") ?? "a script"),
    ),
    issues: wake.tool_calls
      .filter((call) => call.name === "report_issue")
      .map((call) => argument(call.arguments, "detail") ?? call.arguments),
    failedCalls: wake.tool_calls.filter((call) => call.error !== null),
    records: writes.filter((group) => group.kind === "record"),
    notes: writes.filter((group) => group.kind === "note"),
    scripts: writes.filter((group) => group.kind === "script"),
    code: wake.writes.filter((write) => write.kind === "code"),
    memory: writes.some((group) => group.kind === "memory"),
  };
}

/* ---------- Each agent's inputs and outputs ---------- */

/** One way an agent was woken over the window: a map source or the agent whose posts woke it. */
export type AgentInput = {
  /** The map node that woke it. */
  id: string;
  kind: MapNodeKind;
  count: number;
  counts: OutcomeCounts;
  cost: number;
  /** Why its message wakes reached the agent: tagged, routed, delivery rules, or fallback. */
  reasons: Partial<Record<ActivityTriggerReason, number>>;
};

/** Everything an agent did over the window, added up. */
export type AgentOutputs = {
  wakes: number;
  counts: OutcomeCounts;
  cost: number;
  posts: number;
  /** Wakes that posted at least once. */
  postingWakes: number;
  /** The wakes its posts started, by agent. */
  woke: Tally[];
  records: Tally[];
  recordOperations: Record<string, number>;
  notes: Tally[];
  scriptRuns: Tally[];
  scriptChanges: Tally[];
  issues: number;
  /** Wakes that updated its memory. */
  memory: number;
  /** Errors of its wakes and of their tool calls, by message. */
  errors: Tally[];
};

export type AgentActivity = { agent: ActivityAgent; inputs: AgentInput[]; outputs: AgentOutputs };

const inputOrder: Record<MapNodeKind, number> = {
  routine: 0,
  operator: 1,
  agent: 2,
  direct: 3,
  message: 4,
};

/**
 * For each agent on the map: how it was woken, one input per map source or waking agent (its
 * routines listed even when they did not fire), and what its wakes produced.
 */
export function agentActivity(
  view: ActivityView,
  chains: readonly Chain[],
  map: ActivityMap,
): AgentActivity[] {
  const steps = chains.flatMap((chain) => chainSteps(chain));
  return map.agents.flatMap((node) => {
    const agent = view.agents.find((item) => item.id === node.id);
    if (!agent) return [];
    const mine = steps.filter((item) => item.wake.agent_id === agent.id);
    const inputs = new Map<string, AgentInput>();
    for (const source of map.sources) {
      if (source.kind === "routine" && source.agentId === agent.id) {
        inputs.set(source.id, {
          id: source.id,
          kind: "routine",
          count: 0,
          counts: emptyCounts(),
          cost: 0,
          reasons: {},
        });
      }
    }
    for (const item of mine) {
      const input = inputs.get(item.from) ?? {
        id: item.from,
        kind: nodeKind(item.from),
        count: 0,
        counts: emptyCounts(),
        cost: 0,
        reasons: {},
      };
      input.count += 1;
      input.counts[wakeBucket(item.wake)] += 1;
      input.cost += item.wake.cost_usd || 0;
      if (item.wake.trigger.type === "message") {
        const reason = item.wake.trigger.reason;
        input.reasons[reason] = (input.reasons[reason] ?? 0) + 1;
      }
      inputs.set(item.from, input);
    }
    const wakes = mine.map((item) => item.wake);
    const effects = wakes.map(wakeEffects);
    const recordOperations: Record<string, number> = {};
    for (const group of effects.flatMap((effect) => effect.records)) {
      for (const [operation, count] of Object.entries(group.operations)) {
        recordOperations[operation] = (recordOperations[operation] ?? 0) + count;
      }
    }
    const expand = (groups: WriteGroup[]) =>
      groups.flatMap((group) => Array<string>(group.count).fill(group.target));
    const woken = mine.flatMap((item) => item.next.map((next) => next.wake.agent_id));
    const outputs: AgentOutputs = {
      wakes: wakes.length,
      counts: node.counts,
      cost: wakes.reduce((sum, wake) => sum + (wake.cost_usd || 0), 0),
      posts: wakes.reduce((sum, wake) => sum + wake.posts.length, 0),
      postingWakes: wakes.filter((wake) => wake.posts.length > 0).length,
      woke: tally(woken),
      records: tally(expand(effects.flatMap((effect) => effect.records))),
      recordOperations,
      notes: tally(expand(effects.flatMap((effect) => effect.notes))),
      scriptRuns: tally(
        effects.flatMap((effect) =>
          effect.scriptRuns.flatMap((run) => Array<string>(run.count).fill(run.value)),
        ),
      ),
      scriptChanges: tally(expand(effects.flatMap((effect) => effect.scripts))),
      issues: effects.reduce((sum, effect) => sum + effect.issues.length, 0),
      memory: effects.filter((effect) => effect.memory).length,
      errors: tally([
        ...wakes.flatMap((wake) =>
          wake.errors.map((error) => error.message ?? error.operation ?? "error"),
        ),
        ...effects.flatMap((effect) =>
          effect.failedCalls.map((call) => `${call.name}: ${call.error ?? ""}`),
        ),
      ]),
    };
    const ordered = [...inputs.values()].sort(
      (left, right) => inputOrder[left.kind] - inputOrder[right.kind] || right.count - left.count,
    );
    return [{ agent, inputs: ordered, outputs }];
  });
}

/* ---------- Words ---------- */

/** "1h", "6h", "24h", "3d", "7d". */
export function windowLabel(hours: number): string {
  return hours < 24 || hours % 24 !== 0 || hours === 24 ? `${hours}h` : `${hours / 24}d`;
}

const CLOCK_TIME = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;

/** A time as the viewer's clock, in hours and minutes; `—` when unreadable. */
export function clock(value: TimeValue): string {
  const ms = toMs(value);
  return ms === null ? "—" : new Date(ms).toLocaleTimeString([], CLOCK_TIME);
}

/** A time as the viewer's clock, to the second; `—` when unreadable. */
export function clockWithSeconds(value: TimeValue): string {
  const ms = toMs(value);
  return ms === null
    ? "—"
    : new Date(ms).toLocaleTimeString([], { ...CLOCK_TIME, second: "2-digit" });
}

/** A time as the viewer's clock after its month and day; `—` when unreadable. */
export function clockWithDay(value: TimeValue): string {
  const ms = toMs(value);
  if (ms === null) return "—";
  const date = new Date(ms);
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${date.toLocaleTimeString([], CLOCK_TIME)}`;
}

/** A day as the viewer's calendar: weekday, month and day. */
export function dayLabel(value: TimeValue): string {
  const ms = toMs(value);
  return ms === null
    ? "—"
    : new Date(ms).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

/** A compact duration: `53s`, `1m25s`, `2m`, `2h04m`; `—` when negative or not a number. */
export function formatActivityDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) {
    return restSeconds ? `${minutes}m${String(restSeconds).padStart(2, "0")}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** A cost in dollars: `$0`, `<$0.001`, three decimals under a dollar, two above. */
export function formatUsd(value: number | null | undefined): string {
  const amount = Number(value) || 0;
  if (amount === 0) return "$0";
  if (amount < 0.001) return "<$0.001";
  return amount < 1 ? `$${amount.toFixed(3)}` : `$${amount.toFixed(2)}`;
}

/** "3 wakes", "1 wake". */
export function plural(count: number, word: string, many = `${word}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? word : many}`;
}
