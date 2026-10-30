import { isPlainRecord } from "../db/json.js";
import { RecipeError } from "./errors.js";
import { asBool, asString, assertObject } from "./parse-fields.js";
import type { RecipeConnection, RecipeDocument } from "../db/schema/index.js";

// The operator's cuts to a recipe's connector access: a tool turned off for a role, or a
// connector removed, which the design then records as refused by the operator.

export type AccessCut = {
  kind: "tool" | "connector";
  server: string;
  role?: string;
  tool?: string;
};

export type AccessEdit =
  | { action: "set_tool"; server: string; role: string; tool: string; enabled: boolean }
  | { action: "remove_connection"; server: string };

function recordOperatorRemovedConnector(recipe: RecipeDocument, server: string): void {
  const existing = recipe.design.systems.find((item) => item.server === server || item.name === server);
  if (!existing) {
    recipe.design.systems.push({
      name: server,
      server,
      resolution: "refused",
      reason: "Operator removed this connector.",
      proposed_by: "operator",
      accepted: true,
    });
    return;
  }
  existing.resolution = "refused";
  existing.proposed_by = "operator";
  existing.accepted = true;
  existing.server = existing.server || server;
  if (!existing.reason.startsWith("Operator removed")) {
    existing.reason = existing.reason.trim()
      ? `Operator removed this connector. ${existing.reason}`
      : "Operator removed this connector.";
  }
}

/** The tools a connection's role overlays turn off. */
function toolCuts(connection: RecipeConnection): AccessCut[] {
  return Object.entries(connection.roles).flatMap(([role, spec]) =>
    Object.entries(spec.tools)
      .filter(([, enabled]) => enabled === false)
      .map(([tool]): AccessCut => ({ kind: "tool", server: connection.server, role, tool })),
  );
}

export function operatorAccessCuts(recipe: RecipeDocument): AccessCut[] {
  const cuts = recipe.connections.flatMap(toolCuts);
  const live = new Set(recipe.connections.map((item) => item.server));
  for (const system of recipe.design.systems) {
    const server = system.server || system.name;
    if (system.resolution === "refused" && system.proposed_by === "operator" && server && !live.has(server)) {
      cuts.push({ kind: "connector", server });
    }
  }
  return cuts;
}

function setTool(recipe: RecipeDocument, edit: Extract<AccessEdit, { action: "set_tool" }>): void {
  const connection = recipe.connections.find((item) => item.server === edit.server);
  if (!connection) {
    throw new RecipeError("connection not found", 404);
  }
  if (!recipe.roles.some((role) => role.role === edit.role)) {
    throw new RecipeError("role not found", 404);
  }
  if (!edit.tool.trim()) {
    throw new RecipeError("tool is required");
  }
  const spec = connection.roles[edit.role] ?? { enabled: true, tools: {} };
  if (edit.enabled) {
    delete spec.tools[edit.tool];
  } else {
    spec.tools[edit.tool] = false;
  }
  connection.roles[edit.role] = spec;
}

export function applyAccessEdit(recipe: RecipeDocument, edit: AccessEdit): AccessCut[] {
  if (edit.action === "set_tool") {
    setTool(recipe, edit);
    return operatorAccessCuts(recipe);
  }
  const index = recipe.connections.findIndex((item) => item.server === edit.server);
  if (index < 0) {
    throw new RecipeError("connection not found", 404);
  }
  recipe.connections.splice(index, 1);
  recordOperatorRemovedConnector(recipe, edit.server);
  return operatorAccessCuts(recipe);
}

export function applyAccessEdits(recipe: RecipeDocument, edits: AccessEdit[]): AccessCut[] {
  for (const edit of edits) {
    applyAccessEdit(recipe, edit);
  }
  return operatorAccessCuts(recipe);
}

function parseAccessEdit(item: unknown, index: number): AccessEdit {
  const path = `edits[${index}]`;
  const row = assertObject(item, path);
  const action = asString(row.action, `${path}.action`);
  const server = asString(row.server, `${path}.server`).trim();
  if (!server) {
    throw new RecipeError(`${path}.server is required`);
  }
  if (action === "remove_connection") {
    return { action, server };
  }
  if (action !== "set_tool") {
    throw new RecipeError(`${path}.action must be set_tool or remove_connection`);
  }
  return {
    action,
    server,
    role: asString(row.role, `${path}.role`).trim(),
    tool: asString(row.tool, `${path}.tool`).trim(),
    enabled: asBool(row.enabled, `${path}.enabled`),
  };
}

/** The edits of a request: a list, or `{ edits }`. */
export function parseAccessEdits(value: unknown): AccessEdit[] {
  const raw = Array.isArray(value) ? value : isPlainRecord(value) ? value.edits : undefined;
  if (!Array.isArray(raw)) {
    throw new RecipeError("edits must be an array");
  }
  return raw.map(parseAccessEdit);
}

export function formatAccessCutsMessage(cuts: AccessCut[]): string {
  if (!cuts.length) {
    return "";
  }
  const lines = cuts.map((cut) =>
    cut.kind === "tool" ? `- tool ${cut.tool} from ${cut.server} for ${cut.role}` : `- connector ${cut.server}`,
  );
  return [
    "I validated connector access. I removed:",
    ...lines,
    "Update standing prompts if they rely on these, or ask me questions.",
  ].join("\n");
}
