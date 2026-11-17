import { Type } from "typebox";
import { agentSecrets, snapshotEnvValues } from "../access/runtime.js";
import {
  agentGitIdentity,
  CloneFailure,
  cloneFailures,
  eraseRepositoryTokens,
  repositoryTokens,
} from "../coding/git.js";
import { RepositoryTokenInstallationGoneError } from "../coding/github-provider.js";
import { retireInstallationGone } from "../coding/guild-repositories.js";
import { codingRepositoriesDatabase, loadAgentRepositories, type CodingRepositoriesDatabase } from "../coding/agent-repositories.js";
import type { PickedRepository } from "../coding/repositories.js";
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
import { harnessTurnCallId, type SubscriptionGeneration } from "./harness-loop.js";
import type { AgentMachines } from "./machines.js";
import type { GenerationTools } from "./tool-calls.js";
import { maintenanceRun } from "./workspace.js";

export const RUN_DIFF_MAX_BYTES = 256 * 1024;

/** A diff the agent's machine produced: at most `RUN_DIFF_MAX_BYTES` of it, redacted, and whether it was cut. */
export type CodeDiff = { diff: string; truncated: boolean };

/** The db/ functions subscription turns read and keep their repositories, logins and checkpoints through, the retiring of a login, and the minting of a run's repository tokens. */
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

/** The db/ functions subscription turns read and keep their repositories, logins and checkpoints through, the retiring of a login, and the minting of a run's repository tokens, on `db`. */
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

/** What subscription turns are run with, built once by the loop. */
export type CodingRunsServices = {
  db: CodingRunsDatabase;
  generations: ActiveGenerations;
  machines: AgentMachines;
  events: RunEventBus;
  /** The toolbox's services, which a harness check records the agent's logins through. */
  tools: ToolServices;
};

/** The repositories the helper's `git_setup` lists under one of its failures, with why. */
function failedClones(value: JsonValue | undefined): CloneFailure[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const failure = isObjectNode(item) ? keepMatching(CloneFailure, item) : null;
    return failure === null ? [] : [failure];
  });
}

/** Logs each clone `git_setup` could not fetch: the generation works on it as it was. */
function warnUnfetched(gen: RunGeneration, unfetched: CloneFailure[]): void {
  for (const { name, error } of unfetched) {
    writeLog("warn", `${name} was not fetched, so it stays as the last fetch left it: ${error}`, {
      ...gen.log,
      operation: "repository.fetch",
    });
  }
}

/** A checkpoint's record of one repository as the run keeps it: its checkpoints and diffstat, without the files a call's record lists. */
function repositoryChange(record: RunRepositoryChange): RunRepositoryChange {
  const { name, branch, head_sha, start_sha, end_sha, files_changed, insertions, deletions } = record;
  return { name, branch, head_sha, start_sha, end_sha, files_changed, insertions, deletions };
}

/**
 * What a generation does in the repositories its agent picks, on a key or a subscription, and
 * what a subscription agent's turn does around its CLI: the harness checked, and the turn's
 * checkpoints in those repositories; and, outside a run, a turn's diff and the harness check an
 * operator asks for.
 */
export class CodingRuns {
  constructor(private readonly services: CodingRunsServices) {}

  /** Whether the run's harness is installed and has a credential; a turn whose harness cannot run fails here. */
  async harnessReady(turn: RunGeneration, run: ToolRun): Promise<boolean> {
    try {
      await assertHarnessReady(this.services.tools, run);
      return true;
    } catch (error) {
      await this.services.events.recordError(turn, error instanceof HarnessSetupError ? error.code : "harness.check", error);
      return false;
    }
  }

  /**
   * The repositories `agent`, whose run the generation `gen` is, picks, placed in its machine with
   * tokens that push branches or read the ones it only reads, and kept on the generation's run
   * record, whose end empties their tokens (`releaseRepositories`); true at once for an agent that
   * picks none. False when placing them failed, and the run says why.
   */
  async prepareRepositories(gen: RunGeneration, agent: AgentRow, sandbox: SandboxHandle, tools: GenerationTools): Promise<boolean> {
    if (!agent.config.repositories.length) {
      return true;
    }
    const repositories = await this.placeRepositories(gen, agent, sandbox, tools);
    if (repositories === null) {
      return false;
    }
    tools.run.code_repositories = repositories.map((row) => row.name);
    return true;
  }

  /**
   * A subscription turn's repositories, the ones its agent picks, prepared as any generation's
   * are, and the turn's start checkpoint of each.
   */
  async prepareTurnRepositories(gen: SubscriptionGeneration, sandbox: SandboxHandle, tools: GenerationTools): Promise<boolean> {
    if (!(await this.prepareRepositories(gen, gen.agent, sandbox, tools))) {
      return false;
    }
    const names = tools.run.code_repositories;
    if (names.length) {
      await this.checkpoint(maintenanceRun(gen.runId, gen.agent, sandbox), "start", names, harnessTurnCallId(gen));
    }
    return true;
  }

  /**
   * Places the repositories `agent`, whose run the generation `gen` is, picks in its machine: a
   * token for each one with a git provider, minted through it, that pushes branches or, for one
   * the agent only reads, reads it (written under /run/guilds and added to the run's redaction
   * values; a GitHub login whose installation GitHub refuses is retired as `installation_gone`),
   * the agent's git identity, a clone of each one missing from the workspace, a fetch of each one
   * there, and pushing turned off in each clone the agent only reads. Tokens that expire are
   * replaced before each command once they near it. Null when a token or a clone failed, and the
   * run says why; a fetch that failed is logged.
   */
  private async placeRepositories(
    gen: RunGeneration,
    agent: AgentRow,
    sandbox: SandboxHandle,
    tools: GenerationTools,
  ): Promise<PickedRepository[] | null> {
    const { db, events } = this.services;
    const { repositories } = await loadAgentRepositories(db, agent);
    const tokens = db.repositoryTokens(repositories);
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
          repositories: repositories.map((row) => ({ name: row.name, url: row.url, read_only: row.read_only })),
        },
        { timeoutSeconds: 60 + 600 * Math.max(1, repositories.length) },
      );
      failed = failedClones(setup.meta.failed);
      warnUnfetched(gen, failedClones(setup.meta.unfetched));
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
   * Ends a subscription turn in its `repositories`: takes the turn's end checkpoint, and keeps on
   * the run what the turn changed when it changed a repository. A turn without repositories has
   * nothing to end.
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
  }

  /**
   * Empties `agent`'s tokens file once a generation that placed `repositories` ends, however it
   * ends, so the credential helper answers no repository until the next generation writes it. A
   * generation that placed none wrote none.
   */
  async releaseRepositories(agent: AgentRow, sandbox: SandboxHandle, repositories: string[]): Promise<void> {
    if (repositories.length && sandbox.files) {
      await eraseRepositoryTokens(sandbox.files, agent.id);
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
