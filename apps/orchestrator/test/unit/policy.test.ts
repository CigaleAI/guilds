import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LimitError,
  OPEN_POLICY,
  PolicyError,
  UNLIMITED,
  assertCanCreateAgentThrough,
  assertCanCreateAgentsThrough,
  assertCanCreateGuildThrough,
  assertCanEnableBrowserThrough,
  assertCanAddSubscriptionAgentThrough,
  assertCanPlaceAgentsThrough,
  claimCoachRunThrough,
  countsAsSubscriptionAgent,
  machineCap,
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

function countsOf(counts: { agents?: number; browsers?: number; subscribers?: number; guilds?: number }): OrgCounts {
  return {
    countOrgAgents: async () => counts.agents ?? 0,
    countOrgBrowserAgents: async () => counts.browsers ?? 0,
    countOrgSubscriptionAgents: async () => counts.subscribers ?? 0,
    countOrgGuilds: async () => counts.guilds ?? 0,
  };
}

const MODEL = "deepinfra/zai-org/GLM-5.3-Flash";

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
  const full = countsOf({ agents: 10_000, browsers: 10_000, subscribers: 10_000, guilds: 10_000 });
  await assertCanCreateAgentsThrough(OPEN_POLICY, full, "org_1", { agents: 50, browserAgents: 50, subscriptionAgents: 50 });
  await assertCanCreateGuildThrough(OPEN_POLICY, full, "org_1");
  await assertCanEnableBrowserThrough(OPEN_POLICY, full, "org_1", false);
  await assertCanAddSubscriptionAgentThrough(OPEN_POLICY, full, "org_1");
});

test("agent caps count what is being added", async () => {
  const policy = policyOf({ maxAgents: 3, maxBrowserAgents: 1, maxSubscriptionAgents: 1 });
  await assertCanCreateAgentThrough(policy, countsOf({ agents: 2 }), "org_1", { browser: false, model: MODEL });
  await assert.rejects(
    () => assertCanCreateAgentThrough(policy, countsOf({ agents: 3 }), "org_1", { browser: false, model: MODEL }),
    limitOn("agents"),
  );
  await assert.rejects(
    () => assertCanCreateAgentsThrough(policy, countsOf({ agents: 1 }), "org_1", { agents: 3, browserAgents: 0, subscriptionAgents: 0 }),
    limitOn("agents"),
  );
  await assert.rejects(
    () => assertCanCreateAgentThrough(policy, countsOf({ browsers: 1 }), "org_1", { browser: true, model: MODEL }),
    limitOn("browser-enabled agents"),
  );
  await assert.rejects(
    () => assertCanCreateAgentThrough(policy, countsOf({ subscribers: 1 }), "org_1", { browser: false, model: null }),
    limitOn("subscription agents"),
  );
  // A full browser cap does not stop an agent without a browser.
  await assertCanCreateAgentThrough(policy, countsOf({ browsers: 1 }), "org_1", { browser: false, model: MODEL });
});

test("a subscription agent counts against the subscription agents cap; an agent on a key does not", () => {
  assert.equal(countsAsSubscriptionAgent({ model: null }), true);
  assert.equal(countsAsSubscriptionAgent({ model: MODEL }), false);
});

test("a new subscription agent takes one of the subscription agents cap", async () => {
  const policy = policyOf({ maxSubscriptionAgents: 1 });
  await assertCanCreateAgentThrough(policy, countsOf({ subscribers: 0 }), "org_1", { browser: false, model: null });
  await assert.rejects(
    () => assertCanCreateAgentThrough(policy, countsOf({ subscribers: 1 }), "org_1", { browser: false, model: null }),
    limitOn("subscription agents"),
  );
});

test("enabling a browser on an agent, or moving it onto a subscription, takes one more of the cap", async () => {
  const policy = policyOf({ maxBrowserAgents: 1, maxSubscriptionAgents: 1 });
  await assertCanEnableBrowserThrough(policy, countsOf({ browsers: 0 }), "org_1", false);
  await assertCanEnableBrowserThrough(policy, countsOf({ browsers: 1 }), "org_1", true);
  await assert.rejects(
    () => assertCanEnableBrowserThrough(policy, countsOf({ browsers: 1 }), "org_1", false),
    limitOn("browser-enabled agents"),
  );
  await assert.rejects(() => assertCanAddSubscriptionAgentThrough(policy, countsOf({ subscribers: 1 }), "org_1"), limitOn("subscription agents"));
});

test("a barred organisation is refused before any cap, except for guilds and coach runs", async () => {
  const barred = new PolicyError(402, "subscription required: the trial has ended");
  const policy = policyOf({ maxAgents: 0, maxGuilds: 5, monthlyCoachRuns: null }, barred);
  const counts = countsOf({ guilds: 1 });
  const isBarred = (error: unknown) => error === barred;
  await assert.rejects(
    () => assertCanCreateAgentThrough(policy, counts, "org_1", { browser: false, model: MODEL }),
    isBarred,
  );
  await assert.rejects(() => assertCanEnableBrowserThrough(policy, counts, "org_1", false), isBarred);
  await assert.rejects(() => assertCanAddSubscriptionAgentThrough(policy, counts, "org_1"), isBarred);
  await assertCanCreateGuildThrough(policy, counts, "org_1");
  await claimCoachRunThrough(policy, { claimMonthlyStudioBuilderRun: async () => 1 }, "org_1");
});

test("the guild cap counts live guilds", async () => {
  const policy = policyOf({ maxGuilds: 2 });
  await assertCanCreateGuildThrough(policy, countsOf({ guilds: 1 }), "org_1");
  await assert.rejects(() => assertCanCreateGuildThrough(policy, countsOf({ guilds: 2 }), "org_1"), limitOn("guilds"));
});

test("a coach run is counted, and refused once the month's cap is spent", async () => {
  const seen: Array<number | null> = [];
  const store = (claimed: number | null) => ({
    claimMonthlyStudioBuilderRun: async (_orgId: string, _now: Date, limit: number | null) => {
      seen.push(limit);
      return claimed;
    },
  });
  await claimCoachRunThrough(policyOf({ monthlyCoachRuns: 3 }), store(1), "org_1");
  await assert.rejects(
    () => claimCoachRunThrough(policyOf({ monthlyCoachRuns: 3 }), store(null), "org_1"),
    limitOn("studio and builder runs"),
  );
  // Uncapped: the run is still counted, and a store that claims nothing is not a refusal.
  await claimCoachRunThrough(policyOf({ monthlyCoachRuns: null }), store(null), "org_1");
  assert.deepEqual(seen, [3, 3, null]);
});

test("remaining is null without a cap and never negative", () => {
  assert.equal(remaining(null, 12), null);
  assert.equal(remaining(5, 2), 3);
  assert.equal(remaining(5, 9), 0);
});

test("the per-machine cap counts the agents on the machine plus those being placed, and is returned", async () => {
  const seen: string[] = [];
  const countsOn = (count: number) => ({
    countMachineAgents: async (machineId: string) => {
      seen.push(machineId);
      return count;
    },
  });
  assert.equal(await assertCanPlaceAgentsThrough(policyOf({}), countsOn(1_000), "org_1", { machineId: "mach_1", agents: 50 }), null);
  const policy = policyOf({ maxAgentsPerMachine: 4 });
  assert.equal(await assertCanPlaceAgentsThrough(policy, countsOn(2), "org_1", { machineId: "mach_1", agents: 1 }), 4);
  assert.equal(await assertCanPlaceAgentsThrough(policy, countsOn(2), "org_1", { machineId: "mach_1", agents: 2 }), 4);
  await assert.rejects(
    () => assertCanPlaceAgentsThrough(policy, countsOn(3), "org_1", { machineId: "mach_2", agents: 2 }),
    limitOn("agents per machine"),
  );
  await assert.rejects(
    () => assertCanPlaceAgentsThrough(policy, countsOn(4), "org_1", { machineId: "mach_2", agents: 1 }),
    limitOn("agents per machine"),
  );
  assert.deepEqual(seen, ["mach_1", "mach_1", "mach_2", "mach_2"]);
});

test("the machine cap is null when uncapped, else the cap and the refusal a create holds to", async () => {
  assert.equal(await machineCap(policyOf({}), "org_1"), null);
  assert.equal(await machineCap(OPEN_POLICY, "org_1"), null);
  const held = await machineCap(policyOf({ maxMachines: 2 }), "org_1");
  assert.ok(held);
  assert.equal(held.max, 2);
  const refusal = held.refuse();
  assert.ok(limitOn("machines")(refusal));
  assert.notEqual(held.refuse(), refusal, "each refusal is a fresh error");
});
