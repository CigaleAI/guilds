import type { ApplyCreates, ApplyRow, ApplyStep, McpServerAccess } from "../../api/types";

/**
 * The apply checklist as the page shows it: which steps an operator works through, how far along
 * it is, and what each step says and needs.
 */

/** Steps the checklist lists; browser logins happen on the live agent and tool overlays close with their login. */
export function checklistSteps(checklist: readonly ApplyStep[]): ApplyStep[] {
  return checklist.filter((step) => step.kind !== "browser" && step.kind !== "overlays");
}

export const stepClosed = (step: Pick<ApplyStep, "status">) => step.status !== "open";

/** Done and total, counting the two milestones already reached: recipe validated, guild created. */
export function checklistProgress(checklist: readonly ApplyStep[]): {
  done: number;
  total: number;
} {
  const steps = checklistSteps(checklist);
  return { done: 2 + steps.filter(stepClosed).length, total: 2 + steps.length };
}

/** True while a step other than activation is still open. */
export function workOpen(checklist: readonly ApplyStep[]): boolean {
  return checklistSteps(checklist).some((step) => step.kind !== "activate" && !stepClosed(step));
}

/** The connector a login step is for. */
export function stepServer(step: Pick<ApplyStep, "id" | "kind">): string | null {
  return step.kind === "connection" && step.id.startsWith("conn:") ? step.id.slice(5) : null;
}

/** The guild's view of a login step's connector, and whether the guild is signed in to it. */
export function stepConnector(
  step: Pick<ApplyStep, "id" | "kind">,
  servers: readonly McpServerAccess[] | undefined,
): { server: McpServerAccess | null; connected: boolean } {
  const slug = stepServer(step);
  const server = slug ? (servers?.find((item) => item.slug === slug) ?? null) : null;
  return { server, connected: server?.status === "connected" };
}

/** What a step asks for. */
export function stepDetail(step: Pick<ApplyStep, "kind" | "setup">): string {
  if (step.setup) return step.setup;
  switch (step.kind) {
    case "activate":
      return "Start the paused routines once the rest of the checklist is done.";
    case "connection":
      return "Sign the guild in to this connector.";
    case "secret":
      return "Add this secret to the guild.";
    case "repository":
      return "Add this repository in the guild's Settings.";
    default:
      return "Do this outside the platform, then confirm it.";
  }
}

/** Where a step stands. */
export function stepStatus(step: ApplyStep, connected: boolean): string {
  if (step.status === "skipped") return "Skipped";
  if (step.status === "verified") return "Checked";
  if (step.status === "confirmed") return step.kind === "activate" ? "Activated" : "Confirmed";
  if (step.kind === "connection")
    return connected ? "Connected · ready to check" : "Not connected yet";
  if (step.kind === "secret") return "Waiting for the secret";
  if (step.kind === "repository") return "Waiting for the repository";
  return "Needs confirmation";
}

/** What to do next on an open login or secret step; null when the step says it all. */
export function stepHint(step: ApplyStep, connected: boolean): string | null {
  if (stepClosed(step)) return null;
  if (step.kind === "connection" && !connected) {
    return "Connect it here; the step is checked once the login works.";
  }
  if (step.kind === "secret")
    return "Add the secret under the guild's Secrets, then check this step.";
  if (step.kind === "repository")
    return "Add it under Repositories in the guild's Settings, with this name, then check this step.";
  return null;
}

/** Only logins, secrets, and repositories can be skipped; the agents that need them fail those tasks until they are added. */
export const skippable = (step: Pick<ApplyStep, "kind">) =>
  step.kind === "connection" || step.kind === "secret" || step.kind === "repository";

/** "2 agents, 2 routines, 1 connector, 2 tables (1 reused)." */
export function createdSummary(
  creates: Pick<ApplyCreates, "agents" | "routines" | "connections" | "collections">,
): string {
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const reused = creates.collections.filter((item) => item.action === "reuse").length;
  const parts = [
    count(creates.agents.length, "agent"),
    count(creates.routines.length, "routine"),
    ...(creates.connections.length ? [count(creates.connections.length, "connector")] : []),
    ...(creates.collections.length
      ? [`${count(creates.collections.length, "table")}${reused ? ` (${reused} reused)` : ""}`]
      : []),
  ];
  return `${parts.join(", ")}.`;
}

/** The logins, secrets, and repositories skipped, and every step skipped when none of those were. */
export function skippedSteps(checklist: readonly ApplyStep[]): ApplyStep[] {
  const skipped = checklist.filter((step) => step.status === "skipped" && step.kind !== "overlays");
  const access = skipped.filter(skippable);
  return access.length ? access : skipped;
}

/** Whether the apply still takes work: finished and aborted applies are read-only. */
export const applyOpen = (apply: Pick<ApplyRow, "status">) =>
  apply.status === "skeleton" || apply.status === "checklist";
