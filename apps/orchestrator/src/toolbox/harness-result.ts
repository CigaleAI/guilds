import type { Harness } from "../db/schema/index.js";
import type { HarnessExit } from "./harness-ops.js";

/** The last five lines of a CLI's stderr; empty when it printed none. */
function stderrTail(stderr = ""): string {
  return stderr.trim().split("\n").slice(-5).join("\n");
}

/** The first line of a CLI's error text; empty when it gave none. */
function firstLine(text = ""): string {
  return text.split("\n")[0] ?? "";
}

/** Why a turn failed. A CLI that printed no event, such as one refusing to start without a login, says why on stderr. */
export function failureDetail(harness: Harness, result: HarnessExit, version: string | null): string {
  const events = result.events ?? 0;
  if (events === 0 && (result.unparsed ?? 0) > 0) {
    return `error: the ${harness} driver does not parse this CLI's output (${version ?? "unknown version"})`;
  }
  const stderr = stderrTail(result.stderr);
  const error = firstLine(result.error);
  const reasons = events === 0 ? [stderr, error] : [error, stderr];
  return `error: ${reasons.find(Boolean) ?? `exited with code ${String(result.exit_code ?? "unknown")}`}`;
}
