import { argString, functionSchema } from "./schema.js";
import { identityOutput } from "./output.js";
import type { Tool, ToolContext } from "./types.js";

export const groupPost: Tool = {
  name: "group_post",
  description:
    "Post a public message to this agent's guild chat. Format cleanly using " +
    "Markdown with line breaks, paragraphs, and bullet points where appropriate. " +
    "Tag @agent-name to ask that agent to reply, or @user to ask the operator. " +
    "Untagged posts do not ask anyone to reply. content must contain non-whitespace " +
    "text.",
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema(
    "group_post",
    "Post a public message to this agent's guild chat. Format cleanly using " +
      "Markdown with line breaks, paragraphs, and bullet points where appropriate. " +
      "Tag @agent-name to ask that agent to reply, or @user to ask the operator. " +
      "Untagged posts do not ask anyone to reply. content must contain non-whitespace " +
      "text.",
    {
      content: { type: "string" },
    },
    ["content"],
  ),
  async handler(ctx: ToolContext, { arguments: args }) {
    const chat = ctx.group_chat;
    if (chat === null) {
      throw new Error("group chat is not available");
    }
    if (chat.postFromRun) {
      return chat.postFromRun(ctx.run_id, ctx.agent_id, ctx.guild_id, ctx.agent_name, argString(args, "content"));
    }
    throw new Error("group chat is not available");
  },
};
