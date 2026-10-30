import { exitCodeOf, type CommandResult } from "../sandbox/sdk.js";
import type { ToolHooks, ToolInvocation, ToolRun } from "./types.js";

export const COMMAND_TIMEOUT_SECONDS = 120;

export function formatExecution(execution: CommandResult): string {
  const stdout = (execution.logs?.stdout ?? []).map((message) => message.text ?? "").join("\n");
  const stderr = (execution.logs?.stderr ?? []).map((message) => message.text ?? "").join("\n");
  const chunks = [stdout, stderr].filter((part) => part);
  const text = chunks.join("\n");
  const code = exitCodeOf(execution);
  if (code !== 0 && code !== undefined) {
    const suffix = `exit_code: ${code}`;
    return text ? `${text}\n${suffix}` : suffix;
  }
  return text;
}

/** How a sandbox command runs: how long it may take, and the variables its environment gains. */
export type CommandSettings = { timeoutSeconds?: number; envs?: Record<string, string> };

/** The output of the command `call` ran, as the agent reads it; the command's exit code is kept on the call. */
export function commandOutput(call: ToolInvocation, execution: CommandResult): string {
  call.exit_code = exitCodeOf(execution) ?? null;
  return formatExecution(execution);
}

/**
 * Runs one sandbox command of `run`, interruptible by the run's cancel event and tracked with
 * the run's `track_command` hook, and returns it unformatted.
 */
export async function executeCommand(
  run: ToolRun,
  hooks: ToolHooks,
  command: string,
  options: CommandSettings = {},
): Promise<CommandResult> {
  if (!run.sandbox) {
    throw new Error("sandbox is not available");
  }
  const timeoutSeconds = options.timeoutSeconds ?? COMMAND_TIMEOUT_SECONDS;
  const opts: Record<string, unknown> = {
    workingDirectory: run.agent_home,
    working_directory: run.agent_home,
    timeout: timeoutSeconds,
    timeoutSeconds,
  };
  if (options.envs) {
    opts.envs = options.envs;
  }
  const track = hooks.track_command;
  const handlers =
    run.cancel_event !== null && track !== null
      ? {
          onInit: async (init: { id?: string }) => {
            const executionId = init.id;
            if (typeof executionId === "string" && executionId) {
              track(executionId);
            }
          },
        }
      : undefined;
  const runPromise = run.sandbox.commands.run(command, opts, handlers);
  try {
    let execution: CommandResult;
    if (run.cancel_event === null) {
      execution = await runPromise;
    } else {
      const waitAbort = new AbortController();
      try {
        const winner = await Promise.race([
          runPromise.then((result) => ({ kind: "run" as const, result })),
          run.cancel_event.wait(waitAbort.signal).then(
            () => ({ kind: "cancel" as const }),
            () => ({ kind: "wait-aborted" as const }),
          ),
        ]);
        if (winner.kind === "cancel") {
          void runPromise.catch(() => undefined);
          throw new Error("execution interrupted");
        }
        if (winner.kind === "wait-aborted") {
          execution = await runPromise;
        } else {
          execution = winner.result;
        }
      } finally {
        waitAbort.abort();
      }
    }
    return execution;
  } finally {
    if (track !== null) {
      track(null);
    }
  }
}
