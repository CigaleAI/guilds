import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LimitError,
  OPEN_POLICY,
  PolicyError,
  UNLIMITED,
  assertCanCreateAgent,
  assertCanCreateAgents,
  assertCanCreateGuild,
  assertCanEnableBrowser,
  assertCanEnableCoding,
  claimCoachRun,
  remaining,
  type OrgCounts,
  type OrgLimits,
  type OrgPolicy,
} from "../../src/policy/index.js";

function policyOf(limits: Partial<OrgLimits>, blocked: PolicyError | null = null): OrgPolicy {
  return {
    async standing() {
      return { limits: { ...UNLIMITED, source: "plan", ...limits }, blocked };
    },
  };
}

function countsOf(counts: { agents?: number; browsers?: number; coders?: number; guilds?: number }): OrgCounts {
  return {
    countOrgAgents: async () => counts.agents ?? 0,
    countOrgBrowserAgents: async () => counts.browsers ?? 0,
    countOrgCodingAgents: async () => counts.coders ?? 0,
    countOrgGuilds: async () => counts.guilds ?? 0,
  };
}

const limitOn = (cap: string) => (error: unknown) =>
  error instanceof LimitError &&
  error.status === 409 &&
  error.cap === cap &&
  error.message === `plan limit reached: ${cap}`;

test("the open policy caps nothing and bars no one", async () => {
  const { limits, blocked } = await OPEN_POLICY.standing("org_1");
  assert.equal(blocked, null);
  assert.equal(limits.source, "instance");
  assert.equal(limits.maxAgents, null);
  const full = countsOf({ agents: 10_000, browsers: 10_000, coders: 10_000, guilds: 10_000 });
  await assertCanCreateAgents(OPEN_POLICY, full, "org_1", { agents: 50, browserAgents: 50, codingAgents: 50 });
  await assertCanCreateGuild(OPEN_POLICY, full, "org_1");
  await assertCanEnableBrowser(OPEN_POLICY, full, "org_1", false);
  await assertCanEnableCoding(OPEN_POLICY, full, "org_1");
});

test("agent caps count what is being added", async () => {
  const policy = policyOf({ maxAgents: 3, maxBrowserAgents: 1, maxCodingAgents: 1 });
  await assertCanCreateAgent(policy, countsOf({ agents: 2 }), "org_1", { browser: false, coding: false });
  await assert.rejects(
    () => assertCanCreateAgent(policy, countsOf({ agents: 3 }), "org_1", { browser: false, coding: false }),
    limitOn("agents"),
  );
  await assert.rejects(
    () => assertCanCreateAgents(policy, countsOf({ agents: 1 }), "org_1", { agents: 3, browserAgents: 0, codingAgents: 0 }),
    limitOn("agents"),
  );
  await assert.rejects(
    () => assertCanCreateAgent(policy, countsOf({ browsers: 1 }), "org_1", { browser: true, coding: false }),
    limitOn("browser-enabled agents"),
  );
  await assert.rejects(
    () => assertCanCreateAgent(policy, countsOf({ coders: 1 }), "org_1", { browser: false, coding: true }),
    limitOn("coding agents"),
  );
  // A full browser cap does not stop an agent without a browser.
  await assertCanCreateAgent(policy, countsOf({ browsers: 1 }), "org_1", { browser: false, coding: false });
});

test("enabling browser or coding on an agent takes one more of the cap", async () => {
  const policy = policyOf({ maxBrowserAgents: 1, maxCodingAgents: 1 });
  await assertCanEnableBrowser(policy, countsOf({ browsers: 0 }), "org_1", false);
  await assertCanEnableBrowser(policy, countsOf({ browsers: 1 }), "org_1", true);
  await assert.rejects(
    () => assertCanEnableBrowser(policy, countsOf({ browsers: 1 }), "org_1", false),
    limitOn("browser-enabled agents"),
  );
  await assert.rejects(() => assertCanEnableCoding(policy, countsOf({ coders: 1 }), "org_1"), limitOn("coding agents"));
});

test("a barred organisation is refused before any cap, except for guilds and coach runs", async () => {
  const barred = new PolicyError(402, "subscription required: the trial has ended");
  const policy = policyOf({ maxAgents: 0, maxGuilds: 5, monthlyCoachRuns: null }, barred);
  const counts = countsOf({ guilds: 1 });
  const isBarred = (error: unknown) => error === barred;
  await assert.rejects(
    () => assertCanCreateAgent(policy, counts, "org_1", { browser: false, coding: false }),
    isBarred,
  );
  await assert.rejects(() => assertCanEnableBrowser(policy, counts, "org_1", false), isBarred);
  await assert.rejects(() => assertCanEnableCoding(policy, counts, "org_1"), isBarred);
  await assertCanCreateGuild(policy, counts, "org_1");
  await claimCoachRun(policy, { claimMonthlyStudioBuilderRun: async () => 1 }, "org_1");
});

test("the guild cap counts live guilds", async () => {
  const policy = policyOf({ maxGuilds: 2 });
  await assertCanCreateGuild(policy, countsOf({ guilds: 1 }), "org_1");
  await assert.rejects(() => assertCanCreateGuild(policy, countsOf({ guilds: 2 }), "org_1"), limitOn("guilds"));
});

test("a coach run is counted, and refused once the month's cap is spent", async () => {
  const seen: Array<number | null> = [];
  const store = (claimed: number | null) => ({
    claimMonthlyStudioBuilderRun: async (_orgId: string, _now: Date, limit: number | null) => {
      seen.push(limit);
      return claimed;
    },
  });
  await claimCoachRun(policyOf({ monthlyCoachRuns: 3 }), store(1), "org_1");
  await assert.rejects(
    () => claimCoachRun(policyOf({ monthlyCoachRuns: 3 }), store(null), "org_1"),
    limitOn("studio and builder runs"),
  );
  // Uncapped: the run is still counted, and a store that claims nothing is not a refusal.
  await claimCoachRun(policyOf({ monthlyCoachRuns: null }), store(null), "org_1");
  assert.deepEqual(seen, [3, 3, null]);
});

test("remaining is null without a cap and never negative", () => {
  assert.equal(remaining(null, 12), null);
  assert.equal(remaining(5, 2), 3);
  assert.equal(remaining(5, 9), 0);
});
