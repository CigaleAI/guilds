import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { builderGuidance, searchableNames, systemOfRecordNames } from "../connectors/builder.js";
import { hereDir } from "../lib/paths.js";
import { MEMORY_INTRO } from "../memory/index.js";
import {
  REPOSITORIES_INTRO,
  TASK_INTRO,
  standingForCapabilities,
  stateIntroForCapabilities,
} from "../prompts/index.js";
import { ConversationError } from "./errors.js";

export const SHARED_CONTENT_TRUST = "content-trust.md";
export const SHARED_PROMPT_PLACEMENT = "prompt-placement.md";
export const SHARED_WRITING = "writing.md";
export const SHARED_TASK_SHAPE = "task-shape.md";
export const SHARED_AGENT_PROMPT = "agent-prompt.md";
export const AGENT_GUIDELINES_TEMPLATE = "../prompts/system.md";
export const BUILDER_SYSTEM_TEMPLATE = "../builder/system.md";
export const BUILDER_WRITE_EXAMPLE = "../builder/write-example.json";

export type CoachTemplateOptions = {
  /** The agent Guidelines template the coach is shown; the repository's own when absent. */
  guidelinesPath?: string | undefined;
};

/** Every capability part kept: the coach reads the superset of what any agent gets. */
const EVERY_CAPABILITY = {
  scripts: true,
  notes: true,
  browser: true,
  coding: true,
  memory: true,
  memoryWrite: true,
} as const;

function readTemplate(relative: string, metaUrl = import.meta.url): string {
  const filePath = path.join(hereDir(metaUrl), relative);
  if (!existsSync(filePath)) {
    throw new ConversationError(422, `${relative} not found`);
  }
  return readFileSync(filePath, "utf8").replace(/\s+$/, "") + "\n";
}

function readAgentGuidelines(guidelinesPath: string | undefined, metaUrl: string): string {
  const filePath = guidelinesPath ?? path.join(hereDir(metaUrl), AGENT_GUIDELINES_TEMPLATE);
  if (!existsSync(filePath)) {
    throw new ConversationError(422, "system.md not found");
  }
  return standingForCapabilities(readFileSync(filePath, "utf8"), EVERY_CAPABILITY).trim();
}

export function readSharedContentTrust(metaUrl = import.meta.url): string {
  return readTemplate(SHARED_CONTENT_TRUST, metaUrl);
}

export function readSharedPromptPlacement(metaUrl = import.meta.url): string {
  return readTemplate(SHARED_PROMPT_PLACEMENT, metaUrl);
}

export function readSharedWriting(metaUrl = import.meta.url): string {
  return readTemplate(SHARED_WRITING, metaUrl);
}

export function readSharedTaskShape(metaUrl = import.meta.url): string {
  return readTemplate(SHARED_TASK_SHAPE, metaUrl);
}

/** What every agent already reads: the four sections, their intros, and the Guidelines. */
export function readSharedAgentPrompt(options: CoachTemplateOptions = {}, metaUrl = import.meta.url): string {
  return readTemplate(SHARED_AGENT_PROMPT, metaUrl)
    .replace("{{TASK_INTRO}}", () => TASK_INTRO)
    .replace("{{STATE_INTRO}}", () => `${stateIntroForCapabilities(EVERY_CAPABILITY)} ${REPOSITORIES_INTRO}`)
    .replace("{{MEMORY_RULES}}", () => MEMORY_INTRO)
    .replace("{{AGENT_GUIDELINES}}", () => readAgentGuidelines(options.guidelinesPath, metaUrl));
}

export function readBuilderWriteExample(metaUrl = import.meta.url): Record<string, unknown> {
  const filePath = path.join(hereDir(metaUrl), BUILDER_WRITE_EXAMPLE);
  if (!existsSync(filePath)) {
    throw new ConversationError(422, `${BUILDER_WRITE_EXAMPLE} not found`);
  }
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConversationError(422, `${BUILDER_WRITE_EXAMPLE} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export function readBuilderSystemTemplate(options: CoachTemplateOptions = {}, metaUrl = import.meta.url): string {
  const raw = readTemplate(BUILDER_SYSTEM_TEMPLATE, metaUrl);
  const guidance = builderGuidance();
  return raw
    .replace("{{CONTENT_TRUST}}", () => readSharedContentTrust(metaUrl).replace(/\s+$/, ""))
    .replace("{{PROMPT_PLACEMENT}}", () => readSharedPromptPlacement(metaUrl).replace(/\s+$/, ""))
    .replace("{{WRITING}}", () => readSharedWriting(metaUrl).replace(/\s+$/, ""))
    .replace("{{TASK_SHAPE}}", () => readSharedTaskShape(metaUrl).replace(/\s+$/, ""))
    .replace("{{AGENT_PROMPT}}", () => readSharedAgentPrompt(options, metaUrl).replace(/\s+$/, ""))
    .replace("{{SEARCHABLE_WORKSPACES}}", () => searchableNames())
    .replace("{{SYSTEMS_OF_RECORD}}", () => systemOfRecordNames())
    .replace(guidance ? "{{CONNECTOR_GUIDANCE}}" : "{{CONNECTOR_GUIDANCE}}\n\n", () => guidance);
}
