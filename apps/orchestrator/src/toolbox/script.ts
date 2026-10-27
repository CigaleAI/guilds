import { ScriptError } from "../scripts/validation.js";
import type { AgentScript } from "../scripts/catalog.js";
import { liveExtraRows, type RunScriptSnapshot } from "../scripts/snapshot.js";
import {
  launcherCommand,
  SCRIPT_ARGS_ENV,
  writeThroughLiveExtra,
  removeManagedScript,
} from "../scripts/materialise.js";
import { argString, functionSchema } from "./schema.js";
import { identityOutput } from "./output.js";
import { runCommand } from "./shell.js";
import type { Tool, ToolContext } from "./types.js";

export const SCRIPT_TOOLS = [
  "script_create",
  "script_list",
  "script_read",
  "script_run",
  "script_delete",
] as const;

function scripts(ctx: ToolContext) {
  if (ctx.scripts === null) {
    throw new ScriptError("scripts are not available");
  }
  return ctx.scripts;
}

function scriptActor(ctx: ToolContext) {
  if (ctx.artifact_actor === null) {
    throw new ScriptError("script provenance is not available");
  }
  return ctx.artifact_actor;
}

async function publish(
  ctx: ToolContext,
  action: string,
  name: string,
): Promise<void> {
  if (ctx.group_chat !== null && ctx.guild_id && ctx.group_chat.publish) {
    await ctx.group_chat.publish(ctx.guild_id, "agent.scripts.changed", {
      agent_id: ctx.agent_id,
      action,
      name,
    });
  }
}

export const scriptCreate: Tool = {
  name: "script_create",
  description:
    "Create or replace a reusable Python script for this agent. name " +
    "matches ^[a-z][a-z0-9_-]{0,62}$. description is a short why so " +
    "later wakes know when to run it. source is the Python file, which " +
    "is stored at scripts/<name>.py in your home. Optional parameters is a " +
    "JSON Schema object that also offers the script as a tool under its " +
    "name from the next run on. A script reads its arguments as a JSON " +
    "object from stdin (json.load(sys.stdin)): script_run arguments, or " +
    "that tool's arguments. Replacing a script this run started with " +
    "takes effect from the next run. An agent may hold at most its " +
    "max_scripts setting (default 10); replacing a name does not count " +
    "as a new script. Read secrets from the process environment inside " +
    "the script; never print them.",
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema(
    "script_create",
    "Create or replace a reusable Python script for this agent. name " +
      "matches ^[a-z][a-z0-9_-]{0,62}$. description is a short why so " +
      "later wakes know when to run it. source is the Python file, which " +
      "is stored at scripts/<name>.py in your home. Optional parameters is a " +
      "JSON Schema object that also offers the script as a tool under its " +
      "name from the next run on. A script reads its arguments as a JSON " +
      "object from stdin (json.load(sys.stdin)): script_run arguments, or " +
      "that tool's arguments. Replacing a script this run started with " +
      "takes effect from the next run. An agent may hold at most its " +
      "max_scripts setting (default 10); replacing a name does not count " +
      "as a new script. Read secrets from the process environment inside " +
      "the script; never print them.",
    {
      name: { type: "string" },
      description: { type: "string" },
      source: { type: "string" },
      parameters: { type: "object" },
    },
    ["name", "description", "source"],
  ),
  async handler(ctx, args) {
    const row = await scripts(ctx).create(
      scriptActor(ctx),
      ctx.agent_id,
      args.name,
      args.description,
      args.source,
      args.parameters ?? null,
      { reservedNames: ctx.connection_tool_names, maxScripts: ctx.max_scripts },
    );
    if (ctx.sandbox?.files) {
      await writeThroughLiveExtra(
        ctx.sandbox.files,
        ctx.agent_home,
        String(row.name),
        String(row.source),
        ctx.run_scripts,
      );
    }
    await publish(ctx, "create", String(row.name));
    const wrote = `wrote ${row.name}\n${row.description}`;
    if (ctx.run_scripts.some((item) => item.name === row.name)) {
      return `${wrote}\nThis run keeps running the version it started with; the new version runs from the next run.`;
    }
    return wrote;
  },
};

export const scriptList: Tool = {
  name: "script_list",
  description: "List this agent's reusable scripts and why each exists.",
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema(
    "script_list",
    "List this agent's reusable scripts and why each exists.",
    {},
    [],
  ),
  async handler(ctx) {
    return scripts(ctx).formatList(ctx.agent_id);
  },
};

export const scriptRead: Tool = {
  name: "script_read",
  description: "Read one of this agent's scripts by name from script_list.",
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema(
    "script_read",
    "Read one of this agent's scripts by name from script_list.",
    {
      name: { type: "string" },
    },
    ["name"],
  ),
  async handler(ctx, args) {
    const row = await scripts(ctx).get(ctx.agent_id, args.name);
    return `${row.name}\n${row.description}\n\n${row.source}`;
  },
};

export const scriptRun: Tool = {
  name: "script_run",
  description:
    "Run one of this agent's Python scripts by name. The file executes " +
    "in your home as scripts/<name>.py with the bound " +
    "environment variables available. Optional arguments is a JSON " +
    "object the script reads from stdin (json.load(sys.stdin)); without " +
    "it the script reads {}.",
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema(
    "script_run",
    "Run one of this agent's Python scripts by name. The file executes " +
      "in your home as scripts/<name>.py with the bound " +
      "environment variables available. Optional arguments is a JSON " +
      "object the script reads from stdin (json.load(sys.stdin)); without " +
      "it the script reads {}.",
    {
      name: { type: "string" },
      arguments: { type: "object" },
    },
    ["name"],
  ),
  async handler(ctx, args) {
    const name = await resolveRunnableName(ctx, args.name);
    return runScript(ctx, name, scriptArguments(args.arguments));
  },
};

export const scriptDelete: Tool = {
  name: "script_delete",
  description:
    "Delete one of this agent's scripts by name from script_list. " +
    "The file leaves scripts/ in your home and cannot be run again this run.",
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema(
    "script_delete",
    "Delete one of this agent's scripts by name from script_list. " +
      "The file leaves scripts/ in your home and cannot be run again this run.",
    {
      name: { type: "string" },
    },
    ["name"],
  ),
  async handler(ctx, args) {
    const row = await scripts(ctx).delete(scriptActor(ctx), ctx.agent_id, args.name);
    const name = String(row.name);
    const pinned = ctx.run_scripts.findIndex((item) => item.name === name);
    if (pinned >= 0) {
      ctx.run_scripts.splice(pinned, 1);
    }
    delete ctx.dynamic_tools[name];
    ctx.offered_tools?.delete(name);
    if (ctx.persist_run_scripts) {
      await ctx.persist_run_scripts(ctx.run_scripts);
    }
    if (ctx.sandbox?.files) {
      await removeManagedScript(ctx.sandbox.files, ctx.agent_home, name);
    }
    await publish(ctx, "delete", name);
    return `deleted ${name}`;
  },
};

/** Runs a managed script through the launcher, which writes `args` as JSON to its stdin. */
function runScript(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<string> {
  return runCommand(ctx, launcherCommand(ctx.agent_home, name), {
    envs: { [SCRIPT_ARGS_ENV]: JSON.stringify(args) },
  });
}

function scriptArguments(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) {
    return {};
  }
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new ScriptError("arguments must be a JSON object");
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ScriptError("arguments must be a JSON object");
  }
  return value as Record<string, unknown>;
}

async function resolveRunnableName(ctx: ToolContext, raw: unknown): Promise<string> {
  const token = argString({ name: typeof raw === "string" ? raw : "" }, "name") || String(raw ?? "");
  const snap = ctx.run_scripts.find((row) => row.name === token);
  if (snap) {
    return snap.name;
  }
  const row = await scripts(ctx).get(ctx.agent_id, raw);
  return String(row.name);
}

function firstClassSnapshots(snapshot: RunScriptSnapshot[]): RunScriptSnapshot[] {
  return snapshot.filter((row) => row.parameters !== null);
}

export function dynamicScriptTools(snapshot: RunScriptSnapshot[]): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  for (const row of firstClassSnapshots(snapshot)) {
    const parameters = row.parameters ?? { type: "object" };
    const properties =
      parameters.properties && typeof parameters.properties === "object" && !Array.isArray(parameters.properties)
        ? (parameters.properties as Record<string, unknown>)
        : {};
    const required = Array.isArray(parameters.required)
      ? parameters.required.filter((item): item is string => typeof item === "string" && item in properties)
      : [];
    tools[row.name] = {
      name: row.name,
      description: row.description,
      output_filter: identityOutput,
      filter_name: "identity",
      schema: functionSchema(row.name, row.description, properties, required),
      async handler(ctx, args) {
        return runScript(ctx, row.name, args);
      },
    };
  }
  return tools;
}

export function firstClassScriptSchemas(snapshot: RunScriptSnapshot[]): Array<Record<string, unknown>> {
  return Object.values(dynamicScriptTools(snapshot)).map((tool) => tool.schema);
}

export function liveExtraForAgent(snapshot: RunScriptSnapshot[], live: AgentScript[]): AgentScript[] {
  return liveExtraRows(snapshot, live);
}
