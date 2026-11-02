import { Type } from "@sinclair/typebox";
import {
  DexPaprikaError,
  NETWORK_HINT,
  ohlcv,
  ping,
  pool,
  pools,
  prices,
  search,
  swaps,
  token,
  type ToolOptions,
} from "./client.js";
import { given, listRows } from "../format.js";
import { adapterTool, toolsAdapter } from "../tools.js";
import { requiredCredential, translated, type ConnectorContext, type Credentials } from "../types.js";

/** Runs `work` with the login's DexPaprika key and the context's HTTP client, its DexPaprika errors as connector errors. */
function withKey(creds: Credentials, ctx: ConnectorContext, work: (options: ToolOptions) => Promise<string>): Promise<string> {
  const apiKey = requiredCredential(creds, "token", "DexPaprika API key is missing");
  return translated(DexPaprikaError, () => work({ apiKey, client: ctx.http }));
}

const network = Type.String({ description: NETWORK_HINT });

const searchTool = adapterTool({
  name: "search",
  parameters: Type.Object({
    query: Type.String({ description: "Name, symbol, or contract address." }),
    limit: Type.Optional(Type.Integer({ description: "Rows per section. Default 15, max 30." })),
  }),
  run: (input, creds, ctx) => withKey(creds, ctx, (options) => search(input.query, listRows(input.limit), options)),
});

const tokenTool = adapterTool({
  name: "token",
  parameters: Type.Object({
    network,
    address: Type.String({ description: "Token contract address." }),
  }),
  run: (input, creds, ctx) => withKey(creds, ctx, (options) => token(input.network, input.address, options)),
});

const pricesTool = adapterTool({
  name: "prices",
  parameters: Type.Object({
    network,
    tokens: Type.String({ description: "Comma list of token addresses, at most 10." }),
  }),
  run: (input, creds, ctx) => withKey(creds, ctx, (options) => prices(input.network, input.tokens, options)),
});

const poolTool = adapterTool({
  name: "pool",
  parameters: Type.Object({
    network,
    address: Type.String({ description: "Pool address." }),
  }),
  run: (input, creds, ctx) => withKey(creds, ctx, (options) => pool(input.network, input.address, options)),
});

const poolsTool = adapterTool({
  name: "pools",
  parameters: Type.Object({
    network,
    token: Type.Optional(Type.String({ description: "Token contract address." })),
    dex: Type.Optional(Type.String({ description: "DEX id, e.g. uniswap_v3." })),
    created_after: Type.Optional(
      Type.String({ description: "Creation window start: -24h, Unix seconds, RFC3339, or YYYY-MM-DD." }),
    ),
    order_by: Type.Optional(
      Type.String({
        description:
          "volume_usd_24h, volume_usd_7d, volume_usd_30d, liquidity_usd, txns_24h, price_usd, created_at. Default volume_usd_24h.",
      }),
    ),
    sort: Type.Optional(Type.String({ description: "asc or desc. Default desc." })),
    cursor: Type.Optional(Type.String({ description: "Continue from a previous next_cursor." })),
    limit: Type.Optional(Type.Integer({ description: "Rows this page. Default 15, max 30." })),
  }),
  run: (input, creds, ctx) =>
    withKey(creds, ctx, (options) =>
      pools(
        {
          network: input.network,
          limit: listRows(input.limit),
          token: given(input.token),
          dex: given(input.dex),
          createdAfter: given(input.created_after),
          orderBy: given(input.order_by),
          sort: given(input.sort),
          cursor: given(input.cursor),
        },
        options,
      ),
    ),
});

const ohlcvTool = adapterTool({
  name: "ohlcv",
  parameters: Type.Object({
    network,
    address: Type.String({ description: "Pool address." }),
    start: Type.Optional(Type.String({ description: "Window start. Default -24h." })),
    end: Type.Optional(Type.String({ description: "Window end. Same formats as start." })),
    interval: Type.Optional(Type.String({ description: "1m, 5m, 10m, 15m, 30m, 1h, 6h, 12h, 24h. Default 1h." })),
  }),
  run: (input, creds, ctx) =>
    withKey(creds, ctx, (options) =>
      ohlcv(
        {
          network: input.network,
          address: input.address,
          start: given(input.start, "-24h"),
          end: given(input.end),
          interval: given(input.interval, "1h"),
        },
        options,
      ),
    ),
});

const swapsTool = adapterTool({
  name: "swaps",
  parameters: Type.Object({
    network,
    address: Type.String({ description: "Pool address." }),
    from: Type.Optional(Type.String({ description: "Inclusive start: -1h, Unix seconds, RFC3339, or YYYY-MM-DD." })),
    to: Type.Optional(Type.String({ description: "Exclusive end. Same formats as from." })),
    cursor: Type.Optional(Type.String({ description: "Transaction id from a previous page." })),
    limit: Type.Optional(Type.Integer({ description: "Rows this page. Default 15, max 30." })),
  }),
  run: (input, creds, ctx) =>
    withKey(creds, ctx, (options) =>
      swaps(
        {
          network: input.network,
          address: input.address,
          from: given(input.from),
          to: given(input.to),
          cursor: given(input.cursor),
          limit: listRows(input.limit),
        },
        options,
      ),
    ),
});

export default toolsAdapter([searchTool, tokenTool, pricesTool, poolTool, poolsTool, ohlcvTool, swapsTool], {
  async validate(creds, ctx) {
    const apiKey = requiredCredential(creds, "token", "api key is required");
    await translated(DexPaprikaError, () => ping(apiKey, { client: ctx.http }));
    return "";
  },
});
