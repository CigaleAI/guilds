import { DEFAULT_MAX_TOOL_CALLS } from "../agents/config.js";
import { collectDirectoryListing, type DirectoryNotes } from "../directories/index.js";
import { CONTEXT_HISTORY_LIMIT, groupChatHistory } from "../groupchat/history.js";
import type { GuildOperatorRow } from "../db/guilds.js";
import { utcClock } from "../lib/clock.js";
import { environmentCatalog } from "../scripts/validation.js";

function memberEntry(member: unknown): Record<string, string> {
  if (typeof member === "string") {
    return { name: member };
  }
  const record = member as Record<string, unknown>;
  const name = String(record.name);
  const entry: Record<string, string> = { name };
  const focus = String(record.focus ?? "").trim();
  if (focus) {
    entry.focus = focus;
  }
  return entry;
}

/**
 * One State entry per collection the agent can read: its name, purpose, the
 * agent's access, its display path, and its columns.
 */
function collectionEntries(items: unknown[] | null | undefined): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  for (const item of items ?? []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (!("name" in record) || !("purpose" in record)) {
      continue;
    }
    const entry: Record<string, unknown> = { name: record.name, purpose: record.purpose };
    if (record.access === "read" || record.access === "write") {
      entry.access = record.access;
    }
    if (record.scope === "guild" || record.scope === "org") {
      entry.scope = record.scope;
    }
    if (typeof record.display_path === "string" && record.display_path) {
      entry.display_path = record.display_path;
    }
    entry.columns = Array.isArray(record.columns) ? record.columns : [];
    if (record.truncated) {
      entry.truncated = true;
    }
    entries.push(entry);
  }
  return entries;
}

/** The State keys core fills. A connector's State hook may not use one. */
export const CORE_STATE_KEYS: ReadonlySet<string> = new Set([
  "utc_now",
  "utc_date",
  "max_tool_calls",
  "group",
  "collections",
  "scripts",
  "environment",
  "repositories",
]);

/** What a run's State is built from, besides the agent's notes. */
export type RunStateInputs = {
  members: unknown[];
  operators?: GuildOperatorRow[];
  historyRows: Array<Record<string, unknown>>;
  guildAbout?: string;
  guildDescription?: string;
  collections?: unknown[] | null;
  secrets?: Array<Record<string, unknown>> | null | undefined;
  scripts?: unknown[] | null | undefined;
  maxToolCalls?: number;
  /** The entries connectors' State hooks returned, by key. A key core uses is not one of them. */
  connectors?: Record<string, unknown>;
  /** A coding agent's guild repositories; other agents' State has no `repositories`. */
  repositories?: Array<Record<string, string>> | null;
  now?: Date;
};

export function collectRunState(
  notes: DirectoryNotes | null,
  orgSlug: string,
  guildName: string,
  agentName: string,
  options: RunStateInputs,
): Record<string, unknown> {
  const listing = notes
    ? collectDirectoryListing(notes, orgSlug, guildName, agentName, {
        secrets: options.secrets,
        scripts: options.scripts,
      })
    : {
        scripts: [...(options.scripts ?? [])],
        environment: environmentCatalog(options.secrets),
      };
  const group: Record<string, unknown> = {
    members: options.members.map(memberEntry),
    operators: (options.operators ?? []).map(({ name, role }) => ({ name, role })),
    history: groupChatHistory(options.historyRows, { limit: CONTEXT_HISTORY_LIMIT }),
  };
  const about = (options.guildAbout ?? "").trim();
  if (about) {
    group.about = about;
  }
  const description = (options.guildDescription ?? "").trim();
  if (description) {
    group.description = description;
  }
  const clock = utcClock(options.now);
  const state: Record<string, unknown> = {
    utc_now: clock.utc_now,
    utc_date: clock.utc_date,
    max_tool_calls: Number(options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS),
    group,
    collections: collectionEntries(options.collections),
    scripts: listing.scripts,
    environment: listing.environment,
  };
  if (options.repositories) {
    state.repositories = options.repositories;
  }
  for (const [key, value] of Object.entries(options.connectors ?? {})) {
    if (!CORE_STATE_KEYS.has(key)) {
      state[key] = value;
    }
  }
  return state;
}
