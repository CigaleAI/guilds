import { NAME_RE } from "../lib/names.js";

export const ABOUT_MAX = 200;
export const DESCRIPTION_MAX = 8000;
export const GIT_AUTHOR_EMAIL_MAX = 254;
export const GUILD_VISIBILITIES = ["org", "private"] as const;
export type GuildVisibility = (typeof GUILD_VISIBILITIES)[number];
export const GUILD_OPERATOR_ROLES = ["admin", "operator"] as const;
export type GuildOperatorRole = (typeof GUILD_OPERATOR_ROLES)[number];

/** A guild's about and description as a change asks for them; an absent field stays as it is. */
export type GuildTextPatch = { about?: string; description?: string };

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

/** The fields a guild text patch sets, each validated, the about first. */
export function validateGuildTextPatch(patch: GuildTextPatch): GuildTextPatch {
  return {
    ...(patch.about === undefined ? {} : { about: validateAbout(patch.about) }),
    ...(patch.description === undefined ? {} : { description: validateGuildDescription(patch.description) }),
  };
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

export function validateRoutinesEnabled(raw: unknown): boolean {
  if (typeof raw !== "boolean") {
    throw new GuildValidationError("routines_enabled must be a boolean");
  }
  return raw;
}

function isGuildVisibility(value: string): value is GuildVisibility {
  return GUILD_VISIBILITIES.some((visibility) => visibility === value);
}

export function validateVisibility(raw: unknown): GuildVisibility {
  const value = raw === undefined || raw === null || raw === "" ? "org" : String(raw);
  if (!isGuildVisibility(value)) {
    throw new GuildValidationError("visibility must be org or private");
  }
  return value;
}

function isGuildOperatorRole(value: string): value is GuildOperatorRole {
  return GUILD_OPERATOR_ROLES.some((role) => role === value);
}

export function validateGuildOperatorRole(raw: unknown): GuildOperatorRole {
  const value = String(raw ?? "");
  if (!isGuildOperatorRole(value)) {
    throw new GuildValidationError("role must be admin or operator");
  }
  return value;
}
