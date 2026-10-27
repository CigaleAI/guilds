import { parseModelId, providerLabel } from "../llm/providers.js";
import { CONFIG_KEYS, secretAliasesOf } from "../agents/validation.js";
import { credentialFix, HARNESS_INFO, harnessModelOf, HARNESSES, isHarness, isHarnessOff } from "../coding/harnesses.js";
import { EFFORTS, harnessEffortsFor, isEffort } from "../coding/harness-models.js";
import { validateTiming } from "../schedules/timing.js";
import { validateScriptName, validateScriptDescription, validateScriptSource, validateScriptParameters } from "../scripts/validation.js";
import { NATIVE_TOOLS } from "../seed/catalog.js";
import type { CollectionColumn } from "../artifacts/columns.js";
import { collectTaskEmbeds } from "../artifacts/embeds.js";
import { isDisplayPath } from "../artifacts/paths.js";
import { collectRecipeNotePaths, recipeNotePath } from "./rewrite.js";
import { operatorAccessCuts, type RecipeDocument } from "./schema.js";

export type FindingSeverity = "error" | "warning" | "info";

export type RecipeFinding = {
  code: string;
  severity: FindingSeverity;
  path: string;
  message: string;
};

export type ValidationContext = {
  publishedServers: Set<string>;
  /** How many more agents the organisation may hold; null when uncapped. */
  remainingAgents: number | null;
  remainingBrowserAgents: number | null;
  remainingCodingAgents: number | null;
  groupLimit: number;
  /** The model providers the organisation has connected. */
  connectedProviders?: Set<string>;
  /** Connectors the registry offers that the box lacks, by slug: the newest version. */
  registryConnectors?: Map<string, { version: string; verified: boolean }>;
};

const NATIVE = new Set<string>(NATIVE_TOOLS);

function reviewHint(path: string): string {
  if (path.endsWith(".task")) {
    return "Confirm the standing prompt. Press Confirm on that field.";
  }
  if (path.endsWith(".browser")) {
    return "This role needs a take-control browser login. Confirm the login notes; after apply, the live agent asks the operator to log in.";
  }
  if (path.includes(".scripts.")) {
    return "Confirm the script before apply.";
  }
  if (path.startsWith("connections.")) {
    return "Confirm the connector setup notes.";
  }
  return `Confirm ${path}.`;
}
void reviewHint;

function finding(
  code: string,
  severity: FindingSeverity,
  path: string,
  message: string,
): RecipeFinding {
  return { code, severity, path, message };
}

type RecipeRole = RecipeDocument["roles"][number];

/** A harness the recipe names that apply cannot use, or null. */
function harnessChoiceFinding(role: RecipeRole): RecipeFinding | null {
  const harness = role.config.harness;
  const path = `roles.${role.role}.config.harness`;
  if (harness !== undefined && harness !== null && !isHarness(harness)) {
    return finding("harness.unknown", "warning", path, `unknown harness ${String(harness)}; apply asks for one of ${HARNESSES.join(", ")}`);
  }
  if (isHarness(harness) && role.config.coding !== true) {
    return finding("harness.coding", "warning", path, "config.harness is only for a coding role; apply leaves it out");
  }
  if (isHarness(harness) && isHarnessOff(harness)) {
    return finding("harness.off", "warning", path, `${HARNESS_INFO[harness].label} is turned off on this box; apply asks for another`);
  }
  return null;
}

/** A coding role's harness runs on a credential nobody can know before apply. */
function harnessCredentialFinding(role: RecipeRole): RecipeFinding {
  const harness = role.config.harness;
  const named = isHarness(harness);
  const fix = named ? `after apply, ${credentialFix(harness)}` : "apply asks for its harness";
  return finding(
    "harness.credential",
    "warning",
    `roles.${role.role}.config.harness`,
    `${named ? HARNESS_INFO[harness].label : "the harness"} runs on a subscription credential that is not known before apply; ${fix}`,
  );
}

/** A harness model apply cannot use: not a model name, or on a role without a harness. */
function harnessModelFinding(role: RecipeRole): RecipeFinding | null {
  const model = role.config.harness_model;
  const path = `roles.${role.role}.config.harness_model`;
  if (model === undefined || model === null) {
    return null;
  }
  if (harnessModelOf(role.config) === null) {
    return finding("harness_model.invalid", "warning", path, "config.harness_model is not a model name; apply leaves it out");
  }
  if (!isHarness(role.config.harness)) {
    return finding("harness_model.harness", "warning", path, "config.harness_model needs config.harness; apply leaves it out");
  }
  return null;
}

/** A harness effort apply cannot use: not an effort, on a role without a harness, or not one its model runs at. */
function harnessEffortFinding(role: RecipeRole): RecipeFinding | null {
  const effort = role.config.harness_effort;
  const path = `roles.${role.role}.config.harness_effort`;
  if (effort === undefined || effort === null) {
    return null;
  }
  if (!isEffort(effort)) {
    return finding("harness_effort.invalid", "warning", path, `config.harness_effort is not one of ${EFFORTS.join(", ")}; apply leaves it out`);
  }
  if (!isHarness(role.config.harness)) {
    return finding("harness_effort.harness", "warning", path, "config.harness_effort needs config.harness; apply leaves it out");
  }
  return harnessEffortsFor(role.config.harness, harnessModelOf(role.config)).includes(effort)
    ? null
    : finding("harness_effort.model", "warning", path, "config.harness_model does not run at config.harness_effort; apply leaves it out");
}

/** Secret aliases apply cannot use: not a map of variable names to secret names. */
function secretAliasesFinding(role: RecipeRole): RecipeFinding | null {
  const raw = role.config.secret_aliases;
  if (raw === undefined || raw === null) {
    return null;
  }
  const kept = Object.keys(secretAliasesOf(role.config)).length;
  const given = typeof raw === "object" && !Array.isArray(raw) ? Object.keys(raw as object).length : -1;
  if (kept === given) {
    return null;
  }
  return finding(
    "secret_aliases.invalid",
    "warning",
    `roles.${role.role}.config.secret_aliases`,
    "config.secret_aliases is not a map of variable names to secret names; apply leaves it out",
  );
}

function harnessFindings(role: RecipeRole): RecipeFinding[] {
  const choice = harnessChoiceFinding(role);
  const model = harnessModelFinding(role);
  const credential = role.config.coding === true ? harnessCredentialFinding(role) : null;
  return [choice, model, harnessEffortFinding(role), credential, secretAliasesFinding(role)].filter((item): item is RecipeFinding => item !== null);
}

export function validateMechanical(recipe: RecipeDocument, ctx: ValidationContext): RecipeFinding[] {
  const findings: RecipeFinding[] = [];
  const roles = new Set(recipe.roles.map((role) => role.role));
  if (ctx.remainingAgents !== null && recipe.roles.length > ctx.remainingAgents) {
    findings.push(
      finding(
        "capacity.agents",
        "error",
        "roles",
        `recipe needs ${recipe.roles.length} agents; ${ctx.remainingAgents} remaining`,
      ),
    );
  }
  const browserRoles = recipe.roles.filter((role) => role.browser.required || role.config.browser);
  if (ctx.remainingBrowserAgents !== null && browserRoles.length > ctx.remainingBrowserAgents) {
    findings.push(
      finding(
        "capacity.browser",
        "error",
        "roles",
        `recipe needs ${browserRoles.length} browser agents; ${ctx.remainingBrowserAgents} remaining`,
      ),
    );
  }
  const codingRoles = recipe.roles.filter((role) => role.config.coding === true);
  if (ctx.remainingCodingAgents !== null && codingRoles.length > ctx.remainingCodingAgents) {
    findings.push(
      finding(
        "capacity.coding",
        "error",
        "roles",
        `recipe needs ${codingRoles.length} coding agents; ${ctx.remainingCodingAgents} remaining`,
      ),
    );
  }
  if (recipe.repositories.length && !codingRoles.length) {
    findings.push(
      finding(
        "repositories.unused",
        "warning",
        "repositories",
        "the recipe lists repositories but no role sets config.coding",
      ),
    );
  }
  for (const role of recipe.roles) {
    const unknown = Object.keys(role.config).filter((key) => !CONFIG_KEYS.has(key)).sort();
    if (unknown.length) {
      findings.push(
        finding("config.unknown", "error", `roles.${role.role}.config`, `unknown keys: ${unknown.join(", ")}`),
      );
    }
    if (role.config.coding !== undefined && typeof role.config.coding !== "boolean") {
      findings.push(finding("coding.flag", "error", `roles.${role.role}.config.coding`, "config.coding must be a boolean"));
    }
    const model = String(role.config.model ?? "").trim();
    const parsed = model ? parseModelId(model) : null;
    if (model && !parsed) {
      findings.push(
        finding(
          "model.unknown",
          "warning",
          `roles.${role.role}.config.model`,
          `unknown model ${model}; apply asks for one`,
        ),
      );
    }
    if (parsed && parsed.provider.kind === "coding" && role.config.coding !== true) {
      findings.push(
        finding(
          "model.coding",
          "warning",
          `roles.${role.role}.config.model`,
          `${model} is only for a coding agent; apply asks for another`,
        ),
      );
    }
    if (parsed && ctx.connectedProviders && !ctx.connectedProviders.has(parsed.provider.id)) {
      findings.push(
        finding(
          "model.not_connected",
          "warning",
          `roles.${role.role}.config.model`,
          `${model} needs a ${providerLabel(parsed.provider.id)} key on Model keys; apply asks for another`,
        ),
      );
    }
    findings.push(...harnessFindings(role));
    if (Boolean(role.config.browser) !== role.browser.required) {
      findings.push(
        finding(
          "browser.flag",
          "error",
          `roles.${role.role}.browser`,
          "browser.required must match config.browser",
        ),
      );
    }
    if (!role.task.body.trim() && !role.focus.trim() && !recipe.guild.objective.trim() && !recipe.guild.about.trim()) {
      findings.push(finding("task.empty", "error", `roles.${role.role}.task`, "role needs a task prompt"));
    } else if (!role.task.body.trim()) {
      findings.push(
        finding(
          "task.derived",
          "warning",
          `roles.${role.role}.task`,
          "task is empty; apply will use the role focus and guild objective",
        ),
      );
    }
    if (!role.schedules.length) {
      const fromDesign = recipe.design.routines.some((item) => item.role === role.role);
      if (!fromDesign) {
        findings.push(
          finding(
            "schedule.missing",
            "warning",
            `roles.${role.role}.schedules`,
            "This role has no routine. Tell the coach how often it should run, for example every 15 minutes.",
          ),
        );
      }
    }
    for (const name of Object.keys(role.native_tools)) {
      if (!NATIVE.has(name)) {
        findings.push(finding("native.unknown", "error", `roles.${role.role}.native_tools.${name}`, `unknown native tool`));
      }
    }
    for (const schedule of role.schedules) {
      try {
        validateTiming(schedule);
      } catch (error) {
        findings.push(
          finding(
            "schedule.invalid",
            "error",
            `roles.${role.role}.schedules.${schedule.key}`,
            error instanceof Error ? error.message : "invalid schedule",
          ),
        );
      }
    }
    for (const script of role.scripts) {
      try {
        validateScriptName(script.name);
        validateScriptDescription(script.description);
        validateScriptSource(script.source);
        validateScriptParameters(script.parameters);
      } catch (error) {
        findings.push(
          finding(
            "script.invalid",
            "error",
            `roles.${role.role}.scripts.${script.name}`,
            error instanceof Error ? error.message : "invalid script",
          ),
        );
      }
      if (/sk-[a-zA-Z0-9]{10,}|api[_-]?key\s*=\s*['"]/i.test(script.source)) {
        findings.push(
          finding(
            "script.literal_secret",
            "error",
            `roles.${role.role}.scripts.${script.name}`,
            "script source must not contain literal credential values",
          ),
        );
      }
      if (script.author.by === "builder" && !script.author.reviewed) {
        findings.push(
          finding(
            "review.script",
            "info",
            `roles.${role.role}.scripts.${script.name}`,
            "Builder-authored script. Edit it here or ask the coach to revise before you validate.",
          ),
        );
      }
    }
  }
  for (const collection of recipe.collections) {
    findings.push(...unknownWriterFindings(collection.writers, roles, { code: "collection.writer", path: `collections.${collection.name}` }));
  }
  const noteIds = new Set(recipe.notes.map((note) => note.id));
  const notePaths = new Set(recipe.notes.map((note) => recipeNotePath(note)));
  for (const note of recipe.notes) {
    if (note.role && !roles.has(note.role)) {
      findings.push(finding("note.role", "error", `notes.${note.id}`, "unknown role"));
    }
    findings.push(...unknownWriterFindings(note.writers, roles, { code: "note.writer", path: `notes.${note.id}` }));
  }
  for (const role of recipe.roles) {
    for (const href of collectTaskEmbeds(role.task.body)) {
      if (href.startsWith("recipe:") && noteIds.has(href.slice("recipe:".length))) {
        continue;
      }
      if (noteIds.has(href) || notePaths.has(href) || isDisplayPath(href)) {
        continue;
      }
      findings.push(
        finding(
          "task.embed",
          "error",
          `roles.${role.role}.task`,
          `unknown file link ${href}. Use the note's destination path (guild/…, org/…, agent/<role>/…) or ![[recipe:<note-id>]].`,
        ),
      );
    }
    const texts = [
      { path: `roles.${role.role}.task`, text: role.task.body },
      ...role.schedules.map((schedule) => ({
        path: `roles.${role.role}.schedules.${schedule.key}`,
        text: schedule.instruction,
      })),
    ];
    for (const { path, text } of texts) {
      for (const notePath of collectRecipeNotePaths(text)) {
        if (notePaths.has(notePath)) {
          continue;
        }
        findings.push(
          finding(
            "task.note_path",
            "error",
            path,
            `unknown note path ${notePath}. Name a note from notes[] by its destination path (guild/…, org/…, agent/<role>/…).`,
          ),
        );
      }
    }
  }
  if (!recipe.connections.length) {
    findings.push(
      finding(
        "connection.missing",
        "warning",
        "connections",
        "No connectors in the recipe. Name a catalog tool in the prompt, or ask the coach to add one.",
      ),
    );
  }
  for (const connection of recipe.connections) {
    if (!ctx.publishedServers.has(connection.server)) {
      const offered = ctx.registryConnectors?.get(connection.server);
      if (connection.manifest) {
        findings.push(
          finding(
            "server.organisation",
            "error",
            `connections.${connection.server}`,
            "not on this box: add it as this organisation's server from the recipe",
          ),
        );
      } else if (offered) {
        findings.push(
          finding(
            "server.registry",
            "error",
            `connections.${connection.server}`,
            `not installed: the registry offers ${connection.server}@${offered.version}, which an instance admin installs`,
          ),
        );
      } else {
        findings.push(
          finding("server.unknown", "error", `connections.${connection.server}`, "unknown or unpublished connector"),
        );
      }
    }
    for (const role of Object.keys(connection.roles)) {
      if (!roles.has(role)) {
        findings.push(finding("connection.role", "error", `connections.${connection.server}.roles.${role}`, "unknown role"));
      }
    }
  }
  for (const cut of operatorAccessCuts(recipe)) {
    if (cut.kind === "tool") {
      findings.push(
        finding(
          "access.tool_removed",
          "info",
          `connections.${cut.server}.roles.${cut.role}.tools.${cut.tool}`,
          `Operator removed ${cut.tool} from ${cut.server} for ${cut.role}. Update the standing prompt if it relies on that tool, or ask why it was removed.`,
        ),
      );
      continue;
    }
    findings.push(
      finding(
        "access.connector_removed",
        "info",
        `design.systems.${cut.server}`,
        `Operator removed the ${cut.server} connector. Update prompts that name it, or ask whether to restore it or switch to another system.`,
      ),
    );
  }
  return findings;
}

export function validateDesign(recipe: RecipeDocument, ctx: ValidationContext): RecipeFinding[] {
  const findings: RecipeFinding[] = [];
  const collectionNames = new Set(recipe.collections.map((item) => item.name));
  const scheduleKeys = new Set(recipe.roles.flatMap((role) => role.schedules.map((schedule) => schedule.key)));
  for (const routine of recipe.design.routines) {
    if (!scheduleKeys.has(routine.key)) {
      findings.push(finding("design.routine_missing", "error", `design.routines.${routine.key}`, "routine key is not on a role"));
    }
    if (!routine.dedupe_collection && !routine.dedupe_key) {
      findings.push(
        finding(
          "design.poll_dedupe",
          "error",
          `design.routines.${routine.key}`,
          "poll routine needs a dedupe collection or key",
        ),
      );
    }
    if (routine.dedupe_collection && !collectionNames.has(routine.dedupe_collection)) {
      findings.push(
        finding(
          "design.unknown_collection",
          "error",
          `design.routines.${routine.key}`,
          `unknown collection ${routine.dedupe_collection}`,
        ),
      );
    }
  }
  for (const role of recipe.roles) {
    if (role.schedules.length && !recipe.design.routines.some((item) => item.role === role.role)) {
      for (const schedule of role.schedules) {
        if (!recipe.design.routines.some((item) => item.key === schedule.key)) {
          findings.push(
            finding(
              "design.poll_dedupe",
              "error",
              `roles.${role.role}.schedules.${schedule.key}`,
              "routine has no design.routines entry with a dedupe store",
            ),
          );
        }
      }
    }
  }
  for (const spec of recipe.design.specialization) {
    if (!recipe.roles.some((role) => role.role === spec.role)) {
      findings.push(finding("design.specialization_role", "error", `design.specialization.${spec.role}`, "unknown role"));
    }
  }
  if (recipe.meta.source.kind === "builder" && recipe.roles.length === 1) {
    const only = recipe.roles[0];
    const justified = recipe.design.specialization.some(
      (item) => item.role === only?.role && item.detail.trim().length > 0,
    );
    if (!justified) {
      findings.push(
        finding(
          "design.single_role",
          "warning",
          "roles",
          "Split into specialized roles with distinct prompts, or record in design.specialization why this stays one agent.",
        ),
      );
    }
  }
  if (recipe.roles.length > 1) {
    const hasProtocol = recipe.design.handoffs.some(
      (item) => item.kind === "collection" || (item.kind === "tagged" && typeof item.budget === "number"),
    );
    if (!hasProtocol) {
      findings.push(
        finding(
          "design.handoff",
          "error",
          "design.handoffs",
          "multiple roles require a queue/fan-in collection or an explicit tagged-message budget",
        ),
      );
    }
  }
  for (const handoff of recipe.design.handoffs) {
    if (handoff.kind === "collection" && handoff.collection && !collectionNames.has(handoff.collection)) {
      findings.push(
        finding("design.unknown_collection", "error", `design.handoffs`, `unknown collection ${handoff.collection}`),
      );
    }
    if (handoff.kind === "tagged" && (handoff.budget === undefined || handoff.budget > ctx.groupLimit)) {
      findings.push(
        finding(
          "design.tagged_budget",
          "error",
          "design.handoffs",
          "tagged protocol needs a budget within group_agent_message_limit",
        ),
      );
    }
  }
  for (const browser of recipe.design.browser) {
    if (!browser.viable) {
      findings.push(
        finding("design.browser_viability", "warning", `design.browser.${browser.role}`, "site failed a viability test"),
      );
    }
    if (!browser.login_failure_policy) {
      findings.push(
        finding(
          "design.browser_login_policy",
          "error",
          `design.browser.${browser.role}`,
          "browser role needs a login-failure policy",
        ),
      );
    }
  }
  for (const role of recipe.roles) {
    if ((role.browser.required || role.config.browser) && !recipe.design.browser.some((item) => item.role === role.role)) {
      findings.push(
        finding(
          "design.browser_login_policy",
          "error",
          `roles.${role.role}.browser`,
          "browser role needs design.browser viability and login-failure policy",
        ),
      );
    }
  }
  const usedServers = new Set<string>();
  for (const connection of recipe.connections) {
    const anyEnabled = Object.values(connection.roles).some((item) => item.enabled);
    if (!anyEnabled) {
      findings.push(
        finding("design.unused_access", "warning", `connections.${connection.server}`, "connection is unused"),
      );
    }
    usedServers.add(connection.server);
  }
  const producerCron = new Map<string, string>();
  for (const handoff of recipe.design.handoffs) {
    if (handoff.kind !== "collection" || !handoff.collection) {
      continue;
    }
    const producer = recipe.design.routines.find((item) => item.role === handoff.from);
    const consumer = recipe.design.routines.find((item) => item.role === handoff.to);
    if (producer && consumer && producer.cadence === consumer.cadence) {
      findings.push(
        finding(
          "design.cadence_collision",
          "warning",
          `design.handoffs`,
          `${handoff.to} shares a cadence with producer ${handoff.from}`,
        ),
      );
    }
    if (producer) {
      producerCron.set(handoff.collection, producer.cadence);
    }
  }
  for (const collection of recipe.collections) {
    const handoffs = recipe.design.handoffs.filter(
      (item) => item.kind === "collection" && item.collection === collection.name,
    );
    const dedupeRoutines = recipe.design.routines.filter((item) => item.dedupe_collection === collection.name);
    if (!handoffs.length && !dedupeRoutines.length) {
      findings.push(
        finding("design.orphan_collection", "warning", `collections.${collection.name}`, "collection is never read or written"),
      );
    }
    if (!collection.columns.length) {
      findings.push(
        finding("design.untyped_collection", "error", `collections.${collection.name}`, "collection declares no columns"),
      );
    } else if (handoffs.length && !stateColumn(collection.columns)) {
      findings.push(
        finding(
          "design.handoff_state",
          "error",
          `collections.${collection.name}`,
          "hand-off collection needs a required text column with values: the state the consumer matches on",
        ),
      );
    }
    const writingRoles = new Map<string, string>();
    for (const handoff of handoffs) {
      writingRoles.set(handoff.from, "hand-off producer");
      writingRoles.set(handoff.to, "hand-off consumer");
    }
    for (const routine of dedupeRoutines) {
      if (!writingRoles.has(routine.role)) {
        writingRoles.set(routine.role, `dedupe store of routine ${routine.key}`);
      }
    }
    for (const [role, use] of writingRoles) {
      if (collection.guild !== "write" && !collection.writers.includes(role) && recipe.roles.some((item) => item.role === role)) {
        findings.push(
          finding(
            "design.collection_access",
            "error",
            `collections.${collection.name}`,
            `${role} cannot write ${collection.name} (${use}); set guild to write or add ${role} to writers`,
          ),
        );
      }
    }
  }
  void usedServers;
  void producerCron;
  findings.push(...narrownessFindings(recipe));
  return findings;
}

/** An error for each role of a table's or a note's `writers` that the recipe does not have. */
function unknownWriterFindings(
  writers: string[],
  roles: Set<string>,
  where: { code: string; path: string },
): RecipeFinding[] {
  return writers
    .filter((writer) => !roles.has(writer))
    .map((writer) => finding(where.code, "error", where.path, `unknown writer role ${writer}`));
}

/** The roles whose Task or routines embed or name a note. */
function noteReaders(recipe: RecipeDocument, note: RecipeDocument["notes"][number]): string[] {
  const path = recipeNotePath(note);
  const refs = new Set([path, note.id, `recipe:${note.id}`]);
  return recipe.roles
    .filter((role) => {
      if (collectTaskEmbeds(role.task.body).some((href) => refs.has(href))) return true;
      return [role.task.body, ...role.schedules.map((schedule) => schedule.instruction)].some((text) =>
        collectRecipeNotePaths(text).includes(path),
      );
    })
    .map((role) => role.role);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builder designs that load roles with what their work does not use: a shared
 * note that describes several roles, a role offered every native tool, and a
 * connection role that lists none of its tools.
 */
function narrownessFindings(recipe: RecipeDocument): RecipeFinding[] {
  if (recipe.meta.source.kind !== "builder" || recipe.roles.length < 2) {
    return [];
  }
  const findings: RecipeFinding[] = [];
  for (const note of recipe.notes) {
    if (note.level === "agent" || !noteReaders(recipe, note).length) continue;
    const named = recipe.roles
      .map((role) => role.role)
      .filter((role) => new RegExp(`(^|[^a-z0-9-])${escapeRegExp(role)}($|[^a-z0-9-])`, "i").test(note.body));
    if (named.length >= 2) {
      findings.push(
        finding(
          "design.shared_note_roles",
          "warning",
          `notes.${note.id}`,
          `this shared note describes several roles (${named.join(", ")}), so every role that reads it carries the others' work on each wake. Keep only what every reader uses and move each role's part into its own agent note.`,
        ),
      );
    }
  }
  for (const role of recipe.roles) {
    if (!Object.values(role.native_tools).some((enabled) => enabled === false)) {
      findings.push(
        finding(
          "access.broad_native",
          "warning",
          `roles.${role.role}.native_tools`,
          "every native tool stays on for this role; set false for each tool its Task does not call",
        ),
      );
    }
  }
  for (const connection of recipe.connections) {
    for (const [role, spec] of Object.entries(connection.roles)) {
      if (spec.enabled && !Object.keys(spec.tools).length) {
        findings.push(
          finding(
            "access.broad_connection",
            "warning",
            `connections.${connection.server}.roles.${role}.tools`,
            `${role} lists no ${connection.server} tools, so it is offered every one; set false for each tool its Task does not call`,
          ),
        );
      }
    }
  }
  return findings;
}

/** The required text column with a closed value list: what a consumer matches work on. */
function stateColumn(columns: CollectionColumn[]): CollectionColumn | null {
  return columns.find((column) => column.type === "text" && column.required && Boolean(column.values?.length)) ?? null;
}

export function validateRecipe(recipe: RecipeDocument, ctx: ValidationContext): RecipeFinding[] {
  return [...validateMechanical(recipe, ctx), ...validateDesign(recipe, ctx)];
}

export function blockingErrors(findings: RecipeFinding[]): RecipeFinding[] {
  return findings.filter((item) => item.severity === "error");
}

const APPLY_NON_BLOCKING = new Set(["design.poll_dedupe", "design.routine_missing"]);

export function applyBlockingErrors(findings: RecipeFinding[]): RecipeFinding[] {
  return blockingErrors(findings).filter((item) => !APPLY_NON_BLOCKING.has(item.code));
}
