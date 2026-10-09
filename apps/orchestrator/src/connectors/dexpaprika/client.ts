import { proxyFetch, withQuery, type FetchFn } from "../../net/http.js";
import {
  LIST_DEFAULT,
  argStr,
  clipRows,
  downsample,
  fmtNum,
  joinParts,
  rowLimit,
} from "../format.js";

export const API_BASE = "https://api.dexpaprika.com";
export const PRO_BASE = "https://api-pro.dexpaprika.com";
export const PRICES_MAX = 10;
export const CHART_POINTS = 48;
export const NETWORK_HINT = "DexPaprika network id, e.g. ethereum, solana, base.";
export const OHLCV_INTERVALS = ["1m", "5m", "10m", "15m", "30m", "1h", "6h", "12h", "24h"] as const;
export const POOL_ORDER = [
  "volume_usd_24h",
  "volume_usd_7d",
  "volume_usd_30d",
  "liquidity_usd",
  "txns_24h",
  "price_usd",
  "created_at",
] as const;

export class DexPaprikaError extends Error {
  status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "DexPaprikaError";
    this.status = status;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asRows(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is Record<string, unknown> => Boolean(asObject(item)));
}

function field(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") {
      return row[key];
    }
  }
  return undefined;
}

function pct(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  const number = fmtNum(value);
  if (number === "-") {
    return number;
  }
  if (number.startsWith("-") || number.startsWith("+")) {
    return `${number}%`;
  }
  return `+${number}%`;
}

function pair(row: Record<string, unknown>): string {
  const tokens = asRows(row.tokens);
  const symbols = tokens
    .map((token) => String(token.symbol ?? "").trim())
    .filter(Boolean);
  if (symbols.length >= 2) {
    return symbols.slice(0, 2).join("/");
  }
  const named = String(row.pool_name ?? row.name ?? "").trim();
  return named;
}

function section(title: string, rows: string[], limit: number): string {
  const body = clipRows(rows.filter(Boolean), limit);
  if (body === "no results") {
    return "";
  }
  return `${title}\n${body}`;
}

function pageNote(payload: Record<string, unknown>): string {
  const cursor =
    (typeof payload.next_cursor === "string" && payload.next_cursor.trim())
    || (asObject(payload.page_info)?.next_cursor);
  if (typeof cursor === "string" && cursor.trim()) {
    return `page=${cursor.trim()}`;
  }
  return "";
}

function poolRows(payload: unknown): Array<Record<string, unknown>> {
  const object = asObject(payload);
  if (object) {
    const nested = object.results ?? object.pools;
    if (Array.isArray(nested)) {
      return asRows(nested);
    }
  }
  return asRows(payload);
}

export function formatSearch(payload: Record<string, unknown>, limit = LIST_DEFAULT): string {
  const blocks: string[] = [];
  const tokens = asRows(payload.tokens);
  if (tokens.length) {
    blocks.push(
      section(
        "tokens",
        tokens.map((row) =>
          joinParts(row.chain, row.id, row.symbol, row.name, `p=${fmtNum(row.price_usd)}`),
        ),
        limit,
      ),
    );
  }
  const pools = asRows(payload.pools);
  if (pools.length) {
    blocks.push(
      section(
        "pools",
        pools.map((row) =>
          joinParts(
            row.chain,
            row.id,
            row.dex_name ?? row.dex_id,
            pair(row),
            `vol=${fmtNum(field(row, "volume_usd_24h", "volume_usd"))}`,
          ),
        ),
        limit,
      ),
    );
  }
  const dexes = asRows(payload.dexes);
  if (dexes.length) {
    blocks.push(
      section(
        "dexes",
        dexes.map((row) =>
          joinParts(
            row.chain,
            row.dex_id ?? row.id,
            row.dex_name,
            `vol=${fmtNum(row.volume_usd_24h)}`,
          ),
        ),
        limit,
      ),
    );
  }
  const shown = blocks.filter(Boolean);
  return shown.length ? shown.join("\n\n") : "no results";
}

export function formatToken(payload: Record<string, unknown>): string {
  if (!Object.keys(payload).length) {
    return "no results";
  }
  const summary = asObject(payload.summary) ?? {};
  const day = asObject(summary["24h"]) ?? {};
  const head = joinParts(payload.chain ?? summary.chain, payload.id, payload.symbol, payload.name);
  const stats = joinParts(
    `p=${fmtNum(summary.price_usd)}`,
    `liq=${fmtNum(summary.liquidity_usd)}`,
    `fdv=${fmtNum(summary.fdv)}`,
    `vol_24h=${fmtNum(day.volume_usd)}`,
    `chg_24h=${pct(day.last_price_usd_change)}`,
    `pools=${fmtNum(summary.pools)}`,
  );
  return [head, stats].filter(Boolean).join("\n") || "no results";
}

export function formatPrices(payload: unknown): string {
  const rows = asRows(payload).map((row) =>
    joinParts(row.chain, row.id, `p=${fmtNum(row.price_usd)}`),
  );
  return rows.length ? rows.join("\n") : "no results";
}

export function formatPool(payload: Record<string, unknown>): string {
  if (!Object.keys(payload).length) {
    return "no results";
  }
  const head = joinParts(
    payload.chain,
    payload.id,
    payload.dex_name ?? payload.dex_id,
    pair(payload),
  );
  const stats = joinParts(
    `p=${fmtNum(field(payload, "price_usd"))}`,
    `liq=${fmtNum(field(payload, "liquidity_usd"))}`,
    `vol_24h=${fmtNum(field(payload, "volume_usd_24h", "volume_usd"))}`,
    `chg_24h=${pct(field(payload, "last_price_change_usd_24h", "price_change_percentage_24h"))}`,
    `tx_24h=${fmtNum(field(payload, "txns_24h", "transactions"))}`,
  );
  return [head, stats].filter(Boolean).join("\n") || "no results";
}

export function formatPools(payload: unknown, limit = LIST_DEFAULT): string {
  const object = asObject(payload) ?? {};
  const rows = poolRows(payload).map((row) =>
    joinParts(
      row.chain,
      row.id,
      row.dex_name ?? row.dex_id,
      pair(row),
      `p=${fmtNum(field(row, "price_usd"))}`,
      `liq=${fmtNum(field(row, "liquidity_usd"))}`,
      `vol=${fmtNum(field(row, "volume_usd_24h", "volume_usd"))}`,
    ),
  );
  const body = clipRows(rows, limit);
  if (body === "no results") {
    return body;
  }
  return [body, pageNote(object)].filter(Boolean).join("\n");
}

export function formatOhlcv(payload: unknown, title: string): string {
  const points = asRows(payload);
  const rows: string[] = [];
  for (const point of downsample(points, CHART_POINTS)) {
    rows.push(
      joinParts(
        point.time_open ?? point.time_close,
        fmtNum(point.open),
        fmtNum(point.high),
        fmtNum(point.low),
        fmtNum(point.close),
        fmtNum(point.volume),
      ),
    );
  }
  const header = `${title} ohlc n=${rows.length}`;
  return rows.length ? [header, "t  o  h  l  c  v", ...rows].join("\n") : `${header}\nno results`;
}

export function formatSwaps(payload: unknown, limit = LIST_DEFAULT): string {
  const object = asObject(payload) ?? {};
  const items = asRows(object.transactions ?? payload);
  const rows = items.map((row) =>
    joinParts(
      row.created_at,
      row.id,
      row.token_0_symbol,
      fmtNum(row.amount_0),
      row.token_1_symbol,
      fmtNum(row.amount_1),
      `p0=${fmtNum(row.price_0_usd)}`,
    ),
  );
  const body = clipRows(rows, limit);
  if (body === "no results") {
    return body;
  }
  return [body, pageNote(object)].filter(Boolean).join("\n");
}

async function errorDetail(response: Response): Promise<string> {
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    const stripped = text.trim();
    return stripped || `DexPaprika HTTP ${response.status}`;
  }
  const object = asObject(payload);
  if (object) {
    const detail = object.message ?? object.error;
    if (typeof detail === "string" && detail.trim()) {
      return detail.trim();
    }
  }
  return `DexPaprika HTTP ${response.status}`;
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: apiKey, Accept: "application/json" };
}

async function getJson(
  path: string,
  params: Record<string, string>,
  apiKey: string,
  options: { client?: FetchFn; proxyUrl?: string } = {},
): Promise<unknown> {
  const key = apiKey.trim();
  if (!key) {
    throw new DexPaprikaError("DexPaprika API key is missing", 401);
  }
  const fetchFn = options.client ?? proxyFetch(options.proxyUrl ?? "");
  const headers = authHeaders(key);
  const request = async (base: string) =>
    fetchFn(withQuery(`${base}${path}`, params), { method: "GET", headers });
  let response = await request(API_BASE);
  if (response.status === 403) {
    response = await request(PRO_BASE);
  }
  if (response.status >= 400) {
    throw new DexPaprikaError(await errorDetail(response), response.status);
  }
  try {
    return JSON.parse(await response.text());
  } catch {
    throw new DexPaprikaError("DexPaprika returned a non-JSON body");
  }
}

function requireNetwork(arguments_: Record<string, unknown>): string {
  const network = argStr(arguments_, "network").toLowerCase();
  if (!network) {
    throw new DexPaprikaError("network is required");
  }
  return network;
}

function requireAddress(arguments_: Record<string, unknown>, key = "address"): string {
  const address = argStr(arguments_, key);
  if (!address) {
    throw new DexPaprikaError(`${key} is required`);
  }
  return address;
}

export async function ping(
  apiKey: string,
  options: { client?: FetchFn; proxyUrl?: string } = {},
): Promise<void> {
  const payload = await getJson("/usage", {}, apiKey, options);
  const object = asObject(payload);
  const plan = typeof object?.plan === "string" ? object.plan.trim().toLowerCase() : "";
  if (!plan || plan === "keyless") {
    throw new DexPaprikaError("api key was rejected", 401);
  }
}

export async function searchTool(
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const query = argStr(arguments_, "query");
  if (!query) {
    throw new DexPaprikaError("query is required");
  }
  const payload = await getJson("/search", { query }, options.apiKey, options);
  const object = asObject(payload);
  if (!object) {
    throw new DexPaprikaError("DexPaprika returned a non-object");
  }
  return formatSearch(object, rowLimit(arguments_));
}

export async function tokenTool(
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const network = requireNetwork(arguments_);
  const address = requireAddress(arguments_);
  const payload = await getJson(`/networks/${network}/tokens/${address}`, {}, options.apiKey, options);
  const object = asObject(payload);
  if (!object) {
    throw new DexPaprikaError("DexPaprika returned a non-object");
  }
  return formatToken(object);
}

export async function pricesTool(
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const network = requireNetwork(arguments_);
  const tokens = [
    ...new Set(
      argStr(arguments_, "tokens")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ];
  if (!tokens.length) {
    throw new DexPaprikaError("tokens is required");
  }
  if (tokens.length > PRICES_MAX) {
    throw new DexPaprikaError(`tokens must list at most ${PRICES_MAX} addresses`);
  }
  return formatPrices(
    await getJson(`/networks/${network}/multi/prices`, { tokens: tokens.join(",") }, options.apiKey, options),
  );
}

export async function poolTool(
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const network = requireNetwork(arguments_);
  const address = requireAddress(arguments_);
  const payload = await getJson(`/networks/${network}/pools/${address}`, {}, options.apiKey, options);
  const object = asObject(payload);
  if (!object) {
    throw new DexPaprikaError("DexPaprika returned a non-object");
  }
  return formatPool(object);
}

export async function poolsTool(
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const network = requireNetwork(arguments_);
  const limit = rowLimit(arguments_);
  const params: Record<string, string> = { limit: String(limit) };
  const token = argStr(arguments_, "token");
  if (token) {
    params.token_address = token;
  }
  const dex = argStr(arguments_, "dex");
  if (dex) {
    params.dex_name = dex;
  }
  const createdAfter = argStr(arguments_, "created_after");
  if (createdAfter) {
    params.created_after = createdAfter;
  }
  const orderBy = argStr(arguments_, "order_by");
  if (orderBy) {
    params.order_by = orderBy;
  }
  const sort = argStr(arguments_, "sort");
  if (sort) {
    params.sort = sort;
  }
  const cursor = argStr(arguments_, "cursor");
  if (cursor) {
    params.cursor = cursor;
  }
  return formatPools(
    await getJson(`/networks/${network}/pools/search`, params, options.apiKey, options),
    limit,
  );
}

export async function ohlcvTool(
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const network = requireNetwork(arguments_);
  const address = requireAddress(arguments_);
  const start = argStr(arguments_, "start", "-24h") || "-24h";
  const interval = argStr(arguments_, "interval", "1h") || "1h";
  if (!(OHLCV_INTERVALS as readonly string[]).includes(interval)) {
    throw new DexPaprikaError(`interval must be ${OHLCV_INTERVALS.join(", ")}`);
  }
  const params: Record<string, string> = { start, interval, limit: "1000" };
  const end = argStr(arguments_, "end");
  if (end) {
    params.end = end;
  }
  return formatOhlcv(
    await getJson(`/networks/${network}/pools/${address}/ohlcv`, params, options.apiKey, options),
    `${network}:${address} ${interval} ${start}`,
  );
}

export async function swapsTool(
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const network = requireNetwork(arguments_);
  const address = requireAddress(arguments_);
  const limit = rowLimit(arguments_);
  const params: Record<string, string> = { limit: String(limit) };
  const from = argStr(arguments_, "from");
  if (from) {
    params.from = from;
  }
  const to = argStr(arguments_, "to");
  if (to) {
    params.to = to;
  }
  const cursor = argStr(arguments_, "cursor");
  if (cursor) {
    params.cursor = cursor;
  }
  return formatSwaps(
    await getJson(`/networks/${network}/pools/${address}/transactions`, params, options.apiKey, options),
    limit,
  );
}

const HANDLERS: Record<
  string,
  (
    arguments_: Record<string, unknown>,
    options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
  ) => Promise<string>
> = {
  search: searchTool,
  token: tokenTool,
  prices: pricesTool,
  pool: poolTool,
  pools: poolsTool,
  ohlcv: ohlcvTool,
  swaps: swapsTool,
};

export async function callTool(
  name: string,
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const handler = HANDLERS[name];
  if (!handler) {
    throw new DexPaprikaError(`unknown DexPaprika tool ${name}`);
  }
  return handler(arguments_, options);
}
