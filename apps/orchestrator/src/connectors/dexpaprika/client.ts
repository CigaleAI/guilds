import type { Static, TSchema } from "@sinclair/typebox";
import { proxyFetch, withQuery, type FetchFn } from "../../net/http.js";
import { LIST_DEFAULT, clipRows, downsample, fmtNum, joinParts } from "../format.js";
import { decodeResponse, type ConnectorApi } from "../response.js";
import type { ApiGet } from "../types.js";
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
  type Figure,
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

/** A search for pools on a network: one page of `limit`, each filter empty when the call gives none. */
export type PoolSearch = {
  network: string;
  limit: number;
  token: string;
  dex: string;
  createdAfter: string;
  orderBy: string;
  sort: string;
  cursor: string;
};

/** The candles of a pool from `start` to `end` (empty for now), one per `interval`. */
export type OhlcvRequest = { network: string; address: string; start: string; end: string; interval: string };

/** A page of a pool's swaps from `from` to `to`, after `cursor`; each bound empty when the call gives none. */
export type SwapsRequest = { network: string; address: string; from: string; to: string; cursor: string; limit: number };

/** The first of `values` that is set: not absent, null, or empty text. */
function present(...values: Array<Figure | undefined>): Figure | undefined {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function pct(value: Figure | undefined): string {
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
    .map((token) => (token.symbol ?? "").trim())
    .filter(Boolean);
  if (symbols.length >= 2) {
    return symbols.slice(0, 2).join("/");
  }
  return (row.pool_name ?? row.name ?? "").trim();
}

function section(title: string, rows: string[], limit: number): string {
  const body = clipRows(rows.filter(Boolean), limit);
  if (body === "no results") {
    return "";
  }
  return `${title}\n${body}`;
}

function pageNote(payload: PageInfo): string {
  const cursor = payload.next_cursor?.trim() || payload.page_info?.next_cursor?.trim();
  return cursor ? `page=${cursor}` : "";
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
  const pools = Array.isArray(payload) ? payload : (payload.results ?? payload.pools ?? []);
  const page = Array.isArray(payload) ? {} : payload;
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

/** The message of an error body, trimmed; null when it holds none. */
function errorMessage(body: ErrorBody): string | null {
  const detail = (body.message ?? body.error)?.trim();
  return detail ? detail : null;
}

/** DexPaprika's API as the client reads its responses. */
const DEXPAPRIKA: ConnectorApi<typeof ErrorBody> = {
  name: "DexPaprika",
  error: (message, status) => new DexPaprikaError(message, status),
  errorBody: ErrorBody,
  errorMessage,
};

type DexPaprikaOptions = { client?: FetchFn; proxyUrl?: string };

/** The options of a call with a login's key. */
export type ToolOptions = DexPaprikaOptions & { apiKey: string };

/** The response at `path` with `params`, as `schema` describes it; the pro host when the free one refuses. */
async function getJson<T extends TSchema>(
  request: ApiGet<T>,
  apiKey: string,
  options: DexPaprikaOptions = {},
): Promise<Static<T>> {
  const key = apiKey.trim();
  if (!key) {
    throw new DexPaprikaError("DexPaprika API key is missing", 401);
  }
  const fetchFn = options.client ?? proxyFetch(options.proxyUrl ?? "");
  const headers = { Authorization: key, Accept: "application/json" };
  const send = async (base: string) =>
    fetchFn(withQuery(`${base}${request.path}`, request.params), { method: "GET", headers });
  let response = await send(API_BASE);
  if (response.status === 403) {
    response = await send(PRO_BASE);
  }
  return decodeResponse(DEXPAPRIKA, response, request.schema);
}

/** A network id a call names, lower-cased; throws when it is blank. */
function requireNetwork(network: string): string {
  const id = network.trim().toLowerCase();
  if (!id) {
    throw new DexPaprikaError("network is required");
  }
  return id;
}

/** An address a call names under `key`, trimmed; throws when it is blank. */
function requireAddress(address: string, key = "address"): string {
  const trimmed = address.trim();
  if (!trimmed) {
    throw new DexPaprikaError(`${key} is required`);
  }
  return trimmed;
}

export async function ping(apiKey: string, options: DexPaprikaOptions = {}): Promise<void> {
  const payload = await getJson({ path: "/usage", params: {}, schema: UsageResponse }, apiKey, options);
  const plan = payload.plan?.trim().toLowerCase();
  if (!plan || plan === "keyless") {
    throw new DexPaprikaError("api key was rejected", 401);
  }
}

/** DexPaprika's tokens, pools and DEXes for `query` across networks, `limit` rows a section. */
export async function search(query: string, limit: number, options: ToolOptions): Promise<string> {
  const stripped = query.trim();
  if (!stripped) {
    throw new DexPaprikaError("query is required");
  }
  const payload = await getJson({ path: "/search", params: { query: stripped }, schema: SearchResponse }, options.apiKey, options);
  return formatSearch(payload, limit);
}

/** A token's lean market on a network, by its contract address. */
export async function token(network: string, address: string, options: ToolOptions): Promise<string> {
  const path = `/networks/${requireNetwork(network)}/tokens/${requireAddress(address)}`;
  const payload = await getJson({ path, params: {}, schema: TokenResponse }, options.apiKey, options);
  return formatToken(payload);
}

/** The USD prices of the tokens a comma list of addresses names on a network, each address once. */
export async function prices(network: string, tokenList: string, options: ToolOptions): Promise<string> {
  const id = requireNetwork(network);
  const tokens = [
    ...new Set(
      tokenList
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
    { path: `/networks/${id}/multi/prices`, params: { tokens: tokens.join(",") }, schema: PricesResponse },
    options.apiKey,
    options,
  );
  return formatPrices(payload);
}

/** A pool's market on a network, by its address. */
export async function pool(network: string, address: string, options: ToolOptions): Promise<string> {
  const path = `/networks/${requireNetwork(network)}/pools/${requireAddress(address)}`;
  const payload = await getJson({ path, params: {}, schema: PoolRow }, options.apiKey, options);
  return formatPool(payload);
}

/** One page of the pools `request` searches for. */
export async function pools(request: PoolSearch, options: ToolOptions): Promise<string> {
  const { token: tokenAddress, dex, createdAfter, orderBy, sort, cursor, limit } = request;
  const params = {
    limit: String(limit),
    ...(tokenAddress ? { token_address: tokenAddress } : {}),
    ...(dex ? { dex_name: dex } : {}),
    ...(createdAfter ? { created_after: createdAfter } : {}),
    ...(orderBy ? { order_by: orderBy } : {}),
    ...(sort ? { sort } : {}),
    ...(cursor ? { cursor } : {}),
  };
  const payload = await getJson(
    { path: `/networks/${requireNetwork(request.network)}/pools/search`, params, schema: PoolsResponse },
    options.apiKey,
    options,
  );
  return formatPools(payload, limit);
}

/** The candles `request` asks for, downsampled to the chart's points. */
export async function ohlcv(request: OhlcvRequest, options: ToolOptions): Promise<string> {
  const network = requireNetwork(request.network);
  const address = requireAddress(request.address);
  const { start, end, interval } = request;
  if (!OHLCV_INTERVALS.some((entry) => entry === interval)) {
    throw new DexPaprikaError(`interval must be ${OHLCV_INTERVALS.join(", ")}`);
  }
  const params = { start, interval, limit: "1000", ...(end ? { end } : {}) };
  const payload = await getJson(
    { path: `/networks/${network}/pools/${address}/ohlcv`, params, schema: OhlcvResponse },
    options.apiKey,
    options,
  );
  return formatOhlcv(payload, `${network}:${address} ${interval} ${start}`);
}

/** The page of swaps `request` asks for. */
export async function swaps(request: SwapsRequest, options: ToolOptions): Promise<string> {
  const network = requireNetwork(request.network);
  const address = requireAddress(request.address);
  const { from, to, cursor, limit } = request;
  const params = {
    limit: String(limit),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(cursor ? { cursor } : {}),
  };
  const payload = await getJson(
    { path: `/networks/${network}/pools/${address}/transactions`, params, schema: SwapsResponse },
    options.apiKey,
    options,
  );
  return formatSwaps(payload, limit);
}
