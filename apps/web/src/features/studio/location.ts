import type { PinnedFocus } from "./chatModel";

/** What the inspector shows for one agent. */
export type StudioAgentTab =
  | "prompt"
  | "draft"
  | "history"
  | "memory"
  | "routines"
  | "scripts"
  | "files"
  | "tables"
  | "versions";

/** What the inspector shows for the guild as a whole. */
export type StudioGuildTab = "overview" | "files" | "tables";

export type StudioTab = StudioAgentTab | StudioGuildTab;

/**
 * Where the inspector is looking, carried in the session's URL: the agent, its tab, the item
 * selected in that tab (a run, a memory version, a routine, a script, a Task version, a table,
 * or the activity map's selection), and the step to reveal inside a run.
 */
export type StudioSearch = {
  agent?: string;
  tab?: StudioTab;
  item?: string;
  call?: string;
  seq?: number;
};

export const studioAgentTabs: readonly StudioAgentTab[] = [
  "prompt",
  "draft",
  "history",
  "memory",
  "routines",
  "scripts",
  "files",
  "tables",
  "versions",
];

export const studioGuildTabs: readonly StudioGuildTab[] = ["overview", "files", "tables"];

export const studioTabLabel: Record<StudioTab, string> = {
  overview: "Overview",
  prompt: "Prompt",
  draft: "Draft",
  history: "History",
  memory: "Memory",
  routines: "Routines",
  scripts: "Scripts",
  files: "Files",
  tables: "Tables",
  versions: "Versions",
};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

export function parseStudioSearch(search: Record<string, unknown>): StudioSearch {
  const agent = text(search.agent);
  const tab = text(search.tab);
  const allowed: readonly string[] = agent ? studioAgentTabs : studioGuildTabs;
  const item = text(search.item);
  const call = text(search.call);
  const seq = Number(search.seq);
  return {
    ...(agent ? { agent } : {}),
    ...(tab && allowed.includes(tab) ? { tab: tab as StudioTab } : {}),
    ...(item ? { item } : {}),
    ...(call ? { call } : {}),
    ...(search.seq !== undefined && Number.isInteger(seq) && seq >= 0 ? { seq } : {}),
  };
}

/** Where a pin points in the inspector: the run step, memory version, routine, script or file. */
export function focusLocation(focus: PinnedFocus): StudioSearch | null {
  const agent = focus.agent_id;
  switch (focus.kind) {
    case "run":
    case "issue":
      return agent && focus.run_id
        ? {
            agent,
            tab: "history",
            item: focus.run_id,
            ...(focus.call_id ? { call: focus.call_id } : {}),
            ...(typeof focus.seq === "number" ? { seq: focus.seq } : {}),
          }
        : null;
    case "memory_version":
      return agent ? { agent, tab: "memory", item: focus.revision_id ?? "live" } : null;
    case "routine":
      return agent && focus.schedule_id
        ? { agent, tab: "routines", item: focus.schedule_id }
        : null;
    case "file": {
      const path = focus.display_path ?? "";
      const script = /\/agents\/[^/]+\/scripts\/([^/]+?)(\.py)?$/.exec(path);
      if (agent && script?.[1]) return { agent, tab: "scripts", item: script[1] };
      return {
        ...(agent ? { agent } : {}),
        tab: "files",
        ...(path ? { item: path } : {}),
      };
    }
    default:
      return null;
  }
}
