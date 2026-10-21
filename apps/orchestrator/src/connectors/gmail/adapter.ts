import { callTool, GmailError, ping } from "./client.js";
import { requiredCredential, translated, type Adapter } from "../types.js";

const adapter: Adapter = {
  async validate(creds, ctx) {
    const accessToken = requiredCredential(creds, "access_token", "Gmail access token is missing");
    return translated(GmailError, () => ping(accessToken, { client: ctx.http }));
  },
  async call(name, args, creds, ctx) {
    const accessToken = requiredCredential(creds, "access_token", "Gmail access token is missing");
    const workspace = ctx.workspace_dir ? { workspaceDir: ctx.workspace_dir } : {};
    return translated(GmailError, () => callTool(name, args, { accessToken, client: ctx.http, ...workspace }));
  },
};

export default adapter;
