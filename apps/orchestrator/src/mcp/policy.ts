import { installedConnectors } from "../connectors/index.js";
import { manifestDefaultOff } from "../connectors/load.js";
import type { Manifest } from "../db/schema/index.js";
import { nameMutates } from "./verbs.js";

export const RESERVED_MCP_SLUGS = new Set([
  "admin",
  "agent",
  "artifact",
  "artifacts",
  "browser",
  "builder",
  "collection",
  "collections",
  "group",
  "issue",
  "issues",
  "mcp",
  "memory",
  "native",
  "note",
  "notes",
  "oauth",
  "object",
  "objects",
  "org",
  "platform",
  "guild",
  "schedule",
  "schedules",
  "script",
  "scripts",
  "studio",
  "system",
  "user",
]);

export const RESERVED_TOOL_PREFIXES = new Set([
  "admin",
  "artifact",
  "browser",
  "builder",
  "collection",
  "group",
  "issue",
  "mcp",
  "memory",
  "native",
  "note",
  "oauth",
  "object",
  "platform",
  "schedule",
  "script",
  "studio",
  "user",
]);

function manifestOf(slug: string): Manifest | null {
  return installedConnectors().bySlug(slug)?.manifest ?? null;
}

/** Whether a connector's manifest starts a tool Off: it is mutating, or a `policy.default_off` pattern matches its name. */
export function isDefaultOffRemote(slug: string, remoteName: string): boolean {
  return manifestDefaultOff(manifestOf(slug), remoteName);
}

/**
 * Whether Studio may proxy a remote tool on an operator-granted connection. Default-off tools
 * are never readable. A tool the connector's manifest lists is readable unless it is mutating.
 * A listed tool's `readOnlyHint` counts only on a verified connector; any other tool is
 * classified by the verbs in its name.
 */
export function isReadOnlyRemote(
  slug: string,
  remoteName: string,
  listing: { readOnlyHint?: boolean | null; verified?: boolean } = {},
): boolean {
  if (isDefaultOffRemote(slug, remoteName)) {
    return false;
  }
  if (manifestOf(slug)?.tools?.some((tool) => tool.name === remoteName)) {
    return true;
  }
  if (listing.verified === true && listing.readOnlyHint === true) {
    return true;
  }
  return !nameMutates(remoteName);
}

export function isReservedSlug(slug: string): boolean {
  return RESERVED_MCP_SLUGS.has(slug);
}

export function isReservedToolPrefix(prefix: string): boolean {
  return RESERVED_TOOL_PREFIXES.has(prefix);
}

export function generateToolPrefix(slug: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = slug.replace(/[^a-z0-9]+/g, "").slice(0, 32) || "mcp";
  if (!used.has(base) && !isReservedToolPrefix(base)) {
    return base;
  }
  let n = 2;
  while (used.has(`${base}${n}`) || isReservedToolPrefix(`${base}${n}`)) {
    n += 1;
  }
  return `${base}${n}`;
}
