import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { utcClock } from "../lib/clock.js";
import { promptHash } from "../prompts/index.js";
import { hereDir } from "../lib/paths.js";
import {
  readSharedAgentPrompt,
  readSharedContentTrust,
  readSharedPromptPlacement,
  readSharedTaskShape,
  readSharedWriting,
  type CoachTemplateOptions,
} from "../conversation/templates.js";
import {
  escapeXml,
  excerptBytes,
  excerptWords,
  wrapEvidence,
  wrapUntrustedText,
} from "../conversation/trust.js";
import { STUDIO_OBJECTIVE_EXCERPT_BYTES, STUDIO_TASK_EXCERPT_WORDS } from "./constants.js";
import { StudioUnprocessableError } from "./errors.js";

export { escapeXml, excerptBytes, excerptWords, wrapEvidence, wrapUntrustedText };

export const STUDIO_SYSTEM_TEMPLATE = "system.md";

export function studioSystemPath(metaUrl = import.meta.url): string {
  return path.join(hereDir(metaUrl), STUDIO_SYSTEM_TEMPLATE);
}

export function readStudioSystemTemplate(options: CoachTemplateOptions = {}, metaUrl = import.meta.url): string {
  const filePath = studioSystemPath(metaUrl);
  if (!existsSync(filePath)) {
    throw new StudioUnprocessableError("studio system template not found");
  }
  const raw = readFileSync(filePath, "utf8").replace(/\s+$/, "") + "\n";
  return raw
    .replace("{{CONTENT_TRUST}}", () => readSharedContentTrust().replace(/\s+$/, ""))
    .replace("{{PROMPT_PLACEMENT}}", () => readSharedPromptPlacement().replace(/\s+$/, ""))
    .replace("{{WRITING}}", () => readSharedWriting().replace(/\s+$/, ""))
    .replace("{{TASK_SHAPE}}", () => readSharedTaskShape().replace(/\s+$/, ""))
    .replace("{{AGENT_PROMPT}}", () => readSharedAgentPrompt(options).replace(/\s+$/, ""));
}

export function studioSystemHash(content: string): string {
  return promptHash(content);
}

export type StudioMemberHydration = {
  id: string;
  name: string;
  focus?: string;
  task_excerpt?: string;
  task_excerpt_truncated?: boolean;
  task_version?: unknown;
  task_hash?: unknown;
};

export function hydrateStudioMember(row: Record<string, unknown>): StudioMemberHydration {
  const content = String(row.task_content ?? row.task_excerpt ?? "");
  const excerpt = excerptWords(content, STUDIO_TASK_EXCERPT_WORDS);
  return {
    id: String(row.id ?? ""),
    name: String(row.name ?? ""),
    focus: String(row.focus ?? ""),
    task_excerpt: excerpt.text,
    task_excerpt_truncated: Boolean(row.task_excerpt_truncated) || excerpt.truncated,
    task_version: row.task_version ?? null,
    task_hash: row.task_hash ?? null,
  };
}

export function renderStudioBaseHydration(args: {
  sourceGuild: { id: string; name: string; about?: string; objective?: string };
  members: StudioMemberHydration[];
}): string {
  const lines = [
    `source_guild_id: ${args.sourceGuild.id}`,
    `source_guild_name: ${escapeXml(args.sourceGuild.name)}`,
  ];
  const about = (args.sourceGuild.about ?? "").trim();
  if (about) {
    lines.push("");
    lines.push(wrapUntrustedText("guild.about", excerptBytes(about, STUDIO_OBJECTIVE_EXCERPT_BYTES).text));
  }
  const objective = (args.sourceGuild.objective ?? "").trim();
  if (objective) {
    lines.push("");
    lines.push(wrapUntrustedText("guild.objective", excerptBytes(objective, STUDIO_OBJECTIVE_EXCERPT_BYTES).text));
  }
  lines.push("");
  lines.push(`members: ${args.members.length}`);
  for (const member of args.members) {
    const excerpt = excerptWords(member.task_excerpt ?? "", STUDIO_TASK_EXCERPT_WORDS);
    const truncated = Boolean(member.task_excerpt_truncated) || excerpt.truncated;
    lines.push("");
    lines.push(`### ${member.id}`);
    lines.push(`- name: ${wrapUntrustedText("agent.name", member.name)}`);
    const focus = (member.focus ?? "").trim();
    if (focus) {
      lines.push(`- focus: ${wrapUntrustedText("agent.focus", focus)}`);
    }
    lines.push(`- task_version: ${member.task_version ?? "null"}`);
    lines.push(`- task_hash: ${member.task_hash ?? "null"}`);
    lines.push(`- task_excerpt_words: ${STUDIO_TASK_EXCERPT_WORDS}`);
    lines.push(`- task_excerpt_truncated: ${truncated}`);
    lines.push(
      wrapEvidence({
        source: "task.excerpt",
        coordinates: { agent_id: member.id, version: member.task_version ?? "", truncated },
        body: excerpt.text || "(empty task)",
      }),
    );
  }
  return lines.join("\n");
}

export function composeStudioSystemMessage(args: {
  mode: string;
  sourceGuild: {
    id: string;
    name: string;
    about?: string;
    objective?: string;
  } | null;
  members?: StudioMemberHydration[];
  config: Record<string, unknown>;
  template?: string;
  now?: Date;
}): { content: string; hash: string } {
  const template = args.template ?? readStudioSystemTemplate();
  const clock = utcClock(args.now);
  const lines = [template.replace(/\s+$/, ""), "", "## Coach configuration", JSON.stringify(args.config, null, 2)];
  if (args.sourceGuild) {
    lines.push("");
    lines.push("## Source guild");
    lines.push(
      renderStudioBaseHydration({
        sourceGuild: args.sourceGuild,
        members: args.members ?? [],
      }),
    );
  }
  lines.push("");
  lines.push("## Session");
  lines.push(`- mode: ${args.mode}`);
  lines.push(`- utc_now: ${clock.utc_now}`);
  lines.push(`- utc_date: ${clock.utc_date}`);
  if (!args.sourceGuild) {
    lines.push("- source_guild_id: null");
  }
  const content = `${lines.join("\n")}\n`;
  return { content, hash: createHash("sha256").update(content, "utf8").digest("hex") };
}

/** An agent as its roster header shows it: what the Studio inventory lists of it. */
export type RosterAgent = {
  id: string;
  name: string;
  focus: string;
  task_version: number;
  task_hash: string;
  has_embeds: boolean;
  routine_count: number;
  latest_run: { kind: string | null } | null;
  draft_id: string | null;
  warnings: string[];
};

function rosterHeader(agent: RosterAgent): string {
  const name = wrapUntrustedText("agent.name", agent.name);
  const focus = agent.focus.trim();
  const focusBlock = focus ? ` focus=${wrapUntrustedText("agent.focus", focus)}` : "";
  const warnings = agent.warnings.length ? agent.warnings.join(",") : "none";
  return `- ${agent.id} ${name}${focusBlock} task_version=${agent.task_version} source_hash=${agent.task_hash} has_embeds=${agent.has_embeds} routines=${agent.routine_count} latest_run=${agent.latest_run?.kind ?? "none"} draft=${agent.draft_id ?? "none"} warnings=${warnings}`;
}

/** The per-generation map: roster headers and the open draft. Task excerpts live in the system message only. */
export function composeGenerationContext(args: {
  sourceGuild: { id: string };
  roster: RosterAgent[];
  draft: Record<string, unknown> | null;
}): string {
  const parts = [
    wrapEvidence({
      source: "studio.generation_map",
      coordinates: { guild_id: args.sourceGuild.id },
      body: ["roster_headers:", ...args.roster.map((agent) => rosterHeader(agent))].join("\n"),
    }),
  ];
  if (args.draft) {
    const rationale = String(args.draft.rationale ?? "");
    parts.push(
      wrapEvidence({
        source: "studio.draft_header",
        coordinates: { draft_id: String(args.draft.id ?? "") },
        body: JSON.stringify(
          {
            id: args.draft.id,
            status: args.draft.status,
            base_version: args.draft.base_version,
            draft_number: args.draft.draft_number,
            rationale: rationale ? wrapUntrustedText("draft.rationale", rationale) : "",
          },
          null,
          2,
        ),
      }),
    );
  }
  return `${parts.join("\n\n")}\n`;
}
