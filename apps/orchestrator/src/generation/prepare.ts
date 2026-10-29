import { existsSync, statSync } from "node:fs";
import { accessDatabase, agentLogins, agentRuntime, type RuntimeAccess } from "../access/runtime.js";
import { validateAgentConfig } from "../agents/config.js";
import { AgentValidationError } from "../agents/validation.js";
import { agentActor } from "../artifacts/actors.js";
import { ArtifactError } from "../artifacts/errors.js";
import { stateRepositories } from "../coding/repositories.js";
import type { AgentConfig, RunTaskSource } from "../db/schema/index.js";
import { FILE_TOOLS, NOTE_TOOLS } from "../seed/catalog.js";
import { listAgents, type AgentRow } from "../db/agents.js";
import { listGroupMessages } from "../db/group-chat.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import { McpDisconnectedError } from "../mcp/errors.js";
import type { McpPool } from "../mcp/pool.js";
import { readMemory } from "../memory/index.js";
import { NotesError, type NotesStore } from "../notes/store.js";
import {
  PromptError,
  composeSystemPrompt,
  connectorGuidance,
  hydratePrompts,
  hydrateStanding,
  standingForCapabilities,
} from "../prompts/index.js";
import { prepareWorkspace } from "../sandbox/index.js";
import type { Scripts } from "../scripts/catalog.js";
import { collectRunState, type RunStateInputs } from "../state/index.js";
import { SCRIPT_TOOLS } from "../toolbox/script.js";
import { serializeHistoryDecision, type GroupRouter } from "../typesafe/index.js";
import type { ActiveGenerations } from "./active-generations.js";
import { codingRepositoriesDatabase, guildRepositories } from "./coding.js";
import { RunRequestError } from "./errors.js";
import type { AgentMachines } from "./machines.js";
import type { PreparedRun } from "./snapshot.js";
import { collectionCatalog } from "../artifacts/collections.js";
import { agentTask, taskSnapshot } from "../artifacts/task.js";
import type { ArtifactStore } from "../artifacts/store.js";
import { toolArtifacts } from "../toolbox/artifacts.js";

/** The artifact functions a generation calls: its tools', and the reads of its prompts, on `store`. */
export function generationArtifacts(store: ArtifactStore) {
  return {
    ...toolArtifacts(store),
    agentTask: bindQuery(store, agentTask),
    taskSnapshot: bindQuery(store, taskSnapshot),
    collectionCatalog: bindQuery(store, collectionCatalog),
  };
}

export type GenerationArtifacts = ReturnType<typeof generationArtifacts>;

/** The db/ functions a run is prepared through, on `db`. */
export function runPreparationDatabase(db: Queryable) {
  return {
    ...accessDatabase(db),
    ...codingRepositoriesDatabase(db),
    listAgents: bindQuery(db, listAgents),
    listGroupMessages: bindQuery(db, listGroupMessages),
  };
}

export type RunPreparationDatabase = ReturnType<typeof runPreparationDatabase>;

/**
 * The connector pool generation calls connection tools, lists their tools, and reads connector
 * State through; `callTool` reads a call's connection and connector through its `database`.
 */
export type ConnectorPool = Pick<McpPool, "call" | "database" | "syncTools" | "state">;

/** What runs are prepared with, built once by the loop. */
export type RunPreparationServices = {
  db: RunPreparationDatabase;
  notes: NotesStore;
  artifacts: GenerationArtifacts | null;
  mcp: ConnectorPool;
  scripts: Scripts;
  groupRouter: GroupRouter;
  generations: ActiveGenerations;
  machines: AgentMachines;
};

/** The parts of the standing prompt a run's agent can use, from its config and the tools it is granted. */
export type PromptCapabilities = {
  scripts: boolean;
  notes: boolean;
  files: boolean;
  browser: boolean;
  coding: boolean;
  memory: boolean;
  memoryWrite: boolean;
};

function promptCapabilities(config: AgentConfig, tools: string[]): PromptCapabilities {
  const memory = config.memory;
  return {
    scripts: config.scripting && SCRIPT_TOOLS.some((name) => tools.includes(name)),
    notes: NOTE_TOOLS.some((name) => tools.includes(name)),
    files: FILE_TOOLS.some((name) => tools.includes(name)),
    browser: Boolean(config.browser),
    coding: Boolean(config.coding),
    memory,
    memoryWrite: memory && tools.includes("memory_write"),
  };
}

function isDir(value: string): boolean {
  return Boolean(value) && existsSync(value) && statSync(value).isDirectory();
}

/**
 * Prepares runs: an agent's config and access checked, its prompts read, and the system prompt
 * composed with the guild's state as the run starts from it.
 */
export class RunPreparation {
  constructor(private readonly services: RunPreparationServices) {}

  /**
   * A run of the agent about to be created. A group run sees the chat through `throughSeq`;
   * any other run sees all of it.
   */
  async prepare(agentId: string, throughSeq: number | null): Promise<PreparedRun> {
    const { db, scripts, groupRouter } = this.services;
    const agent = await this.services.generations.runnableAgent(agentId);
    const { config, access } = await this.agentAccess(agent);
    const members = await db.listAgents(agent.guild_id);
    const [rawStanding, task, memory] = await this.prompts(agent);
    const caps = promptCapabilities(config, access.tools);
    const standing = standingForCapabilities(rawStanding, caps);
    const historyRows = await db.listGroupMessages(agent.guild_id, { throughSeq });
    const history = await groupRouter.history({ rows: historyRows, agentName: agent.name, agentFocus: agent.focus });
    await this.prepareHome(agent);
    const state = this.runState(agent, {
      members,
      operators: agent.guild_operators,
      historyRows: history.rows,
      guildAbout: agent.guild_about,
      guildDescription: agent.guild_description,
      collections: await this.collections(agent),
      secrets: access.secrets,
      scripts: caps.scripts ? await scripts.catalog(agent.id) : [],
      maxToolCalls: config.max_tool_calls,
      connectors: await this.connectorState(agent),
      repositories: caps.coding ? stateRepositories(await guildRepositories(db, agent), agent.id) : null,
    });
    return {
      agent,
      config,
      access,
      members,
      historyRows,
      standing,
      system: composeSystemPrompt(standing, task, state, memory, caps, connectorGuidance(access.mcp.map((group) => String(group.slug)))),
      task,
      memory,
      scripts: caps.scripts ? await scripts.snapshot(agent.id) : [],
      taskSource: await this.taskSource(agent),
      typesafe: history.source === "limit" ? null : { history: serializeHistoryDecision(history) },
    };
  }

  /** The agent's validated config and the tools, secrets, and connections it is granted; 422 when either fails. */
  private async agentAccess(agent: AgentRow): Promise<{ config: AgentConfig; access: RuntimeAccess }> {
    try {
      const config = validateAgentConfig(agent.config);
      const access = await agentRuntime(this.services.db, agent, { mcpPool: this.services.mcp });
      return { config, access };
    } catch (error) {
      if (error instanceof AgentValidationError || error instanceof McpDisconnectedError) {
        throw new RunRequestError(422, error.message);
      }
      throw error;
    }
  }

  /**
   * The agent's standing prompt, task, and memory: from the artifact store when the box has
   * one, with the task's embeds inlined as the agent may read them, else from its notes folder.
   */
  async prompts(agent: AgentRow): Promise<[string, string, string]> {
    const { artifacts, notes } = this.services;
    if (artifacts && agent.org_id) {
      return this.storedPrompts(artifacts, agent);
    }
    const agentDir = notes.agentDir(agent.org_slug, agent.guild_name, agent.name);
    if (!isDir(agentDir)) {
      throw new RunRequestError(422, "agent folder not found");
    }
    let system: string;
    let task: string | null;
    try {
      [system, task] = hydratePrompts(agentDir, {
        systemPath: notes.systemPath(),
        includeTask: true,
        notes,
        orgSlug: agent.org_slug,
        guildName: agent.guild_name,
        agentName: agent.name,
        agentId: agent.id,
      });
    } catch (error) {
      if (error instanceof PromptError || error instanceof NotesError) {
        throw new RunRequestError(422, error.message);
      }
      throw error;
    }
    if (typeof task !== "string") {
      throw new RunRequestError(422, "task prompt is required");
    }
    return [system, task, readMemory(agentDir)];
  }

  private async storedPrompts(artifacts: GenerationArtifacts, agent: AgentRow): Promise<[string, string, string]> {
    let system: string;
    try {
      system = hydrateStanding({
        systemPath: this.services.notes.systemPath(),
        agentName: agent.name,
        agentId: agent.id,
      });
    } catch (error) {
      if (error instanceof PromptError) {
        throw new RunRequestError(422, error.message);
      }
      throw error;
    }
    const task = await artifacts.agentTask(agent);
    if (!task.expanded.ok) {
      throw new RunRequestError(422, task.expanded.error);
    }
    return [system, task.expanded.text, task.memoryText];
  }

  /** The agent's home on its machine, created when it is missing. */
  private async prepareHome(agent: AgentRow): Promise<void> {
    const root = await this.services.machines.workspaceRootFor(agent.machine_id);
    prepareWorkspace(root, agent.machine_id, agent.id, { browser: Boolean(agent.config.browser) });
  }

  /** The collections the agent can read; none when the box keeps no artifacts or the store refuses. */
  private async collections(agent: AgentRow): Promise<unknown[]> {
    const { artifacts } = this.services;
    if (!artifacts || !agent.org_id) {
      return [];
    }
    const actor = agentActor({ orgId: agent.org_id, guildId: agent.guild_id, agentId: agent.id, agentName: agent.name });
    try {
      return await artifacts.collectionCatalog(actor);
    } catch (error) {
      if (error instanceof ArtifactError) {
        return [];
      }
      throw error;
    }
  }

  private async connectorState(agent: AgentRow): Promise<Record<string, unknown>> {
    const { mcp, db } = this.services;
    return mcp.state(await agentLogins(db, agent));
  }

  /** The guild's state as the run's system prompt shows it; a notes folder it cannot read is a 422. */
  private runState(agent: AgentRow, inputs: RunStateInputs): Record<string, unknown> {
    try {
      return collectRunState(
        this.services.artifacts ? null : this.services.notes,
        agent.org_slug,
        agent.guild_name,
        agent.name,
        inputs,
      );
    } catch (error) {
      if (error instanceof NotesError) {
        throw new RunRequestError(422, error.message);
      }
      throw error;
    }
  }

  /**
   * Where the run's task came from: its version and hash, its display path, and a snapshot of
   * the notes and collections it embeds as the agent may read them.
   */
  private async taskSource(agent: AgentRow): Promise<RunTaskSource | null> {
    const { artifacts } = this.services;
    if (!artifacts || !agent.org_id) {
      return null;
    }
    return artifacts.taskSnapshot(agent);
  }
}
