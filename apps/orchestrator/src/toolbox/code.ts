import { Buffer } from "node:buffer";
import { Type } from "typebox";
import { keepMatching } from "../lib/decode.js";
import { isJsonObject, isObjectNode, type JsonObject } from "../lib/json.js";
import { stderrOf, stdoutOf, type CommandResult } from "../sandbox/sdk.js";
import { executeCommand } from "./shell.js";
import type { ToolHooks, ToolRun } from "./types.js";
import { SandboxCommandError, ToolLimitError } from "./errors.js";

// The sandbox helpers the orchestrator runs on an agent's machine: `guilds-code` for its
// repositories and sizes, `guilds-harness` for its harness. The orchestrator never opens a
// workspace file for them, so a link in the workspace resolves inside the container.

export const CODE_HELPER = "/usr/local/bin/guilds-code";
export const HARNESS_HELPER = "/usr/local/bin/guilds-harness";
export const CODE_REQUEST_DIR = "/run/guilds/requests";
/** Longest base64 request passed on the command line; a larger one goes through the file API. */
export const INLINE_REQUEST_MAX = 64 * 1024;
export const CODE_HELPER_TIMEOUT_SECONDS = 120;

export function codeResultMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.CODE_RESULT_MAX_BYTES ?? "8192");
  return Number.isInteger(value) && value >= 1024 ? value : 8192;
}

export type CodeResult = { text: string; meta: JsonObject };

/** A call id as a file name: providers may use characters a path segment cannot hold. */
export function callSegment(callId: string): string {
  const cleaned = callId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 96);
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : `call_${Date.now()}`;
}

/** What a sandbox helper prints: whether its op succeeded, its text and meta, and its error text when it says one. */
export type HelperEnvelope = { ok: boolean; text: string; meta: JsonObject; error: string | null };

/** The fields of an envelope the helper printed, each one kept when it holds what the envelope puts there. */
const EnvelopeFields = Type.Object({
  ok: Type.Optional(Type.Boolean()),
  text: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
});

/** The envelope a helper printed as base64 JSON; throws when it is not a JSON object. */
export function decodeEnvelope(stdout: string): HelperEnvelope {
  const compact = stdout.replace(/\s+/g, "");
  const decoded: unknown = JSON.parse(Buffer.from(compact, "base64").toString("utf8"));
  if (!isJsonObject(decoded)) {
    throw new SandboxCommandError("code helper returned a non-object");
  }
  const fields = keepMatching(EnvelopeFields, decoded) ?? {};
  const meta = decoded.meta;
  return {
    ok: fields.ok === true,
    text: fields.text ?? "",
    meta: meta !== undefined && isObjectNode(meta) ? meta : {},
    error: fields.error || null,
  };
}

/** A request as a helper is sent it: the op's own fields, and the run and call it runs for. */
type SentRequest = HelperRequest & { run_id: string; agent_id: string; call_id: string; max_bytes: number };

/** The command that runs `helper` on `request`: inline, or through a request file when it is too large. */
async function helperCommand(run: ToolRun, helper: string, request: SentRequest): Promise<string> {
  const encoded = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
  if (encoded.length <= INLINE_REQUEST_MAX) {
    return `python3 ${helper} ${encoded}`;
  }
  return requestFileCommand(run, helper, request);
}

/**
 * The command that runs `helper` on `request` written to a request file through the sandbox's
 * file API; the helper reads the file and removes it.
 */
async function requestFileCommand(run: ToolRun, helper: string, request: SentRequest): Promise<string> {
  const files = run.sandbox?.files;
  if (!files) {
    throw new ToolLimitError("this sandbox takes no request file");
  }
  const requestPath = `${CODE_REQUEST_DIR}/${run.run_id}-${request.call_id}.json`;
  await files.writeFiles([{ path: requestPath, data: JSON.stringify(request) }]);
  return `python3 ${helper} @${requestPath}`;
}

/** The helper's result from its envelope; throws with its error text, or with stderr when it printed no envelope. */
function helperResult(execution: CommandResult): CodeResult {
  let envelope: HelperEnvelope;
  try {
    envelope = decodeEnvelope(stdoutOf(execution));
  } catch {
    const detail = stderrOf(execution).split("\n").slice(-5).join("\n");
    throw new SandboxCommandError(`code helper failed${detail ? `: ${detail}` : ""}`);
  }
  if (!envelope.ok) {
    throw new SandboxCommandError(envelope.error ?? "code helper failed");
  }
  return { text: envelope.text, meta: envelope.meta };
}

/** A request a sandbox helper reads: its op, the call it runs for when there is one, and the op's own fields. */
export type HelperRequest = JsonObject & { op: string; call_id?: string };

/** How a helper request runs: which helper, how long it may take, and how many bytes its text keeps. */
export type HelperSettings = { timeoutSeconds?: number; maxBytes?: number; helper?: string };

/**
 * Runs one op of a sandbox helper (`guilds-code` unless `helper` names another). The request
 * travels base64 on the command line, or through the sandbox file API when it is too large
 * for one argument. Throws with the helper's error text.
 */
export async function runCodeHelper(
  run: ToolRun,
  hooks: ToolHooks,
  request: HelperRequest,
  options: HelperSettings = {},
): Promise<CodeResult> {
  const command = await helperCommand(run, options.helper ?? CODE_HELPER, sentRequest(run, request, options));
  return helperResult(await executeHelper(run, hooks, command, options));
}

/**
 * Runs one op of a sandbox helper on a request that holds a credential: the request always
 * travels through a request file under `/run/guilds`, which only root reads and the helper
 * removes once read, and never on a command line, where any process on the machine sees it.
 */
export async function runCodeHelperFromFile(
  run: ToolRun,
  hooks: ToolHooks,
  request: HelperRequest,
  options: HelperSettings = {},
): Promise<CodeResult> {
  const command = await requestFileCommand(run, options.helper ?? CODE_HELPER, sentRequest(run, request, options));
  return helperResult(await executeHelper(run, hooks, command, options));
}

/** A request as the helper is sent it, for the run and the call it names. */
function sentRequest(run: ToolRun, request: HelperRequest, options: HelperSettings): SentRequest {
  return {
    ...request,
    run_id: run.run_id,
    agent_id: run.agent_id,
    call_id: callSegment(request.call_id || `${request.op}_${Date.now()}`),
    max_bytes: options.maxBytes ?? codeResultMaxBytes(),
  };
}

/** Runs a helper's command in the run's sandbox, within the op's time. */
function executeHelper(run: ToolRun, hooks: ToolHooks, command: string, options: HelperSettings): Promise<CommandResult> {
  return executeCommand(run, hooks, command, {
    timeoutSeconds: options.timeoutSeconds ?? CODE_HELPER_TIMEOUT_SECONDS,
  });
}

/** The size of the agent's home in MiB, measured with `du` inside the sandbox. */
export async function measureWorkspace(run: ToolRun, hooks: ToolHooks): Promise<number> {
  return measured(await runCodeHelper(run, hooks, { op: "workspace_size" }));
}

/** The size of the agent's machine's directory in MiB: every home on it. */
export async function measureMachine(run: ToolRun, hooks: ToolHooks): Promise<number> {
  return measured(await runCodeHelper(run, hooks, { op: "machine_size" }));
}

function measured(result: CodeResult): number {
  const mib = Number(result.meta.mib);
  if (!Number.isFinite(mib)) {
    throw new SandboxCommandError("workspace size is unavailable");
  }
  return mib;
}
