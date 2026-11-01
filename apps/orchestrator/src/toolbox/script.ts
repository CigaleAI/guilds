import { Type } from "@sinclair/typebox";
import { isJsonObject, type JsonObject, type JsonValue } from "../lib/json.js";
import { ScriptError } from "../scripts/validation.js";
import type { AgentScript } from "../scripts/catalog.js";
import type { RunScriptSnapshot } from "../db/schema/index.js";
import { liveExtraRows } from "../scripts/snapshot.js";
import {
  launcherCommand,
  SCRIPT_ARGS_ENV,
  writeThroughLiveExtra,
  removeManagedScript,
} from "../scripts/materialise.js";
import { functionSchema, isText, jsonArgument } from "./schema.js";
import type { FunctionTool, ToolSchema } from "../lib/tool-schema.js";
import { identityOutput } from "./output.js";
import { commandOutput, executeCommand } from "./shell.js";
import type { ToolServices } from "./services.js";
import type { CommandResult } from "../sandbox/sdk.js";
import { callActor, nativeTool, type ToolHooks, type ToolInvocation, type ToolRun, type ToolsByName } from "./types.js";

export const SCRIPT_TOOLS = [
  "script_create",
  "script_list",
  "script_read",
  "script_run",
  "script_delete",
] as const;

function scripts(services: ToolServices) {
  if (services.scripts === null) {
    throw new ScriptError("scripts are not available");
  }
  return services.scripts;
}

function scriptActor(run: ToolRun, call: ToolInvocation) {
  const actor = callActor(run.artifact_actor, call);
  if (actor === null) {
    throw new ScriptError("script provenance is not available");
  }
  return actor;
}

async function publish(
  services: ToolServices,
  run: ToolRun,
  action: string,
  name: string,
): Promise<void> {
  if (services.group_chat !== null && run.guild_id && services.group_chat.publish) {
    await services.group_chat.publish(run.guild_id, "agent.scripts.changed", {
      agent_id: run.agent_id,
      action,
      name,
    });
  }
}

/** The arguments of a call that names one of the agent's scripts: its name, as `script_list` shows it. */
const ScriptName = Type.Object({ name: Type.String() });

export const scriptCreate = nativeTool({
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
  parameters: Type.Object({
    name: Type.String(),
    description: Type.String(),
    source: Type.String(),
    parameters: Type.Optional(jsonArgument({ type: "object" })),
  }),
  async handler(services, run, _hooks, call) {
    const args = call.arguments;
    const row = await scripts(services).create(
      scriptActor(run, call),
      run.agent_id,
      args.name,
      args.description,
      args.source,
      args.parameters ?? null,
      { reservedNames: run.connection_tool_names, maxScripts: run.max_scripts },
    );
    if (run.sandbox?.files) {
      await writeThroughLiveExtra(
        run.sandbox.files,
        run.agent_home,
        String(row.name),
        String(row.source),
        run.run_scripts,
      );
    }
    await publish(services, run, "create", String(row.name));
    const wrote = `wrote ${row.name}\n${row.description}`;
    if (run.run_scripts.some((item) => item.name === row.name)) {
      return `${wrote}\nThis run keeps running the version it started with; the new version runs from the next run.`;
    }
    return wrote;
  },
});

export const scriptList = nativeTool({
  name: "script_list",
  description: "List this agent's reusable scripts and why each exists.",
  parameters: Type.Object({}),
  async handler(services, run) {
    return scripts(services).formatList(run.agent_id);
  },
});

export const scriptRead = nativeTool({
  name: "script_read",
  description: "Read one of this agent's scripts by name from script_list.",
  parameters: ScriptName,
  async handler(services, run, _hooks, call) {
    const row = await scripts(services).get(run.agent_id, call.arguments.name);
    return `${row.name}\n${row.description}\n\n${row.source}`;
  },
});

const RUN_DESCRIPTION =
  "Run one of this agent's Python scripts by name. The file executes " +
  "in your home as scripts/<name>.py with the bound " +
  "environment variables available. Optional arguments is a JSON " +
  "object the script reads from stdin (json.load(sys.stdin)); without " +
  "it the script reads {}.";

export const scriptRun = nativeTool({
  name: "script_run",
  description: RUN_DESCRIPTION,
  parameters: Type.Object({
    name: Type.String(),
    arguments: Type.Optional(jsonArgument({ type: "object" })),
  }),
  async handler(services, run, hooks, call) {
    const name = await resolveRunnableName(services, run, call.arguments.name);
    return commandOutput(call, await runScript(run, hooks, name, scriptArguments(call.arguments.arguments)));
  },
});

const DELETE_DESCRIPTION =
  "Delete one of this agent's scripts by name from script_list. " +
  "The file leaves scripts/ in your home and cannot be run again this run.";

export const scriptDelete = nativeTool({
  name: "script_delete",
  description: DELETE_DESCRIPTION,
  parameters: ScriptName,
  async handler(services, run, _hooks, call) {
    const row = await scripts(services).delete(scriptActor(run, call), run.agent_id, call.arguments.name);
    const name = String(row.name);
    const pinned = run.run_scripts.findIndex((item) => item.name === name);
    if (pinned >= 0) {
      run.run_scripts.splice(pinned, 1);
    }
    delete run.dynamic_tools[name];
    run.offered_tools?.delete(name);
    await services.db?.updateRunScripts(run.run_id, run.run_scripts, new Date());
    if (run.sandbox?.files) {
      await removeManagedScript(run.sandbox.files, run.agent_home, name);
    }
    await publish(services, run, "delete", name);
    return `deleted ${name}`;
  },
});

/** Runs a managed script through the launcher, which writes `args` as JSON to its stdin. */
function runScript(run: ToolRun, hooks: ToolHooks, name: string, args: JsonObject): Promise<CommandResult> {
  return executeCommand(run, hooks, launcherCommand(run.agent_home, name), {
    envs: { [SCRIPT_ARGS_ENV]: JSON.stringify(args) },
  });
}

/** The JSON object a script reads on stdin: the call's `arguments`, sent as an object or as its JSON text; `{}` without them. */
function scriptArguments(raw: JsonValue | undefined): JsonObject {
  if (raw === undefined) {
    return {};
  }
  let value: unknown = raw;
  if (isText(raw)) {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new ScriptError("arguments must be a JSON object");
    }
  }
  if (!isJsonObject(value)) {
    throw new ScriptError("arguments must be a JSON object");
  }
  return value;
}

/** The script `name` runs: the version this run started with, or the agent's script of that name. */
async function resolveRunnableName(services: ToolServices, run: ToolRun, name: string): Promise<string> {
  const snap = run.run_scripts.find((row) => row.name === name);
  if (snap) {
    return snap.name;
  }
  const row = await scripts(services).get(run.agent_id, name);
  return String(row.name);
}

function firstClassSnapshots(snapshot: RunScriptSnapshot[]): RunScriptSnapshot[] {
  return snapshot.filter((row) => row.parameters !== null);
}

export function dynamicScriptTools(snapshot: RunScriptSnapshot[]): ToolsByName {
  const tools: ToolsByName = {};
  for (const row of firstClassSnapshots(snapshot)) {
    const parameters: ToolSchema = row.parameters ?? { type: "object" };
    const properties = parameters.properties ?? {};
    const required = (parameters.required ?? []).filter((item) => item in properties);
    tools[row.name] = {
      name: row.name,
      description: row.description,
      output_filter: identityOutput,
      filter_name: "identity",
      schema: functionSchema(row.name, row.description, properties, required),
      async handler(_services, run, hooks, call) {
        return commandOutput(call, await runScript(run, hooks, row.name, call.arguments));
      },
    };
  }
  return tools;
}

export function firstClassScriptSchemas(snapshot: RunScriptSnapshot[]): FunctionTool[] {
  return Object.values(dynamicScriptTools(snapshot)).map((tool) => tool.schema);
}

export function liveExtraForAgent(snapshot: RunScriptSnapshot[], live: AgentScript[]): AgentScript[] {
  return liveExtraRows(snapshot, live);
}
