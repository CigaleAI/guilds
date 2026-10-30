import type { AccessEdit } from "../../../api/types/recipes";
import { plural } from "./recipeDraft";

/** Tool switches and connector removals the operator has made but not yet validated. */
export type PendingAccess = { tools: Map<string, boolean>; removed: Set<string> };

/** The key a pending tool switch is stored under. */
export function toolKey(server: string, roleId: string, tool: string): string {
  return `${server}\t${roleId}\t${tool}`;
}

/** An empty set of pending access edits. */
export function emptyPendingAccess(): PendingAccess {
  return { tools: new Map(), removed: new Set() };
}

/** The access edits pending switches and removals amount to; tool switches on removed connectors drop out. */
export function pendingAccessEdits(pending: PendingAccess): AccessEdit[] {
  const edits: AccessEdit[] = [];
  for (const [key, enabled] of pending.tools) {
    const [server = "", role = "", tool = ""] = key.split("\t");
    if (pending.removed.has(server)) continue;
    edits.push({ action: "set_tool", server, role, tool, enabled });
  }
  for (const server of pending.removed) {
    edits.push({ action: "remove_connection", server });
  }
  return edits;
}

/** The pending access line: tools switched off and connectors removed; null when nothing is pending. */
export function pendingAccessSummary(pending: PendingAccess): {
  edits: AccessEdit[];
  removedTools: number;
  removedConnectors: number;
  text: string;
  removed: string[];
} | null {
  const edits = pendingAccessEdits(pending);
  if (!edits.length) return null;
  const removedTools = edits.filter(
    (item) => item.action === "set_tool" && item.enabled === false,
  ).length;
  const removedConnectors = edits.filter((item) => item.action === "remove_connection").length;
  return {
    edits,
    removedTools,
    removedConnectors,
    text: `Pending: ${plural(removedTools, "tool")} and ${plural(removedConnectors, "connector")} removed. Validate to save and tell the coach.`,
    removed: [...pending.removed],
  };
}
