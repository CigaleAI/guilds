import { exitCodeOf, type CommandInit, type CommandOptions, type CommandResult } from "../sandbox/sdk.js";
import type { CancelEvent, ToolHooks, ToolInvocation, ToolRun } from "./types.js";
import { SandboxCommandError, ToolUnavailableError } from "./errors.js";

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
 * Runs one sandbox command of `run`, once the run's `before_command` hook has run, interruptible
 * by the run's cancel event and tracked with the run's `track_command` hook, and returns it
 * unformatted.
 */
export async function executeCommand(
  run: ToolRun,
  hooks: ToolHooks,
  command: string,
  options: CommandSettings = {},
): Promise<CommandResult> {
  if (!run.sandbox) {
    throw new ToolUnavailableError("sandbox is not available");
  }
  await hooks.before_command?.();
  const timeoutSeconds = options.timeoutSeconds ?? COMMAND_TIMEOUT_SECONDS;
  const opts: CommandOptions = {
    workingDirectory: run.agent_home,
    timeoutSeconds,
    ...(options.envs ? { envs: options.envs } : {}),
  };
  const track = hooks.track_command;
  const handlers =
    run.cancel_event !== null && track !== null
      ? {
          onInit: async (init: CommandInit) => {
            if (init.id) {
              track(init.id);
            }
          },
        }
      : undefined;
  const runPromise = run.sandbox.commands.run(command, opts, handlers);
  try {
    return run.cancel_event === null ? await runPromise : await untilCancelled(runPromise, run.cancel_event);
  } finally {
    if (track !== null) {
      track(null);
    }
  }
}

/** The command's result, unless `cancel` fires first, which throws `SandboxCommandError` "execution interrupted". */
async function untilCancelled(runPromise: Promise<CommandResult>, cancel: CancelEvent): Promise<CommandResult> {
  const waitAbort = new AbortController();
  try {
    const winner = await Promise.race([
      runPromise.then((result) => ({ kind: "run" as const, result })),
      cancel.wait(waitAbort.signal).then(
        () => ({ kind: "cancel" as const }),
        () => ({ kind: "wait-aborted" as const }),
      ),
    ]);
    if (winner.kind === "cancel") {
      void runPromise.catch(() => undefined);
      throw new SandboxCommandError("execution interrupted");
    }
    return winner.kind === "wait-aborted" ? await runPromise : winner.result;
  } finally {
    waitAbort.abort();
  }
}
