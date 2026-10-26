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
import type { Tool, ToolContext } from "./types.js";

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

export function toolCallFunction(call: Record<string, unknown>): Record<string, unknown> {
  if (call.function && typeof call.function === "object" && !Array.isArray(call.function)) {
    return call.function as Record<string, unknown>;
  }
  return {};
}

function parsedJsonObject(raw: string): Record<string, unknown> {
  const loaded = JSON.parse(raw) as unknown;
  if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) {
    throw new Error("tool arguments must be a JSON object");
  }
  return loaded as Record<string, unknown>;
}

function parseArgumentsObject(raw: unknown): Record<string, unknown> {
  if (raw == null || raw === "") {
    return {};
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string") {
    throw new Error("tool arguments must be a JSON object");
  }
  return parsedJsonObject(raw);
}

export function parseArguments(call: Record<string, unknown>): Record<string, unknown> {
  return parseArgumentsObject(toolCallFunction(call).arguments);
}

export async function invokeTool(
  ctx: ToolContext,
  call: Record<string, unknown>,
  secrets: Record<string, string>,
  maxBytes: number,
): Promise<[Record<string, unknown>, Record<string, unknown>]> {
  const fn = toolCallFunction(call);
  const name = typeof fn.name === "string" ? fn.name : "";
  const callId = typeof call.id === "string" ? call.id : "";
  const started = performance.now();
  ctx.exit_code = null;
  let error: string | null = null;
  const registered = REGISTRY[name] ?? ctx.dynamic_tools[name];
  let reported: Record<string, unknown> | null = null;
  let raw: string;
  let outputFilter = identityOutput;
  let filterName = "identity";
  const offered = ctx.offered_tools;
  const blocked =
    offered !== null && !offered.has(name) && !(name in ctx.dynamic_tools);
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
      const arguments_ = parseArguments(call);
      const invocationCtx: ToolContext = {
        ...ctx,
        tool_call_id: callId,
        tool_metadata: null,
        artifact_actor: ctx.artifact_actor
          ? { ...ctx.artifact_actor, toolCall: { id: callId, name } }
          : null,
      };
      try {
        raw = await registered.handler(invocationCtx, arguments_);
      } finally {
        ctx.exit_code = invocationCtx.exit_code;
        reported = invocationCtx.tool_metadata;
      }
      if (typeof raw !== "string") {
        throw new TypeError("tool must return str");
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      writeLog("warn", message, {
        run_id: ctx.run_id,
        agent_id: ctx.agent_id,
        guild_id: ctx.guild_id,
        operation: `tool.${name}`,
        error_type: caught instanceof Error ? caught.name : "Error",
      });
      raw = `ERROR: ${message}`;
      error = message;
    }
  }
  const [content, pipeline] = processOutput(raw, outputFilter, secrets, maxBytes);
  if (typeof pipeline.error === "string" && pipeline.error) {
    error = pipeline.error;
  }
  const payload = { role: "tool", tool_call_id: callId, content };
  const metadata: Record<string, unknown> = {
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
    metadata.exit_code = ctx.exit_code;
  }
  return [payload, metadata];
}

export function toolResultMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.TOOL_RESULT_MAX_BYTES ?? "65536");
}

export {
  capBytes,
  identityOutput,
  LOW_TOOL_CALL_BUDGET,
  LOW_TOOL_CALL_WRAP_UP,
  processOutput,
  remainingAfter,
  stampToolResult,
  withRemainingToolCalls,
} from "./output.js";
export { createToolContext, CancelEvent } from "./types.js";
export type { Tool, ToolContext } from "./types.js";
export { encodeSpec, HELPER } from "./browser.js";
export { formatExecution, runCommand } from "./shell.js";
export { dynamicScriptTools, firstClassScriptSchemas } from "./script.js";
