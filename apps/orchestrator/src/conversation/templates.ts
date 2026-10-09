import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { builderGuidance, searchableNames, systemOfRecordNames } from "../connectors/builder.js";
import { hereDir } from "../lib/paths.js";
import { ConversationError } from "./errors.js";

export const SHARED_CONTENT_TRUST = "content-trust.md";
export const SHARED_PROMPT_PLACEMENT = "prompt-placement.md";
export const BUILDER_SYSTEM_TEMPLATE = "../builder/system.md";
export const BUILDER_WRITE_EXAMPLE = "../builder/write-example.json";

function readTemplate(relative: string, metaUrl = import.meta.url): string {
  const filePath = path.join(hereDir(metaUrl), relative);
  if (!existsSync(filePath)) {
    throw new ConversationError(422, `${relative} not found`);
  }
  return readFileSync(filePath, "utf8").replace(/\s+$/, "") + "\n";
}


export function readSharedContentTrust(metaUrl = import.meta.url): string {
  return readTemplate(SHARED_CONTENT_TRUST, metaUrl);
}

export function readSharedPromptPlacement(metaUrl = import.meta.url): string {
  return readTemplate(SHARED_PROMPT_PLACEMENT, metaUrl);
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

export function readBuilderSystemTemplate(metaUrl = import.meta.url): string {
  const raw = readTemplate(BUILDER_SYSTEM_TEMPLATE, metaUrl);
  const guidance = builderGuidance();
  return raw
    .replace("{{CONTENT_TRUST}}", readSharedContentTrust(metaUrl).replace(/\s+$/, ""))
    .replace("{{PROMPT_PLACEMENT}}", readSharedPromptPlacement(metaUrl).replace(/\s+$/, ""))
    .replace("{{SEARCHABLE_WORKSPACES}}", searchableNames())
    .replace("{{SYSTEMS_OF_RECORD}}", systemOfRecordNames())
    .replace(guidance ? "{{CONNECTOR_GUIDANCE}}" : "{{CONNECTOR_GUIDANCE}}\n\n", guidance);
}
