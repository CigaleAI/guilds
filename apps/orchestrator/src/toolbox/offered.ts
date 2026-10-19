import { BROWSER_TOOLS } from "./browser.js";
import { CODING_TOOLS } from "./code.js";
import { HARNESS_TOOLS } from "./harness.js";
import { SCHEDULE_TOOLS } from "./schedule.js";
import { SCRIPT_TOOLS } from "./script.js";

// Which native tools a run offers: the names the bindings turn on, less the
// ones the agent's switches withhold, plus the tools its switches add.

function isBrowserOrCodingToolName(name: string): boolean {
  return (
    (BROWSER_TOOLS as readonly string[]).includes(name) ||
    (CODING_TOOLS as readonly string[]).includes(name) ||
    (HARNESS_TOOLS as readonly string[]).includes(name)
  );
}

function nameMatchesToolList(name: string, tools: readonly string[] | string): boolean {
  return typeof tools === "string" ? name === tools : tools.includes(name);
}

function isHiddenByOfferedFlag(
  name: string,
  options: {
    scripting?: boolean;
    memory?: boolean;
    schedules?: boolean;
    direct?: boolean;
  },
): boolean {
  const gates: Array<[boolean, readonly string[] | string]> = [
    [options.scripting !== false, SCRIPT_TOOLS],
    [options.memory !== false, "memory_write"],
    [Boolean(options.schedules), SCHEDULE_TOOLS],
    [Boolean(options.direct), "secret_request"],
  ];
  return gates.some(([allowed, tools]) => !allowed && nameMatchesToolList(name, tools));
}

function offeredNativeNames(
  names: string[],
  options: {
    scripting?: boolean;
    memory?: boolean;
    schedules?: boolean;
    direct?: boolean;
  },
): string[] {
  return names.filter((name) => {
    if (name === "report_issue" || isBrowserOrCodingToolName(name)) {
      return false;
    }
    return !isHiddenByOfferedFlag(name, options);
  });
}

function capabilityToolNames(options: { coding?: boolean; browser?: boolean }): string[] {
  return [
    ...(options.coding ? [...CODING_TOOLS, ...HARNESS_TOOLS] : []),
    ...(options.browser ? BROWSER_TOOLS : []),
  ];
}

// The browser and code tools follow the agent's flags, not bindings.
export function offeredToolNames(
  names: string[],
  options: {
    browser?: boolean;
    coding?: boolean;
    scripting?: boolean;
    memory?: boolean;
    schedules?: boolean;
    direct?: boolean;
  } = {},
): string[] {
  const offered = offeredNativeNames(names, options);
  for (const name of capabilityToolNames(options)) {
    if (!offered.includes(name)) {
      offered.push(name);
    }
  }
  offered.push("report_issue");
  return offered;
}
