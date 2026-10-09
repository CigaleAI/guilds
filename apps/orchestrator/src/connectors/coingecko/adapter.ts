import { callTool, ping, CoinGeckoError } from "./client.js";
import { requiredCredential, translated, type Adapter } from "../types.js";

const adapter: Adapter = {
  async validate(creds, ctx) {
    const apiKey = requiredCredential(creds, "token", "api key is required");
    await translated(CoinGeckoError, () => ping(apiKey, { client: ctx.http }));
    return "";
  },
  async call(name, args, creds, ctx) {
    const apiKey = requiredCredential(creds, "token", "CoinGecko API key is missing");
    return translated(CoinGeckoError, () => callTool(name, args, { apiKey, client: ctx.http }));
  },
};

export default adapter;
