import type { ConnectorTool } from "../connectors/types.js";
import type { McpToolRow } from "../db/mcp.js";
import type { ToolInputSchema } from "../db/schema/index.js";
import { llmToolParameters, type FunctionTool } from "../lib/tool-schema.js";
import type { McpTool } from "./session.js";
import { namespacedName } from "../connectors/naming.js";

/**
 * A tool a login's listing offers: its name on the remote and here, its copy and input schema,
 * and the listing's `readOnlyHint` and `destructiveHint`, each null when it gave none.
 */
export type ListedTool = Pick<
  McpToolRow,
  "remote_name" | "namespaced_name" | "description" | "input_schema" | "read_only_hint" | "destructive_hint"
>;

/** A listed tool as the model is offered it: a function taking its input schema, or any object when the schema is empty. */
export function mcpSchema(tool: Pick<ListedTool, "namespaced_name" | "description" | "input_schema">): FunctionTool {
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

/**
 * A remote tool's input schema, or an empty object schema when it declares none or an empty one.
 * A declared schema that is not a JSON Schema the box reads is left out where the listing is read
 * (`McpSession.listTools`), so that tool too takes any object, and its server checks the arguments.
 */
function remoteSchema(tool: McpTool): ToolInputSchema {
  const declared = tool.inputSchema;
  return declared !== undefined && Object.keys(declared).length ? declared : { type: "object" };
}

export function fromRemote(slug: string, tool: McpTool): ListedTool {
  const remote = tool.name.trim();
  return {
    remote_name: remote,
    namespaced_name: namespacedName(slug, remote),
    description: tool.description ?? "",
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
export function remoteConnectorTool(tool: McpTool): ConnectorTool {
  const listed = fromRemote("", tool);
  return {
    name: listed.remote_name,
    description: listed.description,
    input_schema: listed.input_schema,
    read_only_hint: tool.annotations?.readOnlyHint ?? null,
    destructive_hint: tool.annotations?.destructiveHint ?? null,
  };
}
