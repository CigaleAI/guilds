import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from "@tanstack/react-router";
import { GuildChatPage, GuildWorkspace } from "../features/guild/GuildWorkspace";
import { Home } from "../features/home/Home";
import type { DatabaseTab } from "../features/databases/DatabasesPage";
import { parseStudioSearch } from "../features/studio/location";
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
  validateSearch: parseStudioSearch,
});

const databaseTabs: DatabaseTab[] = ["records", "columns", "access"];

const validateDatabaseTab = (search: Record<string, unknown>): { tab?: DatabaseTab } =>
  databaseTabs.includes(search.tab as DatabaseTab) && search.tab !== "records"
    ? { tab: search.tab as DatabaseTab }
    : {};

const databasesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/databases",
  component: lazyRouteComponent(
    () => import("../features/databases/DatabasesPage"),
    "DatabasesPage",
  ),
  validateSearch: validateDatabaseTab,
});

const databaseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/databases/$collectionId",
  component: lazyRouteComponent(
    () => import("../features/databases/DatabasesPage"),
    "DatabasesPage",
  ),
  validateSearch: validateDatabaseTab,
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

/** The State tab: files, databases and artifact scope as sub-tabs, one route each. */
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

const guildDatabasesRoute = createRoute({
  getParentRoute: () => guildStateRoute,
  path: "databases",
  component: lazyRouteComponent(
    () => import("../features/databases/DatabaseAccessTabs"),
    "GuildDatabasesTab",
  ),
});

const agentDatabasesRoute = createRoute({
  getParentRoute: () => agentStateRoute,
  path: "databases",
  component: lazyRouteComponent(
    () => import("../features/databases/DatabaseAccessTabs"),
    "AgentDatabasesTab",
  ),
});

/** `path` opens that note first, by display path. */
function parseFileSearch(search: Record<string, unknown>): { path?: string } {
  return typeof search.path === "string" && search.path ? { path: search.path } : {};
}

const guildFilesRoute = createRoute({
  getParentRoute: () => guildStateRoute,
  path: "files",
  component: lazyRouteComponent(() => import("../features/files/NotesTabs"), "GuildFilesTab"),
  validateSearch: parseFileSearch,
});

const guildArtifactsRoute = createRoute({
  getParentRoute: () => guildStateRoute,
  path: "artifacts",
  component: lazyRouteComponent(
    () => import("../features/guild/GuildAccessTabs"),
    "GuildArtifactScope",
  ),
});

const agentScriptsRoute = createRoute({
  getParentRoute: () => agentStateRoute,
  path: "scripts",
  component: lazyRouteComponent(
    () => import("../features/agent/scripts/AgentScripts"),
    "AgentScripts",
  ),
});

const agentArtifactsRoute = createRoute({
  getParentRoute: () => agentStateRoute,
  path: "artifacts",
  component: lazyRouteComponent(
    () => import("../features/agent/AgentAccessTabs"),
    "AgentArtifactScope",
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
  component: lazyRouteComponent(() => import("../features/files/NotesTabs"), "AgentNotesTab"),
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

/** The State tab: memory, notes, databases, scripts and artifact scope as sub-tabs, one route each. */
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

const agentSettingsRoute = createRoute({
  getParentRoute: () => agentRoute,
  path: "settings",
  component: lazyRouteComponent(
    () => import("../features/agent/settings/AgentSettings"),
    "AgentSettings",
  ),
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
    databasesRoute,
    databaseRoute,
    guildRoute.addChildren([
      guildChatRoute,
      guildSettingsRoute,
      guildStateRoute.addChildren([
        guildStateIndexRoute,
        guildFilesRoute,
        guildDatabasesRoute,
        guildArtifactsRoute,
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
          agentDatabasesRoute,
          agentScriptsRoute,
          agentArtifactsRoute,
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
