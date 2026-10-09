import { callTool, ping, XError } from "./client.js";
import { requiredCredential, translated, type Adapter } from "../types.js";

const adapter: Adapter = {
  async validate(creds, ctx) {
    const apiKey = requiredCredential(creds, "token", "api key is required");
    await translated(XError, () => ping(apiKey, { client: ctx.http }));
    return "";
  },
  async call(name, args, creds, ctx) {
    const apiKey = requiredCredential(creds, "token", "X bearer token is missing");
    return translated(XError, () => callTool(name, args, { apiKey, client: ctx.http }));
  },
};

export default adapter;
