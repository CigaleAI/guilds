import { Type } from "@sinclair/typebox";
import { search, TavilyError } from "./client.js";
import { adapterTool, toolsAdapter } from "../tools.js";
import { requiredCredential, translated } from "../types.js";

/** `search`: the live web for a natural-language query. */
const searchTool = adapterTool({
  name: "search",
  parameters: Type.Object({ query: Type.String() }),
  run: ({ query }, creds, ctx) => {
    const apiKey = requiredCredential(creds, "token", "Tavily API key is missing");
    return translated(TavilyError, () => search(query, { apiKey, client: ctx.http }));
  },
});

export default toolsAdapter([searchTool]);
