import type { PinnedFocus } from "./chatModel";

/** The four parts of a session's workspace. */
export type StudioSection = "guild" | "agents" | "state" | "tools";

/** What the inspector shows for one agent. */
export type StudioAgentTab =
  "prompt" | "draft" | "history" | "memory" | "routines" | "scripts" | "versions";

/** The two ways State looks at the guild's notes, tables, scripts and Memory. */
export type StudioStateView = "list" | "references";

/** Which kind of item State's list keeps. */
export type StudioStateKind = "note" | "table" | "script" | "memory";

export const studioStateKinds: readonly StudioStateKind[] = ["note", "table", "script", "memory"];

export type StudioTab = StudioAgentTab | StudioStateView;

/**
 * Where the workspace is looking, carried in the session's URL: the section, the agent (the one
 * inspected in Agents, the filter in State), the tab or view, the item selected in it (a run, a
 * memory version, a routine, a script, a Task version, a file, a table, or the topology map's
 * selection), and the step to reveal inside a run.
 */
export type StudioSearch = {
  section: StudioSection;
  agent?: string;
  tab?: StudioTab;
  kind?: StudioStateKind;
  item?: string;
  call?: string;
  seq?: number;
};

export const studioSections: readonly StudioSection[] = ["guild", "agents", "state", "tools"];

export const studioSectionLabel: Record<StudioSection, string> = {
  guild: "Guild",
  agents: "Agents",
  state: "State",
  tools: "Tools",
};

export const studioAgentTabs: readonly StudioAgentTab[] = [
  "prompt",
  "draft",
  "history",
  "memory",
  "routines",
  "scripts",
  "versions",
];

export const studioStateViews: readonly StudioStateView[] = ["list", "references"];

export const studioTabLabel: Record<StudioTab, string> = {
  prompt: "Prompt",
  draft: "Draft",
  history: "History",
  memory: "Memory",
  routines: "Routines",
  scripts: "Scripts",
  versions: "Versions",
  list: "List",
  references: "References",
};

/**
 * The tab an agent opens on when the URL names none it has: the tab holding a request the coach
 * waits on, else Prompt.
 */
export function agentTab(
  requested: StudioTab | undefined,
  waiting: readonly StudioTab[],
  tabs: readonly StudioAgentTab[],
): StudioAgentTab {
  return (
    tabs.find((value) => value === requested) ??
    tabs.find((value) => waiting.includes(value)) ??
    "prompt"
  );
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const oneOf = <T extends string>(allowed: readonly T[], value: unknown): T | undefined =>
  allowed.find((entry) => entry === text(value));

const parseSeq = (value: unknown): number | undefined => {
  const seq = Number(value);
  return value !== undefined && Number.isInteger(seq) && seq >= 0 ? seq : undefined;
};

/** A location whose optional fields may be spelled out as missing. */
type LooseSearch = Pick<StudioSearch, "section"> & {
  [Key in Exclude<keyof StudioSearch, "section">]?: StudioSearch[Key] | undefined;
};

/** Drops the keys whose value is missing, so the URL carries only what is set. */
function compact(search: LooseSearch): StudioSearch {
  const { section, agent, tab, kind, item, call, seq } = search;
  return {
    section,
    ...(agent === undefined ? {} : { agent }),
    ...(tab === undefined ? {} : { tab }),
    ...(kind === undefined ? {} : { kind }),
    ...(item === undefined ? {} : { item }),
    ...(call === undefined ? {} : { call }),
    ...(seq === undefined ? {} : { seq }),
  };
}

/** Each section keeps only the fields it reads. */
const sectionParsers: Record<StudioSection, (search: Record<string, unknown>) => LooseSearch> = {
  guild: () => ({ section: "guild" }),
  agents: (search) => {
    const agent = text(search.agent);
    return {
      section: "agents",
      agent,
      tab: agent ? oneOf(studioAgentTabs, search.tab) : undefined,
      item: text(search.item),
      call: agent ? text(search.call) : undefined,
      seq: agent ? parseSeq(search.seq) : undefined,
    };
  },
  state: (search) => ({
    section: "state",
    agent: text(search.agent),
    tab: oneOf(studioStateViews, search.tab),
    kind: oneOf(studioStateKinds, search.kind),
    item: text(search.item),
  }),
  tools: (search) => ({ section: "tools", item: text(search.item) }),
};

/** A URL without a known section opens the guild's overview. */
export function parseStudioSearch(search: Record<string, unknown>): StudioSearch {
  const section = oneOf(studioSections, search.section) ?? "guild";
  return compact(sectionParsers[section](search));
}

/** A file opens in State with the file selected; a record opens its table. */
function fileLocation(focus: PinnedFocus): StudioSearch {
  const path = focus.display_path ?? "";
  return compact({
    section: "state",
    agent: focus.agent_id,
    tab: "list",
    item: (path && tablePathOf(path)) || path || undefined,
  });
}

/** A record's path names its table, `org/<org>/collections/<name>`; a table's path is its own. */
export function tablePathOf(path: string): string | null {
  const match = /^(org\/[^/]+\/collections\/[^/]+)(\/[^/]+)?$/.exec(path);
  return match?.[1] ?? null;
}

function runLocation(focus: PinnedFocus): StudioSearch | null {
  if (!focus.agent_id || !focus.run_id) return null;
  return compact({
    section: "agents",
    agent: focus.agent_id,
    tab: "history",
    item: focus.run_id,
    call: focus.call_id ?? undefined,
    seq: typeof focus.seq === "number" ? focus.seq : undefined,
  });
}

const focusLocations: Record<string, (focus: PinnedFocus) => StudioSearch | null> = {
  run: runLocation,
  issue: runLocation,
  memory_version: (focus) =>
    focus.agent_id
      ? {
          section: "agents",
          agent: focus.agent_id,
          tab: "memory",
          item: focus.revision_id ?? "live",
        }
      : null,
  routine: (focus) =>
    focus.agent_id && focus.schedule_id
      ? { section: "agents", agent: focus.agent_id, tab: "routines", item: focus.schedule_id }
      : null,
  file: fileLocation,
};

/** Where a pin points in the workspace: the run step, memory version, routine, script or file. */
export function focusLocation(focus: PinnedFocus): StudioSearch | null {
  return focusLocations[focus.kind]?.(focus) ?? null;
}
