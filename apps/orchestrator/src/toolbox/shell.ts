import type { CommandResult, ToolContext } from "./types.js";

export const COMMAND_TIMEOUT_SECONDS = 120;

export function formatExecution(execution: CommandResult): string {
  const stdout = (execution.logs?.stdout ?? []).map((message) => message.text ?? "").join("\n");
  const stderr = (execution.logs?.stderr ?? []).map((message) => message.text ?? "").join("\n");
  const chunks = [stdout, stderr].filter((part) => part);
  const text = chunks.join("\n");
  const code = execution.exit_code ?? execution.exitCode;
  if (code !== 0 && code !== null && code !== undefined) {
    const suffix = `exit_code: ${code}`;
    return text ? `${text}\n${suffix}` : suffix;
  }
  return text;
}

export async function runCommand(ctx: ToolContext, command: string, options: {
  timeoutSeconds?: number;
  envs?: Record<string, string>;
} = {}): Promise<string> {
  const execution = await executeCommand(ctx, command, options);
  ctx.exit_code = execution.exit_code ?? execution.exitCode ?? null;
  return formatExecution(execution);
}

/** Runs one sandbox command, interruptible by the run's cancel event, and returns it unformatted. */
export async function executeCommand(ctx: ToolContext, command: string, options: {
  timeoutSeconds?: number;
  envs?: Record<string, string>;
} = {}): Promise<CommandResult> {
  if (!ctx.sandbox) {
    throw new Error("sandbox is not available");
  }
  const timeoutSeconds = options.timeoutSeconds ?? COMMAND_TIMEOUT_SECONDS;
  const opts: Record<string, unknown> = {
    workingDirectory: "/home/agent",
    working_directory: "/home/agent",
    timeout: timeoutSeconds,
    timeoutSeconds,
  };
  if (options.envs) {
    opts.envs = options.envs;
  }
  const handlers =
    ctx.cancel_event !== null && ctx.track_command !== null
      ? {
          onInit: async (init: { id?: string }) => {
            const executionId = init.id;
            if (typeof executionId === "string" && executionId) {
              ctx.track_command!(executionId);
            }
          },
        }
      : undefined;
  const runPromise = ctx.sandbox.commands.run(command, opts, handlers);
  try {
    let execution: CommandResult;
    if (ctx.cancel_event === null) {
      execution = await runPromise;
    } else {
      const waitAbort = new AbortController();
      try {
        const winner = await Promise.race([
          runPromise.then((result) => ({ kind: "run" as const, result })),
          ctx.cancel_event.wait(waitAbort.signal).then(
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
    if (ctx.track_command !== null) {
      ctx.track_command(null);
    }
  }
}
