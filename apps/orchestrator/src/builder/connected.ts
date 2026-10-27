import type pg from "pg";
import { defaultSearchServer, isSearchable, storageHint } from "../connectors/builder.js";
import { type McpDatabase, mcpDatabase, McpError } from "../mcp/index.js";
import { getMcpServer, getMcpServerBySlug } from "../db/connectors.js";
import { bindQuery } from "../db/pg.js";


const SEARCH_REMOTES = ["search", "notion-search", "Search"];
const MAX_HITS = 20;
const MAX_SNIPPET = 240;
const MAX_RAW = 4_000;

export type BuilderMcpClient = {
  call(
    db: McpDatabase,
    connection: Record<string, unknown>,
    server: Record<string, unknown>,
    remoteName: string,
    arguments_: Record<string, unknown>,
  ): Promise<string>;
};

/** The db/ functions the Builder's connected-workspace tools read and call through, on `db`. */
export function connectedDatabase(db: pg.Pool) {
  return {
    ...mcpDatabase(db),
    getMcpServer: bindQuery(db, getMcpServer),
    getMcpServerBySlug: bindQuery(db, getMcpServerBySlug),
  };
}

export type ConnectedDatabase = ReturnType<typeof connectedDatabase>;

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
): Promise<Record<string, unknown> | null> {
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
  server: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const connections = await db.listMcpConnections({ orgId });
  return (
    connections.find(
      (row) =>
        String(row.mcp_server_id) === String(server.id) &&
        row.status === "connected" &&
        (row.owner_scope === "org" || row.owner_scope === "platform"),
    ) ?? null
  );
}

export function pickSearchRemote(tools: Array<Record<string, unknown>>): string {
  const names = tools.map((tool) => String(tool.remote_name || ""));
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

export function parseWorkspaceHits(raw: string): { hits: WorkspaceHit[]; raw_excerpt?: string } {
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

export async function searchConnectedWorkspace(args: {
  db: ConnectedDatabase;
  mcp?: BuilderMcpClient | null | undefined;
  orgId: string;
  serverRef: string;
  query: string;
}): Promise<ConnectedSearchResult> {
  const serverRef = args.serverRef.trim() || defaultSearchServer();
  const query = args.query.trim();
  const hint = isSearchable(serverRef)
    ? storageHint()
    : "Prefer local notes and collections unless this connector is the operator's durable system of record.";
  const server = await resolvePublishedServer(args.db, serverRef, args.orgId);
  if (!server) {
    return {
      server: serverRef,
      display_name: serverRef,
      connected: false,
      query,
      hits: [],
      databases: [],
      storage_hint: hint,
      error: "unknown or unpublished connector",
    };
  }
  const slug = String(server.slug);
  const displayName = String(server.display_name || slug);
  const connection = await findReusableOrgConnection(args.db, args.orgId, server);
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
  if (!args.mcp) {
    return {
      server: slug,
      display_name: displayName,
      connected: true,
      scope: String(connection.owner_scope),
      query,
      hits: [],
      databases: [],
      storage_hint: hint,
      error: "connected workspace search is unavailable",
    };
  }
  const tools = await args.db.listMcpTools(String(connection.id));
  const remoteName = pickSearchRemote(tools);
  try {
    const raw = await args.mcp.call(args.db, connection, server, remoteName, query ? { query } : {});
    const parsed = parseWorkspaceHits(raw);
    const databases = parsed.hits.filter((hit) => hit.kind === "database");
    return {
      server: slug,
      display_name: displayName,
      connected: true,
      scope: String(connection.owner_scope),
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
      scope: String(connection.owner_scope),
      query,
      hits: [],
      databases: [],
      storage_hint: hint,
      error: message,
    };
  }
}
