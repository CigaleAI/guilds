import { Writable } from "node:stream";
import {
  AbortError,
  Fastbrowse,
  FastbrowseError,
  type BrowserEvent,
  type RunOptions,
  type RunResult,
  type StartOptions,
  type StepEvent,
} from "fastbrowse";
import type { BrowserUsageMetadata } from "../db/schema/index.js";
import { errorMessage, errorName, writeLog, type LogFields } from "../observability/log.js";
import { openCdpBridge, type CdpTarget } from "./bridge.js";
import { browserUsageOf } from "./cost.js";
import { formatBrowseResult, formatStep } from "./format.js";

/** The kind of value a requested field holds. */
export type BrowseFieldType = "string" | "number" | "integer" | "boolean";

/** The JSON Schema of the fields a browse run extracts: a flat object whose every field is required. */
export type BrowseOutputSchema = {
  type: "object";
  properties: Record<string, { type: BrowseFieldType; description?: string }>;
  required: string[];
  additionalProperties: false;
};

/** One browse task as the model asked for it. */
export type BrowseRequest = {
  task: string;
  /** The http or https address to start on; null to continue from the current page or infer one from the task. */
  start: string | null;
  /** Whether the run may take irreversible actions without stopping at `needs_confirmation`. */
  authorize: boolean;
  /** The fields to extract; null when none were asked for. */
  output: BrowseOutputSchema | null;
  max_steps: number;
  max_seconds: number;
};

/** What a browse call reports on its result. */
export type BrowseMetadata = {
  status: string;
  final_url: string | null;
  steps: number;
  browser_usage?: BrowserUsageMetadata;
};

/** A browse call's result: the text the model reads, and its metadata. */
export type BrowseOutcome = { text: string; metadata: BrowseMetadata };

/** One running fastbrowse process, as the runner drives it. */
export type FastbrowseSession = {
  run(task: string, options: RunOptions): Promise<RunResult>;
  close(): Promise<void>;
};

/** Starts fastbrowse processes: the SDK's own, or a fake in a test. */
export type FastbrowseLauncher = {
  start(options: StartOptions): Promise<FastbrowseSession>;
};

/** The SDK's launcher: each start runs the fastbrowse binary of the installed platform package. */
export const FASTBROWSE: FastbrowseLauncher = {
  start: (options) => Fastbrowse.start(options),
};

/**
 * What one browse call runs with: fastbrowse's environment, the browser model it is priced by,
 * the agent's DevTools relay, the signal that stops it, where each step is reported, and the
 * fields its log lines carry.
 */
export type BrowseContext = {
  env: Record<string, string>;
  model: string;
  target: CdpTarget;
  signal: AbortSignal;
  onStep(text: string): Promise<void>;
  log: LogFields;
};

/** Fastbrowse could not run the task: it refused the request or its process ended. */
export class BrowseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrowseError";
  }
}

/** Fastbrowse's stderr, each chunk a debug log line. */
function fastbrowseLog(fields: LogFields): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      writeLog("debug", String(chunk).trimEnd(), { ...fields, operation: "browse.fastbrowse" });
      done();
    },
  });
}

/** The outcome of a run its signal stopped: past its time limit, or cancelled with the run. */
function stoppedOutcome(reason: unknown, steps: number): BrowseOutcome {
  if (reason instanceof DOMException && reason.name === "TimeoutError") {
    return { text: "ERROR: browse stopped at its time limit", metadata: { status: "timed_out", final_url: null, steps } };
  }
  return { text: "ERROR: browse cancelled", metadata: { status: "cancelled", final_url: null, steps } };
}

/**
 * Reports one step through `context.onStep`; a report that fails is logged and answers false, so
 * a step the run view misses never stops the run.
 */
async function reportStep(context: BrowseContext, line: string): Promise<boolean> {
  try {
    await context.onStep(line);
    return true;
  } catch (error) {
    writeLog("warn", `a browse step was not reported: ${errorMessage(error)}`, {
      ...context.log,
      operation: "browse.progress",
      error_type: errorName(error),
    });
    return false;
  }
}

/** The run options of a request: its start, fields, limits, and authorization. */
function runOptions(request: BrowseRequest): RunOptions {
  return {
    ...(request.start === null ? {} : { start: request.start }),
    ...(request.output === null ? {} : { output: request.output }),
    limits: { maxSteps: request.max_steps, maxSeconds: request.max_seconds },
    authorization: { irreversibleActions: request.authorize },
  };
}

/**
 * Runs the task on a started fastbrowse, reporting each step in order, and reads its result. A
 * step that fails to report is logged and the run goes on. A run its signal stops counts no
 * usage, since fastbrowse answers no result, and its spend is logged as uncounted.
 */
async function runTask(
  fastbrowse: FastbrowseSession,
  context: BrowseContext,
  request: BrowseRequest,
): Promise<BrowseOutcome> {
  let steps = 0;
  let reported = Promise.resolve(true);
  const onEvent = (event: StepEvent | BrowserEvent): void => {
    if (event.type !== "step") {
      return;
    }
    steps += 1;
    const line = formatStep(event.step);
    reported = reported.then(() => reportStep(context, line));
  };
  let result: RunResult;
  try {
    result = await fastbrowse.run(request.task, { ...runOptions(request), onEvent, signal: context.signal });
  } catch (error) {
    await reported;
    if (error instanceof AbortError) {
      writeLog(
        "warn",
        `a stopped browse run's Jev and LLM spend is not counted, since fastbrowse answers no result on abort (steps: ${steps})`,
        { ...context.log, operation: "browse.cost" },
      );
      return stoppedOutcome(context.signal.reason, steps);
    }
    if (error instanceof FastbrowseError) {
      throw new BrowseError(`the agent-optimized browser failed: ${error.message}`, { cause: error });
    }
    throw error;
  }
  await reported;
  return {
    text: formatBrowseResult(result),
    metadata: {
      status: result.status,
      final_url: result.final_url,
      steps: result.steps.length,
      browser_usage: browserUsageOf(context.model, result.cost.lines),
    },
  };
}

/**
 * Runs one browse task on the agent's Chrome: opens a loopback bridge to its DevTools relay,
 * starts fastbrowse attached to that Chrome in the foreground, and runs the task. Fastbrowse and
 * the bridge are closed however the run ends. A run its signal stops answers an `ERROR:` text
 * with no usage; a request fastbrowse refuses throws a `BrowseError`.
 */
export async function runBrowse(
  launcher: FastbrowseLauncher,
  context: BrowseContext,
  request: BrowseRequest,
): Promise<BrowseOutcome> {
  const bridge = await openCdpBridge(context.target);
  try {
    const fastbrowse = await launcher.start({
      env: context.env,
      cdpPort: bridge.port,
      attach: true,
      foreground: true,
      stderr: fastbrowseLog(context.log),
    });
    try {
      return await runTask(fastbrowse, context, request);
    } finally {
      await fastbrowse.close();
    }
  } finally {
    await bridge.close();
  }
}
