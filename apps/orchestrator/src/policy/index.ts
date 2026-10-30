import {
  countOrgAgents,
  countOrgBrowserAgents,
  countOrgCodingAgents,
  countOrgGuilds,
} from "../db/orgs.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import type { CoachRunLimits } from "../db/schema/index.js";
import { countMachineAgents } from "../db/machines.js";
import { claimMonthlyStudioBuilderRun } from "../db/usage.js";

// Organisation policy (docs/architecture/extension-points.md): the caps an organisation works under and
// whether it may work at all. Core checks them here; an extension says what they are.

export type CoachKind = "studio" | "builder";

export const COACH_RUN_LIMITS: Record<CoachKind, CoachRunLimits> = {
  studio: { max_tokens: 8192, max_tool_calls: 40, max_input_tokens: 100_000 },
  builder: { max_tokens: 25000, max_tool_calls: 40, max_input_tokens: 200_000 },
};

/** An organisation's caps; null leaves that one uncapped. */
export type OrgLimits = {
  /** What sets them, as a refusal names it: "plan limit reached: agents". */
  source: string;
  maxAgents: number | null;
  maxBrowserAgents: number | null;
  maxCodingAgents: number | null;
  /** Machines the organisation runs its agents on. */
  maxMachines: number | null;
  /** Agents on one machine; core's own ceiling of 32 still holds above it. */
  maxAgentsPerMachine: number | null;
  maxGuilds: number | null;
  maxConcurrentRuns: number | null;
  /** Studio and Builder generations a month, counted together. */
  monthlyCoachRuns: number | null;
  /** Remote MCP servers the organisation adds of its own. */
  maxMcpServers: number | null;
  /** Calls a month on a connector's platform login, by connector slug; a slug absent is uncapped. */
  monthlyConnectorCalls: Readonly<Record<string, number>>;
  coach: Record<CoachKind, CoachRunLimits>;
};

/** A refusal under the policy; a route answers with its status and message. */
export class PolicyError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "PolicyError";
    this.status = status;
  }
}

export class LimitError extends PolicyError {
  cap: string;

  constructor(source: string, cap: string) {
    super(409, `${source} limit reached: ${cap}`);
    this.name = "LimitError";
    this.cap = cap;
  }
}

export type OrgStanding = {
  limits: OrgLimits;
  /** Why the organisation may not create agents or run generations now; null while it may. */
  blocked: PolicyError | null;
};

export type OrgPolicy = {
  standing(orgId: string, now?: Date): Promise<OrgStanding>;
};

export const UNLIMITED: OrgLimits = {
  source: "instance",
  maxAgents: null,
  maxBrowserAgents: null,
  maxCodingAgents: null,
  maxMachines: null,
  maxAgentsPerMachine: null,
  maxGuilds: null,
  maxConcurrentRuns: null,
  monthlyCoachRuns: null,
  maxMcpServers: null,
  monthlyConnectorCalls: {},
  coach: COACH_RUN_LIMITS,
};

/** Core's policy: nothing is capped and every organisation may work. */
export const OPEN_POLICY: OrgPolicy = {
  async standing() {
    return { limits: UNLIMITED, blocked: null };
  },
};

/** The live counts the caps are checked against. */
function orgCounts(db: Queryable) {
  return {
    countOrgAgents: bindQuery(db, countOrgAgents),
    countOrgBrowserAgents: bindQuery(db, countOrgBrowserAgents),
    countOrgCodingAgents: bindQuery(db, countOrgCodingAgents),
    countOrgGuilds: bindQuery(db, countOrgGuilds),
  };
}

export type OrgCounts = ReturnType<typeof orgCounts>;

/** The live counts the machine caps are checked against. */
function machineCounts(db: Queryable) {
  return {
    countMachineAgents: bindQuery(db, countMachineAgents),
  };
}

export type MachineCounts = ReturnType<typeof machineCounts>;

/** How many more of a capped thing fit; null when it is uncapped. */
export function remaining(limit: number | null, count: number): number | null {
  return limit === null ? null : Math.max(0, limit - count);
}

/** The agents a create adds, and how many of them have Browser and Coding on. */
export type AddedAgents = { agents: number; browserAgents: number; codingAgents: number };

/** Whether a new agent has Browser and Coding on. */
export type AgentFlags = { browser: boolean; coding: boolean };

export async function assertCanCreateAgents(
  policy: OrgPolicy,
  db: Queryable,
  orgId: string,
  adding: AddedAgents,
): Promise<void> {
  await assertCanCreateAgentsThrough(policy, orgCounts(db), orgId, adding);
}

/** `assertCanCreateAgents` through `counts`, the dependencies object a unit test fakes. */
export async function assertCanCreateAgentsThrough(
  policy: OrgPolicy,
  counts: OrgCounts,
  orgId: string,
  adding: AddedAgents,
): Promise<void> {
  const { limits, blocked } = await policy.standing(orgId);
  if (blocked) {
    throw blocked;
  }
  if (limits.maxAgents !== null && (await counts.countOrgAgents(orgId)) + adding.agents > limits.maxAgents) {
    throw new LimitError(limits.source, "agents");
  }
  if (
    adding.browserAgents &&
    limits.maxBrowserAgents !== null &&
    (await counts.countOrgBrowserAgents(orgId)) + adding.browserAgents > limits.maxBrowserAgents
  ) {
    throw new LimitError(limits.source, "browser-enabled agents");
  }
  if (
    adding.codingAgents &&
    limits.maxCodingAgents !== null &&
    (await counts.countOrgCodingAgents(orgId)) + adding.codingAgents > limits.maxCodingAgents
  ) {
    throw new LimitError(limits.source, "coding agents");
  }
}

export async function assertCanCreateAgent(
  policy: OrgPolicy,
  db: Queryable,
  orgId: string,
  flags: AgentFlags,
): Promise<void> {
  await assertCanCreateAgentThrough(policy, orgCounts(db), orgId, flags);
}

/** `assertCanCreateAgent` through `counts`, the dependencies object a unit test fakes. */
export async function assertCanCreateAgentThrough(
  policy: OrgPolicy,
  counts: OrgCounts,
  orgId: string,
  flags: AgentFlags,
): Promise<void> {
  await assertCanCreateAgentsThrough(policy, counts, orgId, {
    agents: 1,
    browserAgents: flags.browser ? 1 : 0,
    codingAgents: flags.coding ? 1 : 0,
  });
}

/** A cap a repository write holds to inside its transaction, and the error it refuses with. */
export type HeldCap = { max: number; refuse: () => Error };

/**
 * `maxMachines` caps the organisation's machines. The insert counts them under the
 * organisation's lock, so concurrent creates cannot pass it; null leaves them uncapped.
 */
export async function machineCap(policy: OrgPolicy, orgId: string): Promise<HeldCap | null> {
  const { limits } = await policy.standing(orgId);
  if (limits.maxMachines === null) {
    return null;
  }
  return { max: limits.maxMachines, refuse: () => new LimitError(limits.source, "machines") };
}

/** The agents a placement puts on one machine. */
export type PlacedAgents = { machineId: string; agents: number };

/**
 * `maxAgentsPerMachine` caps the agents one machine takes. Returns the cap, which placement holds
 * to inside its transaction; null leaves core's ceiling alone.
 */
export async function assertCanPlaceAgents(
  policy: OrgPolicy,
  db: Queryable,
  orgId: string,
  placed: PlacedAgents,
): Promise<number | null> {
  return assertCanPlaceAgentsThrough(policy, machineCounts(db), orgId, placed);
}

/** `assertCanPlaceAgents` through `counts`, the dependencies object a unit test fakes. */
export async function assertCanPlaceAgentsThrough(
  policy: OrgPolicy,
  counts: MachineCounts,
  orgId: string,
  placed: PlacedAgents,
): Promise<number | null> {
  const { limits } = await policy.standing(orgId);
  if (
    limits.maxAgentsPerMachine !== null
    && (await counts.countMachineAgents(placed.machineId)) + placed.agents > limits.maxAgentsPerMachine
  ) {
    throw new LimitError(limits.source, "agents per machine");
  }
  return limits.maxAgentsPerMachine;
}

/** `maxGuilds` caps the organisation's live guilds. */
export async function assertCanCreateGuild(policy: OrgPolicy, db: Queryable, orgId: string): Promise<void> {
  await assertCanCreateGuildThrough(policy, orgCounts(db), orgId);
}

/** `assertCanCreateGuild` through `counts`, the dependencies object a unit test fakes. */
export async function assertCanCreateGuildThrough(policy: OrgPolicy, counts: OrgCounts, orgId: string): Promise<void> {
  const { limits } = await policy.standing(orgId);
  if (limits.maxGuilds !== null && (await counts.countOrgGuilds(orgId)) >= limits.maxGuilds) {
    throw new LimitError(limits.source, "guilds");
  }
}

export async function assertCanEnableBrowser(
  policy: OrgPolicy,
  db: Queryable,
  orgId: string,
  alreadyBrowser: boolean,
): Promise<void> {
  await assertCanEnableBrowserThrough(policy, orgCounts(db), orgId, alreadyBrowser);
}

/** `assertCanEnableBrowser` through `counts`, the dependencies object a unit test fakes. */
export async function assertCanEnableBrowserThrough(
  policy: OrgPolicy,
  counts: OrgCounts,
  orgId: string,
  alreadyBrowser: boolean,
): Promise<void> {
  if (alreadyBrowser) {
    return;
  }
  const { limits, blocked } = await policy.standing(orgId);
  if (blocked) {
    throw blocked;
  }
  if (limits.maxBrowserAgents !== null && (await counts.countOrgBrowserAgents(orgId)) >= limits.maxBrowserAgents) {
    throw new LimitError(limits.source, "browser-enabled agents");
  }
}

/** Turning `coding` on for an existing agent takes one more of the organisation's coding agents. */
export async function assertCanEnableCoding(policy: OrgPolicy, db: Queryable, orgId: string): Promise<void> {
  await assertCanEnableCodingThrough(policy, orgCounts(db), orgId);
}

/** `assertCanEnableCoding` through `counts`, the dependencies object a unit test fakes. */
export async function assertCanEnableCodingThrough(policy: OrgPolicy, counts: OrgCounts, orgId: string): Promise<void> {
  const { limits, blocked } = await policy.standing(orgId);
  if (blocked) {
    throw blocked;
  }
  if (limits.maxCodingAgents !== null && (await counts.countOrgCodingAgents(orgId)) >= limits.maxCodingAgents) {
    throw new LimitError(limits.source, "coding agents");
  }
}

/** The month's Studio and Builder runs, claimed on `db`: the pool, or the transaction that starts the run. */
function coachRunClaims(db: Queryable) {
  return { claimMonthlyStudioBuilderRun: bindQuery(db, claimMonthlyStudioBuilderRun) };
}

export type CoachRunClaims = ReturnType<typeof coachRunClaims>;

/**
 * Counts one Studio or Builder generation against the month on `db`, the pool or the transaction
 * that starts the run, refusing it past `monthlyCoachRuns`.
 */
export async function claimCoachRun(
  policy: OrgPolicy,
  db: Queryable,
  orgId: string,
  now = new Date(),
): Promise<void> {
  await claimCoachRunThrough(policy, coachRunClaims(db), orgId, now);
}

/** `claimCoachRun` through `claims`, the dependencies object a unit test fakes. */
export async function claimCoachRunThrough(
  policy: OrgPolicy,
  claims: CoachRunClaims,
  orgId: string,
  now = new Date(),
): Promise<void> {
  const { limits } = await policy.standing(orgId, now);
  const claimed = await claims.claimMonthlyStudioBuilderRun(orgId, now, limits.monthlyCoachRuns);
  if (limits.monthlyCoachRuns !== null && claimed === null) {
    throw new LimitError(limits.source, "studio and builder runs");
  }
}
