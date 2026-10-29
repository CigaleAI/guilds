import { agentActor } from "../artifacts/actors.js";
import type { ArtifactFiles } from "../artifacts/files.js";
import { REPOSITORIES_MISSING, REPOSITORIES_MISSING_MESSAGE } from "../coding/harnesses.js";
import { getAgent, type AgentRow } from "../db/agents.js";
import { listBindingsCovering } from "../db/bindings.js";
import { isPlainRecord } from "../db/json.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import { completeRun, getRun, listMessages, type MessageRow, type RunRow } from "../db/runs.js";
import type { GroupChat } from "../groupchat/index.js";
import type { Issues } from "../issues/index.js";
import { agentHome } from "../lib/agent-file.js";
import { INPUT_TOKEN_LIMIT_MESSAGE } from "../llm/index.js";
import { slotPorts } from "../machines/index.js";
import type { NotesStore } from "../notes/store.js";
import { errorName, writeLog } from "../observability/log.js";
import { agentSandbox, applyRunScripts, prepareBrowserWorkspace, prepareWorkspace, seatEnvironment, type SandboxHandle } from "../sandbox/index.js";
import type { Schedules } from "../schedules/service.js";
import type { Scripts } from "../scripts/catalog.js";
import type { RunConfigSnapshot, RunScriptSnapshot } from "../db/schema/index.js";
import { harnessMissingError } from "../toolbox/harness.js";
import { toolboxDatabase } from "../toolbox/services.js";
import { createToolContext, type ToolContext } from "../toolbox/index.js";
import { dynamicScriptTools, liveExtraForAgent, SCRIPT_TOOLS } from "../toolbox/script.js";
import type { ActiveGenerations } from "./active-generations.js";
import { chainOf, completeIfActive, HANDOFF_FRACTION, type RunChains } from "./chain.js";
import { codingRepositoriesDatabase, guildRepositories, type CodingRuns } from "./coding.js";
import { completionRequest, historyTokens, type ModelCompletion } from "./completion.js";
import { GenerationCancelled, RunLimitError } from "./errors.js";
import type { RunEvents, RunGeneration } from "./events.js";
import { agentSeat, type AgentMachines } from "./machines.js";
import { liveOfferedNames, mcpIndex, snapshotOfferedNames, toolSchemaName, withFirstClassScriptTools } from "./offered-tools.js";
import type { GenerationSecrets, RunSecrets } from "./run-secrets.js";
import type { GenerationStarter } from "./runs.js";
import { executedToolCalls, toolCallsOf, type GenerationTools, type ToolCalls } from "./tool-calls.js";
import type { WorkspaceLimits } from "./workspace.js";
import type { GenerationArtifacts } from "./prepare.js";

const TOOL_CALL_LIMIT_MESSAGE = "Tool call limit reached. Start a new run to continue.";
const SCHEDULE_WAKE_PREFIX = "Schedule wake-up: ";

/** A generation under way: its run and agent as it started, and the snapshot it runs with. */
export type Generation = RunGeneration & { run: RunRow; agent: AgentRow; snapshot: RunConfigSnapshot };

/** The containers a generation runs in: its machine's, and the agent's on it with the run's environment. */
type RunSandboxes = { machine: SandboxHandle; agent: SandboxHandle };

/** What a generation offers the model: the tool names, the scripts its snapshot pins, and its connection tools. */
type ToolOffer = { names: Set<string>; scripts: RunScriptSnapshot[]; connections: Record<string, [string, string]> };

/** A coding run's prompt reached the hand-off share of its input limit. */
class HandoffDue extends Error {
  constructor() {
    super("hand-off due");
    this.name = "HandoffDue";
  }
}

/** Whether an operator resumed the run, which then stays open for their messages. */
export function runWasResumed(run: Pick<RunRow, "metadata">): boolean {
  return Boolean(run.metadata.resumed_at);
}

/**
 * Whether the run completes when its generation ends: a schedule run does, and a group
 * continuation does, since the group delivery completes only the chain's first run. A resumed
 * run stays open.
 */
function completesItself(run: RunRow): boolean {
  if (runWasResumed(run)) {
    return false;
  }
  return run.kind === "schedule" || (run.kind === "group" && chainOf(run).index > 1);
}

/** The instruction the run's schedule wake-up message carries; empty when it carries none. */
function scheduleInstructionOf(rows: MessageRow[]): string {
  const raw = rows.find((row) => row.metadata.source === "schedule")?.payload.content;
  if (raw === undefined || !raw.startsWith(SCHEDULE_WAKE_PREFIX)) {
    return "";
  }
  const text = raw.slice(SCHEDULE_WAKE_PREFIX.length);
  try {
    const info: unknown = JSON.parse(text);
    return isPlainRecord(info) ? String(info.instruction || "") : "";
  } catch {
    return text;
  }
}

/** The names the group message that woke the run tags. */
function groupTagsOf(rows: MessageRow[]): string[] {
  const tagged = rows.find((row) => row.metadata.source === "group_chat")?.metadata.tagged ?? [];
  return tagged.filter((item) => item);
}

/** The db/ functions a generation reads its run and keeps its progress through, on `db`. */
export function runGeneratorDatabase(db: Queryable) {
  return {
    listBindingsCovering: bindQuery(db, listBindingsCovering),
    ...codingRepositoriesDatabase(db),
    getRun: bindQuery(db, getRun),
    getAgent: bindQuery(db, getAgent),
    listMessages: bindQuery(db, listMessages),
    completeRun: bindQuery(db, completeRun),
    ...toolboxDatabase(db),
  };
}

export type RunGeneratorDatabase = ReturnType<typeof runGeneratorDatabase>;

/** What a memory write in this run names as its source: the run, and what woke it. */
async function memoryReplacedBy(db: Pick<RunGeneratorDatabase, "listMessages">, run: RunRow): Promise<string> {
  const position = chainOf(run);
  if (position.previous_run_id !== null) {
    return `run ${run.id} (continuation of ${position.previous_run_id})`;
  }
  if (run.kind === "direct") {
    return `run ${run.id} (direct)`;
  }
  const rows = await db.listMessages(run.id);
  if (run.kind === "schedule") {
    return `run ${run.id} (schedule wake-up: "${scheduleInstructionOf(rows)}")`;
  }
  const tags = groupTagsOf(rows);
  return tags.length
    ? `run ${run.id} (group delivery: ${tags.map((name) => `@${name}`).join(", ")})`
    : `run ${run.id} (group delivery)`;
}

/** What generations run with, built once by the loop. */
export type RunGeneratorServices = {
  db: RunGeneratorDatabase;
  notes: NotesStore;
  artifacts: GenerationArtifacts | null;
  files: ArtifactFiles | null;
  groupChat: GroupChat;
  issues: Issues;
  schedules: Schedules;
  scripts: Scripts;
  events: RunEvents;
  generations: ActiveGenerations;
  machines: AgentMachines;
  completion: ModelCompletion;
  coding: CodingRuns;
  workspace: WorkspaceLimits;
  toolCalls: ToolCalls;
  secrets: RunSecrets;
  chains: RunChains;
  starter: Pick<GenerationStarter, "endGeneration">;
};

/**
 * Generates runs: the agent's home, secrets, container, and tools set up, then model steps
 * and their tool calls until the model stops, a limit or failure ends the generation, a coding
 * run hands off, or a cancel stops it.
 */
export class RunGenerator {
  constructor(private readonly services: RunGeneratorServices) {}

  /**
   * Generates the run. A run that handed off generates its continuation in the same admission;
   * any other generation frees its agent when it ends.
   */
  async generate(runId: string, generation: number): Promise<void> {
    const turn: RunGeneration = { runId, generation, log: { run_id: runId } };
    let cancelled = false;
    try {
      cancelled = await this.generateUntilStopped(turn);
    } finally {
      try {
        await this.finish(turn, cancelled);
      } finally {
        await this.continueOrEnd(runId, cancelled);
      }
    }
  }

  /** What a cancelled generation leaves: each of its calls without a result resolved, and the cancel recorded. */
  recordCancel = async (turn: RunGeneration): Promise<void> => {
    await this.services.toolCalls.resolveUnresolved(turn.runId, turn.generation);
    await this.services.events.recordError(turn, "generation.cancelled", new GenerationCancelled());
  };

  /** Runs the generation; true when a cancel stopped it. Any other failure is recorded on the run. */
  private async generateUntilStopped(turn: RunGeneration): Promise<boolean> {
    const { events } = this.services;
    try {
      await events.publish(turn.runId, "generation.started", { generation: turn.generation });
      const started = await this.startedGeneration(turn);
      if (started !== null) {
        await this.runGeneration(started);
      }
      return false;
    } catch (error) {
      if (error instanceof GenerationCancelled) {
        return true;
      }
      await events.recordError(turn, "generation", error);
      return false;
    }
  }

  /** The generation with its run and agent, its log fields naming them; null when either is gone. */
  private async startedGeneration(turn: RunGeneration): Promise<Generation | null> {
    const { db, events } = this.services;
    const run = await db.getRun(turn.runId);
    if (run === null) {
      return null;
    }
    const agent = await db.getAgent(run.agent_id);
    if (agent === null) {
      await events.recordError(turn, "generation", new Error("agent not found"));
      return null;
    }
    turn.log = { run_id: turn.runId, agent_id: agent.id, guild_id: agent.guild_id };
    return { ...turn, run, agent, snapshot: run.config_snapshot };
  }

  /** Settles a cancel, tells the run's subscribers the generation finished, and completes a run that completes itself. */
  private async finish(turn: RunGeneration, cancelled: boolean): Promise<void> {
    const { db, events } = this.services;
    if (cancelled) {
      await this.settleCancel(turn);
    }
    await events.publish(turn.runId, "generation.finished", { generation: turn.generation });
    const finished = await db.getRun(turn.runId);
    if (finished !== null && completesItself(finished)) {
      await db.completeRun(turn.runId, new Date());
    }
  }

  /** Records the cancel once, however many times it is settled; a settlement that fails is logged. */
  private async settleCancel(turn: RunGeneration): Promise<void> {
    try {
      await this.services.generations.settlement(turn.runId, () => this.recordCancel(turn));
    } catch (error) {
      writeLog(
        "error",
        "cancel settlement failed",
        { ...turn.log, operation: "generation.cancelled", error_type: errorName(error) },
        error,
      );
    }
  }

  /** Generates the run's continuation when it handed off and was not cancelled; otherwise ends the generation. */
  private async continueOrEnd(runId: string, cancelled: boolean): Promise<void> {
    const next = this.services.chains.takeContinuation(runId);
    if (next !== null && !cancelled) {
      await this.continueChain(runId, next);
      return;
    }
    this.services.starter.endGeneration(runId);
  }

  /**
   * Hands the agent's admission from a run to its continuation without releasing it, tells the
   * first run's subscribers where the work went, and generates the continuation. The agent
   * stays busy across the chain.
   */
  private async continueChain(fromRunId: string, toRunId: string): Promise<void> {
    const { generations, events } = this.services;
    generations.handOver(fromRunId, toRunId);
    await events.publish(fromRunId, "run.continued", { run_id: toRunId });
    const task = this.generate(toRunId, 1);
    generations.setTask(toRunId, task);
    await task;
  }

  /** Sets the generation up and runs its steps; afterwards a coding run's checkpoints and the workspace sizes are kept. */
  private async runGeneration(gen: Generation): Promise<void> {
    const { coding, workspace, generations } = this.services;
    const ready = await this.setUp(gen);
    if (ready === null) {
      return;
    }
    try {
      await this.runSteps(gen, ready.tools);
    } finally {
      if (gen.snapshot.coding) {
        await coding.recordCheckpoints(gen.runId, gen.agent, ready.sandbox);
      }
      if (!generations.isCancelled(gen.runId)) {
        await workspace.recordSize(gen.runId, gen.agent, ready.sandbox);
      }
    }
  }

  /**
   * What the generation's first step needs: its tools, and its machine's container, where
   * platform work runs with the agent's home and ports and none of its secrets. Null when part
   * of it failed, and the run says why.
   */
  private async setUp(gen: Generation): Promise<{ tools: GenerationTools; sandbox: SandboxHandle } | null> {
    if (!(await this.isStartable(gen)) || !(await this.prepareHome(gen))) {
      return null;
    }
    const secrets = await this.resolveSecrets(gen);
    if (secrets === null) {
      return null;
    }
    const sandboxes = await this.runSandboxes(gen, secrets.env);
    if (sandboxes === null) {
      return null;
    }
    const tools = await this.generationTools(gen, sandboxes, secrets);
    return (await this.isReady(gen, sandboxes.machine, tools)) ? { tools, sandbox: sandboxes.machine } : null;
  }

  /** A coding run starts only with a harness picked and a repository in its guild. */
  private async isStartable(gen: Generation): Promise<boolean> {
    const { db, events } = this.services;
    if (!gen.snapshot.coding) {
      return true;
    }
    if (gen.snapshot.harness === null) {
      const missing = harnessMissingError();
      await events.recordError(gen, missing.code, missing);
      return false;
    }
    if (!(await guildRepositories(db, gen.agent)).length) {
      await events.recordError(gen, REPOSITORIES_MISSING, new Error(REPOSITORIES_MISSING_MESSAGE));
      return false;
    }
    return true;
  }

  /** The agent's home on its machine's host, created when it is missing; the run keeps the host it ran on. */
  private async prepareHome(gen: Generation): Promise<boolean> {
    const { db, events, machines } = this.services;
    const machineId = gen.agent.machine_id;
    try {
      const root = await machines.workspaceRootFor(machineId);
      const host = await machines.sandboxes.machineHost?.(machineId);
      if (host) {
        gen.log.host_id = host.hostId;
        await db.mergeRunMetadata(gen.runId, { host_id: host.hostId }, new Date());
      }
      if (gen.snapshot.browser) {
        prepareBrowserWorkspace(root, machineId, gen.agent.id);
      } else {
        prepareWorkspace(root, machineId, gen.agent.id);
      }
      return true;
    } catch (error) {
      await events.recordError(gen, "workspace.create", error);
      return false;
    }
  }

  private async resolveSecrets(gen: Generation): Promise<GenerationSecrets | null> {
    try {
      return await this.services.secrets.resolve(gen.agent, gen.snapshot);
    } catch (error) {
      await this.services.events.recordError(gen, "secrets.resolve", error);
      return null;
    }
  }

  /** The machine's container, and the agent's on it with the run's environment and its pinned scripts in place. */
  private async runSandboxes(gen: Generation, env: Record<string, string>): Promise<RunSandboxes | null> {
    const { scripts, machines, events } = this.services;
    try {
      const pinned = gen.snapshot.scripts ?? (await scripts.snapshot(gen.agent.id));
      const live = await scripts.listForAgent(gen.agent.id);
      const machine = await machines.sandboxForGeneration(gen.agent);
      const seat = agentSeat(gen.agent);
      const home = agentHome(seat.agentId);
      const agent = agentSandbox(machine, home, { ...env, ...seatEnvironment(seat) });
      await applyRunScripts(agent, home, pinned, liveExtraForAgent(pinned, live));
      return { machine, agent };
    } catch (error) {
      await events.recordError(gen, "sandbox.ensure", error);
      return null;
    }
  }

  /**
   * Whether the generation may take its first step: the workspace has room, and a coding run's
   * harness is ready and its repositories are cloned.
   */
  private async isReady(gen: Generation, sandbox: SandboxHandle, tools: GenerationTools): Promise<boolean> {
    const { workspace, coding } = this.services;
    if (!(await workspace.hasRoom(gen, gen.agent, sandbox))) {
      return false;
    }
    if (!gen.snapshot.coding) {
      return true;
    }
    return (await coding.harnessReady(gen, tools.ctx)) && (await coding.prepareRepositories(gen, gen.agent, sandbox, tools));
  }

  /** The tools the generation calls: those its snapshot froze that the agent's live bindings and settings still offer. */
  private async generationTools(
    gen: Generation,
    sandboxes: RunSandboxes,
    secrets: GenerationSecrets,
  ): Promise<GenerationTools> {
    const frozen = gen.snapshot.tools;
    const offer: ToolOffer = {
      names: await this.offeredNames(gen, frozen),
      scripts: gen.snapshot.scripts ?? [],
      connections: mcpIndex(gen.snapshot.mcp),
    };
    return {
      ctx: await this.toolContext(gen, sandboxes, secrets, offer),
      schemas: withFirstClassScriptTools(
        frozen.filter((tool) => offer.names.has(toolSchemaName(tool))),
        offer.scripts,
        offer.names.has("script_run"),
      ),
      secrets: secrets.values,
      connections: offer.connections,
      maxToolCalls: gen.snapshot.max_tool_calls,
    };
  }

  private async offeredNames(gen: Generation, frozen: RunConfigSnapshot["tools"]): Promise<Set<string>> {
    const { agent, run } = gen;
    const scope = { orgId: agent.org_id || null, guildId: agent.guild_id, agentId: agent.id };
    const rows = await this.services.db.listBindingsCovering(scope);
    const live = agent.config;
    return liveOfferedNames(snapshotOfferedNames(frozen), rows, {
      ...scope,
      browser: live.browser,
      coding: live.coding,
      scripting: live.scripting,
      memory: live.memory,
      schedules: run.kind !== "schedule",
      direct: run.kind === "direct",
    });
  }

  private async toolContext(
    gen: Generation,
    sandboxes: RunSandboxes,
    secrets: GenerationSecrets,
    offer: ToolOffer,
  ): Promise<ToolContext> {
    const { db, notes, artifacts, files, groupChat, issues, schedules, scripts, events, generations, machines } =
      this.services;
    const { runId, agent, snapshot } = gen;
    const seat = agentSeat(agent);
    return createToolContext({
      run_id: runId,
      agent_id: agent.id,
      guild_id: agent.guild_id,
      sandbox: sandboxes.agent,
      secrets: secrets.values,
      notes,
      artifacts,
      files,
      workspace_dir: await machines.agentWorkspace(agent),
      artifact_actor: agent.org_id
        ? agentActor({ orgId: agent.org_id, guildId: agent.guild_id, agentId: agent.id, agentName: agent.name, runId })
        : null,
      guild_name: agent.guild_name,
      agent_name: agent.name,
      org_slug: agent.org_slug,
      cancel_event: generations.cancelEvent(runId),
      track_command: (executionId) => generations.trackCommand(runId, sandboxes.agent, executionId),
      agent_home: agentHome(seat.agentId),
      cdp_port: snapshot.browser ? slotPorts(seat.slot).cdp : null,
      ensure_browser: snapshot.browser ? () => machines.ensureRunBrowser(agent, sandboxes.machine) : null,
      group_chat: groupChat,
      issues,
      schedules,
      scripts: SCRIPT_TOOLS.some((name) => offer.names.has(name)) ? scripts : null,
      run_kind: gen.run.kind,
      secret_names: secrets.refs.map((ref) => ref.name),
      secret_store: this.services.secrets.secretStore(agent),
      memory_replaced_by: await memoryReplacedBy(db, gen.run),
      run_scripts: offer.scripts,
      max_scripts: agent.config.max_scripts,
      dynamic_tools: offer.names.has("script_run") ? dynamicScriptTools(offer.scripts) : {},
      connection_tool_names: Object.keys(offer.connections),
      offered_tools: offer.names,
      harness: snapshot.harness,
      harness_model: snapshot.harness_model,
      harness_effort: snapshot.harness_effort,
      secret_aliases: snapshot.secret_aliases,
      db,
      events,
    });
  }

  /** Model steps until the model stops calling tools, or the step, tool-call, or input limit ends the run. */
  private async runSteps(gen: Generation, tools: GenerationTools): Promise<void> {
    const maxSteps = gen.snapshot.max_steps;
    for (let step = 0; step < maxSteps; step += 1) {
      if (this.services.generations.isCancelled(gen.runId)) {
        throw new GenerationCancelled();
      }
      if (await this.reachedToolLimit(gen, tools)) {
        return;
      }
      const calls = await this.stepOrStop(gen, tools);
      if (calls === null || !calls.length || (await this.reachedToolLimit(gen, tools))) {
        return;
      }
      if (step === maxSteps - 1) {
        await this.services.events.recordError(gen, "generation.max_steps", new Error("max_steps reached"));
        return;
      }
    }
  }

  /** Whether the run has made its last tool call; a run that has completes with `generation.max_tool_calls`. */
  private async reachedToolLimit(gen: Generation, tools: GenerationTools): Promise<boolean> {
    const { db, events } = this.services;
    if (executedToolCalls(await db.listMessages(gen.runId)) < tools.maxToolCalls) {
      return false;
    }
    await events.recordError(
      gen,
      "generation.max_tool_calls",
      new RunLimitError("generation.max_tool_calls", TOOL_CALL_LIMIT_MESSAGE),
    );
    await completeIfActive(db, gen.runId);
    return true;
  }

  /**
   * One model step with its tool calls; null when the step ended the generation: a hand-off, a
   * limit that completes the run, or a failed model call, and the run says which.
   */
  private async stepOrStop(gen: Generation, tools: GenerationTools): Promise<Array<Record<string, unknown>> | null> {
    const { db, events, chains } = this.services;
    try {
      return await this.modelStep(gen, tools);
    } catch (error) {
      if (error instanceof GenerationCancelled) {
        throw error;
      }
      if (error instanceof HandoffDue) {
        await chains.handOff(gen, tools);
        return null;
      }
      if (error instanceof RunLimitError) {
        await events.recordError(gen, error.operation, error);
        await completeIfActive(db, gen.runId);
        return null;
      }
      await events.recordError(gen, "llm.complete", error);
      return null;
    }
  }

  /**
   * Calls the model with the run's history and runs the tool calls it makes. A history over
   * the input limit ends the run; a coding run's history at the hand-off share hands off.
   */
  private async modelStep(gen: Generation, tools: GenerationTools): Promise<Array<Record<string, unknown>>> {
    const { db, completion, events, toolCalls } = this.services;
    const maxInputTokens = gen.snapshot.max_input_tokens;
    const agent = await db.getAgent(gen.run.agent_id);
    const history = await completion.modelHistory(gen, agent, gen.snapshot, tools.schemas);
    const tokens = historyTokens(gen.snapshot, history, tools.schemas);
    if (tokens > maxInputTokens) {
      throw new RunLimitError("generation.max_input_tokens", INPUT_TOKEN_LIMIT_MESSAGE);
    }
    if (gen.snapshot.coding && tokens >= Math.floor(maxInputTokens * HANDOFF_FRACTION)) {
      throw new HandoffDue();
    }
    const reply = await completion.complete(gen.runId, completionRequest(gen.snapshot, history.payloads, tools.schemas));
    await events.commitMessage(gen.runId, reply.payload, { generation: gen.generation, ...reply.metadata });
    const calls = toolCallsOf(reply.payload);
    if (calls.length) {
      await toolCalls.execute(gen, tools, calls);
    }
    return calls;
  }
}

