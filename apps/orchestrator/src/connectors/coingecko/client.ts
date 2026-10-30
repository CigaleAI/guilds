import { Value } from "@sinclair/typebox/value";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { decode } from "../../lib/decode.js";
import { proxyFetch, withQuery, type FetchFn } from "../../net/http.js";
import {
  LIST_CAP,
  LIST_DEFAULT,
  argStr,
  clipRows,
  downsample,
  fmtNum,
  joinParts,
  rowLimit,
  tsSec,
} from "../format.js";
import type { ApiGet } from "../types.js";
import {
  ChartResponse,
  CoinResponse,
  ErrorBody,
  ErrorDetail,
  MoversResponse,
  NewCoinsResponse,
  OhlcResponse,
  PerCurrency,
  PricesResponse,
  SearchResponse,
  SupplyResponse,
  TrendingResponse,
  type Mover,
  type TrendingCategory,
  type TrendingCoin,
  type TrendingNft,
} from "./responses.js";

export const PRO_BASE = "https://pro-api.coingecko.com/api/v3";
export const VS_DEFAULT = "usd";
export const CHART_POINTS = 48;
export const PRICES_IDS_MAX = 50;

export class CoinGeckoError extends Error {
  status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "CoinGeckoError";
    this.status = status;
  }
}

function rank(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  return `#${value}`;
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

/** A figure CoinGecko sends either as one number or per quote currency: the `vs` one, else USD. */
function currency(value: unknown, vs: string): string {
  if (!Value.Check(PerCurrency, value)) {
    return fmtNum(value);
  }
  if (vs in value) {
    return fmtNum(value[vs]);
  }
  return "usd" in value ? fmtNum(value.usd) : "-";
}

function section(title: string, rows: string[], limit: number): string {
  const body = clipRows(rows.filter(Boolean), limit);
  if (body === "no results") {
    return "";
  }
  return `${title}\n${body}`;
}

function sections(blocks: string[]): string {
  const shown = blocks.filter(Boolean);
  return shown.length ? shown.join("\n\n") : "no results";
}

/** The points of a series that carry a timestamp and a value. */
function pairs(points: unknown[][] | undefined): unknown[][] {
  return (points ?? []).filter((point) => point.length >= 2);
}

export function formatSearch(payload: SearchResponse, limit = LIST_DEFAULT): string {
  const blocks: string[] = [];
  if (payload.coins?.length) {
    const rows = payload.coins.map((row) => joinParts(row.id, row.symbol, row.name, rank(row.market_cap_rank)));
    blocks.push(section("coins", rows, limit));
  }
  if (payload.nfts?.length) {
    blocks.push(section("nfts", payload.nfts.map((row) => joinParts(row.id, row.symbol, row.name)), limit));
  }
  if (payload.categories?.length) {
    blocks.push(section("categories", payload.categories.map((row) => joinParts(row.id, row.name)), limit));
  }
  return sections(blocks);
}

/** A coin's contracts, `chain=address`: its platforms, else its own platform and address. */
export function formatPlatforms(payload: CoinResponse): string {
  const found: string[] = [];
  for (const [chain, address] of Object.entries(payload.platforms ?? {})) {
    if (typeof address === "string" && address.trim()) {
      found.push(`${chain}=${address.trim()}`);
    }
  }
  const platform = payload.asset_platform_id;
  const address = payload.contract_address;
  if (!found.length && typeof platform === "string" && typeof address === "string" && address.trim()) {
    found.push(`${platform}=${address.trim()}`);
  }
  return found.join("  ");
}

export function formatCoin(payload: CoinResponse, vs = VS_DEFAULT): string {
  if (Object.keys(payload).length === 0) {
    return "no results";
  }
  const market = payload.market_data ?? {};
  const head = joinParts(payload.id, payload.symbol, payload.name, rank(payload.market_cap_rank ?? market.market_cap_rank));
  const stats = joinParts(
    `p=${currency(market.current_price, vs)}`,
    `mcap=${currency(market.market_cap, vs)}`,
    `vol=${currency(market.total_volume, vs)}`,
    `circ=${fmtNum(market.circulating_supply)}`,
    `total=${fmtNum(market.total_supply)}`,
    `chg_24h=${pct(market.price_change_percentage_24h)}`,
  );
  return [head, stats, formatPlatforms(payload)].filter(Boolean).join("\n");
}

export function formatNew(payload: NewCoinsResponse, limit = LIST_DEFAULT): string {
  return clipRows(payload.map((row) => joinParts(row.id, row.symbol, row.name, row.activated_at)), limit);
}

/** A mover's row in the `vs` currency, falling back to USD for each figure CoinGecko leaves out. */
function moverRow(row: Mover, vs: string): string {
  return joinParts(
    row.id,
    row.symbol,
    row.name,
    rank(row.market_cap_rank),
    fmtNum(row[vs] ?? row.usd),
    fmtNum(row[`${vs}_24h_vol`] ?? row.usd_24h_vol),
    pct(row[`${vs}_24h_change`] ?? row.usd_24h_change),
  );
}

export function formatMovers(payload: MoversResponse, vs = VS_DEFAULT, limit = LIST_DEFAULT): string {
  const blocks: string[] = [];
  for (const [items, label] of [
    [payload.top_gainers, "gainers"],
    [payload.top_losers, "losers"],
  ] as const) {
    if (items?.length) {
      blocks.push(section(label, items.map((row) => moverRow(row, vs)), limit));
    }
  }
  return blocks.length ? blocks.join("\n\n") : "no results";
}

export function formatSupply(payload: SupplyResponse): string {
  if (Object.keys(payload).length === 0) {
    return "no results";
  }
  const data = payload.supply_data ?? {};
  const head = joinParts(payload.id, payload.symbol, payload.name);
  const stats = joinParts(
    `circ=${fmtNum(data.circulating_supply)}`,
    `total=${fmtNum(data.total_supply)}`,
    `locked=${fmtNum(data.non_circulating_supply)}`,
    `outstanding=${fmtNum(data.outstanding_supply)}`,
  );
  const lines = [head, stats];
  const wallets = payload.non_circulating_wallets ?? [];
  if (wallets.length) {
    lines.push("wallets");
    for (const row of wallets.slice(0, LIST_CAP)) {
      const mark = row.anomaly ? " anomaly" : "";
      lines.push(joinParts(row.address, row.label, fmtNum(row.balance), pct(row.percentage_of_total_supply)) + mark);
    }
  }
  return lines.filter(Boolean).join("\n");
}

export function formatOhlc(payload: OhlcResponse, title: string): string {
  const rows = downsample(payload, CHART_POINTS)
    .filter((point) => point.length >= 5)
    .map((point) => joinParts(tsSec(point[0]), fmtNum(point[1]), fmtNum(point[2]), fmtNum(point[3]), fmtNum(point[4])));
  const header = `${title} ohlc n=${rows.length}`;
  return rows.length ? [header, "t  o  h  l  c", ...rows].join("\n") : `${header}\nno results`;
}

/** The series a chart shows: `price`, `mcap` and `vol`, comma separated; price when none is named. */
function chartSeries(series: string): Set<string> {
  const wanted = new Set(
    series
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
  return wanted.size ? wanted : new Set(["price"]);
}

export function formatChart(payload: ChartResponse, title: string, series = "price"): string {
  const wanted = chartSeries(series);
  const price = pairs(payload.prices);
  const mcap = pairs(payload.market_caps);
  const volume = pairs(payload.total_volumes);
  const base = downsample(price.length ? price : mcap.length ? mcap : volume, CHART_POINTS);
  const values = (points: unknown[][]) =>
    downsample(points.length ? points : base, CHART_POINTS).map((point) => fmtNum(point[1]));
  const columns: Array<[string, string[]]> = [["t", base.map((point) => tsSec(point[0]))]];
  if (wanted.has("price")) columns.push(["p", values(price)]);
  if (wanted.has("mcap")) columns.push(["m", values(mcap)]);
  if (wanted.has("vol")) columns.push(["v", values(volume)]);
  const width = Math.min(...columns.map((column) => column[1].length));
  if (width === 0) {
    return `${title} n=0\nno results`;
  }
  const header = `${title} n=${width}`;
  const labels = columns.map(([name]) => name).join("  ");
  const rows = Array.from({ length: width }, (_, index) => columns.map((column) => column[1][index]).join("  "));
  return [header, labels, ...rows].join("\n");
}

function trendingCoinRow(row: TrendingCoin): string {
  const data = row.data ?? {};
  return joinParts(
    row.id,
    row.symbol,
    row.name,
    rank(row.market_cap_rank),
    fmtNum(data.price),
    pct(data.price_change_percentage_24h?.usd),
  );
}

function trendingNftRow(row: TrendingNft): string {
  return joinParts(
    row.id,
    row.symbol,
    row.name,
    fmtNum(row.floor_price_in_native_currency),
    row.native_currency_symbol,
    pct(row.floor_price_24h_percentage_change),
  );
}

function trendingCategoryRow(row: TrendingCategory): string {
  const data = row.data ?? {};
  return joinParts(row.slug ?? row.id, row.name, fmtNum(data.market_cap), pct(data.market_cap_change_percentage_24h?.usd));
}

export function formatTrending(payload: TrendingResponse, limit = LIST_DEFAULT): string {
  const blocks: string[] = [];
  const coins = (payload.coins ?? []).flatMap((wrapper) => (wrapper.item ? [wrapper.item] : []));
  if (payload.coins?.length) {
    blocks.push(section("coins", coins.map(trendingCoinRow), limit));
  }
  if (payload.nfts?.length) {
    blocks.push(section("nfts", payload.nfts.map(trendingNftRow), limit));
  }
  if (payload.categories?.length) {
    blocks.push(section("categories", payload.categories.map(trendingCategoryRow), limit));
  }
  return blocks.length ? blocks.join("\n\n") : "no results";
}

/** The first non-empty text among `values`. */
function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

/** The message of an error body, as text or one object deeper. */
function errorMessage(payload: unknown): string | null {
  if (!Value.Check(ErrorBody, payload)) {
    return null;
  }
  const detail = payload.error ?? payload.status ?? payload.message;
  if (Value.Check(ErrorDetail, detail)) {
    return firstText(detail.error_message ?? detail.error ?? detail.message);
  }
  return firstText(detail);
}

async function errorDetail(response: Response): Promise<string> {
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    const stripped = text.trim();
    return stripped || `CoinGecko HTTP ${response.status}`;
  }
  return errorMessage(payload) ?? `CoinGecko HTTP ${response.status}`;
}

type CoinGeckoOptions = { client?: FetchFn; proxyUrl?: string };

function unexpected(problem: string): CoinGeckoError {
  return new CoinGeckoError(`CoinGecko returned an unexpected response at ${problem}`);
}

/** The response at `path` with `params`, as `schema` describes it. */
async function getJson<T extends TSchema>(
  request: ApiGet<T>,
  apiKey: string,
  options: CoinGeckoOptions = {},
): Promise<Static<T>> {
  const key = apiKey.trim();
  if (!key) {
    throw new CoinGeckoError("CoinGecko API key is missing", 401);
  }
  const fetchFn = options.client ?? proxyFetch(options.proxyUrl ?? "");
  const response = await fetchFn(withQuery(`${PRO_BASE}${request.path}`, request.params), {
    method: "GET",
    headers: { "x-cg-pro-api-key": key, Accept: "application/json" },
  });
  if (response.status >= 400) {
    throw new CoinGeckoError(await errorDetail(response), response.status);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    throw new CoinGeckoError("CoinGecko returned a non-JSON body");
  }
  return decode(request.schema, payload, unexpected);
}

/** The coin the arguments name, as `[id, platform, address]`: by `id`, else by `platform` and `address`, each empty when not given. */
function coinRef(arguments_: Record<string, unknown>): [string, string, string] {
  const coinId = argStr(arguments_, "id");
  if (coinId) {
    return [coinId, "", ""];
  }
  return ["", argStr(arguments_, "platform"), argStr(arguments_, "address")];
}

/** The coin the arguments name, as `coinRef` reads it; throws when they name none. */
function requiredCoinRef(arguments_: Record<string, unknown>): [string, string, string] {
  const [coinId, platform, address] = coinRef(arguments_);
  if (!coinId && !(platform && address)) {
    throw new CoinGeckoError("id, or platform and address, is required");
  }
  return [coinId, platform, address];
}

const PING = Type.Unknown();

export async function ping(apiKey: string, options: CoinGeckoOptions = {}): Promise<void> {
  await getJson({ path: "/ping", params: {}, schema: PING }, apiKey, options);
}

type ToolOptions = CoinGeckoOptions & { apiKey: string };

export async function searchTool(arguments_: Record<string, unknown>, options: ToolOptions): Promise<string> {
  const query = argStr(arguments_, "query");
  if (!query) {
    throw new CoinGeckoError("query is required");
  }
  const payload = await getJson({ path: "/search", params: { query }, schema: SearchResponse }, options.apiKey, options);
  return formatSearch(payload, rowLimit(arguments_));
}

export async function coinTool(arguments_: Record<string, unknown>, options: ToolOptions): Promise<string> {
  const [coinId, platform, address] = requiredCoinRef(arguments_);
  const params = {
    localization: "false",
    tickers: "false",
    market_data: "true",
    sparkline: "false",
  };
  const path = coinId ? `/coins/${coinId}` : `/coins/${platform}/contract/${address}`;
  return formatCoin(await getJson({ path, params, schema: CoinResponse }, options.apiKey, options));
}

export async function newTool(arguments_: Record<string, unknown>, options: ToolOptions): Promise<string> {
  const payload = await getJson({ path: "/coins/list/new", params: {}, schema: NewCoinsResponse }, options.apiKey, options);
  return formatNew(payload, rowLimit(arguments_));
}

export async function moversTool(arguments_: Record<string, unknown>, options: ToolOptions): Promise<string> {
  const vs = argStr(arguments_, "vs", VS_DEFAULT) || VS_DEFAULT;
  const params: Record<string, string> = { vs_currency: vs };
  const duration = argStr(arguments_, "duration");
  if (duration) {
    params.duration = duration;
  }
  const top = argStr(arguments_, "top");
  if (top) {
    params.top_coins = top;
  }
  const payload = await getJson(
    { path: "/coins/top_gainers_losers", params, schema: MoversResponse },
    options.apiKey,
    options,
  );
  return formatMovers(payload, vs, rowLimit(arguments_));
}

export async function supplyTool(arguments_: Record<string, unknown>, options: ToolOptions): Promise<string> {
  const coinId = argStr(arguments_, "id");
  if (!coinId) {
    throw new CoinGeckoError("id is required");
  }
  const payload = await getJson(
    { path: `/coins/${coinId}/supply_breakdown`, params: {}, schema: SupplyResponse },
    options.apiKey,
    options,
  );
  return formatSupply(payload);
}

/** What the chart tool is asked for: a coin by id or by contract, over `days`, in `vs`. */
type ChartRequest = {
  coinId: string;
  platform: string;
  address: string;
  days: string;
  kind: "price" | "ohlc";
  vs: string;
  series: string;
};

function chartRequest(arguments_: Record<string, unknown>): ChartRequest {
  const [coinId, platform, address] = coinRef(arguments_);
  const kind = argStr(arguments_, "kind", "price") || "price";
  if (kind !== "price" && kind !== "ohlc") {
    throw new CoinGeckoError("kind must be price or ohlc");
  }
  if (kind === "ohlc" && !coinId) {
    throw new CoinGeckoError("ohlc requires coin id");
  }
  if (!coinId && !(platform && address)) {
    throw new CoinGeckoError("id, or platform and address, is required");
  }
  return {
    coinId,
    platform,
    address,
    kind,
    days: argStr(arguments_, "days", "7") || "7",
    vs: argStr(arguments_, "vs", VS_DEFAULT) || VS_DEFAULT,
    series: argStr(arguments_, "series", "price") || "price",
  };
}

export async function chartTool(arguments_: Record<string, unknown>, options: ToolOptions): Promise<string> {
  const { coinId, platform, address, days, kind, vs, series } = chartRequest(arguments_);
  const params = { vs_currency: vs, days };
  if (kind === "ohlc") {
    const payload = await getJson({ path: `/coins/${coinId}/ohlc`, params, schema: OhlcResponse }, options.apiKey, options);
    return formatOhlc(payload, `${coinId} ${vs} ${days}d`);
  }
  const path = coinId ? `/coins/${coinId}/market_chart` : `/coins/${platform}/contract/${address}/market_chart`;
  const title = coinId ? `${coinId} ${vs} ${days}d` : `${platform}:${address} ${vs} ${days}d`;
  const payload = await getJson({ path, params, schema: ChartResponse }, options.apiKey, options);
  return formatChart(payload, title, series);
}

export async function trendingTool(arguments_: Record<string, unknown>, options: ToolOptions): Promise<string> {
  const payload = await getJson({ path: "/search/trending", params: {}, schema: TrendingResponse }, options.apiKey, options);
  return formatTrending(payload, rowLimit(arguments_));
}

export type CoinMatch = {
  id: string;
  symbol: string;
  name: string;
  market_cap_rank: number | null;
  thumb: string;
};

export type CoinPrice = {
  usd: number;
  change_24h: number | null;
  updated_at: number | null;
};

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function searchCoins(query: string, options: ToolOptions): Promise<CoinMatch[]> {
  const text = query.trim();
  if (!text) {
    throw new CoinGeckoError("query is required");
  }
  const payload = await getJson({ path: "/search", params: { query: text }, schema: SearchResponse }, options.apiKey, options);
  const matches: CoinMatch[] = [];
  for (const row of (payload.coins ?? []).slice(0, LIST_CAP)) {
    if (typeof row.id !== "string" || !row.id) {
      continue;
    }
    matches.push({
      id: row.id,
      symbol: String(row.symbol ?? "").toUpperCase(),
      name: String(row.name ?? row.id),
      market_cap_rank: finite(row.market_cap_rank),
      thumb: typeof row.thumb === "string" ? row.thumb : "",
    });
  }
  return matches;
}

export async function simplePrices(ids: string[], options: ToolOptions): Promise<Record<string, CoinPrice>> {
  if (!ids.length) {
    return {};
  }
  const params = {
    ids: ids.join(","),
    vs_currencies: VS_DEFAULT,
    include_24hr_change: "true",
    include_last_updated_at: "true",
  };
  const payload = await getJson({ path: "/simple/price", params, schema: PricesResponse }, options.apiKey, options);
  const prices: Record<string, CoinPrice> = {};
  for (const [id, row] of Object.entries(payload)) {
    const usd = finite(row.usd);
    if (usd !== null) {
      prices[id] = { usd, change_24h: finite(row.usd_24h_change), updated_at: finite(row.last_updated_at) };
    }
  }
  return prices;
}

export function formatPrices(ids: string[], prices: Record<string, CoinPrice>): string {
  const rows = ids.map((id) => {
    const quote = prices[id];
    if (!quote) {
      return joinParts(id, "no price");
    }
    return joinParts(
      id,
      `p=${fmtNum(quote.usd)}`,
      `chg_24h=${pct(quote.change_24h)}`,
      quote.updated_at === null ? "" : tsSec(quote.updated_at),
    );
  });
  return rows.length ? rows.join("\n") : "no results";
}

export async function pricesTool(arguments_: Record<string, unknown>, options: ToolOptions): Promise<string> {
  const ids = [
    ...new Set(
      argStr(arguments_, "ids")
        .split(",")
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (!ids.length) {
    throw new CoinGeckoError("ids is required");
  }
  if (ids.length > PRICES_IDS_MAX) {
    throw new CoinGeckoError(`ids must list at most ${PRICES_IDS_MAX} coins`);
  }
  return formatPrices(ids, await simplePrices(ids, options));
}

const HANDLERS: Record<string, (arguments_: Record<string, unknown>, options: ToolOptions) => Promise<string>> = {
  search: searchTool,
  coin: coinTool,
  prices: pricesTool,
  new: newTool,
  movers: moversTool,
  supply: supplyTool,
  chart: chartTool,
  trending: trendingTool,
};

export async function callTool(
  name: string,
  arguments_: Record<string, unknown>,
  options: ToolOptions,
): Promise<string> {
  const handler = HANDLERS[name];
  if (!handler) {
    throw new CoinGeckoError(`unknown CoinGecko tool ${name}`);
  }
  return handler(arguments_, options);
}
