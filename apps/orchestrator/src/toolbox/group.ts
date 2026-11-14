import { Type } from "typebox";
import { nativeTool } from "./types.js";
import { ToolUnavailableError } from "./errors.js";

const DESCRIPTION =
  "Post a public message to this agent's guild chat. The chat is only for " +
  "coordination: handing a task to another agent, asking another agent for help " +
  "or a question, and talking with an operator. Work products stay in their " +
  "canonical artifact; do not post them or unsolicited status. Format cleanly " +
  "using Markdown with line breaks, paragraphs, and bullet points where " +
  "appropriate. Tag @agent-name to ask that agent to reply, @operator-name to " +
  "ask that operator, or @user to ask every operator. Untagged posts do not ask " +
  "anyone to reply. content must contain non-whitespace text.";

export const groupPost = nativeTool({
  name: "group_post",
  description: DESCRIPTION,
  parameters: Type.Object({ content: Type.String() }),
  async handler(services, run, _hooks, { arguments: args }) {
    const chat = services.group_chat;
    if (chat === null) {
      throw new ToolUnavailableError("group chat is not available");
    }
    if (chat.postFromRun) {
      return chat.postFromRun(run.run_id, run.agent_id, run.guild_id, run.agent_name, args.content);
    }
    throw new ToolUnavailableError("group chat is not available");
  },
});
