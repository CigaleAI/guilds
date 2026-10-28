import type { CollectionColumn } from "../db/collections.js";
import { collectTaskEmbeds } from "../artifacts/embeds.js";
import { collectRecipeNotePaths, recipeNotePath } from "./rewrite.js";
import type { RecipeDocument } from "./schema.js";
import { browserRoles, finding, type RecipeFinding, type RecipeRule, type ValidationContext } from "./findings.js";

// The design checks of a recipe: that its routines dedupe, its roles hand work off through a
// protocol, its browser roles have a login plan, its collections are read, written and typed,
// and its roles are not offered more than their work uses.

type DesignRoutine = RecipeDocument["design"]["routines"][number];
type RecipeCollection = RecipeDocument["collections"][number];
type RecipeNote = RecipeDocument["notes"][number];

function collectionNames(recipe: RecipeDocument): Set<string> {
  return new Set(recipe.collections.map((item) => item.name));
}

/** A design routine no role runs, with no dedupe store, or deduping in an unknown collection. */
function routineFindings(routine: DesignRoutine, context: { scheduleKeys: Set<string>; collections: Set<string> }): RecipeFinding[] {
  const path = `design.routines.${routine.key}`;
  const findings: RecipeFinding[] = [];
  if (!context.scheduleKeys.has(routine.key)) {
    findings.push(finding("design.routine_missing", "error", path, "routine key is not on a role"));
  }
  if (!routine.dedupe_collection && !routine.dedupe_key) {
    findings.push(finding("design.poll_dedupe", "error", path, "poll routine needs a dedupe collection or key"));
  }
  if (routine.dedupe_collection && !context.collections.has(routine.dedupe_collection)) {
    findings.push(finding("design.unknown_collection", "error", path, `unknown collection ${routine.dedupe_collection}`));
  }
  return findings;
}

function designRoutines(recipe: RecipeDocument): RecipeFinding[] {
  const context = {
    scheduleKeys: new Set(recipe.roles.flatMap((role) => role.schedules.map((schedule) => schedule.key))),
    collections: collectionNames(recipe),
  };
  return recipe.design.routines.flatMap((routine) => routineFindings(routine, context));
}

/** Routines of a role the design lists none of, each without a design entry naming its dedupe store. */
function undesignedSchedules(recipe: RecipeDocument): RecipeFinding[] {
  const routines = recipe.design.routines;
  return recipe.roles
    .filter((role) => !routines.some((item) => item.role === role.role))
    .flatMap((role) =>
      role.schedules
        .filter((schedule) => !routines.some((item) => item.key === schedule.key))
        .map((schedule) =>
          finding(
            "design.poll_dedupe",
            "error",
            `roles.${role.role}.schedules.${schedule.key}`,
            "routine has no design.routines entry with a dedupe store",
          ),
        ),
    );
}

/** Specializations of roles the recipe does not have. */
function specializationRoles(recipe: RecipeDocument): RecipeFinding[] {
  return recipe.design.specialization
    .filter((spec) => !recipe.roles.some((role) => role.role === spec.role))
    .map((spec) => finding("design.specialization_role", "error", `design.specialization.${spec.role}`, "unknown role"));
}

/** A Builder recipe of one role that does not say why it stays one agent. */
function singleRole(recipe: RecipeDocument): RecipeFinding[] {
  const only = recipe.roles[0];
  if (recipe.meta.source.kind !== "builder" || recipe.roles.length !== 1) return [];
  if (recipe.design.specialization.some((item) => item.role === only?.role && item.detail.trim().length > 0)) return [];
  return [
    finding(
      "design.single_role",
      "warning",
      "roles",
      "Split into specialized roles with distinct prompts, or record in design.specialization why this stays one agent.",
    ),
  ];
}

/** Several roles with neither a hand-off collection nor a tagged-message budget. */
function handoffProtocol(recipe: RecipeDocument): RecipeFinding[] {
  if (recipe.roles.length <= 1) return [];
  const hasProtocol = recipe.design.handoffs.some(
    (item) => item.kind === "collection" || (item.kind === "tagged" && typeof item.budget === "number"),
  );
  if (hasProtocol) return [];
  return [
    finding(
      "design.handoff",
      "error",
      "design.handoffs",
      "multiple roles require a queue/fan-in collection or an explicit tagged-message budget",
    ),
  ];
}

/** Hand-offs through an unknown collection, or tagged ones without a budget within the group limit. */
function handoffFindings(recipe: RecipeDocument, ctx: ValidationContext): RecipeFinding[] {
  const collections = collectionNames(recipe);
  return recipe.design.handoffs.flatMap((handoff) => [
    ...(handoff.kind === "collection" && handoff.collection && !collections.has(handoff.collection)
      ? [finding("design.unknown_collection", "error", `design.handoffs`, `unknown collection ${handoff.collection}`)]
      : []),
    ...(handoff.kind === "tagged" && (handoff.budget === undefined || handoff.budget > ctx.groupLimit)
      ? [finding("design.tagged_budget", "error", "design.handoffs", "tagged protocol needs a budget within group_agent_message_limit")]
      : []),
  ]);
}

/** Browser designs whose site failed its viability test, or that have no login-failure policy. */
function browserDesigns(recipe: RecipeDocument): RecipeFinding[] {
  return recipe.design.browser.flatMap((browser) => [
    ...(browser.viable ? [] : [finding("design.browser_viability", "warning", `design.browser.${browser.role}`, "site failed a viability test")]),
    ...(browser.login_failure_policy
      ? []
      : [finding("design.browser_login_policy", "error", `design.browser.${browser.role}`, "browser role needs a login-failure policy")]),
  ]);
}

/** Browser roles the design gives no viability and login-failure policy. */
function undesignedBrowserRoles(recipe: RecipeDocument): RecipeFinding[] {
  return browserRoles(recipe)
    .filter((role) => !recipe.design.browser.some((item) => item.role === role.role))
    .map((role) =>
      finding(
        "design.browser_login_policy",
        "error",
        `roles.${role.role}.browser`,
        "browser role needs design.browser viability and login-failure policy",
      ),
    );
}

/** Connections no role is enabled on. */
function unusedConnections(recipe: RecipeDocument): RecipeFinding[] {
  return recipe.connections
    .filter((connection) => !Object.values(connection.roles).some((item) => item.enabled))
    .map((connection) => finding("design.unused_access", "warning", `connections.${connection.server}`, "connection is unused"));
}

/** Hand-offs through a collection whose consumer wakes on the producer's cadence. */
function cadenceCollisions(recipe: RecipeDocument): RecipeFinding[] {
  return recipe.design.handoffs.flatMap((handoff) => {
    if (handoff.kind !== "collection" || !handoff.collection) return [];
    const producer = recipe.design.routines.find((item) => item.role === handoff.from);
    const consumer = recipe.design.routines.find((item) => item.role === handoff.to);
    if (!producer || !consumer || producer.cadence !== consumer.cadence) return [];
    return [finding("design.cadence_collision", "warning", `design.handoffs`, `${handoff.to} shares a cadence with producer ${handoff.from}`)];
  });
}

/** How the design uses a collection: the hand-offs through it and the routines deduping in it. */
type CollectionUse = {
  collection: RecipeCollection;
  handoffs: RecipeDocument["design"]["handoffs"];
  dedupeRoutines: DesignRoutine[];
};

/** A collection no hand-off or routine reads or writes. */
function orphanCollection(use: CollectionUse): RecipeFinding[] {
  if (use.handoffs.length || use.dedupeRoutines.length) return [];
  return [finding("design.orphan_collection", "warning", `collections.${use.collection.name}`, "collection is never read or written")];
}

/** The required text column with a closed value list: what a consumer matches work on. */
function stateColumn(columns: CollectionColumn[]): CollectionColumn | null {
  return columns.find((column) => column.type === "text" && column.required && Boolean(column.values?.length)) ?? null;
}

/** A collection with no columns, or a hand-off collection without a state column. */
function collectionShape(use: CollectionUse): RecipeFinding[] {
  const path = `collections.${use.collection.name}`;
  if (!use.collection.columns.length) {
    return [finding("design.untyped_collection", "error", path, "collection declares no columns")];
  }
  if (!use.handoffs.length || stateColumn(use.collection.columns)) return [];
  return [
    finding(
      "design.handoff_state",
      "error",
      path,
      "hand-off collection needs a required text column with values: the state the consumer matches on",
    ),
  ];
}

/** The roles that write a collection, with what each writes it for. */
function collectionWritingRoles(use: CollectionUse): Map<string, string> {
  const writing = new Map<string, string>();
  for (const handoff of use.handoffs) {
    writing.set(handoff.from, "hand-off producer");
    writing.set(handoff.to, "hand-off consumer");
  }
  for (const routine of use.dedupeRoutines) {
    if (!writing.has(routine.role)) {
      writing.set(routine.role, `dedupe store of routine ${routine.key}`);
    }
  }
  return writing;
}

/** Roles that write a collection its access list does not let them write. */
function collectionAccess(use: CollectionUse, recipe: RecipeDocument): RecipeFinding[] {
  const { collection } = use;
  if (collection.guild === "write") return [];
  return [...collectionWritingRoles(use)]
    .filter(([role]) => !collection.writers.includes(role) && recipe.roles.some((item) => item.role === role))
    .map(([role, purpose]) =>
      finding(
        "design.collection_access",
        "error",
        `collections.${collection.name}`,
        `${role} cannot write ${collection.name} (${purpose}); set guild to write or add ${role} to writers`,
      ),
    );
}

const COLLECTION_RULES = [orphanCollection, collectionShape, collectionAccess];

function collectionFindings(recipe: RecipeDocument): RecipeFinding[] {
  return recipe.collections.flatMap((collection) => {
    const use = {
      collection,
      handoffs: recipe.design.handoffs.filter((item) => item.kind === "collection" && item.collection === collection.name),
      dedupeRoutines: recipe.design.routines.filter((item) => item.dedupe_collection === collection.name),
    };
    return COLLECTION_RULES.flatMap((rule) => rule(use, recipe));
  });
}

/** The roles whose Task or routines embed or name a note. */
function noteReaders(recipe: RecipeDocument, note: RecipeNote): string[] {
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

/** Shared notes that describe several roles, so each reader carries the others' work. */
function sharedNoteRoles(recipe: RecipeDocument): RecipeFinding[] {
  return recipe.notes.flatMap((note) => {
    if (note.level === "agent" || !noteReaders(recipe, note).length) return [];
    const named = recipe.roles
      .map((role) => role.role)
      .filter((role) => new RegExp(`(^|[^a-z0-9-])${escapeRegExp(role)}($|[^a-z0-9-])`, "i").test(note.body));
    if (named.length < 2) return [];
    return [
      finding(
        "design.shared_note_roles",
        "warning",
        `notes.${note.id}`,
        `this shared note describes several roles (${named.join(", ")}), so every role that reads it carries the others' work on each wake. Keep only what every reader uses and move each role's part into its own agent note.`,
      ),
    ];
  });
}

/** Roles offered every native tool. */
function broadNative(recipe: RecipeDocument): RecipeFinding[] {
  return recipe.roles
    .filter((role) => !Object.values(role.native_tools).some((enabled) => enabled === false))
    .map((role) =>
      finding(
        "access.broad_native",
        "warning",
        `roles.${role.role}.native_tools`,
        "every native tool stays on for this role; set false for each tool its Task does not call",
      ),
    );
}

/** Connection roles that list none of the server's tools, so they are offered every one. */
function broadConnection(recipe: RecipeDocument): RecipeFinding[] {
  return recipe.connections.flatMap((connection) =>
    Object.entries(connection.roles)
      .filter(([, spec]) => spec.enabled && !Object.keys(spec.tools).length)
      .map(([role]) =>
        finding(
          "access.broad_connection",
          "warning",
          `connections.${connection.server}.roles.${role}.tools`,
          `${role} lists no ${connection.server} tools, so it is offered every one; set false for each tool its Task does not call`,
        ),
      ),
  );
}

const NARROWNESS_RULES = [sharedNoteRoles, broadNative, broadConnection];

/**
 * Builder designs that load roles with what their work does not use: a shared
 * note that describes several roles, a role offered every native tool, and a
 * connection role that lists none of its tools.
 */
function narrownessFindings(recipe: RecipeDocument): RecipeFinding[] {
  if (recipe.meta.source.kind !== "builder" || recipe.roles.length < 2) {
    return [];
  }
  return NARROWNESS_RULES.flatMap((rule) => rule(recipe));
}

const DESIGN_RULES: RecipeRule[] = [
  designRoutines,
  undesignedSchedules,
  specializationRoles,
  singleRole,
  handoffProtocol,
  handoffFindings,
  browserDesigns,
  undesignedBrowserRoles,
  unusedConnections,
  cadenceCollisions,
  collectionFindings,
  narrownessFindings,
];

export function validateDesign(recipe: RecipeDocument, ctx: ValidationContext): RecipeFinding[] {
  return DESIGN_RULES.flatMap((rule) => rule(recipe, ctx));
}
