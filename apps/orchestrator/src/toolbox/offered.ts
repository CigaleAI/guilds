import { BROWSER_TOOLS, OPTIMIZED_BROWSER_TOOLS } from "./browser.js";
import { CODING_TOOLS } from "./code.js";
import { HARNESS_TOOLS } from "./harness.js";
import { SCHEDULE_TOOLS } from "./schedule.js";
import { SCRIPT_TOOLS } from "./script.js";

// Which native tools a run offers: the names the bindings turn on, less the
// ones the agent's switches withhold, plus the tools its switches add. With the
// browser on, the run offers the step-by-step browser tools, or `browse` and
// `browser_eval` when the agent-optimized browser is on.

/** The agent's switches that change which native tools a run offers; one left out is the default. */
export type ToolSwitches = {
  browser?: boolean;
  /** Whether the browser offers `browse` in place of the step-by-step tools; only read with `browser` on. */
  browserOptimized?: boolean;
  coding?: boolean;
  scripting?: boolean;
  memory?: boolean;
  schedules?: boolean;
  direct?: boolean;
};

/** The tools the browser and coding switches offer, whatever the bindings say. */
const BROWSER_AND_CODING_TOOLS: ReadonlySet<string> = new Set<string>([
  ...BROWSER_TOOLS,
  ...OPTIMIZED_BROWSER_TOOLS,
  ...CODING_TOOLS,
  ...HARNESS_TOOLS,
]);

function nameMatchesToolList(name: string, tools: readonly string[] | string): boolean {
  return typeof tools === "string" ? name === tools : tools.includes(name);
}

function isHiddenByOfferedFlag(name: string, options: ToolSwitches): boolean {
  const gates: Array<[boolean, readonly string[] | string]> = [
    [options.scripting !== false, SCRIPT_TOOLS],
    [options.memory !== false, "memory_write"],
    [Boolean(options.schedules), SCHEDULE_TOOLS],
    [Boolean(options.direct), "secret_request"],
  ];
  return gates.some(([allowed, tools]) => !allowed && nameMatchesToolList(name, tools));
}

function offeredNativeNames(names: string[], options: ToolSwitches): string[] {
  return names.filter((name) => {
    if (name === "report_issue" || BROWSER_AND_CODING_TOOLS.has(name)) {
      return false;
    }
    return !isHiddenByOfferedFlag(name, options);
  });
}

/** The browser tools the switches offer: none with the browser off, else those of its mode. */
function browserToolNames(options: ToolSwitches): readonly string[] {
  if (!options.browser) {
    return [];
  }
  return options.browserOptimized ? OPTIMIZED_BROWSER_TOOLS : BROWSER_TOOLS;
}

function capabilityToolNames(options: ToolSwitches): string[] {
  return [...(options.coding ? [...CODING_TOOLS, ...HARNESS_TOOLS] : []), ...browserToolNames(options)];
}

// The browser and code tools follow the agent's flags, not bindings.
export function offeredToolNames(names: string[], options: ToolSwitches = {}): string[] {
  const offered = offeredNativeNames(names, options);
  for (const name of capabilityToolNames(options)) {
    if (!offered.includes(name)) {
      offered.push(name);
    }
  }
  offered.push("report_issue");
  return offered;
}
