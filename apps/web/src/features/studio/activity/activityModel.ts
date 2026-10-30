import type { WakeOutcome } from "@guildsrun/ui";
import type {
  ActivityAgent,
  ActivityMessage,
  ActivityPost,
  ActivityRoutine,
  ActivityTrigger,
  ActivityTriggerReason,
  ActivityView,
  ActivityWake,
} from "../../../api/types/studio";
import { tally, wakeEffects, type Tally, type WriteGroup } from "./wakeEffects";

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

/** Every reason a message reaches the agent it wakes. */
const activityTriggerReasons = [
  "tag",
  "jev",
  "rules",
  "fallback",
] as const satisfies readonly ActivityTriggerReason[];

/** Whether a key of an agent input's reasons names a reason a message wakes an agent for. */
export function isActivityTriggerReason(value: string): value is ActivityTriggerReason {
  const known: readonly string[] = activityTriggerReasons;
  return known.includes(value);
}

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
    const seq = triggerSeq(wake);
    const existing = seq === null ? undefined : byMessage.get(seq);
    if (existing) {
      existing.steps.push(step(wake, existing.source, null));
      continue;
    }
    const { start, source } = chainOrigin(wake, index);
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
    if (seq !== null) byMessage.set(seq, chain);
  }
  return chains.map(withTotals).sort((left, right) => right.start.at - left.start.at);
}

/** What started the chain a wake begins, and the map node it starts from. */
function chainOrigin(wake: ActivityWake, index: ActivityIndex): Pick<Chain, "start" | "source"> {
  const at = toMs(wake.started_at) ?? 0;
  const { trigger } = wake;
  if (trigger.type === "routine") {
    return {
      start: { kind: "routine", scheduleId: trigger.schedule_id, at },
      source: routineNode(trigger.schedule_id),
    };
  }
  if (trigger.type === "direct") return { start: { kind: "direct", at }, source: DIRECT_NODE };
  return messageOrigin(trigger.seq, index, at);
}

/**
 * What started the chain a message wake begins: the operator's row, an agent's post from before
 * the window, or a row the ledger does not include. `wokeAt` dates a start whose row is missing.
 */
function messageOrigin(
  seq: number | null,
  index: ActivityIndex,
  wokeAt: number,
): Pick<Chain, "start" | "source"> {
  const message = seq === null ? undefined : index.messages.get(seq);
  const author = message?.author_agent_id;
  if (message?.author_type === "user") {
    return {
      start: { kind: "operator", message, at: toMs(message.created_at) ?? wokeAt },
      source: OPERATOR_NODE,
    };
  }
  if (message && author && index.agents.has(author)) {
    return {
      start: { kind: "earlier", message, at: toMs(message.created_at) ?? wokeAt },
      source: author,
    };
  }
  return { start: { kind: "unknown", seq, at: wokeAt }, source: MESSAGE_NODE };
}

/** A chain with its wakes counted and costed, when the last ended, and whether all were silent. */
function withTotals(chain: Chain): Chain {
  const steps = chainSteps(chain);
  return {
    ...chain,
    wakes: steps.length,
    cost: steps.reduce((sum, item) => sum + (item.wake.cost_usd || 0), 0),
    end: steps.reduce(
      (end, item) => Math.max(end, toMs(item.wake.ended_at) ?? end),
      chain.start.at,
    ),
    quiet: steps.every((item) => wakeBucket(item.wake) === "silent"),
  };
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
  for (let line = queue.shift(); line; line = queue.shift()) {
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
  return {
    sources: mapSources(view.routines, started, onMap),
    agents,
    links: [...links.values()].filter((link) => onMap.has(link.to)),
  };
}

/**
 * The map's sources, each with the chains it started: every routine of an agent on the map, then
 * every other node that started a chain and is no agent on the map.
 */
function mapSources(
  routines: readonly ActivityRoutine[],
  started: ReadonlyMap<string, number>,
  onMap: ReadonlySet<string>,
): MapNode[] {
  const sources: MapNode[] = [];
  const addSource = (id: string, agentId: string | null) =>
    sources.push({
      id,
      kind: nodeKind(id),
      count: started.get(id) ?? 0,
      counts: emptyCounts(),
      agentId,
    });
  for (const routine of routines) {
    if (onMap.has(routine.agent_id)) addSource(routineNode(routine.id), routine.agent_id);
  }
  for (const id of started.keys()) {
    if (onMap.has(id) || sources.some((source) => source.id === id)) continue;
    addSource(id, null);
  }
  return sources;
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
    return [
      {
        agent,
        inputs: agentInputs(agent.id, map.sources, mine),
        outputs: agentOutputs(node.counts, mine),
      },
    ];
  });
}

/**
 * How an agent was woken, routines first and then the operator, other agents, direct chats and
 * unknown rows, busiest first: one input per map source or waking agent of its wakes, its routines
 * listed even when they did not fire.
 */
function agentInputs(
  agentId: string,
  sources: readonly MapNode[],
  wakes: readonly ChainStep[],
): AgentInput[] {
  const inputs = new Map<string, AgentInput>();
  for (const source of sources) {
    if (source.kind === "routine" && source.agentId === agentId) {
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
  for (const item of wakes) {
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
  return [...inputs.values()].sort(
    (left, right) => inputOrder[left.kind] - inputOrder[right.kind] || right.count - left.count,
  );
}

/** What an agent's wakes produced, added up; `counts` are its wakes by outcome. */
function agentOutputs(counts: OutcomeCounts, steps: readonly ChainStep[]): AgentOutputs {
  const wakes = steps.map((item) => item.wake);
  const effects = wakes.map(wakeEffects);
  const recordOperations: Record<string, number> = {};
  for (const group of effects.flatMap((effect) => effect.records)) {
    for (const [operation, count] of Object.entries(group.operations)) {
      recordOperations[operation] = (recordOperations[operation] ?? 0) + count;
    }
  }
  const expand = (groups: WriteGroup[]) =>
    groups.flatMap((group) => Array<string>(group.count).fill(group.target));
  const woken = steps.flatMap((item) => item.next.map((next) => next.wake.agent_id));
  return {
    wakes: wakes.length,
    counts,
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
