import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  type SearchSchemaInput,
} from "@tanstack/react-router";
import { GuildChatPage, GuildWorkspace } from "../features/guild/GuildWorkspace";
import { Home } from "../features/home/Home";
import type { TableTab } from "../features/tables/TablesPage";
import { parseStudioSearch, type StudioSearch } from "../features/studio/location";
import { NotFound } from "../features/home/NotFound";
import { AppShell } from "../features/shell/AppShell";

const rootRoute = createRootRoute({ component: AppShell, notFoundComponent: NotFound });

const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Home });

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox",
  component: lazyRouteComponent(() => import("../features/inbox/Inbox"), "Inbox"),
});

/**
 * A tabbed page's search: the tab, and whatever a tab reads for itself. The page decides which tabs
 * exist, since an edition adds its own.
 */
export type TabSearch = { tab?: string } & Record<string, string | undefined>;

function tabSearch(search: Record<string, unknown>): TabSearch {
  const kept: TabSearch = {};
  for (const [key, value] of Object.entries(search)) {
    if (typeof value === "string" && value) kept[key] = value;
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
  validateSearch: (search: Record<string, unknown>): { guild?: string } =>
    typeof search.guild === "string" && search.guild ? { guild: search.guild } : {},
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

const tableTabs: TableTab[] = ["records", "columns", "access"];

const validateTableTab = (search: Record<string, unknown>): { tab?: TableTab } =>
  tableTabs.includes(search.tab as TableTab) && search.tab !== "records"
    ? { tab: search.tab as TableTab }
    : {};

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

const guildChatRoute = createRoute({
  getParentRoute: () => guildRoute,
  path: "/",
  component: GuildChatPage,
  /** `seq` opens the chat at that message, such as the one that tagged the operator. */
  validateSearch: (search: Record<string, unknown>): { seq?: number } => {
    const seq = Number(search.seq);
    return search.seq !== undefined && Number.isInteger(seq) && seq >= 0 ? { seq } : {};
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

/** `path` opens that note or file first, by display path. */
function parseFileSearch(search: Record<string, unknown>): { path?: string } {
  return typeof search.path === "string" && search.path ? { path: search.path } : {};
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

/** The run the agent's chat shows, the step to open in it, and whether the session history drawer is open. */
function parseAgentSearch(search: Record<string, unknown>): {
  run?: string;
  call?: string;
  seq?: number;
  history?: true;
} {
  const run = typeof search.run === "string" && search.run ? search.run : undefined;
  const history =
    search.history === true || search.history === "true" || search.history === 1 ? true : undefined;
  const seq = Number(search.seq);
  return {
    ...(run ? { run } : {}),
    ...(run && typeof search.call === "string" && search.call ? { call: search.call } : {}),
    ...(run && search.seq !== undefined && Number.isInteger(seq) && seq >= 0 ? { seq } : {}),
    ...(history ? { history: true as const } : {}),
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

/** Settings, one section at a time; `section` names the one open (Identity without it). */
const agentSettingsRoute = createRoute({
  getParentRoute: () => agentRoute,
  path: "settings",
  component: lazyRouteComponent(
    () => import("../features/agent/settings/AgentSettings"),
    "AgentSettings",
  ),
  validateSearch: (search: Record<string, unknown>): { section?: string } =>
    typeof search.section === "string" && search.section ? { section: search.section } : {},
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
