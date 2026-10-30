import { Value } from "@sinclair/typebox/value";
import type { ConnectorTool } from "../connectors/types.js";
import { isPlainRecord, jsonObj } from "../db/json.js";
import type { McpToolRow } from "../db/mcp.js";
import { ToolInputSchema } from "../db/schema/index.js";
import { llmToolParameters } from "../lib/tool-schema.js";
import { McpError } from "./errors.js";
import { namespacedName } from "../connectors/naming.js";

export class ListedTool {
  constructor(
    public remote_name: string,
    public namespaced_name: string,
    public description: string,
    public input_schema: ToolInputSchema,
    /** The listing's `readOnlyHint`, null when it gave none. */
    public read_only_hint: boolean | null = null,
    /** The listing's `destructiveHint`, null when it gave none. */
    public destructive_hint: boolean | null = null,
  ) {}
}

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
  return new ListedTool(
    remote,
    namespacedName(slug, remote),
    typeof description === "string" ? description : "",
    remoteSchema(tool),
  );
}

export function listedFromRows(rows: McpToolRow[]): ListedTool[] {
  return rows.map(
    (row) =>
      new ListedTool(
        row.remote_name,
        row.namespaced_name,
        row.description,
        row.input_schema,
        row.read_only_hint,
        row.destructive_hint,
      ),
  );
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
