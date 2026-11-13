import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  type SearchSchemaInput,
} from "@tanstack/react-router";
import { issueSeverities, type IssueSeverity } from "../api/types/issues";
import { isString, type JsonObject, type JsonValue } from "../api/wire";
import type { RevealStep } from "../features/agent/chat/FlowView";
import type { ChatSearch } from "../features/agent/chat/SessionChrome";
import { GuildChatPage, GuildWorkspace } from "../features/guild/GuildWorkspace";
import { Home } from "../features/home/Home";
import type { TableTab } from "../features/tables/TablesPage";
import {
  parseStudioLandingSearch,
  parseStudioSearch,
  type StudioLandingSearch,
  type StudioSearch,
} from "../features/studio/location";
import { NotFound } from "../features/home/NotFound";
import { AppShell } from "../features/shell/AppShell";

const rootRoute = createRootRoute({ component: AppShell, notFoundComponent: NotFound });

const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Home });

/** What a list of issues reads from its address: the one severity it shows, or none for every one. */
export type IssueListSearch = { severity?: IssueSeverity };

function issueListSearch(search: JsonObject): IssueListSearch {
  const severity = issueSeverities.find((known) => known === search.severity);
  return severity ? { severity } : {};
}

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox",
  component: lazyRouteComponent(() => import("../features/inbox/Inbox"), "Inbox"),
  validateSearch: issueListSearch,
});

// Each route's `validateSearch` reads the search as the router parses it from the URL: a JSON
// object, each value decoded as JSON when it is JSON text and kept as text otherwise. It keeps
// the fields its route reads, of their types, and drops the rest.

/** A search value as text, when it is non-empty text. */
function searchText(value: JsonValue | undefined): string | undefined {
  return isString(value) && value ? value : undefined;
}

/** A search value as a place in a sequence: a whole number from zero, written as one or as its digits. */
function searchIndex(value: JsonValue | undefined): number | undefined {
  const index = Number(value);
  return value !== undefined && Number.isInteger(index) && index >= 0 ? index : undefined;
}

/**
 * A tabbed page's search: the tab, and whatever a tab reads for itself. The page decides which tabs
 * exist, since an extension adds its own.
 */
export type TabSearch = { tab?: string } & Record<string, string | undefined>;

function tabSearch(search: JsonObject): TabSearch {
  const kept: TabSearch = {};
  for (const [key, value] of Object.entries(search)) {
    const text = searchText(value);
    if (text) kept[key] = text;
  }
  return kept;
}

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: lazyRouteComponent(() => import("../features/settings/SettingsPage"), "SettingsPage"),
  validateSearch: tabSearch,
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  component: lazyRouteComponent(() => import("../features/admin/AdminPage"), "AdminPage"),
  validateSearch: tabSearch,
});

const recipesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/recipes",
  component: lazyRouteComponent(() => import("../features/recipes/RecipesPage"), "RecipesPage"),
});

const builderRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/builder",
  component: lazyRouteComponent(
    () => import("../features/builder/BuilderLanding"),
    "BuilderLanding",
  ),
});

const builderSessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/builder/$sessionId",
  component: lazyRouteComponent(
    () => import("../features/builder/BuilderWorkspace"),
    "BuilderWorkspace",
  ),
});

const recipeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/recipes/$recipeId",
  component: lazyRouteComponent(() => import("../features/recipes/RecipePage"), "RecipePage"),
});

const recipeApplyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/recipes/$recipeId/apply",
  component: lazyRouteComponent(
    () => import("../features/recipes/ApplyPreviewPage"),
    "ApplyPreviewPage",
  ),
});

const applyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/applies/$applyId",
  component: lazyRouteComponent(() => import("../features/recipes/ApplyPage"), "ApplyPage"),
});

const studioRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/studio",
  component: lazyRouteComponent(() => import("../features/studio/StudioLanding"), "StudioLanding"),
  validateSearch: (search: JsonObject): StudioLandingSearch => parseStudioLandingSearch(search),
});

const studioSessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/studio/$sessionId",
  component: lazyRouteComponent(
    () => import("../features/studio/StudioWorkspace"),
    "StudioWorkspace",
  ),
  // Every field is optional in a link: without a section the session opens on the guild.
  validateSearch: (search: Partial<StudioSearch> & SearchSchemaInput) => parseStudioSearch(search),
});

const tableTabs = ["records", "columns", "access"] as const satisfies readonly TableTab[];

/** The tab a table page opens on; Records without one. */
type TableSearch = { tab?: TableTab };

const validateTableTab = (search: JsonObject): TableSearch => {
  const tab = tableTabs.find((item) => item === search.tab);
  return tab && tab !== "records" ? { tab } : {};
};

const tablesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tables",
  component: lazyRouteComponent(
    () => import("../features/tables/TablesPage"),
    "TablesPage",
  ),
  validateSearch: validateTableTab,
});

const tableRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tables/$collectionId",
  component: lazyRouteComponent(
    () => import("../features/tables/TablesPage"),
    "TablesPage",
  ),
  validateSearch: validateTableTab,
});

const guildRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/guilds/$guildId",
  component: GuildWorkspace,
});

/** The message the group chat opens at. */
type GuildChatSearch = { seq?: number };

const guildChatRoute = createRoute({
  getParentRoute: () => guildRoute,
  path: "/",
  component: GuildChatPage,
  /** `seq` opens the chat at that message, such as the one that tagged the operator. */
  validateSearch: (search: JsonObject): GuildChatSearch => {
    const seq = searchIndex(search.seq);
    return seq === undefined ? {} : { seq };
  },
});

const guildSettingsRoute = createRoute({
  getParentRoute: () => guildRoute,
  path: "settings",
  component: lazyRouteComponent(
    () => import("../features/guild/pages/GuildSettings"),
    "GuildSettings",
  ),
});

const guildRoutinesRoute = createRoute({
  getParentRoute: () => guildRoute,
  path: "routines",
  component: lazyRouteComponent(
    () => import("../features/guild/pages/GuildRoutines"),
    "GuildRoutines",
  ),
});

const guildIssuesRoute = createRoute({
  getParentRoute: () => guildRoute,
  path: "issues",
  component: lazyRouteComponent(() => import("../features/guild/pages/GuildIssues"), "GuildIssues"),
  validateSearch: issueListSearch,
});

const guildUsageRoute = createRoute({
  getParentRoute: () => guildRoute,
  path: "usage",
  component: lazyRouteComponent(() => import("../features/guild/pages/GuildUsage"), "GuildUsage"),
});

/** The State tab: notes, files, tables and access as sub-tabs, one route each. */
const guildStateRoute = createRoute({
  getParentRoute: () => guildRoute,
  path: "state",
  component: lazyRouteComponent(() => import("../features/guild/GuildState"), "GuildState"),
});

const guildStateIndexRoute = createRoute({
  getParentRoute: () => guildStateRoute,
  path: "/",
  component: lazyRouteComponent(() => import("../features/guild/GuildState"), "GuildStateIndex"),
});

const guildTablesRoute = createRoute({
  getParentRoute: () => guildStateRoute,
  path: "tables",
  component: lazyRouteComponent(
    () => import("../features/tables/StateTablesTab"),
    "GuildTablesTab",
  ),
});

const agentTablesRoute = createRoute({
  getParentRoute: () => agentStateRoute,
  path: "tables",
  component: lazyRouteComponent(
    () => import("../features/tables/StateTablesTab"),
    "AgentTablesTab",
  ),
});

const guildAccessRoute = createRoute({
  getParentRoute: () => guildStateRoute,
  path: "access",
  component: lazyRouteComponent(() => import("../features/guild/GuildAccessTabs"), "GuildReachTab"),
});

const agentAccessRoute = createRoute({
  getParentRoute: () => agentStateRoute,
  path: "access",
  component: lazyRouteComponent(() => import("../features/agent/AgentAccessTabs"), "AgentReachTab"),
});

/** The note or file a notes or files tab opens first, by display path. */
type FileSearch = { path?: string };

function parseFileSearch(search: JsonObject): FileSearch {
  const path = searchText(search.path);
  return path ? { path } : {};
}

const guildNotesRoute = createRoute({
  getParentRoute: () => guildStateRoute,
  path: "notes",
  component: lazyRouteComponent(() => import("../features/notes/NotesTabs"), "GuildNotesTab"),
  validateSearch: parseFileSearch,
});

const guildFilesRoute = createRoute({
  getParentRoute: () => guildStateRoute,
  path: "files",
  component: lazyRouteComponent(() => import("../features/files/FilesTabs"), "GuildFilesTab"),
  validateSearch: parseFileSearch,
});

const agentScriptsRoute = createRoute({
  getParentRoute: () => agentStateRoute,
  path: "scripts",
  component: lazyRouteComponent(
    () => import("../features/agent/scripts/AgentScripts"),
    "AgentScripts",
  ),
});

const agentBrowserRoute = createRoute({
  getParentRoute: () => agentRoute,
  path: "browser",
  component: lazyRouteComponent(
    () => import("../features/agent/browser/AgentBrowser"),
    "AgentBrowser",
  ),
});

const agentCliRoute = createRoute({
  getParentRoute: () => agentRoute,
  path: "cli",
  component: lazyRouteComponent(() => import("../features/agent/cli/AgentCli"), "AgentCli"),
});

const agentNotesRoute = createRoute({
  getParentRoute: () => agentStateRoute,
  path: "notes",
  component: lazyRouteComponent(() => import("../features/notes/NotesTabs"), "AgentNotesTab"),
  validateSearch: parseFileSearch,
});

const agentFilesRoute = createRoute({
  getParentRoute: () => agentStateRoute,
  path: "files",
  component: lazyRouteComponent(() => import("../features/files/FilesTabs"), "AgentFilesTab"),
  validateSearch: parseFileSearch,
});

const guildToolsRoute = createRoute({
  getParentRoute: () => guildRoute,
  path: "tools",
  component: lazyRouteComponent(() => import("../features/guild/GuildAccessTabs"), "GuildToolsTab"),
});

const guildSecretsRoute = createRoute({
  getParentRoute: () => guildRoute,
  path: "secrets",
  component: lazyRouteComponent(
    () => import("../features/guild/GuildAccessTabs"),
    "GuildSecretsTab",
  ),
});

/** The step a search names in the run it opens: its tool call, or its place in the run's sequence. */
function parseRevealStep(search: JsonObject): RevealStep {
  const call = searchText(search.call);
  const seq = searchIndex(search.seq);
  return {
    ...(call ? { call } : {}),
    ...(seq === undefined ? {} : { seq }),
  };
}

/** Whether a search value opens the session history drawer: `true`, `"true"` or `1`. */
function opensHistory(value: JsonValue | undefined): boolean {
  return value === true || value === "true" || value === 1;
}

/** The run the agent's chat shows, the step to open in it, and whether the session history drawer is open. */
function parseAgentSearch(search: JsonObject): ChatSearch {
  const run = searchText(search.run);
  return {
    ...(run ? { run, ...parseRevealStep(search) } : {}),
    ...(opensHistory(search.history) ? { history: true as const } : {}),
  };
}

/** The agent inspector over its guild, one route per tab; `run` opens that run in Chat, `call` or `seq` a step in it, `history` the session drawer. `/history` opens Chat with the drawer. */
const agentRoute = createRoute({
  getParentRoute: () => guildRoute,
  path: "agents/$agentId",
  component: lazyRouteComponent(() => import("../features/agent/AgentInspector"), "AgentInspector"),
  validateSearch: parseAgentSearch,
});

const agentChatRoute = createRoute({
  getParentRoute: () => agentRoute,
  path: "/",
  component: lazyRouteComponent(() => import("../features/agent/chat/AgentChat"), "AgentChat"),
});

const agentPromptRoute = createRoute({
  getParentRoute: () => agentRoute,
  path: "prompt",
  component: lazyRouteComponent(
    () => import("../features/agent/prompt/AgentPrompt"),
    "AgentPrompt",
  ),
});

/** The State tab: memory, notes, tables, access and scripts as sub-tabs, one route each. */
const agentStateRoute = createRoute({
  getParentRoute: () => agentRoute,
  path: "state",
  component: lazyRouteComponent(() => import("../features/agent/AgentState"), "AgentState"),
});

const agentStateIndexRoute = createRoute({
  getParentRoute: () => agentStateRoute,
  path: "/",
  component: lazyRouteComponent(() => import("../features/agent/AgentState"), "AgentStateIndex"),
});

const agentMemoryRoute = createRoute({
  getParentRoute: () => agentStateRoute,
  path: "memory",
  component: lazyRouteComponent(
    () => import("../features/agent/memory/AgentMemory"),
    "AgentMemory",
  ),
});

const agentRoutineRoute = createRoute({
  getParentRoute: () => agentRoute,
  path: "routine",
  component: lazyRouteComponent(
    () => import("../features/agent/routine/AgentRoutines"),
    "AgentRoutines",
  ),
});

const agentToolsRoute = createRoute({
  getParentRoute: () => agentRoute,
  path: "tools",
  component: lazyRouteComponent(() => import("../features/agent/AgentAccessTabs"), "AgentToolsTab"),
});

const agentSecretsRoute = createRoute({
  getParentRoute: () => agentRoute,
  path: "secrets",
  component: lazyRouteComponent(
    () => import("../features/agent/AgentAccessTabs"),
    "AgentSecretsTab",
  ),
});

const agentUsageRoute = createRoute({
  getParentRoute: () => agentRoute,
  path: "usage",
  component: lazyRouteComponent(
    () => import("../features/agent/settings/AgentUsage"),
    "AgentUsage",
  ),
});

/** The settings section open; Identity without one. */
type AgentSettingsSearch = { section?: string };

/** Settings, one section at a time; `section` names the one open (Identity without it). */
const agentSettingsRoute = createRoute({
  getParentRoute: () => agentRoute,
  path: "settings",
  component: lazyRouteComponent(
    () => import("../features/agent/settings/AgentSettings"),
    "AgentSettings",
  ),
  validateSearch: (search: JsonObject): AgentSettingsSearch => {
    const section = searchText(search.section);
    return section ? { section } : {};
  },
});

const agentHistoryRoute = createRoute({
  getParentRoute: () => agentRoute,
  path: "history",
  component: lazyRouteComponent(
    () => import("../features/agent/history/AgentHistory"),
    "AgentHistoryRedirect",
  ),
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    homeRoute,
    inboxRoute,
    settingsRoute,
    adminRoute,
    builderRoute,
    builderSessionRoute,
    recipesRoute,
    recipeRoute,
    recipeApplyRoute,
    applyRoute,
    studioRoute,
    studioSessionRoute,
    tablesRoute,
    tableRoute,
    guildRoute.addChildren([
      guildChatRoute,
      guildSettingsRoute,
      guildStateRoute.addChildren([
        guildStateIndexRoute,
        guildNotesRoute,
        guildFilesRoute,
        guildTablesRoute,
        guildAccessRoute,
      ]),
      guildRoutinesRoute,
      guildIssuesRoute,
      guildUsageRoute,
      guildToolsRoute,
      guildSecretsRoute,
      agentRoute.addChildren([
        agentChatRoute,
        agentPromptRoute,
        agentStateRoute.addChildren([
          agentStateIndexRoute,
          agentMemoryRoute,
          agentNotesRoute,
          agentFilesRoute,
          agentTablesRoute,
          agentAccessRoute,
          agentScriptsRoute,
        ]),
        agentHistoryRoute,
        agentRoutineRoute,
        agentBrowserRoute,
        agentCliRoute,
        agentToolsRoute,
        agentSecretsRoute,
        agentUsageRoute,
        agentSettingsRoute,
      ]),
    ]),
  ]),
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
