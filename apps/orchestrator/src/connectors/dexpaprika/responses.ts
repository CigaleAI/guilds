import { Type, type Static, type TSchema } from "@sinclair/typebox";

// The DexPaprika responses the tools read. Each object keeps the fields DexPaprika sends beyond
// the ones named.

/** Text DexPaprika sends, sends as null, or leaves out. */
const Text = Type.Optional(Type.Union([Type.String(), Type.Null()]));

/** A figure DexPaprika sends as a number or as numeric text, depending on the pool; null when it has none. */
export const Figure = Type.Union([Type.Number(), Type.String(), Type.Null()]);
export type Figure = Static<typeof Figure>;

/** A figure field, which DexPaprika may also leave out. */
const FigureField = Type.Optional(Figure);

function Nullable<T extends TSchema>(schema: T) {
  return Type.Optional(Type.Union([schema, Type.Null()]));
}

/** The cursor of the next page: at the top, or under `page_info`. */
const Paged = {
  next_cursor: Text,
  page_info: Nullable(Type.Object({ next_cursor: Text })),
};

export const PageInfo = Type.Object(Paged);
export type PageInfo = Static<typeof PageInfo>;

/** A pool; its 24-hour figures go by either of two names, depending on the endpoint. */
export const PoolRow = Type.Object({
  chain: Text,
  id: Text,
  dex_name: Text,
  dex_id: Text,
  pool_name: Text,
  name: Text,
  tokens: Nullable(Type.Array(Type.Object({ symbol: Text }))),
  price_usd: FigureField,
  liquidity_usd: FigureField,
  volume_usd_24h: FigureField,
  volume_usd: FigureField,
  last_price_change_usd_24h: FigureField,
  price_change_percentage_24h: FigureField,
  txns_24h: FigureField,
  transactions: FigureField,
});
export type PoolRow = Static<typeof PoolRow>;

export const SearchResponse = Type.Object({
  tokens: Nullable(Type.Array(Type.Object({ chain: Text, id: Text, symbol: Text, name: Text, price_usd: FigureField }))),
  pools: Nullable(Type.Array(PoolRow)),
  dexes: Nullable(Type.Array(Type.Object({ chain: Text, id: Text, dex_id: Text, dex_name: Text, volume_usd_24h: FigureField }))),
});
export type SearchResponse = Static<typeof SearchResponse>;

export const TokenResponse = Type.Object({
  chain: Text,
  id: Text,
  symbol: Text,
  name: Text,
  summary: Nullable(
    Type.Object({
      chain: Text,
      price_usd: FigureField,
      liquidity_usd: FigureField,
      fdv: FigureField,
      pools: FigureField,
      "24h": Nullable(Type.Object({ volume_usd: FigureField, last_price_usd_change: FigureField })),
    }),
  ),
});
export type TokenResponse = Static<typeof TokenResponse>;

export const PricesResponse = Type.Array(Type.Object({ chain: Text, id: Text, price_usd: FigureField }));
export type PricesResponse = Static<typeof PricesResponse>;

/** A page of pools: a bare list, or an object listing them under `results` or `pools`. */
export const PoolsResponse = Type.Union([
  Type.Array(PoolRow),
  Type.Object({ results: Nullable(Type.Array(PoolRow)), pools: Nullable(Type.Array(PoolRow)), ...Paged }),
]);
export type PoolsResponse = Static<typeof PoolsResponse>;

export const OhlcvResponse = Type.Array(
  Type.Object({
    time_open: Text,
    time_close: Text,
    open: FigureField,
    high: FigureField,
    low: FigureField,
    close: FigureField,
    volume: FigureField,
  }),
);
export type OhlcvResponse = Static<typeof OhlcvResponse>;

const Swap = Type.Object({
  id: Text,
  created_at: Text,
  token_0_symbol: Text,
  token_1_symbol: Text,
  amount_0: FigureField,
  amount_1: FigureField,
  price_0_usd: FigureField,
});

/** A page of swaps: a bare list, or an object listing them under `transactions`. */
export const SwapsResponse = Type.Union([
  Type.Array(Swap),
  Type.Object({ transactions: Nullable(Type.Array(Swap)), ...Paged }),
]);
export type SwapsResponse = Static<typeof SwapsResponse>;

/** The key's usage: `plan` names its plan, `keyless` when the key was not recognised. */
export const UsageResponse = Type.Object({ plan: Text });

/** An error body: the message sits in `message` or `error`. */
export const ErrorBody = Type.Object({ message: Text, error: Text });
export type ErrorBody = Static<typeof ErrorBody>;
