import { Value } from "@sinclair/typebox/value";
import type { Static, TSchema } from "@sinclair/typebox";
import { proxyFetch, withQuery, type FetchFn } from "../../net/http.js";
import { LIST_CAP, LIST_DEFAULT, clipRows, downsample, fmtNum, joinParts, tsSec } from "../format.js";
import { decodeResponse, type ConnectorApi } from "../response.js";
import type { ApiGet } from "../types.js";
import {
  ChartResponse,
  CoinResponse,
  ErrorBody,
  ErrorDetail,
  MoversResponse,
  NewCoinsResponse,
  OhlcResponse,
  PingResponse,
  PricesResponse,
  SearchResponse,
  SupplyResponse,
  TrendingResponse,
  type ChartPoint,
  type Figure,
  type Mover,
  type PerCurrency,
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

/** A coin as a call names it: by its CoinGecko id, or by its contract address on a platform. */
export type CoinRef = { id: string } | { platform: string; address: string };

/** The window and quote currency of a chart: `days` back (or `max`), priced in `vs`. */
export type ChartWindow = { days: string; vs: string };

/** The movers a call asks for: priced in `vs`, over `duration`, among the `top` coins by market cap; CoinGecko's default for each left empty. */
export type MoversRequest = { vs: string; duration: string; top: string; limit: number };

function rank(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : `#${value}`;
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

/** A figure CoinGecko sends per quote currency: the `vs` one, else USD. */
function currency(prices: PerCurrency | null | undefined, vs: string): string {
  if (!prices) {
    return "-";
  }
  return fmtNum(vs in prices ? prices[vs] : prices.usd);
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
    const trimmed = address?.trim();
    if (trimmed) {
      found.push(`${chain}=${trimmed}`);
    }
  }
  const platform = payload.asset_platform_id;
  const address = payload.contract_address?.trim();
  if (!found.length && platform && address) {
    found.push(`${platform}=${address}`);
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
  const rows = downsample(payload, CHART_POINTS).map(([time, open, high, low, close]) =>
    joinParts(tsSec(time), fmtNum(open), fmtNum(high), fmtNum(low), fmtNum(close)),
  );
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
  const price = payload.prices ?? [];
  const mcap = payload.market_caps ?? [];
  const volume = payload.total_volumes ?? [];
  const base = downsample(price.length ? price : mcap.length ? mcap : volume, CHART_POINTS);
  const values = (points: ChartPoint[]) =>
    downsample(points.length ? points : base, CHART_POINTS).map(([, value]) => fmtNum(value));
  const columns: Array<[string, string[]]> = [["t", base.map(([time]) => tsSec(time))]];
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

/** Text, trimmed; null when it is blank or absent. */
function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** The message of an error body, as text or one object deeper. */
function errorMessage(body: ErrorBody): string | null {
  const detail = body.error ?? body.status ?? body.message;
  return Value.Check(ErrorDetail, detail)
    ? text(detail.error_message ?? detail.error ?? detail.message)
    : text(detail);
}

/** CoinGecko's API as the client reads its responses. */
const COINGECKO: ConnectorApi<typeof ErrorBody> = {
  name: "CoinGecko",
  error: (message, status) => new CoinGeckoError(message, status),
  errorBody: ErrorBody,
  errorMessage,
};

type CoinGeckoOptions = { client?: FetchFn; proxyUrl?: string };

/** The options of a call with a login's key. */
export type ToolOptions = CoinGeckoOptions & { apiKey: string };

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
  return decodeResponse(COINGECKO, response, request.schema);
}

export async function ping(apiKey: string, options: CoinGeckoOptions = {}): Promise<void> {
  await getJson({ path: "/ping", params: {}, schema: PingResponse }, apiKey, options);
}

/** CoinGecko's coins, NFTs and categories for `query`, `limit` rows a section. */
export async function search(query: string, limit: number, options: ToolOptions): Promise<string> {
  const stripped = query.trim();
  if (!stripped) {
    throw new CoinGeckoError("query is required");
  }
  const payload = await getJson({ path: "/search", params: { query: stripped }, schema: SearchResponse }, options.apiKey, options);
  return formatSearch(payload, limit);
}

/** A coin's contracts and lean market data. */
export async function coin(ref: CoinRef, options: ToolOptions): Promise<string> {
  const params = {
    localization: "false",
    tickers: "false",
    market_data: "true",
    sparkline: "false",
  };
  const path = "id" in ref ? `/coins/${ref.id}` : `/coins/${ref.platform}/contract/${ref.address}`;
  return formatCoin(await getJson({ path, params, schema: CoinResponse }, options.apiKey, options));
}

/** The coins CoinGecko listed last, `limit` rows. */
export async function newCoins(limit: number, options: ToolOptions): Promise<string> {
  const payload = await getJson({ path: "/coins/list/new", params: {}, schema: NewCoinsResponse }, options.apiKey, options);
  return formatNew(payload, limit);
}

/** The top gainers and losers `request` asks for, `limit` rows a side. */
export async function movers(request: MoversRequest, options: ToolOptions): Promise<string> {
  const { vs, duration, top, limit } = request;
  const params = {
    vs_currency: vs,
    ...(duration ? { duration } : {}),
    ...(top ? { top_coins: top } : {}),
  };
  const payload = await getJson(
    { path: "/coins/top_gainers_losers", params, schema: MoversResponse },
    options.apiKey,
    options,
  );
  return formatMovers(payload, vs, limit);
}

/** A coin's circulating, total and non-circulating supply, by its id. */
export async function supply(coinId: string, options: ToolOptions): Promise<string> {
  const id = coinId.trim();
  if (!id) {
    throw new CoinGeckoError("id is required");
  }
  const payload = await getJson(
    { path: `/coins/${id}/supply_breakdown`, params: {}, schema: SupplyResponse },
    options.apiKey,
    options,
  );
  return formatSupply(payload);
}

/** A coin's OHLC candles over `window`, by its id. */
export async function ohlcChart(coinId: string, window: ChartWindow, options: ToolOptions): Promise<string> {
  const { days, vs } = window;
  const params = { vs_currency: vs, days };
  const payload = await getJson({ path: `/coins/${coinId}/ohlc`, params, schema: OhlcResponse }, options.apiKey, options);
  return formatOhlc(payload, `${coinId} ${vs} ${days}d`);
}

/** A coin's price history over `window`: the `series` it names, comma separated. */
export async function priceChart(ref: CoinRef, window: ChartWindow, series: string, options: ToolOptions): Promise<string> {
  const { days, vs } = window;
  const params = { vs_currency: vs, days };
  const path = "id" in ref ? `/coins/${ref.id}/market_chart` : `/coins/${ref.platform}/contract/${ref.address}/market_chart`;
  const subject = "id" in ref ? ref.id : `${ref.platform}:${ref.address}`;
  const payload = await getJson({ path, params, schema: ChartResponse }, options.apiKey, options);
  return formatChart(payload, `${subject} ${vs} ${days}d`, series);
}

/** The coins, NFTs and categories trending in the last 24 hours, `limit` rows a section. */
export async function trending(limit: number, options: ToolOptions): Promise<string> {
  const payload = await getJson({ path: "/search/trending", params: {}, schema: TrendingResponse }, options.apiKey, options);
  return formatTrending(payload, limit);
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

export async function searchCoins(query: string, options: ToolOptions): Promise<CoinMatch[]> {
  const stripped = query.trim();
  if (!stripped) {
    throw new CoinGeckoError("query is required");
  }
  const payload = await getJson({ path: "/search", params: { query: stripped }, schema: SearchResponse }, options.apiKey, options);
  const matches: CoinMatch[] = [];
  for (const row of (payload.coins ?? []).slice(0, LIST_CAP)) {
    if (!row.id) {
      continue;
    }
    matches.push({
      id: row.id,
      symbol: (row.symbol ?? "").toUpperCase(),
      name: row.name ?? row.id,
      market_cap_rank: row.market_cap_rank ?? null,
      thumb: row.thumb ?? "",
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
    if (row.usd !== null && row.usd !== undefined) {
      prices[id] = { usd: row.usd, change_24h: row.usd_24h_change ?? null, updated_at: row.last_updated_at ?? null };
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

/** The USD quotes of the coins a comma list of CoinGecko ids names, each id once. */
export async function prices(idList: string, options: ToolOptions): Promise<string> {
  const ids = [
    ...new Set(
      idList
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
