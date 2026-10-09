import { newId } from "../lib/ids.js";
import { GITHUB_SLUG } from "../github/index.js";
import { operatorActor } from "../artifacts/grants.js";
import { collectTaskEmbeds } from "../artifacts/index.js";
import type { ArtifactStore } from "../artifacts/index.js";
import { httpAccess } from "../http/access.js";
import type { Repositories } from "../db/repositories.js";
import type { Scripts } from "../scripts/catalog.js";
import type { Schedules } from "../schedules/service.js";
import { rowTiming } from "../schedules/timing.js";
import { describeWindow } from "../schedules/window.js";
import {
  CONFIG_KEYS,
  addMissingBrowser,
  addMissingBrowserLanguage,
  addMissingCliScriptingAndMemory,
  addMissingRunLimits,
  addMissingTemperatureAndStepLimits,
  addMissingThinkingLevel,
} from "../agents/validation.js";
import { jsonObj } from "../db/json.js";
import { secretGrants } from "../secrets/access.js";
import { emptyRecipe } from "./minimal.js";
import { operatorAuthor, parseRecipe, RECIPE_HINT_MAX, type RecipeDocument } from "./schema.js";
import { recipeNotePath, rewriteGuildTextToRecipeRefs } from "./rewrite.js";
import { RecipeError } from "./errors.js";
import { exportManifest } from "../mcp/catalog.js";

export type CaptureDeps = {
  repo: Repositories;
  artifacts: ArtifactStore;
  scripts: Scripts;
  schedules: Schedules;
};

export function recipeScope(value: unknown): "org" | "guild" | "agent" {
  return value === "org" || value === "agent" ? value : "guild";
}

export function preferRecipeScope(
  current: "org" | "guild" | "agent" | undefined,
  next: "org" | "guild" | "agent",
): "org" | "guild" | "agent" {
  if (current === "org" || next === "org") return "org";
  if (current === "guild" || next === "guild") return "guild";
  return next;
}

/** How an agent of `guildId` gets a secret: organisation-wide, through its guild, or granted itself. */
function secretRecipeScope(secret: Record<string, unknown>, guildId: string): "org" | "guild" | "agent" {
  if (secret.org_wide) return "org";
  return secretGrants(secret).some((grant) => grant.guild_id === guildId) ? "guild" : "agent";
}

function clippedHint(value: unknown): string {
  return String(value ?? "").slice(0, RECIPE_HINT_MAX);
}

export function portableRoleConfig(
  config: Record<string, unknown>,
  browserRequired: boolean,
): Record<string, unknown> {
  const filled = addMissingCliScriptingAndMemory(
    addMissingThinkingLevel(
      addMissingBrowserLanguage(
        addMissingRunLimits(
          addMissingTemperatureAndStepLimits(
            addMissingBrowser({
              ...config,
              browser: browserRequired || Boolean(config.browser),
            }),
          ),
        ),
      ),
    ),
  );
  const out: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS) {
    // The box follows the browser and coding flags, so a recipe carries the flags alone.
    if (key === "box") {
      continue;
    }
    if (key in filled) {
      out[key] = filled[key];
    }
  }
  return out;
}

export async function captureGuild(
  deps: CaptureDeps,
  args: {
    guild: Record<string, unknown>;
    user: Record<string, unknown>;
    includeNotes?: string[];
  },
): Promise<RecipeDocument> {
  const guildId = String(args.guild.id);
  const orgId = String(args.guild.org_id);
  const agents = (await deps.repo.listAgents(guildId)).filter((row) => !row.archived_at);
  if (!agents.length) {
    throw new RecipeError("guild has no agents to capture");
  }
  const nameToRole = new Map<string, string>();
  for (const agent of agents) {
    nameToRole.set(String(agent.name), String(agent.name));
  }
  const actor = operatorActor({
    orgId,
    actorId: String(args.user.id),
    actorName: String(args.user.name ?? "operator"),
    guildId,
  });
  const recipe = emptyRecipe({
    name: String(args.guild.name),
    source: { kind: "guild", guild_id: guildId },
  });
  recipe.meta.name = String(args.guild.name);
  recipe.meta.description = String(args.guild.about ?? "");
  recipe.guild.name_suggestion = String(args.guild.name);
  recipe.guild.about = String(args.guild.about ?? "");
  recipe.guild.group_agent_message_limit = Number(args.guild.group_agent_message_limit ?? 20);
  recipe.guild.objective = String(args.guild.description ?? "");

  const hrefToNoteId = new Map<string, string>();
  // Every table the guild reaches: its own, and the organisation tables it or
  // one of its agents is granted. Writers are the agents that override an
  // organisation table to write, named by role.
  const memberIds = new Set(agents.map((agent) => String(agent.id)));
  const guildModes = new Map(
    (await deps.artifacts.accessForGuild(actor, guildId)).map((row) => [row.collection_id, row.mode]),
  );
  for (const collection of await deps.artifacts.listCollections(actor)) {
    if (collection.scope === "guild") {
      if (collection.guild?.id !== guildId) {
        continue;
      }
      recipe.collections.push({
        name: collection.name,
        purpose: collection.purpose,
        columns: collection.columns,
        scope: "guild",
        guild: "write",
        writers: [],
      });
      continue;
    }
    const guildMode = guildModes.get(collection.id) ?? null;
    const access = await deps.artifacts.listAccess(actor, collection.id);
    const memberGrants = access.agents.filter((row) => memberIds.has(row.id) && row.agent_mode !== null);
    if (!guildMode && !memberGrants.length) {
      continue;
    }
    recipe.collections.push({
      name: collection.name,
      purpose: collection.purpose,
      columns: collection.columns,
      scope: "org",
      guild: guildMode ?? "read",
      writers: memberGrants.filter((row) => row.agent_mode === "write").map((row) => row.name),
    });
  }

  for (const agent of agents) {
    const agentId = String(agent.id);
    const role = String(agent.name);
    const config = (jsonObj(agent.config) ?? {}) as Record<string, unknown>;
    const taskRow = await deps.repo.getAgentTask(orgId, agentId);
    const taskBody = String(taskRow?.content_text ?? "");
    const access = await httpAccess(deps.repo, { orgId, guildId, agentId, viewScope: "agent" });
    const grants = Object.fromEntries(
      (access.grants as Array<Record<string, unknown>>).map((item) => [String(item.name), Boolean(item.enabled)]),
    );
    const nativeTools = Object.fromEntries(
      (access.tools as Array<Record<string, unknown>>).map((item) => [String(item.name), Boolean(item.enabled)]),
    );
    const scripts = await deps.scripts.listForAgent(agentId);
    const schedules = await deps.repo.listSchedules(agentId);
    const browserRequired = Boolean(config.browser);
    const portable = portableRoleConfig(config, browserRequired);
    if (scripts.length > Number(portable.max_scripts ?? 0)) {
      portable.max_scripts = scripts.length;
    }
    recipe.roles.push({
      role,
      name_suggestion: role,
      focus: String(agent.focus ?? ""),
      wake_triggers: String(agent.wake_triggers ?? ""),
      avatar_shape: String(agent.avatar_shape ?? "teardrop"),
      avatar_color: String(agent.avatar_color ?? "#7c5cff"),
      config: portable,
      task: { body: taskBody, embeds: collectTaskEmbeds(taskBody), author: operatorAuthor() },
      scripts: scripts.map((script) => ({
        name: String(script.name),
        description: String(script.description ?? ""),
        parameters: (script.parameters as Record<string, unknown> | null) ?? null,
        source: String(script.source ?? ""),
        secrets: [],
        author: operatorAuthor(),
      })),
      schedules: schedules.map((row, index) => {
        const timing = rowTiming(row);
        return {
          key: `${role}-${index + 1}`,
          ...(timing.window === null ? { cron: timing.cron } : { window: timing.window }),
          description: String(row.description ?? ""),
          instruction: String(row.instruction ?? ""),
          author: operatorAuthor(),
        };
      }),
      grants: {
        read_guild: Boolean(grants.read_guild),
        write_guild: Boolean(grants.write_guild),
        read_org: Boolean(grants.read_org),
        write_org: Boolean(grants.write_org),
      },
      native_tools: nativeTools,
      browser: {
        required: browserRequired,
        instructions: "",
        author: operatorAuthor(),
      },
    });
    const mcp = (access.mcp as Array<Record<string, unknown>>) ?? [];
    for (const server of mcp) {
      if (!server.enabled && !(server.tools as unknown[] | undefined)?.length) {
        continue;
      }
      if (!server.enabled) {
        continue;
      }
      const slug = String(server.slug);
      // The repositories list stands for GitHub: apply asks for it with them.
      if (slug === GITHUB_SLUG) {
        continue;
      }
      const scope = recipeScope(server.connection_owner_scope ?? server.source_scope);
      let connection = recipe.connections.find((item) => item.server === slug);
      if (!connection) {
        connection = {
          server: slug,
          auth: (server.auth as "oauth" | "token" | "none") ?? "token",
          recommended_scope: scope,
          hint: clippedHint(server.description),
          setup: String(server.setup_hint ?? ""),
          author: operatorAuthor(),
          roles: {},
        };
        if (scope === "agent") {
          connection.recommended_role = role;
        }
        // An organisation's own server travels whole: the box applying the recipe may lack it.
        if (server.org_owned) {
          const row = await deps.repo.getMcpServerBySlug(slug, orgId);
          if (row && row.owner_org_id === orgId) {
            connection.manifest = exportManifest(row);
          }
        }
        recipe.connections.push(connection);
      } else {
        connection.recommended_scope = preferRecipeScope(connection.recommended_scope, scope);
        if (connection.recommended_scope !== "agent") {
          delete connection.recommended_role;
        } else if (!connection.recommended_role) {
          connection.recommended_role = role;
        }
        if (!connection.setup && server.setup_hint) {
          connection.setup = String(server.setup_hint);
        }
        if (!connection.hint && server.description) {
          connection.hint = clippedHint(server.description);
        }
      }
      const tools = Object.fromEntries(
        ((server.tools as Array<Record<string, unknown>>) ?? []).map((tool) => [
          String(tool.name),
          Boolean(tool.enabled),
        ]),
      );
      connection.roles[role] = { enabled: Boolean(server.enabled), tools };
    }
    for (const secret of await deps.repo.listSecrets(orgId, { agentId })) {
      const name = String(secret.name);
      const scope = secretRecipeScope(secret, guildId);
      let entry = recipe.secrets.find((item) => item.name === name);
      if (!entry) {
        entry = {
          name,
          description: String(secret.description ?? ""),
          recommended_scope: scope,
          roles: [],
        };
        if (scope === "agent") {
          entry.recommended_role = role;
        }
        recipe.secrets.push(entry);
      } else {
        entry.recommended_scope = preferRecipeScope(entry.recommended_scope, scope);
        if (entry.recommended_scope !== "agent") {
          delete entry.recommended_role;
        } else if (!entry.recommended_role) {
          entry.recommended_role = role;
        }
      }
      if (!entry.roles.includes(role)) {
        entry.roles.push(role);
      }
    }
  }

  // Repositories travel by name only: their URLs and connections stay with the guild.
  recipe.repositories = (await deps.repo.listGuildRepositories(guildId)).map((row) => ({
    name: String(row.name),
    purpose: "",
  }));

  const include = new Set(args.includeNotes ?? []);
  for (const role of recipe.roles) {
    for (const href of role.task.embeds) {
      include.add(href);
    }
  }
  const notes = await deps.artifacts.listEmbeddableNotes(actor);
  for (const note of notes) {
    const display = String(note.display_path ?? "");
    const key = String(note.key ?? "");
    if (!include.has(display) && !include.has(key)) {
      continue;
    }
    if (key === "memory.md" || String(note.kind) !== "note") {
      continue;
    }
    const id = newId("nte").slice(0, 16);
    const captured: RecipeDocument["notes"][number] = {
      id,
      level: String(note.level) as "org" | "guild" | "agent",
      key,
      body: String(note.content ?? ""),
      kind: "seed",
      author: operatorAuthor(),
    };
    if (captured.level === "agent") {
      const ownerId = String(note.owner_id ?? "");
      const owner = agents.find((agent) => String(agent.id) === ownerId);
      if (owner) {
        captured.role = String(owner.name);
      }
    }
    hrefToNoteId.set(display, recipeNotePath(captured));
    recipe.notes.push(captured);
  }

  for (const role of recipe.roles) {
    role.task.body = rewriteGuildTextToRecipeRefs(role.task.body, nameToRole, hrefToNoteId);
    role.task.embeds = role.task.embeds.map((href) => hrefToNoteId.get(href) ?? href);
    for (const schedule of role.schedules) {
      schedule.instruction = rewriteGuildTextToRecipeRefs(schedule.instruction, nameToRole, hrefToNoteId);
    }
    for (const script of role.scripts) {
      script.source = rewriteGuildTextToRecipeRefs(script.source, nameToRole, hrefToNoteId);
    }
  }
  for (const note of recipe.notes) {
    note.body = rewriteGuildTextToRecipeRefs(note.body, nameToRole, hrefToNoteId);
  }
  if (recipe.roles.length === 1) {
    const only = recipe.roles[0];
    if (only && !recipe.design.specialization.some((item) => item.role === only.role)) {
      recipe.design.specialization.push({
        proposed_by: "operator",
        accepted: true,
        role: only.role,
        reason: "other",
        detail: "Captured from a live guild that already runs as this single role.",
      });
    }
  }
  if (recipe.roles.length > 1 && !recipe.design.handoffs.length) {
    const from = recipe.roles[0];
    const to = recipe.roles[1];
    if (from && to) {
      recipe.design.handoffs.push({
        proposed_by: "operator",
        accepted: true,
        from: from.role,
        to: to.role,
        kind: "tagged",
        budget: recipe.guild.group_agent_message_limit,
      });
    }
  }
  for (const role of recipe.roles) {
    for (const schedule of role.schedules) {
      if (!recipe.design.routines.some((item) => item.key === schedule.key)) {
        recipe.design.routines.push({
          proposed_by: "operator",
          accepted: true,
          key: schedule.key,
          role: role.role,
          cadence: schedule.cron ?? (schedule.window ? describeWindow(schedule.window) : ""),
          dedupe_key: "key",
        });
      }
    }
    if (
      (role.browser.required || Boolean(role.config.browser)) &&
      !recipe.design.browser.some((item) => item.role === role.role)
    ) {
      recipe.design.browser.push({
        proposed_by: "operator",
        accepted: true,
        role: role.role,
        site: "",
        viable: true,
        login_failure_policy: "pause the routine and ask the operator to log in again",
      });
    }
  }
  return parseRecipe(recipe);
}
