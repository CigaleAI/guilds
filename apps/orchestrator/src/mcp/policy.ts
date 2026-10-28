
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
