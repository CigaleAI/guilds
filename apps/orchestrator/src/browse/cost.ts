import type { CostLine } from "fastbrowse";
import type { BrowserUsageMetadata } from "../db/schema/index.js";
import { catalogCostUsd } from "../llm/cost.js";
import { writeLog } from "../observability/log.js";

/** The dollars of one cost line: its own when fastbrowse priced it, else the model catalog's for an LLM line, else 0. */
function lineDollars(model: string, line: CostLine): number {
  if (line.dollars !== null) {
    return line.dollars;
  }
  if (line.component === "llm") {
    const usage = { input_tokens: line.input_tokens, output_tokens: line.output_tokens, cache_read_tokens: 0 };
    return catalogCostUsd(model, usage).cost_usd;
  }
  writeLog("warn", `a ${line.component} cost line of ${line.basis} basis has no dollars; it counts 0`, {
    operation: "browse.cost",
  });
  return 0;
}

/**
 * What one browse run spent on Jev and on the browser model (`model`), from fastbrowse's cost
 * lines. Browser and proxy lines are not counted.
 */
export function browserUsageOf(model: string, lines: readonly CostLine[]): BrowserUsageMetadata {
  const usage: BrowserUsageMetadata = {
    model,
    jev_input_tokens: 0,
    jev_output_tokens: 0,
    jev_cost_usd: 0,
    llm_input_tokens: 0,
    llm_output_tokens: 0,
    llm_cost_usd: 0,
    cost_usd: 0,
  };
  for (const line of lines) {
    if (line.component === "jev") {
      usage.jev_input_tokens += line.input_tokens;
      usage.jev_output_tokens += line.output_tokens;
      usage.jev_cost_usd += lineDollars(model, line);
    } else if (line.component === "llm") {
      usage.llm_input_tokens += line.input_tokens;
      usage.llm_output_tokens += line.output_tokens;
      usage.llm_cost_usd += lineDollars(model, line);
    }
  }
  usage.cost_usd = usage.jev_cost_usd + usage.llm_cost_usd;
  return usage;
}
