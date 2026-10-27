import {
  EMBED_BUDGET,
  EMBED_DEPTH,
  collectTaskEmbeds,
  inspectEmbed,
  parseDisplayPath,
  storeNoteReader,
  taskEmbedActor,
  walkTaskEmbeds,
  withoutEmbeds,
  type ArtifactActor,
  type ArtifactLevel,
  type ArtifactRow,
  type ArtifactStore,
  type CollectionView,
  type EmbedStep,
} from "../artifacts/index.js";
import { taskDisplayPath } from "../agents/task.js";
import { listAgents, type AgentRow } from "../db/agents.js";
import type { Queryable } from "../db/pg.js";

export type ReferenceNodeKind = "task" | "note" | "table" | "unresolved";

/** A Task, a note or table, or a link target that does not resolve. */
export type ReferenceNode = {
  /** The display path, or the link as written when it does not resolve. */
  id: string;
  kind: ReferenceNodeKind;
  label: string;
  level: ArtifactLevel | null;
  /** The agent whose Task it is, or who owns an agent-level note. */
  agent_id: string | null;
  collection_id: string | null;
  /** Part of the guild's state, rather than only reached from it. */
  in_state: boolean;
  /** UTF-8 size of its text. */
  bytes: number;
  /** For a Task: the note text a run inlines, counted against the embed budget. */
  inlined_bytes: number | null;
  /** The hop at which each agent's run meets it: 0 its own Task, 1 and 2 inlined, 3 left as text. */
  hops: Record<string, number>;
  /** Embed hops from the nearest Task; null when no Task reaches it. */
  depth: number | null;
  /** Why a link does not resolve. */
  reason: string | null;
  /** The agents whose runs meet it at an inlined level but cannot read it, so they get the unreachable marker. */
  unreachable_for: string[];
};

/**
 * `inlined`: the holder's embeds are expanded in some run. `too_deep`: runs meet the holder only at
 * the last inlined level, so the embed stays text. `unreached`: no Task reaches the holder.
 * `broken`: the target does not resolve, or a run that inlines the holder cannot read it. `named`: the text names the path without embedding it.
 */
export type ReferenceEdgeStatus = "inlined" | "too_deep" | "unreached" | "broken" | "named";

export type ReferenceEdge = {
  from: string;
  to: string;
  kind: "embed" | "name";
  status: ReferenceEdgeStatus;
};

export type GuildReferences = {
  guild_id: string;
  budget: number;
  depth: number;
  nodes: ReferenceNode[];
  edges: ReferenceEdge[];
};

export type ReferenceTask = { agent_id: string; label: string; display_path: string; text: string };

/** A note or table; `text` is null for a table, and for a note too far from any Task to be read. */
export type ReferenceFile = {
  display_path: string;
  kind: "note" | "table";
  label: string;
  level: ArtifactLevel;
  agent_id: string | null;
  collection_id: string | null;
  in_state: boolean;
  text: string | null;
};

export type UnresolvedLink = { href: string; reason: string };

export type ReferenceInput = {
  guild_id: string;
  tasks: ReferenceTask[];
  files: ReferenceFile[];
  unresolved: UnresolvedLink[];
  /** Each agent's walk of its Task as that agent reads, by agent id, one level past what a run inlines. */
  walks: Map<string, EmbedStep[]>;
  /** The embeds each agent's run inlines but cannot read, by agent id. */
  unreachable: Map<string, Set<string>>;
};

type EdgeContext = {
  hops: Map<string, Record<string, number>>;
  unresolved: Set<string>;
  /** The agents that cannot read each target, by display path. */
  blocked: Map<string, string[]>;
};

// A display path as prose names it: `org/<org_id>/…` up to a space, quote, or bracket.
const NAMED_PATH = /org\/[A-Za-z0-9_]+\/[^\s[\]()<>"'`]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

const byteSize = (text: string | null): number => Buffer.byteLength(text ?? "", "utf8");

/** What each Task and file embeds or names, how deep each run meets it, and what does not resolve. */
export function buildReferences(input: ReferenceInput): GuildReferences {
  const hops = hopsByTarget(input);
  const blocked = blockedAgents(input.unreachable);
  const texts = noteTexts(input.files);
  const nodes = new Map<string, ReferenceNode>();
  for (const item of input.unresolved) nodes.set(item.href, unresolvedNode(item, hops));
  for (const file of input.files) nodes.set(file.display_path, fileNode(file, hops));
  for (const task of input.tasks) nodes.set(task.display_path, taskNode(task, input, texts));
  for (const node of nodes.values()) node.unreachable_for = blocked.get(node.id) ?? [];
  const edges = referenceEdges(input, [...nodes.values()], {
    hops,
    unresolved: new Set(input.unresolved.map((item) => item.href)),
    blocked,
  });
  return {
    guild_id: input.guild_id,
    budget: EMBED_BUDGET,
    depth: EMBED_DEPTH,
    nodes: withDepths([...nodes.values()], edges),
    edges,
  };
}

/** Each live note's text, by display path, for the notes that were read. */
export function noteTexts(files: readonly ReferenceFile[]): Map<string, string> {
  return new Map(
    files.flatMap((file) =>
      file.kind === "note" && file.text !== null ? [[file.display_path, file.text]] : [],
    ),
  );
}

function hopsByTarget(input: ReferenceInput): Map<string, Record<string, number>> {
  const hops = new Map<string, Record<string, number>>();
  const meet = (id: string, agentId: string, hop: number) => {
    const met = hops.get(id) ?? {};
    met[agentId] = Math.min(met[agentId] ?? hop, hop);
    hops.set(id, met);
  };
  for (const task of input.tasks) meet(task.display_path, task.agent_id, 0);
  for (const [agentId, steps] of input.walks) {
    for (const step of steps) meet(step.href, agentId, step.depth);
  }
  return hops;
}

/** The agents that cannot read each embed target their runs inline, by target. */
function blockedAgents(unreachable: Map<string, Set<string>>): Map<string, string[]> {
  const blocked = new Map<string, string[]>();
  for (const [agentId, hrefs] of unreachable) {
    for (const href of hrefs) blocked.set(href, [...(blocked.get(href) ?? []), agentId]);
  }
  return blocked;
}

function taskNode(
  task: ReferenceTask,
  input: Pick<ReferenceInput, "walks" | "unreachable">,
  texts: Map<string, string>,
): ReferenceNode {
  const unreachable = input.unreachable.get(task.agent_id) ?? new Set<string>();
  const inlined = (input.walks.get(task.agent_id) ?? []).filter(
    (step) => step.inlined && !unreachable.has(step.href),
  );
  return {
    id: task.display_path,
    kind: "task",
    label: task.label,
    level: "agent",
    agent_id: task.agent_id,
    collection_id: null,
    in_state: true,
    bytes: byteSize(task.text),
    inlined_bytes: inlined.reduce((sum, step) => sum + byteSize(texts.get(step.href) ?? null), 0),
    hops: { [task.agent_id]: 0 },
    depth: 0,
    reason: null,
    unreachable_for: [],
  };
}

function fileNode(file: ReferenceFile, hops: Map<string, Record<string, number>>): ReferenceNode {
  return {
    id: file.display_path,
    kind: file.kind,
    label: file.label,
    level: file.level,
    agent_id: file.agent_id,
    collection_id: file.collection_id,
    in_state: file.in_state,
    bytes: byteSize(file.text),
    inlined_bytes: null,
    hops: hops.get(file.display_path) ?? {},
    depth: null,
    reason: null,
    unreachable_for: [],
  };
}

function unresolvedNode(
  link: UnresolvedLink,
  hops: Map<string, Record<string, number>>,
): ReferenceNode {
  return {
    id: link.href,
    kind: "unresolved",
    label: link.href,
    level: null,
    agent_id: null,
    collection_id: null,
    in_state: false,
    bytes: 0,
    inlined_bytes: null,
    hops: hops.get(link.href) ?? {},
    depth: null,
    reason: link.reason,
    unreachable_for: [],
  };
}

function referenceEdges(
  input: ReferenceInput,
  nodes: ReferenceNode[],
  context: EdgeContext,
): ReferenceEdge[] {
  const sources = [
    ...input.tasks.map((task) => ({ id: task.display_path, text: task.text })),
    ...input.files.flatMap((file) =>
      file.text === null ? [] : [{ id: file.display_path, text: file.text }],
    ),
  ];
  const named = new Set(nodes.filter((node) => node.kind !== "unresolved").map((node) => node.id));
  return sources.flatMap((source) => {
    const embeds = collectTaskEmbeds(source.text);
    const names = namedPaths(source.text, named).filter(
      (path) => path !== source.id && !embeds.includes(path),
    );
    return [
      ...embeds.map((to) => embedEdge(context, source.id, to)),
      ...names.map((to): ReferenceEdge => ({ from: source.id, to, kind: "name", status: "named" })),
    ];
  });
}

function embedEdge(context: EdgeContext, from: string, to: string): ReferenceEdge {
  return { from, to, kind: "embed", status: embedStatus(context, from, to) };
}

function embedStatus(context: EdgeContext, from: string, to: string): ReferenceEdgeStatus {
  if (context.unresolved.has(to) || isBlockedEmbed(context, from, to)) return "broken";
  const hops = Object.values(context.hops.get(from) ?? {});
  if (hops.some((hop) => hop < EMBED_DEPTH)) return "inlined";
  return hops.length ? "too_deep" : "unreached";
}

/** Whether a run that expands the holder's embeds cannot read the target. */
function isBlockedEmbed(context: EdgeContext, from: string, to: string): boolean {
  const blocked = context.blocked.get(to) ?? [];
  return Object.entries(context.hops.get(from) ?? {}).some(
    ([agentId, hop]) => hop < EMBED_DEPTH && blocked.includes(agentId),
  );
}

/** The known display paths a text names outside its embeds, each once. */
export function namedPaths(text: string, known: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  for (const match of withoutEmbeds(text).matchAll(NAMED_PATH)) {
    const path = match[0].replace(TRAILING_PUNCTUATION, "");
    if (known.has(path)) found.add(path);
  }
  return [...found];
}

/** Each node's depth: its nearest run's hop, then one more per embed past the walked levels. */
function withDepths(nodes: ReferenceNode[], edges: ReferenceEdge[]): ReferenceNode[] {
  const depth = new Map<string, number>();
  for (const node of nodes) {
    const hops = Object.values(node.hops);
    if (hops.length) depth.set(node.id, Math.min(...hops));
  }
  const embeds = edges.filter((edge) => edge.kind === "embed");
  let frontier = new Set(depth.keys());
  while (frontier.size) frontier = deepen(depth, frontier, embeds);
  return nodes.map((node) => ({ ...node, depth: depth.get(node.id) ?? null }));
}

function deepen(
  depth: Map<string, number>,
  frontier: Set<string>,
  embeds: ReferenceEdge[],
): Set<string> {
  const next = new Set<string>();
  for (const edge of embeds.filter((item) => frontier.has(item.from) && !depth.has(item.to))) {
    depth.set(edge.to, (depth.get(edge.from) ?? 0) + 1);
    next.add(edge.to);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Loading: the guild's files as the operator may read them, each Task's run as its agent reads.

export type ReferenceDeps = { db: Queryable; artifacts: ArtifactStore };

type Reached = { files: ReferenceFile[]; unresolved: UnresolvedLink[] };
type Resolved = { file?: ReferenceFile; unresolved?: UnresolvedLink };

/**
 * What every Task and file in a guild's state embeds or names, read as `actor`: the guild's
 * agents' notes, the guild's and organisation's notes and tables, and what their embeds reach.
 * Each Task's run is walked as its agent, so an embed the agent cannot read shows as broken.
 */
export async function loadGuildReferences(
  deps: ReferenceDeps,
  actor: ArtifactActor,
  guildId: string,
): Promise<GuildReferences> {
  const agents = await listAgents(deps.db, guildId);
  const tasks = agents.map((agent) => referenceTask(actor.orgId, agent));
  const state = await loadStateFiles(deps.artifacts, actor, {
    guildId,
    agentIds: tasks.map((task) => task.agent_id),
  });
  const reached = await resolveReached(deps.artifacts, actor, {
    texts: [
      ...tasks.map((task) => task.text),
      ...state.flatMap((file) => (file.text === null ? [] : [file.text])),
    ],
    known: new Set(state.map((file) => file.display_path)),
  });
  const runs = await walkAgentRuns(deps.artifacts, actor.orgId, agents);
  return buildReferences({
    guild_id: guildId,
    tasks,
    files: [...state, ...reached.files],
    unresolved: reached.unresolved,
    ...runs,
  });
}

function referenceTask(orgId: string, agent: Pick<AgentRow, "id" | "name" | "task">): ReferenceTask {
  const agentId = agent.id;
  return {
    agent_id: agentId,
    label: agent.name,
    display_path: taskDisplayPath(orgId, agentId),
    text: String(agent.task ?? ""),
  };
}

async function loadStateFiles(
  store: ArtifactStore,
  actor: ArtifactActor,
  scope: { guildId: string; agentIds: string[] },
): Promise<ReferenceFile[]> {
  const owners: Array<[ArtifactLevel, string]> = [
    ...scope.agentIds.map((id): [ArtifactLevel, string] => ["agent", id]),
    ["guild", scope.guildId],
    ["org", actor.orgId],
  ];
  const listed = await Promise.all(
    owners.map(([level, ownerId]) => store.listOwnerNotes(actor, level, ownerId)),
  );
  const notes = await Promise.all(
    listed.flat().map((item) => loadNoteFile(store, actor, String(item.display_path))),
  );
  const tables = (await store.listCollections(actor)).filter(
    (table) => table.guild === null || table.guild.id === scope.guildId,
  );
  return [
    ...notes.flatMap((note) => (note ? [{ ...note, in_state: true }] : [])),
    ...tables.map((table) => tableFile(table, true)),
  ];
}

async function loadNoteFile(
  store: ArtifactStore,
  actor: ArtifactActor,
  displayPath: string,
): Promise<ReferenceFile | null> {
  try {
    const loaded = await store.getByDisplayPath(actor, displayPath);
    const row = loaded.tombstone ? undefined : loaded.row;
    return row?.kind === "note" ? noteFile(displayPath, row) : null;
  } catch {
    return null;
  }
}

function noteFile(displayPath: string, row: ArtifactRow): ReferenceFile {
  return {
    display_path: displayPath,
    kind: "note",
    label: row.title || row.key.replace(/\.md$/, ""),
    level: row.level,
    agent_id: row.level === "agent" ? row.owner_id : null,
    collection_id: null,
    in_state: false,
    text: row.content_text ?? "",
  };
}

function tableFile(
  table: Pick<CollectionView, "id" | "name" | "display_path" | "scope">,
  inState: boolean,
): ReferenceFile {
  return {
    display_path: table.display_path,
    kind: "table",
    label: table.name,
    level: table.scope,
    agent_id: null,
    collection_id: table.id,
    in_state: inState,
    text: null,
  };
}

/**
 * The embed targets outside the guild's state: notes and tables the actor can read, followed as
 * far as a run could inline them, and the links that do not resolve, with why.
 */
async function resolveReached(
  store: ArtifactStore,
  actor: ArtifactActor,
  start: { texts: string[]; known: Set<string> },
): Promise<Reached> {
  const { known } = start;
  const reached: Reached = { files: [], unresolved: [] };
  let layer = start.texts;
  for (let round = 0; round <= EMBED_DEPTH; round += 1) {
    const hrefs = [...new Set(layer.flatMap((text) => collectTaskEmbeds(text)))].filter(
      (href) => !known.has(href),
    );
    hrefs.forEach((href) => known.add(href));
    const resolved = await Promise.all(
      hrefs.map((href) => resolveHref(store, actor, { href, readText: round < EMBED_DEPTH })),
    );
    const files = resolved.flatMap((item) => (item.file ? [item.file] : []));
    reached.files.push(...files);
    reached.unresolved.push(
      ...resolved.flatMap((item) => (item.unresolved ? [item.unresolved] : [])),
    );
    layer = files.flatMap((file) => (file.text === null ? [] : [file.text]));
  }
  return reached;
}

async function resolveHref(
  store: ArtifactStore,
  actor: ArtifactActor,
  target: { href: string; readText: boolean },
): Promise<Resolved> {
  const inspection = await inspectEmbed(store, actor, target.href);
  if (!inspection.ok)
    return { unresolved: { href: target.href, reason: inspection.reason ?? "missing" } };
  const parsed = parseDisplayPath(target.href);
  const file =
    parsed.kind === "collection"
      ? await reachedTable(store, actor, { href: target.href, name: parsed.collectionName })
      : await loadNoteFile(store, actor, target.href);
  if (!file) return {};
  return { file: target.readText ? file : { ...file, text: null } };
}

async function reachedTable(
  store: ArtifactStore,
  actor: ArtifactActor,
  table: { href: string; name: string },
): Promise<ReferenceFile | null> {
  const described = await store.describeCollection(actor, table.name);
  if (!described) return null;
  const scope = described.guild_id ? "guild" : "org";
  return tableFile(
    { id: described.id, name: described.name, display_path: table.href, scope },
    false,
  );
}

type AgentRuns = Pick<ReferenceInput, "walks" | "unreachable">;

/** Each agent's walk of its Task as that agent reads, and the inlined embeds it cannot read. */
async function walkAgentRuns(
  store: ArtifactStore,
  orgId: string,
  agents: Array<Pick<AgentRow, "id" | "guild_id" | "name" | "task">>,
): Promise<AgentRuns> {
  const runs: AgentRuns = { walks: new Map(), unreachable: new Map() };
  for (const agent of agents) {
    const actor = taskEmbedActor(orgId, agent);
    const steps = await walkTaskEmbeds(
      String(agent.task ?? ""),
      storeNoteReader(store, actor),
      EMBED_DEPTH + 1,
    );
    runs.walks.set(agent.id, steps);
    runs.unreachable.set(agent.id, await unreachableEmbeds(store, actor, steps));
  }
  return runs;
}

async function unreachableEmbeds(
  store: ArtifactStore,
  actor: ArtifactActor,
  steps: EmbedStep[],
): Promise<Set<string>> {
  const hrefs = [...new Set(steps.filter((step) => step.inlined).map((step) => step.href))];
  const inspected = await Promise.all(hrefs.map((href) => inspectEmbed(store, actor, href)));
  return new Set(inspected.filter((item) => !item.ok).map((item) => item.href));
}
