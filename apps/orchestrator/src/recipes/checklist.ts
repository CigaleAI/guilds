import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { writeBinding } from "../access/bindings.js";
import { loadAccessView } from "../access/view.js";
import { getMcpServerBySlug } from "../connectors/servers.js";
import { listBindingsCovering } from "../db/bindings.js";
import { listGuildRepositories } from "../db/guilds.js";
import { listMcpTools } from "../db/mcp.js";
import { getMembership } from "../db/orgs.js";
import { getRecipe } from "../db/recipes.js";
import { setApplyChecklist, type RecipeApplyRow } from "../db/recipe-applies.js";
import type { ApplyPlan, ApplyStep, ApplyWarning, PlannedAgent } from "../db/schema/index.js";
import { getSecretByName, listAgentSecrets, setSecretAccess } from "../db/secrets.js";
import type { UserRow } from "../db/users.js";
import { GITHUB_SLUG } from "../github/index.js";
import { type ChangeActor, userActor } from "../lib/change-actor.js";
import { newId } from "../lib/ids.js";
import { mcpDatabase } from "../mcp/index.js";
import { accessOf, managesOrgSecrets } from "../secrets/access.js";
import type { RecipeApply } from "./apply.js";
import { RecipeError } from "./errors.js";
import { prepareRecipeForApply, roleBrowses } from "./prepare.js";
import { parseRecipe, type RecipeConnection, type RecipeDocument, type RecipeRole } from "./schema.js";

// An apply's checklist: the steps its skeleton leaves open, the server's checks of the steps it
// verifies, and the operator's confirmations and skips of the rest.

export function browserLoginSetup(role: RecipeRole, site?: string): string {
  const written = role.browser.instructions.trim();
  if (written) return written;
  const target = site || "the site";
  return `This role has no native connector. After apply, open the agent and take control of its Chromium to log into ${target}. Session cookies stay in the browser profile. Mark the reminder as done once you have — we cannot tell when you are finished.`;
}

/** What connecting GitHub takes for a recipe's repositories, beside whatever its GitHub connection says. */
const REPOSITORIES_GITHUB_SETUP =
  "Install the GitHub App on the account that owns the repositories (once per account; later logins reuse that install), so the coding agents clone, push, and open pull requests. Public repositories clone without it; pushing to them still needs it. On the GitHub card in Tools, pick this guild's or agent's repositories. In the guild's Settings, set Commit author email to a verified email on the GitHub account that owns any deploy project (Vercel, etc.).";

function connectionSteps(plan: ApplyPlan): ApplyStep[] {
  return plan.connections.flatMap((connection): ApplyStep[] => {
    const bound = connection.bound === true || (connection.action === "reuse" && Boolean(connection.connection_id));
    const status = bound ? "verified" : "open";
    return [
      {
        id: `conn:${connection.server}`,
        kind: "connection",
        title: `Connect ${connection.server}`,
        setup: connection.setup,
        closure: "verified",
        status,
      },
      {
        id: `overlays:${connection.server}`,
        kind: "overlays",
        title: `Tool overlays for ${connection.server}`,
        closure: "verified",
        status,
      },
    ];
  });
}

/** The GitHub connection the recipe's repositories need, joined to the recipe's own GitHub step when it has one. */
function addRepositorySteps(steps: ApplyStep[], recipe: RecipeDocument): void {
  if (!recipe.repositories.length) {
    return;
  }
  const github = steps.find((step) => step.id === `conn:${GITHUB_SLUG}`);
  if (github) {
    github.setup = [github.setup, REPOSITORIES_GITHUB_SETUP].filter(Boolean).join(" ");
  } else {
    steps.push({
      id: `conn:${GITHUB_SLUG}`,
      kind: "connection",
      title: "Connect GitHub",
      setup: REPOSITORIES_GITHUB_SETUP,
      closure: "verified",
      status: "open",
    });
  }
  for (const repository of recipe.repositories) {
    steps.push({
      id: `repo:${repository.name}`,
      kind: "repository",
      title: `Add the ${repository.name} repository`,
      setup: `${repository.purpose ? `${repository.purpose} ` : ""}Add it in the guild's Settings under Repositories, named ${repository.name}.`,
      closure: "verified",
      status: "open",
    });
  }
}

function browserSteps(recipe: RecipeDocument): ApplyStep[] {
  return recipe.roles.filter(roleBrowses).map((role) => {
    const site = recipe.design.browser.find((item) => item.role === role.role)?.site;
    return {
      id: `browser:${role.role}`,
      kind: "browser",
      title: `Take control and log into ${site || "the web page"}`,
      setup: browserLoginSetup(role, site),
      site: site || "",
      role: role.role,
      deferrable: true,
      phase: "post_apply",
      closure: "confirmed",
      status: "open",
    };
  });
}

export function checklistFromPlan(recipe: RecipeDocument, plan: ApplyPlan): ApplyStep[] {
  const steps = connectionSteps(plan);
  addRepositorySteps(steps, recipe);
  for (const secret of plan.secrets) {
    if (secret.action === "skip") continue;
    steps.push({
      id: `secret:${secret.name}`,
      kind: "secret",
      title: `Secret ${secret.dest_name}`,
      closure: "verified",
      status: "open",
    });
  }
  steps.push(...browserSteps(recipe));
  for (const [index, card] of recipe.external.entries()) {
    steps.push({
      id: `external:${index}`,
      kind: "external",
      title: card.title,
      setup: card.setup,
      closure: "confirmed",
      status: "open",
    });
  }
  steps.push({ id: "activate", kind: "activate", title: "Activate paused routines", closure: "confirmed", status: "open" });
  return steps;
}

export function isSkippableApplyStep(step: ApplyStep): boolean {
  if (step.status !== "open") return false;
  return step.kind === "connection" || step.kind === "secret" || step.kind === "overlays" || step.kind === "repository";
}

export function blockingApplySteps(checklist: ApplyStep[]): ApplyStep[] {
  return checklist.filter((item) => item.status === "open" && item.kind !== "browser" && item.kind !== "activate");
}

function closeAsSkipped(step: ApplyStep, now: Date): void {
  step.status = "skipped";
  step.resolution = "skipped";
  step.closed_at = now.toISOString();
}

export function skipApplyChecklistStep(
  checklist: ApplyStep[],
  stepId: string,
  now = new Date(),
): { checklist: ApplyStep[]; warning: ApplyWarning } {
  const next = checklist.map((item) => ({ ...item }));
  const step = next.find((item) => item.id === stepId);
  if (!step) {
    throw new RecipeError("step not found", 404);
  }
  if (!isSkippableApplyStep(step)) {
    throw new RecipeError("this step cannot be skipped");
  }
  closeAsSkipped(step, now);
  if (step.kind === "connection") {
    const overlays = next.find((item) => item.id === `overlays:${step.id.slice("conn:".length)}`);
    if (overlays && overlays.status === "open") {
      closeAsSkipped(overlays, now);
    }
  }
  return {
    checklist: next,
    warning: {
      code: "step.skipped",
      path: step.id,
      message: `Skipped ${step.title || step.id}. Agents will not have this access until you connect it later from Tools.`,
    },
  };
}

/** Agents a ready apply still asks to log in by hand (`resolution: later` after activate). */
export function browserLoginAgentIds(apply: Pick<RecipeApplyRow, "status" | "plan" | "checklist"> | null): string[] {
  if (!apply || apply.status !== "ready") return [];
  const roles = new Set(
    apply.checklist.filter((item) => item.kind === "browser" && item.resolution === "later").map((item) => item.role ?? ""),
  );
  return apply.plan.names.flatMap((item) => (item.agent_id && roles.has(item.role) ? [item.agent_id] : []));
}

/** The checklist with the browser logins left for later and the routines activated. */
export function deferLaunchSteps(checklist: ApplyStep[], now = new Date()): ApplyStep[] {
  return checklist.map((item): ApplyStep => {
    if (item.kind === "browser" && item.status === "open") {
      return { ...item, status: "confirmed", resolution: "later", closed_at: now.toISOString() };
    }
    if (item.kind === "activate" && item.status === "open") {
      return { ...item, status: "confirmed", resolution: "activated", closed_at: now.toISOString() };
    }
    return { ...item };
  });
}

/** The guild an apply fills. */
export function applyGuild(apply: Pick<RecipeApplyRow, "id" | "guild_id">): string {
  if (!apply.guild_id) {
    throw new RecipeError(`apply ${apply.id} has no guild`);
  }
  return apply.guild_id;
}

/** The recipe of an apply, settled as apply created it. */
export async function appliedRecipe(apply: RecipeApply, recipeId: string): Promise<RecipeDocument> {
  return prepareRecipeForApply(parseRecipe((await getRecipe(apply.db, recipeId))?.body));
}

/** Where overlays are bound: the apply's recipe and guild, and the agents its roles became. */
export type OverlayTarget = Pick<RecipeApplyRow, "recipe_id" | "org_id"> & { guild_id: string; names: PlannedAgent[] };

/** Whether every role is enabled on the connection with the same tools, so one guild binding covers them. */
function bindsAtGuild(connection: RecipeConnection, recipe: RecipeDocument): boolean {
  const specs = recipe.roles.map((role) => connection.roles[role.role]);
  const first = JSON.stringify(specs[0]?.tools ?? {});
  return (
    connection.recommended_scope !== "agent" &&
    specs.length > 0 &&
    specs.every((spec) => spec?.enabled === true && JSON.stringify(spec.tools ?? {}) === first)
  );
}

type OverlayBinding = {
  serverId: string;
  connectionId: string;
  scope: "guild" | "agent";
  scopeId: string;
  spec: { enabled: boolean; tools: Record<string, boolean> };
};

/** Binds the server and its listed tools at one scope, as the recipe's role spec sets them. */
async function bindOverlay(apply: RecipeApply, binding: OverlayBinding, known: Set<string>, actor: ChangeActor): Promise<void> {
  const now = new Date();
  const { scope, scopeId, connectionId } = binding;
  await writeBinding(
    apply.db,
    { bindingId: newId("bind"), catalogKind: "mcp", catalogId: binding.serverId, scope, scopeId, enabled: binding.spec.enabled, connectionId },
    now,
    actor,
  );
  for (const [tool, enabled] of Object.entries(binding.spec.tools)) {
    if (!known.has(tool)) {
      continue;
    }
    await writeBinding(
      apply.db,
      { bindingId: newId("bind"), catalogKind: "mcp_tool", catalogId: tool, scope, scopeId, enabled, connectionId: null },
      now,
      actor,
    );
  }
}

/**
 * Binds the recipe's tool overlays for `server` on the connection: at the guild when every role
 * takes the same tools, else on each enabled role's agent.
 */
export async function writeOverlays(
  apply: RecipeApply,
  target: OverlayTarget,
  connection: { server: string; connectionId: string },
  actor: ChangeActor,
): Promise<void> {
  const recipe = await appliedRecipe(apply, target.recipe_id);
  const wanted = recipe.connections.find((item) => item.server === connection.server);
  const server = wanted ? await getMcpServerBySlug(apply.db, connection.server, target.org_id) : null;
  if (!wanted || !server) return;
  const listed = await listMcpTools(apply.db, connection.connectionId);
  const known = new Set(listed.map((row) => row.namespaced_name));
  const base = { serverId: server.id, connectionId: connection.connectionId };
  const enabled = recipe.roles.flatMap((role) => {
    const spec = wanted.roles[role.role];
    return spec?.enabled ? [{ role: role.role, spec }] : [];
  });
  if (bindsAtGuild(wanted, recipe)) {
    const spec = enabled[0]?.spec;
    if (spec) await bindOverlay(apply, { ...base, scope: "guild", scopeId: target.guild_id, spec }, known, actor);
    return;
  }
  for (const item of enabled) {
    const agentId = target.names.find((row) => row.role === item.role)?.agent_id;
    if (agentId) await bindOverlay(apply, { ...base, scope: "agent", scopeId: agentId, spec: item.spec }, known, actor);
  }
}

type StepCheck = { ok: true } | { ok: false; reason: string };

const PASSED: StepCheck = { ok: true };

/** The guild's servers as the access view lists them: each one's slug, status, and connection. */
const AccessServers = Type.Array(
  Type.Object({ slug: Type.Unknown(), status: Type.Unknown(), connection_id: Type.Optional(Type.Unknown()) }),
);

/** The connection the guild reaches `slug` through, when it is connected. */
async function guildConnection(apply: RecipeApply, row: RecipeApplyRow, slug: string): Promise<string | null> {
  const access = await loadAccessView(mcpDatabase(apply.db), {
    orgId: row.org_id,
    guildId: applyGuild(row),
    viewScope: "guild",
  });
  const servers = Value.Check(AccessServers, access.mcp) ? access.mcp : [];
  const mcp = servers.find((item) => item.slug === slug);
  if (mcp?.status !== "connected") {
    return null;
  }
  return typeof mcp.connection_id === "string" ? mcp.connection_id : "";
}

/** A connection step passes once the guild reaches the server; its overlays are then bound and their step closes. */
async function checkConnection(apply: RecipeApply, row: RecipeApplyRow, step: ApplyStep, actor: ChangeActor): Promise<StepCheck> {
  const slug = step.id.slice("conn:".length);
  const connectionId = await guildConnection(apply, row, slug);
  if (connectionId === null) {
    return { ok: false, reason: `${slug} is not connected yet. Connect it on this step, then check it.` };
  }
  if (connectionId) {
    const target = { ...row, guild_id: applyGuild(row), names: row.plan.names };
    await writeOverlays(apply, target, { server: slug, connectionId }, actor);
    const overlays = row.checklist.find((item) => item.id === `overlays:${slug}`);
    if (overlays && overlays.status === "open") {
      overlays.status = "verified";
      overlays.closed_at = new Date().toISOString();
    }
  }
  return PASSED;
}

async function checkRepository(apply: RecipeApply, row: RecipeApplyRow, step: ApplyStep): Promise<StepCheck> {
  const name = step.id.slice("repo:".length);
  const listed = await listGuildRepositories(apply.db, applyGuild(row));
  return listed.some((item) => item.name === name)
    ? PASSED
    : { ok: false, reason: `The guild has no repository named ${name} yet. Add it in the guild's Settings, then check it.` };
}

/** Planned roles (the secret's roles, or every role) whose agent does not get the secret. */
async function rolesWithoutSecret(apply: RecipeApply, row: RecipeApplyRow, secret: { name: string; roles: string[] }): Promise<string[]> {
  const missing: string[] = [];
  for (const item of row.plan.names) {
    if (secret.roles.length && !secret.roles.includes(item.role)) continue;
    if (!item.agent_id) continue;
    const environment = await listAgentSecrets(apply.db, { orgId: row.org_id, guildId: applyGuild(row), agentId: item.agent_id });
    if (!environment.some((entry) => entry.name === secret.name)) {
      missing.push(item.name || item.role);
    }
  }
  return missing;
}

async function checkSecret(apply: RecipeApply, row: RecipeApplyRow, step: ApplyStep): Promise<StepCheck> {
  const recipeName = step.id.slice("secret:".length);
  const planned = row.plan.secrets.find((item) => item.name === recipeName);
  const name = planned?.dest_name ?? recipeName;
  const missing = await rolesWithoutSecret(apply, row, { name, roles: planned?.roles ?? [] });
  return missing.length
    ? { ok: false, reason: `Secret ${name} does not reach ${missing.join(", ")} yet. Add or grant it under Secrets, then check this step.` }
    : PASSED;
}

async function checkOverlays(apply: RecipeApply, row: RecipeApplyRow, step: ApplyStep): Promise<StepCheck> {
  const slug = step.id.slice("overlays:".length);
  const server = await getMcpServerBySlug(apply.db, slug, row.org_id);
  if (!server) {
    return { ok: false, reason: `${slug} is not in the catalog.` };
  }
  const bindings = await listBindingsCovering(apply.db, { orgId: row.org_id, guildId: applyGuild(row) });
  const bound = bindings.some(
    (item) => item.catalog_kind === "mcp" && item.catalog_id === server.id && (item.scope === "guild" || item.scope === "agent"),
  );
  return bound ? PASSED : { ok: false, reason: `${slug} tools are not bound yet. Connect ${slug} on the Connect step first.` };
}

/** The server's check of a verified step. */
async function checkStep(apply: RecipeApply, row: RecipeApplyRow, step: ApplyStep, actor: ChangeActor): Promise<StepCheck> {
  switch (step.kind) {
    case "connection":
      return checkConnection(apply, row, step, actor);
    case "repository":
      return checkRepository(apply, row, step);
    case "secret":
      return checkSecret(apply, row, step);
    case "overlays":
      return checkOverlays(apply, row, step);
    default:
      return { ok: false, reason: "this step cannot be checked yet" };
  }
}

/** Writes the apply's checklist and warnings, returning the apply as written. */
async function saveChecklist(
  apply: RecipeApply,
  row: RecipeApplyRow,
  progress: { checklist: ApplyStep[]; warnings?: ApplyWarning[] },
): Promise<RecipeApplyRow> {
  const saved = await setApplyChecklist(
    apply.db,
    row.id,
    { checklist: progress.checklist, warnings: progress.warnings ?? row.warnings },
    new Date(),
  );
  if (!saved) {
    throw new RecipeError("apply not found", 404);
  }
  return saved;
}

function closeStep(step: ApplyStep, status: "verified" | "confirmed"): void {
  step.status = status;
  step.closed_at = new Date().toISOString();
}

/** Closes a verified step once the server's check of it passes. */
export async function verifyStep(
  apply: RecipeApply,
  row: RecipeApplyRow,
  stepId: string,
  actor: ChangeActor,
): Promise<RecipeApplyRow> {
  const working = { ...row, checklist: row.checklist.map((item) => ({ ...item })) };
  const step = working.checklist.find((item) => item.id === stepId);
  if (!step) {
    throw new RecipeError("step not found", 404);
  }
  if (step.closure !== "verified") {
    throw new RecipeError("step is attestation-only");
  }
  const checked = await checkStep(apply, working, step, actor);
  if (!checked.ok) {
    throw new RecipeError(checked.reason);
  }
  closeStep(step, "verified");
  return saveChecklist(apply, row, { checklist: working.checklist });
}

/** How the operator closes a confirmed step: done, or, for a browser login, left for later. */
export type StepConfirmation = { later: boolean };

/** Closes a confirmed step on the operator's word. */
export async function confirmStep(
  apply: RecipeApply,
  row: RecipeApplyRow,
  stepId: string,
  confirmation: StepConfirmation,
): Promise<RecipeApplyRow> {
  const checklist = row.checklist.map((item) => ({ ...item }));
  const step = checklist.find((item) => item.id === stepId);
  if (!step) {
    throw new RecipeError("step not found", 404);
  }
  if (step.closure !== "confirmed") {
    throw new RecipeError("step must be verified by the server");
  }
  closeStep(step, "confirmed");
  if (step.kind === "browser") {
    step.resolution = confirmation.later ? "later" : "done";
  }
  return saveChecklist(apply, row, { checklist });
}

/** Skips a step the apply can go on without, warning that its access waits. */
export async function skipStep(apply: RecipeApply, row: RecipeApplyRow, stepId: string): Promise<RecipeApplyRow> {
  const skipped = skipApplyChecklistStep(row.checklist, stepId);
  return saveChecklist(apply, row, { checklist: skipped.checklist, warnings: [...row.warnings, skipped.warning] });
}

/** Grants the new guild each reused secret that does not reach it yet. */
async function grantSecretsToGuild(apply: RecipeApply, row: RecipeApplyRow): Promise<void> {
  const guildId = applyGuild(row);
  for (const secret of row.plan.secrets) {
    if (secret.action !== "reuse") continue;
    const stored = await getSecretByName(apply.db, row.org_id, secret.dest_name || secret.name);
    if (!stored || stored.org_wide) continue;
    const access = accessOf(stored);
    if (access.guild_ids.includes(guildId)) continue;
    await setSecretAccess(apply.db, stored.id, { ...access, guild_ids: [...access.guild_ids, guildId] }, new Date());
  }
}

/**
 * Reused secrets that do not reach the new guild are granted to it when the applying
 * user is an org owner or admin; secret steps that now pass close.
 */
export async function grantReusedSecrets(apply: RecipeApply, row: RecipeApplyRow, user: UserRow): Promise<RecipeApplyRow> {
  const membership = await getMembership(apply.db, row.org_id, user.id);
  if (membership && managesOrgSecrets(membership.role)) {
    await grantSecretsToGuild(apply, row);
  }
  const working = { ...row, checklist: row.checklist.map((item) => ({ ...item })) };
  let closed = false;
  for (const step of working.checklist) {
    if (step.kind !== "secret" || step.status !== "open") continue;
    if ((await checkStep(apply, working, step, userActor(user))).ok) {
      closeStep(step, "verified");
      closed = true;
    }
  }
  return closed ? saveChecklist(apply, row, { checklist: working.checklist }) : row;
}
