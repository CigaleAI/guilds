import { Type, type Static, type TSchema } from "@sinclair/typebox";

// The CoinGecko responses the tools read. Each object keeps the fields CoinGecko sends beyond the
// ones named.

/** Text CoinGecko sends, sends as null, or leaves out. */
const Text = Type.Optional(Type.Union([Type.String(), Type.Null()]));

/** A figure CoinGecko sends as a number or as numeric text, depending on the coin; null when it has none. */
export const Figure = Type.Union([Type.Number(), Type.String(), Type.Null()]);
export type Figure = Static<typeof Figure>;

/** A figure field, which CoinGecko may also leave out. */
const FigureField = Type.Optional(Figure);

/** A coin's market-cap rank; null when it is unranked. */
const Rank = Type.Optional(Type.Union([Type.Number(), Type.Null()]));

/** A Unix time in seconds; null when CoinGecko has none. */
const Seconds = Type.Optional(Type.Union([Type.Number(), Type.Null()]));

function Nullable<T extends TSchema>(schema: T) {
  return Type.Optional(Type.Union([schema, Type.Null()]));
}

/** A figure per quote currency, keyed by the currency code (`usd`, `btc`, …). */
export const PerCurrency = Type.Record(Type.String(), Type.Union([Type.Number(), Type.Null()]));
export type PerCurrency = Static<typeof PerCurrency>;

/** A category's id: its slug in a search, a number in the trending list. */
const CategoryId = Type.Optional(Type.Union([Type.String(), Type.Number()]));

/** A point of a chart series: its time in milliseconds, and the value then. */
export const ChartPoint = Type.Tuple([Type.Number(), Type.Number()]);
export type ChartPoint = Static<typeof ChartPoint>;

/** A candle: its time in milliseconds, then open, high, low and close. */
const Candle = Type.Tuple([Type.Number(), Type.Number(), Type.Number(), Type.Number(), Type.Number()]);

/** The answer to a ping, of which connecting reads only that it is one. */
export const PingResponse = Type.Object({});

export const SearchResponse = Type.Object({
  coins: Type.Optional(
    Type.Array(Type.Object({ id: Text, symbol: Text, name: Text, market_cap_rank: Rank, thumb: Text })),
  ),
  nfts: Type.Optional(Type.Array(Type.Object({ id: Text, symbol: Text, name: Text }))),
  categories: Type.Optional(Type.Array(Type.Object({ id: CategoryId, name: Text }))),
});
export type SearchResponse = Static<typeof SearchResponse>;

export const CoinResponse = Type.Object({
  id: Text,
  symbol: Text,
  name: Text,
  market_cap_rank: Rank,
  /** The coin's contract address on each platform, keyed by the platform id. */
  platforms: Nullable(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
  asset_platform_id: Text,
  contract_address: Text,
  market_data: Nullable(
    Type.Object({
      market_cap_rank: Rank,
      current_price: Nullable(PerCurrency),
      market_cap: Nullable(PerCurrency),
      total_volume: Nullable(PerCurrency),
      circulating_supply: FigureField,
      total_supply: FigureField,
      price_change_percentage_24h: FigureField,
    }),
  ),
});
export type CoinResponse = Static<typeof CoinResponse>;

export const NewCoinsResponse = Type.Array(Type.Object({ id: Text, symbol: Text, name: Text, activated_at: Seconds }));
export type NewCoinsResponse = Static<typeof NewCoinsResponse>;

/** A mover's row: its coin, and its price, volume and change keyed by the quote currency (`usd`, `usd_24h_vol`, …). */
const Mover = Type.Intersect([
  Type.Object({ id: Text, symbol: Text, name: Text, market_cap_rank: Rank }),
  Type.Record(Type.String(), Figure),
]);
export type Mover = Static<typeof Mover>;

export const MoversResponse = Type.Object({
  top_gainers: Type.Optional(Type.Array(Mover)),
  top_losers: Type.Optional(Type.Array(Mover)),
});
export type MoversResponse = Static<typeof MoversResponse>;

export const SupplyResponse = Type.Object({
  id: Text,
  symbol: Text,
  name: Text,
  supply_data: Nullable(
    Type.Object({
      circulating_supply: FigureField,
      total_supply: FigureField,
      non_circulating_supply: FigureField,
      outstanding_supply: FigureField,
    }),
  ),
  non_circulating_wallets: Nullable(
    Type.Array(
      Type.Object({
        address: Text,
        label: Text,
        balance: FigureField,
        percentage_of_total_supply: FigureField,
        anomaly: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
      }),
    ),
  ),
});
export type SupplyResponse = Static<typeof SupplyResponse>;

export const OhlcResponse = Type.Array(Candle);
export type OhlcResponse = Static<typeof OhlcResponse>;

export const ChartResponse = Type.Object({
  prices: Type.Optional(Type.Array(ChartPoint)),
  market_caps: Type.Optional(Type.Array(ChartPoint)),
  total_volumes: Type.Optional(Type.Array(ChartPoint)),
});
export type ChartResponse = Static<typeof ChartResponse>;

const TrendingCoin = Type.Object({
  id: Text,
  symbol: Text,
  name: Text,
  market_cap_rank: Rank,
  data: Nullable(Type.Object({ price: FigureField, price_change_percentage_24h: Nullable(PerCurrency) })),
});
export type TrendingCoin = Static<typeof TrendingCoin>;

const TrendingNft = Type.Object({
  id: Text,
  symbol: Text,
  name: Text,
  floor_price_in_native_currency: FigureField,
  native_currency_symbol: Text,
  floor_price_24h_percentage_change: FigureField,
});
export type TrendingNft = Static<typeof TrendingNft>;

const TrendingCategory = Type.Object({
  id: CategoryId,
  slug: Text,
  name: Text,
  data: Nullable(Type.Object({ market_cap: FigureField, market_cap_change_percentage_24h: Nullable(PerCurrency) })),
});
export type TrendingCategory = Static<typeof TrendingCategory>;

export const TrendingResponse = Type.Object({
  coins: Type.Optional(Type.Array(Type.Object({ item: Nullable(TrendingCoin) }))),
  nfts: Type.Optional(Type.Array(TrendingNft)),
  categories: Type.Optional(Type.Array(TrendingCategory)),
});
export type TrendingResponse = Static<typeof TrendingResponse>;

/** A USD quote, its change and its time; CoinGecko leaves out each it does not have. */
const Quote = Type.Optional(Type.Union([Type.Number(), Type.Null()]));

/** The quotes of coins, keyed by coin id. */
export const PricesResponse = Type.Record(
  Type.String(),
  Type.Object({ usd: Quote, usd_24h_change: Quote, last_updated_at: Quote }),
);
export type PricesResponse = Static<typeof PricesResponse>;

/** An error's detail one object deep: its message in `error_message`, `error` or `message`. */
export const ErrorDetail = Type.Object({ error_message: Text, error: Text, message: Text });

/** Where an error body may carry its message: as text, or as an error detail. */
const ErrorField = Type.Optional(Type.Union([Type.String(), Type.Null(), ErrorDetail]));

/** An error body: the message sits in `error`, `status` or `message`, as text or one object deeper. */
export const ErrorBody = Type.Object({ error: ErrorField, status: ErrorField, message: ErrorField });
export type ErrorBody = Static<typeof ErrorBody>;
