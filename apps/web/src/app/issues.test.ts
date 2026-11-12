import assert from "node:assert/strict";
import { test } from "node:test";
import type { Issue } from "../api/types/issues";
import {
  disablesAgent,
  issueDisabling,
  issuesOfSeverity,
  reachesSeverity,
  severityFilterOptions,
} from "./issues";

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "iss_1",
    guild_id: "guild_1",
    agent_id: "agent_1",
    agent_name: "scout",
    run_id: null,
    kind: "api",
    severity: "blocking",
    status: "open",
    summary: "Login revoked",
    detail: "401",
    tool_name: null,
    created_at: "2026-01-02T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    resolved_at: null,
    resolved_by: null,
    agent: null,
    ...overrides,
  };
}

test("a severity reaches a floor at or below it", () => {
  assert.equal(reachesSeverity("low", "low"), true);
  assert.equal(reachesSeverity("medium", "high"), false);
  assert.equal(reachesSeverity("high", "medium"), true);
  assert.equal(reachesSeverity("blocking", "blocking"), true);
  assert.equal(reachesSeverity("high", "blocking"), false);
});

test("only an open blocking issue whose agent exists disables it", () => {
  assert.equal(disablesAgent(issue()), true);
  assert.equal(disablesAgent(issue({ status: "resolved" })), false);
  assert.equal(disablesAgent(issue({ severity: "high" })), false);
  assert.equal(disablesAgent(issue({ agent_id: null })), false);
});

test("an agent is disabled by its oldest open blocking issue, and by no one else's", () => {
  const issues = [
    issue({ id: "newer", created_at: "2026-01-03T00:00:00.000Z" }),
    issue({ id: "older", created_at: "2026-01-01T00:00:00.000Z" }),
    issue({ id: "other", agent_id: "agent_2", created_at: "2025-01-01T00:00:00.000Z" }),
    issue({ id: "resolved", status: "resolved", created_at: "2024-01-01T00:00:00.000Z" }),
  ];
  assert.equal(issueDisabling("agent_1", issues)?.id, "older");
  assert.equal(issueDisabling("agent_2", issues)?.id, "other");
  assert.equal(issueDisabling("agent_3", issues), undefined);
});

test("the severity filter keeps every issue, or those of one level", () => {
  const issues = [
    issue({ id: "a" }),
    issue({ id: "b", severity: "low" }),
    issue({ id: "c", severity: "low" }),
  ];
  assert.deepEqual(
    issuesOfSeverity(issues, "all").map((kept) => kept.id),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    issuesOfSeverity(issues, "low").map((kept) => kept.id),
    ["b", "c"],
  );
  assert.deepEqual(issuesOfSeverity(issues, "high"), []);
});

test("the severity filter offers All, then each level from the most severe, with its count", () => {
  const options = severityFilterOptions([
    issue(),
    issue({ severity: "low" }),
    issue({ severity: "low" }),
  ]);
  assert.deepEqual(
    options.map((option) => [option.value, option.label, option.count]),
    [
      ["all", "All", 3],
      ["blocking", "Blocking", 1],
      ["high", "High", 0],
      ["medium", "Medium", 0],
      ["low", "Low", 2],
    ],
  );
});
