import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderMemorySection } from "../memory/index.js";
import { installedManifests } from "../connectors/servers.js";
import { agentHome } from "../lib/agent-file.js";
import type { FunctionTool } from "../lib/tool-schema.js";
import type { RunState } from "../state/index.js";

export class PromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptError";
  }
}

export function promptHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * How a run's prompt names a tool to its model: the tool's own name after `prefix`. A model on a
 * key calls a tool by its own name; a subscription agent's harness calls the orchestrator's MCP
 * server's tools under the prefix it puts before them.
 */
export type ToolNaming = { prefix: string };

/** The naming of a run whose model calls each tool by its own name. */
export const OWN_TOOL_NAMES: ToolNaming = { prefix: "" };

/** The name `tool` is called by under `naming`. */
export function toolName(naming: ToolNaming, tool: string): string {
  return `${naming.prefix}${tool}`;
}

/** Where a prompt's text names a tool: `<tool>name</tool>`, the name as a tool's or a connection tool's. */
const TOOL_TAG = /<tool>([A-Za-z0-9_-]+)<\/tool>/g;

/** Where the standing prompt names the run's tool that opens a pull request on its repositories. */
const PULL_REQUEST_TOOL_TAG = "<pull_request_tool/>";

/** `text` with each tool it names (`<tool>name</tool>`) written by its name under `naming`. */
export function nameTools(text: string, naming: ToolNaming): string {
  return text.replace(TOOL_TAG, (_tag, tool: string) => toolName(naming, tool));
}

/** Whether the offered tools include the one named `name`. */
export function schemasOffer(schemas: readonly FunctionTool[], name: string): boolean {
  return schemas.some((schema) => schema.function.name === name);
}

export const TASK_INTRO =
  "The operator's standing purpose for you. Follow it. You do not rewrite " +
  "this section; it is not yours to edit with <tool>memory_write</tool>.";

const TASK_INTRO_NO_MEMORY =
  "The operator's standing purpose for you. Follow it. You do not rewrite this section.";

export type StandingCaps = {
  scripts: boolean;
  notes: boolean;
  /** Whether the file tools are offered. Missing means off. */
  files?: boolean;
  browser: boolean;
  /** Whether the browser is the agent-optimized one, which offers `browse`. Missing means off. */
  browserOptimized?: boolean;
  /** Missing means on, matching agent config. */
  memory?: boolean;
  /** Whether `memory_write` is offered. Missing follows `memory`. */
  memoryWrite?: boolean;
  /** Whether the run offers any tool, and so has a tool budget. Missing means on. */
  tools?: boolean;
  /** Whether the run offers a note, record, or file tool, or `memory_write`. Missing means on. */
  artifacts?: boolean;
  /** Whether `group_post` is offered. Missing means on. */
  groupPost?: boolean;
  /** Whether the schedule tools are offered. Missing means on. */
  schedules?: boolean;
  /** Whether `report_issue` is offered. Missing means on. */
  issues?: boolean;
  /** Whether the agent's harness runs its turns: a subscription agent. Missing means off. */
  harness?: boolean;
  /** Whether that harness keeps its own system prompt and reads this one as rules beside it. Missing means off. */
  harnessRules?: boolean;
  /** Whether the agent's turns work in repositories it picks. Missing means off. */
  repositories?: boolean;
  /** Whether it only reads some of them. Missing means off. */
  readOnlyRepositories?: boolean;
  /** Whether it pushes to some of them. Missing means off. */
  writableRepositories?: boolean;
  /** The tool the run offers that opens a pull request on those it pushes to; missing or null for none. */
  pullRequestTool?: string | null;
  /** How the prompt names the run's tools. Missing names each by its own name. */
  toolNaming?: ToolNaming;
};

function memoryOn(caps?: StandingCaps): boolean {
  return caps?.memory !== false;
}

function memoryWriteOn(caps?: StandingCaps): boolean {
  return memoryOn(caps) && caps?.memoryWrite !== false;
}

export function taskIntroForCapabilities(caps?: StandingCaps): string {
  return memoryWriteOn(caps) ? TASK_INTRO : TASK_INTRO_NO_MEMORY;
}

/** What precedes the State snapshot's JSON in a prompt. */
export const STATE_PREFIX = "State: ";

export const STATE_INTRO =
  "A snapshot of the guild at the start of this run. Use it as your initial " +
  "context. Call listing tools later only when you need a refresh.\n" +
  "\n" +
  "`utc_now` is the UTC instant at run creation (ISO-8601). `utc_date` is " +
  "that calendar day, including the weekday. Treat them as the current " +
  "clock. Do not invent a date, weekday, or time of day. " +
  "`max_tool_calls` is the tool-invocation budget for this run. " +
  "`group.about` is the short guild goal when set. `group.description` is " +
  "the longer guild goal when set. `group.members` lists every agent in this " +
  "guild and its purpose (`focus`); use those names when tagging. " +
  "`group.operators` lists the people the guild works for; use those names when " +
  "tagging. `group.history` is up to 10 public rows, each " +
  "with `seq`, `sentBy` (the member or operator who wrote it), and `replyToSeq` when it replies to an earlier message. " +
  "`collections` lists the collections this agent " +
  "can read (capped at 50): name, purpose, `access` (read or write), `scope` " +
  "(`guild` for a table of this guild, `org` for an organisation table), display " +
  "path, and `columns` (name, type, description, and when set required, " +
  "unique, or the values a text column accepts). Notes are not listed here. " +
  "Shared files are not listed here. `scripts` are this agent's reusable " +
  "Python files. " +
  "`environment` is the secrets this agent " +
  "has, injected as variables. Never print those values.";

/** The State intro's sentences on listing tools and the tool budget, which a run that offers no tool leaves out. */
const STATE_INTRO_TOOL_SENTENCES = [
  " Call listing tools later only when you need a refresh.",
  "`max_tool_calls` is the tool-invocation budget for this run. ",
];

export function stateIntroForCapabilities(caps: StandingCaps): string {
  const scripted = caps.scripts ? STATE_INTRO : STATE_INTRO.replace("`scripts` are this agent's reusable Python files. ", "");
  if (caps.tools !== false) {
    return scripted;
  }
  return STATE_INTRO_TOOL_SENTENCES.reduce((text, sentence) => text.replace(sentence, ""), scripted);
}

export const REPOSITORIES_INTRO =
  "`repositories` lists the git repositories you work in: `name`, the `path` of your " +
  "working tree, the `default_branch`, and `read_only`, true for one you only read. " +
  "Before each of your turns the platform clones a missing one and fetches the others; " +
  "you branch, commit, and push yourself.";

/** The guild roster as the State section lists it: each agent and its purpose, then the operators. */
export function formatStateRoster(state: RunState): string {
  const agents = state.group.members.map((member) =>
    member.focus ? `- ${member.name}: ${member.focus}` : `- ${member.name}`,
  );
  const operators = state.group.operators.map(
    (operator) => `- ${operator.name} (${operator.role})`,
  );
  const parts: string[] = [];
  if (agents.length) {
    parts.push("Agents in this guild, each with its purpose (`focus`):", ...agents);
  }
  if (operators.length) {
    if (parts.length) {
      parts.push("");
    }
    parts.push("Operators:", ...operators);
  }
  return parts.join("\n");
}

function xmlSection(name: string, body: string): string {
  return `<${name}>\n${body.replace(/\s+$/, "")}\n</${name}>`;
}

function guidelinesBody(standing: string): string {
  let text = standing.replaceAll("\r\n", "\n").replace(/^\s+/, "");
  if (text.startsWith("# Guidelines")) {
    text = text.slice("# Guidelines".length).replace(/^\n+/, "");
  }
  return text.replace(/\s+$/, "");
}

/** What finds a capability tag in standing text: a tag on lines of its own, and one inline. */
type CapabilityTagPatterns = { block: RegExp; inline: RegExp };

function capabilityTagPatterns(name: string): CapabilityTagPatterns {
  return {
    block: new RegExp(`<capability name="${name}">\\n([\\s\\S]*?)\\n</capability>\\n?`, "g"),
    inline: new RegExp(`<capability name="${name}">([\\s\\S]*?)</capability>`, "g"),
  };
}

/** Removes the named capability tags and keeps their content in place. */
function unwrapCapability(text: string, name: string): string {
  const { block, inline } = capabilityTagPatterns(name);
  return text.replace(block, "$1\n").replace(inline, "$1");
}

/** Removes the named capability tags together with their content. */
function stripCapability(text: string, name: string): string {
  const { block, inline } = capabilityTagPatterns(name);
  return text.replace(block, "").replace(inline, "");
}

/**
 * Resolves each listed capability tag: an enabled one is unwrapped, a disabled
 * one is stripped. Tags not listed stay as they are.
 */
function resolveCapabilities(standing: string, enabled: Record<string, boolean>): string {
  let text = standing.replaceAll("\r\n", "\n");
  for (const [name, on] of Object.entries(enabled)) {
    text = on ? unwrapCapability(text, name) : stripCapability(text, name);
  }
  return text.replace(/\n{3,}/g, "\n\n");
}

/** Resolves only the Memory capability tags. Other capability tags stay as they are. */
export function standingForMemory(standing: string, memory: boolean, memoryWrite = memory): string {
  return resolveCapabilities(standing, { memory_write: memoryWrite, memory, no_memory: !memory });
}

/**
 * The standing prompt with each capability part this run has unwrapped and each other one
 * stripped, and the run's pull request tool named where the prompt names it.
 */
export function standingForCapabilities(standing: string, caps: StandingCaps): string {
  const memory = memoryOn(caps);
  const browserOptimized = caps.browserOptimized === true;
  const repositories = caps.repositories === true;
  const pullRequestTool = caps.pullRequestTool ?? null;
  const resolved = resolveCapabilities(standing, {
    key_scripts: caps.harness !== true,
    harness_scripts: caps.harness === true,
    scripts: caps.scripts,
    notes: caps.notes,
    files: caps.files === true,
    browser_standard: caps.browser && !browserOptimized,
    browser_optimized: caps.browser && browserOptimized,
    memory_write: memoryWriteOn(caps),
    memory,
    no_memory: !memory,
    // Each part below holds parts named above, which are resolved first.
    tools: caps.tools !== false,
    artifacts: caps.artifacts !== false,
    group_post: caps.groupPost !== false,
    schedules: caps.schedules !== false,
    issues: caps.issues !== false,
    pull_request_tool: pullRequestTool !== null,
    no_pull_request_tool: pullRequestTool === null,
    read_only_repositories: caps.readOnlyRepositories === true,
    writable_repositories: caps.writableRepositories === true,
    harness_repositories: repositories && caps.harness === true,
    script_repositories: repositories && caps.harness !== true && caps.scripts,
    repositories,
    no_repositories: !repositories,
    harness_rules: caps.harnessRules === true,
    harness: caps.harness === true,
  });
  return pullRequestTool === null ? resolved : resolved.replaceAll(PULL_REQUEST_TOOL_TAG, `<tool>${pullRequestTool}</tool>`);
}

const PREVIEW_CAPS = {
  scripts: true,
  notes: true,
  files: true,
  browser: true,
  browserOptimized: false,
} as const;

/** Compose a run prompt, resolving only the Memory capability from the agent's flag. */
export function composeAgentSystemPrompt(
  standing: string,
  task: string,
  state: RunState,
  memory: string,
  memoryEnabled = true,
  memoryWrite = memoryEnabled,
): string {
  return composeSystemPrompt(
    standingForMemory(standing, memoryEnabled, memoryWrite),
    task,
    state,
    memory,
    {
      ...PREVIEW_CAPS,
      memory: memoryEnabled,
      memoryWrite,
    },
  );
}

/** The `prompt.guidance` of each connector whose tools the run offers, in catalog order. */
export function connectorGuidance(offeredSlugs: Iterable<string>): string[] {
  const offered = new Set(offeredSlugs);
  return installedManifests().flatMap((manifest) =>
    offered.has(manifest.slug) && manifest.prompt ? [manifest.prompt.guidance] : [],
  );
}

/**
 * The run's system prompt: its Guidelines with the connectors' guidance, its Task, State, and
 * Memory, with each tool the text names (`<tool>name</tool>`) written as the run calls it.
 */
export function composeSystemPrompt(
  standing: string,
  task: string,
  state: RunState,
  memory: string,
  caps?: StandingCaps,
  guidance: readonly string[] = [],
): string {
  const snapshot = STATE_PREFIX + JSON.stringify(state, null, 2);
  const introBase = caps ? stateIntroForCapabilities(caps) : STATE_INTRO;
  const intro = [
    introBase,
    ...installedManifests().map((manifest) =>
      manifest.state && manifest.state.key in state ? manifest.state.intro : null,
    ),
    "repositories" in state ? REPOSITORIES_INTRO : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
  const roster = formatStateRoster(state);
  const stateBody = [intro, roster, snapshot].filter((part) => part.length > 0).join("\n\n");
  const guidelines = [
    guidelinesBody(standing),
    ...guidance.map((text) => text.replace(/\s+$/, "")),
  ].join("\n\n");
  const parts = [
    xmlSection("guidelines", guidelines),
    xmlSection("task", `${taskIntroForCapabilities(caps)}\n\n${task.replace(/\s+$/, "")}`),
    xmlSection("state", stateBody),
  ];
  if (memoryOn(caps)) {
    parts.push(renderMemorySection(memory, memoryWriteOn(caps)).replace(/\s+$/, ""));
  }
  return nameTools(`${parts.join("\n\n")}\n`, caps?.toolNaming ?? OWN_TOOL_NAMES);
}

export function attachState(system: string, state: RunState): string {
  return `${system.replace(/\s+$/, "")}\n\n${STATE_PREFIX}${JSON.stringify(state, null, 2)}\n`;
}

function attachIdentity(system: string, agentName: string, agentId: string): string {
  if (!(agentName && agentId)) {
    return system;
  }
  return `${system.replace(/\s+$/, "")}\n\nYou are ${agentName}. Your id is ${agentId}. Your home is ${agentHome(agentId)}.\n`;
}

export function hydrateStanding(options: {
  systemPath: string;
  agentName: string;
  agentId: string;
}): string {
  if (!existsSync(options.systemPath)) {
    throw new PromptError("system.md not found");
  }
  return attachIdentity(
    readFileSync(options.systemPath, "utf8"),
    options.agentName,
    options.agentId,
  );
}

export type PromptNotes = {
  expandWikilinks(text: string, orgSlug: string, guildName: string, agentName: string): string;
};

export function hydratePrompts(
  agentDir: string,
  options: {
    systemPath: string;
    includeTask: boolean;
    notes?: PromptNotes | null;
    orgSlug?: string;
    guildName?: string;
    agentName?: string;
    agentId?: string;
  },
): [string, string | null] {
  if (!existsSync(options.systemPath)) {
    throw new PromptError("system.md not found");
  }
  let system = readFileSync(options.systemPath, "utf8");
  let task: string | null = null;
  if (options.includeTask) {
    const taskPath = path.join(agentDir, "task.md");
    if (!existsSync(taskPath)) {
      throw new PromptError("task.md not found");
    }
    task = readFileSync(taskPath, "utf8");
  }
  const expander = options.notes?.expandWikilinks?.bind(options.notes);
  if (expander) {
    system = expander(
      system,
      options.orgSlug ?? "",
      options.guildName ?? "",
      options.agentName ?? "",
    );
    if (task !== null) {
      task = expander(
        task,
        options.orgSlug ?? "",
        options.guildName ?? "",
        options.agentName ?? "",
      );
    }
  }
  system = attachIdentity(system, options.agentName ?? "", options.agentId ?? "");
  if (!options.includeTask) {
    return [system, null];
  }
  return [system, task];
}
