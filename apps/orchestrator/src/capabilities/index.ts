import { modelsService, type ModelsService, type OrgModelsPayload } from "../llm/models.js";
import { isSearchable } from "../connectors/builder.js";
import {
  connectorFacts,
  listedTool,
  listServers,
  serverTools,
  type ConnectorFacts,
  type LoadedConnector,
  type ServerTool,
} from "../connectors/servers.js";
import { oauthSetupState, type OauthSetupState } from "../oauth/index.js";
import { OPEN_POLICY, remaining, type OrgLimits, type OrgPolicy } from "../policy/index.js";
import { usageFields, type UsageTotals } from "../usage/index.js";
import {
  ALWAYS_OFFERED_TOOLS,
  BROWSER_CAPABILITY,
  CODING_CAPABILITY,
  NATIVE_CAPABILITY_GROUPS,
} from "./native.js";
import { listMcpConnections, listMcpTools, type ScopedMcpConnectionRow } from "../db/mcp.js";
import { countOrgAgents, countOrgBrowserAgents, countOrgCodingAgents } from "../db/orgs.js";
import { getOrgMonthlyUsage, utcMonth } from "../db/usage.js";
import type { Queryable } from "../db/pg.js";

const FORBIDDEN_CONNECTION_KEYS = new Set([
  "connection_id",
  "ciphertext",
  "nonce",
  "oauth_state",
  "oauth_client",
  "account_hint",
  "token",
  "access_token",
  "refresh_token",
]);

export type CapabilityOrgContext = {
  orgId: string;
};

/** A connector as the Builder's catalog describes it, before the organisation's logins on it. */
export type CatalogConnector = Pick<
  LoadedConnector,
  "slug" | "display_name" | "auth" | "oauth_strategy" | "description" | "limitations" | "setup_hint" | "enabled" | "tool_prefix" | "transport"
> &
  ConnectorFacts & {
    oauth_setup_state: OauthSetupState;
  };

/** One tool the Builder may name: from the connector's manifest, or listed by one of the organisation's logins. */
export type CatalogTool = Pick<ServerTool, "remote_name" | "namespaced_name" | "description" | "default_enabled"> & {
  source: "manifest" | "listed";
};

/** A tool as the catalog lists it beside its connector: its name, and whether it starts on. */
export type CapabilityTool = Pick<CatalogTool, "namespaced_name" | "default_enabled">;

/** Whether the organisation can use a connector now: a login of its own is connected, or not. */
type ConnectionState = "connected" | "registered_not_connected";

/** How the organisation reaches a connector: the scopes its connected logins sit at, and whether the Builder may search it. */
type ConnectorReach = {
  reusable_scopes: ScopedMcpConnectionRow["owner_scope"][];
  searchable: boolean;
  search_via: "builder_search_connected" | null;
};

/** A published connector in the catalog `listCapabilities` returns, with the organisation's reach of it. */
export type CapabilityServer = CatalogConnector &
  ConnectorReach & {
    connection_state: ConnectionState;
    tools: CapabilityTool[];
  };

/** One connector's complete catalog record: a connector without a login is `public_catalog` when its manifest offers tools. */
export type ServerRecord = CatalogConnector &
  ConnectorReach & {
    connection_state: ConnectionState | "public_catalog";
    tools: CatalogTool[];
  };

/** A connector, or one of its tools, matching a capability search, with how well it matched. */
export type CapabilityHit = {
  server: LoadedConnector["slug"];
  display_name: LoadedConnector["display_name"];
  server_description: LoadedConnector["description"];
  limitations: LoadedConnector["limitations"];
  auth: LoadedConnector["auth"];
  tool: CatalogTool["namespaced_name"] | null;
  remote_name: CatalogTool["remote_name"] | null;
  tool_description: CatalogTool["description"];
  default_enabled: CatalogTool["default_enabled"] | null;
  score: number;
};

/** A capability search: its text, and the best twenty hits. */
export type CapabilitySearch = { query: string; hits: CapabilityHit[] };

/** What the Builder and the recipe pages can use: native tools, connectors, models, plan caps and room, and the month's usage. */
export type BuilderCapabilities = {
  native: typeof NATIVE_CAPABILITY_GROUPS;
  always_offered: typeof ALWAYS_OFFERED_TOOLS;
  browser: typeof BROWSER_CAPABILITY;
  coding: typeof CODING_CAPABILITY;
  catalog: CapabilityServer[];
  models: OrgModelsPayload;
  limits: {
    max_agents: OrgLimits["maxAgents"];
    max_browser_agents: OrgLimits["maxBrowserAgents"];
    max_coding_agents: OrgLimits["maxCodingAgents"];
    max_concurrent_runs: OrgLimits["maxConcurrentRuns"];
    monthly_studio_builder_runs: OrgLimits["monthlyCoachRuns"];
  };
  /** How many more agents the organisation may hold, by kind; null where nothing caps it. */
  remaining: { agents: number | null; browser_agents: number | null; coding_agents: number | null };
  usage: Pick<UsageTotals, "cost_usd" | "calls"> & { month: string };
};

/** A connector with the organisation's logins on it. */
type ReachableServer = { server: LoadedConnector; mine: ScopedMcpConnectionRow[] };

function catalogConnector(row: LoadedConnector): CatalogConnector {
  return {
    slug: row.slug,
    display_name: row.display_name,
    auth: row.auth,
    oauth_strategy: row.oauth_strategy,
    oauth_setup_state: oauthSetupState(row),
    description: row.description,
    limitations: row.limitations,
    setup_hint: row.setup_hint,
    enabled: row.enabled,
    tool_prefix: row.tool_prefix,
    transport: row.transport,
    ...connectorFacts(row),
  };
}

/** The connector's reach: the scopes of the organisation's connected logins on it, and its search. */
function connectorReach(server: LoadedConnector, connected: ScopedMcpConnectionRow[]): ConnectorReach {
  return {
    reusable_scopes: [...new Set(connected.map((row) => row.owner_scope))],
    searchable: connected.length > 0 && isSearchable(server),
    search_via: isSearchable(server) ? "builder_search_connected" : null,
  };
}

/** How well `query` matches `text`: 3 for the whole text, 2 for a substring, else the share of its words found. */
function matchScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!t) {
    return 0;
  }
  if (t === q) {
    return 3;
  }
  if (t.includes(q)) {
    return 2;
  }
  const words = q.split(/[^a-z0-9]+/).filter((word) => word.length > 1);
  if (!words.length) {
    return 0;
  }
  return words.filter((word) => t.includes(word)).length / words.length;
}

function assertNoSecrets(value: unknown, path = "capability"): void {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoSecrets(item, `${path}[${index}]`);
    }
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_CONNECTION_KEYS.has(key)) {
      throw new Error(`${path} leaked forbidden field ${key}`);
    }
    assertNoSecrets(item, `${path}.${key}`);
  }
}

export class CapabilityService {
  private models: ModelsService;

  constructor(
    private db: Queryable,
    private policy: OrgPolicy = OPEN_POLICY,
    models?: ModelsService,
  ) {
    this.models = models ?? modelsService(db);
  }

  /** The enabled servers the organisation may use, with its logins on each. */
  private async servers(ctx: CapabilityOrgContext): Promise<ReachableServer[]> {
    const servers = await listServers(this.db, { owner: { visibleTo: ctx.orgId }, enabled: true });
    const connections = await listMcpConnections(this.db, { orgId: ctx.orgId });
    return servers.map((server) => ({
      server,
      mine: connections.filter(
        (row) =>
          row.mcp_server_id === server.id && (row.owner_scope === "org" || row.owner_scope === "platform"),
      ),
    }));
  }

  /** The tools a server offers before any login lists them, then the ones the organisation's connected logins list beside them. */
  private async tools(server: LoadedConnector, mine: ScopedMcpConnectionRow[]): Promise<CatalogTool[]> {
    const tools: CatalogTool[] = serverTools(server).map((tool) => ({
      remote_name: tool.remote_name,
      namespaced_name: tool.namespaced_name,
      description: tool.description,
      default_enabled: tool.default_enabled,
      source: "manifest",
    }));
    const named = new Set(tools.map((tool) => tool.namespaced_name));
    for (const connection of mine.filter((row) => row.status === "connected")) {
      for (const row of await listMcpTools(this.db, connection.id)) {
        const listed = listedTool(server, row);
        if (named.has(listed.namespaced_name)) {
          continue;
        }
        named.add(listed.namespaced_name);
        tools.push({
          remote_name: listed.remote_name,
          namespaced_name: listed.namespaced_name,
          description: listed.description,
          default_enabled: listed.default_enabled,
          source: "listed",
        });
      }
    }
    return tools;
  }

  async listCapabilities(ctx: CapabilityOrgContext): Promise<BuilderCapabilities> {
    const catalog: CapabilityServer[] = [];
    for (const { server, mine } of await this.servers(ctx)) {
      const tools = await this.tools(server, mine);
      const connected = mine.filter((row) => row.status === "connected");
      catalog.push({
        ...catalogConnector(server),
        ...connectorReach(server, connected),
        connection_state: connected.length ? "connected" : "registered_not_connected",
        tools: tools.map((tool) => ({
          namespaced_name: tool.namespaced_name,
          default_enabled: tool.default_enabled,
        })),
      });
    }
    const { limits } = await this.policy.standing(ctx.orgId);
    const agents = await countOrgAgents(this.db, ctx.orgId);
    const browsers = await countOrgBrowserAgents(this.db, ctx.orgId);
    const coders = await countOrgCodingAgents(this.db, ctx.orgId);
    const month = utcMonth();
    const usage = usageFields(await getOrgMonthlyUsage(this.db, ctx.orgId, month));
    const payload: BuilderCapabilities = {
      native: NATIVE_CAPABILITY_GROUPS,
      always_offered: ALWAYS_OFFERED_TOOLS,
      browser: BROWSER_CAPABILITY,
      coding: CODING_CAPABILITY,
      catalog,
      models: await this.models.read(ctx.orgId),
      limits: {
        max_agents: limits.maxAgents,
        max_browser_agents: limits.maxBrowserAgents,
        max_coding_agents: limits.maxCodingAgents,
        max_concurrent_runs: limits.maxConcurrentRuns,
        monthly_studio_builder_runs: limits.monthlyCoachRuns,
      },
      remaining: {
        agents: remaining(limits.maxAgents, agents),
        browser_agents: remaining(limits.maxBrowserAgents, browsers),
        coding_agents: remaining(limits.maxCodingAgents, coders),
      },
      usage: {
        month,
        cost_usd: usage.cost_usd,
        calls: usage.calls,
      },
    };
    assertNoSecrets(payload);
    return payload;
  }

  async searchCapabilities(ctx: CapabilityOrgContext, query: string): Promise<CapabilitySearch> {
    const q = query.trim();
    const hits: CapabilityHit[] = [];
    for (const { server, mine } of await this.servers(ctx)) {
      const serverFields = [server.slug, server.display_name, server.description, server.limitations ?? ""];
      const serverScore = q ? Math.max(...serverFields.map((text) => matchScore(q, text))) : 0;
      const base = {
        server: server.slug,
        display_name: server.display_name,
        server_description: server.description,
        limitations: server.limitations,
        auth: server.auth,
      };
      const tools = await this.tools(server, mine);
      if (!tools.length && (!q || serverScore > 0)) {
        hits.push({ ...base, tool: null, remote_name: null, tool_description: "", default_enabled: null, score: serverScore });
      }
      for (const tool of tools) {
        const score = q
          ? Math.max(serverScore, matchScore(q, tool.remote_name), matchScore(q, tool.namespaced_name), matchScore(q, tool.description))
          : 0;
        if (q && score <= 0) {
          continue;
        }
        hits.push({
          ...base,
          tool: tool.namespaced_name,
          remote_name: tool.remote_name,
          tool_description: tool.description,
          default_enabled: tool.default_enabled,
          score,
        });
      }
    }
    hits.sort(
      (left, right) =>
        right.score - left.score ||
        left.server.localeCompare(right.server) ||
        (left.tool ?? "").localeCompare(right.tool ?? ""),
    );
    const payload: CapabilitySearch = { query, hits: hits.slice(0, 20) };
    assertNoSecrets(payload);
    return payload;
  }

  async describeServer(ctx: CapabilityOrgContext, serverRef: string): Promise<ServerRecord | null> {
    const trimmed = serverRef.trim();
    const found = (await this.servers(ctx)).find(({ server }) => server.id === trimmed || server.slug === trimmed);
    if (!found) {
      return null;
    }
    const { server: row, mine } = found;
    const tools = await this.tools(row, mine);
    const connected = mine.filter((item) => item.status === "connected");
    const payload: ServerRecord = {
      ...catalogConnector(row),
      ...connectorReach(row, connected),
      connection_state: connected.length
        ? "connected"
        : tools.length
          ? "public_catalog"
          : "registered_not_connected",
      tools,
    };
    assertNoSecrets(payload);
    return payload;
  }
}
