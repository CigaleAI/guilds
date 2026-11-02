import { Type, type Static } from "@sinclair/typebox";
import {
  CoinGeckoError,
  VS_DEFAULT,
  coin,
  movers,
  newCoins,
  ohlcChart,
  ping,
  priceChart,
  prices,
  search,
  supply,
  trending,
  type CoinRef,
  type ToolOptions,
} from "./client.js";
import { given, listRows } from "../format.js";
import { adapterTool, toolsAdapter } from "../tools.js";
import { requiredCredential, translated, type ConnectorContext, type Credentials } from "../types.js";

/** Runs `work` with the login's CoinGecko key and the context's HTTP client, its CoinGecko errors as connector errors. */
function withKey(creds: Credentials, ctx: ConnectorContext, work: (options: ToolOptions) => Promise<string>): Promise<string> {
  const apiKey = requiredCredential(creds, "token", "CoinGecko API key is missing");
  return translated(CoinGeckoError, () => work({ apiKey, client: ctx.http }));
}

const CoinParameters = Type.Object({
  id: Type.Optional(Type.String({ description: "CoinGecko coin id." })),
  platform: Type.Optional(Type.String({ description: "Asset platform id, e.g. ethereum." })),
  address: Type.Optional(Type.String({ description: "Token contract address." })),
});

/** The arguments that name a coin: its id, or a platform and a contract address. */
type CoinArguments = Static<typeof CoinParameters>;

/** The coin the arguments name: by `id`, else by `platform` and `address`; null when they name none. */
function coinOf(input: CoinArguments): CoinRef | null {
  const id = given(input.id);
  if (id) {
    return { id };
  }
  const platform = given(input.platform);
  const address = given(input.address);
  return platform && address ? { platform, address } : null;
}

/** The coin the arguments name; throws when they name none. */
function requiredCoin(input: CoinArguments): CoinRef {
  const ref = coinOf(input);
  if (ref === null) {
    throw new CoinGeckoError("id, or platform and address, is required");
  }
  return ref;
}

const searchTool = adapterTool({
  name: "search",
  parameters: Type.Object({
    query: Type.String({ description: "Name, symbol, or phrase." }),
    limit: Type.Optional(Type.Integer({ description: "Rows per section. Default 15, max 30." })),
  }),
  run: (input, creds, ctx) => withKey(creds, ctx, (options) => search(input.query, listRows(input.limit), options)),
});

const coinTool = adapterTool({
  name: "coin",
  parameters: CoinParameters,
  run: (input, creds, ctx) => withKey(creds, ctx, (options) => coin(requiredCoin(input), options)),
});

const pricesTool = adapterTool({
  name: "prices",
  parameters: Type.Object({
    ids: Type.String({ description: "Comma list of CoinGecko coin ids, at most 50." }),
  }),
  run: (input, creds, ctx) => withKey(creds, ctx, (options) => prices(input.ids, options)),
});

const newTool = adapterTool({
  name: "new",
  parameters: Type.Object({
    limit: Type.Optional(Type.Integer({ description: "Row cap. Default 15, max 30." })),
  }),
  run: (input, creds, ctx) => withKey(creds, ctx, (options) => newCoins(listRows(input.limit), options)),
});

const moversTool = adapterTool({
  name: "movers",
  parameters: Type.Object({
    vs: Type.Optional(Type.String({ description: "Quote currency. Default usd." })),
    duration: Type.Optional(Type.String({ description: "1h, 24h, 7d, 14d, 30d, 60d, or 1y. Default 24h." })),
    top: Type.Optional(Type.String({ description: "Market-cap universe: 300, 500, 1000, or all. Default 1000." })),
    limit: Type.Optional(Type.Integer({ description: "Rows per side. Default 15, max 30." })),
  }),
  run: (input, creds, ctx) =>
    withKey(creds, ctx, (options) =>
      movers(
        {
          vs: given(input.vs, VS_DEFAULT),
          duration: given(input.duration),
          top: given(input.top),
          limit: listRows(input.limit),
        },
        options,
      ),
    ),
});

const supplyTool = adapterTool({
  name: "supply",
  parameters: Type.Object({
    id: Type.String({ description: "CoinGecko coin id." }),
  }),
  run: (input, creds, ctx) => withKey(creds, ctx, (options) => supply(input.id, options)),
});

const chartTool = adapterTool({
  name: "chart",
  parameters: Type.Object({
    id: Type.Optional(Type.String({ description: "CoinGecko coin id." })),
    platform: Type.Optional(Type.String({ description: "Asset platform id." })),
    address: Type.Optional(Type.String({ description: "Token contract address." })),
    days: Type.Optional(Type.String({ description: "Lookback. Default 7. Use max for full range." })),
    kind: Type.Optional(Type.String({ description: "price or ohlc. Default price." })),
    vs: Type.Optional(Type.String({ description: "Quote currency. Default usd." })),
    series: Type.Optional(Type.String({ description: "price, or comma list including mcap and vol." })),
  }),
  run: (input, creds, ctx) =>
    withKey(creds, ctx, (options) => {
      const kind = given(input.kind, "price");
      if (kind !== "price" && kind !== "ohlc") {
        throw new CoinGeckoError("kind must be price or ohlc");
      }
      const ref = coinOf(input);
      const window = { days: given(input.days, "7"), vs: given(input.vs, VS_DEFAULT) };
      if (kind === "ohlc") {
        if (ref === null || !("id" in ref)) {
          throw new CoinGeckoError("ohlc requires coin id");
        }
        return ohlcChart(ref.id, window, options);
      }
      if (ref === null) {
        throw new CoinGeckoError("id, or platform and address, is required");
      }
      return priceChart(ref, window, given(input.series, "price"), options);
    }),
});

const trendingTool = adapterTool({
  name: "trending",
  parameters: Type.Object({
    limit: Type.Optional(Type.Integer({ description: "Rows per section. Default 15, max 30." })),
  }),
  run: (input, creds, ctx) => withKey(creds, ctx, (options) => trending(listRows(input.limit), options)),
});

export default toolsAdapter(
  [searchTool, coinTool, pricesTool, newTool, moversTool, supplyTool, chartTool, trendingTool],
  {
    async validate(creds, ctx) {
      const apiKey = requiredCredential(creds, "token", "api key is required");
      await translated(CoinGeckoError, () => ping(apiKey, { client: ctx.http }));
      return "";
    },
  },
);
