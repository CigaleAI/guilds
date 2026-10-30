import { IssueError } from "../issues/index.js";
import { argString, functionSchema } from "./schema.js";
import { identityOutput } from "./output.js";
import type { Tool } from "./types.js";
import { ToolUnavailableError } from "./errors.js";

const DESCRIPTION =
  "Report a problem with this agent's tooling or platform to the operator. " +
  "Use when a tool call fails, a result is truncated, an API or MCP login errors, " +
  "or the sandbox otherwise blocks the work this run needs. Do not use for missing " +
  "facts, Task questions, or ordinary empty search results. kind is tool_failure, " +
  "truncated, api, or other. Name the failing tool when you know it. summary is one " +
  "line; detail is what happened and any error text.";

export const reportIssue: Tool = {
  name: "report_issue",
  description: DESCRIPTION,
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema(
    "report_issue",
    DESCRIPTION,
    {
      summary: {
        type: "string",
        description: "one-line title, at most 200 characters",
      },
      detail: {
        type: "string",
        description: "what failed, including the tool name and error text when you have them",
      },
      kind: {
        type: "string",
        enum: ["tool_failure", "truncated", "api", "other"],
        description:
          "tool_failure for a failed call, truncated when output was cut off, api for login or remote HTTP errors, other for the rest",
      },
      severity: {
        type: "string",
        enum: ["medium", "low", "high"],
        description: "optional; defaults to medium",
      },
      tool_name: {
        type: "string",
        description: "the tool that failed, when known",
      },
    },
    ["summary", "detail", "kind"],
  ),
  async handler(services, run, _hooks, { arguments: args }) {
    const issues = services.issues;
    if (issues === null) {
      throw new ToolUnavailableError("issue reporting is not available");
    }
    try {
      const row = await issues.create({
        guildId: run.guild_id,
        agentId: run.agent_id,
        agentName: run.agent_name,
        runId: run.run_id,
        kind: argString(args, "kind"),
        severity: args.severity,
        summary: argString(args, "summary"),
        detail: argString(args, "detail"),
        toolName: argString(args, "tool_name"),
      });
      const chat = services.group_chat;
      if (chat?.publish) {
        await chat.publish(run.guild_id, "guild.issues.changed", {
          action: "create",
          issue_id: row.id,
          agent_id: run.agent_id,
        });
      }
      const tool = row.tool_name ? ` tool=${row.tool_name}` : "";
      return `reported ${row.id}\nkind=${row.kind} severity=${row.severity} status=${row.status}${tool}`;
    } catch (caught) {
      if (caught instanceof IssueError) {
        throw caught;
      }
      throw caught;
    }
  },
};
