import { ownerRefs } from "../db/columns.js";
import type { ConfigChange, ConfigOperation } from "../db/config-changes.js";
import { isCatalogKind, type CatalogKind } from "./index.js";

/** A binding's identity: what it sets and at which scope. */
export type BindingKey = {
  catalogKind: string;
  catalogId: string;
  scope: string;
  scopeId: string | null;
};

/** The word a change's summary calls each kind of catalog item by. */
const KIND_WORDS: Record<CatalogKind, string> = {
  native_tool: "tool",
  mcp: "connector",
  mcp_tool: "tool",
};

function bindingLabel(key: BindingKey): string {
  const word = isCatalogKind(key.catalogKind) ? KIND_WORDS[key.catalogKind] : key.catalogKind;
  return `${word} ${key.catalogId}`;
}

function bindingOperation(before: boolean | null, after: boolean | null): ConfigOperation {
  if (after === null) {
    return "delete";
  }
  return before === null ? "create" : "update";
}

function bindingSummary(key: BindingKey, after: boolean | null): string {
  if (after === null) {
    return `Reset ${bindingLabel(key)} to inherit`;
  }
  return `Turned ${after ? "on" : "off"} ${bindingLabel(key)}`;
}

/**
 * The change-log entry for a binding set from `before` to `after`, where null
 * is no binding (the scope inherits). Null for a platform binding, which no
 * organisation owns, and when nothing changed.
 */
export function bindingChange(
  key: BindingKey,
  before: boolean | null,
  after: boolean | null,
): ConfigChange | null {
  const [orgId, guildId, agentId] = ownerRefs(key.scope, key.scopeId);
  const owned = [orgId, guildId, agentId].some(Boolean);
  if (!owned || before === after) {
    return null;
  }
  return {
    orgId,
    guildId,
    agentId,
    targetKind: "access",
    targetId: key.catalogId,
    operation: bindingOperation(before, after),
    summary: bindingSummary(key, after),
  };
}
