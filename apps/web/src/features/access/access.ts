import type {
  AccessBinding,
  AgentAccess,
  BindingScope,
  CatalogKind,
  Instance,
  McpConnectionStatus,
  McpServerAccess,
} from "../../api/types";
import type { BindingOrigin } from "@guildsrun/ui";
import { missingVariablesPhrase, toolIntegrationGap } from "../instance/instance";
/** One switch in the Tools tab: what it binds, and how the agent gets it now. */
export type BindingTarget = { kind: CatalogKind; id: string };

/** The item a target points at in an access payload, or undefined when it is gone. */
export function findBinding(
  access: AgentAccess,
  target: BindingTarget,
): AccessBinding | McpServerAccess | undefined {
  switch (target.kind) {
    case "native_tool":
      return access.tools.find((item) => item.name === target.id);
    case "artifact_grant":
      return access.grants.find((item) => item.name === target.id);
    case "mcp":
      return access.mcp.find((server) => server.id === target.id);
    case "mcp_tool":
      return access.mcp.flatMap((server) => server.tools).find((tool) => tool.name === target.id);
  }
}

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

function matchesToolQuery(
  tool: Pick<AccessBinding, "name"> & { description?: string },
  needle: string,
): boolean {
  return !needle || `${tool.name} ${tool.description ?? ""}`.toLowerCase().includes(needle);
}

export function filterTools<
  T extends Pick<AccessBinding, "name" | "enabled"> & { description?: string },
>(tools: readonly T[], query: string, filter: ToolFilter): T[] {
  const needle = query.trim().toLowerCase();
  return tools.filter(
    (tool) => matchesToolState(tool.enabled, filter) && matchesToolQuery(tool, needle),
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

/** Code tools: offered when the agent's coding capability is on; not bindings. */
export const CODING_NATIVE_TOOLS = [
  "shell",
  "shell_status",
  "file_read",
  "file_edit",
  "file_write",
  "code_search",
  "code_match",
  "code_map",
  "code_find",
  "code_outline",
  "code_callers",
] as const;

/** Native tools a run always offers; not bindings. */
export const ALWAYS_NATIVE_TOOLS = ["report_issue"] as const;

const CAPABILITY_NATIVE_TOOLS: readonly string[] = [
  ...BROWSER_NATIVE_TOOLS,
  ...CODING_NATIVE_TOOLS,
  ...ALWAYS_NATIVE_TOOLS,
];

export type AgentNativeCapabilities = {
  browser?: boolean;
  coding?: boolean;
};

/** Native tools by what they work on, in the platform's order. */
const toolFamilies: { label: string; matches: (name: string) => boolean }[] = [
  { label: "Notes", matches: (name) => name.startsWith("note_") },
  { label: "Tables", matches: (name) => name.startsWith("record_") },
  { label: "Memory", matches: (name) => name.startsWith("memory_") },
  { label: "Scripts", matches: (name) => name.startsWith("script_") },
  { label: "Routines", matches: (name) => name.startsWith("schedule_") },
  { label: "Group chat", matches: (name) => name.startsWith("group_") },
  { label: "Secrets", matches: (name) => name.startsWith("secret_") },
  { label: "Browser", matches: (name) => name.startsWith("browser_") },
  {
    label: "Coding",
    matches: (name) =>
      name === "shell" ||
      name === "shell_status" ||
      name.startsWith("file_") ||
      name.startsWith("code_"),
  },
  { label: "Issues", matches: (name) => name === "report_issue" },
];

export function isCapabilityNativeTool(name: string): boolean {
  return CAPABILITY_NATIVE_TOOLS.includes(name);
}

/** Bindable native tools plus the capability-gated ones the access payload omits. */
export function withCapabilityNativeTools(tools: readonly AccessBinding[]): AccessBinding[] {
  const names = new Set(tools.map((tool) => tool.name));
  return [
    ...tools,
    ...CAPABILITY_NATIVE_TOOLS.filter((name) => !names.has(name)).map((name) => ({
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
      caption: `Offered once this server has ${missingVariablesPhrase(waitsFor)} set`,
      bindable: false,
    };
  }
  if ((BROWSER_NATIVE_TOOLS as readonly string[]).includes(item.name)) {
    const on = capabilities?.browser;
    return {
      enabled: on ?? true,
      caption:
        scope === "agent"
          ? on
            ? "Active via browser"
            : "Offered when browser is on"
          : "Offered when an agent has browser on",
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

export const grantLabel: Record<string, string> = {
  read_guild: "Read this agent's guild artifacts",
  read_org: "Read organisation artifacts",
  write_guild: "Write this agent's guild artifacts",
  write_org: "Write organisation artifacts",
};
