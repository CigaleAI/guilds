import { Type, type Static, type TObject } from "@sinclair/typebox";
import type { ConversationTool } from "../conversation/runner.js";
import type { RecipeApply } from "../recipes/apply.js";
import { parseRecipe } from "../recipes/parse.js";
import { RECIPE_WRITE_HINT } from "./constants.js";
import {
  searchConnectedWorkspace,
  type BuilderMcpClient,
  type ConnectedDatabase,
} from "./connected.js";
import {
  buildAnyConnectWidget,
  buildOrgConnectWidget,
  buildQuestionWidget,
  ConnectScopeInput,
  QuestionCardInput,
} from "./widgets.js";
import { jsonArgument, toolFunctionSchema } from "../toolbox/schema.js";
import { decodeToolArguments } from "../toolbox/types.js";
import { ToolArgumentError } from "../toolbox/errors.js";
import type { CapabilityService } from "../capabilities/index.js";
import type { RecipeDocument } from "../db/schema/index.js";
import { RecipeConflictError, RecipeError } from "../recipes/errors.js";
import type { Queryable } from "../db/pg.js";
import { getRecipe, type RecipeRow } from "../db/recipes.js";
import { validateLibraryRecipe, writeBuilderRecipe, type RecipeValidation } from "../recipes/library.js";
import type { FunctionTool, ToolSchema } from "../lib/tool-schema.js";
import type { JsonObject } from "../lib/json.js";

export type BuilderCapabilityContext = {
  orgId: string;
  capabilities: CapabilityService;
  db?: ConnectedDatabase;
  mcp?: BuilderMcpClient | null;
};

export type BuilderToolContext = BuilderCapabilityContext & {
  recipeId: string;
  expectedWrite?: boolean;
  /** The connection the recipe is read and written on. */
  connection: Queryable;
  /** The coach's own model: the recommendation a role without one is written with. */
  coachModel?: string;
  /** The services the recipe is validated in its organisation with. */
  apply: RecipeApply;
  onRecipeChanged?: (recipe: RecipeRow) => Promise<void>;
};

/** What a Builder tool returns when it refuses the call: why, and for a version conflict the version the recipe is at. */
export type BuilderToolRefusal = { error: string; code?: "conflict"; body_version?: number | undefined };

/** What a recipe write returns to the coach: the version written and the roster, not the body. */
export type BuilderWriteReceipt = { ok: true; body_version: number; name: string; roles: string[] };

/** What the coach's validate tool returns: the findings and access cuts at the version validated. */
export type BuilderValidation = Pick<RecipeValidation, "findings" | "access_cuts" | "body_version">;

/**
 * A Builder tool as it is written: its name, what it does, the TypeBox schema of its parameters,
 * what the coach is told beside the first mismatch when a call does not match them, and the work
 * it does on a call decoded against them.
 */
type BuilderToolDefinition<C, P extends TObject, R> = {
  name: string;
  description: string;
  /** What the function schema says the tool does; `description` when it is the same. */
  summary?: string;
  parameters: P;
  /** What the coach is told to do when a call's arguments do not match the parameters. */
  mismatchHint?: string;
  run: (ctx: C, input: Static<P>) => Promise<R>;
};

/**
 * A Builder tool as the coach calls it: what it is offered, and the handler of the arguments it
 * writes, which are decoded against the tool's parameters before any work, so a call that does
 * not match them is refused with nothing done.
 */
export type BuilderTool<C, R> = {
  name: string;
  description: string;
  schema: FunctionTool;
  handler: (ctx: C, args: JsonObject) => Promise<R | BuilderToolRefusal>;
};

/** The tool `definition` describes: one declaration of its parameters is both the schema the coach is offered and the decode of its calls. */
function builderTool<C, P extends TObject, R>(definition: BuilderToolDefinition<C, P, R>): BuilderTool<C, R> {
  const { name, description, summary, parameters, mismatchHint, run } = definition;
  return {
    name,
    description,
    schema: toolFunctionSchema(name, summary ?? description, parameters),
    handler: async (ctx, args) => {
      let input: Static<P>;
      try {
        input = decodeToolArguments(parameters, args);
      } catch (error) {
        if (error instanceof ToolArgumentError) {
          const hint = mismatchHint === undefined ? "" : ` ${mismatchHint}`;
          return { error: `invalid ${name} arguments: ${error.message}.${hint}` };
        }
        throw error;
      }
      return run(ctx, input);
    },
  };
}

export const builderListCapabilities = builderTool({
  name: "builder_list_capabilities",
  description:
    "List native tools, the browser capability (operator take-control login at apply when a site has no connector), the coding capability (code tools and repositories), published catalog connectors, models, plan caps, remaining capacity, and reusable org/platform connections. Native group ids are tool groups, not recipe role keys. Call this before naming any system.",
  parameters: Type.Object({}),
  run: (ctx: BuilderCapabilityContext) => ctx.capabilities.listCapabilities({ orgId: ctx.orgId }),
});

export const builderSearchCapabilities = builderTool({
  name: "builder_search_capabilities",
  description:
    "Search published connector descriptions and canonical tool names. Use when the operator names a system or action that is not obvious from builder_list_capabilities.",
  parameters: Type.Object({
    query: Type.String({ description: "Search phrase, slug, or tool name." }),
  }),
  run: (ctx: BuilderCapabilityContext, input) => ctx.capabilities.searchCapabilities({ orgId: ctx.orgId }, input.query),
});

export const builderDescribeServer = builderTool({
  name: "builder_describe_server",
  description:
    "Return one published connector's complete catalog record, including canonical tools. server_ref is a slug or server id from list or search results.",
  parameters: Type.Object({
    server_ref: Type.String({ description: "Catalog slug or server id." }),
  }),
  async run(ctx: BuilderCapabilityContext, input) {
    const record = await ctx.capabilities.describeServer({ orgId: ctx.orgId }, input.server_ref);
    return record ?? { error: "unknown or unpublished connector" };
  },
});

export function builderWriteRejection(
  previous: RecipeDocument,
  next: RecipeDocument,
): string | null {
  if (next.roles.length > 0 && next.roles.every((role) => !role.task.body.trim())) {
    return "refusing a roster with empty task.body on every role. Write standing tasks on the full specialized roster; do not probe the schema with an empty one-role document.";
  }
  if (previous.roles.length >= 2 && next.roles.length < previous.roles.length) {
    const from = previous.roles.map((role) => role.role).join(", ");
    const to = next.roles.map((role) => role.role).join(", ") || "(none)";
    return `refusing to drop roles (${from} → ${to}). Fix the rejected keys and resend the same roster.`;
  }
  return null;
}

const authorProperties: ToolSchema = {
  type: "object",
  properties: {
    by: { type: "string", enum: ["builder", "operator"] },
    reviewed: { type: "boolean" },
  },
  additionalProperties: false,
};

const recipeDocumentParameter: ToolSchema = {
  type: "object",
  properties: {
    format: { type: "string" },
    version: { type: "integer" },
    meta: {
      type: "object",
      properties: {
        name: { type: "string", description: "Guild title. Not a role handle." },
        description: { type: "string" },
        created_at: { type: "string" },
        source: { type: "object" },
      },
      additionalProperties: false,
    },
    guild: {
      type: "object",
      properties: {
        name_suggestion: { type: "string" },
        about: { type: "string" },
        objective: { type: "string" },
        group_agent_message_limit: { type: "integer" },
      },
      additionalProperties: false,
    },
    roles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          role: {
            type: "string",
            description: "Handle matching ^[a-z][a-z0-9-]{0,62}$. Never `name`.",
          },
          name_suggestion: { type: "string" },
          focus: { type: "string" },
          avatar_shape: {
            type: "string",
            description:
              "Omit. The write picks one DiceBear family for the guild and a unique variant per role.",
          },
          avatar_color: {
            type: "string",
            description: "Omit. The write assigns a unique identity colour per role.",
          },
          config: {
            type: "object",
            description:
              "Agent configuration: model, run limits, browser, coding (true for a role that clones, edits, runs, and pushes code; see the coding capability), harness (a coding role's harness: claude-code, codex, cursor, or antigravity; leave it out unless the operator named one), harness_model (the model that harness runs; leave it out unless the operator named one), harness_effort (the reasoning effort that model runs at: none, minimal, low, medium, high, xhigh, max, or ultra; leave it out unless the operator named one), secret_aliases (variable names the role's commands see beside its secrets, each holding the value of the secret it names; leave it out unless the operator asked), and memory (false to omit Memory and memory_write).",
          },
          task: {
            type: "object",
            properties: {
              body: { type: "string", description: "Standing prompt. Never `text`." },
              embeds: {
                type: "array",
                items: { type: "string" },
                description:
                  "guild/<key>, org/<key>, or agent/<role>/<key> for each ![[…]] in task.body. A bare filename does not inline.",
              },
              author: authorProperties,
            },
            required: ["body"],
            additionalProperties: false,
          },
          scripts: { type: "array" },
          schedules: {
            type: "array",
            description: "Role wakes. Never `routines` on the role.",
            items: {
              type: "object",
              properties: {
                key: { type: "string" },
                cron: {
                  type: "string",
                  description: "5-field UTC cron. Set cron or window, not both.",
                },
                window: {
                  type: "object",
                  description: "Random daily wake-ups between start and end local time.",
                  properties: {
                    timezone: { type: "string", description: "IANA name, e.g. Europe/Paris." },
                    start: { type: "string", description: "HH:MM" },
                    end: { type: "string", description: "HH:MM" },
                    max_wakes: { type: "integer" },
                  },
                  required: ["timezone", "start", "end", "max_wakes"],
                  additionalProperties: false,
                },
                description: { type: "string" },
                instruction: { type: "string", description: "Plain string, not { text }." },
                author: authorProperties,
              },
              required: ["key", "instruction"],
              additionalProperties: false,
            },
          },
          native_tools: { type: "object" },
          browser: {
            type: "object",
            properties: {
              required: { type: "boolean" },
              instructions: { type: "string" },
              author: authorProperties,
            },
            additionalProperties: false,
          },
        },
        required: ["role", "task"],
        additionalProperties: false,
      },
    },
    collections: {
      type: "array",
      description:
        "Typed tables of the guild or of the organisation. Apply creates each one or reuses a live organisation table of that name.",
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Table name matching ^[a-z][a-z0-9_-]{0,62}$, unique in the organisation.",
          },
          purpose: {
            type: "string",
            description: "One line: what one record is and who writes it.",
          },
          columns: {
            type: "array",
            description:
              "The typed columns, in display order. Every record write is validated against them.",
            items: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description:
                    "^[a-z][a-z0-9_]{0,63}$; id, created_at, updated_at, created_by, and updated_by are reserved.",
                },
                type: { type: "string", enum: ["text", "number", "boolean", "datetime", "array"] },
                description: {
                  type: "string",
                  description: "What the value means and how agents should fill it. At most 1000 characters.",
                },
                required: { type: "boolean" },
                unique: {
                  type: "boolean",
                  description:
                    "Text or number only, at most one per collection. A record_add that repeats the value merges into that record.",
                },
                values: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Text or array only: the closed list of accepted values. A queue's state column uses this.",
                },
              },
              required: ["name", "type", "description"],
              additionalProperties: false,
            },
          },
          scope: {
            type: "string",
            enum: ["guild", "org"],
            description:
              "guild: this guild owns the table and every agent in it reads and writes; org: the organisation holds it, every agent of the organisation reads it, and guild is the guild's mode on its access list. Default org.",
          },
          guild: {
            type: "string",
            enum: ["read", "write"],
            description: "An org table: the mode every agent in the guild gets. Default read.",
          },
          writers: {
            type: "array",
            items: { type: "string" },
            description:
              "An org table: role handles whose agents get write on its access list. Needed when guild is read and the role writes.",
          },
        },
        required: ["name", "purpose", "columns"],
        additionalProperties: false,
      },
    },
    notes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          level: { type: "string", enum: ["org", "guild", "agent"] },
          role: { type: "string" },
          key: { type: "string", description: "A .md file name with no /. Notes have no folders." },
          body: { type: "string" },
          kind: { type: "string" },
          author: authorProperties,
          guild: {
            type: "string",
            enum: ["read", "write"],
            description:
              "The mode every agent in the guild gets. A guild note is always write; an org note defaults to read; an agent note reaches only its role unless set.",
          },
          writers: {
            type: "array",
            items: { type: "string" },
            description:
              "An org or agent note: role handles whose agents get write on its access list. A guild note takes none.",
          },
        },
        additionalProperties: false,
      },
    },
    connections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          server: { type: "string" },
          auth: { type: "string", enum: ["oauth", "token", "none"] },
          recommended_scope: { type: "string", enum: ["org", "guild", "agent"] },
          recommended_role: { type: "string" },
          hint: { type: "string" },
          setup: { type: "string" },
          resources: {
            type: "array",
            description:
              "Long-lived external tables or pages the operator agreed to use. Not for queues or wake state.",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["database", "page", "other"] },
                id: { type: "string" },
                title: { type: "string" },
                url: { type: "string" },
                use: { type: "string" },
              },
              additionalProperties: false,
            },
          },
          author: authorProperties,
          roles: {
            type: "object",
            description: "Keyed by role handle, each { enabled, tools }. Not an array of names.",
            additionalProperties: {
              type: "object",
              properties: {
                enabled: { type: "boolean" },
                tools: { type: "object", additionalProperties: { type: "boolean" } },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
    secrets: { type: "array" },
    external: { type: "array" },
    repositories: {
      type: "array",
      description:
        "Git repositories the guild's coding roles work on, by name and purpose only: no URL and no credential. Apply asks the operator to connect GitHub and add each one.",
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Folder name under repos/ in each coding agent's home, matching ^[a-z][a-z0-9_-]{0,62}$.",
          },
          purpose: {
            type: "string",
            description: "One line: what the repository holds and what the guild does in it.",
          },
        },
        required: ["name", "purpose"],
        additionalProperties: false,
      },
    },
    design: { type: "object" },
  },
  required: ["format", "version", "meta", "guild", "roles"],
  additionalProperties: false,
};

export function builderWriteToolResult(
  written: Pick<RecipeRow, "body_version">,
  recipe: RecipeDocument,
): BuilderWriteReceipt {
  return {
    ok: true,
    body_version: written.body_version,
    name: recipe.meta.name,
    roles: recipe.roles.map((role) => role.role),
  };
}

const BUILDER_WRITE_RECIPE_DESCRIPTION = `Replace the session's draft recipe with the complete document. Pass expected_body_version from the Session block. ${RECIPE_WRITE_HINT}`;

export const builderWriteRecipe = builderTool({
  name: "builder_write_recipe",
  description: BUILDER_WRITE_RECIPE_DESCRIPTION,
  parameters: Type.Object({
    expected_body_version: Type.Integer({ description: "The body_version last observed." }),
    recipe: jsonArgument(recipeDocumentParameter),
  }),
  mismatchHint:
    "The recipe or expected_body_version was missing or truncated: send complete JSON with expected_body_version from the Session block. Shrink task prose, not the roster. This is not a version conflict.",
  async run(ctx: BuilderToolContext, input): Promise<BuilderWriteReceipt | BuilderToolRefusal> {
    try {
      const row = await getRecipe(ctx.connection, ctx.recipeId);
      if (!row) {
        return { error: "recipe not found" };
      }
      const currentVersion = row.body_version;
      if (input.expected_body_version !== currentVersion) {
        return {
          error: "recipe body_version conflict",
          code: "conflict",
          body_version: currentVersion,
        };
      }
      const previous = row.body;
      const next = parseRecipe(input.recipe);
      recommendCoachModel(next, ctx.coachModel ?? "");
      const rejected = builderWriteRejection(previous, next);
      if (rejected) {
        return { error: rejected };
      }
      const written = await writeBuilderRecipe(
        ctx.connection,
        { id: ctx.recipeId, body_version: input.expected_body_version },
        next,
        previous,
      );
      if (ctx.onRecipeChanged) {
        await ctx.onRecipeChanged(written);
      }
      return builderWriteToolResult(written, next);
    } catch (error) {
      if (error instanceof RecipeConflictError) {
        return { error: error.message, code: "conflict", body_version: error.body_version };
      }
      if (error instanceof RecipeError) {
        return { error: error.message };
      }
      throw error;
    }
  },
});

/** A role the coach wrote without a model is recommended the coach's own. */
export function recommendCoachModel(recipe: RecipeDocument, coachModel: string): void {
  const model = coachModel.trim();
  if (!model) {
    return;
  }
  for (const role of recipe.roles) {
    if (typeof role.config.model !== "string" || !role.config.model.trim()) {
      role.config.model = model;
    }
  }
}

export const builderValidateRecipe = builderTool({
  name: "builder_validate_recipe",
  description:
    "Run mechanical and design validation against the current draft recipe. Findings include operator-removed tools and connectors so you can update standing prompts or ask why they were removed.",
  parameters: Type.Object({}),
  async run(ctx: BuilderToolContext): Promise<BuilderValidation | BuilderToolRefusal> {
    const row = await getRecipe(ctx.connection, ctx.recipeId);
    if (!row) {
      return { error: "recipe not found" };
    }
    const validation = await validateLibraryRecipe(ctx.apply, row);
    return { findings: validation.findings, access_cuts: validation.access_cuts, body_version: validation.body_version };
  },
});

export const builderSearchConnected = builderTool({
  name: "builder_search_connected",
  description:
    "Search an organisation-connected workspace that the catalog marks searchable, such as its pages and databases. Use after that workspace is connected at org scope. Results are suggestions only — confirm with the operator before writing connections.resources. Do not treat an external workspace as the home for queues, seen-sets, or working files.",
  summary:
    "Search an organisation-connected workspace that the catalog marks searchable. Use after that workspace is connected at org scope.",
  parameters: Type.Object({
    query: Type.Optional(Type.String({ description: "Search phrase, table name, or empty to list recent records." })),
    server_ref: Type.Optional(
      Type.String({ description: "Catalog slug or server id. Defaults to the first searchable workspace." }),
    ),
  }),
  async run(ctx: BuilderCapabilityContext, input) {
    if (!ctx.db) {
      return { error: "workspace search is unavailable" };
    }
    return searchConnectedWorkspace(
      { db: ctx.db, mcp: ctx.mcp ?? null },
      ctx.orgId,
      input.server_ref ?? "",
      input.query ?? "",
    );
  },
});

export const builderAskOrgConnection = builderTool({
  name: "builder_ask_org_connection",
  description:
    "Show a chat widget that asks the operator to connect one published connector to the organisation now. This pauses the turn until they connect or skip. Use this when a shared workspace should be searched during design. Do not keep writing the recipe in the same turn.",
  summary:
    "Show a chat widget that asks the operator to connect one published connector to the organisation now. This pauses the turn until they connect or skip.",
  parameters: Type.Object({
    server_ref: Type.String({ description: "Catalog slug or server id from list or search results." }),
    reason: Type.String({ description: "Why this organisation login is needed, in one or two sentences." }),
  }),
  async run(ctx: BuilderCapabilityContext, input) {
    if (!ctx.db) {
      return { error: "connection widgets are unavailable" };
    }
    return buildOrgConnectWidget(ctx.db, ctx.orgId, input.server_ref, input.reason);
  },
});

export const builderAskConnection = builderTool({
  name: "builder_ask_connection",
  description:
    "Show a chat widget that lets the operator connect any published connector at the appropriate scope. This pauses the turn until they connect, confirm, or skip. Organisation logins can happen now. Guild and agent logins are confirmed here and created at apply. Use when the account owner is not the organisation, or the operator should pick the service. Do not keep writing the recipe in the same turn.",
  summary:
    "Show a chat widget that lets the operator connect any published connector at org, guild, or agent scope. This pauses the turn until they connect, confirm, or skip.",
  parameters: Type.Object({
    reason: Type.String({ description: "Why this login is needed, in one or two sentences." }),
    server_ref: Type.Optional(
      Type.String({ description: "Optional catalog slug or server id. Omit to let the operator pick." }),
    ),
    recommended_scope: Type.Optional(ConnectScopeInput),
    allow_scope_change: Type.Optional(
      Type.Boolean({ description: "When true, the operator may pick org, guild, or agent. Defaults to true." }),
    ),
  }),
  async run(ctx: BuilderCapabilityContext, input) {
    if (!ctx.db) {
      return { error: "connection widgets are unavailable" };
    }
    return buildAnyConnectWidget(ctx.db, ctx.orgId, {
      serverRef: input.server_ref || undefined,
      recommendedScope: input.recommended_scope ?? "org",
      allowScopeChange: input.allow_scope_change ?? true,
      reason: input.reason,
    });
  },
});

export const builderAskQuestion = builderTool({
  name: "builder_ask_question",
  description:
    "Show a Claude-style question card and pause this turn until the operator answers. Use this for facts the runtime cannot know: cadence, matching rules, destination tables, login owner, or an open design choice. Prefer two to four concrete options. Do not keep writing the recipe in the same turn.",
  summary: "Show a question card and pause until the operator picks an option or types an answer.",
  parameters: QuestionCardInput,
  run: async (_ctx: BuilderCapabilityContext, input) => buildQuestionWidget(input),
});

export const BUILDER_CAPABILITY_TOOLS = [
  builderListCapabilities,
  builderSearchCapabilities,
  builderDescribeServer,
  builderSearchConnected,
  builderAskOrgConnection,
  builderAskConnection,
  builderAskQuestion,
];

export const BUILDER_SESSION_TOOLS = [
  ...BUILDER_CAPABILITY_TOOLS,
  builderWriteRecipe,
  builderValidateRecipe,
];

/** The session tools as the conversation runner calls them, each bound to the session's `context`. */
export function builderConversationTools(context: BuilderToolContext): Map<string, ConversationTool> {
  return new Map(
    BUILDER_SESSION_TOOLS.map((tool) => [
      tool.name,
      {
        name: tool.name,
        schema: tool.schema,
        handler: (_runnerContext, args) => tool.handler(context, args),
      },
    ]),
  );
}

export function builderToolSchemas(): FunctionTool[] {
  return BUILDER_SESSION_TOOLS.map((tool) => tool.schema);
}
