import { Type } from "typebox";
import { ISSUE_SEVERITIES } from "../issues/index.js";
import { nativeTool } from "./types.js";
import { ToolUnavailableError } from "./errors.js";

const DESCRIPTION =
  "Report a problem with this agent's tooling or platform to the operator. " +
  "Use when a tool call fails, a result is truncated, an API or MCP login errors, " +
  "or the sandbox otherwise blocks the work this run needs. Do not use for missing " +
  "facts, Task questions, or ordinary empty search results. kind is tool_failure, " +
  "truncated, api, or other. Name the failing tool when you know it. summary is one " +
  "line; detail is what happened and any error text. severity blocking is for a problem " +
  "that makes every further run of this agent pointless or harmful until the operator " +
  "fixes it, such as a revoked login the Task depends on: it ends this run at once and " +
  "disables this agent until the operator resolves the issue.";

export const reportIssue = nativeTool({
  name: "report_issue",
  description: DESCRIPTION,
  parameters: Type.Object({
    summary: Type.String({ description: "one-line title, at most 200 characters" }),
    detail: Type.String({ description: "what failed, including the tool name and error text when you have them" }),
    kind: Type.String({
      enum: ["tool_failure", "truncated", "api", "other"],
      description:
        "tool_failure for a failed call, truncated when output was cut off, api for login or remote HTTP errors, other for the rest",
    }),
    severity: Type.Optional(
      Type.String({
        enum: [...ISSUE_SEVERITIES],
        description: "optional; defaults to medium. blocking ends this run and disables this agent until the operator resolves the issue",
      }),
    ),
    tool_name: Type.Optional(Type.String({ description: "the tool that failed, when known" })),
  }),
  async handler(services, run, _hooks, call) {
    const args = call.arguments;
    const issues = services.issues;
    if (issues === null) {
      throw new ToolUnavailableError("issue reporting is not available");
    }
    const row = await issues.create({
      guildId: run.guild_id,
      agentId: run.agent_id,
      agentName: run.agent_name,
      runId: run.run_id,
      kind: args.kind,
      severity: args.severity,
      summary: args.summary,
      detail: args.detail,
      toolName: args.tool_name ?? "",
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
    const reported = `reported ${row.id}\nkind=${row.kind} severity=${row.severity} status=${row.status}${tool}`;
    if (row.severity !== "blocking") {
      return reported;
    }
    call.metadata = { blocking_issue_id: row.id };
    return `${reported}\nThis agent is disabled until the operator resolves the issue. The run ends now.`;
  },
});
