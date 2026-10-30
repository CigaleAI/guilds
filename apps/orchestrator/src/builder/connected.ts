import { defaultSearchServer, isSearchable, storageHint } from "../connectors/builder.js";
import { getMcpServer, getMcpServerBySlug, listServers, type LoadedConnector } from "../connectors/servers.js";
import { McpError } from "../mcp/errors.js";
import { OPERATOR_CALLER, type McpPool } from "../mcp/pool.js";
import { callTool } from "../mcp/service.js";
import { listMcpConnections, listMcpTools, type McpConnectionRow, type McpToolRow } from "../db/mcp.js";
import { bindQuery, type BoundQuery, type Queryable } from "../db/pg.js";

const SEARCH_REMOTES = ["search", "notion-search", "Search"];
const MAX_HITS = 20;
const MAX_SNIPPET = 240;
const MAX_RAW = 4_000;

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
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

function inferKind(item: Record<string, unknown>): WorkspaceHit["kind"] {
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

function titleFromItem(item: Record<string, unknown>): string {
  const direct = firstString(item.title, item.name, item.Name);
  if (direct) {
    return direct;
  }
  const properties = asRecord(item.properties);
  const titleProp = properties ? asRecord(properties.title) || asRecord(properties.Name) : null;
  const titleArray = titleProp && Array.isArray(titleProp.title) ? titleProp.title : null;
  if (titleArray) {
    const parts = titleArray
      .map((part) => {
        const row = asRecord(part);
        return row ? firstString(row.plain_text, row.text && asRecord(row.text)?.content) : "";
      })
      .filter(Boolean);
    if (parts.length) {
      return parts.join("");
    }
  }
  return firstString(item.id, item.page_id, item.database_id) || "Untitled";
}

export function hitFromUnknown(value: unknown): WorkspaceHit | null {
  const item = asRecord(value);
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

function unwrapMcpPayload(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      const texts = parsed
        .map((part) => {
          const row = asRecord(part);
          return row && row.type === "text" ? firstString(row.text) : "";
        })
        .filter(Boolean);
      if (texts.length === 1) {
        try {
          return JSON.parse(texts[0] as string);
        } catch {
          return texts[0];
        }
      }
      if (texts.length) {
        return texts.join("\n");
      }
      return parsed;
    }
    const record = asRecord(parsed);
    if (record && Array.isArray(record.content)) {
      const texts = record.content
        .map((part) => {
          const row = asRecord(part);
          return row ? firstString(row.text) : "";
        })
        .filter(Boolean);
      if (texts.length === 1) {
        try {
          return JSON.parse(texts[0] as string);
        } catch {
          return texts[0];
        }
      }
      if (texts.length) {
        return texts.join("\n");
      }
    }
    return parsed;
  } catch {
    return trimmed;
  }
}

function collectCandidateArrays(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  const record = asRecord(value);
  if (!record) {
    return [];
  }
  for (const key of ["results", "hits", "databases", "pages", "items"]) {
    if (Array.isArray(record[key])) {
      return record[key] as unknown[];
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
  for (const item of collectCandidateArrays(payload)) {
    const hit = hitFromUnknown(item);
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
  const excerpt = typeof payload === "string" ? payload : raw;
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
    const message = error instanceof McpError || error instanceof Error ? error.message : "search failed";
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
