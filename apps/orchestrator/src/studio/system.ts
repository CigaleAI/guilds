import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { utcClock } from "../lib/clock.js";
import { promptHash } from "../prompts/index.js";
import { hereDir } from "../lib/paths.js";
import { readSharedPromptPlacement } from "../conversation/templates.js";
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

export function readStudioSystemTemplate(metaUrl = import.meta.url): string {
  const filePath = studioSystemPath(metaUrl);
  if (!existsSync(filePath)) {
    throw new StudioUnprocessableError("studio system template not found");
  }
  const raw = readFileSync(filePath, "utf8").replace(/\s+$/, "") + "\n";
  return raw.replace("{{PROMPT_PLACEMENT}}", readSharedPromptPlacement().replace(/\s+$/, ""));
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
  const lines = [
    template.replace(/\s+$/, ""),
    "",
    "## Session",
    `- mode: ${args.mode}`,
    `- utc_now: ${clock.utc_now}`,
    `- utc_date: ${clock.utc_date}`,
  ];
  if (args.sourceGuild) {
    lines.push("");
    lines.push("## Source guild");
    lines.push(
      renderStudioBaseHydration({
        sourceGuild: args.sourceGuild,
        members: args.members ?? [],
      }),
    );
  } else {
    lines.push("- source_guild_id: null");
  }
  lines.push("");
  lines.push("## Coach configuration");
  lines.push(JSON.stringify(args.config, null, 2));
  lines.push("");
  lines.push("## Draft contract reminder");
  lines.push(
    "Call studio_create_task_draft with agent_id (id or name of a source-guild member), complete proposed task content, a rationale, and evidence references from committed tool results. Never ask the operator to select a target. Inspector selection is irrelevant. Several drafts may be created in one turn.",
  );
  const content = `${lines.join("\n")}\n`;
  return { content, hash: createHash("sha256").update(content, "utf8").digest("hex") };
}

export function composeGenerationContext(args: {
  sourceGuild: { id: string; name: string; about?: string; objective?: string };
  roster: Array<Record<string, unknown>>;
  target: Record<string, unknown> | null;
  draft: Record<string, unknown> | null;
}): string {
  const members = args.roster
    .filter((agent) => !agent.archived && !agent.archived_at)
    .map((agent) => hydrateStudioMember(agent));
  const rosterLines = args.roster.map((agent) => {
    const name = wrapUntrustedText("agent.name", String(agent.name ?? ""));
    const focus = String(agent.focus ?? "").trim();
    const focusBlock = focus ? ` focus=${wrapUntrustedText("agent.focus", focus)}` : "";
    const latestRun = agent.latest_run && typeof agent.latest_run === "object"
      ? (agent.latest_run as Record<string, unknown>).kind
      : agent.latest_run_kind;
    return `- ${agent.id} ${name}${focusBlock} task_version=${agent.task_version ?? "null"} source_hash=${agent.task_hash ?? "null"} has_embeds=${Boolean(agent.has_embeds)} routines=${agent.routine_count ?? 0} latest_run=${latestRun ?? "none"}`;
  });
  const parts = [
    wrapEvidence({
      source: "studio.generation_map",
      coordinates: { guild_id: args.sourceGuild.id },
      body: [
        renderStudioBaseHydration({ sourceGuild: args.sourceGuild, members }),
        "",
        "roster_headers:",
        ...rosterLines,
      ].join("\n"),
    }),
  ];
  // Inspector selection is UI-only and is not included in the generation map.
  parts.push(
    "The operator inspector does not restrict this generation. Work from the hydrated guild. Never ask the operator to select a target. Ignore any earlier Studio message that said drafts need an active target. studio_create_task_draft requires agent_id or name of a source-guild member; several drafts may be created in one turn.",
  );
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
