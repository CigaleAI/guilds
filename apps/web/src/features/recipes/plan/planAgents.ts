import { harnessLabel, isHarness } from "../../agent/harness";
import type { Harness } from "../../../api/types/agents";
import type { RecipeFinding } from "../../../api/types/recipes";
import {
  asArray,
  asObject,
  enabledKeys,
  plural,
  reviewLabel,
  type AuthorDraft,
  type ConnectionDraft,
  type CreatedAgentDraft,
  type OverlayRoutine,
  type RecipeDraft,
  type RoleDraft,
  type ScriptDraft,
} from "./recipeDraft";
import type { RecipePlan } from "./planModel";
import {
  routineView,
  routinesForRole,
  scheduleCadence,
  type PlanRoutine,
  type RoutineView,
} from "./planRoutines";
import { connectionTools, roleUsesConnection } from "./planConnectors";
import { operatorActions, type OperatorActions } from "./designSystems";
import { roleFindings, type RoleFindings } from "./planFindings";

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

/** The roles the plan shows: the recipe's, or the apply plan's agents when the recipe has none. */
export function planRoles(
  doc: RecipeDraft,
  createdAgents: readonly CreatedAgentDraft[],
  overlayRoutines: readonly OverlayRoutine[],
): readonly RoleDraft[] {
  const roles = asArray(doc.roles);
  if (roles.length || !createdAgents.length) return roles;
  return rolesFromCreatedAgents(createdAgents, overlayRoutines);
}

/** The harness a coding role runs; null when the role does not code or names no known harness. */
function codingHarness(role: RoleDraft): Harness | null {
  const config = asObject(role.config);
  return config.coding === true && isHarness(config.harness) ? config.harness : null;
}

export function planAgent(
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
    harness: codingHarness(role),
    browserInstructions: browser.instructions || "",
    task: taskBody(role),
    taskAuthor: taskAuthor(role),
    browserAuthor: browser.author || null,
    nativeTools: enabledKeys(role.native_tools),
    scripts: asArray(role.scripts),
    routines: routinesForRole(role, doc, overlayRoutines),
  };
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
        cadence: scheduleCadence(item.window, item.cron),
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
