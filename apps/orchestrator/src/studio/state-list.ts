import { COLLECTIONS_SEGMENT } from "../artifacts/paths.js";
import { iso } from "../db/views.js";

// A guild's state as Studio's State list shows it: every note, table,
// script, and Memory the guild's agents work on, with who changed and who
// read each one in a window. Changes come from the change logs, reads from
// run history; both are projected here, on read. Pure: the loaders in
// state-data.ts fetch the rows.

export type StateKind = "note" | "memory" | "script" | "table";
export type StateLevel = "agent" | "guild" | "org";

export type StateItem = {
  display_path: string;
  kind: StateKind;
  level: StateLevel;
  owner_id: string;
  title: string;
  /** Bytes of text, or records for a table. */
  size: number;
  /** The note's, Memory's, or script's version; null for a table. */
  version: number | null;
  created_by: string;
  created_at: string;
  /** A table's id; null for the others. */
  collection_id: string | null;
  /** A note's id; null for the others. */
  note_id: string | null;
};

/**
 * Who acted: a person, one of this guild's agents, or an agent of another
 * guild, which is shown without its name.
 */
export type StateActor = { kind: "person" | "agent" | "other_guild"; id: string; name: string };

/** Where an event opens: the run step that did it, or the coach message it was applied from. */
export type StateLink =
  | { kind: "run"; run_id: string; agent_id: string | null; call_id: string | null }
  | { kind: "coach"; session_id: string; seq: number };

export type StateEvent = {
  path: string;
  at: string;
  what: "change" | "read";
  /** A change's operation, or how a read happened: embed, memory, note_get, record_list, record_search, script. */
  how: string;
  actor: StateActor;
  link: StateLink | null;
  /** For a record change, the record's own path. */
  record: string | null;
};

export type StateShare = { actor: StateActor; count: number; share: number };

export type StateFlag = "no_agent_read" | "writers" | "deletes_others_rows" | "untouched";

export type StateRow = StateItem & {
  changes: number;
  reads: number;
  top_writer: StateShare | null;
  top_reader: StateShare | null;
  writers: number;
  last_change: { at: string; actor: StateActor } | null;
  flags: StateFlag[];
};

type Row = Record<string, unknown>;
type Agents = ReadonlyMap<string, string>;

const OTHER_GUILD: StateActor = { kind: "other_guild", id: "", name: "another guild" };

const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

function agentActor(agentId: string, agents: Agents): StateActor {
  const name = agents.get(agentId);
  return name === undefined ? OTHER_GUILD : { kind: "agent", id: agentId, name };
}

/** Who made a stored change: the run's agent, an agent acting on its own, or a person. */
export function changeActor(row: Row, agents: Agents): StateActor {
  const agentId = str(row.run_agent_id) ?? (row.actor_type === "agent" ? str(row.actor_id) : null);
  if (agentId) return agentActor(agentId, agents);
  if (row.actor_type === "run") return OTHER_GUILD;
  return { kind: "person", id: String(row.actor_id), name: String(row.actor_name) };
}

/** The run step or coach message a stored change links to. */
export function changeLink(row: Row): StateLink | null {
  const session = str(row.studio_session_id);
  if (session && row.studio_seq !== null && row.studio_seq !== undefined) {
    return { kind: "coach", session_id: session, seq: Number(row.studio_seq) };
  }
  const runId = str(row.run_id);
  return runId ? { kind: "run", run_id: runId, agent_id: str(row.run_agent_id), call_id: str(row.tool_call_id) } : null;
}

/** A record's path names its table: `org/<org>/collections/<name>/<id>`. */
export function tablePathOf(displayPath: string): string | null {
  const parts = displayPath.split("/");
  const at = parts.indexOf(COLLECTIONS_SEGMENT);
  return at >= 0 && parts.length === at + 3 ? parts.slice(0, at + 2).join("/") : null;
}

/** The config-log key of an item's own changes: a table's shape and access, a note's access. */
export function configKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

function itemConfigKey(item: StateItem): string | null {
  if (item.collection_id) return configKey("collection", item.collection_id);
  return item.note_id ? configKey("note", item.note_id) : null;
}

/**
 * Stored changes as events on the items they touch: file changes, a record's
 * change counted for its table, and the config log's changes to a table or a note.
 */
export function changeEvents(
  fileChanges: Row[],
  configChanges: Row[],
  context: { items: StateItem[]; agents: Agents },
): StateEvent[] {
  const paths = new Set(context.items.map((item) => item.display_path));
  const configured = new Map(
    context.items.flatMap((item) => {
      const key = itemConfigKey(item);
      return key ? [[key, item.display_path] as const] : [];
    }),
  );
  const files = fileChanges.flatMap((row) => {
    const own = String(row.display_path);
    const path = paths.has(own) ? own : tablePathOf(own);
    return path && paths.has(path) ? [changeEvent(row, path, own === path ? null : own, context.agents)] : [];
  });
  const shapes = configChanges.flatMap((row) => {
    const path = configured.get(configKey(String(row.target_kind), String(row.target_id)));
    return path ? [changeEvent(row, path, null, context.agents)] : [];
  });
  return [...files, ...shapes];
}

function changeEvent(row: Row, path: string, record: string | null, agents: Agents): StateEvent {
  return {
    path,
    at: iso(row.created_at),
    what: "change",
    how: String(row.operation),
    actor: changeActor(row, agents),
    link: changeLink(row),
    record,
  };
}

type ReadContext = { items: StateItem[]; agents: Agents };

function readEvent(path: string, row: Row, how: string, context: ReadContext): StateEvent {
  const agentId = String(row.agent_id);
  return {
    path,
    at: iso(row.created_at),
    what: "read",
    how,
    actor: agentActor(agentId, context.agents),
    link: { kind: "run", run_id: String(row.run_id ?? row.id), agent_id: agentId, call_id: str(row.call_id) },
    record: null,
  };
}

function itemAt(items: StateItem[], test: (item: StateItem) => boolean): string | null {
  return items.find(test)?.display_path ?? null;
}

/** What one run read by being woken: its Task's embedded notes and tables, and its agent's Memory. */
function runReads(run: Row, context: ReadContext): StateEvent[] {
  const source = (run.task_source ?? {}) as { embeds?: Array<{ display_path?: unknown }>; collections?: unknown[] };
  const embedded = [
    ...(source.embeds ?? []).map((embed) => String(embed.display_path ?? "")),
    ...(source.collections ?? []).map(String),
  ].filter((path) => context.items.some((item) => item.display_path === path));
  const memory = itemAt(context.items, (item) => item.kind === "memory" && item.owner_id === String(run.agent_id));
  const reads = [...new Set(embedded)].map((path) => readEvent(path, run, "embed", context));
  return memory ? [...reads, readEvent(memory, run, "memory", context)] : reads;
}

function parseArguments(raw: unknown): Row {
  try {
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Row) : {};
  } catch {
    return {};
  }
}

/** The item one tool call named, by the tool's own argument. */
const callTargets: Record<string, (args: Row, call: Row, items: StateItem[]) => string | null> = {
  note_get: (args, _call, items) => itemAt(items, (item) => item.display_path === str(args.path)),
  record_list: (args, _call, items) => itemAt(items, (item) => item.kind === "table" && item.title === str(args.collection)),
  record_search: (args, _call, items) =>
    itemAt(items, (item) => item.kind === "table" && item.title === str(args.collection)),
  script_run: (args, call, items) => scriptOf(items, String(call.agent_id), str(args.name)),
};

function scriptOf(items: StateItem[], agentId: string, name: string | null): string | null {
  return itemAt(items, (item) => item.kind === "script" && item.owner_id === agentId && item.title === name);
}

/** What one tool call read: the note, table, or script it names, or the script tool it is. */
function callRead(call: Row, context: ReadContext): StateEvent | null {
  const name = String(call.tool_name);
  const target = callTargets[name];
  const path = target
    ? target(parseArguments(call.arguments), call, context.items)
    : scriptOf(context.items, String(call.agent_id), name);
  const how = target && name !== "script_run" ? name : "script";
  return path ? readEvent(path, call, how, context) : null;
}

/** Reads from run history: what each run inlined, its Memory, and the tool calls that named an item. */
export function readEvents(runs: Row[], calls: Row[], context: ReadContext): StateEvent[] {
  const fromCalls = calls.flatMap((call) => {
    const read = callRead(call, context);
    return read ? [read] : [];
  });
  return [...runs.flatMap((run) => runReads(run, context)), ...fromCalls];
}

/** Whether an actor counts: people and this guild's agents. */
export function counts(actor: StateActor): boolean {
  return actor.kind !== "other_guild";
}

function actorKey(actor: StateActor): string {
  return `${actor.kind}:${actor.id}`;
}

/** The actor behind the most events, and its share of the counted ones. */
export function topActor(events: StateEvent[]): StateShare | null {
  const tally = new Map<string, { actor: StateActor; count: number }>();
  for (const event of events) {
    const entry = tally.get(actorKey(event.actor)) ?? { actor: event.actor, count: 0 };
    tally.set(actorKey(event.actor), { ...entry, count: entry.count + 1 });
  }
  const top = [...tally.values()].sort((a, b) => b.count - a.count)[0];
  return top ? { ...top, share: top.count / events.length } : null;
}

/** A table where an agent deleted records another agent created, as the window shows them. */
function deletesOthersRows(changes: StateEvent[]): boolean {
  const creators = new Map(
    changes.filter((event) => event.how === "create" && event.record).map((event) => [event.record, actorKey(event.actor)]),
  );
  return changes.some((event) => {
    const creator = event.record ? creators.get(event.record) : undefined;
    return event.how === "delete" && event.actor.kind === "agent" && creator !== undefined && creator !== actorKey(event.actor);
  });
}

/** What stands out about an item in the window. */
export function stateFlags(item: StateItem, changes: StateEvent[], reads: StateEvent[]): StateFlag[] {
  const writers = new Set(changes.map((event) => actorKey(event.actor))).size;
  const checks: Array<[StateFlag, boolean]> = [
    ["no_agent_read", !reads.some((event) => event.actor.kind === "agent")],
    ["writers", writers > 2],
    ["deletes_others_rows", item.kind === "table" && deletesOthersRows(changes)],
    ["untouched", !changes.length && !reads.length],
  ];
  return checks.filter(([, on]) => on).map(([flag]) => flag);
}

/** One item's row: its counts, top writer and reader, last change, and flags. */
export function stateRow(item: StateItem, events: StateEvent[]): StateRow {
  const own = events.filter((event) => event.path === item.display_path && counts(event.actor));
  const changes = own.filter((event) => event.what === "change");
  const reads = own.filter((event) => event.what === "read");
  const last = [...changes].sort((a, b) => b.at.localeCompare(a.at))[0];
  return {
    ...item,
    changes: changes.length,
    reads: reads.length,
    top_writer: topActor(changes),
    top_reader: topActor(reads),
    writers: new Set(changes.map((event) => actorKey(event.actor))).size,
    last_change: last ? { at: last.at, actor: last.actor } : null,
    flags: stateFlags(item, changes, reads),
  };
}

/** The list's rows, narrowed to one kind or to items one agent changed or read when asked. */
export function stateRows(
  items: StateItem[],
  events: StateEvent[],
  filter: { kind: StateKind | null; agentId: string | null },
): StateRow[] {
  const touched = (item: StateItem) =>
    item.owner_id === filter.agentId ||
    events.some((event) => event.path === item.display_path && event.actor.id === filter.agentId);
  return items
    .filter((item) => !filter.kind || item.kind === filter.kind)
    .filter((item) => !filter.agentId || touched(item))
    .map((item) => stateRow(item, events));
}

/** How often each actor did each thing to one item: `how` is the operation or the way it read. */
export function tallyBy(events: StateEvent[]): Array<{ actor: StateActor; how: string; count: number }> {
  const tally = new Map<string, { actor: StateActor; how: string; count: number }>();
  for (const event of events) {
    const key = `${actorKey(event.actor)}\u0000${event.how}`;
    const entry = tally.get(key) ?? { actor: event.actor, how: event.how, count: 0 };
    tally.set(key, { ...entry, count: entry.count + 1 });
  }
  return [...tally.values()].sort((a, b) => b.count - a.count);
}
