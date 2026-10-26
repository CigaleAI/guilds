import assert from "node:assert/strict";
import { test } from "node:test";
import type { GuildIssueRow, IssueStatusChange, NewIssue } from "../../src/db/issues.js";
import { Issues, IssueError, ISSUE_OPEN_CAP, issueItem } from "../../src/issues/index.js";
import { createToolContext, invokeTool } from "../../src/toolbox/index.js";
import { validateCatalog, BindingError } from "../../src/access/index.js";

class MemoryIssuesDB {
  guilds: Record<string, { id: string; org_id: string; name: string }> = {
    guild_1: { id: "guild_1", org_id: "org_1", name: "alpha" },
  };
  rows: GuildIssueRow[] = [];

  async getGuild(guildId: string) {
    return this.guilds[guildId] ?? null;
  }

  async insertIssue(input: NewIssue, now: Date) {
    const {
      issueId,
      guildId,
      orgId,
      agentId,
      agentName,
      runId,
      kind,
      severity,
      summary,
      detail,
      toolName,
    } = input;
    const row: GuildIssueRow = {
      id: issueId,
      guild_id: guildId,
      org_id: orgId,
      agent_id: agentId,
      agent_name: agentName,
      run_id: runId,
      kind,
      severity,
      status: "open",
      summary,
      detail,
      tool_name: toolName,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      resolved_at: null,
      resolved_by: null,
      live_agent_name: agentName,
      avatar_shape: "teardrop",
      avatar_color: "#7c5cff",
    };
    this.rows.push(row);
    return row;
  }

  async listIssuesForGuild(guildId: string, status: string | null) {
    return this.rows.filter(
      (row) => row.guild_id === guildId && (status === null || row.status === status),
    );
  }

  async getIssue(guildId: string, issueId: string) {
    return this.rows.find((row) => row.guild_id === guildId && row.id === issueId) ?? null;
  }

  async setIssueStatus(guildId: string, issueId: string, change: IssueStatusChange, now: Date) {
    const { status, resolvedAt, resolvedBy } = change;
    const row = await this.getIssue(guildId, issueId);
    if (!row) {
      return null;
    }
    row.status = status;
    row.resolved_at = resolvedAt ? resolvedAt.toISOString() : null;
    row.resolved_by = resolvedBy;
    row.updated_at = now.toISOString();
    return row;
  }

  async resolveOpenIssues(guildId: string, resolvedAt: Date, resolvedBy: string, now: Date) {
    let resolved = 0;
    for (const row of this.rows) {
      if (row.guild_id !== guildId || row.status !== "open") {
        continue;
      }
      row.status = "resolved";
      row.resolved_at = resolvedAt.toISOString();
      row.resolved_by = resolvedBy;
      row.updated_at = now.toISOString();
      resolved += 1;
    }
    return resolved;
  }

  async countOpenIssues(guildId: string) {
    return this.rows.filter((row) => row.guild_id === guildId && row.status === "open").length;
  }
}

test("report_issue_tool_writes_an_open_row", async () => {
  const db = new MemoryIssuesDB();
  const issues = new Issues(db);
  const published: Array<[string, string, Record<string, unknown>]> = [];
  const ctx = createToolContext({
    run_id: "r_1",
    agent_id: "a_1",
    guild_id: "guild_1",
    sandbox: null,
    secrets: {},
    agent_name: "researcher",
    issues,
    group_chat: {
      async publish(guildId, event, data) {
        published.push([guildId, event, data]);
      },
    },
  });
  const [payload, metadata] = await invokeTool(
    ctx,
    {
      id: "call_1",
      function: {
        name: "report_issue",
        arguments: JSON.stringify({
          summary: "Notion search timed out",
          detail: "notion_search returned ERROR: timeout after 60s",
          kind: "api",
          severity: "high",
          tool_name: "notion_search",
        }),
      },
    },
    {},
    1024,
  );
  assert.equal(metadata.error, null);
  assert.match(String(payload.content), /^reported iss_/);
  assert.match(String(payload.content), /kind=api severity=high status=open/);
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0]?.kind, "api");
  assert.equal(db.rows[0]?.run_id, "r_1");
  assert.equal(published[0]?.[1], "guild.issues.changed");
});

test("report_issue_rejects_unknown_kind", async () => {
  const issues = new Issues(new MemoryIssuesDB());
  const ctx = createToolContext({
    run_id: "r_1",
    agent_id: "a_1",
    guild_id: "guild_1",
    sandbox: null,
    secrets: {},
    agent_name: "researcher",
    issues,
  });
  const [, metadata] = await invokeTool(
    ctx,
    {
      id: "call_1",
      function: {
        name: "report_issue",
        arguments: JSON.stringify({
          summary: "something broke",
          detail: "unclear",
          kind: "mystery",
        }),
      },
    },
    {},
    1024,
  );
  assert.match(String(metadata.error), /kind must be/);
});

test("open issue cap is enforced", async () => {
  const db = new MemoryIssuesDB();
  const issues = new Issues(db);
  for (let index = 0; index < ISSUE_OPEN_CAP; index += 1) {
    await issues.create({
      guildId: "guild_1",
      agentId: "a_1",
      agentName: "researcher",
      runId: "r_1",
      kind: "other",
      summary: `issue ${index}`,
      detail: "detail",
    });
  }
  await assert.rejects(
    () =>
      issues.create({
        guildId: "guild_1",
        agentId: "a_1",
        agentName: "researcher",
        runId: "r_1",
        kind: "other",
        summary: "one more",
        detail: "detail",
      }),
    (error: unknown) => error instanceof IssueError && error.message.includes("open issues"),
  );
});

test("operator can resolve and reopen", async () => {
  const db = new MemoryIssuesDB();
  const issues = new Issues(db);
  const created = await issues.create({
    guildId: "guild_1",
    agentId: "a_1",
    agentName: "researcher",
    runId: "r_1",
    kind: "truncated",
    summary: "artifact_get truncated",
    detail: "result ended with [truncated]",
    toolName: "artifact_get",
  });
  const resolved = await issues.setStatus("guild_1", String(created.id), "resolved", "operator");
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolved_by, "operator");
  const reopened = await issues.setStatus("guild_1", String(created.id), "open", "operator");
  assert.equal(reopened.status, "open");
  assert.equal(reopened.resolved_by, null);
});

test("operator can resolve every open issue", async () => {
  const db = new MemoryIssuesDB();
  const issues = new Issues(db);
  const first = await issues.create({
    guildId: "guild_1",
    agentId: "a_1",
    agentName: "researcher",
    runId: "r_1",
    kind: "api",
    summary: "login expired",
    detail: "401",
  });
  const second = await issues.create({
    guildId: "guild_1",
    agentId: "a_1",
    agentName: "researcher",
    runId: "r_1",
    kind: "truncated",
    summary: "artifact truncated",
    detail: "[truncated]",
  });
  await issues.setStatus("guild_1", String(first.id), "resolved", "operator");
  assert.equal(await issues.resolveOpen("guild_1", "ada"), 1);
  const listed = await issues.listForGuild("guild_1");
  const byId = Object.fromEntries(listed.map((row) => [String(row.id), row]));
  assert.equal(byId[String(first.id)]?.status, "resolved");
  assert.equal(byId[String(first.id)]?.resolved_by, "operator");
  assert.equal(byId[String(second.id)]?.status, "resolved");
  assert.equal(byId[String(second.id)]?.resolved_by, "ada");
  assert.equal(await issues.resolveOpen("guild_1", "ada"), 0);
});

test("issueItem snapshots the reporting agent", () => {
  const item = issueItem({
    id: "iss_1",
    guild_id: "guild_1",
    org_id: "org_1",
    agent_id: "a_1",
    agent_name: "researcher",
    run_id: "r_1",
    kind: "tool_failure",
    severity: "medium",
    status: "open",
    summary: "script_run failed",
    detail: "exit 1",
    tool_name: "script_run",
    created_at: "2026-09-17T10:00:00+00:00",
    updated_at: "2026-09-17T10:00:00+00:00",
    resolved_at: null,
    resolved_by: null,
    live_agent_name: "researcher",
    avatar_shape: "blob",
    avatar_color: "#ff00aa",
  });
  assert.deepEqual(item.agent, {
    id: "a_1",
    name: "researcher",
    avatar_shape: "blob",
    avatar_color: "#ff00aa",
  });
});

test("group_post is a binding", () => {
  assert.deepEqual(validateCatalog("native_tool", "group_post"), ["native_tool", "group_post"]);
});

test("report_issue is not a binding", () => {
  assert.throws(
    () => validateCatalog("native_tool", "report_issue"),
    (error: unknown) => error instanceof BindingError && error.message.includes("not a binding"),
  );
});
