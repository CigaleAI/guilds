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

function currency(value: unknown, vs: string): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const mapped = value as Record<string, unknown>;
    if (vs in mapped) {
      return fmtNum(mapped[vs]);
    }
    if ("usd" in mapped) {
      return fmtNum(mapped.usd);
    }
    return "-";
  }
  return fmtNum(value);
}

function section(title: string, rows: string[], limit: number): string {
  const body = clipRows(rows.filter(Boolean), limit);
  if (body === "no results") {
    return "";
  }
  return `${title}\n${body}`;
}

function pairs(payload: Record<string, unknown>, keys: string[]): Array<[unknown, unknown]> {
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value) && value.length) {
      return value.filter((point) => Array.isArray(point) && point.length >= 2) as Array<
        [unknown, unknown]
      >;
    }
  }
  return [];
}

export function formatSearch(payload: Record<string, unknown>, limit = LIST_DEFAULT): string {
  const blocks: string[] = [];
  const coins = payload.coins;
  if (Array.isArray(coins) && coins.length) {
    const rows: string[] = [];
    for (const item of coins) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const row = item as Record<string, unknown>;
      rows.push(joinParts(row.id, row.symbol, row.name, rank(row.market_cap_rank)));
    }
    blocks.push(section("coins", rows, limit));
  }
  const nfts = payload.nfts;
  if (Array.isArray(nfts) && nfts.length) {
    const lines: string[] = [];
    for (const item of nfts) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const row = item as Record<string, unknown>;
      lines.push(joinParts(row.id, row.symbol, row.name));
    }
    blocks.push(section("nfts", lines, limit));
  }
  const categories = payload.categories;
  if (Array.isArray(categories) && categories.length) {
    const lines: string[] = [];
    for (const item of categories) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const row = item as Record<string, unknown>;
      lines.push(joinParts(row.id, row.name));
    }
    blocks.push(section("categories", lines, limit));
  }
  const shown = blocks.filter(Boolean);
  return shown.length ? shown.join("\n\n") : "no results";
}

export function formatPlatforms(payload: Record<string, unknown>): string {
  const found: string[] = [];
  const platforms = payload.platforms;
  if (platforms && typeof platforms === "object" && !Array.isArray(platforms)) {
    for (const [chain, address] of Object.entries(platforms as Record<string, unknown>)) {
      if (typeof chain === "string" && typeof address === "string" && address.trim()) {
        found.push(`${chain}=${address.trim()}`);
      }
    }
  }
  if (!found.length) {
    const platform = payload.asset_platform_id;
    const address = payload.contract_address;
    if (typeof platform === "string" && typeof address === "string" && address.trim()) {
      found.push(`${platform}=${address.trim()}`);
    }
  }
  return found.join("  ");
}

export function formatCoin(payload: Record<string, unknown>, vs = VS_DEFAULT): string {
  if (!payload || Object.keys(payload).length === 0) {
    return "no results";
  }
  const market =
    payload.market_data && typeof payload.market_data === "object" && !Array.isArray(payload.market_data)
      ? (payload.market_data as Record<string, unknown>)
      : {};
  let rankValue = payload.market_cap_rank;
  if (rankValue === null || rankValue === undefined) {
    rankValue = market.market_cap_rank;
  }
  const head = joinParts(payload.id, payload.symbol, payload.name, rank(rankValue));
  const stats = joinParts(
    `p=${currency(market.current_price, vs)}`,
    `mcap=${currency(market.market_cap, vs)}`,
    `vol=${currency(market.total_volume, vs)}`,
    `circ=${fmtNum(market.circulating_supply)}`,
    `total=${fmtNum(market.total_supply)}`,
    `chg_24h=${pct(market.price_change_percentage_24h)}`,
  );
  const platforms = formatPlatforms(payload);
  return [head, stats, platforms].filter(Boolean).join("\n");
}

export function formatNew(payload: unknown, limit = LIST_DEFAULT): string {
  if (!Array.isArray(payload)) {
    return "no results";
  }
  const rows: string[] = [];
  for (const item of payload) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const row = item as Record<string, unknown>;
    rows.push(joinParts(row.id, row.symbol, row.name, row.activated_at));
  }
  return clipRows(rows, limit);
}

export function formatMovers(
  payload: Record<string, unknown>,
  vs = VS_DEFAULT,
  limit = LIST_DEFAULT,
): string {
  const blocks: string[] = [];
  for (const [key, label] of [
    ["top_gainers", "gainers"],
    ["top_losers", "losers"],
  ] as const) {
    const items = payload[key];
    if (!Array.isArray(items) || !items.length) {
      continue;
    }
    const rows: string[] = [];
    for (const item of items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const row = item as Record<string, unknown>;
      let change = row[`${vs}_24h_change`];
      if (change === null || change === undefined) {
        change = row.usd_24h_change;
      }
      rows.push(
        joinParts(
          row.id,
          row.symbol,
          row.name,
          rank(row.market_cap_rank),
          fmtNum(row[vs] ?? row.usd),
          fmtNum(row[`${vs}_24h_vol`] ?? row.usd_24h_vol),
          pct(change),
        ),
      );
    }
    blocks.push(section(label, rows, limit));
  }
  return blocks.length ? blocks.join("\n\n") : "no results";
}

export function formatSupply(payload: Record<string, unknown>): string {
  if (!payload || Object.keys(payload).length === 0) {
    return "no results";
  }
  const data =
    payload.supply_data && typeof payload.supply_data === "object" && !Array.isArray(payload.supply_data)
      ? (payload.supply_data as Record<string, unknown>)
      : {};
  const head = joinParts(payload.id, payload.symbol, payload.name);
  const stats = joinParts(
    `circ=${fmtNum(data.circulating_supply)}`,
    `total=${fmtNum(data.total_supply)}`,
    `locked=${fmtNum(data.non_circulating_supply)}`,
    `outstanding=${fmtNum(data.outstanding_supply)}`,
  );
  const lines = [head, stats];
  const wallets = payload.non_circulating_wallets;
  if (Array.isArray(wallets) && wallets.length) {
    lines.push("wallets");
    for (const wallet of wallets.slice(0, LIST_CAP)) {
      if (!wallet || typeof wallet !== "object" || Array.isArray(wallet)) {
        continue;
      }
      const row = wallet as Record<string, unknown>;
      const mark = row.anomaly ? " anomaly" : "";
      lines.push(
        joinParts(row.address, row.label, fmtNum(row.balance), pct(row.percentage_of_total_supply)) + mark,
      );
    }
  }
  return lines.filter(Boolean).join("\n");
}

export function formatChart(
  payload: unknown,
  options: { title: string; kind?: string; series?: string },
): string {
  const kind = options.kind ?? "price";
  const series = options.series ?? "price";
  if (kind === "ohlc") {
    const points = Array.isArray(payload) ? payload : [];
    const rows: string[] = [];
    for (const point of downsample(points, CHART_POINTS)) {
      if (!Array.isArray(point) || point.length < 5) {
        continue;
      }
      rows.push(joinParts(tsSec(point[0]), fmtNum(point[1]), fmtNum(point[2]), fmtNum(point[3]), fmtNum(point[4])));
    }
    const header = `${options.title} ohlc n=${rows.length}`;
    return rows.length ? [header, "t  o  h  l  c", ...rows].join("\n") : `${header}\nno results`;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return `${options.title}\nno results`;
  }
  const body = payload as Record<string, unknown>;
  const wanted = new Set(
    series
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
  if (!wanted.size) {
    wanted.add("price");
  }
  const price = pairs(body, ["prices"]);
  const mcap = pairs(body, ["market_caps"]);
  const volume = pairs(body, ["total_volumes"]);
  const base = downsample(price.length ? price : mcap.length ? mcap : volume, CHART_POINTS);
  const columns: Array<[string, string[]]> = [["t", base.map((point) => tsSec(point[0]))]];
  if (wanted.has("price")) {
    columns.push(["p", downsample(price.length ? price : base, CHART_POINTS).map((point) => fmtNum(point[1]))]);
  }
  if (wanted.has("mcap")) {
    columns.push(["m", downsample(mcap.length ? mcap : base, CHART_POINTS).map((point) => fmtNum(point[1]))]);
  }
  if (wanted.has("vol")) {
    columns.push(["v", downsample(volume.length ? volume : base, CHART_POINTS).map((point) => fmtNum(point[1]))]);
  }
  const width = columns.length ? Math.min(...columns.map((column) => column[1].length)) : 0;
  if (width === 0) {
    return `${options.title} n=0\nno results`;
  }
  const header = `${options.title} n=${width}`;
  const labels = columns.map(([name]) => name).join("  ");
  const rows = Array.from({ length: width }, (_, index) =>
    columns.map((column) => column[1][index]).join("  "),
  );
  return [header, labels, ...rows].join("\n");
}

export function formatTrending(payload: Record<string, unknown>, limit = LIST_DEFAULT): string {
  const blocks: string[] = [];
  const coins = payload.coins;
  if (Array.isArray(coins) && coins.length) {
    const rows: string[] = [];
    for (const wrapper of coins) {
      const item =
        wrapper && typeof wrapper === "object" && !Array.isArray(wrapper)
          ? (wrapper as { item?: unknown }).item
          : undefined;
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const row = item as Record<string, unknown>;
      const data =
        row.data && typeof row.data === "object" && !Array.isArray(row.data)
          ? (row.data as Record<string, unknown>)
          : {};
      const change = data.price_change_percentage_24h;
      const usdChange =
        change && typeof change === "object" && !Array.isArray(change)
          ? (change as Record<string, unknown>).usd
          : undefined;
      rows.push(
        joinParts(row.id, row.symbol, row.name, rank(row.market_cap_rank), fmtNum(data.price), pct(usdChange)),
      );
    }
    blocks.push(section("coins", rows, limit));
  }
  const nfts = payload.nfts;
  if (Array.isArray(nfts) && nfts.length) {
    const rows: string[] = [];
    for (const item of nfts) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const row = item as Record<string, unknown>;
      rows.push(
        joinParts(
          row.id,
          row.symbol,
          row.name,
          fmtNum(row.floor_price_in_native_currency),
          row.native_currency_symbol,
          pct(row.floor_price_24h_percentage_change),
        ),
      );
    }
    blocks.push(section("nfts", rows, limit));
  }
  const categories = payload.categories;
  if (Array.isArray(categories) && categories.length) {
    const rows: string[] = [];
    for (const item of categories) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const row = item as Record<string, unknown>;
      const data =
        row.data && typeof row.data === "object" && !Array.isArray(row.data)
          ? (row.data as Record<string, unknown>)
          : {};
      const change = data.market_cap_change_percentage_24h;
      const usdChange =
        change && typeof change === "object" && !Array.isArray(change)
          ? (change as Record<string, unknown>).usd
          : undefined;
      rows.push(joinParts(row.slug ?? row.id, row.name, fmtNum(data.market_cap), pct(usdChange)));
    }
    blocks.push(section("categories", rows, limit));
  }
  return blocks.length ? blocks.join("\n\n") : "no results";
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
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const detail =
      (payload as { error?: unknown; status?: unknown; message?: unknown }).error
      ?? (payload as { status?: unknown }).status
      ?? (payload as { message?: unknown }).message;
    if (typeof detail === "string" && detail.trim()) {
      return detail.trim();
    }
    if (detail && typeof detail === "object" && !Array.isArray(detail)) {
      const inner =
        (detail as { error_message?: unknown; error?: unknown; message?: unknown }).error_message
        ?? (detail as { error?: unknown }).error
        ?? (detail as { message?: unknown }).message;
      if (typeof inner === "string" && inner.trim()) {
        return inner.trim();
      }
    }
  }
  return `CoinGecko HTTP ${response.status}`;
}

async function getJson(
  path: string,
  params: Record<string, string>,
  apiKey: string,
  options: { client?: FetchFn; proxyUrl?: string } = {},
): Promise<unknown> {
  const key = apiKey.trim();
  if (!key) {
    throw new CoinGeckoError("CoinGecko API key is missing", 401);
  }
  const fetchFn = options.client ?? proxyFetch(options.proxyUrl ?? "");
  const response = await fetchFn(withQuery(`${PRO_BASE}${path}`, params), {
    method: "GET",
    headers: { "x-cg-pro-api-key": key, Accept: "application/json" },
  });
  if (response.status >= 400) {
    throw new CoinGeckoError(await errorDetail(response), response.status);
  }
  try {
    return JSON.parse(await response.text());
  } catch {
    throw new CoinGeckoError("CoinGecko returned a non-JSON body");
  }
}

function idOrContract(
  arguments_: Record<string, unknown>,
  options: { required?: boolean; idKey?: string } = {},
): [string, string, string] {
  const required = options.required ?? true;
  const idKey = options.idKey ?? "id";
  const coinId = argStr(arguments_, idKey);
  const platform = argStr(arguments_, "platform");
  const address = argStr(arguments_, "address");
  if (coinId) {
    return [coinId, "", ""];
  }
  if (platform && address) {
    return ["", platform, address];
  }
  if (required) {
    throw new CoinGeckoError(`${idKey}, or platform and address, is required`);
  }
  return ["", platform, address];
}

export async function ping(
  apiKey: string,
  options: { client?: FetchFn; proxyUrl?: string } = {},
): Promise<void> {
  await getJson("/ping", {}, apiKey, options);
}

export async function searchTool(
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const query = argStr(arguments_, "query");
  if (!query) {
    throw new CoinGeckoError("query is required");
  }
  const payload = await getJson("/search", { query }, options.apiKey, options);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CoinGeckoError("CoinGecko returned a non-object");
  }
  return formatSearch(payload as Record<string, unknown>, rowLimit(arguments_));
}

export async function coinTool(
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const [coinId, platform, address] = idOrContract(arguments_);
  const params = {
    localization: "false",
    tickers: "false",
    market_data: "true",
    sparkline: "false",
  };
  const payload = coinId
    ? await getJson(`/coins/${coinId}`, params, options.apiKey, options)
    : await getJson(`/coins/${platform}/contract/${address}`, params, options.apiKey, options);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CoinGeckoError("CoinGecko returned a non-object");
  }
  return formatCoin(payload as Record<string, unknown>);
}

export async function newTool(
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const payload = await getJson("/coins/list/new", {}, options.apiKey, options);
  return formatNew(payload, rowLimit(arguments_));
}

export async function moversTool(
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
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
  const payload = await getJson("/coins/top_gainers_losers", params, options.apiKey, options);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CoinGeckoError("CoinGecko returned a non-object");
  }
  return formatMovers(payload as Record<string, unknown>, vs, rowLimit(arguments_));
}

export async function supplyTool(
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const coinId = argStr(arguments_, "id");
  if (!coinId) {
    throw new CoinGeckoError("id is required");
  }
  const payload = await getJson(`/coins/${coinId}/supply_breakdown`, {}, options.apiKey, options);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CoinGeckoError("CoinGecko returned a non-object");
  }
  return formatSupply(payload as Record<string, unknown>);
}

export async function chartTool(
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const [coinId, platform, address] = idOrContract(arguments_, { required: false });
  const days = argStr(arguments_, "days", "7") || "7";
  const kind = argStr(arguments_, "kind", "price") || "price";
  const vs = argStr(arguments_, "vs", VS_DEFAULT) || VS_DEFAULT;
  const series = argStr(arguments_, "series", "price") || "price";
  if (kind !== "price" && kind !== "ohlc") {
    throw new CoinGeckoError("kind must be price or ohlc");
  }
  if (kind === "ohlc" && !coinId) {
    throw new CoinGeckoError("ohlc requires coin id");
  }
  if (!coinId && !(platform && address)) {
    throw new CoinGeckoError("id, or platform and address, is required");
  }
  const params = { vs_currency: vs, days };
  if (kind === "ohlc") {
    const payload = await getJson(`/coins/${coinId}/ohlc`, params, options.apiKey, options);
    return formatChart(payload, { title: `${coinId} ${vs} ${days}d`, kind: "ohlc" });
  }
  const path = coinId
    ? `/coins/${coinId}/market_chart`
    : `/coins/${platform}/contract/${address}/market_chart`;
  const title = coinId ? `${coinId} ${vs} ${days}d` : `${platform}:${address} ${vs} ${days}d`;
  const payload = await getJson(path, params, options.apiKey, options);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CoinGeckoError("CoinGecko returned a non-object");
  }
  return formatChart(payload, { title, series });
}

export async function trendingTool(
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const payload = await getJson("/search/trending", {}, options.apiKey, options);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CoinGeckoError("CoinGecko returned a non-object");
  }
  return formatTrending(payload as Record<string, unknown>, rowLimit(arguments_));
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

export async function searchCoins(
  query: string,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<CoinMatch[]> {
  const text = query.trim();
  if (!text) {
    throw new CoinGeckoError("query is required");
  }
  const payload = await getJson("/search", { query: text }, options.apiKey, options);
  const coins =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { coins?: unknown }).coins
      : undefined;
  if (!Array.isArray(coins)) {
    return [];
  }
  const matches: CoinMatch[] = [];
  for (const item of coins.slice(0, LIST_CAP)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const row = item as Record<string, unknown>;
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

export async function simplePrices(
  ids: string[],
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<Record<string, CoinPrice>> {
  if (!ids.length) {
    return {};
  }
  const payload = await getJson(
    "/simple/price",
    {
      ids: ids.join(","),
      vs_currencies: VS_DEFAULT,
      include_24hr_change: "true",
      include_last_updated_at: "true",
    },
    options.apiKey,
    options,
  );
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CoinGeckoError("CoinGecko returned a non-object");
  }
  const prices: Record<string, CoinPrice> = {};
  for (const [id, value] of Object.entries(payload as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const row = value as Record<string, unknown>;
    const usd = finite(row.usd);
    if (usd === null) {
      continue;
    }
    prices[id] = {
      usd,
      change_24h: finite(row.usd_24h_change),
      updated_at: finite(row.last_updated_at),
    };
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

export async function pricesTool(
  arguments_: Record<string, unknown>,
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
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

const HANDLERS: Record<
  string,
  (
    arguments_: Record<string, unknown>,
    options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
  ) => Promise<string>
> = {
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
  options: { apiKey: string; client?: FetchFn; proxyUrl?: string },
): Promise<string> {
  const handler = HANDLERS[name];
  if (!handler) {
    throw new CoinGeckoError(`unknown CoinGecko tool ${name}`);
  }
  return handler(arguments_, options);
}
