import { Type } from "@sinclair/typebox";
import { agentSecrets, snapshotEnvValues } from "../access/runtime.js";
import {
  agentGitIdentity,
  cloneFailures,
  repositoryTokens,
  RepositoryTokenInstallationGoneError,
} from "../coding/git.js";
import { retireInstallationGone } from "../coding/guild-repositories.js";
import { codingRepositories } from "../coding/repositories.js";
import { clearHarnessLogin, getAgent, markHarnessLogin, type AgentRow } from "../db/agents.js";
import { getGuild, listGuildRepositories } from "../db/guilds.js";
import { isPlainRecord } from "../db/json.js";
import { getMcpConnectionForOwner, type McpConnectionRow } from "../db/mcp.js";
import { bindQuery, type BoundQuery, type Queryable } from "../db/pg.js";
import { getRun, mergeRunMetadata, type RunRow } from "../db/runs.js";
import { RunRepositoryChangeSchema, type Harness, type RunRepositoryChange, type ToolCall } from "../db/schema/index.js";
import { decode } from "../lib/decode.js";
import { RepositoryAccessError } from "../github/tokens.js";
import { GITHUB_SERVER_ID } from "../instance/integrations.js";
import { retireLogin, type LoginFailure } from "../mcp/service.js";
import { errorMessage, errorName, writeLog } from "../observability/log.js";
import { agentRunDir } from "../sandbox/index.js";
import type { SandboxHandle } from "../sandbox/sdk.js";
import { redact } from "../secrets/index.js";
import { callSegment, runCodeHelper } from "../toolbox/code.js";
import { endLostTurn, type LostTurnEnd } from "../toolbox/harness.js";
import { readHarnessLog, type HarnessLog } from "../toolbox/harness-ops.js";
import { interruptedText } from "../toolbox/harness-result.js";
import { assertHarnessReady, checkHarnessOn, HarnessSetupError, type HarnessCheck } from "../toolbox/harness-setup.js";
import { createToolHooks, type ToolRun } from "../toolbox/index.js";
import type { ToolServices } from "../toolbox/services.js";
import type { ActiveGenerations } from "./active-generations.js";
import { RunRequestError } from "./errors.js";
import type { RunEvents, RunGeneration } from "./events.js";
import type { AgentMachines } from "./machines.js";
import { lostCodeTask, type GenerationTools, type InterruptedToolRecord, type LostCodeTask } from "./tool-calls.js";
import { maintenanceRun } from "./workspace.js";

export const RUN_DIFF_MAX_BYTES = 256 * 1024;

/** The db/ functions a coding run's repositories are read through. */
export type CodingRepositoriesDatabase = {
  listGuildRepositories: BoundQuery<typeof listGuildRepositories>;
  getMcpConnectionForOwner: BoundQuery<typeof getMcpConnectionForOwner>;
};

/** The db/ functions a coding run's repositories are read through, on `db`. */
export function codingRepositoriesDatabase(db: Queryable): CodingRepositoriesDatabase {
  return {
    listGuildRepositories: bindQuery(db, listGuildRepositories),
    getMcpConnectionForOwner: bindQuery(db, getMcpConnectionForOwner),
  };
}

/** The GitHub connection a coding run of the agent clones with: the agent's, else its guild's, else its organisation's. */
async function githubConnectionOf(
  db: CodingRepositoriesDatabase,
  agent: AgentRow,
): Promise<McpConnectionRow | null> {
  for (const [scope, ownerId] of [
    ["agent", agent.id],
    ["guild", agent.guild_id],
    ["org", agent.org_id],
  ] as const) {
    const row = ownerId ? await db.getMcpConnectionForOwner(GITHUB_SERVER_ID, scope, ownerId) : null;
    if (row !== null && row.status === "connected") {
      return row;
    }
  }
  return null;
}

/** The guild repositories a coding run of the agent clones, with what its GitHub connection reaches. */
export async function guildRepositories(
  db: CodingRepositoriesDatabase,
  agent: AgentRow,
): Promise<Array<Record<string, unknown>>> {
  return codingRepositories(await db.listGuildRepositories(agent.guild_id), await githubConnectionOf(db, agent));
}

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
  events: RunEvents;
  /** The toolbox's services, which a harness check records the agent's logins through. */
  tools: ToolServices;
};

/** The repositories the helper's `git_setup` could not clone, with why. */
function failedClones(value: unknown): Array<{ name: string; error: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) =>
    isPlainRecord(item) && typeof item.name === "string" && typeof item.error === "string"
      ? [{ name: item.name, error: item.error }]
      : [],
  );
}

/**
 * What a coding run does around its tool calls: the harness checked and the guild's
 * repositories cloned before the model's first step, the end checkpoint taken after its last,
 * and, outside a run, the diff, the harness log, and the harness check an operator asks for.
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

  /**
   * A coding generation's repositories: installation tokens for those with a GitHub
   * connection (written under /run/guilds and added to the run's redaction values; a login
   * whose installation GitHub refuses is retired as `installation_gone`), the
   * agent's git identity, a clone of each one missing from the workspace, and the run's start
   * checkpoint. The working directory starts in the repository when there is one.
   */
  async prepareRepositories(
    turn: RunGeneration,
    agent: AgentRow,
    sandbox: SandboxHandle,
    tools: GenerationTools,
  ): Promise<boolean> {
    const { db, events } = this.services;
    const repositories = await guildRepositories(db, agent);
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
        tools.secrets[`GITHUB_TOKEN_${index + 1}`] = value;
      });
    };
    try {
      await mint();
      if (sandbox.files) {
        await sandbox.commands.run(`mkdir -p -m 700 ${agentRunDir(agent.id)}`, { timeoutSeconds: 10 });
        await tokens.write(sandbox.files, agent.id);
      }
    } catch (error) {
      await events.recordError(turn, "repository.token", error);
      return false;
    }
    const maintenance = maintenanceRun(turn.runId, agent, sandbox);
    let failed: Array<{ name: string; error: string }>;
    try {
      const guild = await db.getGuild(agent.guild_id);
      const setup = await runCodeHelper(
        maintenance,
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
      await events.recordError(turn, "repository.clone", error);
      return false;
    }
    if (failed.length) {
      const detail = cloneFailures(failed, repositories, tokens.entries);
      await events.recordError(turn, "repository.clone", new RepositoryAccessError(`clone failed: ${detail}`));
      return false;
    }
    await this.checkpoint(maintenance, "start", agent);
    tools.run.code_repositories = repositories.map((row) => String(row.name));
    if (repositories.length === 1) {
      tools.run.code_default_cwd = `repos/${String(repositories[0]?.name)}`;
    }
    if (tokens.connected.length) {
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
    return true;
  }

  /** The end checkpoint of every working tree, and what the run changed since its start. */
  async recordCheckpoints(runId: string, agent: AgentRow, sandbox: SandboxHandle): Promise<void> {
    const repos = await this.checkpoint(maintenanceRun(runId, agent, sandbox), "end", agent);
    if (repos.length) {
      await this.services.db.mergeRunMetadata(runId, { repos }, new Date());
    }
  }

  /**
   * The diff a run made in one repository, between its start and end checkpoints, or with
   * `task` between one `code_task` call's, from the agent's machine (woken as the CLI tab
   * wakes it), at most 256 KiB and redacted.
   */
  async runDiff(
    runId: string,
    repository: string,
    task: string | null = null,
  ): Promise<{ diff: string; truncated: boolean }> {
    const { agent, sandbox } = await this.runAgent(runId);
    let result;
    try {
      const request = task === null ? { op: "diff", repository } : { op: "diff", repository, task: callSegment(task) };
      result = await runCodeHelper(maintenanceRun(runId, agent, sandbox), createToolHooks(), request, {
        maxBytes: RUN_DIFF_MAX_BYTES,
      });
    } catch (error) {
      throw new RunRequestError(404, errorMessage(error));
    }
    return { diff: redact(result.text, await this.secretValues(agent)), truncated: result.meta.truncated === true };
  }

  /**
   * The kept event log of one `code_task` call of a run, run on `harness`, from the agent's
   * machine (woken as the CLI tab wakes it), redacted with the agent's secrets. Throws 404 once
   * the agent's home no longer keeps it.
   */
  async harnessLog(runId: string, callId: string, harness: Harness): Promise<HarnessLog> {
    const { agent, sandbox } = await this.runAgent(runId);
    const secrets = await this.secretValues(agent);
    let log: HarnessLog | null;
    try {
      log = await readHarnessLog(maintenanceRun(runId, agent, sandbox), harness, callSegment(callId), secrets);
    } catch (error) {
      throw new RunRequestError(503, errorMessage(error));
    }
    if (log === null) {
      throw new RunRequestError(404, "that log is no longer kept: an agent's home keeps its 20 most recent runs");
    }
    return log;
  }

  /** The guild repositories a coding run of the agent clones, by their folder under `repos/`. */
  async repositoryNames(agent: AgentRow): Promise<string[]> {
    return (await guildRepositories(this.services.db, agent)).map((row) => String(row.name));
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
   * A `code_task` the orchestrator never saw finish: the harness gets `stop` on its machine, so
   * it never keeps running with nobody polling it; its state is cleared, the task's end
   * checkpoint is taken, and the result names its session and log.
   */
  async interruptedCodeTask(
    run: RunRow,
    call: ToolCall,
    record: InterruptedToolRecord,
  ): Promise<InterruptedToolRecord> {
    const harness = run.config_snapshot.harness;
    if (harness === null) {
      return record;
    }
    const task = lostCodeTask(run, call, harness);
    const ended = await this.endLostTurn(run.agent_id, task);
    const session_id = ended.session_id ?? task.session_id;
    const content = interruptedText({ ...task, session_id, stopped: ended.stopped });
    const bytes = Buffer.byteLength(content, "utf8");
    return [
      { ...record[0], content },
      {
        ...record[1],
        harness,
        status: "interrupted",
        session_id,
        repository: task.repository ?? "unknown",
        log_path: task.log_path,
        start_sha: ended.start_sha,
        end_sha: ended.end_sha,
        original_bytes: bytes,
        stored_bytes: bytes,
      },
    ];
  }

  /** Ends a lost `code_task` on its agent's machine; a machine that is not running has no harness left to stop. */
  private async endLostTurn(agentId: string, task: LostCodeTask): Promise<LostTurnEnd> {
    const { db, machines } = this.services;
    try {
      const agent = await db.getAgent(agentId);
      const sandbox = agent ? await machines.sandboxes.connectRunning(agent.machine_id) : null;
      if (agent === null || sandbox === null) {
        return { stopped: true, session_id: null, start_sha: null, end_sha: null };
      }
      return await endLostTurn(maintenanceRun(task.run_id, agent, sandbox), task.call_id, task.harness, task.repository);
    } catch (error) {
      writeLog("warn", errorMessage(error), {
        run_id: task.run_id,
        agent_id: agentId,
        operation: "code_task.stop",
        error_type: errorName(error),
      });
      return { stopped: false, session_id: null, start_sha: null, end_sha: null };
    }
  }

  /**
   * Takes a checkpoint of every working tree; the end one lists what each repository changed since
   * the start. One that fails, or reports repositories in another shape, is logged and lists none.
   */
  private async checkpoint(run: ToolRun, which: "start" | "end", agent: AgentRow): Promise<RunRepositoryChange[]> {
    try {
      const result = await runCodeHelper(run, createToolHooks(), { op: "checkpoint", which }, { timeoutSeconds: 300 });
      return which === "end"
        ? decode(Type.Array(RunRepositoryChangeSchema), result.meta.repositories, (problem) => new Error(`checkpoint ${problem}`))
        : [];
    } catch (error) {
      writeLog("warn", errorMessage(error), {
        run_id: run.run_id,
        agent_id: agent.id,
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
