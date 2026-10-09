import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { displayPathFor } from "../artifacts/paths.js";

export const FALLBACK_TASK = "Assist the user and collaborate with the guild members.\n";
export const FALLBACK_TASK_HASH = "80672a5468f14aafbd6e02d8ca30846bdb8483f45e2408190cd4751a9e01d33a";

export type AgentTaskRow = {
  org_id: string;
  agent_id: string;
  content_text: string;
  version: number;
  content_hash: string;
  updated_at: string;
};

export function resolveTaskContent(seed: string, templatesRoot = ""): string {
  const focus = seed.trim();
  if (focus) {
    return `${focus}\n`;
  }
  if (!templatesRoot) {
    return FALLBACK_TASK;
  }
  try {
    return readFileSync(path.join(templatesRoot, "task.md"), "utf8");
  } catch {
    return FALLBACK_TASK;
  }
}

export function hashTaskContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function taskDisplayPath(orgId: string, agentId: string): string {
  return displayPathFor({
    orgId,
    level: "agent",
    ownerId: agentId,
    kind: "task",
    path: "",
    key: "task.md",
  });
}
