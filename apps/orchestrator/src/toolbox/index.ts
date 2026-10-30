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
import type { ToolCall, ToolMessage, ToolResultMetadata } from "../db/schema/index.js";
import { writeLog } from "../observability/log.js";
import { identityOutput, processOutput } from "./output.js";
import { browse } from "./browse.js";
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
import { ToolArgumentError } from "./errors.js";

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
register(browse);
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
    throw new ToolArgumentError("tool arguments must be a JSON object");
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
  const started = performance.now();
  const registered = REGISTRY[name] ?? run.dynamic_tools[name];
  const offered = run.offered_tools;
  const blocked =
    offered !== null && !offered.has(name) && !(name in run.dynamic_tools);
  if (registered === undefined || blocked) {
    const message = blocked
      ? `tool ${name} is not offered this run`
      : `unknown tool ${name}`;
    return toolResult(run, call, started, { raw: `ERROR: ${message}`, error: message, tool: null, invocation: null });
  }
  const invocation: ToolInvocation = { id: call.id, name, arguments: {}, exit_code: null, metadata: null };
  try {
    invocation.arguments = parseArguments(call);
    const raw: unknown = await registered.handler(services, run, hooks, invocation);
    if (typeof raw !== "string") {
      throw new TypeError("tool must return str");
    }
    return toolResult(run, call, started, { raw, error: null, tool: registered, invocation });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    writeLog("warn", message, {
      run_id: run.run_id,
      agent_id: run.agent_id,
      guild_id: run.guild_id,
      operation: `tool.${name}`,
      error_type: caught instanceof Error ? caught.name : "Error",
    });
    return toolResult(run, call, started, { raw: `ERROR: ${message}`, error: message, tool: registered, invocation });
  }
}

/**
 * How a tool call ended before its output is kept: the text, why it failed, the tool that ran it
 * (null when the call named none this run may use), and the invocation the handler reported on.
 */
type CallOutcome = {
  raw: string;
  error: string | null;
  tool: Tool | null;
  invocation: ToolInvocation | null;
};

/** The call's result as the model reads it, with its metadata; `started` is when the call began, from `performance.now()`. */
function toolResult(
  run: ToolRun,
  call: ToolCall,
  started: number,
  outcome: CallOutcome,
): [ToolMessage, ToolResultMetadata] {
  const outputFilter = outcome.tool?.output_filter ?? identityOutput;
  const [content, pipeline] = processOutput(outcome.raw, outputFilter, run.secrets, toolResultMaxBytes());
  const payload: ToolMessage = { role: "tool", tool_call_id: call.id, content };
  const metadata: ToolResultMetadata = {
    ...(outcome.invocation?.metadata ?? {}),
    tool_name: call.function.name,
    tool_call_id: call.id,
    duration_ms: Math.trunc(performance.now() - started),
    output_filter: outcome.tool?.filter_name ?? "identity",
    truncated: pipeline.truncated,
    original_bytes: pipeline.original_bytes,
    stored_bytes: pipeline.stored_bytes,
    error: pipeline.error ?? outcome.error,
  };
  if (call.function.name === "script_run") {
    metadata.exit_code = outcome.invocation?.exit_code ?? null;
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
