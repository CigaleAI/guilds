import { DEFAULT_AGENT_MESSAGE_LIMIT } from "../db/schema/index.js";
import { RECIPE_FORMAT, RECIPE_VERSION, type RecipeDocument } from "./schema.js";

export function emptyRecipe(args: {
  name?: string;
  source: { kind: "guild" | "builder" | "file"; guild_id?: string; session_id?: string };
  now?: Date;
}): RecipeDocument {
  return {
    format: RECIPE_FORMAT,
    version: RECIPE_VERSION,
    meta: {
      name: args.name || "Untitled guild",
      description: "",
      created_at: (args.now ?? new Date()).toISOString(),
      source: args.source,
    },
    guild: {
      name_suggestion: "untitled",
      about: "",
      objective: "",
      group_agent_message_limit: DEFAULT_AGENT_MESSAGE_LIMIT,
    },
    roles: [],
    collections: [],
    notes: [],
    connections: [],
    secrets: [],
    external: [],
    repositories: [],
    design: { systems: [], specialization: [], routines: [], handoffs: [], browser: [] },
  };
}
