import { DEFAULT_GUILD_AGENTS, guildOperators } from "./validation.js";

/** A guild as the API answers it. */
export function guildItem(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    about: row.about || "",
    description: row.description || "",
    max_agents: Number(row.max_agents ?? DEFAULT_GUILD_AGENTS),
    git_author_email: typeof row.git_author_email === "string" ? row.git_author_email : "",
    database: false,
    visibility: row.visibility || "org",
    operators: guildOperators(row),
    routines_enabled: row.routines_enabled !== false,
  };
}
