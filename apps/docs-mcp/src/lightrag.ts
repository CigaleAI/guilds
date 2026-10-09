import type { DocsMcpConfig } from "./config.js";

export type SearchMode = "mix" | "hybrid" | "local" | "global" | "naive";

export type SearchParams = {
  query: string;
  mode: SearchMode;
  topK: number;
  chunkTopK: number;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function lightragFetch(
  config: DocsMcpConfig,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.apiKey) {
    headers["X-API-Key"] = config.apiKey;
  }
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const request: RequestInit = {
      method: init.method ?? "GET",
      headers,
      signal: controller.signal,
    };
    if (init.body !== undefined) {
      request.body = JSON.stringify(init.body);
    }
    const response = await fetch(`${config.baseUrl}${path}`, request);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`LightRAG ${path} HTTP ${response.status}: ${text.slice(0, 800)}`);
    }
    if (text === "") {
      return {};
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`LightRAG ${path} returned non-JSON`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function line(label: string, value: unknown): string | undefined {
  const text = asString(value);
  if (!text) {
    return undefined;
  }
  return `${label}: ${text}`;
}

function formatEntity(raw: unknown, index: number): string {
  if (typeof raw === "string") {
    return `${index}. ${raw}`;
  }
  if (!isRecord(raw)) {
    return `${index}. ${JSON.stringify(raw)}`;
  }
  const name =
    asString(raw.entity_name) ?? asString(raw.entity_id) ?? asString(raw.name) ?? `entity ${index}`;
  const kind = asString(raw.entity_type) ?? asString(raw.type);
  const description = asString(raw.description);
  const filePath = asString(raw.file_path) ?? asString(raw.source_id);
  const parts = [`${index}. ${name}`];
  if (kind) {
    parts[0] = `${index}. ${name} (${kind})`;
  }
  if (description) {
    parts.push(description);
  }
  if (filePath) {
    parts.push(`source: ${filePath}`);
  }
  return parts.join("\n   ");
}

function formatRelation(raw: unknown, index: number): string {
  if (!isRecord(raw)) {
    return `${index}. ${JSON.stringify(raw)}`;
  }
  const src = asString(raw.src_id) ?? asString(raw.source) ?? asString(raw.src) ?? "?";
  const tgt = asString(raw.tgt_id) ?? asString(raw.target) ?? asString(raw.tgt) ?? "?";
  const description = asString(raw.description) ?? asString(raw.keywords);
  const weight = asNumber(raw.weight);
  const head = `${index}. ${src} → ${tgt}`;
  const extra = [
    description,
    weight === undefined ? undefined : `weight ${weight}`,
  ].filter((part): part is string => part !== undefined);
  if (extra.length === 0) {
    return head;
  }
  return `${head}\n   ${extra.join(" · ")}`;
}

export function chapterPreviewUrl(
  filePath: string,
  previewBase = process.env.DOCS_PREVIEW_URL ?? "http://127.0.0.1:9622",
): string {
  const relative = filePath
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)?docs\//, "")
    .replace(/^\/+/, "");
  return `${previewBase.replace(/\/$/, "")}/#${encodeURIComponent(relative)}`;
}

function formatChunk(raw: unknown, index: number): string {
  if (typeof raw === "string") {
    return `${index}. ${raw}`;
  }
  if (!isRecord(raw)) {
    return `${index}. ${JSON.stringify(raw)}`;
  }
  const filePath = asString(raw.file_path) ?? asString(raw.source) ?? "unknown file";
  const content = asString(raw.content) ?? asString(raw.text) ?? "";
  const clipped = content.length > 1200 ? `${content.slice(0, 1200)}…` : content;
  return `${index}. ${filePath}\n   ${chapterPreviewUrl(filePath)}\n${clipped}`;
}

function formatNode(raw: unknown, index: number): string {
  if (!isRecord(raw)) {
    return `${index}. ${JSON.stringify(raw)}`;
  }
  const props = isRecord(raw.properties) ? raw.properties : raw;
  const id = asString(raw.id) ?? asString(props.entity_id) ?? asString(props.entity_name) ?? `node ${index}`;
  const kind = asString(props.entity_type) ?? asString(props.type);
  const description = asString(props.description);
  const head = kind ? `${index}. ${id} (${kind})` : `${index}. ${id}`;
  return description ? `${head}\n   ${description}` : head;
}

function formatEdge(raw: unknown, index: number): string {
  if (!isRecord(raw)) {
    return `${index}. ${JSON.stringify(raw)}`;
  }
  const props = isRecord(raw.properties) ? raw.properties : {};
  const src = asString(raw.source) ?? asString(raw.src) ?? asString(props.src_id) ?? "?";
  const tgt = asString(raw.target) ?? asString(raw.tgt) ?? asString(props.tgt_id) ?? "?";
  const description = asString(props.description) ?? asString(props.keywords);
  const head = `${index}. ${src} → ${tgt}`;
  return description ? `${head}\n   ${description}` : head;
}

export function formatSearchResult(payload: unknown): string {
  if (!isRecord(payload)) {
    return JSON.stringify(payload, null, 2);
  }
  const data = isRecord(payload.data) ? payload.data : payload;
  const entities = Array.isArray(data.entities) ? data.entities.slice(0, 24) : [];
  const relations = Array.isArray(data.relationships)
    ? data.relationships.slice(0, 24)
    : Array.isArray(data.relations)
      ? data.relations.slice(0, 24)
      : [];
  const chunks = Array.isArray(data.chunks) ? data.chunks.slice(0, 12) : [];
  const references = Array.isArray(data.references) ? data.references.slice(0, 12) : [];
  const sections: string[] = [];
  const status = line("status", payload.status);
  const message = line("message", payload.message);
  if (status) {
    sections.push(status);
  }
  if (message) {
    sections.push(message);
  }
  if (entities.length > 0) {
    sections.push(`## Entities\n${entities.map((item, i) => formatEntity(item, i + 1)).join("\n")}`);
  }
  if (relations.length > 0) {
    sections.push(`## Relations\n${relations.map((item, i) => formatRelation(item, i + 1)).join("\n")}`);
  }
  if (chunks.length > 0) {
    sections.push(`## Chunks\n${chunks.map((item, i) => formatChunk(item, i + 1)).join("\n\n")}`);
  }
  if (references.length > 0 && chunks.length === 0) {
    sections.push(
      `## References\n${references
        .map((item, i) => {
          if (!isRecord(item)) {
            return `${i + 1}. ${JSON.stringify(item)}`;
          }
          return `${i + 1}. ${asString(item.file_path) ?? JSON.stringify(item)}`;
        })
        .join("\n")}`,
    );
  }
  if (sections.length === 0) {
    return JSON.stringify(payload, null, 2);
  }
  return sections.join("\n\n");
}

export function formatGraphResult(payload: unknown): string {
  if (!isRecord(payload)) {
    return JSON.stringify(payload, null, 2);
  }
  const nodes = Array.isArray(payload.nodes) ? payload.nodes.slice(0, 40) : [];
  const edges = Array.isArray(payload.edges) ? payload.edges.slice(0, 40) : [];
  const truncated = payload.is_truncated === true;
  const sections = [
    truncated ? "truncated: true" : undefined,
    nodes.length > 0 ? `## Nodes\n${nodes.map((item, i) => formatNode(item, i + 1)).join("\n")}` : undefined,
    edges.length > 0 ? `## Edges\n${edges.map((item, i) => formatEdge(item, i + 1)).join("\n")}` : undefined,
  ].filter((part): part is string => part !== undefined);
  if (sections.length === 0) {
    return JSON.stringify(payload, null, 2);
  }
  return sections.join("\n\n");
}

export function formatLabels(payload: unknown): string {
  const labels = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.labels)
      ? payload.labels
      : null;
  if (!labels) {
    return JSON.stringify(payload, null, 2);
  }
  if (labels.length === 0) {
    return "No matching entity labels.";
  }
  return labels
    .slice(0, 40)
    .map((label, i) => `${i + 1}. ${typeof label === "string" ? label : JSON.stringify(label)}`)
    .join("\n");
}

export async function searchDocs(config: DocsMcpConfig, params: SearchParams): Promise<string> {
  const payload = await lightragFetch(config, "/query/data", {
    method: "POST",
    body: {
      query: params.query,
      mode: params.mode,
      top_k: params.topK,
      chunk_top_k: params.chunkTopK,
      enable_rerank: false,
      include_references: true,
      include_chunk_content: true,
    },
  });
  return formatSearchResult(payload);
}

export async function entityGraph(
  config: DocsMcpConfig,
  label: string,
  maxDepth: number,
  maxNodes: number,
): Promise<string> {
  const query = new URLSearchParams({
    label,
    max_depth: String(maxDepth),
    max_nodes: String(maxNodes),
  });
  const payload = await lightragFetch(config, `/graphs?${query.toString()}`);
  return formatGraphResult(payload);
}

export async function searchLabels(config: DocsMcpConfig, query: string, limit: number): Promise<string> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const payload = await lightragFetch(config, `/graph/label/search?${params.toString()}`);
  return formatLabels(payload);
}
