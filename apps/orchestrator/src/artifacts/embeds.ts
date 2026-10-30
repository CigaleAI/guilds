import { createHash } from "node:crypto";
import { agentActor } from "./actors.js";
import { ArtifactError } from "./errors.js";
import { isDisplayPath, parseDisplayPath } from "./paths.js";
import { EMBED_BUDGET, type ArtifactActor } from "./types.js";
import type { AgentRow } from "../db/agents.js";
import { bindQuery } from "../db/pg.js";
import type { TaskEmbedSnapshot } from "../db/schema/index.js";
import { describeCollection } from "./collections.js";
import { getByDisplayPath, type DisplayPathRead, type LiveNote } from "./notes.js";
import type { ArtifactRow } from "../db/artifacts.js";
import type { ArtifactStore, CollectionDescription } from "./store.js";

const EMBED_RE = /!\[\[([^\]]+)\]\]/g;

/** Why an embed that names a file path does not resolve: the agent cannot tell a missing file from one it cannot read. */
const NOT_REACHABLE = "not reachable";

const UNREACHABLE_TAG = "unreachable";

// Element names an inlined note must not take: the prompt sections it sits
// inside and the marker for an unreachable embed, where a same-named element
// would be ambiguous.
const RESERVED_TAGS = new Set(["guidelines", "task", "state", "memory", UNREACHABLE_TAG]);

// The XML element name for an inlined note: its file name without `.md`,
// reduced to the characters an element name allows.
export function embedTagName(key: string): string {
  const slug = key
    .replace(/\.md$/i, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    return "note";
  }
  if (!/^[A-Za-z_]/.test(slug) || RESERVED_TAGS.has(slug.toLowerCase())) {
    return `note-${slug}`;
  }
  return slug;
}

/** What a run puts in place of an embed that does not resolve to a note or table the agent can read. */
export function unreachableMarker(href: string): string {
  return `<${UNREACHABLE_TAG} path="${escapeXml(href)}" message="This file is not reachable." />`;
}

/** The actor a Task's embeds resolve as: the agent whose Task it is. */
export function taskEmbedActor(orgId: string, agent: Pick<AgentRow, "id" | "guild_id" | "name">): ArtifactActor {
  return agentActor({
    orgId,
    guildId: agent.guild_id,
    agentId: agent.id,
    agentName: agent.name,
  });
}

/** The table an embed names: its organisation and its name. */
type CollectionEmbed = { orgId: string; name: string };

function collectionEmbed(href: string): CollectionEmbed | null {
  try {
    const parsed = parseDisplayPath(href);
    return parsed.kind === "collection" ? { orgId: parsed.orgId, name: parsed.collectionName } : null;
  } catch {
    return null;
  }
}

export function collectTaskEmbeds(task: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of task.matchAll(EMBED_RE)) {
    const href = (match[1] ?? "").trim();
    if (!href || seen.has(href)) {
      continue;
    }
    seen.add(href);
    found.push(href);
  }
  return found;
}

/** The text with its embeds taken out, so what is left only names paths. */
export function withoutEmbeds(text: string): string {
  return text.replace(EMBED_RE, " ");
}

export const EMBED_DEPTH = 2;

type EmbedBudget = { used: number };
type EmbedMemory = { seen: Set<string>; titles: Map<string, string> };
type InlineContext = { source: EmbedSource; actor: ArtifactActor; budget: EmbedBudget; memory: EmbedMemory };

/** What task embeds read, as an actor: what a display path holds, and a collection's description. */
export type EmbedSource = {
  getByDisplayPath(actor: ArtifactActor, href: string): Promise<DisplayPathRead>;
  describeCollection(actor: ArtifactActor, name: string): Promise<CollectionDescription | null>;
};

/** The embed source over the store's notes and collections. */
export function embedSource(store: ArtifactStore): EmbedSource {
  return { getByDisplayPath: bindQuery(store, getByDisplayPath), describeCollection: bindQuery(store, describeCollection) };
}

/** One embed a run meets: the note that holds it (null for the Task), its depth, and whether the run inlines it. */
export type EmbedStep = { from: string | null; href: string; depth: number; inlined: boolean };

/** The text of a live note the walk goes into, or null for anything it does not open. */
export type EmbedReader = (href: string) => Promise<string | null>;

type EmbedWalk = { read: EmbedReader; levels: number; seen: Set<string>; steps: EmbedStep[] };
type EmbedLayer = { text: string; from: string | null; depth: number };

/**
 * The embeds a run meets in a Task, in the order it inlines them: each one within EMBED_DEPTH
 * once, as the run inlines it. Levels past EMBED_DEPTH are walked too, their embeds marked as
 * staying text, without changing what the inlined levels see.
 */
export async function walkTaskEmbeds(task: string, read: EmbedReader, levels = EMBED_DEPTH): Promise<EmbedStep[]> {
  const walk: EmbedWalk = { read, levels, seen: new Set(), steps: [] };
  await walkEmbedLayer(walk, { text: task, from: null, depth: 1 });
  return walk.steps;
}

async function walkEmbedLayer(walk: EmbedWalk, layer: EmbedLayer): Promise<void> {
  for (const href of collectTaskEmbeds(layer.text)) {
    if (walk.seen.has(href)) {
      continue;
    }
    const inlined = layer.depth <= EMBED_DEPTH;
    if (inlined) {
      walk.seen.add(href);
    }
    walk.steps.push({ from: layer.from, href, depth: layer.depth, inlined });
    await walkEmbedChild(walk, href, layer.depth);
  }
}

async function walkEmbedChild(walk: EmbedWalk, href: string, depth: number): Promise<void> {
  if (depth >= walk.levels) {
    return;
  }
  const body = await walk.read(href);
  if (body !== null) {
    await walkEmbedLayer(walk, { text: body, from: href, depth: depth + 1 });
  }
}

type EmbedNote = { row: ArtifactRow; reason?: undefined } | { row?: undefined; reason: string };

/** The live note an embed names, as the actor reads it, or why it does not resolve. */
async function readEmbedNote(source: EmbedSource, actor: ArtifactActor, href: string): Promise<EmbedNote> {
  if (!isDisplayPath(href)) {
    return { reason: href.startsWith("recipe:") ? "recipe link was not rewritten to a file path" : "not a file path" };
  }
  const loaded = await loadDisplayPath(source, actor, href);
  if (!loaded || loaded.tombstone) {
    return { reason: NOT_REACHABLE };
  }
  if (loaded.row?.kind === "note") {
    return { row: loaded.row };
  }
  return { reason: loaded.row || loaded.revision ? "not a note" : NOT_REACHABLE };
}

/** What a display path holds for the actor, or null when the store refuses it. */
async function loadDisplayPath(
  source: EmbedSource,
  actor: ArtifactActor,
  href: string,
): Promise<DisplayPathRead | null> {
  try {
    return await source.getByDisplayPath(actor, href);
  } catch (error) {
    if (error instanceof ArtifactError) {
      return null;
    }
    throw error;
  }
}

/** Whether the actor can read the collection an embed names. */
async function readsEmbedCollection(
  source: EmbedSource,
  actor: ArtifactActor,
  collection: CollectionEmbed,
): Promise<boolean> {
  return collection.orgId === actor.orgId && (await source.describeCollection(actor, collection.name)) !== null;
}

/** A walk reader over the notes the actor can read. */
export function noteReader(source: EmbedSource, actor: ArtifactActor): EmbedReader {
  return async (href) => {
    if (collectionEmbed(href)) {
      return null;
    }
    const note = await readEmbedNote(source, actor, href);
    return note.row ? String(note.row.content_text ?? "") : null;
  };
}

async function collectEmbedsDeep(source: EmbedSource, actor: ArtifactActor, text: string): Promise<string[]> {
  const steps = await walkTaskEmbeds(text, noteReader(source, actor));
  return steps.map((step) => step.href);
}

export type TaskEmbedInspection = {
  href: string;
  ok: boolean;
  reason?: string;
};

export async function inspectTaskEmbeds(
  source: EmbedSource,
  actor: ArtifactActor,
  task: string,
): Promise<TaskEmbedInspection[]> {
  const items: TaskEmbedInspection[] = [];
  for (const href of await collectEmbedsDeep(source, actor, task)) {
    items.push(await inspectEmbed(source, actor, href));
  }
  return items;
}

/** Whether one embed resolves to a note or table the actor can read, and why not when it does not. */
export async function inspectEmbed(source: EmbedSource, actor: ArtifactActor, href: string): Promise<TaskEmbedInspection> {
  const collection = collectionEmbed(href);
  if (collection) {
    const reads = await readsEmbedCollection(source, actor, collection);
    return reads ? { href, ok: true } : { href, ok: false, reason: NOT_REACHABLE };
  }
  const note = await readEmbedNote(source, actor, href);
  return note.row ? { href, ok: true } : { href, ok: false, reason: note.reason };
}

/** A note or table an embed walk reaches: a note with its text, null where the walk stops reading, or a table's description. */
export type EmbedTarget =
  | { kind: "note"; href: string; row: ArtifactRow; text: string | null }
  | { kind: "collection"; href: string; collection: CollectionDescription };

/** An embed that does not resolve for its reader, and why. */
export type UnresolvedEmbed = { href: string; reason: string };

/** What an embed walk reaches past the display paths its reader already holds. */
export type EmbedReach = { targets: EmbedTarget[]; unresolved: UnresolvedEmbed[] };

/**
 * What `roots` embed as the actor reads them, round by round, one level past what a run inlines:
 * each note and table in the order the walk first meets it, and each link that does not resolve.
 * A note met at that last level is not read. The walk neither resolves nor follows `known`.
 */
export async function reachEmbeds(
  source: EmbedSource,
  actor: ArtifactActor,
  roots: string[],
  known: ReadonlySet<string>,
): Promise<EmbedReach> {
  const met = new Set(known);
  const reach: EmbedReach = { targets: [], unresolved: [] };
  let layer = roots;
  for (let round = 0; round <= EMBED_DEPTH; round += 1) {
    const hrefs = [...new Set(layer.flatMap((text) => collectTaskEmbeds(text)))].filter((href) => !met.has(href));
    hrefs.forEach((href) => met.add(href));
    const resolved = await Promise.all(hrefs.map((href) => resolveEmbedTarget(source, actor, href)));
    const targets = resolved.flatMap((item) => (item.target ? [item.target] : []));
    reach.targets.push(...(round < EMBED_DEPTH ? targets : targets.map(unreadTarget)));
    reach.unresolved.push(...resolved.flatMap((item) => (item.unresolved ? [item.unresolved] : [])));
    layer = targets.flatMap((target) => (target.kind === "note" ? [target.text ?? ""] : []));
  }
  return reach;
}

/** The note or table one embed names, as the actor reads it, or why it does not resolve. */
async function resolveEmbedTarget(
  source: EmbedSource,
  actor: ArtifactActor,
  href: string,
): Promise<{ target: EmbedTarget; unresolved?: undefined } | { target?: undefined; unresolved: UnresolvedEmbed }> {
  const collection = collectionEmbed(href);
  if (collection) {
    const described = collection.orgId === actor.orgId ? await source.describeCollection(actor, collection.name) : null;
    return described
      ? { target: { kind: "collection", href, collection: described } }
      : { unresolved: { href, reason: NOT_REACHABLE } };
  }
  const note = await readEmbedNote(source, actor, href);
  return note.row
    ? { target: { kind: "note", href, row: note.row, text: note.row.content_text ?? "" } }
    : { unresolved: { href, reason: note.reason } };
}

/** A target as the walk's last level holds it: a note's text is not read there. */
function unreadTarget(target: EmbedTarget): EmbedTarget {
  return target.kind === "note" ? { ...target, text: null } : target;
}

/** What texts embed as a reader reads them, with how many embed levels a run inlines and how many bytes of note text at most. */
export type EmbedGraph = EmbedReach & { depth: number; budget: number };

/**
 * What `roots` embed as the actor reads them, followed one level past what a run inlines. The
 * walk neither resolves nor follows the display paths in `known`.
 */
export async function embedGraph(
  store: ArtifactStore,
  actor: ArtifactActor,
  roots: string[],
  known: ReadonlySet<string>,
): Promise<EmbedGraph> {
  const reach = await reachEmbeds(embedSource(store), actor, roots, known);
  return { ...reach, depth: EMBED_DEPTH, budget: EMBED_BUDGET };
}

/** The notes a run inlines from a Task, directly or through other notes, as the actor reads them. */
export async function snapshotTaskEmbeds(
  source: EmbedSource,
  actor: ArtifactActor,
  task: string,
): Promise<TaskEmbedSnapshot[]> {
  const items: TaskEmbedSnapshot[] = [];
  for (const href of await collectEmbedsDeep(source, actor, task)) {
    const note = collectionEmbed(href) ? null : await readEmbedNote(source, actor, href);
    if (note?.row) {
      items.push(noteSnapshot(href, note.row));
    }
  }
  return items;
}

function noteSnapshot(href: string, row: ArtifactRow): TaskEmbedSnapshot {
  return {
    display_path: href,
    version: Number(row.version),
    content_hash: String((row as { content_hash?: unknown }).content_hash ?? hashFromRow(row)),
    kind: String(row.kind),
  };
}

/** The collections a Task embeds that the actor can read, directly or through the notes it inlines, by display path. */
export async function snapshotTaskCollections(
  source: EmbedSource,
  actor: ArtifactActor,
  task: string,
): Promise<string[]> {
  const found: string[] = [];
  for (const href of await collectEmbedsDeep(source, actor, task)) {
    const collection = collectionEmbed(href);
    if (collection && (await readsEmbedCollection(source, actor, collection))) {
      found.push(href);
    }
  }
  return found;
}

function hashFromRow(row: Pick<ArtifactRow, "content_text" | "content_json">): string {
  const body = row.content_text ?? JSON.stringify(row.content_json ?? {});
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/**
 * The Task with its embeds inlined as the actor reads them: a note as an element holding its text,
 * a collection as its name, and anything else as the unreachable marker. Throws past the embed budget.
 */
export async function inlineTaskEmbeds(
  source: EmbedSource,
  actor: ArtifactActor,
  task: string,
): Promise<string> {
  const context: InlineContext = { source, actor, budget: { used: 0 }, memory: { seen: new Set(), titles: new Map() } };
  return expandEmbedLayer(context, task, EMBED_DEPTH);
}

async function expandEmbedLayer(context: InlineContext, text: string, depth: number): Promise<string> {
  const hrefs = depth < 1 ? [] : collectTaskEmbeds(text);
  if (!hrefs.length) {
    return text;
  }
  const { memory } = context;
  const blocks = new Map<string, string>();
  for (const href of hrefs.filter((item) => !memory.seen.has(item))) {
    memory.seen.add(href);
    blocks.set(href, await resolveEmbedBlock(context, href, depth));
  }
  const appeared = new Set<string>();
  return text.replace(EMBED_RE, (full, href: string) => {
    const path = href.trim();
    if (!appeared.has(path)) {
      appeared.add(path);
      return blocks.get(path) ?? memory.titles.get(path) ?? full;
    }
    return memory.titles.get(path) ?? path;
  });
}

async function resolveEmbedBlock(context: InlineContext, href: string, depth: number): Promise<string> {
  const collection = collectionEmbed(href);
  if (collection) {
    return resolveCollectionBlock(context, href, collection);
  }
  const note = await readEmbedNote(context.source, context.actor, href);
  return note.row ? noteBlock(context, { href, row: note.row }, depth) : unreachableMarker(href);
}

async function resolveCollectionBlock(
  context: InlineContext,
  href: string,
  collection: CollectionEmbed,
): Promise<string> {
  if (!(await readsEmbedCollection(context.source, context.actor, collection))) {
    return unreachableMarker(href);
  }
  context.memory.titles.set(href, collection.name);
  return collection.name;
}

async function noteBlock(context: InlineContext, note: LiveNote, depth: number): Promise<string> {
  const { href, row } = note;
  let body = row.content_text ?? "";
  context.budget.used += Buffer.byteLength(body, "utf8");
  if (context.budget.used > EMBED_BUDGET) {
    throw new ArtifactError("embed budget exceeded", 422);
  }
  context.memory.titles.set(href, row.title || row.key.replace(/\.md$/, ""));
  if (depth > 1) {
    body = await expandEmbedLayer(context, body, depth - 1);
  }
  const tag = embedTagName(row.key);
  return `<${tag} path="${escapeXml(href)}" level="${row.level}">\n${body.replace(/\s+$/, "")}\n</${tag}>`;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
