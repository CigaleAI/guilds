import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApplyStep, McpServerAccess } from "../../api/types";
import {
  checklistProgress,
  checklistSteps,
  createdSummary,
  skippedSteps,
  stepConnector,
  stepHint,
  stepStatus,
  workOpen,
} from "./applySteps";

const step = (
  id: string,
  kind: ApplyStep["kind"],
  status: ApplyStep["status"] = "open",
): ApplyStep => ({
  id,
  kind,
  title: id,
  closure:
    kind === "connection" || kind === "secret" || kind === "overlays" ? "verified" : "confirmed",
  status,
});

const checklist = [
  step("conn:notion", "connection"),
  step("overlays:notion", "overlays"),
  step("secret:API_KEY", "secret", "skipped"),
  step("browser:scout", "browser"),
  step("external:0", "external", "confirmed"),
  step("activate", "activate"),
];

test("the checklist leaves out browser logins and tool overlays", () => {
  assert.deepEqual(
    checklistSteps(checklist).map((item) => item.id),
    ["conn:notion", "secret:API_KEY", "external:0", "activate"],
  );
});

test("progress counts the two milestones and every closed step", () => {
  assert.deepEqual(checklistProgress(checklist), { done: 4, total: 6 });
  assert.equal(workOpen(checklist), true);
  assert.equal(workOpen(checklist.filter((item) => item.kind !== "connection")), false);
});

test("a login step reads the guild's connector by its slug", () => {
  const servers = [{ slug: "notion", status: "connected" }] as McpServerAccess[];
  const [first] = checklist;
  assert.ok(first);
  assert.deepEqual(stepConnector(first, servers), { server: servers[0], connected: true });
  assert.equal(stepStatus(first, true), "Connected · ready to check");
  assert.equal(stepStatus(first, false), "Not connected yet");
});

test("an open login step says to connect, or what a platform admin sets up first", () => {
  const [first] = checklist;
  assert.ok(first);
  assert.equal(
    stepHint(first, false),
    "Connect it here; the step is checked once the login works.",
  );
  assert.equal(
    stepHint(first, false, "GitHub App is not set up on this server: Private key missing."),
    "GitHub App is not set up on this server: Private key missing. A platform admin sets it up under Admin → Platform keys; then connect it here.",
  );
  assert.equal(stepHint(first, true, "GitHub App is not set up on this server."), null);
  assert.equal(stepHint(step("conn:notion", "connection", "verified"), false, "gap"), null);
});

test("skipped logins and secrets are named, not every skipped step", () => {
  assert.deepEqual(
    skippedSteps(checklist).map((item) => item.id),
    ["secret:API_KEY"],
  );
});

test("the created summary counts reused tables", () => {
  assert.equal(
    createdSummary({
      agents: [{}, {}] as never,
      routines: [{}] as never,
      connections: [],
      collections: [{ action: "create" }, { action: "reuse" }] as never,
    }),
    "2 agents, 1 routine, 2 tables (1 reused).",
  );
});
