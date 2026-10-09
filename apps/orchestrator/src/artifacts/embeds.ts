import { createHash } from "node:crypto";
import { ArtifactError } from "./errors.js";
import { isDisplayPath, parseDisplayPath } from "./paths.js";
import { EMBED_BUDGET, type ArtifactActor } from "./types.js";
import type { ArtifactStore } from "./store.js";

const EMBED_RE = /!\[\[([^\]]+)\]\]/g;

// Element names an inlined note must not take: the prompt sections it sits
// inside, where a same-named nested element would be ambiguous.
const SECTION_NAMES = new Set(["guidelines", "task", "state", "memory"]);

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
  if (!/^[A-Za-z_]/.test(slug) || SECTION_NAMES.has(slug.toLowerCase())) {
    return `note-${slug}`;
  }
  return slug;
}

function collectionEmbed(href: string): { orgId: string; name: string } | null {
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

export const EMBED_DEPTH = 2;

type EmbedBudget = { used: number };
type EmbedMemory = { seen: Set<string>; titles: Map<string, string> };

async function collectEmbedsDeep(
  store: ArtifactStore,
  actor: ArtifactActor,
  text: string,
  depth: number,
  seen: Set<string> = new Set(),
): Promise<string[]> {
  const found: string[] = [];
  for (const href of collectTaskEmbeds(text)) {
    if (seen.has(href)) {
      continue;
    }
    seen.add(href);
    found.push(href);
    if (depth <= 1 || collectionEmbed(href) || !isDisplayPath(href)) {
      continue;
    }
    try {
      const loaded = await store.getByDisplayPath(actor, href);
      if (loaded.tombstone || loaded.revision || loaded.row?.kind !== "note") {
        continue;
      }
      const nested = await collectEmbedsDeep(
        store,
        actor,
        String(loaded.row.content_text ?? ""),
        depth - 1,
        seen,
      );
      found.push(...nested);
    } catch {
      continue;
    }
  }
  return found;
}

export type TaskEmbedInspection = {
  href: string;
  ok: boolean;
  reason?: string;
};

export async function inspectTaskEmbeds(
  store: ArtifactStore,
  actor: ArtifactActor,
  task: string,
): Promise<TaskEmbedInspection[]> {
  const items: TaskEmbedInspection[] = [];
  for (const href of await collectEmbedsDeep(store, actor, task, EMBED_DEPTH)) {
    if (!isDisplayPath(href)) {
      items.push({
        href,
        ok: false,
        reason: href.startsWith("recipe:")
          ? "recipe link was not rewritten to a file path"
          : "not a file path",
      });
      continue;
    }
    const collection = collectionEmbed(href);
    if (collection) {
      if (collection.orgId !== actor.orgId) {
        items.push({ href, ok: false, reason: "missing" });
        continue;
      }
      const described = await store.describeCollection(actor, collection.name);
      items.push(described ? { href, ok: true } : { href, ok: false, reason: "missing" });
      continue;
    }
    try {
      const loaded = await store.getByDisplayPath(actor, href);
      if (loaded.tombstone || loaded.revision || !loaded.row) {
        items.push({ href, ok: false, reason: "missing" });
        continue;
      }
      if (loaded.row.kind !== "note") {
        items.push({ href, ok: false, reason: "not a note" });
        continue;
      }
      items.push({ href, ok: true });
    } catch (error) {
      const message = error instanceof ArtifactError ? error.message : "missing";
      items.push({ href, ok: false, reason: message });
    }
  }
  return items;
}

export type TaskEmbedSnapshot = {
  display_path: string;
  version: number;
  content_hash: string;
  kind: string;
};

export async function snapshotTaskEmbeds(
  store: ArtifactStore,
  actor: ArtifactActor,
  task: string,
): Promise<TaskEmbedSnapshot[]> {
  const hrefs = await collectEmbedsDeep(store, actor, task, EMBED_DEPTH);
  const items: TaskEmbedSnapshot[] = [];
  for (const href of hrefs) {
    if (collectionEmbed(href)) {
      continue;
    }
    try {
      const loaded = await store.getByDisplayPath(actor, href);
      if (loaded.tombstone || loaded.revision || !loaded.row) {
        continue;
      }
      items.push({
        display_path: href,
        version: Number(loaded.row.version),
        content_hash: String((loaded.row as { content_hash?: unknown }).content_hash ?? hashFromRow(loaded.row)),
        kind: String(loaded.row.kind),
      });
    } catch {
      continue;
    }
  }
  return items;
}

function hashFromRow(row: { content_text?: string | null; content_json?: unknown }): string {
  const body = row.content_text ?? JSON.stringify(row.content_json ?? {});
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export async function inlineTaskEmbeds(
  store: ArtifactStore,
  actor: ArtifactActor,
  task: string,
): Promise<string> {
  return expandEmbedLayer(store, actor, task, EMBED_DEPTH, { used: 0 }, { seen: new Set(), titles: new Map() });
}

async function expandEmbedLayer(
  store: ArtifactStore,
  actor: ArtifactActor,
  text: string,
  depth: number,
  budget: EmbedBudget,
  memory: EmbedMemory,
): Promise<string> {
  if (depth < 1) {
    return text;
  }
  const hrefs = collectTaskEmbeds(text);
  if (!hrefs.length) {
    return text;
  }
  const blocks = new Map<string, string>();
  for (const href of hrefs) {
    if (memory.seen.has(href)) {
      continue;
    }
    memory.seen.add(href);
    blocks.set(href, await resolveEmbedBlock(store, actor, href, depth, budget, memory));
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

async function resolveEmbedBlock(
  store: ArtifactStore,
  actor: ArtifactActor,
  href: string,
  depth: number,
  budget: EmbedBudget,
  memory: EmbedMemory,
): Promise<string> {
  const collection = collectionEmbed(href);
  if (collection) {
    memory.titles.set(href, collection.name);
    return collection.name;
  }
  let loaded;
  try {
    loaded = await store.getByDisplayPath(actor, href);
  } catch (error) {
    if (error instanceof ArtifactError) {
      throw new ArtifactError(`embed failed: ${href} (${error.message})`, 422);
    }
    throw error;
  }
  if (loaded.tombstone || loaded.revision || !loaded.row) {
    throw new ArtifactError(`embed failed: ${href} (missing)`, 422);
  }
  if (loaded.row.kind !== "note") {
    throw new ArtifactError(`embed failed: ${href} (not a note)`, 422);
  }
  let body = loaded.row.content_text ?? "";
  budget.used += Buffer.byteLength(body, "utf8");
  if (budget.used > EMBED_BUDGET) {
    throw new ArtifactError("embed budget exceeded", 422);
  }
  const title = loaded.row.title || loaded.row.key.replace(/\.md$/, "");
  memory.titles.set(href, title);
  if (depth > 1) {
    body = await expandEmbedLayer(store, actor, body, depth - 1, budget, memory);
  }
  const tag = embedTagName(loaded.row.key);
  return `<${tag} path="${escapeXml(href)}" level="${loaded.row.level}">\n${body.replace(/\s+$/, "")}\n</${tag}>`;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
