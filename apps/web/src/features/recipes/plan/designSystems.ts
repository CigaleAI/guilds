import { asArray, asObject, recipeBody, reviewLabel, type SystemDraft } from "./recipeDraft";
import type { RecipePlan } from "./planModel";
import type { PlanAgent } from "./planAgents";

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
