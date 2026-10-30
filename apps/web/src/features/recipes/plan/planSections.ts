import { agentsMinimum, machineSizeLabel } from "../../machines/machines";
import type { RecipePlan } from "./planModel";
import { accessSection } from "./planConnectors";

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
export function planSections(plan: RecipePlan, hideEmpty = false): PlanSection[] {
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
