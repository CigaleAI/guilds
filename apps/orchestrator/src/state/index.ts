import { DEFAULT_MAX_TOOL_CALLS } from "../agents/config.js";
import type { CatalogCollection } from "../artifacts/collections.js";
import type { StateRepository } from "../coding/repositories.js";
import type { GuildAgentRow } from "../db/agents.js";
import type { GuildOperatorRow } from "../db/guilds.js";
import type { SecretRef } from "../db/schema/index.js";
import { collectDirectoryListing, type DirectoryNotes } from "../directories/index.js";
import { CONTEXT_HISTORY_LIMIT, groupChatHistory } from "../groupchat/history.js";
import type { RoutedMessage } from "../groupchat/router.js";
import { utcClock, type UtcClock } from "../lib/clock.js";
import type { JsonObject, JsonValue } from "../lib/json.js";
import type { ScriptCatalogItem } from "../scripts/catalog.js";
import { environmentCatalog } from "../scripts/validation.js";

/** A guild member as State lists it: its name, and its focus when it has one. */
export type StateMember = Pick<GuildAgentRow, "name"> & Partial<Pick<GuildAgentRow, "focus">>;

/** A guild operator as State lists it: their name and role. */
export type StateOperator = Pick<GuildOperatorRow, "name" | "role">;

/** The guild as State shows it: its members, its operators, the recent group chat, and its about and description when set. */
export type StateGroup = {
  members: StateMember[];
  operators: StateOperator[];
  history: ReturnType<typeof groupChatHistory>;
  about?: string;
  description?: string;
};

/** A collection as State lists it: the catalog's entry, without a display path when it has none. */
export type StateCollection = Omit<CatalogCollection, "display_path"> & Partial<Pick<CatalogCollection, "display_path">>;

/** What core fills in a run's State, under the `CORE_STATE_KEYS`. A coding agent's State alone has `repositories`. */
export type CoreState = UtcClock & {
  max_tool_calls: number;
  group: StateGroup;
  collections: StateCollection[];
  scripts: ScriptCatalogItem[];
  environment: ReturnType<typeof environmentCatalog>;
  repositories?: StateRepository[];
};

/**
 * A run's State, as the system prompt prints it and the Studio previews it: core's entries, and
 * beside them each connector State hook's JSON entry under a key core does not use.
 */
export type RunState = CoreState & { [key: string]: CoreState[keyof CoreState] | JsonValue };

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
  members: Array<Pick<GuildAgentRow, "name" | "focus">>;
  operators?: GuildOperatorRow[];
  historyRows: RoutedMessage[];
  guildAbout?: string;
  guildDescription?: string;
  /** The collections the agent can read, as the artifact store's State catalog lists them. */
  collections?: CatalogCollection[] | null;
  secrets?: SecretRef[] | null | undefined;
  scripts?: ScriptCatalogItem[] | null | undefined;
  maxToolCalls?: number;
  /** The entries connectors' State hooks returned, by key. A key core uses is not one of them. */
  connectors?: JsonObject;
  /** A coding agent's guild repositories; other agents' State has no `repositories`. */
  repositories?: StateRepository[] | null;
  now?: Date;
};

function stateMember(member: Pick<GuildAgentRow, "name" | "focus">): StateMember {
  const focus = member.focus.trim();
  return focus ? { name: member.name, focus } : { name: member.name };
}

function stateCollection(item: CatalogCollection): StateCollection {
  return {
    name: item.name,
    purpose: item.purpose,
    access: item.access,
    scope: item.scope,
    ...(item.display_path ? { display_path: item.display_path } : {}),
    columns: item.columns,
    ...(item.truncated ? { truncated: true } : {}),
  };
}

function stateGroup(options: RunStateInputs): StateGroup {
  const group: StateGroup = {
    members: options.members.map(stateMember),
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
  return group;
}

/**
 * The run's State. With `notes`, the agent's notes folder is listed first, so a folder that cannot
 * be read refuses the run as it would its prompts.
 */
export function collectRunState(
  notes: DirectoryNotes | null,
  orgSlug: string,
  guildName: string,
  agentName: string,
  options: RunStateInputs,
): RunState {
  if (notes) {
    collectDirectoryListing(notes, orgSlug, guildName, agentName);
  }
  const clock = utcClock(options.now);
  const core: CoreState = {
    utc_now: clock.utc_now,
    utc_date: clock.utc_date,
    max_tool_calls: options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
    group: stateGroup(options),
    collections: (options.collections ?? []).map(stateCollection),
    scripts: [...(options.scripts ?? [])],
    environment: environmentCatalog(options.secrets),
  };
  if (options.repositories) {
    core.repositories = options.repositories;
  }
  const hooked: JsonObject = {};
  for (const [key, value] of Object.entries(options.connectors ?? {})) {
    if (!CORE_STATE_KEYS.has(key)) {
      hooked[key] = value;
    }
  }
  return { ...core, ...hooked };
}
