import { Type } from "typebox";
import { ping, post, posts, search, user, XError, type ListPage } from "./client.js";
import { listRows } from "../format.js";
import { adapterTool, Paged, toolsAdapter, type PagedArguments } from "../tools.js";
import { requiredCredential, translated, type ConnectorContext, type Credentials } from "../types.js";


const User = Type.String({ description: "Username (@optional) or user id." });

/** The page a call's arguments ask for. */
function listPage(input: PagedArguments): ListPage {
  return { rows: listRows(input.limit), token: input.page_key };
}

/** The client's options for a call made with `creds`. */
function options(creds: Credentials, ctx: ConnectorContext) {
  return { apiKey: requiredCredential(creds, "token", "X bearer token is missing"), client: ctx.http };
}

const searchTool = adapterTool({
  name: "search",
  parameters: Type.Object({
    query: Type.String({ description: "Search query. Operators such as from:user work." }),
    ...Paged,
  }),
  run: (input, creds, ctx) => translated(XError, () => search(input.query, listPage(input), options(creds, ctx))),
});

const userTool = adapterTool({
  name: "user",
  parameters: Type.Object({ user: User }),
  run: (input, creds, ctx) => translated(XError, () => user(input.user, options(creds, ctx))),
});

const postsTool = adapterTool({
  name: "posts",
  parameters: Type.Object({ user: User, ...Paged }),
  run: (input, creds, ctx) => translated(XError, () => posts(input.user, listPage(input), options(creds, ctx))),
});

const postTool = adapterTool({
  name: "post",
  parameters: Type.Object({ id: Type.String({ description: "Post id or status URL." }) }),
  run: (input, creds, ctx) => translated(XError, () => post(input.id, options(creds, ctx))),
});

export default toolsAdapter([searchTool, userTool, postsTool, postTool], {
  async validate(creds, ctx) {
    const apiKey = requiredCredential(creds, "token", "api key is required");
    await translated(XError, () => ping(apiKey, { client: ctx.http }));
    return "";
  },
});
