import { accessDatabase, agentSecrets } from "../access/runtime.js";
import { secretAliasesOf } from "../agents/validation.js";
import type { AgentRow } from "../db/agents.js";
import { isPlainRecord, jsonObj } from "../db/json.js";
import type { Queryable } from "../db/pg.js";
import { getToolResultMetadata, type RunRow } from "../db/runs.js";
import { HARNESSES, type Harness } from "../db/schema/index.js";
import type { CodingRuns } from "../generation/coding.js";
import { RunRequestError } from "../generation/errors.js";
import { harnessEffortOf } from "./harness-models.js";
import {
  HARNESS_INFO,
  harnessLoginOf,
  harnessModelOf,
  harnessOf,
  harnessSecretSource,
  isHarness,
} from "./harnesses.js";

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
function taskDiffRepository(metadata: Item | null): string | null {
  const repository = metadata?.tool_name === "code_task" ? metadata.repository : null;
  return typeof repository === "string" && repository && typeof metadata?.end_sha === "string"
    ? repository
    : null;
}

/** The harness a `code_task` call ran on, when its result names one and the log it kept. */
function taskLogHarness(metadata: Item | null): Harness | null {
  const harness = metadata?.tool_name === "code_task" ? metadata.harness : null;
  return isHarness(harness) && typeof metadata?.log_path === "string" && metadata.log_path
    ? harness
    : null;
}

/** The repositories a run changed, as its metadata lists them. */
function changedRepositories(run: RunRow): Item[] {
  const metadata = jsonObj(run.metadata);
  const repos = isPlainRecord(metadata) && Array.isArray(metadata.repos) ? metadata.repos : [];
  return repos.filter(isPlainRecord);
}

/** One harness of the agent: its secret, whether the agent is granted it, and the login its home holds. */
function harnessView(
  harness: Harness,
  logins: Item,
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
    (await agentSecrets(accessDatabase(services.db), agent)).map((secret) => secret.name),
  );
  const aliases = secretAliasesOf(config);
  const stored = jsonObj(agent.harness_logins);
  const logins = isPlainRecord(stored) ? stored : {};
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
) {
  if (!isHarness(harness)) {
    throw new RunRequestError(422, `harness must be one of: ${HARNESSES.join(", ")}`);
  }
  return codingOf(services).checkHarness(agent.id, harness);
}

export function listRunChanges(run: RunRow): { repositories: Item[] } {
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
export async function taskLog(services: RunReviewServices, run: RunRow, callId: string) {
  const harness = taskLogHarness(await getToolResultMetadata(services.db, run.id, callId));
  if (harness === null) {
    throw new RunRequestError(404, "that call has no harness log");
  }
  return codingOf(services).harnessLog(run.id, callId, harness);
}
