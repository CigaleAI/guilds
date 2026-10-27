import { Type, type Static, type TSchema } from "@sinclair/typebox";

// The DexPaprika responses the tools read. Each object keeps the fields DexPaprika sends beyond
// the ones named; a field the tools print as it comes is `Shown`, since DexPaprika sends a number,
// a string, or null for it depending on the pool.

const Shown = Type.Optional(Type.Unknown());

function Nullable<T extends TSchema>(schema: T) {
  return Type.Optional(Type.Union([schema, Type.Null()]));
}

/** The cursor of the next page: at the top, or under `page_info`. */
const Paged = {
  next_cursor: Shown,
  page_info: Nullable(Type.Object({ next_cursor: Shown })),
};

export const PageInfo = Type.Object(Paged);
export type PageInfo = Static<typeof PageInfo>;

/** A pool; its 24-hour figures go by either of two names, depending on the endpoint. */
export const PoolRow = Type.Object({
  chain: Shown,
  id: Shown,
  dex_name: Shown,
  dex_id: Shown,
  pool_name: Shown,
  name: Shown,
  tokens: Nullable(Type.Array(Type.Object({ symbol: Shown }))),
  price_usd: Shown,
  liquidity_usd: Shown,
  volume_usd_24h: Shown,
  volume_usd: Shown,
  last_price_change_usd_24h: Shown,
  price_change_percentage_24h: Shown,
  txns_24h: Shown,
  transactions: Shown,
});
export type PoolRow = Static<typeof PoolRow>;

export const SearchResponse = Type.Object({
  tokens: Nullable(Type.Array(Type.Object({ chain: Shown, id: Shown, symbol: Shown, name: Shown, price_usd: Shown }))),
  pools: Nullable(Type.Array(PoolRow)),
  dexes: Nullable(Type.Array(Type.Object({ chain: Shown, id: Shown, dex_id: Shown, dex_name: Shown, volume_usd_24h: Shown }))),
});
export type SearchResponse = Static<typeof SearchResponse>;

export const TokenResponse = Type.Object({
  chain: Shown,
  id: Shown,
  symbol: Shown,
  name: Shown,
  summary: Nullable(
    Type.Object({
      chain: Shown,
      price_usd: Shown,
      liquidity_usd: Shown,
      fdv: Shown,
      pools: Shown,
      "24h": Nullable(Type.Object({ volume_usd: Shown, last_price_usd_change: Shown })),
    }),
  ),
});
export type TokenResponse = Static<typeof TokenResponse>;

export const PricesResponse = Type.Array(Type.Object({ chain: Shown, id: Shown, price_usd: Shown }));
export type PricesResponse = Static<typeof PricesResponse>;

/** A page of pools: a bare list, or an object listing them under `results` or `pools`. */
export const PoolsResponse = Type.Union([
  Type.Array(PoolRow),
  Type.Object({ results: Nullable(Type.Array(PoolRow)), pools: Nullable(Type.Array(PoolRow)), ...Paged }),
]);
export type PoolsResponse = Static<typeof PoolsResponse>;

export const OhlcvResponse = Type.Array(
  Type.Object({ time_open: Shown, time_close: Shown, open: Shown, high: Shown, low: Shown, close: Shown, volume: Shown }),
);
export type OhlcvResponse = Static<typeof OhlcvResponse>;

const Swap = Type.Object({
  id: Shown,
  created_at: Shown,
  token_0_symbol: Shown,
  token_1_symbol: Shown,
  amount_0: Shown,
  amount_1: Shown,
  price_0_usd: Shown,
});

/** A page of swaps: a bare list, or an object listing them under `transactions`. */
export const SwapsResponse = Type.Union([
  Type.Array(Swap),
  Type.Object({ transactions: Nullable(Type.Array(Swap)), ...Paged }),
]);
export type SwapsResponse = Static<typeof SwapsResponse>;

/** The key's usage: `plan` names its plan, `keyless` when the key was not recognised. */
export const UsageResponse = Type.Object({ plan: Shown });

/** An error body: the message sits in `message` or `error`. */
export const ErrorBody = Type.Object({ message: Shown, error: Shown });
