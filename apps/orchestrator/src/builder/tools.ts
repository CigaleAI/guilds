import { assignGuildLooks } from "../avatars/looks.js";
import { RECIPE_WRITE_HINT } from "./constants.js";
import { searchConnectedWorkspace, type BuilderMcpClient } from "./connected.js";
import {
  buildAnyConnectWidget,
  buildOrgConnectWidget,
  buildQuestionWidget,
  normalizeConnectScope,
} from "./widgets.js";
import { argInteger, argString, functionSchema } from "../toolbox/schema.js";
import type { CapabilityService } from "../capabilities/index.js";
import type { Repositories } from "../db/repositories.js";
import {
  operatorAccessCuts,
  parseRecipe,
  stampBuilderWrite,
  type RecipeDocument,
} from "../recipes/schema.js";
import { RecipeConflictError, RecipeError } from "../recipes/errors.js";
import type { RecipeStore } from "../recipes/store.js";
import { validateRecipe, type ValidationContext } from "../recipes/validate.js";

export type BuilderCapabilityContext = {
  orgId: string;
  capabilities: CapabilityService;
  repo?: Repositories;
  mcp?: BuilderMcpClient | null;
};

export type BuilderToolContext = BuilderCapabilityContext & {
  recipeId: string;
  expectedWrite?: boolean;
  recipes: RecipeStore;
  /** The coach's own model: the recommendation a role without one is written with. */
  coachModel?: string;
  validationContext: () => Promise<ValidationContext>;
  onRecipeChanged?: (recipe: Record<string, unknown>) => Promise<void>;
};

export const builderListCapabilities = {
  name: "builder_list_capabilities",
  description:
    "List native tools, the browser capability (operator take-control login at apply when a site has no connector), the coding capability (code tools and repositories), published catalog connectors, models, plan caps, remaining capacity, and reusable org/platform connections. Native group ids are tool groups, not recipe role keys. Call this before naming any system.",
  schema: functionSchema(
    "builder_list_capabilities",
    "List native tools, the browser capability (operator take-control login at apply when a site has no connector), the coding capability (code tools and repositories), published catalog connectors, models, plan caps, remaining capacity, and reusable org/platform connections. Native group ids are tool groups, not recipe role keys. Call this before naming any system.",
    {},
    [],
  ),
  async handler(ctx: BuilderCapabilityContext) {
    return ctx.capabilities.listCapabilities({ orgId: ctx.orgId });
  },
};

export const builderSearchCapabilities = {
  name: "builder_search_capabilities",
  description:
    "Search published connector descriptions and canonical tool names. Use when the operator names a system or action that is not obvious from builder_list_capabilities.",
  schema: functionSchema(
    "builder_search_capabilities",
    "Search published connector descriptions and canonical tool names. Use when the operator names a system or action that is not obvious from builder_list_capabilities.",
    {
      query: { type: "string", description: "Search phrase, slug, or tool name." },
    },
    ["query"],
  ),
  async handler(ctx: BuilderCapabilityContext, args: Record<string, unknown>) {
    return ctx.capabilities.searchCapabilities({ orgId: ctx.orgId }, argString(args, "query"));
  },
};

export const builderDescribeServer = {
  name: "builder_describe_server",
  description:
    "Return one published connector's complete catalog record, including canonical tools. server_ref is a slug or server id from list or search results.",
  schema: functionSchema(
    "builder_describe_server",
    "Return one published connector's complete catalog record, including canonical tools. server_ref is a slug or server id from list or search results.",
    {
      server_ref: { type: "string", description: "Catalog slug or server id." },
    },
    ["server_ref"],
  ),
  async handler(ctx: BuilderCapabilityContext, args: Record<string, unknown>) {
    const record = await ctx.capabilities.describeServer(
      { orgId: ctx.orgId },
      argString(args, "server_ref"),
    );
    if (!record) {
      return { error: "unknown or unpublished connector" };
    }
    return record;
  },
};

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

const authorProperties = {
  type: "object",
  properties: {
    by: { type: "string", enum: ["builder", "operator"] },
    reviewed: { type: "boolean" },
  },
  additionalProperties: false,
};

const recipeDocumentParameter = {
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
          grants: { type: "object" },
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
        "Typed tables at the organisation. Apply creates each one or reuses a live table of that name.",
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
                  description: "What the value means, for the agents. At most 200 characters.",
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
              "guild: this guild owns the table and every agent in it reads and writes; org: the organisation holds it and guild is the grant. Default org.",
          },
          guild: {
            type: "string",
            enum: ["read", "write"],
            description: "An org table: the mode every agent in the guild gets.",
          },
          writers: {
            type: "array",
            items: { type: "string" },
            description:
              "An org table: role handles that get their own write grant. Needed when guild is read and the role writes.",
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
  written: { body_version?: unknown },
  recipe: RecipeDocument,
): Record<string, unknown> {
  return {
    ok: true,
    body_version: written.body_version,
    name: recipe.meta.name,
    roles: recipe.roles.map((role) => role.role),
  };
}

const BUILDER_WRITE_RECIPE_DESCRIPTION = `Replace the session's draft recipe with the complete document. Pass expected_body_version from the Session block. ${RECIPE_WRITE_HINT}`;

export const builderWriteRecipe = {
  name: "builder_write_recipe",
  description: BUILDER_WRITE_RECIPE_DESCRIPTION,
  schema: functionSchema(
    "builder_write_recipe",
    BUILDER_WRITE_RECIPE_DESCRIPTION,
    {
      expected_body_version: { type: "integer", description: "The body_version last observed." },
      recipe: recipeDocumentParameter,
    },
    ["expected_body_version", "recipe"],
  ),
  async handler(ctx: BuilderToolContext, args: Record<string, unknown>) {
    if (args.recipe == null || typeof args.recipe !== "object" || Array.isArray(args.recipe)) {
      return {
        error:
          "incomplete builder_write_recipe arguments. The recipe object was missing or truncated; send complete JSON. Shrink task prose, not the roster. This is not a version conflict.",
      };
    }
    const expected = argInteger(args, "expected_body_version", Number.NaN);
    if (!Number.isInteger(expected)) {
      return {
        error:
          "incomplete builder_write_recipe arguments. expected_body_version is required from the Session block. This is not a version conflict.",
      };
    }
    try {
      const row = await ctx.recipes.get(ctx.recipeId);
      if (!row) {
        return { error: "recipe not found" };
      }
      const currentVersion = Number(row.body_version);
      if (expected !== currentVersion) {
        return {
          error: "recipe body_version conflict",
          code: "conflict",
          body_version: currentVersion,
        };
      }
      const previous = parseRecipe(row.body);
      const next = parseRecipe(args.recipe);
      recommendCoachModel(next, ctx.coachModel ?? "");
      const rejected = builderWriteRejection(previous, next);
      if (rejected) {
        return { error: rejected };
      }
      const stamped = stampBuilderWrite(next, previous);
      assignGuildLooks(stamped.roles, previous.roles);
      const written = await ctx.recipes.writeBody(
        ctx.recipeId,
        expected,
        stamped,
        { name: stamped.meta.name, description: stamped.meta.description },
        new Date(),
      );
      if (ctx.onRecipeChanged) {
        await ctx.onRecipeChanged(written);
      }
      return builderWriteToolResult(written, stamped);
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
};

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

export const builderValidateRecipe = {
  name: "builder_validate_recipe",
  description:
    "Run mechanical and design validation against the current draft recipe. Findings include operator-removed tools and connectors so you can update standing prompts or ask why they were removed.",
  schema: functionSchema(
    "builder_validate_recipe",
    "Run mechanical and design validation against the current draft recipe. Findings include operator-removed tools and connectors so you can update standing prompts or ask why they were removed.",
    {},
    [],
  ),
  async handler(ctx: BuilderToolContext) {
    const row = await ctx.recipes.get(ctx.recipeId);
    if (!row) {
      return { error: "recipe not found" };
    }
    const recipe = parseRecipe(row.body);
    const findings = validateRecipe(recipe, await ctx.validationContext());
    return { findings, access_cuts: operatorAccessCuts(recipe), body_version: row.body_version };
  },
};

export const builderSearchConnected = {
  name: "builder_search_connected",
  description:
    "Search an organisation-connected workspace that the catalog marks searchable, such as its pages and databases. Use after that workspace is connected at org scope. Results are suggestions only — confirm with the operator before writing connections.resources. Do not treat an external workspace as the home for queues, seen-sets, or working files.",
  schema: functionSchema(
    "builder_search_connected",
    "Search an organisation-connected workspace that the catalog marks searchable. Use after that workspace is connected at org scope.",
    {
      query: {
        type: "string",
        description: "Search phrase, table name, or empty to list recent records.",
      },
      server_ref: {
        type: "string",
        description: "Catalog slug or server id. Defaults to the first searchable workspace.",
      },
    },
    [],
  ),
  async handler(ctx: BuilderCapabilityContext, args: Record<string, unknown>) {
    if (!ctx.repo) {
      return { error: "workspace search is unavailable" };
    }
    return searchConnectedWorkspace({
      repo: ctx.repo,
      mcp: ctx.mcp ?? null,
      orgId: ctx.orgId,
      serverRef: argString(args, "server_ref"),
      query: argString(args, "query"),
    });
  },
};

export const builderAskOrgConnection = {
  name: "builder_ask_org_connection",
  description:
    "Show a chat widget that asks the operator to connect one published connector to the organisation now. This pauses the turn until they connect or skip. Use this when a shared workspace should be searched during design. Do not keep writing the recipe in the same turn.",
  schema: functionSchema(
    "builder_ask_org_connection",
    "Show a chat widget that asks the operator to connect one published connector to the organisation now. This pauses the turn until they connect or skip.",
    {
      server_ref: {
        type: "string",
        description: "Catalog slug or server id from list or search results.",
      },
      reason: {
        type: "string",
        description: "Why this organisation login is needed, in one or two sentences.",
      },
    },
    ["server_ref", "reason"],
  ),
  async handler(ctx: BuilderCapabilityContext, args: Record<string, unknown>) {
    if (!ctx.repo) {
      return { error: "connection widgets are unavailable" };
    }
    return buildOrgConnectWidget({
      repo: ctx.repo,
      orgId: ctx.orgId,
      serverRef: argString(args, "server_ref"),
      reason: argString(args, "reason"),
    });
  },
};

export const builderAskConnection = {
  name: "builder_ask_connection",
  description:
    "Show a chat widget that lets the operator connect any published connector at the appropriate scope. This pauses the turn until they connect, confirm, or skip. Organisation logins can happen now. Guild and agent logins are confirmed here and created at apply. Use when the account owner is not the organisation, or the operator should pick the service. Do not keep writing the recipe in the same turn.",
  schema: functionSchema(
    "builder_ask_connection",
    "Show a chat widget that lets the operator connect any published connector at org, guild, or agent scope. This pauses the turn until they connect, confirm, or skip.",
    {
      reason: {
        type: "string",
        description: "Why this login is needed, in one or two sentences.",
      },
      server_ref: {
        type: "string",
        description: "Optional catalog slug or server id. Omit to let the operator pick.",
      },
      recommended_scope: {
        type: "string",
        enum: ["org", "guild", "agent"],
        description:
          "Best owner for this login. Org can connect now; guild and agent wait for apply.",
      },
      allow_scope_change: {
        type: "boolean",
        description: "When true, the operator may pick org, guild, or agent. Defaults to true.",
      },
    },
    ["reason"],
  ),
  async handler(ctx: BuilderCapabilityContext, args: Record<string, unknown>) {
    if (!ctx.repo) {
      return { error: "connection widgets are unavailable" };
    }
    return buildAnyConnectWidget({
      repo: ctx.repo,
      capabilities: ctx.capabilities,
      orgId: ctx.orgId,
      serverRef: argString(args, "server_ref") || undefined,
      recommendedScope: normalizeConnectScope(argString(args, "recommended_scope", "org"), "org"),
      allowScopeChange: args.allow_scope_change === false ? false : true,
      reason: argString(args, "reason"),
    });
  },
};

export const builderAskQuestion = {
  name: "builder_ask_question",
  description:
    "Show a Claude-style question card and pause this turn until the operator answers. Use this for facts the runtime cannot know: cadence, matching rules, destination tables, login owner, or an open design choice. Prefer two to four concrete options. Do not keep writing the recipe in the same turn.",
  schema: functionSchema(
    "builder_ask_question",
    "Show a question card and pause until the operator picks an option or types an answer.",
    {
      questions: {
        type: "array",
        description: "One to four questions. Each pauses the same turn until submitted.",
        items: {
          type: "object",
          properties: {
            header: { type: "string", description: "Short label, a few words." },
            question: { type: "string", description: "The question to answer." },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  description: { type: "string" },
                },
              },
            },
            allow_other: { type: "boolean", description: "Show an Other field. Defaults to true." },
            multi_select: {
              type: "boolean",
              description: "Allow more than one option. Defaults to false.",
            },
          },
          required: ["question"],
        },
      },
      question: {
        type: "string",
        description: "Shorthand for a single question when questions[] is omitted.",
      },
      header: { type: "string" },
      options: {
        type: "array",
        items: {
          type: "object",
          properties: { label: { type: "string" }, description: { type: "string" } },
        },
      },
    },
    [],
  ),
  async handler(_ctx: BuilderCapabilityContext, args: Record<string, unknown>) {
    return buildQuestionWidget(args);
  },
};

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

export function builderConversationTools(): Map<
  string,
  {
    name: string;
    schema: Record<string, unknown>;
    handler: (ctx: unknown, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  }
> {
  return new Map(
    BUILDER_SESSION_TOOLS.map((tool) => [
      tool.name,
      {
        name: tool.name,
        schema: tool.schema,
        handler: (ctx, args) => tool.handler(ctx as BuilderToolContext, args ?? {}),
      },
    ]),
  );
}

export function builderToolSchemas(): Array<Record<string, unknown>> {
  return BUILDER_SESSION_TOOLS.map((tool) => tool.schema);
}
