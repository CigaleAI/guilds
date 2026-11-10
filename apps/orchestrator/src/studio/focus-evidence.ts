import { wrapEvidence, type EvidenceAttributes } from "../conversation/trust.js";
import type { AgentRow } from "../db/agents.js";
import type { RunRow } from "../db/runs.js";
import type { StudioFocus, StudioFocusKind } from "../db/schema/index.js";
import { capBytes } from "../lib/bytes.js";
import { STUDIO_FOCUS_EXCERPT_BYTES } from "./constants.js";

// What every focus pin's evidence is built from: the focus it stores and the block the coach reads.

/** A focus pin as the server resolved it: the focus it stores, and the evidence block the coach reads. */
export type ResolvedFocus = { focus: StudioFocus; content: string };

/** What each kind of run is called in a pin's label and evidence. */
export const RUN_KIND_LABELS: Record<RunRow["kind"], string> = {
  direct: "Direct run",
  group: "Group delivery",
  schedule: "Schedule wake-up",
};

export function excerpt(text: string): string {
  return capBytes(text, STUDIO_FOCUS_EXCERPT_BYTES)[0];
}

/** `lines` with each blank line that follows another blank line dropped. */
export function withoutRepeatedBlankLines(lines: string[]): string[] {
  return lines.filter((line, index) => line !== "" || lines[index - 1] !== "");
}

/** A focus of `kind` on `agent`, or on no agent, naming none of the ids a pin can carry. */
export function emptyFocus(kind: StudioFocusKind, agent: AgentRow | null): StudioFocus {
  return {
    kind,
    agent_id: agent?.id ?? null,
    agent_name: agent?.name ?? null,
    label: "",
    run_id: null,
    seq: null,
    call_id: null,
    tool_name: null,
    revision_id: null,
    version_index: null,
    schedule_id: null,
    display_path: null,
    change_id: null,
    issue_id: null,
  };
}

export function evidenceBlock(
  source: string,
  coordinates: EvidenceAttributes,
  body: string,
  tail: string,
): string {
  return `${wrapEvidence({ source, coordinates, body })}\n\n${tail}`;
}
