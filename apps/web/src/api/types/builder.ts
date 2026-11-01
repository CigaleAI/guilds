import type { ConnectorAuthField, ConnectorFacts } from "./access";
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

/** Where a login a connect widget asks for lives (builder/widgets.ts). */
export type ConnectScope = "org" | "guild" | "agent";

/** A connector as a connect widget shows it; a token connector names the fields its login asks for (builder/widgets.ts). */
export type ConnectServer = Pick<
  CapabilityServer,
  "slug" | "display_name" | "auth" | "oauth_setup_state" | "setup_hint" | "connection_state"
> & { id: string; auth_fields?: ConnectorAuthField[] };

/** What a connect widget shows in either mode: the scopes offered, whether it waits on the operator, and why (builder/widgets.ts). */
type ConnectWidgetFields = {
  widget: "connect";
  recommended_scope: ConnectScope;
  allowed_scopes: ConnectScope[];
  /** The organisation already has a login to the server it names, at the scope it recommends. */
  already_connected: boolean;
  await_operator: boolean;
  reason: string;
  title: string;
  storage_hint: string | null;
};

/** The widget that asks the operator to connect one connector to the organisation now (builder/widgets.ts). */
export type OrgConnectWidget = ConnectWidgetFields & { mode: "org"; server: ConnectServer };

/** The widget that lets the operator connect any published connector, the one the coach named first when it named one (builder/widgets.ts). */
export type AnyConnectWidget = ConnectWidgetFields & {
  mode: "any";
  server: ConnectServer | null;
  servers: ConnectServer[];
};

/** A widget that asks the operator for a login (builder/widgets.ts). */
export type ConnectWidget = OrgConnectWidget | AnyConnectWidget;

/** One choice of a question card (builder/widgets.ts). */
export type QuestionOption = { id: string; label: string; description: string };

/** One question of a question card: its choices, and whether the operator may type another answer or pick several (builder/widgets.ts). */
export type Question = {
  id: string;
  header: string;
  question: string;
  options: QuestionOption[];
  allow_other: boolean;
  multi_select: boolean;
};

/** The card that pauses the coach until the operator answers its questions (builder/widgets.ts). */
export type QuestionWidget = {
  widget: "question";
  await_operator: true;
  title: string;
  questions: Question[];
};

/** A widget a Builder tool result carries, which pauses the coach on the operator (builder/widgets.ts). */
export type BuilderWidget = ConnectWidget | QuestionWidget;
