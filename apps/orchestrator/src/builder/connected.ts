import { Type, type Static } from "@sinclair/typebox";
import { defaultSearchServer, isSearchable, storageHint } from "../connectors/builder.js";
import { getMcpServer, getMcpServerBySlug, listServers, type LoadedConnector } from "../connectors/servers.js";
import { OPERATOR_CALLER, type McpPool } from "../mcp/pool.js";
import { callTool } from "../mcp/service.js";
import { listMcpConnections, listMcpTools, type McpConnectionRow, type McpToolRow } from "../db/mcp.js";
import { bindQuery, type BoundQuery, type Queryable } from "../db/pg.js";
import { keepMatching } from "../lib/decode.js";
import { isJsonValue, isObjectNode, type JsonValue } from "../lib/json.js";
import { isText } from "../toolbox/schema.js";

const SEARCH_REMOTES = ["search", "notion-search", "Search"];
const MAX_HITS = 20;
const MAX_SNIPPET = 240;
const MAX_RAW = 4_000;

/** The fields of a search tool's answer that hold its hits, in the order they are looked for. */
const HIT_LISTS = ["results", "hits", "databases", "pages", "items"] as const;

/** A text part of a search tool's answer, as an MCP content list holds it: its kind and its text. */
const TextPart = Type.Object({ type: Type.Optional(Type.String()), text: Type.String() });

/** A run of a Notion title property: its plain text, or the content of its text. */
const TitleRun = Type.Object({
  plain_text: Type.Optional(Type.String()),
  text: Type.Optional(Type.Object({ content: Type.Optional(Type.String()) })),
});

/** A Notion title property: the runs of its text. */
const TitleProperty = Type.Object({ title: Type.Array(TitleRun) });

/**
 * A page, database or record a workspace search names, as its connector writes it: the fields a
 * hit is read from, each kept only when it is text (or, for `properties`, a Notion title property).
 */
const WorkspaceItem = Type.Object({
  id: Type.Optional(Type.String()),
  page_id: Type.Optional(Type.String()),
  database_id: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  public_url: Type.Optional(Type.String()),
  object: Type.Optional(Type.String()),
  type: Type.Optional(Type.String()),
  kind: Type.Optional(Type.String()),
  resource: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  Name: Type.Optional(Type.String()),
  snippet: Type.Optional(Type.String()),
  highlight: Type.Optional(Type.String()),
  text: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  caption: Type.Optional(Type.String()),
  properties: Type.Optional(
    Type.Object({ title: Type.Optional(TitleProperty), Name: Type.Optional(TitleProperty) }),
  ),
});
type WorkspaceItem = Static<typeof WorkspaceItem>;

/** The pool the Builder searches a connected workspace through. */
export type BuilderMcpClient = Pick<McpPool, "call" | "database">;

/** The db/ functions the Builder's connected-workspace tools read through. */
export type ConnectedDatabase = {
  getMcpServer: BoundQuery<typeof getMcpServer>;
  getMcpServerBySlug: BoundQuery<typeof getMcpServerBySlug>;
  listServers: BoundQuery<typeof listServers>;
  listMcpConnections: BoundQuery<typeof listMcpConnections>;
  listMcpTools: BoundQuery<typeof listMcpTools>;
};

/** The services a connected-workspace search reads and calls through. */
export type ConnectedWorkspaceDeps = {
  db: ConnectedDatabase;
  /** The pool the search tool is called through; the search is unavailable when null. */
  mcp: BuilderMcpClient | null;
};

/** The db/ functions the Builder's connected-workspace tools read through, on `db`. */
export function connectedDatabase(db: Queryable): ConnectedDatabase {
  return {
    getMcpServer: bindQuery(db, getMcpServer),
    getMcpServerBySlug: bindQuery(db, getMcpServerBySlug),
    listServers: bindQuery(db, listServers),
    listMcpConnections: bindQuery(db, listMcpConnections),
    listMcpTools: bindQuery(db, listMcpTools),
  };
}

export type WorkspaceHit = {
  kind: "database" | "page" | "other";
  id: string;
  title: string;
  url: string;
  snippet: string;
};

export type ConnectedSearchResult = {
  server: string;
  display_name: string;
  connected: boolean;
  scope?: string;
  query: string;
  hits: WorkspaceHit[];
  databases: WorkspaceHit[];
  storage_hint: string;
  error?: string;
  recommended_widget?: string;
  raw_excerpt?: string;
};

/** The enabled server an organisation sees by id or slug: the platform's, or its own. */
export async function resolvePublishedServer(
  db: ConnectedDatabase,
  serverRef: string,
  orgId: string,
): Promise<LoadedConnector | null> {
  const trimmed = serverRef.trim();
  if (!trimmed) {
    return null;
  }
  const byId = await db.getMcpServer(trimmed);
  const row = byId && (!byId.owner_org_id || byId.owner_org_id === orgId) ? byId : await db.getMcpServerBySlug(trimmed, orgId);
  if (!row || row.enabled === false) {
    return null;
  }
  return row;
}

export async function findReusableOrgConnection(
  db: ConnectedDatabase,
  orgId: string,
  server: LoadedConnector,
): Promise<McpConnectionRow | null> {
  const connections = await db.listMcpConnections({ orgId });
  return (
    connections.find(
      (row) =>
        String(row.mcp_server_id) === server.id &&
        row.status === "connected" &&
        (row.owner_scope === "org" || row.owner_scope === "platform"),
    ) ?? null
  );
}

export function pickSearchRemote(tools: Array<Pick<McpToolRow, "remote_name">>): string {
  const names = tools.map((tool) => tool.remote_name);
  for (const candidate of SEARCH_REMOTES) {
    if (names.includes(candidate)) {
      return candidate;
    }
  }
  return names.find((name) => /search/i.test(name)) || "search";
}

/** The first of `values` that holds more than whitespace, trimmed; empty when none does. */
function firstString(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return "";
}

function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1)}…`;
}

function inferKind(item: WorkspaceItem): WorkspaceHit["kind"] {
  const token = firstString(item.object, item.type, item.kind, item.resource).toLowerCase();
  if (token.includes("database") || token === "data_source") {
    return "database";
  }
  if (token.includes("page")) {
    return "page";
  }
  const url = firstString(item.url, item.public_url).toLowerCase();
  if (url.includes("notion.so") && (url.includes("?v=") || token.includes("collection"))) {
    return "database";
  }
  return token ? "other" : "page";
}

function titleFromItem(item: WorkspaceItem): string {
  const direct = firstString(item.title, item.name, item.Name);
  if (direct) {
    return direct;
  }
  const runs = (item.properties?.title ?? item.properties?.Name)?.title ?? [];
  const title = runs.map((run) => firstString(run.plain_text, run.text?.content)).join("");
  if (title) {
    return title;
  }
  return firstString(item.id, item.page_id, item.database_id) || "Untitled";
}

/** The hit a search tool's answer names in `value`; null when it is not an object or names no id or url. */
export function hitOf(value: JsonValue): WorkspaceHit | null {
  const item = isObjectNode(value) ? keepMatching(WorkspaceItem, value) : null;
  if (!item) {
    return null;
  }
  const id = firstString(item.id, item.page_id, item.database_id, item.url, item.public_url);
  if (!id) {
    return null;
  }
  return {
    kind: inferKind(item),
    id,
    title: titleFromItem(item),
    url: firstString(item.url, item.public_url),
    snippet: clip(firstString(item.snippet, item.highlight, item.text, item.description, item.caption), MAX_SNIPPET),
  };
}

/** The JSON `text` holds, or `text` itself when it is not JSON. */
function jsonOrText(text: string): JsonValue {
  try {
    const parsed: unknown = JSON.parse(text);
    return isJsonValue(parsed) ? parsed : text;
  } catch {
    return text;
  }
}

/** The text of each of `parts` that is a text part holding more than whitespace; `kind` names the part type a part must state, when it must. */
function partTexts(parts: JsonValue[], kind: string | null): string[] {
  return parts.flatMap((item) => {
    const part = isObjectNode(item) ? keepMatching(TextPart, item) : null;
    const text = part && (kind === null || part.type === kind) ? part.text.trim() : "";
    return text ? [text] : [];
  });
}

/** What the text parts of a tool result carry: a single part's JSON (or its text), the parts joined, or `fallback` when there are none. */
function payloadOfTexts(texts: string[], fallback: JsonValue): JsonValue {
  const [only, ...rest] = texts;
  if (only === undefined) {
    return fallback;
  }
  if (rest.length) {
    return texts.join("\n");
  }
  return jsonOrText(only);
}

/** What a search tool answered in `raw`: the JSON its text parts carry, or the JSON or text `raw` holds. */
function unwrapMcpPayload(raw: string): JsonValue {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const parsed = jsonOrText(trimmed);
  if (Array.isArray(parsed)) {
    return payloadOfTexts(partTexts(parsed, "text"), parsed);
  }
  const content = isObjectNode(parsed) ? parsed.content : undefined;
  if (Array.isArray(content)) {
    return payloadOfTexts(partTexts(content, null), parsed);
  }
  return parsed;
}

/** The entries of the list `value` names its hits in: `value` itself when it is a list, else its first list of hits. */
function candidateItems(value: JsonValue): JsonValue[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isObjectNode(value)) {
    return [];
  }
  for (const key of HIT_LISTS) {
    const candidates = value[key];
    if (Array.isArray(candidates)) {
      return candidates;
    }
  }
  return [];
}

/** The hits a search tool's result names, or an excerpt of the result when it names none. */
export type WorkspaceHits = { hits: WorkspaceHit[]; raw_excerpt?: string };

export function parseWorkspaceHits(raw: string): WorkspaceHits {
  const payload = unwrapMcpPayload(raw);
  const hits: WorkspaceHit[] = [];
  const seen = new Set<string>();
  for (const item of candidateItems(payload)) {
    const hit = hitOf(item);
    if (!hit || seen.has(hit.id)) {
      continue;
    }
    seen.add(hit.id);
    hits.push(hit);
    if (hits.length >= MAX_HITS) {
      break;
    }
  }
  if (hits.length) {
    return { hits };
  }
  const excerpt = isText(payload) ? payload : raw;
  return {
    hits: [],
    raw_excerpt: clip(excerpt, MAX_RAW),
  };
}

/** Searches `orgId`'s connected workspace `serverRef` (the default searchable one when blank) for `phrase`. */
export async function searchConnectedWorkspace(
  deps: ConnectedWorkspaceDeps,
  orgId: string,
  serverRef: string,
  phrase: string,
): Promise<ConnectedSearchResult> {
  const ref = serverRef.trim() || defaultSearchServer();
  const query = phrase.trim();
  const hint = isSearchable(ref)
    ? storageHint()
    : "Prefer local notes and collections unless this connector is the operator's durable system of record.";
  const server = await resolvePublishedServer(deps.db, ref, orgId);
  if (!server) {
    return {
      server: ref,
      display_name: ref,
      connected: false,
      query,
      hits: [],
      databases: [],
      storage_hint: hint,
      error: "unknown or unpublished connector",
    };
  }
  const slug = server.slug;
  const displayName = String(server.display_name || slug);
  const connection = await findReusableOrgConnection(deps.db, orgId, server);
  if (!connection) {
    return {
      server: slug,
      display_name: displayName,
      connected: false,
      query,
      hits: [],
      databases: [],
      storage_hint: hint,
      error: "not_connected",
      recommended_widget: "builder_ask_org_connection",
    };
  }
  if (!deps.mcp) {
    return {
      server: slug,
      display_name: displayName,
      connected: true,
      scope: connection.owner_scope,
      query,
      hits: [],
      databases: [],
      storage_hint: hint,
      error: "connected workspace search is unavailable",
    };
  }
  const tools = await deps.db.listMcpTools(connection.id);
  const remoteName = pickSearchRemote(tools);
  try {
    const raw = await callTool(deps.mcp, {
      connectionId: connection.id,
      tool: remoteName,
      arguments: query ? { query } : {},
      caller: OPERATOR_CALLER,
    });
    const parsed = parseWorkspaceHits(raw);
    const databases = parsed.hits.filter((hit) => hit.kind === "database");
    return {
      server: slug,
      display_name: displayName,
      connected: true,
      scope: connection.owner_scope,
      query,
      hits: parsed.hits,
      databases,
      storage_hint: hint,
      ...(parsed.raw_excerpt ? { raw_excerpt: parsed.raw_excerpt } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "search failed";
    return {
      server: slug,
      display_name: displayName,
      connected: true,
      scope: connection.owner_scope,
      query,
      hits: [],
      databases: [],
      storage_hint: hint,
      error: message,
    };
  }
}
