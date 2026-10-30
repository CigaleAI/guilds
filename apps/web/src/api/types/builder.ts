import type { ConnectorFacts } from "./access";
import type { OrgModels } from "./models";
import type { RecipeRow } from "./recipes";

/**
 * Shapes of the orchestrator's JSON API for the Builder, as the app reads them. Timestamps are
 * ISO-8601 in UTC.
 */

/** A published connector's tool (capabilities/index.ts). */
export type CapabilityTool = { namespaced_name: string; default_enabled: boolean };

/** A published connector in `GET /api/builder/capabilities` `catalog` (capabilities/index.ts). */
export type CapabilityServer = Partial<ConnectorFacts> & {
  slug: string;
  display_name: string;
  auth: "none" | "token" | "oauth";
  oauth_strategy: "none" | "dynamic" | "configured";
  oauth_setup_state: "not_applicable" | "dynamic" | "configured" | "unsupported";
  description: string;
  limitations: string | null;
  setup_hint: string | null;
  enabled: boolean;
  tool_prefix: string;
  transport: "stdio" | "http";
  connection_state: "connected" | "registered_not_connected";
  reusable_scopes: string[];
  tools: CapabilityTool[];
  searchable: boolean;
  search_via: string | null;
};

/** What the Builder and the recipe pages can use: the connector catalog, models and plan room. */
export type BuilderCapabilities = {
  catalog: CapabilityServer[];
  models: OrgModels;
  /** How many more agents the organisation may hold, by kind; null where nothing caps it. */
  remaining: { agents: number | null; browser_agents: number | null; coding_agents: number | null };
};

/** A Builder session: the coach conversation that writes one draft recipe. */
export type BuilderSession = {
  id: string;
  org_id: string;
  recipe_id: string | null;
  status: "active" | "blocked" | "archived";
  blocked_reason: "input_token_limit" | null;
  generation_state: "idle" | "generating" | "cancelling";
  generation_number: number;
  created_at: string;
  updated_at: string;
  /** The recipe being written; sessions listed together carry only its name, status and version. */
  recipe: RecipeRow;
};

/** A Builder session as its list shows it. */
export type BuilderSessionSummary = Omit<BuilderSession, "recipe"> & {
  recipe: Pick<RecipeRow, "name" | "status" | "body_version"> | null;
};

/** A Builder session to start: its coach's model, and the operator's description of the guild. */
export type NewBuilderSession = { model: string; brief: string };
