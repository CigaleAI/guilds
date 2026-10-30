import { Value } from "@sinclair/typebox/value";
import type { ConnectorTool } from "../connectors/types.js";
import { isPlainRecord, jsonObj } from "../db/json.js";
import type { McpToolRow } from "../db/mcp.js";
import { ToolInputSchema } from "../db/schema/index.js";
import { llmToolParameters } from "../lib/tool-schema.js";
import { McpError } from "./errors.js";
import { namespacedName } from "../connectors/naming.js";

/**
 * A tool a login's listing offers: its name on the remote and here, its copy and input schema,
 * and the listing's `readOnlyHint` and `destructiveHint`, each null when it gave none.
 */
export type ListedTool = Pick<
  McpToolRow,
  "remote_name" | "namespaced_name" | "description" | "input_schema" | "read_only_hint" | "destructive_hint"
>;

export function mcpSchema(tool: Pick<ListedTool, "namespaced_name" | "description" | "input_schema">): Record<string, unknown> {
  const parameters = Object.keys(tool.input_schema).length ? tool.input_schema : { type: "object" };
  return {
    type: "function",
    function: {
      name: tool.namespaced_name,
      description: tool.description,
      parameters: llmToolParameters(parameters),
    },
  };
}

/** A remote tool's input schema, or an empty object schema when it sends none the box can read. */
function remoteSchema(tool: Record<string, unknown>): ToolInputSchema {
  let loaded = pythonOr(tool.inputSchema, tool.input_schema, { type: "object" });
  if (typeof loaded === "string") {
    try {
      loaded = JSON.parse(loaded);
    } catch {
      return { type: "object" };
    }
  }
  return Value.Check(ToolInputSchema, loaded) ? loaded : { type: "object" };
}

function pythonOr(...values: unknown[]): unknown {
  for (const value of values) {
    if (value === null || value === undefined || value === false || value === 0 || value === "") {
      continue;
    }
    if (isPlainRecord(value) && Object.keys(value).length === 0) {
      continue;
    }
    return value;
  }
  return values[values.length - 1];
}

export function fromRemote(slug: string, tool: Record<string, unknown>): ListedTool {
  const remoteName = tool.name;
  if (typeof remoteName !== "string" || !remoteName.trim()) {
    throw new McpError("mcp tool is missing a name");
  }
  const remote = remoteName.trim();
  const description = tool.description;
  return {
    remote_name: remote,
    namespaced_name: namespacedName(slug, remote),
    description: typeof description === "string" ? description : "",
    input_schema: remoteSchema(tool),
    read_only_hint: null,
    destructive_hint: null,
  };
}

export function listedFromRows(rows: McpToolRow[]): ListedTool[] {
  return rows.map((row) => ({
    remote_name: row.remote_name,
    namespaced_name: row.namespaced_name,
    description: row.description,
    input_schema: row.input_schema,
    read_only_hint: row.read_only_hint,
    destructive_hint: row.destructive_hint,
  }));
}

/** A tool from a remote `tools/list`, with its annotations, null when absent. */
export function remoteConnectorTool(tool: Record<string, unknown>): ConnectorTool {
  const listed = fromRemote("", tool);
  const annotations = jsonObj(tool.annotations);
  const hint = (name: string): boolean | null => {
    const value = isPlainRecord(annotations) ? annotations[name] : undefined;
    return typeof value === "boolean" ? value : null;
  };
  return {
    name: listed.remote_name,
    description: listed.description,
    input_schema: listed.input_schema,
    read_only_hint: hint("readOnlyHint"),
    destructive_hint: hint("destructiveHint"),
  };
}
