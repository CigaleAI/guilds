import type { CostLine, RunOptions, RunResult, StartOptions, StepResult } from "fastbrowse";
import type { FastbrowseLauncher, FastbrowseSession } from "../../src/browse/runner.js";

/** A cost line of fastbrowse's, metered at $0 with no tokens unless `overrides` says otherwise. */
export function costLine(overrides: Partial<CostLine>): CostLine {
  return {
    component: "llm",
    basis: "metered",
    dollars: 0,
    purpose: null,
    input_tokens: 0,
    output_tokens: 0,
    seconds: null,
    ...overrides,
  };
}

/** A fastbrowse result: a complete run with nothing in it unless `overrides` says otherwise. */
export function runResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    status: "complete",
    budget: null,
    answer: null,
    data: null,
    evidence: [],
    steps: [],
    cost: { lines: [] },
    artifacts: [],
    citations: [],
    error: null,
    final_url: null,
    recordings: [],
    wall: null,
    ...overrides,
  };
}

/** One executed click step on a cart page unless `overrides` says otherwise. */
export function stepResult(overrides: Partial<StepResult> = {}): StepResult {
  return {
    index: 0,
    operation: "click",
    decided_by: "jev",
    outcome: "executed",
    url: "https://shop.test/cart",
    target: null,
    confidence: null,
    note: null,
    facts: [],
    page_changed: true,
    duration_ms: 12,
    ...overrides,
  };
}

/** What a fake fastbrowse run does with the task and options it is given. */
export type FakeRun = (task: string, options: RunOptions) => Promise<RunResult>;

/** A fastbrowse launcher whose processes run `run`, recording each start, run, and close in `calls`. */
export class FakeFastbrowse implements FastbrowseLauncher {
  calls: string[] = [];
  started: StartOptions[] = [];
  runs: Array<{ task: string; options: RunOptions }> = [];

  constructor(private readonly run: FakeRun) {}

  async start(options: StartOptions): Promise<FastbrowseSession> {
    this.calls.push("start");
    this.started.push(options);
    return {
      run: async (task, runOptions) => {
        this.calls.push("run");
        this.runs.push({ task, options: runOptions });
        return this.run(task, runOptions);
      },
      close: async () => {
        this.calls.push("close");
      },
    };
  }
}
