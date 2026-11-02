import { Type } from "typebox";
import {
  followers,
  following,
  mentions,
  ping,
  post,
  posts,
  quotes,
  replies,
  search,
  trends,
  TwitterApiIoError,
  user,
  type ListPage,
} from "./client.js";
import { listRows } from "../format.js";
import { adapterTool, Paged, toolsAdapter, type PagedArguments } from "../tools.js";
import { requiredCredential, translated, type ConnectorContext, type Credentials } from "../types.js";


/** A user named by username or by id. */
const AnyUser = Type.String({ description: "Username (@optional) or user id." });

/** A user named by username. */
const UserName = Type.String({ description: "Username (@optional)." });

const PostRef = Type.String({ description: "Post id or status URL." });

/** The page a call's arguments ask for. */
function listPage(input: PagedArguments): ListPage {
  return { rows: listRows(input.limit), cursor: input.page_key };
}

/** The client's options for a call made with `creds`. */
function options(creds: Credentials, ctx: ConnectorContext) {
  return { apiKey: requiredCredential(creds, "token", "TwitterAPI.io API key is missing"), client: ctx.http };
}

const searchTool = adapterTool({
  name: "search",
  parameters: Type.Object({
    query: Type.String({
      description: "Search query. Operators such as from:user work. Time range is always the last 24 hours.",
    }),
    ...Paged,
  }),
  run: (input, creds, ctx) =>
    translated(TwitterApiIoError, () => search(input.query, listPage(input), options(creds, ctx))),
});

const userTool = adapterTool({
  name: "user",
  parameters: Type.Object({ user: AnyUser }),
  run: (input, creds, ctx) => translated(TwitterApiIoError, () => user(input.user, options(creds, ctx))),
});

const postsTool = adapterTool({
  name: "posts",
  parameters: Type.Object({ user: AnyUser, ...Paged }),
  run: (input, creds, ctx) =>
    translated(TwitterApiIoError, () => posts(input.user, listPage(input), options(creds, ctx))),
});

const postTool = adapterTool({
  name: "post",
  parameters: Type.Object({ id: PostRef }),
  run: (input, creds, ctx) => translated(TwitterApiIoError, () => post(input.id, options(creds, ctx))),
});

const followersTool = adapterTool({
  name: "followers",
  parameters: Type.Object({ user: UserName, ...Paged }),
  run: (input, creds, ctx) =>
    translated(TwitterApiIoError, () => followers(input.user, listPage(input), options(creds, ctx))),
});

const followingTool = adapterTool({
  name: "following",
  parameters: Type.Object({ user: UserName, ...Paged }),
  run: (input, creds, ctx) =>
    translated(TwitterApiIoError, () => following(input.user, listPage(input), options(creds, ctx))),
});

const mentionsTool = adapterTool({
  name: "mentions",
  parameters: Type.Object({ user: UserName, ...Paged }),
  run: (input, creds, ctx) =>
    translated(TwitterApiIoError, () => mentions(input.user, listPage(input), options(creds, ctx))),
});

const repliesTool = adapterTool({
  name: "replies",
  parameters: Type.Object({ id: PostRef, ...Paged }),
  run: (input, creds, ctx) =>
    translated(TwitterApiIoError, () => replies(input.id, listPage(input), options(creds, ctx))),
});

const quotesTool = adapterTool({
  name: "quotes",
  parameters: Type.Object({ id: PostRef, ...Paged }),
  run: (input, creds, ctx) =>
    translated(TwitterApiIoError, () => quotes(input.id, listPage(input), options(creds, ctx))),
});

const trendsTool = adapterTool({
  name: "trends",
  parameters: Type.Object({
    woeid: Type.Optional(Type.String({ description: "Yahoo WOEID. Default 1 (worldwide)." })),
    limit: Paged.limit,
  }),
  run: (input, creds, ctx) =>
    translated(TwitterApiIoError, () => trends(input.woeid, listRows(input.limit), options(creds, ctx))),
});

export default toolsAdapter(
  [
    searchTool,
    userTool,
    postsTool,
    postTool,
    followersTool,
    followingTool,
    mentionsTool,
    repliesTool,
    quotesTool,
    trendsTool,
  ],
  {
    async validate(creds, ctx) {
      const apiKey = requiredCredential(creds, "token", "api key is required");
      await translated(TwitterApiIoError, () => ping(apiKey, { client: ctx.http }));
      return "";
    },
  },
);
