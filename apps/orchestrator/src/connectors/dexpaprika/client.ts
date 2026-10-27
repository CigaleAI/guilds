import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { decode } from "../../lib/decode.js";
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
import {
  ErrorBody,
  OhlcvResponse,
  PoolRow,
  PoolsResponse,
  PricesResponse,
  SearchResponse,
  SwapsResponse,
  TokenResponse,
  UsageResponse,
  type PageInfo,
} from "./responses.js";

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

/** The first of `values` that is set: not undefined, null, or empty text. */
function present(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null && value !== "");
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

function pair(row: PoolRow): string {
  const symbols = (row.tokens ?? [])
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

function pageNote(payload: PageInfo): string {
  const cursor =
    (typeof payload.next_cursor === "string" && payload.next_cursor.trim())
    || payload.page_info?.next_cursor;
  if (typeof cursor === "string" && cursor.trim()) {
    return `page=${cursor.trim()}`;
  }
  return "";
}

/** The pools of a page, and its cursor. */
function poolPage(payload: PoolsResponse): { rows: PoolRow[]; page: PageInfo } {
  if (Array.isArray(payload)) {
    return { rows: payload, page: {} };
  }
  return { rows: payload.results ?? payload.pools ?? [], page: payload };
}

function searchPoolRow(row: PoolRow): string {
  return joinParts(
    row.chain,
    row.id,
    row.dex_name ?? row.dex_id,
    pair(row),
    `vol=${fmtNum(present(row.volume_usd_24h, row.volume_usd))}`,
  );
}

export function formatSearch(payload: SearchResponse, limit = LIST_DEFAULT): string {
  const blocks: string[] = [];
  const tokens = payload.tokens ?? [];
  if (tokens.length) {
    const rows = tokens.map((row) => joinParts(row.chain, row.id, row.symbol, row.name, `p=${fmtNum(row.price_usd)}`));
    blocks.push(section("tokens", rows, limit));
  }
  const pools = payload.pools ?? [];
  if (pools.length) {
    blocks.push(section("pools", pools.map(searchPoolRow), limit));
  }
  const dexes = payload.dexes ?? [];
  if (dexes.length) {
    const rows = dexes.map((row) =>
      joinParts(row.chain, row.dex_id ?? row.id, row.dex_name, `vol=${fmtNum(row.volume_usd_24h)}`),
    );
    blocks.push(section("dexes", rows, limit));
  }
  const shown = blocks.filter(Boolean);
  return shown.length ? shown.join("\n\n") : "no results";
}

export function formatToken(payload: TokenResponse): string {
  if (!Object.keys(payload).length) {
    return "no results";
  }
  const summary = payload.summary ?? {};
  const day = summary["24h"] ?? {};
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

export function formatPrices(payload: PricesResponse): string {
  const rows = payload.map((row) =>
    joinParts(row.chain, row.id, `p=${fmtNum(row.price_usd)}`),
  );
  return rows.length ? rows.join("\n") : "no results";
}

export function formatPool(payload: PoolRow): string {
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
    `p=${fmtNum(present(payload.price_usd))}`,
    `liq=${fmtNum(present(payload.liquidity_usd))}`,
    `vol_24h=${fmtNum(present(payload.volume_usd_24h, payload.volume_usd))}`,
    `chg_24h=${pct(present(payload.last_price_change_usd_24h, payload.price_change_percentage_24h))}`,
    `tx_24h=${fmtNum(present(payload.txns_24h, payload.transactions))}`,
  );
  return [head, stats].filter(Boolean).join("\n") || "no results";
}

export function formatPools(payload: PoolsResponse, limit = LIST_DEFAULT): string {
  const { rows: pools, page } = poolPage(payload);
  const rows = pools.map((row) =>
    joinParts(
      row.chain,
      row.id,
      row.dex_name ?? row.dex_id,
      pair(row),
      `p=${fmtNum(present(row.price_usd))}`,
      `liq=${fmtNum(present(row.liquidity_usd))}`,
      `vol=${fmtNum(present(row.volume_usd_24h, row.volume_usd))}`,
    ),
  );
  const body = clipRows(rows, limit);
  if (body === "no results") {
    return body;
  }
  return [body, pageNote(page)].filter(Boolean).join("\n");
}

export function formatOhlcv(payload: OhlcvResponse, title: string): string {
  const rows = downsample(payload, CHART_POINTS).map((point) =>
    joinParts(
      point.time_open ?? point.time_close,
      fmtNum(point.open),
      fmtNum(point.high),
      fmtNum(point.low),
      fmtNum(point.close),
      fmtNum(point.volume),
    ),
  );
  const header = `${title} ohlc n=${rows.length}`;
  return rows.length ? [header, "t  o  h  l  c  v", ...rows].join("\n") : `${header}\nno results`;
}

export function formatSwaps(payload: SwapsResponse, limit = LIST_DEFAULT): string {
  const items = Array.isArray(payload) ? payload : (payload.transactions ?? []);
  const page = Array.isArray(payload) ? {} : payload;
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
  return [body, pageNote(page)].filter(Boolean).join("\n");
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
  if (Value.Check(ErrorBody, payload)) {
    const detail = payload.message ?? payload.error;
    if (typeof detail === "string" && detail.trim()) {
      return detail.trim();
    }
  }
  return `DexPaprika HTTP ${response.status}`;
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: apiKey, Accept: "application/json" };
}

type DexPaprikaOptions = { client?: FetchFn; proxyUrl?: string };

type ToolOptions = DexPaprikaOptions & { apiKey: string };

function unexpected(problem: string): DexPaprikaError {
  return new DexPaprikaError(`DexPaprika returned an unexpected response at ${problem}`);
}

/** The response at `path` with `params`, as `schema` describes it; the pro host when the free one refuses. */
async function getJson<T extends TSchema>(
  request: { path: string; params: Record<string, string>; schema: T },
  apiKey: string,
  options: DexPaprikaOptions = {},
): Promise<Static<T>> {
  const key = apiKey.trim();
  if (!key) {
    throw new DexPaprikaError("DexPaprika API key is missing", 401);
  }
  const fetchFn = options.client ?? proxyFetch(options.proxyUrl ?? "");
  const headers = authHeaders(key);
  const send = async (base: string) =>
    fetchFn(withQuery(`${base}${request.path}`, request.params), { method: "GET", headers });
  let response = await send(API_BASE);
  if (response.status === 403) {
    response = await send(PRO_BASE);
  }
  if (response.status >= 400) {
    throw new DexPaprikaError(await errorDetail(response), response.status);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    throw new DexPaprikaError("DexPaprika returned a non-JSON body");
  }
  return decode(request.schema, payload, unexpected);
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

const USAGE = Type.Unknown();

export async function ping(apiKey: string, options: DexPaprikaOptions = {}): Promise<void> {
  const payload = await getJson({ path: "/usage", params: {}, schema: USAGE }, apiKey, options);
  const plan = Value.Check(UsageResponse, payload) && typeof payload.plan === "string"
    ? payload.plan.trim().toLowerCase()
    : "";
  if (!plan || plan === "keyless") {
    throw new DexPaprikaError("api key was rejected", 401);
  }
}

export async function searchTool(arguments_: Record<string, unknown>, options: ToolOptions): Promise<string> {
  const query = argStr(arguments_, "query");
  if (!query) {
    throw new DexPaprikaError("query is required");
  }
  const payload = await getJson({ path: "/search", params: { query }, schema: SearchResponse }, options.apiKey, options);
  return formatSearch(payload, rowLimit(arguments_));
}

export async function tokenTool(arguments_: Record<string, unknown>, options: ToolOptions): Promise<string> {
  const network = requireNetwork(arguments_);
  const address = requireAddress(arguments_);
  const payload = await getJson(
    { path: `/networks/${network}/tokens/${address}`, params: {}, schema: TokenResponse },
    options.apiKey,
    options,
  );
  return formatToken(payload);
}

export async function pricesTool(arguments_: Record<string, unknown>, options: ToolOptions): Promise<string> {
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
  const payload = await getJson(
    { path: `/networks/${network}/multi/prices`, params: { tokens: tokens.join(",") }, schema: PricesResponse },
    options.apiKey,
    options,
  );
  return formatPrices(payload);
}

export async function poolTool(arguments_: Record<string, unknown>, options: ToolOptions): Promise<string> {
  const network = requireNetwork(arguments_);
  const address = requireAddress(arguments_);
  const payload = await getJson(
    { path: `/networks/${network}/pools/${address}`, params: {}, schema: PoolRow },
    options.apiKey,
    options,
  );
  return formatPool(payload);
}

/** The arguments that, when given, become a query parameter of their own name. */
function optionalParams(arguments_: Record<string, unknown>, names: Record<string, string>): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [argument, param] of Object.entries(names)) {
    const value = argStr(arguments_, argument);
    if (value) {
      params[param] = value;
    }
  }
  return params;
}

export async function poolsTool(arguments_: Record<string, unknown>, options: ToolOptions): Promise<string> {
  const network = requireNetwork(arguments_);
  const limit = rowLimit(arguments_);
  const params = {
    limit: String(limit),
    ...optionalParams(arguments_, {
      token: "token_address",
      dex: "dex_name",
      created_after: "created_after",
      order_by: "order_by",
      sort: "sort",
      cursor: "cursor",
    }),
  };
  const payload = await getJson(
    { path: `/networks/${network}/pools/search`, params, schema: PoolsResponse },
    options.apiKey,
    options,
  );
  return formatPools(payload, limit);
}

export async function ohlcvTool(arguments_: Record<string, unknown>, options: ToolOptions): Promise<string> {
  const network = requireNetwork(arguments_);
  const address = requireAddress(arguments_);
  const start = argStr(arguments_, "start", "-24h") || "-24h";
  const interval = argStr(arguments_, "interval", "1h") || "1h";
  if (!OHLCV_INTERVALS.some((entry) => entry === interval)) {
    throw new DexPaprikaError(`interval must be ${OHLCV_INTERVALS.join(", ")}`);
  }
  const params = { start, interval, limit: "1000", ...optionalParams(arguments_, { end: "end" }) };
  const payload = await getJson(
    { path: `/networks/${network}/pools/${address}/ohlcv`, params, schema: OhlcvResponse },
    options.apiKey,
    options,
  );
  return formatOhlcv(payload, `${network}:${address} ${interval} ${start}`);
}

export async function swapsTool(arguments_: Record<string, unknown>, options: ToolOptions): Promise<string> {
  const network = requireNetwork(arguments_);
  const address = requireAddress(arguments_);
  const limit = rowLimit(arguments_);
  const params = { limit: String(limit), ...optionalParams(arguments_, { from: "from", to: "to", cursor: "cursor" }) };
  const payload = await getJson(
    { path: `/networks/${network}/pools/${address}/transactions`, params, schema: SwapsResponse },
    options.apiKey,
    options,
  );
  return formatSwaps(payload, limit);
}

const HANDLERS: Record<string, (arguments_: Record<string, unknown>, options: ToolOptions) => Promise<string>> = {
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
  options: ToolOptions,
): Promise<string> {
  const handler = HANDLERS[name];
  if (!handler) {
    throw new DexPaprikaError(`unknown DexPaprika tool ${name}`);
  }
  return handler(arguments_, options);
}
