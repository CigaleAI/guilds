import { Type, type Static, type TSchema } from "@sinclair/typebox";

// The CoinGecko responses the tools read. Each object keeps the fields CoinGecko sends beyond the
// ones named; a field the tools print as it comes is `Shown`, since CoinGecko sends a number, a
// string, or null for it depending on the coin.

const Shown = Type.Optional(Type.Unknown());

function Nullable<T extends TSchema>(schema: T) {
  return Type.Optional(Type.Union([schema, Type.Null()]));
}

/** A figure per quote currency, keyed by the currency code. */
export const PerCurrency = Type.Record(Type.String(), Type.Unknown());

/** A chart series: `[timestamp, value, …]` points. */
const Points = Type.Array(Type.Array(Type.Unknown()));

export const SearchResponse = Type.Object({
  coins: Type.Optional(
    Type.Array(Type.Object({ id: Shown, symbol: Shown, name: Shown, market_cap_rank: Shown, thumb: Shown })),
  ),
  nfts: Type.Optional(Type.Array(Type.Object({ id: Shown, symbol: Shown, name: Shown }))),
  categories: Type.Optional(Type.Array(Type.Object({ id: Shown, name: Shown }))),
});
export type SearchResponse = Static<typeof SearchResponse>;

export const CoinResponse = Type.Object({
  id: Shown,
  symbol: Shown,
  name: Shown,
  market_cap_rank: Shown,
  platforms: Nullable(Type.Record(Type.String(), Type.Unknown())),
  asset_platform_id: Shown,
  contract_address: Shown,
  market_data: Nullable(
    Type.Object({
      market_cap_rank: Shown,
      current_price: Shown,
      market_cap: Shown,
      total_volume: Shown,
      circulating_supply: Shown,
      total_supply: Shown,
      price_change_percentage_24h: Shown,
    }),
  ),
});
export type CoinResponse = Static<typeof CoinResponse>;

export const NewCoinsResponse = Type.Array(Type.Object({ id: Shown, symbol: Shown, name: Shown, activated_at: Shown }));
export type NewCoinsResponse = Static<typeof NewCoinsResponse>;

/** A mover's row: its price, volume and change are keyed by the quote currency (`usd`, `usd_24h_vol`, …). */
const Mover = Type.Record(Type.String(), Type.Unknown());
export type Mover = Static<typeof Mover>;

export const MoversResponse = Type.Object({
  top_gainers: Type.Optional(Type.Array(Mover)),
  top_losers: Type.Optional(Type.Array(Mover)),
});
export type MoversResponse = Static<typeof MoversResponse>;

export const SupplyResponse = Type.Object({
  id: Shown,
  symbol: Shown,
  name: Shown,
  supply_data: Nullable(
    Type.Object({
      circulating_supply: Shown,
      total_supply: Shown,
      non_circulating_supply: Shown,
      outstanding_supply: Shown,
    }),
  ),
  non_circulating_wallets: Nullable(
    Type.Array(
      Type.Object({ address: Shown, label: Shown, balance: Shown, percentage_of_total_supply: Shown, anomaly: Shown }),
    ),
  ),
});
export type SupplyResponse = Static<typeof SupplyResponse>;

export const OhlcResponse = Points;
export type OhlcResponse = Static<typeof OhlcResponse>;

export const ChartResponse = Type.Object({
  prices: Type.Optional(Points),
  market_caps: Type.Optional(Points),
  total_volumes: Type.Optional(Points),
});
export type ChartResponse = Static<typeof ChartResponse>;

const TrendingCoin = Type.Object({
  id: Shown,
  symbol: Shown,
  name: Shown,
  market_cap_rank: Shown,
  data: Nullable(Type.Object({ price: Shown, price_change_percentage_24h: Nullable(PerCurrency) })),
});
export type TrendingCoin = Static<typeof TrendingCoin>;

const TrendingNft = Type.Object({
  id: Shown,
  symbol: Shown,
  name: Shown,
  floor_price_in_native_currency: Shown,
  native_currency_symbol: Shown,
  floor_price_24h_percentage_change: Shown,
});
export type TrendingNft = Static<typeof TrendingNft>;

const TrendingCategory = Type.Object({
  id: Shown,
  slug: Shown,
  name: Shown,
  data: Nullable(Type.Object({ market_cap: Shown, market_cap_change_percentage_24h: Nullable(PerCurrency) })),
});
export type TrendingCategory = Static<typeof TrendingCategory>;

export const TrendingResponse = Type.Object({
  coins: Type.Optional(Type.Array(Type.Object({ item: Nullable(TrendingCoin) }))),
  nfts: Type.Optional(Type.Array(TrendingNft)),
  categories: Type.Optional(Type.Array(TrendingCategory)),
});
export type TrendingResponse = Static<typeof TrendingResponse>;

export const PricesResponse = Type.Record(
  Type.String(),
  Type.Object({ usd: Shown, usd_24h_change: Shown, last_updated_at: Shown }),
);
export type PricesResponse = Static<typeof PricesResponse>;

/** An error body: the message sits in `error`, `status` or `message`, as text or one object deeper. */
export const ErrorBody = Type.Object({ error: Shown, status: Shown, message: Shown });

export const ErrorDetail = Type.Object({ error_message: Shown, error: Shown, message: Shown });
