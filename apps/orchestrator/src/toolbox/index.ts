import {
  noteDelete,
  noteFind,
  noteGet,
  noteWrite,
  recordAdd,
  recordList,
  recordRemove,
  recordSearch,
  recordUpdate,
} from "./artifacts.js";
import { isPlainRecord } from "../db/json.js";
import type { ReportedToolMetadata, ToolCall, ToolMessage, ToolResultMetadata } from "../db/schema/index.js";
import { writeLog } from "../observability/log.js";
import { identityOutput, processOutput } from "./output.js";
import { browserClick, browserEval, browserFill, browserNavigate, browserScreenshot, browserScroll, browserSnapshot, browserType } from "./browser.js";
import { codeSearch, fileRead, shell, shellStatus } from "./code.js";
import { groupPost } from "./group.js";
import { codeTask } from "./harness.js";
import { fileDelete, fileFetch, fileFind, filePut } from "./file.js";
import { memoryWrite } from "./memory.js";
import { reportIssue } from "./report.js";
import { scheduleCreateCron, scheduleCreateWindow, scheduleDelete, scheduleList, schedulePause, scheduleResume, scheduleUpdate } from "./schedule.js";
import { scriptCreate, scriptDelete, scriptList, scriptRead, scriptRun } from "./script.js";
import { secretRequest, secretStore } from "./secret.js";
import type { ToolServices } from "./services.js";
import type { Tool, ToolHooks, ToolInvocation, ToolRun } from "./types.js";

export const REGISTRY: Record<string, Tool> = {};

function register(tool: Tool): void {
  REGISTRY[tool.name] = tool;
}

register(noteFind);
register(noteGet);
register(noteWrite);
register(noteDelete);
register(recordSearch);
register(recordList);
register(recordAdd);
register(recordUpdate);
register(recordRemove);
register(fileFind);
register(fileFetch);
register(filePut);
register(fileDelete);
register(memoryWrite);
register(groupPost);
register(reportIssue);
register(scriptCreate);
register(scriptList);
register(scriptRead);
register(scriptRun);
register(scriptDelete);
register(scheduleCreateCron);
register(scheduleCreateWindow);
register(scheduleList);
register(scheduleUpdate);
register(schedulePause);
register(scheduleResume);
register(scheduleDelete);
register(browserNavigate);
register(browserSnapshot);
register(browserClick);
register(browserType);
register(browserFill);
register(browserScroll);
register(browserScreenshot);
register(browserEval);
register(shell);
register(shellStatus);
register(fileRead);
register(codeSearch);
register(codeTask);
register(secretStore);
register(secretRequest);

export const NATIVE_TOOL_NAMES = Object.freeze(Object.keys(REGISTRY));

export function schemasFor(names: string[]): Array<Record<string, unknown>> {
  return names.flatMap((name) => (REGISTRY[name] ? [REGISTRY[name].schema] : []));
}

/** A call's arguments: the JSON object the model wrote, empty when it wrote none. */
export function parseArguments(call: ToolCall): Record<string, unknown> {
  if (call.function.arguments === "") {
    return {};
  }
  const loaded: unknown = JSON.parse(call.function.arguments);
  if (!isPlainRecord(loaded)) {
    throw new Error("tool arguments must be a JSON object");
  }
  return loaded;
}

/**
 * Runs the model's `call` with the tool it names, and returns its result as the model reads it:
 * filtered, redacted with the run's secrets, and cut to `TOOL_RESULT_MAX_BYTES`, with its metadata.
 */
export async function invokeTool(
  services: ToolServices,
  run: ToolRun,
  hooks: ToolHooks,
  call: ToolCall,
): Promise<[ToolMessage, ToolResultMetadata]> {
  const name = call.function.name;
  const callId = call.id;
  const started = performance.now();
  let error: string | null = null;
  const registered = REGISTRY[name] ?? run.dynamic_tools[name];
  let reported: ReportedToolMetadata | null = null;
  let exitCode: number | null = null;
  let raw: string;
  let outputFilter = identityOutput;
  let filterName = "identity";
  const offered = run.offered_tools;
  const blocked =
    offered !== null && !offered.has(name) && !(name in run.dynamic_tools);
  if (registered === undefined || blocked) {
    const message = blocked
      ? `tool ${name} is not offered this run`
      : `unknown tool ${name}`;
    raw = `ERROR: ${message}`;
    error = message;
  } else {
    outputFilter = registered.output_filter;
    filterName = registered.filter_name;
    try {
      const invocation: ToolInvocation = {
        id: callId,
        name,
        arguments: parseArguments(call),
        exit_code: null,
        metadata: null,
      };
      try {
        raw = await registered.handler(services, run, hooks, invocation);
      } finally {
        exitCode = invocation.exit_code;
        reported = invocation.metadata;
      }
      if (typeof raw !== "string") {
        throw new TypeError("tool must return str");
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      writeLog("warn", message, {
        run_id: run.run_id,
        agent_id: run.agent_id,
        guild_id: run.guild_id,
        operation: `tool.${name}`,
        error_type: caught instanceof Error ? caught.name : "Error",
      });
      raw = `ERROR: ${message}`;
      error = message;
    }
  }
  const [content, pipeline] = processOutput(raw, outputFilter, run.secrets, toolResultMaxBytes());
  if (pipeline.error) {
    error = pipeline.error;
  }
  const payload: ToolMessage = { role: "tool", tool_call_id: callId, content };
  const metadata: ToolResultMetadata = {
    ...(reported ?? {}),
    tool_name: name,
    tool_call_id: callId,
    duration_ms: Math.trunc(performance.now() - started),
    output_filter: filterName,
    truncated: pipeline.truncated,
    original_bytes: pipeline.original_bytes,
    stored_bytes: pipeline.stored_bytes,
    error,
  };
  if (name === "script_run") {
    metadata.exit_code = exitCode;
  }
  return [payload, metadata];
}

export function toolResultMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.TOOL_RESULT_MAX_BYTES ?? "65536");
}

export {
  identityOutput,
  LOW_TOOL_CALL_BUDGET,
  LOW_TOOL_CALL_WRAP_UP,
  processOutput,
  remainingAfter,
  stampToolResult,
  withRemainingToolCalls,
} from "./output.js";
export { createToolHooks, createToolRun, CancelEvent } from "./types.js";
export type { Tool, ToolHooks, ToolRun } from "./types.js";
export { encodeSpec, HELPER } from "./browser.js";
export { formatExecution } from "./shell.js";
export { dynamicScriptTools, firstClassScriptSchemas } from "./script.js";
