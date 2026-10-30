import { agentSecrets } from "../access/runtime.js";
import type { AgentRow } from "../db/agents.js";
import type { Queryable } from "../db/pg.js";
import { getToolResultMetadata, type RunRow } from "../db/runs.js";
import {
  HARNESSES,
  type Harness,
  type HarnessLogins,
  type MessageMetadata,
  type RunRepositoryChange,
} from "../db/schema/index.js";
import { harnessEffortOf } from "../coding/harness-models.js";
import {
  HARNESS_INFO,
  harnessLoginOf,
  harnessModelOf,
  harnessOf,
  harnessSecretSource,
  isHarness,
} from "../coding/harnesses.js";
import type { HarnessCheck, HarnessLog } from "../toolbox/harness.js";
import type { CodingRuns } from "./coding.js";
import { RunRequestError } from "./errors.js";

/** What a coding agent's harness and a coding run's changes are read through, built once from the app's services. */
export type RunReviewServices = {
  db: Queryable;
  /** The coding runs whose machines hold the repositories; absent on a box without a generation loop. */
  coding: Pick<CodingRuns, "runDiff" | "harnessLog" | "repositoryNames" | "checkHarness"> | null;
};

type Item = Record<string, unknown>;

function codingOf(services: RunReviewServices): NonNullable<RunReviewServices["coding"]> {
  if (services.coding === null) {
    throw new RunRequestError(503, "generation is unavailable");
  }
  return services.coding;
}

/** The repository a `code_task` result's diff is in, or null when the result has no end checkpoint. */
function taskDiffRepository(metadata: MessageMetadata | null): string | null {
  if (metadata?.tool_name !== "code_task" || !metadata.end_sha) {
    return null;
  }
  return metadata.repository || null;
}

/** The harness a `code_task` call ran on, when its result names one and the log it kept. */
function taskLogHarness(metadata: MessageMetadata | null): Harness | null {
  if (metadata?.tool_name !== "code_task" || !metadata.log_path) {
    return null;
  }
  return metadata.harness ?? null;
}

/** The repositories a run changed, as its metadata lists them. */
function changedRepositories(run: RunRow): RunRepositoryChange[] {
  return run.metadata.repos ?? [];
}

/** One harness of the agent: its secret, whether the agent is granted it, and the login its home holds. */
function harnessView(
  harness: Harness,
  logins: HarnessLogins,
  aliases: Record<string, string>,
  granted: ReadonlySet<string | undefined>,
): Item {
  const info = HARNESS_INFO[harness];
  const login = harnessLoginOf(logins, harness);
  const source = harnessSecretSource(harness, aliases);
  return {
    harness,
    label: info.label,
    secret: info.secret,
    secret_source: source,
    secret_granted: source !== null && granted.has(source),
    secret_shadowed: source !== null && source !== info.secret && granted.has(String(info.secret)),
    login: info.login,
    login_seen_at: login.seen_at,
    login_account: login.account,
  };
}

/** A coding agent's harness, model and effort, the repositories it works in, and each harness's secret and login. */
export async function loadHarnessView(services: RunReviewServices, agent: AgentRow): Promise<Item> {
  const config = agent.config;
  const granted = new Set(
    (await agentSecrets(services.db, agent)).map((secret) => secret.name),
  );
  const aliases = config.secret_aliases;
  const logins = agent.harness_logins;
  const carried = Array.isArray(agent.machine_harnesses)
    ? agent.machine_harnesses.filter(isHarness)
    : null;
  return {
    harness: harnessOf(config),
    harness_model: harnessModelOf(config),
    harness_effort: harnessEffortOf(config),
    machine_harnesses: carried,
    repositories: (await services.coding?.repositoryNames(agent)) ?? [],
    harnesses: HARNESSES.map((harness) => harnessView(harness, logins, aliases, granted)),
  };
}

/** Checks that a harness runs on the agent's machine with what the agent is given. */
export async function checkAgentHarness(
  services: RunReviewServices,
  agent: AgentRow,
  harness: unknown,
): Promise<HarnessCheck> {
  if (!isHarness(harness)) {
    throw new RunRequestError(422, `harness must be one of: ${HARNESSES.join(", ")}`);
  }
  return codingOf(services).checkHarness(agent.id, harness);
}

export function listRunChanges(run: RunRow): { repositories: RunRepositoryChange[] } {
  return { repositories: changedRepositories(run) };
}

/** What a run changed in one repository. */
export async function repositoryDiff(
  services: RunReviewServices,
  run: RunRow,
  repository: string,
): Promise<Item> {
  if (!changedRepositories(run).some((item) => item.name === repository)) {
    throw new RunRequestError(404, "the run changed nothing in that repository");
  }
  return { repository, ...(await codingOf(services).runDiff(run.id, repository)) };
}

/** What one `code_task` call of a run changed. */
export async function taskDiff(
  services: RunReviewServices,
  run: RunRow,
  callId: string,
): Promise<Item> {
  const repository = taskDiffRepository(await getToolResultMetadata(services.db, run.id, callId));
  if (repository === null) {
    throw new RunRequestError(404, "that call has no task diff");
  }
  return { repository, ...(await codingOf(services).runDiff(run.id, repository, callId)) };
}

/** The log the harness of one `code_task` call kept. */
export async function taskLog(services: RunReviewServices, run: RunRow, callId: string): Promise<HarnessLog> {
  const harness = taskLogHarness(await getToolResultMetadata(services.db, run.id, callId));
  if (harness === null) {
    throw new RunRequestError(404, "that call has no harness log");
  }
  return codingOf(services).harnessLog(run.id, callId, harness);
}
