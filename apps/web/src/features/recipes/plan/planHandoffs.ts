import type { HandoffDraft } from "./recipeDraft";
import type { RecipePlan } from "./planModel";
import type { PlanAgent } from "./planAgents";

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
