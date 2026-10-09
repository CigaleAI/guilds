import { NAME_RE } from "../agents/validation.js";
import { jsonObj } from "../db/json.js";

export const ABOUT_MAX = 200;
export const DESCRIPTION_MAX = 8000;
export const GIT_AUTHOR_EMAIL_MAX = 254;
export const DEFAULT_GUILD_AGENTS = 15;
export const DEFAULT_AGENT_MESSAGE_LIMIT = 200;
export const GUILD_VISIBILITIES = ["org", "private"] as const;
export type GuildVisibility = (typeof GUILD_VISIBILITIES)[number];
export const GUILD_OPERATOR_ROLES = ["admin", "operator"] as const;
export type GuildOperatorRole = (typeof GUILD_OPERATOR_ROLES)[number];

export class GuildValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuildValidationError";
  }
}

export function validateGuildName(name: string): string {
  if (!NAME_RE.test(name)) {
    throw new GuildValidationError("name must match ^[a-z][a-z0-9-]{0,62}$");
  }
  return name;
}

export function validateAbout(about: string | null | undefined): string {
  const text = (about ?? "").trim();
  if (text.length > ABOUT_MAX) {
    throw new GuildValidationError(`about must be at most ${ABOUT_MAX} characters`);
  }
  return text;
}

export function validateGuildDescription(description: string | null | undefined): string {
  const text = (description ?? "").trim();
  if (text.length > DESCRIPTION_MAX) {
    throw new GuildValidationError(`description must be at most ${DESCRIPTION_MAX} characters`);
  }
  return text;
}

function trimmedOptionalEmail(raw: unknown): string {
  if (raw === null) {
    return "";
  }
  if (typeof raw !== "string") {
    throw new GuildValidationError("git_author_email must be a string");
  }
  return raw.trim();
}

function emailDomain(text: string): string | null {
  const at = text.indexOf("@");
  if (at <= 0 || at !== text.lastIndexOf("@")) {
    return null;
  }
  return text.slice(at + 1);
}

function looksLikeDnsDomain(domain: string): boolean {
  return domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}

function hasSingleAtWithDomain(text: string): boolean {
  const domain = emailDomain(text);
  return domain !== null && looksLikeDnsDomain(domain);
}

function rejectMalformedEmailAddress(text: string): void {
  if (/\s/.test(text) || !hasSingleAtWithDomain(text)) {
    throw new GuildValidationError("git_author_email must be a single email address");
  }
}

function rejectReservedInvalidEmailDomain(text: string): void {
  const domain = text.slice(text.indexOf("@") + 1).toLowerCase();
  if (domain === "invalid" || domain.endsWith(".invalid")) {
    throw new GuildValidationError("git_author_email must not use a .invalid domain");
  }
}

export function validateGitAuthorEmail(raw: unknown): string {
  const text = trimmedOptionalEmail(raw);
  if (text.length === 0) {
    return "";
  }
  if (text.length > GIT_AUTHOR_EMAIL_MAX) {
    throw new GuildValidationError(`git_author_email must be at most ${GIT_AUTHOR_EMAIL_MAX} characters`);
  }
  rejectMalformedEmailAddress(text);
  rejectReservedInvalidEmailDomain(text);
  return text;
}

export function validateMaxAgents(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new GuildValidationError("max_agents must be a positive integer");
  }
  return value;
}

export class GuildAgentLimitError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(`this guild is limited to ${limit} agents`);
    this.name = "GuildAgentLimitError";
    this.limit = limit;
  }
}

export async function assertGuildAgentRoom(
  repo: {
    getGuild(guildId: string): Promise<Record<string, unknown> | null>;
    countGuildAgents(guildId: string): Promise<number>;
  },
  guildId: string | null,
  adding: number,
): Promise<void> {
  if (adding <= 0) {
    return;
  }
  const row = guildId ? await repo.getGuild(guildId) : null;
  const limit = Number(row?.max_agents ?? DEFAULT_GUILD_AGENTS);
  const cap = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_GUILD_AGENTS;
  const count = guildId ? await repo.countGuildAgents(guildId) : 0;
  if (count + adding > cap) {
    throw new GuildAgentLimitError(cap);
  }
}

export function validateRoutinesEnabled(raw: unknown): boolean {
  if (typeof raw !== "boolean") {
    throw new GuildValidationError("routines_enabled must be a boolean");
  }
  return raw;
}

export function validateVisibility(raw: unknown): GuildVisibility {
  const value = raw === undefined || raw === null || raw === "" ? "org" : String(raw);
  if (!(GUILD_VISIBILITIES as readonly string[]).includes(value)) {
    throw new GuildValidationError("visibility must be org or private");
  }
  return value as GuildVisibility;
}

export type GuildOperator = { user_id: string; name: string; role: GuildOperatorRole };

/** The operators on a guild row (`operators` from the repository), oldest first. */
export function guildOperators(guild: { operators?: unknown }): GuildOperator[] {
  const raw = jsonObj(guild.operators ?? []);
  if (!Array.isArray(raw)) {
    return [];
  }
  const operators: GuildOperator[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const role = String(record.role);
    if ((GUILD_OPERATOR_ROLES as readonly string[]).includes(role)) {
      operators.push({
        user_id: String(record.user_id),
        name: String(record.name),
        role: role as GuildOperatorRole,
      });
    }
  }
  return operators;
}

export function guildRole(guild: { operators?: unknown }, userId: string): GuildOperatorRole | null {
  return guildOperators(guild).find((operator) => operator.user_id === userId)?.role ?? null;
}

/** An org guild is visible to every organisation member; a private one to its operators. */
export function canSeeGuild(
  guild: { visibility?: unknown; operators?: unknown },
  userId: string,
): boolean {
  if (String(guild.visibility ?? "org") !== "private") {
    return true;
  }
  return guildRole(guild, userId) !== null;
}

export function validateGuildOperatorRole(raw: unknown): GuildOperatorRole {
  const value = String(raw ?? "");
  if (!(GUILD_OPERATOR_ROLES as readonly string[]).includes(value)) {
    throw new GuildValidationError("role must be admin or operator");
  }
  return value as GuildOperatorRole;
}
