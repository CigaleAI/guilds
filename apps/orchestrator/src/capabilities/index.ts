import { listMcpServers } from "../connectors/servers.js";
import { coreModelCredentials, modelProviderStore } from "../llm/credentials.js";
import { modelsDatabase, ModelsService } from "../llm/models.js";
import { isSearchable } from "../connectors/builder.js";
import { manifestTools, overriddenTool, toolStartsOff } from "../connectors/load.js";
import { connectorFacts } from "../connectors/view.js";
import { oauthSetupState } from "../oauth/index.js";
import { OPEN_POLICY, remaining, type OrgPolicy } from "../policy/index.js";
import { usageFields } from "../usage/index.js";
import {
  ALWAYS_OFFERED_TOOLS,
  BROWSER_CAPABILITY,
  CODING_CAPABILITY,
  NATIVE_CAPABILITY_GROUPS,
} from "./native.js";
import { listMcpConnections, listMcpTools } from "../db/mcp.js";
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


function capabilityServer(row: Record<string, unknown>): Record<string, unknown> {
  return {
    slug: row.slug,
    display_name: row.display_name,
    auth: row.auth,
    oauth_strategy: row.oauth_strategy,
    oauth_setup_state: oauthSetupState(row),
    description: row.description || "",
    limitations: row.limitations ?? null,
    setup_hint: row.setup_hint ?? null,
    enabled: row.enabled !== false,
    tool_prefix: row.tool_prefix,
    transport: row.transport,
    ...connectorFacts(row),
  };
}

/** One tool the builder may name: from the connector's manifest, or listed by one of the organisation's logins. */
type CapabilityTool = {
  remote_name: string;
  namespaced_name: string;
  description: string;
  default_enabled: boolean;
  source: "manifest" | "listed";
};

function capabilityTool(tool: CapabilityTool): Record<string, unknown> {
  return { ...tool };
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
    this.models = models ?? new ModelsService({ db: modelsDatabase(db), credentials: coreModelCredentials(modelProviderStore(db)) });
  }

  /** The enabled servers the organisation may use, with its logins on each. */
  private async servers(ctx: CapabilityOrgContext): Promise<
    Array<{ server: Record<string, unknown>; mine: Array<Record<string, unknown>> }>
  > {
    const servers = (await listMcpServers(this.db, ctx.orgId)).filter((row) => row.enabled !== false);
    const connections = await listMcpConnections(this.db, { orgId: ctx.orgId });
    return servers.map((server) => ({
      server,
      mine: connections.filter(
        (row) =>
          row.mcp_server_id === server.id && (row.owner_scope === "org" || row.owner_scope === "platform"),
      ),
    }));
  }

  /** A server's manifest tools, then the tools the organisation's connected logins list that the manifest does not name. */
  private async tools(server: Record<string, unknown>, mine: Array<Record<string, unknown>>): Promise<CapabilityTool[]> {
    const tools: CapabilityTool[] = manifestTools(server).map((tool) => ({
      remote_name: tool.remote_name,
      namespaced_name: tool.namespaced_name,
      description: tool.description,
      default_enabled: tool.default_enabled,
      source: "manifest",
    }));
    const named = new Set(tools.map((tool) => tool.namespaced_name));
    for (const connection of mine.filter((row) => row.status === "connected")) {
      for (const row of await listMcpTools(this.db, String(connection.id))) {
        const listed = overriddenTool(server, {
          remote_name: String(row.remote_name),
          description: String(row.description ?? ""),
          input_schema: {},
        });
        const namespaced = String(row.namespaced_name);
        if (named.has(namespaced)) {
          continue;
        }
        named.add(namespaced);
        tools.push({
          remote_name: listed.remote_name,
          namespaced_name: namespaced,
          description: listed.description,
          default_enabled: !toolStartsOff(server, listed.remote_name, {
            destructiveHint: typeof row.destructive_hint === "boolean" ? row.destructive_hint : null,
          }),
          source: "listed",
        });
      }
    }
    return tools;
  }

  async listCapabilities(ctx: CapabilityOrgContext): Promise<Record<string, unknown>> {
    const catalog: Array<Record<string, unknown>> = [];
    for (const { server, mine } of await this.servers(ctx)) {
      const tools = await this.tools(server, mine);
      const connected = mine.some((row) => row.status === "connected");
      catalog.push({
        ...capabilityServer(server),
        connection_state: connected ? "connected" : "registered_not_connected",
        reusable_scopes: [
          ...new Set(
            mine.filter((row) => row.status === "connected").map((row) => String(row.owner_scope)),
          ),
        ],
        tools: tools.map((tool) => ({
          namespaced_name: tool.namespaced_name,
          default_enabled: tool.default_enabled,
        })),
        searchable: connected && isSearchable(server),
        search_via: isSearchable(server) ? "builder_search_connected" : null,
      });
    }
    const { limits } = await this.policy.standing(ctx.orgId);
    const agents = await countOrgAgents(this.db, ctx.orgId);
    const browsers = await countOrgBrowserAgents(this.db, ctx.orgId);
    const coders = await countOrgCodingAgents(this.db, ctx.orgId);
    const month = utcMonth();
    const usage = usageFields(await getOrgMonthlyUsage(this.db, ctx.orgId, month));
    const payload = {
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

  async searchCapabilities(ctx: CapabilityOrgContext, query: string): Promise<Record<string, unknown>> {
    const q = query.trim();
    const hits: Array<Record<string, unknown>> = [];
    for (const { server, mine } of await this.servers(ctx)) {
      const serverFields = [
        String(server.slug),
        String(server.display_name ?? ""),
        String(server.description ?? ""),
        String(server.limitations ?? ""),
      ];
      const serverScore = q ? Math.max(...serverFields.map((text) => matchScore(q, text))) : 0;
      const base = {
        server: server.slug,
        display_name: server.display_name,
        server_description: server.description || "",
        limitations: server.limitations ?? null,
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
        Number(right.score) - Number(left.score) ||
        String(left.server).localeCompare(String(right.server)) ||
        String(left.tool ?? "").localeCompare(String(right.tool ?? "")),
    );
    const payload = { query, hits: hits.slice(0, 20) };
    assertNoSecrets(payload);
    return payload;
  }

  async describeServer(ctx: CapabilityOrgContext, serverRef: string): Promise<Record<string, unknown> | null> {
    const trimmed = serverRef.trim();
    const found = (await this.servers(ctx)).find(({ server }) => server.id === trimmed || server.slug === trimmed);
    if (!found) {
      return null;
    }
    const { server: row, mine } = found;
    const tools = (await this.tools(row, mine)).map(capabilityTool);
    const connected = mine.some((item) => item.status === "connected");
    const payload = {
      ...capabilityServer(row),
      connection_state: connected
        ? "connected"
        : tools.length
          ? "public_catalog"
          : "registered_not_connected",
      reusable_scopes: [
        ...new Set(
          mine.filter((item) => item.status === "connected").map((item) => String(item.owner_scope)),
        ),
      ],
      tools,
      searchable: connected && isSearchable(row),
      search_via: isSearchable(row) ? "builder_search_connected" : null,
    };
    assertNoSecrets(payload);
    return payload;
  }
}
