import { Type } from "typebox";
import { agentSecrets, snapshotEnvValues } from "../access/runtime.js";
import {
  agentGitIdentity,
  CloneFailure,
  cloneFailures,
  eraseRepositoryTokens,
  repositoryTokens,
  type GitTokenScope,
} from "../coding/git.js";
import { RepositoryTokenInstallationGoneError } from "../coding/github-provider.js";
import { retireInstallationGone } from "../coding/guild-repositories.js";
import { codingRepositoriesDatabase, loadAgentRepositories, type CodingRepositoriesDatabase } from "../coding/agent-repositories.js";
import type { CodingRepository } from "../coding/repositories.js";
import { clearHarnessLogin, getAgent, markHarnessLogin, type AgentRow } from "../db/agents.js";
import { getGuild } from "../db/guilds.js";
import type { McpConnectionRow } from "../db/mcp.js";
import { bindQuery, type BoundQuery, type Queryable } from "../db/pg.js";
import { getRun, mergeRunMetadata } from "../db/runs.js";
import {
  RunRepositoryChangeSchema,
  type Harness,
  type RunRepositoryChange,
  type RunTurnChange,
} from "../db/schema/index.js";
import { assertMatches, keepMatching } from "../lib/decode.js";
import { isObjectNode, type JsonValue } from "../lib/json.js";
import { RepositoryAccessError } from "../github/tokens.js";
import { retireLogin, type LoginFailure } from "../mcp/service.js";
import { errorMessage, errorName, writeLog } from "../observability/log.js";
import { agentRunDir } from "../sandbox/index.js";
import type { SandboxHandle } from "../sandbox/sdk.js";
import { redact } from "../secrets/index.js";
import { callSegment, runCodeHelper } from "../toolbox/code.js";
import { assertHarnessReady, checkHarnessOn, HarnessSetupError, type HarnessCheck } from "../toolbox/harness-setup.js";
import { createToolHooks, type ToolRun } from "../toolbox/index.js";
import type { ToolServices } from "../toolbox/services.js";
import type { ActiveGenerations } from "./active-generations.js";
import { RunRequestError } from "./errors.js";
import type { RunEventBus, RunGeneration } from "./events.js";
import type { Generation, KeyGeneration } from "./generate.js";
import { harnessTurnCallId, type SubscriptionGeneration } from "./harness-loop.js";
import type { AgentMachines } from "./machines.js";
import type { GenerationTools } from "./tool-calls.js";
import { maintenanceRun } from "./workspace.js";

export const RUN_DIFF_MAX_BYTES = 256 * 1024;

/** A diff the agent's machine produced: at most `RUN_DIFF_MAX_BYTES` of it, redacted, and whether it was cut. */
export type CodeDiff = { diff: string; truncated: boolean };

/** The db/ functions coding runs read and keep their repositories, logins and checkpoints through, the retiring of a login, and the minting of a run's repository tokens. */
export type CodingRunsDatabase = CodingRepositoriesDatabase & {
  agentSecrets: BoundQuery<typeof agentSecrets>;
  snapshotEnvValues: BoundQuery<typeof snapshotEnvValues>;
  /** Retires a login that stopped working (`retireLogin`, with no pool to forget it). */
  retireLogin: (connection: McpConnectionRow, failure: LoginFailure) => ReturnType<typeof retireLogin>;
  getAgent: BoundQuery<typeof getAgent>;
  getGuild: BoundQuery<typeof getGuild>;
  getRun: BoundQuery<typeof getRun>;
  mergeRunMetadata: BoundQuery<typeof mergeRunMetadata>;
  markHarnessLogin: BoundQuery<typeof markHarnessLogin>;
  clearHarnessLogin: BoundQuery<typeof clearHarnessLogin>;
  repositoryTokens: BoundQuery<typeof repositoryTokens>;
};

/** The db/ functions coding runs read and keep their repositories, logins and checkpoints through, the retiring of a login, and the minting of a run's repository tokens, on `db`. */
export function codingRunsDatabase(db: Queryable): CodingRunsDatabase {
  return {
    agentSecrets: bindQuery(db, agentSecrets),
    snapshotEnvValues: bindQuery(db, snapshotEnvValues),
    ...codingRepositoriesDatabase(db),
    retireLogin: (connection: McpConnectionRow, failure: LoginFailure) => retireLogin(null, db, connection, failure),
    getAgent: bindQuery(db, getAgent),
    getGuild: bindQuery(db, getGuild),
    getRun: bindQuery(db, getRun),
    mergeRunMetadata: bindQuery(db, mergeRunMetadata),
    markHarnessLogin: bindQuery(db, markHarnessLogin),
    clearHarnessLogin: bindQuery(db, clearHarnessLogin),
    repositoryTokens: bindQuery(db, repositoryTokens),
  };
}

/** What coding runs are run with, built once by the loop. */
export type CodingRunsServices = {
  db: CodingRunsDatabase;
  generations: ActiveGenerations;
  machines: AgentMachines;
  events: RunEventBus;
  /** The toolbox's services, which a harness check records the agent's logins through. */
  tools: ToolServices;
};

/** The repositories the helper's `git_setup` could not clone, with why. */
function failedClones(value: JsonValue | undefined): CloneFailure[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const failure = isObjectNode(item) ? keepMatching(CloneFailure, item) : null;
    return failure === null ? [] : [failure];
  });
}

/** A checkpoint's record of one repository as the run keeps it: its checkpoints and diffstat, without the files a call's record lists. */
function repositoryChange(record: RunRepositoryChange): RunRepositoryChange {
  const { name, branch, head_sha, start_sha, end_sha, files_changed, insertions, deletions } = record;
  return { name, branch, head_sha, start_sha, end_sha, files_changed, insertions, deletions };
}

/**
 * What a coding run does around its tool calls: the harness checked and the agent's
 * repositories cloned before the model's first step, the end checkpoint taken after its last;
 * what a subscription agent's turn does around its CLI in the repositories its agent picks; and,
 * outside a run, the diff, the harness log, and the harness check an operator asks for.
 */
export class CodingRuns {
  constructor(private readonly services: CodingRunsServices) {}

  /** Whether the run's harness is installed and has a credential; a run that cannot delegate code work fails here. */
  async harnessReady(turn: RunGeneration, run: ToolRun): Promise<boolean> {
    try {
      await assertHarnessReady(this.services.tools, run);
      return true;
    } catch (error) {
      await this.services.events.recordError(turn, error instanceof HarnessSetupError ? error.code : "harness.check", error);
      return false;
    }
  }

  /** A coding generation's repositories, placed with tokens that push and open pull requests. */
  async prepareRepositories(gen: KeyGeneration, sandbox: SandboxHandle, tools: GenerationTools): Promise<boolean> {
    const repositories = await this.placeRepositories(gen, sandbox, tools, "push_and_pull_requests");
    if (repositories === null) {
      return false;
    }
    const names = repositories.map((row) => row.name);
    tools.run.code_repositories = names;
    return true;
  }

  /**
   * A subscription turn's repositories, the ones its agent picks, placed with tokens that push
   * branches alone, and the turn's start checkpoint of each; true at once for an agent that picks
   * none.
   */
  async prepareTurnRepositories(gen: SubscriptionGeneration, sandbox: SandboxHandle, tools: GenerationTools): Promise<boolean> {
    if (!gen.agent.config.repositories.length) {
      return true;
    }
    const repositories = await this.placeRepositories(gen, sandbox, tools, "push");
    if (repositories === null) {
      return false;
    }
    const names = repositories.map((row) => row.name);
    await this.checkpoint(maintenanceRun(gen.runId, gen.agent, sandbox), "start", names, harnessTurnCallId(gen));
    tools.run.code_repositories = names;
    return true;
  }

  /**
   * Places the repositories the generation's agent picks in its machine, for a run whose tokens
   * hold `scope`: a token for each one with a git provider, minted through it (written under
   * /run/guilds and added to the run's redaction values; a GitHub login whose installation GitHub
   * refuses is retired as `installation_gone`), the agent's git identity, and a clone of each one
   * missing from the workspace. Tokens that expire are replaced before each command once they
   * near it. Null when a token or a clone failed, and the run says why.
   */
  private async placeRepositories(
    gen: Generation,
    sandbox: SandboxHandle,
    tools: GenerationTools,
    scope: GitTokenScope,
  ): Promise<CodingRepository[] | null> {
    const { db, events } = this.services;
    const { agent } = gen;
    const { repositories } = await loadAgentRepositories(db, agent);
    const tokens = db.repositoryTokens(repositories, scope);
    const mint = async () => {
      try {
        await tokens.mint();
      } catch (error) {
        if (error instanceof RepositoryTokenInstallationGoneError) {
          await retireInstallationGone(db, error.connection);
        }
        throw error;
      }
      tokens.values.forEach((value, index) => {
        tools.secrets[`GIT_TOKEN_${index + 1}`] = value;
      });
    };
    try {
      await mint();
      if (sandbox.files) {
        await sandbox.commands.run(`mkdir -p -m 700 ${agentRunDir(agent.id)}`, { timeoutSeconds: 10 });
        await tokens.write(sandbox.files, agent.id);
      }
    } catch (error) {
      await events.recordError(gen, "repository.token", error);
      return null;
    }
    let failed: CloneFailure[];
    try {
      const guild = await db.getGuild(agent.guild_id);
      const setup = await runCodeHelper(
        maintenanceRun(gen.runId, agent, sandbox),
        createToolHooks(),
        {
          op: "git_setup",
          identity: agentGitIdentity(agent, { email: guild?.git_author_email ?? "" }),
          repositories: repositories.map((row) => ({ name: row.name, url: row.url })),
        },
        { timeoutSeconds: 60 + 600 * Math.max(1, repositories.length) },
      );
      failed = failedClones(setup.meta.failed);
    } catch (error) {
      await events.recordError(gen, "repository.clone", error);
      return null;
    }
    if (failed.length) {
      const detail = cloneFailures(failed, repositories, tokens.entries);
      await events.recordError(gen, "repository.clone", new RepositoryAccessError(`clone failed: ${detail}`));
      return null;
    }
    if (tokens.hasExpiringTokens) {
      tools.hooks.before_command = async () => {
        if (!tokens.needsRefresh()) {
          return;
        }
        await mint();
        if (sandbox.files) {
          await tokens.write(sandbox.files, agent.id);
        }
      };
    }
    return repositories;
  }

  /**
   * Ends a subscription turn in its `repositories`: takes the turn's end checkpoint, keeps on the
   * run what the turn changed when it changed a repository, and empties the tokens file the
   * credential helper answers from. A turn without repositories has nothing to end.
   */
  async endTurnInRepositories(gen: SubscriptionGeneration, sandbox: SandboxHandle, repositories: string[]): Promise<void> {
    if (!repositories.length) {
      return;
    }
    const { db } = this.services;
    const callId = harnessTurnCallId(gen);
    const ended = await this.checkpoint(maintenanceRun(gen.runId, gen.agent, sandbox), "end", repositories, callId);
    const changed = ended.filter((change) => change.files_changed > 0);
    if (changed.length) {
      const kept = (await db.getRun(gen.runId))?.metadata.turn_changes ?? [];
      const turn: RunTurnChange = { call_id: callId, generation: gen.generation, repos: changed };
      await db.mergeRunMetadata(gen.runId, { turn_changes: [...kept, turn] }, new Date());
    }
    if (sandbox.files) {
      await eraseRepositoryTokens(sandbox.files, gen.agent.id);
    }
  }

  /**
   * The diff one subscription turn of a run, `callId`, made in one repository, between the
   * turn's start and end checkpoints, from the agent's machine (woken as the CLI tab wakes it),
   * at most 256 KiB and redacted.
   */
  async turnDiff(runId: string, callId: string, repository: string): Promise<CodeDiff> {
    const { agent, sandbox } = await this.runAgent(runId);
    let result;
    try {
      const request = { op: "diff", repository, task: callSegment(callId) };
      result = await runCodeHelper(maintenanceRun(runId, agent, sandbox), createToolHooks(), request, {
        maxBytes: RUN_DIFF_MAX_BYTES,
      });
    } catch (error) {
      throw new RunRequestError(404, errorMessage(error));
    }
    return { diff: redact(result.text, await this.secretValues(agent)), truncated: result.meta.truncated === true };
  }

  /**
   * Checks the agent's machine, waking it, for what `harness` would run on outside a run: a
   * login in the agent's home or nothing, since a granted secret reaches only a run. Records
   * the login as seen, or forgets it when none is left.
   */
  async checkHarness(agentId: string, harness: Harness): Promise<HarnessCheck> {
    const { db, generations, machines } = this.services;
    const agent = await generations.runnableAgent(agentId);
    const sandbox = await machines.wakeSandbox(agentId);
    let check: HarnessCheck;
    try {
      check = await checkHarnessOn(maintenanceRun("", agent, sandbox), harness);
    } catch (error) {
      throw new RunRequestError(503, errorMessage(error));
    }
    if (check.credential === "login") {
      await db.markHarnessLogin(agentId, { harness, account: check.account }, new Date());
    } else if (check.installed) {
      await db.clearHarnessLogin(agentId, harness);
    }
    return check;
  }

  /**
   * Takes a checkpoint of the working tree of each of the turn's repositories, under the refs of
   * the turn `callId` names; the end one lists what each changed since the start. One that fails,
   * or reports repositories in another shape, is logged and lists none.
   */
  private async checkpoint(
    run: ToolRun,
    which: "start" | "end",
    names: string[],
    callId: string,
  ): Promise<RunRepositoryChange[]> {
    try {
      const request = { op: "checkpoint", which, repositories: names, task: callId };
      const result = await runCodeHelper(run, createToolHooks(), request, { timeoutSeconds: 300 });
      if (which === "start") {
        return [];
      }
      const { repositories } = result.meta;
      assertMatches(Type.Array(RunRepositoryChangeSchema), repositories, (problem) => new Error(`checkpoint ${problem}`));
      return repositories.map(repositoryChange);
    } catch (error) {
      writeLog("warn", errorMessage(error), {
        run_id: run.run_id,
        agent_id: run.agent_id,
        operation: "repository.checkpoint",
        error_type: errorName(error),
      });
      return [];
    }
  }

  /** The run's agent, refused while its guild is being deleted, and its machine, woken. */
  private async runAgent(runId: string): Promise<{ agent: AgentRow; sandbox: SandboxHandle }> {
    const { db, generations, machines } = this.services;
    const run = await db.getRun(runId);
    if (run === null) {
      throw new RunRequestError(404, "run not found");
    }
    const agent = await generations.runnableAgent(run.agent_id);
    return { agent, sandbox: await machines.wakeSandbox(run.agent_id) };
  }

  /**
   * The values of the agent's secrets, which a diff or log read outside a run is redacted
   * with. Output is never served unredacted: secrets that cannot be read refuse it.
   */
  private async secretValues(agent: AgentRow): Promise<Record<string, string>> {
    const { db } = this.services;
    try {
      return await db.snapshotEnvValues(await db.agentSecrets(agent));
    } catch (error) {
      throw new RunRequestError(503, `the agent's secrets cannot be read to redact this: ${errorMessage(error)}`);
    }
  }
}
