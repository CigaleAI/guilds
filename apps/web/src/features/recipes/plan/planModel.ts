import { describeCron, describeWindow } from "../../agent/routine/describeTiming";
import { harnessLabel, isHarness } from "../../agent/harness";
import { agentsMinimum, machineSizeLabel } from "../../machines/machines";
import type {
  AccessEdit,
  ApplyCreates,
  CapabilityServer,
  Column,
  CollectionPlan,
  CreatedAgent,
  CreatedRoutine,
  DesignBrowser,
  DesignHandoff,
  DesignSystem,
  FieldAuthor,
  Harness,
  PlannedConnection,
  PlannedSecret,
  RecipeConnection,
  RecipeDesign,
  RecipeDocument,
  RecipeExternal,
  RecipeFinding,
  RecipeRepository,
  RecipeNote,
  RecipeRole,
  RecipeSchedule,
  RecipeScript,
  RecipeSecret,
  WakeWindow,
} from "../../../api/types";

/**
 * A value as the plan reads it: every field optional at any depth, so partial drafts and hand-made
 * recipes fit. A routine window stays whole, since its four fields always travel together.
 */
export type Draft<T> = unknown extends T
  ? T
  : T extends string | number | boolean | null | undefined
    ? T
    : T extends WakeWindow
      ? T
      : T extends readonly (infer U)[]
        ? readonly Draft<U>[]
        : { [K in keyof T]?: Draft<T[K]> | null | undefined };

/** A field author as the plan reads it. */
export type AuthorDraft = Draft<FieldAuthor>;
/** A role script as the plan reads it. */
export type ScriptDraft = Draft<RecipeScript>;
/** A role routine as the plan reads it. */
export type ScheduleDraft = Draft<RecipeSchedule>;
/** A role as the plan reads it; the task may also be given as plain text. */
export type RoleDraft = Omit<Draft<RecipeRole>, "task"> & {
  task?: Draft<RecipeRole["task"]> | string | null | undefined;
};
/** A design system as the plan reads it, with an optional `kind` and explicit target `roles`. */
export type SystemDraft = Draft<DesignSystem> & {
  kind?: string | null | undefined;
  roles?: readonly string[] | null | undefined;
};
/** The design notes as the plan reads them. */
export type DesignDraft = Omit<Draft<RecipeDesign>, "systems"> & {
  systems?: readonly SystemDraft[] | null | undefined;
};
/** A recipe document as the plan reads it. */
export type RecipeDraft = Omit<Draft<RecipeDocument>, "roles" | "design"> & {
  roles?: readonly RoleDraft[] | null | undefined;
  design?: DesignDraft | null | undefined;
};
/** A stored recipe row (its `body` is the document, as in `RecipeRow`), a recipe document, or nothing. */
export type RecipeSource = { body: unknown } | RecipeDraft | null | undefined;
/** A connector from the recipe, the apply plan, or both merged. */
export type ConnectionDraft = Draft<RecipeConnection> &
  Draft<Pick<PlannedConnection, "action" | "connection_id" | "reusable">>;
/** A secret from the recipe or the apply plan. */
export type SecretDraft = Draft<RecipeSecret> &
  Draft<Pick<PlannedSecret, "action" | "dest_name" | "collision">>;
/** A collection from the recipe, or the apply plan's decision for it. */
export type CollectionDraft = Draft<CollectionPlan>;
/** A seed note from the recipe, the apply plan, or both merged. */
export type NoteDraft = Draft<RecipeNote>;
/** An external setup card as the plan reads it. */
export type ExternalDraft = Draft<RecipeExternal>;
/** A repository the recipe needs, as the plan reads it. */
export type RepositoryDraft = Draft<RecipeRepository>;
/** A design handoff as the plan reads it. */
export type HandoffDraft = Draft<DesignHandoff>;
/** A design browser site as the plan reads it. */
export type BrowserSiteDraft = Draft<DesignBrowser>;
/** An agent from the apply plan. */
export type CreatedAgentDraft = Draft<CreatedAgent>;
/** A routine from the apply plan, with the author when one is attached. */
export type OverlayRoutine = Draft<CreatedRoutine> & { author?: AuthorDraft | null | undefined };
/** The apply plan's inventory as the plan reads it. */
export type CreatesDraft = Omit<Draft<ApplyCreates>, "routines" | "connections" | "secrets"> & {
  routines?: readonly OverlayRoutine[] | null | undefined;
  connections?: readonly ConnectionDraft[] | null | undefined;
  secrets?: readonly SecretDraft[] | null | undefined;
};

/**
 * What the apply preview adds on top of the recipe: its inventory, and planned connectors and
 * secrets used when the inventory has none.
 */
export type PlanOverlay = {
  creates?: CreatesDraft | null | undefined;
  connections?: readonly ConnectionDraft[] | null | undefined;
  secrets?: readonly SecretDraft[] | null | undefined;
};

/** A catalog tool as the plan reads it; the first of its names that is set is its name. */
export type CatalogToolEntry = {
  namespaced_name?: string | null | undefined;
  remote_name?: string | null | undefined;
  name?: string | null | undefined;
};

/** A catalog connector as the plan reads it, matched to a recipe connector by `slug` or `server`. */
export type CatalogEntry = Omit<Partial<CapabilityServer>, "tools"> & {
  server?: string | null | undefined;
  tools?: readonly CatalogToolEntry[] | null | undefined;
};

/** Where a routine comes from: a role schedule, the apply plan, or a design cadence. */
export type RoutineSource = "schedule" | "apply" | "design";

/** One routine the plan shows. */
export type PlanRoutine = {
  role: string;
  key: string;
  cron: string | null;
  window: WakeWindow | null;
  description: string;
  instruction: string;
  author: AuthorDraft | null;
  source: RoutineSource;
  /** Set on design routines: the collection the routine dedupes against, or "". */
  dedupe_collection?: string;
};

/** One agent the plan shows. */
export type PlanAgent = {
  role: string;
  name: string;
  focus: string;
  model: string;
  avatar_shape: string;
  avatar_color: string;
  browser: boolean;
  coding: boolean;
  /** The harness a coding agent runs; null when it does not code or none is named yet. */
  harness: Harness | null;
  browserInstructions: string;
  task: string;
  taskAuthor: AuthorDraft | null;
  browserAuthor: AuthorDraft | null;
  nativeTools: string[];
  scripts: readonly ScriptDraft[];
  routines: PlanRoutine[];
};

/** One script the plan shows, with the role that owns it. */
export type PlanScript = {
  role: string;
  name: string;
  description: string;
  author: AuthorDraft | null;
  source: string;
};

/** One collection column the plan shows. */
export type PlanColumn = {
  name: string;
  type: string;
  description: string;
  required: boolean;
  unique: boolean;
  values: string[];
};

/** One collection the plan shows; `action` is "" when there is no apply decision. */
export type PlanCollection = {
  name: string;
  purpose: string;
  columns: PlanColumn[];
  scope: "guild" | "org";
  guild: "read" | "write";
  writers: string[];
  action: "" | "create" | "reuse" | "conflict";
  collection_id: string | null;
  differences: string[];
};

/**
 * One operator step apply needs: a connector login, a secret, a repository to add, a browser
 * login, or an external setup.
 */
export type PlanAction = {
  kind: "connect" | "reuse" | "secret" | "repository" | "browser" | "external";
  title: string;
  detail: string;
  path: string;
  author: AuthorDraft | null;
  required: boolean;
  server?: string;
  role?: string;
};

/** The guild the plan creates. */
export type PlanGuild = { name: string; about: string; objective: string; groupLimit: number };

/** How many of each thing the plan holds. */
export type PlanCounts = {
  agents: number;
  collections: number;
  notes: number;
  scripts: number;
  routines: number;
  connections: number;
  secrets: number;
};

/** Everything a recipe creates and needs, ready to show. */
export type RecipePlan = {
  guild: PlanGuild;
  agents: PlanAgent[];
  collections: PlanCollection[];
  notes: readonly NoteDraft[];
  scripts: PlanScript[];
  routines: PlanRoutine[];
  connections: ConnectionDraft[];
  secrets: readonly SecretDraft[];
  external: readonly ExternalDraft[];
  repositories: readonly RepositoryDraft[];
  systems: readonly SystemDraft[];
  handoffs: readonly HandoffDraft[];
  browserSites: readonly BrowserSiteDraft[];
  actions: PlanAction[];
  counts: PlanCounts;
};

/** Tool switches and connector removals the operator has made but not yet validated. */
export type PendingAccess = { tools: Map<string, boolean>; removed: Set<string> };

function asArray<T>(value: readonly T[] | null | undefined): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : [];
}

function asObject<T extends object>(value: T | null | undefined): Partial<T> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function enabledKeys(map: unknown): string[] {
  return Object.entries(recordOf(map))
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
}

/** True when a recipe's status means it is approved. */
export function isRecipeApproved(status: unknown): boolean {
  return String(status || "") === "ready";
}

/** The word a recipe's status reads as: "approved" or "draft". */
export function recipeStatusLabel(status: unknown): "approved" | "draft" {
  return isRecipeApproved(status) ? "approved" : "draft";
}

/** The recipe document inside a recipe row, the value itself when it is a document, or an empty recipe. */
export function recipeBody(row: unknown): RecipeDraft {
  if (row && typeof row === "object") {
    const body = (row as { body?: unknown }).body;
    if (body && typeof body === "object") return body as RecipeDraft;
    return row as RecipeDraft;
  }
  return { roles: [], collections: [], connections: [], design: {} };
}

/** Findings grouped by their recipe path, in their original order. */
export function findingsByPath(
  findings: readonly RecipeFinding[] | null | undefined,
): Map<string, RecipeFinding[]> {
  const map = new Map<string, RecipeFinding[]>();
  for (const item of asArray(findings)) {
    const list = map.get(item.path) || [];
    list.push(item);
    map.set(item.path, list);
  }
  return map;
}

/** True when a builder wrote the field and no operator has confirmed it. */
export function needsReview(author: AuthorDraft | null | undefined): boolean {
  return Boolean(author && author.by === "builder" && !author.reviewed);
}

/** Who wrote a field, when it is someone other than the builder; null otherwise. */
export function reviewLabel(author: AuthorDraft | null | undefined): string | null {
  if (!author || !author.by || author.by === "builder") return null;
  return author.by;
}

/** The group messages per agent a guild allows when its recipe names no limit, as the orchestrator applies it. */
const DEFAULT_GROUP_LIMIT = 200;

/** A cron expression in words without the UTC suffix, or "Unspecified cadence" when empty. */
export function cadenceLabel(cron: string | null | undefined): string {
  const text = String(cron || "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
  if (!text) return "Unspecified cadence";
  const desc = describeCron(text);
  if (desc && desc !== text) {
    return desc.replace(/\s*\(UTC\)$/i, "");
  }
  if (text === "* * * * *") return "Every minute";
  if (text === "0 * * * *") return "Every hour";
  const everyMin = text.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (everyMin) return everyMin[1] === "1" ? "Every minute" : `Every ${everyMin[1]} minutes`;
  const everyHour = text.match(/^0\s+\*\/(\d+)\s+\*\s+\*\s+\*$/);
  if (everyHour) return everyHour[1] === "1" ? "Every hour" : `Every ${everyHour[1]} hours`;
  return text;
}

/** A routine's timing in words: its random wake window when it has one, its cron otherwise. */
export function scheduleCadence(item: {
  window?: WakeWindow | null | undefined;
  cron?: string | null | undefined;
}): string {
  return item.window ? describeWindow(item.window) : cadenceLabel(item.cron);
}

function isFiveFieldCron(value: unknown): boolean {
  return (
    String(value || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean).length === 5
  );
}

function systemKind(system: SystemDraft | null | undefined): string {
  return String(system?.kind || "")
    .trim()
    .toLowerCase();
}

function systemResolution(system: SystemDraft | null | undefined): string {
  return String(system?.resolution || "")
    .trim()
    .toLowerCase();
}

function systemReason(system: SystemDraft | null | undefined): string {
  return String(system?.reason || "").trim();
}

function isScriptSystem(system: SystemDraft): boolean {
  return systemKind(system) === "script" || systemResolution(system) === "script";
}

/**
 * True when a design system needs an operator at the keyboard: a browser or script resolution, a
 * browser fallback, or a reason that asks to take control. Catalog and native systems never do.
 */
export function isOperatorSystem(system: SystemDraft | null | undefined): boolean {
  const kind = systemKind(system);
  const resolution = systemResolution(system);
  if (
    kind === "catalog" ||
    resolution === "catalog" ||
    kind === "native" ||
    resolution === "native"
  ) {
    return false;
  }
  if (
    kind === "browser" ||
    kind === "script" ||
    resolution === "browser" ||
    resolution === "script" ||
    resolution === "browser_fallback"
  ) {
    return true;
  }
  return /\btake[- ]?control\b/.test(systemReason(system).toLowerCase());
}

/**
 * True when a design system is an open question for the operator: not accepted, not an operator
 * step, not catalog or native, and either a reason starting "Open question" or a decision or
 * composition resolution.
 */
export function isPendingQuestion(system: SystemDraft | null | undefined): boolean {
  if (!system || system.accepted === true) return false;
  if (isOperatorSystem(system)) return false;
  const kind = systemKind(system);
  const resolution = systemResolution(system);
  if (
    kind === "catalog" ||
    resolution === "catalog" ||
    kind === "native" ||
    resolution === "native"
  ) {
    return false;
  }
  const reason = systemReason(system);
  if (/^open question\b/i.test(reason)) return true;
  return (
    resolution === "decision" ||
    resolution === "composition" ||
    kind === "decision" ||
    kind === "composition"
  );
}

/** The design systems of a recipe row or document that are still open questions. */
export function pendingDesignQuestions(recipe: unknown): SystemDraft[] {
  const systems = asArray(asObject(recipeBody(recipe).design).systems);
  return systems.filter((system) => isPendingQuestion(system));
}

/**
 * The roles a design system targets: its explicit `roles`, otherwise every agent whose role handle
 * appears in the system's name or reason.
 */
function systemTargetRoles(system: SystemDraft, agents: readonly PlanAgent[]): string[] {
  const roles = asArray(system?.roles)
    .map((role) => String(role || "").trim())
    .filter(Boolean);
  if (roles.length) return roles;
  const named = String(system?.name || "").toLowerCase();
  const reason = systemReason(system).toLowerCase();
  const haystack = `${named} ${reason}`;
  return agents
    .map((agent) => String(agent.role || "").trim())
    .filter((role) => role && haystack.includes(role.toLowerCase()));
}

/**
 * The operator systems shown on a role's card: those that target the role, plus untargeted ones
 * when the role works through a browser.
 */
export function operatorSystemsForRole(
  plan: Pick<RecipePlan, "agents" | "browserSites" | "systems">,
  roleId: string | null | undefined,
): SystemDraft[] {
  const role = String(roleId || "").trim();
  if (!role) return [];
  const agent = plan.agents.find((entry) => entry.role === role);
  const browserRoles = new Set(
    asArray(plan.browserSites)
      .map((entry) => String(entry?.role || "").trim())
      .filter(Boolean),
  );
  return asArray(plan.systems).filter((system) => {
    if (!isOperatorSystem(system)) return false;
    const targets = systemTargetRoles(system, plan.agents);
    if (targets.includes(role)) return true;
    return !targets.length && Boolean(agent?.browser || browserRoles.has(role));
  });
}

function operatorSystemIsAttached(system: SystemDraft, plan: Pick<RecipePlan, "agents">): boolean {
  if (!isOperatorSystem(system)) return false;
  if (systemTargetRoles(system, plan.agents).length) return true;
  return plan.agents.some((agent) => agent.browser);
}

function taskBody(role: RoleDraft): string {
  const task = role.task;
  if (!task) return "";
  if (typeof task === "string") return task;
  return String(task.body || "");
}

function taskAuthor(role: RoleDraft): AuthorDraft | null {
  const task = role.task;
  return task && typeof task === "object" ? task.author || null : null;
}

/** True when a role uses a connector: every role does when the connector names none. */
export function roleUsesConnection(connection: ConnectionDraft, roleId: string): boolean {
  const roles = asObject(connection.roles);
  const keys = Object.keys(roles);
  if (!keys.length) return true;
  const entry = roles[roleId];
  if (!entry) return false;
  return entry.enabled !== false;
}

/** The connector tools the recipe switches on for a role. */
export function connectionTools(connection: ConnectionDraft, roleId: string): string[] {
  return enabledKeys(asObject(asObject(connection.roles)[roleId]).tools);
}

function catalogEntry(
  catalog: readonly CatalogEntry[] | null | undefined,
  server: string | null | undefined,
): CatalogEntry | null {
  return asArray(catalog).find((item) => item?.slug === server || item?.server === server) || null;
}

/** The tool names the catalog lists for a connector. */
export function catalogToolNames(
  catalog: readonly CatalogEntry[] | null | undefined,
  server: string | null | undefined,
): string[] {
  return asArray(catalogEntry(catalog, server)?.tools)
    .map((item) => String(item?.namespaced_name || item?.remote_name || item?.name || "").trim())
    .filter(Boolean);
}

/** The key a pending tool switch is stored under. */
export function toolKey(server: string, roleId: string, tool: string): string {
  return `${server}\t${roleId}\t${tool}`;
}

/** An empty set of pending access edits. */
export function emptyPendingAccess(): PendingAccess {
  return { tools: new Map(), removed: new Set() };
}

/**
 * Every tool a role can have on a connector, sorted by name: the catalog's tools and those the
 * recipe mentions, each on unless the recipe or a pending switch turns it off.
 */
export function toolsForConnectionRole(
  connection: ConnectionDraft,
  roleId: string,
  catalog: readonly CatalogEntry[] | null | undefined,
  pending: PendingAccess | null = null,
): Array<{ name: string; enabled: boolean }> {
  const overlay = asObject(asObject(asObject(connection.roles)[roleId]).tools);
  const names = new Set([...catalogToolNames(catalog, connection.server), ...Object.keys(overlay)]);
  return [...names].sort().map((name) => {
    const key = toolKey(String(connection.server), roleId, name);
    const pendingEnabled = pending?.tools.get(key);
    return {
      name,
      enabled: pendingEnabled === undefined ? overlay[name] !== false : pendingEnabled,
    };
  });
}

/** The access edits pending switches and removals amount to; tool switches on removed connectors drop out. */
export function pendingAccessEdits(pending: PendingAccess): AccessEdit[] {
  const edits: AccessEdit[] = [];
  for (const [key, enabled] of pending.tools) {
    const [server = "", role = "", tool = ""] = key.split("\t");
    if (pending.removed.has(server)) continue;
    edits.push({ action: "set_tool", server, role, tool, enabled });
  }
  for (const server of pending.removed) {
    edits.push({ action: "remove_connection", server });
  }
  return edits;
}

/** The pending access line: tools switched off and connectors removed; null when nothing is pending. */
export function pendingAccessSummary(pending: PendingAccess): {
  edits: AccessEdit[];
  removedTools: number;
  removedConnectors: number;
  text: string;
  removed: string[];
} | null {
  const edits = pendingAccessEdits(pending);
  if (!edits.length) return null;
  const removedTools = edits.filter(
    (item) => item.action === "set_tool" && item.enabled === false,
  ).length;
  const removedConnectors = edits.filter((item) => item.action === "remove_connection").length;
  return {
    edits,
    removedTools,
    removedConnectors,
    text: `Pending: ${plural(removedTools, "tool")} and ${plural(removedConnectors, "connector")} removed. Validate to save and tell the coach.`,
    removed: [...pending.removed],
  };
}

function mergeConnection(base: ConnectionDraft, overlay: ConnectionDraft): ConnectionDraft {
  return {
    ...base,
    ...overlay,
    roles:
      overlay.roles && Object.keys(asObject(overlay.roles)).length ? overlay.roles : base.roles,
    setup: overlay.setup || overlay.hint || base.setup || base.hint || "",
    hint: overlay.hint || base.hint || "",
    author: overlay.author || base.author || null,
  };
}

type RoutineInput = {
  key?: string | null | undefined;
  cron?: string | null | undefined;
  window?: WakeWindow | null | undefined;
  description?: string | null | undefined;
  instruction?: string | null | undefined;
  author?: AuthorDraft | null | undefined;
};

function scheduledRoutine(
  item: RoutineInput,
  role: string,
  source: "schedule" | "apply",
): PlanRoutine {
  return {
    role,
    key: item.key ?? "",
    cron: item.cron ?? null,
    window: item.window || null,
    description: item.description || "",
    instruction: item.instruction || "",
    author: item.author || null,
    source,
  };
}

function routinesForRole(
  role: RoleDraft,
  doc: RecipeDraft,
  overlayRoutines: readonly OverlayRoutine[],
): PlanRoutine[] {
  const roleId = role.role ?? "";
  const explicit = asArray(role.schedules).map((item) =>
    scheduledRoutine(item, roleId, "schedule"),
  );
  if (explicit.length) return explicit;
  const fromOverlay = overlayRoutines.filter((item) => item.role === role.role);
  if (fromOverlay.length) {
    return fromOverlay.map((item) => scheduledRoutine(item, roleId, "apply"));
  }
  return asArray(asObject(doc.design).routines)
    .filter((item) => item.role === role.role && isFiveFieldCron(item.cadence))
    .map((item) => ({
      role: roleId,
      key: item.key ?? "",
      cron: item.cadence ?? null,
      window: null,
      description: item.key ?? "",
      instruction: "",
      author: null,
      source: "design",
      dedupe_collection: item.dedupe_collection || "",
    }));
}

function connectionsFromRecipe(
  doc: RecipeDraft,
  overlayConnections: readonly ConnectionDraft[],
): ConnectionDraft[] {
  const byServer = new Map<string, ConnectionDraft>();
  for (const item of asArray(doc.connections)) {
    if (item?.server) byServer.set(item.server, item);
  }
  for (const item of overlayConnections) {
    if (!item?.server) continue;
    const current = byServer.get(item.server) || {};
    byServer.set(item.server, mergeConnection(current, item));
  }
  return [...byServer.values()];
}

function collectionColumn(column: Draft<Column> | null | undefined): PlanColumn {
  const item = asObject(column);
  return {
    name: String(item.name || ""),
    type: String(item.type || "text"),
    description: String(item.description || ""),
    required: item.required === true,
    unique: item.unique === true,
    values: asArray(item.values).map((value) => String(value)),
  };
}

function collectionsFromRecipe(
  docCollections: readonly CollectionDraft[],
  overlayCollections: readonly CollectionDraft[],
): PlanCollection[] {
  const source = overlayCollections.length ? overlayCollections : docCollections;
  return source.map((item) => ({
    name: String(item?.name || ""),
    purpose: String(item?.purpose || ""),
    columns: asArray(item?.columns).map(collectionColumn),
    scope: item?.scope === "guild" ? "guild" : "org",
    guild: item?.guild === "write" ? "write" : "read",
    writers: asArray(item?.writers).map((role) => String(role)),
    action:
      item?.action === "create" || item?.action === "reuse" || item?.action === "conflict"
        ? item.action
        : "",
    collection_id: item?.collection_id || null,
    differences: asArray(item?.differences).map((line) => String(line)),
  }));
}

function notesFromRecipe(
  docNotes: readonly NoteDraft[],
  overlayNotes: readonly NoteDraft[],
): readonly NoteDraft[] {
  if (!overlayNotes.length) return docNotes;
  const byId = new Map<string, NoteDraft>();
  const byKey = new Map<string, NoteDraft>();
  for (const item of docNotes) {
    if (item?.id) byId.set(item.id, item);
    if (item?.key) byKey.set(item.key, item);
  }
  return overlayNotes.map((item) => {
    const base: NoteDraft =
      (item?.id && byId.get(item.id)) || (item?.key && byKey.get(item.key)) || {};
    return { ...base, ...item, body: item.body || base.body || "" };
  });
}

function rolesFromCreatedAgents(
  agents: readonly CreatedAgentDraft[],
  overlayRoutines: readonly OverlayRoutine[],
): RoleDraft[] {
  return agents.map((agent) => ({
    role: agent.role,
    name_suggestion: agent.name,
    focus: agent.focus || "",
    config: { model: agent.model, browser: agent.browser, coding: agent.coding },
    task: { body: agent.task || "", embeds: [], author: null },
    native_tools: Object.fromEntries(asArray(agent.native_tools).map((name) => [name, true])),
    scripts: [],
    schedules: overlayRoutines.filter((item) => item.role === agent.role),
    browser: { required: Boolean(agent.browser), instructions: "", author: null },
  }));
}

function planAgent(
  role: RoleDraft,
  doc: RecipeDraft,
  overlayRoutines: readonly OverlayRoutine[],
): PlanAgent {
  const config = asObject(role.config);
  const browser = asObject(role.browser);
  const model = config.model;
  return {
    role: role.role ?? "",
    name: role.name_suggestion || role.role || "",
    focus: role.focus || "",
    model: model ? String(model) : "",
    avatar_shape: role.avatar_shape || "teardrop",
    avatar_color: role.avatar_color || "#7c5cff",
    browser: Boolean(browser.required || config.browser),
    coding: config.coding === true,
    harness: config.coding === true && isHarness(config.harness) ? config.harness : null,
    browserInstructions: browser.instructions || "",
    task: taskBody(role),
    taskAuthor: taskAuthor(role),
    browserAuthor: browser.author || null,
    nativeTools: enabledKeys(role.native_tools),
    scripts: asArray(role.scripts),
    routines: routinesForRole(role, doc, overlayRoutines),
  };
}

/**
 * Everything a recipe creates and needs, ready to show: the guild, its agents with their routines,
 * collections, notes, scripts, connectors, secrets, external setup, design systems, handoffs, and
 * the operator steps apply needs. The apply preview's inventory, when given, overrides the recipe's
 * routines, connectors, secrets, collections, and notes, and supplies agents when the recipe has
 * no roles.
 */
export function planFromRecipe(recipe: RecipeSource, overlay: PlanOverlay = {}): RecipePlan {
  const doc = recipeBody(recipe);
  const guild = asObject(doc.guild);
  const meta = asObject(doc.meta);
  const design = asObject(doc.design);
  const creates = asObject(overlay.creates);
  const overlayRoutines = asArray(creates.routines);
  const overlayConnections = asArray<ConnectionDraft>(
    creates.connections?.length ? creates.connections : overlay.connections,
  );
  const overlaySecrets = asArray<SecretDraft>(
    creates.secrets?.length ? creates.secrets : overlay.secrets,
  );
  let roles: readonly RoleDraft[] = asArray(doc.roles);
  const createdAgents = asArray(creates.agents);
  if (!roles.length && createdAgents.length) {
    roles = rolesFromCreatedAgents(createdAgents, overlayRoutines);
  }
  const agents = roles.map((role) => planAgent(role, doc, overlayRoutines));
  const routines = overlayRoutines.length
    ? overlayRoutines.map((item) => scheduledRoutine(item, item.role ?? "", "apply"))
    : agents.flatMap((agent) => agent.routines);
  const connections = connectionsFromRecipe(doc, overlayConnections);
  const collections = collectionsFromRecipe(
    asArray<CollectionDraft>(doc.collections),
    asArray(creates.collections),
  );
  const notes = notesFromRecipe(asArray(doc.notes), asArray<NoteDraft>(creates.notes));
  const scripts = agents.flatMap((agent) =>
    agent.scripts.map((item) => ({
      role: agent.role,
      name: item.name ?? "",
      description: item.description || "",
      author: item.author || null,
      source: item.source || "",
    })),
  );
  const secrets = overlaySecrets.length ? overlaySecrets : asArray<SecretDraft>(doc.secrets);
  const external = asArray(doc.external);
  const repositories = asArray(doc.repositories).length
    ? asArray(doc.repositories)
    : asArray<RepositoryDraft>(creates.repositories);
  const systems = asArray(design.systems);
  const handoffs = asArray(design.handoffs);
  const browserSites = asArray(design.browser);
  const actions: PlanAction[] = [];
  for (const connection of connections) {
    const reused = Boolean(connection.action === "reuse" && connection.connection_id);
    actions.push({
      kind: reused ? "reuse" : "connect",
      title: reused ? `Reuse ${connection.server}` : `Connect ${connection.server}`,
      detail:
        connection.setup ||
        connection.hint ||
        `${connection.auth || "oauth"} · ${connection.recommended_scope || "guild"}`,
      path: `connections.${connection.server}.setup`,
      author: connection.author || null,
      required: !reused,
      server: connection.server ?? "",
    });
  }
  for (const secret of secrets) {
    actions.push({
      kind: "secret",
      title: `Provide ${secret.dest_name || secret.name}`,
      detail: secret.description || secret.recommended_scope || "",
      path: `secrets.${secret.name}`,
      author: null,
      required: secret.action !== "reuse" && secret.action !== "skip",
    });
  }
  if (repositories.length && !connections.some((connection) => connection.server === "github")) {
    actions.push({
      kind: "connect",
      title: "Connect GitHub",
      detail: "Install the GitHub App on the account that owns the repositories, or reuse an existing install. Pick this login's repositories on the GitHub card in Tools.",
      path: "repositories",
      author: null,
      required: false,
      server: "github",
    });
  }
  for (const repository of repositories) {
    actions.push({
      kind: "repository",
      title: `Add the ${repository.name ?? ""} repository`,
      detail: repository.purpose || "Add it in the guild's Settings under Repositories.",
      path: `repositories.${repository.name ?? ""}`,
      author: null,
      required: true,
    });
  }
  for (const agent of agents) {
    if (!agent.browser) continue;
    const site = browserSites.find((item) => item.role === agent.role)?.site;
    actions.push({
      kind: "browser",
      title: `Take control and log ${agent.name} into ${site || "the web page"}`,
      detail:
        agent.browserInstructions ||
        "No native connector. After apply, open this agent and log in from the Browser tab.",
      path: `roles.${agent.role}.browser`,
      author: agent.browserAuthor,
      required: true,
      role: agent.role,
    });
  }
  for (const [index, card] of external.entries()) {
    actions.push({
      kind: "external",
      title: card.title || card.kind || "External setup",
      detail: card.setup || "",
      path: `external[${index}]`,
      author: card.author || null,
      required: true,
    });
  }
  return {
    guild: {
      name: meta.name || guild.name_suggestion || creates.guild?.name || "Untitled guild",
      about: guild.about || creates.guild?.about || meta.description || "",
      objective: guild.objective || creates.guild?.objective || "",
      groupLimit: guild.group_agent_message_limit ?? DEFAULT_GROUP_LIMIT,
    },
    agents,
    collections,
    notes,
    scripts,
    routines,
    connections,
    secrets,
    external,
    repositories,
    systems,
    handoffs,
    browserSites,
    actions,
    counts: {
      agents: agents.length,
      collections: collections.length,
      notes: notes.length,
      scripts: scripts.length,
      routines: routines.length,
      connections: connections.length,
      secrets: secrets.length,
    },
  };
}

/** A section of the plan page. */
export type PlanSectionId =
  | "agents"
  | "routines"
  | "connectors"
  | "repositories"
  | "collections"
  | "notes"
  | "handoffs"
  | "external";

/** One count tile above the plan and the section it opens. */
export type PlanTallyItem = {
  label: "Agents" | "Connectors" | "Routines" | "Tables" | "Secrets";
  count: number;
  section: PlanSectionId;
};

/** The smallest machine every agent of the plan runs on, in a line: "2 CPU · 4 GiB"; null without agents. */
export function planMachineMinimum(plan: Pick<RecipePlan, "agents">): string | null {
  return plan.agents.length ? machineSizeLabel(agentsMinimum(plan.agents)) : null;
}

/** The count tiles above the plan: agents always, then connectors, routines, tables, and secrets when non-zero. */
export function planTally(plan: RecipePlan): PlanTallyItem[] {
  const items: PlanTallyItem[] = [
    { label: "Agents", count: plan.counts.agents, section: "agents" },
    { label: "Connectors", count: plan.counts.connections, section: "connectors" },
    { label: "Routines", count: plan.counts.routines, section: "routines" },
    { label: "Tables", count: plan.counts.collections, section: "collections" },
    { label: "Secrets", count: plan.counts.secrets, section: "connectors" },
  ];
  return items.filter((item) => item.count > 0 || item.label === "Agents");
}

/** The guild header: name, about text, message cap, and the goal when it says more than the about text. */
export function guildHero(plan: RecipePlan): {
  name: string;
  about: string;
  groupLimit: number;
  goal: string | null;
} {
  const { name, about, objective, groupLimit } = plan.guild;
  return {
    name: name || "Untitled guild",
    about,
    groupLimit,
    goal: objective && objective !== about ? objective : null,
  };
}

/** One section of the plan page: its title, count (null when none is shown), whether it is empty, and whether it starts open. */
export type PlanSection = {
  id: PlanSectionId;
  title: string;
  count: number | null;
  empty: boolean;
  open: boolean;
};

/**
 * The plan page's sections in order. Agents always show; routines, connectors, collections, and
 * notes show when they have entries or when `hideEmpty` is off; repositories, handoffs, and
 * external setup show only with entries.
 */
export function planSections(
  plan: RecipePlan,
  { hideEmpty = false }: { hideEmpty?: boolean } = {},
): PlanSection[] {
  const sections: PlanSection[] = [
    {
      id: "agents",
      title: "Agents",
      count: plan.agents.length,
      empty: !plan.agents.length,
      open: true,
    },
  ];
  if (plan.routines.length || !hideEmpty) {
    sections.push({
      id: "routines",
      title: "Routines",
      count: plan.routines.length,
      empty: !plan.routines.length,
      open: false,
    });
  }
  const access = accessSection(plan);
  if (!access.empty) {
    sections.push({
      id: "connectors",
      title: "Connectors & Integrations",
      count: access.count,
      empty: false,
      open: false,
    });
  } else if (!hideEmpty) {
    sections.push({
      id: "connectors",
      title: "Connectors & Integrations",
      count: null,
      empty: true,
      open: false,
    });
  }
  if (plan.repositories.length) {
    sections.push({
      id: "repositories",
      title: "Repositories",
      count: plan.repositories.length,
      empty: false,
      open: true,
    });
  }
  if (plan.collections.length || !hideEmpty) {
    sections.push({
      id: "collections",
      title: "Tables",
      count: plan.collections.length ? plan.collections.length : null,
      empty: !plan.collections.length,
      open: false,
    });
  }
  if (plan.notes.length || !hideEmpty) {
    sections.push({
      id: "notes",
      title: "Notes",
      count: plan.notes.length ? plan.notes.length : null,
      empty: !plan.notes.length,
      open: Boolean(plan.notes.length),
    });
  }
  if (plan.handoffs.length) {
    sections.push({
      id: "handoffs",
      title: "Handoffs",
      count: plan.handoffs.length,
      empty: false,
      open: true,
    });
  }
  if (plan.external.length) {
    sections.push({
      id: "external",
      title: "External setup",
      count: plan.external.length,
      empty: false,
      open: true,
    });
  }
  return sections;
}

/** The blocking-issue banner: how many error findings there are and the first one's message; null when none. */
export function blockingSummary(findings: readonly RecipeFinding[] | null | undefined): {
  count: number;
  label: string;
  hint: string;
  errors: RecipeFinding[];
} | null {
  const errors = asArray(findings)
    .filter(
      (item) =>
        item.code !== "review.required" &&
        item.code !== "review.script" &&
        (item.severity === "error" || item.severity === "warning"),
    )
    .filter((item) => item.severity === "error");
  const first = errors[0];
  if (!first) return null;
  return {
    count: errors.length,
    label: `${plural(errors.length, "issue")} to fix`,
    hint: errors.length === 1 ? first.message : `${first.message} (+${errors.length - 1} more)`,
    errors,
  };
}

/** The findings attached to one role: all of them, the routine advice, and the notices shown on the card. */
export type RoleFindings = {
  all: RecipeFinding[];
  routine: RecipeFinding | null;
  notices: RecipeFinding[];
};

/** Findings about what apply itself asks for or what is set up after it, which no card shows. */
const settledByApply: ReadonlySet<string> = new Set(["harness.credential"]);

/**
 * The findings at `roles.<role>` or under it: the routine advice is a `schedule.missing` finding
 * or one at `roles.<role>.schedules`; notices are the rest outside any schedule path, leaving out
 * what apply settles.
 */
export function roleFindings(
  findings: readonly RecipeFinding[] | null | undefined,
  role: string,
): RoleFindings {
  const path = `roles.${role}`;
  const all = asArray(findings).filter(
    (item) =>
      (item.path === path || item.path?.startsWith(`${path}.`)) && item.code !== "review.required",
  );
  const routine =
    all.find((item) => item.code === "schedule.missing" || item.path === `${path}.schedules`) ??
    null;
  const notices = all.filter(
    (item) =>
      item.code !== "schedule.missing" &&
      !item.path?.includes(".schedules") &&
      !settledByApply.has(item.code),
  );
  return { all, routine, notices };
}

/** A finding in the plan's issues list, labelled by what the operator should do with it. */
export type PlanIssue = {
  finding: RecipeFinding;
  label: "Coach should update prompts" | "Needs a decision" | "Optional";
  blocking: boolean;
};

/**
 * The findings no card shows: every `access.*` finding, and errors and warnings outside role paths
 * except `machine.*` ones, which the machine picker shows.
 * The list is titled "System issues" when one is an error, "Notes" otherwise; null when empty.
 */
export function planIssues(findings: readonly RecipeFinding[] | null | undefined): {
  title: "System issues" | "Notes";
  items: PlanIssue[];
} | null {
  const unhandled = asArray(findings).filter((item) => {
    if (item.code === "review.required") return false;
    if (String(item.code || "").startsWith("machine.")) return false;
    if (String(item.code || "").startsWith("access.")) return true;
    if (item.path?.startsWith("roles.")) return false;
    return item.severity === "error" || item.severity === "warning";
  });
  if (!unhandled.length) return null;
  const items = unhandled.map((finding): PlanIssue => {
    const blocking = finding.severity === "error";
    const label = String(finding.code || "").startsWith("access.")
      ? "Coach should update prompts"
      : blocking
        ? "Needs a decision"
        : "Optional";
    return { finding, label, blocking };
  });
  return { title: items.some((item) => item.blocking) ? "System issues" : "Notes", items };
}

/** The size badge of a prompt: "<n> chars" of its trimmed text, or "empty". */
export function promptBadge(text: string | null | undefined): string {
  const chars = String(text || "").trim().length;
  return chars ? `${chars} chars` : "empty";
}

/** The connectors a role uses. */
export function agentConnectors(
  plan: Pick<RecipePlan, "connections">,
  role: string,
): ConnectionDraft[] {
  return plan.connections.filter((item) => roleUsesConnection(item, role));
}

/** The three metric pills of an agent: connectors, routines, and tools. */
export type AgentMetrics = {
  connectors: {
    count: number;
    label: string;
    empty: boolean;
    entries: Array<{ server: string; detail: string }>;
  };
  routines: {
    count: number;
    label: string;
    empty: boolean;
    warning: string | null;
    entries: Array<{ key: string; cadence: string; description: string }>;
  };
  tools: {
    count: number;
    label: string;
    empty: boolean;
    nativeTools: string[];
  };
};

/** An agent's metric pills from its connectors and its routine advice. */
export function agentMetrics(
  agent: PlanAgent,
  connectors: readonly ConnectionDraft[],
  routineFinding: RecipeFinding | null,
): AgentMetrics {
  const toolCount = agent.nativeTools.length;
  return {
    connectors: {
      count: connectors.length,
      label: plural(connectors.length, "connector"),
      empty: connectors.length === 0,
      entries: connectors.map((item) => {
        const tools = connectionTools(item, agent.role);
        const toolText = tools.length ? ` · tools: ${tools.join(", ")}` : "";
        return {
          server: item.server ?? "",
          detail: `${[item.auth || "oauth", item.recommended_scope || "guild"].join(" · ")}${toolText}`,
        };
      }),
    },
    routines: {
      count: agent.routines.length,
      label: plural(agent.routines.length, "routine"),
      empty: agent.routines.length === 0,
      warning: routineFinding ? routineFinding.message : null,
      entries: agent.routines.map((item) => ({
        key: item.key,
        cadence: scheduleCadence(item),
        description: item.description,
      })),
    },
    tools: {
      count: toolCount,
      label: plural(toolCount, "tool"),
      empty: toolCount === 0,
      nativeTools: agent.nativeTools,
    },
  };
}

/** A routine as a row or a card line shows it. */
export type RoutineView = {
  role: string;
  key: string;
  cron: string | null;
  cadence: string;
  description: string;
  status: "from design" | "paused at create";
  reviewer: string | null;
};

/** A routine's row: its cadence in words, its cron, its description (or instruction), and how apply creates it. */
export function routineView(item: PlanRoutine): RoutineView {
  return {
    role: item.role,
    key: item.key,
    cron: item.cron || null,
    cadence: scheduleCadence(item),
    description: (item.description || item.instruction || "").trim(),
    status: item.source === "design" ? "from design" : "paused at create",
    reviewer: reviewLabel(item.author),
  };
}

/** The operator steps on an agent's card: its browser login with notes, and cards for other operator systems. */
export type OperatorActions = {
  browser: { instructions: string; reviewer: string | null; notes: string[] } | null;
  cards: Array<{ title: string | null; text: string }>;
};

/**
 * The operator steps on an agent's card. A browser agent gets a login step whose notes are its
 * non-script operator systems, and a card only for script systems; other agents get a card for
 * each operator system. Null when there is nothing to do.
 */
export function operatorActions(
  agent: PlanAgent,
  plan: Pick<RecipePlan, "agents" | "browserSites" | "systems">,
): OperatorActions | null {
  const extras = operatorSystemsForRole(plan, agent.role);
  const browser = agent.browser
    ? {
        instructions:
          agent.browserInstructions ||
          "Take control of this agent's browser and log into the intended account.",
        reviewer: reviewLabel(agent.browserAuthor),
        notes: extras
          .filter((system) => !isScriptSystem(system))
          .map((system) => systemReason(system) || system.name || "")
          .filter(Boolean),
      }
    : null;
  const cards = extras
    .filter((system) => !agent.browser || isScriptSystem(system))
    .map((system) => ({
      title: system.name || null,
      text: systemReason(system) || "This agent needs an operator step before it can do this work.",
    }));
  return browser || cards.length ? { browser, cards } : null;
}

/** Something an agent can do beyond chat, as its card lists it. */
export type AgentCapability = {
  id: "browser" | "coding";
  label: string;
  /** The lines shown on hover: the browser login step and its notes, or which harness runs the code. */
  hint: string[];
  reviewer: string | null;
  /** True while apply still has to ask for something before the capability works. */
  pending: boolean;
};

/** An agent's capabilities: its browser with the login step apply needs, and its coding harness. */
export function agentCapabilities(
  agent: PlanAgent,
  operator: OperatorActions | null,
): AgentCapability[] {
  const capabilities: AgentCapability[] = [];
  if (operator?.browser) {
    capabilities.push({
      id: "browser",
      label: "Browser",
      hint: [operator.browser.instructions, ...operator.browser.notes],
      reviewer: operator.browser.reviewer,
      pending: false,
    });
  }
  if (agent.coding) {
    const name = agent.harness ? harnessLabel(agent.harness) : null;
    capabilities.push({
      id: "coding",
      label: name ? `Coding · ${name}` : "Coding · no harness yet",
      hint: [name ? `Code tasks run on ${name}.` : "Apply asks for the harness."],
      reviewer: null,
      pending: !name,
    });
  }
  return capabilities;
}

/** Everything an agent's card shows besides the agent itself. */
export type AgentCard = {
  connectors: ConnectionDraft[];
  findings: RoleFindings;
  metrics: AgentMetrics;
  capabilities: AgentCapability[];
  prompt: { text: string; badge: string; reviewer: string | null };
  routines: RoutineView[];
  operator: OperatorActions | null;
  scripts: Array<{ name: string; source: string; reviewer: string | null }>;
};

/** An agent's card: its connectors, findings, metric pills, capabilities, standing prompt, routines, operator steps, and scripts. */
export function agentCard(
  agent: PlanAgent,
  plan: RecipePlan,
  findings: readonly RecipeFinding[] | null | undefined,
): AgentCard {
  const connectors = agentConnectors(plan, agent.role);
  const attached = roleFindings(findings, agent.role);
  const text = String(agent.task || "").trim();
  const operator = operatorActions(agent, plan);
  return {
    connectors,
    findings: attached,
    metrics: agentMetrics(agent, connectors, attached.routine),
    capabilities: agentCapabilities(agent, operator),
    prompt: { text, badge: promptBadge(text), reviewer: reviewLabel(agent.taskAuthor) },
    routines: agent.routines.map(routineView),
    operator,
    scripts: agent.scripts.map((script) => ({
      name: script.name ?? "",
      source: script.source || "",
      reviewer: reviewLabel(script.author),
    })),
  };
}

/** The per-role tool lists of a connector, and the line shown when no role has any. */
export type ConnectionToolGroups = {
  groups: Array<{ role: string; title: string; tools: Array<{ name: string; enabled: boolean }> }>;
  empty: string | null;
};

/** A connector's tools grouped by the roles that use it; the group title is the agent's name when several roles share it. */
export function connectionToolGroups(
  connection: ConnectionDraft,
  plan: Pick<RecipePlan, "agents">,
  catalog: readonly CatalogEntry[] | null | undefined,
  pending: PendingAccess | null = null,
): ConnectionToolGroups {
  const roles = plan.agents.filter((agent) => roleUsesConnection(connection, agent.role));
  const groups: ConnectionToolGroups["groups"] = [];
  for (const agent of roles) {
    const tools = toolsForConnectionRole(connection, agent.role, catalog, pending);
    if (!tools.length) continue;
    groups.push({
      role: agent.role,
      title: roles.length > 1 ? `${agent.name || agent.role}` : "Tools",
      tools,
    });
  }
  let empty: string | null = null;
  if (!groups.length) {
    empty = catalogToolNames(catalog, connection.server).length
      ? "No tools listed for assigned roles."
      : "Catalog tools will appear here once this connector is published.";
  }
  return { groups, empty };
}

/** A connector's card. */
export type ConnectionCard = {
  server: string;
  reused: boolean;
  chip: { label: "reuse login" | "org login" | "connect at apply"; tone: "ok" | "action" };
  snippet: string;
  description: string;
  meta: string;
  resources: string[];
  reviewer: string | null;
  tools: ConnectionToolGroups;
};

/**
 * A connector's card: whether apply reuses a live login, its setup or the roles using it (with
 * their tools), its auth and scope line, its resources, and its tools per role.
 */
export function connectionCard(
  connection: ConnectionDraft,
  plan: Pick<RecipePlan, "agents">,
  catalog: readonly CatalogEntry[] | null | undefined,
  pending: PendingAccess | null = null,
): ConnectionCard {
  const reused = Boolean(connection.action === "reuse" && connection.connection_id);
  const roleBits = plan.agents
    .filter((agent) => roleUsesConnection(connection, agent.role))
    .map((agent) => {
      const tools = connectionTools(connection, agent.role);
      const label = agent.name || agent.role;
      return tools.length ? `${label} (${tools.join(", ")})` : label;
    });
  const description = connection.setup || connection.hint || "";
  return {
    server: connection.server ?? "",
    reused,
    chip: {
      label: reused
        ? "reuse login"
        : connection.recommended_scope === "org"
          ? "org login"
          : "connect at apply",
      tone: reused ? "ok" : "action",
    },
    snippet: description || (roleBits.length ? `Used by: ${roleBits.join(", ")}` : ""),
    description,
    meta: [
      connection.auth || "oauth",
      connection.recommended_scope || "guild",
      roleBits.join(", ") || "all roles",
    ].join(" · "),
    resources: asArray(connection.resources).map((resource) => {
      const title = resource.title || resource.id || "Untitled";
      const kind = resource.kind || "table";
      return resource.use ? `${kind}: ${title} — ${resource.use}` : `${kind}: ${title}`;
    }),
    reviewer: reviewLabel(connection.author),
    tools: connectionToolGroups(connection, plan, catalog, pending),
  };
}

/** A secret's card: the name it is stored under and its description or scope. */
export function secretCard(secret: SecretDraft): { name: string; snippet: string } {
  return {
    name: secret.dest_name || secret.name || "",
    snippet: secret.description || secret.recommended_scope || "",
  };
}

/** A design system listed among the connectors. */
export type SystemCard = {
  system: SystemDraft;
  name: string;
  resolution: string;
  reason: string;
  server: string | null;
};

/**
 * The design systems listed among the connectors: those that are not open questions, not operator
 * steps shown on an agent card, and not catalog systems already covered by a recipe connector.
 */
export function systemCards(
  plan: Pick<RecipePlan, "agents" | "systems" | "connections">,
): SystemCard[] {
  return plan.systems
    .filter((system) => {
      if (isPendingQuestion(system)) return false;
      if (operatorSystemIsAttached(system, plan)) return false;
      return !(
        system.resolution === "catalog" &&
        system.server &&
        plan.connections.some((item) => item.server === system.server)
      );
    })
    .map((system) => ({
      system,
      name: system.name || system.server || "System",
      resolution: system.resolution || "decision",
      reason: system.reason || "",
      server: system.server || null,
    }));
}

/** The connectors section: its count (connectors and secrets), its listed systems, and whether it has nothing to list. */
export function accessSection(plan: RecipePlan): {
  count: number;
  systems: SystemCard[];
  empty: boolean;
} {
  const systems = systemCards(plan);
  return {
    count: plan.connections.length + plan.secrets.length,
    systems,
    empty: !plan.connections.length && !plan.secrets.length && !systems.length,
  };
}

/** A collection's card. */
export type CollectionView = {
  chip: { label: string; tone: "action" | "ok" | "warn" } | null;
  access: string;
  snippet: string;
  meta: string;
  conflict: { headline: string; differences: string[] } | null;
  reuses: boolean;
  columns: Array<PlanColumn & { typeLabel: string; rules: string[] }>;
};

/** The apply decision chip of a collection; null when there is no decision. */
export function collectionActionChip(item: PlanCollection): CollectionView["chip"] {
  if (item.action === "create") {
    return { label: item.scope === "guild" ? "new guild table" : "new table", tone: "action" };
  }
  if (item.action === "reuse") return { label: "reuses existing table", tone: "ok" };
  if (item.action === "conflict") return { label: "conflict", tone: "warn" };
  return null;
}

/** The roles that write on top of the guild's mode, as a label suffix; "" when there are none. */
function writersSuffix(writers: readonly string[]): string {
  return writers.length ? ` · writers: ${writers.map((role) => `@${role}`).join(", ")}` : "";
}

/** Who reaches a collection: the guild's own table, or the guild's mode on an organisation table with its writers. */
export function collectionAccessLabel(item: PlanCollection): string {
  if (item.scope === "guild") return "the guild's own";
  return `guild ${item.guild}${writersSuffix(item.writers)}`;
}

/** The guild's mode a note's level gives when the recipe names none. */
const NOTE_GUILD_DEFAULT: Record<string, string> = { org: "read", guild: "write" };

/** The guild's mode on a note: the recipe's, or what the note's level gives. */
function noteGuildMode(item: NoteDraft): string | undefined {
  return item.guild || NOTE_GUILD_DEFAULT[item.level || "guild"];
}

/** Who reaches a note: the guild's mode, or its role alone, with the roles that write on top. */
export function noteAccessLabel(item: NoteDraft): string {
  const guild = noteGuildMode(item);
  const writers = writersSuffix(asArray(item.writers).map((role) => String(role)));
  if (guild) return `guild ${guild}${writers}`;
  return `@${item.role || "agent"}${writers || " only"}`;
}

/** A column's type, followed by its closed values when it has them. */
export function columnTypeLabel(column: PlanColumn): string {
  return column.values.length ? `${column.type}: ${column.values.join(" | ")}` : column.type;
}

/** A collection's card: decision chip, access, purpose, access sentence, conflict details, and columns. */
export function collectionView(item: PlanCollection): CollectionView {
  const writers = item.writers.length
    ? `Agent rows at write: ${item.writers.map((role) => `@${role}`).join(", ")}`
    : "No agent rows";
  return {
    chip: collectionActionChip(item),
    access: collectionAccessLabel(item),
    snippet: item.purpose || "Typed table",
    meta:
      item.scope === "guild"
        ? "The guild's table · every agent in the guild reads and writes it"
        : `Organisation table · every agent in the guild gets ${item.guild} · ${writers}`,
    conflict:
      item.action === "conflict"
        ? {
            headline:
              item.scope === "guild"
                ? `The organisation already has a table named ${item.name}.`
                : `A table named ${item.name} already exists with different columns.`,
            differences: item.differences,
          }
        : null,
    reuses: item.action === "reuse",
    columns: item.columns.map((column) => ({
      ...column,
      typeLabel: columnTypeLabel(column),
      rules: [column.required ? "required" : "", column.unique ? "unique" : ""].filter(Boolean),
    })),
  };
}

/** A note's title: its key or id, or "note". */
export function noteTitle(item: NoteDraft | null | undefined): string {
  return String(item?.key || item?.id || "note").trim() || "note";
}

/** A note's first non-blank line without heading marks, cut to 88 characters; "Empty note" when blank. */
export function noteSnippet(body: string | null | undefined): string {
  const text = String(body || "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!text) return "Empty note";
  const first = text.split("\n").find((line) => line.trim()) || text;
  const cleaned = first.replace(/^#+\s*/, "").trim();
  return cleaned.length > 88 ? `${cleaned.slice(0, 85)}…` : cleaned;
}

/** A note's card: title, owner, who reaches it, snippet, where apply writes it, and its body. */
export function noteCard(item: NoteDraft): {
  title: string;
  owner: string;
  access: string;
  snippet: string;
  destination: string;
  body: string;
} {
  const title = noteTitle(item);
  const body = String(item.body || "");
  const dest = item.key || title;
  return {
    title,
    owner: item.role ? `${item.level || "agent"} · ${item.role}` : item.level || "guild",
    access: noteAccessLabel(item),
    snippet: noteSnippet(body),
    destination:
      item.level === "agent" && item.role
        ? `agent/${item.role}/${dest}`
        : `${item.level || "guild"}/${dest}`,
    body,
  };
}

/** An external setup card: its title (or kind) and setup text. */
export function externalCard(card: ExternalDraft): { title: string; setup: string } {
  return { title: card.title || card.kind || "", setup: card.setup || "" };
}

/** One end of a handoff: the agent when the role is in the plan. */
export type HandoffActor = { role: string; name: string; agent: PlanAgent | null };
/** How work passes along a handoff: a collection queue or a tagged message with its budget. */
export type HandoffVia = { kind: "collection" | "tagged"; label: string };
/** A handoff between two roles, with every way work passes between them. */
export type HandoffRow = { from: HandoffActor; to: HandoffActor; vias: HandoffVia[] };

function handoffActor(
  plan: Pick<RecipePlan, "agents">,
  roleId: string | null | undefined,
): HandoffActor {
  const agent = plan.agents.find((item) => item.role === roleId);
  if (agent) return { role: agent.role, name: agent.name || agent.role, agent };
  return { role: roleId ?? "", name: roleId ?? "", agent: null };
}

function handoffVia(item: HandoffDraft): HandoffVia {
  if (item.kind === "collection") {
    return { kind: "collection", label: item.collection || "table" };
  }
  return { kind: "tagged", label: `tagged${item.budget ? ` · ${item.budget}` : ""}` };
}

/**
 * The handoff chart: one row per from/to pair in first-seen order with every way work passes, and
 * the roles taking part in first-seen order.
 */
export function handoffChart(plan: Pick<RecipePlan, "agents" | "handoffs">): {
  nodes: HandoffActor[];
  rows: HandoffRow[];
} {
  const groups: Array<{
    from: string | null | undefined;
    to: string | null | undefined;
    vias: HandoffVia[];
  }> = [];
  const index = new Map<string, (typeof groups)[number]>();
  for (const item of plan.handoffs) {
    const key = `${item.from}\0${item.to}`;
    let group = index.get(key);
    if (!group) {
      group = { from: item.from, to: item.to, vias: [] };
      index.set(key, group);
      groups.push(group);
    }
    group.vias.push(handoffVia(item));
  }
  const seen = new Set<string | null | undefined>();
  const nodes: HandoffActor[] = [];
  for (const group of groups) {
    for (const role of [group.from, group.to]) {
      if (seen.has(role)) continue;
      seen.add(role);
      nodes.push(handoffActor(plan, role));
    }
  }
  const rows = groups.map((group) => ({
    from: handoffActor(plan, group.from),
    to: handoffActor(plan, group.to),
    vias: group.vias,
  }));
  return { nodes, rows };
}
