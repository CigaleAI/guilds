import { ConnectorError, type Adapter } from "../types.js";

/** The tool OpenSea lists to a request whose key it did not accept. */
const INSTANT_KEY_TOOL = "get_instant_api_key";

const adapter: Adapter = {
  async validate(_creds, ctx) {
    const listed = await ctx.remote.list();
    if (listed.every((tool) => tool.name === INSTANT_KEY_TOOL)) {
      throw new ConnectorError("api key was rejected", 401);
    }
    return "";
  },
};

export default adapter;
