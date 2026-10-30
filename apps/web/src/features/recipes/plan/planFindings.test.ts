import assert from "node:assert/strict";
import { test } from "node:test";
import { blockingSummary, findingsByPath, planIssues, roleFindings } from "./planFindings";
import { finding } from "./planFixtures";

test("findings attach by path to roles, the blocking banner, and the issues list", () => {
  const findings = [
    finding("schedule.missing", "roles.writer.schedules"),
    finding("task.derived", "roles.writer.task"),
    finding("task.derived", "roles.writer2.task"),
    finding("review.script", "roles.watcher.scripts.scrape", "info"),
    finding("design.poll_dedupe", "design.routines.read", "error", "needs dedupe"),
    finding("collection.conflict", "collections.queue", "error", "queue exists"),
    finding("design.unused_access", "design.systems.x", "info"),
    finding(
      "access.tool_removed",
      "connections.crm.roles.writer.tools.crm_read",
      "info",
      "removed",
    ),
    finding("harness.credential", "roles.writer.config.harness"),
  ];
  assert.equal(findingsByPath(findings).get("roles.writer.task")?.length, 1);

  const writer = roleFindings(findings, "writer");
  assert.equal(writer.routine?.code, "schedule.missing");
  assert.deepEqual(
    writer.notices.map((item) => item.path),
    ["roles.writer.task"],
  );

  assert.deepEqual(blockingSummary(findings), {
    count: 2,
    label: "2 issues to fix",
    hint: "needs dedupe (+1 more)",
    errors: [findings[4], findings[5]],
  });
  assert.equal(blockingSummary(findings.slice(0, 4)), null);

  const issues = planIssues(findings);
  assert.equal(issues?.title, "System issues");
  assert.deepEqual(
    issues?.items.map((item) => [item.finding.code, item.label]),
    [
      ["design.poll_dedupe", "Needs a decision"],
      ["collection.conflict", "Needs a decision"],
      ["access.tool_removed", "Coach should update prompts"],
    ],
  );
  assert.equal(planIssues([finding("server.unknown", "connections.x", "warning")])?.title, "Notes");
  assert.equal(planIssues(findings.slice(0, 4)), null);
  assert.equal(
    planIssues([finding("machine.full", "machine_id", "error")]),
    null,
    "the machine picker shows machine findings",
  );
});
