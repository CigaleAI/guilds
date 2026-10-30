import type { RunResult, StepResult } from "fastbrowse";

/** The citations of an answer, one line each: its number as the answer marks it, the quote, and its page. */
function formatCitations(result: RunResult): string[] {
  if (!result.citations.length) {
    return [];
  }
  return ["Citations:", ...result.citations.map((citation) => `[${citation.id}] "${citation.quote}" — ${citation.url}`)];
}

/** Where a run that stopped was stopped: the wall it met, the budget it spent, and its error. */
function formatStop(result: RunResult): string[] {
  const lines: string[] = [];
  if (result.wall !== null) {
    const fields = result.wall.fields.length ? ` (fields: ${result.wall.fields.join(", ")})` : "";
    lines.push(`Wall: ${result.wall.kind} at ${result.wall.origin}${fields}`);
  }
  if (result.budget !== null) {
    lines.push(`Budget: ${result.budget.resource} limit ${result.budget.limit} reached`);
  }
  if (result.error) {
    lines.push(`Error: ${result.error}`);
  }
  return lines;
}

/**
 * A browse run's result as the model reads it: its status, the page it ended on, the answer with
 * the `[n]` markers fastbrowse wrote, the quotes those markers cite, the extracted data, and the
 * wall, budget, or error it stopped at.
 */
export function formatBrowseResult(result: RunResult): string {
  const lines = [`Status: ${result.status}`];
  if (result.final_url) {
    lines.push(`Final URL: ${result.final_url}`);
  }
  if (result.answer) {
    lines.push("Answer:", result.answer);
  }
  lines.push(...formatCitations(result));
  if (result.data !== null && result.data !== undefined) {
    lines.push("Data:", JSON.stringify(result.data, null, 2));
  }
  lines.push(...formatStop(result));
  return lines.join("\n");
}

/** One browser action as a progress line: what it did, on which control, on which page, how it ended, and its note. */
export function formatStep(step: StepResult): string {
  const target = step.target ? ` "${step.target}"` : "";
  const outcome = step.outcome === "executed" ? "" : ` (${step.outcome})`;
  const note = step.note ? ` — ${step.note}` : "";
  return `${step.operation}${target} at ${step.url}${outcome}${note}`;
}
