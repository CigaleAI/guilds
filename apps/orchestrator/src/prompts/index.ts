import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderMemorySection } from "../memory/index.js";
import { STATE_PREFIX } from "../state/index.js";
import { installedConnectors } from "../connectors/index.js";

export class PromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptError";
  }
}

export function promptHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function schemasOffer(schemas: Array<Record<string, unknown>>, name: string): boolean {
  return schemas.some((schema) => {
    const fn = schema.function;
    return Boolean(
      fn && typeof fn === "object" && !Array.isArray(fn) && (fn as { name?: unknown }).name === name,
    );
  });
}

export const TASK_INTRO =
  "The operator's standing purpose for you. Follow it. You do not rewrite " +
  "this section; it is not yours to edit with memory_write.";

const TASK_INTRO_NO_MEMORY =
  "The operator's standing purpose for you. Follow it. You do not rewrite this section.";

export type StandingCaps = {
  scripts: boolean;
  notes: boolean;
  browser: boolean;
  coding: boolean;
  /** Missing means on, matching agent config. */
  memory?: boolean;
  /** Whether `memory_write` is offered. Missing follows `memory`. */
  memoryWrite?: boolean;
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

export const STATE_INTRO =
  "A snapshot of the guild at the start of this run. Use it instead of an " +
  "initial note_find, record_list, or script_list. Call those tools later only when " +
  "you need a refresh.\n" +
  "\n" +
  "`utc_now` is the UTC instant at run creation (ISO-8601). `utc_date` is " +
  "that calendar day, including the weekday. Treat them as the current " +
  "clock. Do not invent a date, weekday, or time of day. " +
  "`max_tool_calls` is the tool-invocation budget for this run. " +
  "`group.about` is the short guild description when set. `group.description` is " +
  "the longer guild brief when set. `group.members` is the agent " +
  "roster and `group.operators` the people the guild works for; use those " +
  "names when tagging. `group.history` is the last 10 public rows, each " +
  "with `sentBy`, the member or operator who wrote it. " +
  "`readable_levels` and `writable_levels` are the note " +
  "levels this agent may use. `collections` lists the collections this agent " +
  "can read (capped at 50): name, purpose, `access` (read or write), `scope` " +
  "(`guild` for a table of this guild, `org` for an organisation table), display " +
  "path, and `columns` (name, type, description, and when set required, " +
  "unique, or the values a text column accepts). Notes are not listed here; " +
  "search them with note_find. `scripts` are reusable Python files at " +
  "`/home/agent/scripts/<name>.py` that read their arguments as JSON from " +
  "stdin; pass them in the `arguments` of script_run, or call a script " +
  "listed with `parameters` as a tool under its name. " +
  "`environment` is the secrets this agent " +
  "has, injected as variables. Read those values from the process environment " +
  "inside a script; never print them.";

export function stateIntroForCapabilities(caps: StandingCaps): string {
  const listing = [
    caps.notes ? "note_find" : null,
    "record_list",
    caps.scripts ? "script_list" : null,
  ].filter((item): item is string => item !== null);
  const listed =
    listing.length === 1
      ? listing[0]
      : listing.length === 2
        ? `${listing[0]} or ${listing[1]}`
        : `${listing[0]}, ${listing[1]}, or ${listing[2]}`;
  let text = STATE_INTRO.replace("initial note_find, record_list, or script_list", `initial ${listed}`);
  if (!caps.notes) {
    text = text.replace(
      "`readable_levels` and `writable_levels` are the note levels this agent may use. ",
      "",
    );
    text = text.replace("Notes are not listed here; search them with note_find. ", "");
  }
  if (!caps.scripts) {
    text = text.replace(
      "`scripts` are reusable Python files at `/home/agent/scripts/<name>.py` that read their arguments as JSON from stdin; pass them in the `arguments` of script_run, or call a script listed with `parameters` as a tool under its name. ",
      "",
    );
    text = text.replace(
      "Read those values from the process environment inside a script; never print them.",
      "The values stay in the process environment; never print them.",
    );
  }
  return text;
}

export const REPOSITORIES_INTRO =
  "`repositories` lists the guild's git repositories: `name`, the `path` of your " +
  "working tree, and the `default_branch`. The platform clones a missing one at run " +
  "start; after that you fetch, branch, commit, and push yourself. Read live git " +
  "state with `shell`.";

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

function applyCapability(text: string, name: string, on: boolean): string {
  const block = new RegExp(`<capability name="${name}">\\n([\\s\\S]*?)\\n</capability>\\n?`, "g");
  const inline = new RegExp(`<capability name="${name}">([\\s\\S]*?)</capability>`, "g");
  if (on) {
    return text.replace(block, "$1\n").replace(inline, "$1");
  }
  return text.replace(block, "").replace(inline, "");
}

/** Strip or unwrap only the Memory capability tags. Other capability tags stay as they are. */
export function standingForMemory(standing: string, memory: boolean, memoryWrite = memory): string {
  let text = standing.replaceAll("\r\n", "\n");
  text = applyCapability(text, "memory_write", memoryWrite);
  text = applyCapability(text, "memory", memory);
  text = applyCapability(text, "no_memory", !memory);
  return text.replace(/\n{3,}/g, "\n\n");
}

export function standingForCapabilities(standing: string, caps: StandingCaps): string {
  let text = standing.replaceAll("\r\n", "\n");
  const memory = memoryOn(caps);
  const memoryWrite = memoryWriteOn(caps);
  text = applyCapability(text, "scripts", caps.scripts);
  text = applyCapability(text, "notes", caps.notes);
  text = applyCapability(text, "browser", caps.browser);
  text = applyCapability(text, "coding", caps.coding);
  text = applyCapability(text, "no_coding", !caps.coding);
  text = applyCapability(text, "memory_write", memoryWrite);
  text = applyCapability(text, "memory", memory);
  text = applyCapability(text, "no_memory", !memory);
  return text.replace(/\n{3,}/g, "\n\n");
}

const PREVIEW_CAPS = {
  scripts: true,
  notes: true,
  browser: true,
  coding: true,
} as const;

/** Compose a run prompt, resolving only the Memory capability from the agent's flag. */
export function composeAgentSystemPrompt(
  standing: string,
  task: string,
  state: Record<string, unknown>,
  memory: string,
  memoryEnabled = true,
  memoryWrite = memoryEnabled,
): string {
  return composeSystemPrompt(standingForMemory(standing, memoryEnabled, memoryWrite), task, state, memory, {
    ...PREVIEW_CAPS,
    memory: memoryEnabled,
    memoryWrite,
  });
}

/** The `prompt.guidance` of each connector whose tools the run offers, in catalog order. */
export function connectorGuidance(offeredSlugs: Iterable<string>): string[] {
  const offered = new Set(offeredSlugs);
  return installedConnectors()
    .entries()
    .flatMap((entry) => (offered.has(entry.manifest.slug) && entry.manifest.prompt ? [entry.manifest.prompt.guidance] : []));
}

export function composeSystemPrompt(
  standing: string,
  task: string,
  state: Record<string, unknown>,
  memory: string,
  caps?: StandingCaps,
  guidance: readonly string[] = [],
): string {
  const snapshot = STATE_PREFIX + JSON.stringify(state, null, 2);
  const introBase = caps ? stateIntroForCapabilities(caps) : STATE_INTRO;
  const intro = [
    introBase,
    ...installedConnectors().entries().map((entry) =>
      entry.manifest.state && entry.manifest.state.key in state ? entry.manifest.state.intro : null,
    ),
    "repositories" in state ? REPOSITORIES_INTRO : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
  const guidelines = [guidelinesBody(standing), ...guidance.map((text) => text.replace(/\s+$/, ""))].join("\n\n");
  const parts = [
    xmlSection("guidelines", guidelines),
    xmlSection("task", `${taskIntroForCapabilities(caps)}\n\n${task.replace(/\s+$/, "")}`),
    xmlSection("state", `${intro}\n\n${snapshot}`),
  ];
  if (memoryOn(caps)) {
    parts.push(renderMemorySection(memory, memoryWriteOn(caps)).replace(/\s+$/, ""));
  }
  return `${parts.join("\n\n")}\n`;
}

function attachIdentity(system: string, agentName: string, agentId: string): string {
  if (!(agentName && agentId)) {
    return system;
  }
  return `${system.replace(/\s+$/, "")}\n\nYou are ${agentName}. Your id is ${agentId}.\n`;
}

export function hydrateStanding(options: {
  systemPath: string;
  agentName: string;
  agentId: string;
}): string {
  if (!existsSync(options.systemPath)) {
    throw new PromptError("system.md not found");
  }
  return attachIdentity(readFileSync(options.systemPath, "utf8"), options.agentName, options.agentId);
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
    system = expander(system, options.orgSlug ?? "", options.guildName ?? "", options.agentName ?? "");
    if (task !== null) {
      task = expander(task, options.orgSlug ?? "", options.guildName ?? "", options.agentName ?? "");
    }
  }
  system = attachIdentity(system, options.agentName ?? "", options.agentId ?? "");
  if (!options.includeTask) {
    return [system, null];
  }
  return [system, task];
}
