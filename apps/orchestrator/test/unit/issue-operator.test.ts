import assert from "node:assert/strict";
import { test } from "node:test";
import type { GuildIssueRow } from "../../src/db/issues.js";
import { Issues, IssueError, type IssuesDatabase } from "../../src/issues/index.js";
import {
  changeIssueStatus,
  resolveGuildIssues,
  type IssueChange,
  type IssueWriteDeps,
} from "../../src/issues/operator.js";

const ISSUE: GuildIssueRow = {
  id: "iss_1",
  guild_id: "g_1",
  org_id: "org_1",
  agent_id: "a_1",
  agent_name: "keeper",
  run_id: null,
  kind: "other",
  severity: "low",
  status: "open",
  summary: "Odd.",
  detail: "Odd detail.",
  tool_name: null,
  created_at: "2026-10-12T09:00:00.000Z",
  updated_at: "2026-10-12T09:00:00.000Z",
  resolved_at: null,
  resolved_by: null,
  live_agent_name: "keeper",
  avatar_shape: "teardrop",
  avatar_color: "#7c5cff",
};

function unused(): never {
  throw new Error("not called by an operator's issue writes");
}

/** Issue writes over a guild holding `open` open issues and `iss_1`, and the changes they announce. */
function announcing(open: number): { deps: IssueWriteDeps; published: Array<[string, IssueChange]> } {
  const db: IssuesDatabase = {
    getGuild: async () => unused(),
    insertIssue: async () => unused(),
    listIssuesForGuild: async () => unused(),
    countOpenIssues: async () => unused(),
    getIssue: async (_guildId, issueId) => (issueId === ISSUE.id ? ISSUE : null),
    setIssueStatus: async (_issue, change) => ({ ...ISSUE, status: change.status }),
    resolveOpenIssues: async () => open,
  };
  const published: Array<[string, IssueChange]> = [];
  const deps: IssueWriteDeps = {
    issues: new Issues(db),
    publishIssuesChanged: async (guildId, change) => {
      published.push([guildId, change]);
    },
  };
  return { deps, published };
}

test("resolve_guild_issues_announces_the_resolution_when_any_issue_was_open", async () => {
  const { deps, published } = announcing(2);
  assert.equal(await resolveGuildIssues(deps, "g_1", "operator"), 2);
  assert.deepEqual(published, [["g_1", { action: "resolved", issueId: null }]]);
});

test("resolve_guild_issues_announces_nothing_when_no_issue_was_open", async () => {
  const { deps, published } = announcing(0);
  assert.equal(await resolveGuildIssues(deps, "g_1", "operator"), 0);
  assert.deepEqual(published, []);
});

test("change_issue_status_announces_the_status_and_the_issue", async () => {
  const { deps, published } = announcing(1);
  const issue = { guildId: "g_1", issueId: "iss_1" };
  assert.equal((await changeIssueStatus(deps, issue, "resolved", "operator")).status, "resolved");
  await changeIssueStatus(deps, issue, "open", "operator");
  assert.deepEqual(published, [
    ["g_1", { action: "resolved", issueId: "iss_1" }],
    ["g_1", { action: "open", issueId: "iss_1" }],
  ]);
});

test("change_issue_status_announces_nothing_when_the_change_is_refused", async () => {
  const { deps, published } = announcing(1);
  await assert.rejects(changeIssueStatus(deps, { guildId: "g_1", issueId: "iss_none" }, "resolved", null), IssueError);
  await assert.rejects(changeIssueStatus(deps, { guildId: "g_1", issueId: "iss_1" }, "closed", null), IssueError);
  assert.deepEqual(published, []);
});

test("issue_writes_announce_nothing_without_a_publisher", async () => {
  const { deps } = announcing(1);
  const quiet: IssueWriteDeps = { issues: deps.issues };
  assert.equal(await resolveGuildIssues(quiet, "g_1", null), 1);
  assert.equal((await changeIssueStatus(quiet, { guildId: "g_1", issueId: "iss_1" }, "open", null)).id, "iss_1");
});
