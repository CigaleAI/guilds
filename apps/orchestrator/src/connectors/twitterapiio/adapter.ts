import { callTool, ping, TwitterApiIoError } from "./client.js";
import { requiredCredential, translated, type Adapter } from "../types.js";

const adapter: Adapter = {
  async validate(creds, ctx) {
    const apiKey = requiredCredential(creds, "token", "api key is required");
    await translated(TwitterApiIoError, () => ping(apiKey, { client: ctx.http }));
    return "";
  },
  async call(name, args, creds, ctx) {
    const apiKey = requiredCredential(creds, "token", "TwitterAPI.io API key is missing");
    return translated(TwitterApiIoError, () => callTool(name, args, { apiKey, client: ctx.http }));
  },
};

export default adapter;
