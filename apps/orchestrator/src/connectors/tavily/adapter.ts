import { search, TavilyError } from "./client.js";
import { ConnectorError, requiredCredential, translated, type Adapter } from "../types.js";

const adapter: Adapter = {
  async call(name, args, creds, ctx) {
    if (name !== "search") {
      throw new ConnectorError(`unknown Tavily tool ${name}`, 404);
    }
    const apiKey = requiredCredential(creds, "token", "Tavily API key is missing");
    const query = typeof args.query === "string" ? args.query : "";
    return translated(TavilyError, () => search(query, { apiKey, client: ctx.http }));
  },
};

export default adapter;
