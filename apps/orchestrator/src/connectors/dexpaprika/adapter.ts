import { callTool, ping, DexPaprikaError } from "./client.js";
import { requiredCredential, translated, type Adapter } from "../types.js";

const adapter: Adapter = {
  async validate(creds, ctx) {
    const apiKey = requiredCredential(creds, "token", "api key is required");
    await translated(DexPaprikaError, () => ping(apiKey, { client: ctx.http }));
    return "";
  },
  async call(name, args, creds, ctx) {
    const apiKey = requiredCredential(creds, "token", "DexPaprika API key is missing");
    return translated(DexPaprikaError, () => callTool(name, args, { apiKey, client: ctx.http }));
  },
};

export default adapter;
