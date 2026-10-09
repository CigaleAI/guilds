import type pg from "pg";
import {
  BUILDER_MAX_INPUT_TOKENS,
  BUILDER_MAX_TOKENS,
  BUILDER_MAX_TOOL_CALLS,
} from "../builder/constants.js";
import {
  STUDIO_MAX_INPUT_TOKENS,
  STUDIO_MAX_TOKENS,
  STUDIO_MAX_TOOL_CALLS,
} from "../studio/constants.js";

// Organisation policy (docs/architecture/extension-points.md): the caps an organisation works under and
// whether it may work at all. Core checks them here; an edition says what they are.

export type CoachKind = "studio" | "builder";

/** Output tokens, tool calls, and input tokens of one Studio or Builder generation. */
export type CoachRunLimits = {
  max_tokens: number;
  max_tool_calls: number;
  max_input_tokens: number;
};

export const COACH_RUN_LIMITS: Record<CoachKind, CoachRunLimits> = {
  studio: {
    max_tokens: STUDIO_MAX_TOKENS,
    max_tool_calls: STUDIO_MAX_TOOL_CALLS,
    max_input_tokens: STUDIO_MAX_INPUT_TOKENS,
  },
  builder: {
    max_tokens: BUILDER_MAX_TOKENS,
    max_tool_calls: BUILDER_MAX_TOOL_CALLS,
    max_input_tokens: BUILDER_MAX_INPUT_TOKENS,
  },
};

/** An organisation's caps; null leaves that one uncapped. */
export type OrgLimits = {
  /** What sets them, as a refusal names it: "plan limit reached: agents". */
  source: string;
  maxAgents: number | null;
  maxBrowserAgents: number | null;
  maxCodingAgents: number | null;
  maxGuilds: number | null;
  maxConcurrentRuns: number | null;
  monthlyCostLimitUsd: number | null;
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
  maxGuilds: null,
  maxConcurrentRuns: null,
  monthlyCostLimitUsd: null,
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
export type OrgCounts = {
  countOrgAgents(orgId: string): Promise<number>;
  countOrgBrowserAgents(orgId: string): Promise<number>;
  countOrgCodingAgents(orgId: string): Promise<number>;
  countOrgGuilds(orgId: string): Promise<number>;
};

/** How many more of a capped thing fit; null when it is uncapped. */
export function remaining(limit: number | null, count: number): number | null {
  return limit === null ? null : Math.max(0, limit - count);
}

export async function assertCanCreateAgents(
  policy: OrgPolicy,
  counts: OrgCounts,
  orgId: string,
  adding: { agents: number; browserAgents: number; codingAgents: number },
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
  counts: OrgCounts,
  orgId: string,
  flags: { browser: boolean; coding: boolean },
): Promise<void> {
  await assertCanCreateAgents(policy, counts, orgId, {
    agents: 1,
    browserAgents: flags.browser ? 1 : 0,
    codingAgents: flags.coding ? 1 : 0,
  });
}

/** `maxGuilds` caps the organisation's live guilds. */
export async function assertCanCreateGuild(policy: OrgPolicy, counts: OrgCounts, orgId: string): Promise<void> {
  const { limits } = await policy.standing(orgId);
  if (limits.maxGuilds !== null && (await counts.countOrgGuilds(orgId)) >= limits.maxGuilds) {
    throw new LimitError(limits.source, "guilds");
  }
}

export async function assertCanEnableBrowser(
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
export async function assertCanEnableCoding(policy: OrgPolicy, counts: OrgCounts, orgId: string): Promise<void> {
  const { limits, blocked } = await policy.standing(orgId);
  if (blocked) {
    throw blocked;
  }
  if (limits.maxCodingAgents !== null && (await counts.countOrgCodingAgents(orgId)) >= limits.maxCodingAgents) {
    throw new LimitError(limits.source, "coding agents");
  }
}

/** Counts one Studio or Builder generation against the month, refusing it past `monthlyCoachRuns`. */
export async function claimCoachRun(
  policy: OrgPolicy,
  store: {
    claimMonthlyStudioBuilderRun(
      orgId: string,
      now: Date,
      limit: number | null,
      client?: pg.PoolClient,
    ): Promise<number | null>;
  },
  orgId: string,
  now = new Date(),
  client?: pg.PoolClient,
): Promise<void> {
  const { limits } = await policy.standing(orgId, now);
  const claimed = await store.claimMonthlyStudioBuilderRun(orgId, now, limits.monthlyCoachRuns, client);
  if (limits.monthlyCoachRuns !== null && claimed === null) {
    throw new LimitError(limits.source, "studio and builder runs");
  }
}
