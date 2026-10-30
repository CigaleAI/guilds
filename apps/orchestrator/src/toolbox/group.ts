import { argString, functionSchema } from "./schema.js";
import { identityOutput } from "./output.js";
import type { Tool } from "./types.js";
import { ToolUnavailableError } from "./errors.js";

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
  async handler(services, run, _hooks, { arguments: args }) {
    const chat = services.group_chat;
    if (chat === null) {
      throw new ToolUnavailableError("group chat is not available");
    }
    if (chat.postFromRun) {
      return chat.postFromRun(run.run_id, run.agent_id, run.guild_id, run.agent_name, argString(args, "content"));
    }
    throw new ToolUnavailableError("group chat is not available");
  },
};
