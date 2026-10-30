import type { Instance } from "../../api/types/admin";
import type { AgentConfig } from "../../api/types/agents";
import type {
  AccessBinding,
  BindingScope,
  McpConnectionStatus,
  McpServerAccess,
} from "../../api/types/access";
import type { BindingOrigin } from "@guildsrun/ui";
import { missingFieldsPhrase, toolIntegrationGap } from "../instance/instance";
/**
 * The agent's own binding can go when it holds no login: dropping it may already give the wanted
 * state, which keeps overrides to the ones that matter.
 */
export function canResetFirst(item: Pick<AccessBinding, "overlay">): boolean {
  return Boolean(item.overlay) && !item.overlay?.connection_id;
}

/** Where a switch's value comes from at the scope being edited, for its caption. */
export function bindingOrigin(
  item: Pick<AccessBinding, "overlay" | "source_scope">,
  scope: BindingScope,
): BindingOrigin | undefined {
  if (item.overlay) return { kind: "overridden" };
  if (item.source_scope && item.source_scope !== scope)
    return { kind: "inherited", from: item.source_scope };
  return undefined;
}

/** The login state a server card shows; undefined when there is no login at all. */
export function connectionStatus(server: McpServerAccess): McpConnectionStatus | undefined {
  if (server.needs_settings) return "pending";
  if (server.status === "connected" || server.account_hint) return "connected";
  if (!server.connection_id) return undefined;
  return server.status === "pending" ? "pending" : "disconnected";
}

/** The login the scope being edited owns, which it may disconnect; inherited logins belong to a wider scope. */
export function ownedConnection(server: McpServerAccess, scope: BindingScope): string | null {
  if (!server.overlay?.connection_id || server.connection_owner_scope !== scope) return null;
  return server.overlay.connection_id;
}

export type ToolFilter = "all" | "active" | "disabled";

function matchesToolState(enabled: boolean, filter: ToolFilter): boolean {
  return filter === "all" || enabled === (filter === "active");
}

function matchesToolQuery(name: string, description: string | undefined, needle: string): boolean {
  return !needle || `${name} ${description ?? ""}`.toLowerCase().includes(needle);
}

export function filterTools<
  T extends Pick<AccessBinding, "name" | "enabled"> & { description?: string },
>(tools: readonly T[], query: string, filter: ToolFilter): T[] {
  const needle = query.trim().toLowerCase();
  return tools.filter(
    (tool) =>
      matchesToolState(tool.enabled, filter) &&
      matchesToolQuery(tool.name, tool.description, needle),
  );
}

/** Browser tools: offered when the agent's browser capability is on; not bindings. */
export const BROWSER_NATIVE_TOOLS = [
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_fill",
  "browser_scroll",
  "browser_screenshot",
  "browser_eval",
] as const;

/**
 * The agent-optimized browser's tools: offered in place of the step tools when the agent's browser
 * runs that way.
 */
export const OPTIMIZED_BROWSER_NATIVE_TOOLS = ["browse", "browser_eval"] as const;

/** Every browser tool, in either mode. */
const ANY_BROWSER_NATIVE_TOOLS: readonly string[] = [...BROWSER_NATIVE_TOOLS, "browse"];

/** Code tools: offered when the agent's coding capability is on; not bindings. */
export const CODING_NATIVE_TOOLS = [
  "code_task",
  "shell",
  "shell_status",
  "file_read",
  "code_search",
] as const;

/** Native tools a run always offers; not bindings. */
export const ALWAYS_NATIVE_TOOLS = ["report_issue"] as const;

const CAPABILITY_NATIVE_TOOLS: readonly string[] = [
  ...ANY_BROWSER_NATIVE_TOOLS,
  ...CODING_NATIVE_TOOLS,
  ...ALWAYS_NATIVE_TOOLS,
];

export type AgentNativeCapabilities = {
  browser?: boolean;
  /** Whether the agent's browser runs as the agent-optimized browser. */
  browser_optimized?: boolean;
  coding?: boolean;
};

/**
 * Whether an agent's runs offer `browse`: its config turns the agent-optimized browser on and the
 * integration `browse` waits for is on, as the server decides; otherwise they offer the
 * step-by-step browser tools.
 */
export function offersOptimizedBrowser(
  config: Pick<AgentConfig, "browser_optimized"> | undefined,
  instance: Instance | undefined,
): boolean {
  return config?.browser_optimized === true && toolIntegrationGap(instance, "browse") === null;
}

/**
 * The browser tools a Tools tab lists: those of the agent's browser mode, or every one where no
 * agent's capabilities are in view.
 */
export function listedBrowserTools(capabilities?: AgentNativeCapabilities): readonly string[] {
  if (!capabilities) return ANY_BROWSER_NATIVE_TOOLS;
  return capabilities.browser_optimized ? OPTIMIZED_BROWSER_NATIVE_TOOLS : BROWSER_NATIVE_TOOLS;
}

/** Native tools by what they work on, in the platform's order. */
const toolFamilies: { label: string; matches: (name: string) => boolean }[] = [
  { label: "Notes", matches: (name) => name.startsWith("note_") },
  { label: "Tables", matches: (name) => name.startsWith("record_") },
  { label: "Files", matches: (name) => name.startsWith("file_") && name !== "file_read" },
  { label: "Memory", matches: (name) => name.startsWith("memory_") },
  { label: "Scripts", matches: (name) => name.startsWith("script_") },
  { label: "Routines", matches: (name) => name.startsWith("schedule_") },
  { label: "Group chat", matches: (name) => name.startsWith("group_") },
  { label: "Secrets", matches: (name) => name.startsWith("secret_") },
  { label: "Browser", matches: (name) => name === "browse" || name.startsWith("browser_") },
  {
    label: "Coding",
    matches: (name) =>
      name === "shell" ||
      name === "shell_status" ||
      name === "file_read" ||
      name.startsWith("code_"),
  },
  { label: "Issues", matches: (name) => name === "report_issue" },
];

export function isCapabilityNativeTool(name: string): boolean {
  return CAPABILITY_NATIVE_TOOLS.includes(name);
}

/**
 * Bindable native tools plus the capability-gated ones the access payload omits; of the browser
 * tools, only those `listedBrowserTools` lists for the capabilities.
 */
export function withCapabilityNativeTools(
  tools: readonly AccessBinding[],
  capabilities?: AgentNativeCapabilities,
): AccessBinding[] {
  const browser = listedBrowserTools(capabilities);
  const listed = tools.filter(
    (tool) => !ANY_BROWSER_NATIVE_TOOLS.includes(tool.name) || browser.includes(tool.name),
  );
  const names = new Set(listed.map((tool) => tool.name));
  const gated = [...browser, ...CODING_NATIVE_TOOLS, ...ALWAYS_NATIVE_TOOLS];
  return [
    ...listed,
    ...gated
      .filter((name) => !names.has(name))
      .map((name) => ({
        name,
        enabled: true,
        source_scope: null,
        overlay: null,
      })),
  ];
}

export function nativeToolDisplay(
  item: AccessBinding,
  scope: BindingScope,
  capabilities?: AgentNativeCapabilities,
  instance?: Instance,
): { enabled: boolean; caption?: string; bindable: boolean } {
  const waitsFor = toolIntegrationGap(instance, item.name);
  if (waitsFor) {
    return {
      enabled: false,
      caption:
        waitsFor.source === "store"
          ? `Offered once a platform admin sets up ${waitsFor.label} under Admin → Platform keys`
          : `Offered once this server has ${missingFieldsPhrase(waitsFor)} set`,
      bindable: false,
    };
  }
  if (ANY_BROWSER_NATIVE_TOOLS.includes(item.name)) {
    const on = capabilities?.browser;
    const mode = item.name === "browse" ? "the agent-optimized browser" : "browser";
    return {
      enabled: on ?? true,
      caption:
        scope === "agent"
          ? on
            ? "Active via browser"
            : "Offered when browser is on"
          : `Offered when an agent has ${mode} on`,
      bindable: false,
    };
  }
  if ((CODING_NATIVE_TOOLS as readonly string[]).includes(item.name)) {
    const on = capabilities?.coding;
    return {
      enabled: on ?? true,
      caption:
        scope === "agent"
          ? on
            ? "Active via coding"
            : "Offered when coding is on"
          : "Offered when an agent has coding on",
      bindable: false,
    };
  }
  if ((ALWAYS_NATIVE_TOOLS as readonly string[]).includes(item.name)) {
    return { enabled: true, caption: "Always offered", bindable: false };
  }
  return { enabled: item.enabled, bindable: true };
}

export function toolFamilyGroups(
  tools: readonly AccessBinding[],
): { label: string; tools: AccessBinding[] }[] {
  const groups = toolFamilies.map((family) => ({
    label: family.label,
    tools: [] as AccessBinding[],
  }));
  const other: AccessBinding[] = [];
  for (const tool of tools) {
    const index = toolFamilies.findIndex((family) => family.matches(tool.name));
    const group = index >= 0 ? groups[index] : undefined;
    if (group) group.tools.push(tool);
    else other.push(tool);
  }
  return [...groups, { label: "Other", tools: other }].filter((group) => group.tools.length > 0);
}
