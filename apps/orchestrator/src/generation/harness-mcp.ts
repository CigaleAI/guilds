import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Type, type Static } from "typebox";
import { HARNESS_MCP_SERVER } from "../coding/harnesses.js";
import { getAgent } from "../db/agents.js";
import { listBindingsCovering } from "../db/bindings.js";
import { bindQuery, type BoundQuery, type Queryable } from "../db/pg.js";
import { listMessages } from "../db/runs.js";
import type { ToolCall } from "../db/schema/index.js";
import { keepMatching } from "../lib/decode.js";
import { newId } from "../lib/ids.js";
import { JsonObjectSchema, type JsonObject } from "../lib/json.js";
import type { ToolSchema } from "../lib/tool-schema.js";
import { AsyncLock } from "../lib/lock.js";
import { PROTOCOL_VERSION } from "../mcp/session.js";
import type { HarnessMcpAccess } from "../toolbox/harness-ops.js";
import { GenerationBlocked, HarnessMcpRefused, TOOL_CALL_LIMIT_MESSAGE } from "./errors.js";
import type { SubscriptionGeneration } from "./harness-loop.js";
import {
  liveOfferedNames,
  offeredToolSettings,
  snapshotOfferedNames,
  toolSchemaName,
  type ToolBindingScope,
} from "./offered-tools.js";
import { executedToolCalls, type GenerationTools, type ToolCalls } from "./tool-calls.js";

// The orchestrator's MCP server, which serves a subscription agent's harness the Guilds tools its
// run offers, over MCP's Streamable HTTP transport answered with plain JSON. Each generation's
// turn holds one grant: a random token bound to its agent and run, held only in this process,
// compared by its digest, and revoked when the generation ends. A call goes the way a model's
// call goes, one at a time in arrival order, and is kept as the run's rows.

/** The bytes of randomness in a turn's token: 256 bits from the platform's CSPRNG. */
const TOKEN_BYTES = 32;

/** The name a turn's token is redacted under in its run's rows. */
export const HARNESS_MCP_TOKEN_SECRET = "HARNESS_MCP_TOKEN";

/** The latest protocol version the server speaks, which it answers a client asking for one it does not with. */
const LATEST_PROTOCOL_VERSION = "2025-11-25";

/** The protocol versions the server speaks. */
const PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, "2025-06-18", PROTOCOL_VERSION, "2024-11-05"];

/** What the server says it is in its `initialize` result. */
const SERVER_INFO = { name: HARNESS_MCP_SERVER, version: "1.0.0" };

/** The JSON-RPC error codes the server answers with. */
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

/** A JSON-RPC message a harness sends the server: a request when it has an `id`, a notification otherwise. */
export const HarnessMcpMessage = Type.Object({
  jsonrpc: Type.Literal("2.0"),
  id: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Number()])),
  method: Type.String({ maxLength: 200 }),
  params: Type.Optional(JsonObjectSchema),
});
export type HarnessMcpMessage = Static<typeof HarnessMcpMessage>;

/** The params of `initialize` the server reads: the protocol version the client asks for. */
const InitializeParams = Type.Object({ protocolVersion: Type.Optional(Type.String()) });

/** The params of `tools/call`: the tool, and the arguments the harness's model wrote. */
const CallToolParams = Type.Object({ name: Type.String(), arguments: Type.Optional(JsonObjectSchema) });
type CallToolParams = Static<typeof CallToolParams>;

/** A tool as the server lists it (MCP `Tool`): its name, what it does, and its input's JSON Schema. */
type ServedTool = { name: string; description: string; inputSchema: ToolSchema };

/** A `tools/call` result (MCP `CallToolResult`): the tool's text, and whether the call failed. */
type ServedCallResult = { content: Array<{ type: "text"; text: string }>; isError: boolean };

/** The result of a request the server answers: what it is, the tools it lists, a call's result, or nothing. */
type ServedResult =
  | { protocolVersion: string; capabilities: { tools: JsonObject }; serverInfo: typeof SERVER_INFO }
  | { tools: ServedTool[] }
  | ServedCallResult
  | JsonObject;

/** A JSON-RPC response the server sends: a request's result, or the error it failed with. */
export type HarnessMcpResponse =
  | { jsonrpc: "2.0"; id: string | number; result: ServedResult }
  | { jsonrpc: "2.0"; id: string | number; error: { code: number; message: string } };

/**
 * What the server asks of a turn its calls ended: its tool calls reached the run's limit, or a
 * call filed a blocking issue. The harness loop stops the harness and ends the generation with it.
 */
export type HarnessTurnStop = { kind: "max_tool_calls" } | { kind: "blocked"; issueId: string };

/**
 * A generation's grant on the server: the generation and its tools, whose redaction holds the
 * token, the token's digest it is compared by, its calls in arrival order, and the stop its calls
 * asked of its turn, null until one does.
 */
export type HarnessGrant = {
  gen: SubscriptionGeneration;
  tools: GenerationTools;
  digest: Buffer;
  calls: AsyncLock;
  stop: HarnessTurnStop | null;
};

/** A grant just opened, and the MCP server its generation's turn is given under it. */
export type HarnessMcpOpening = { grant: HarnessGrant; access: HarnessMcpAccess };

/** The db/ functions the server reads an agent's live offer and a run's tool calls through. */
export type HarnessMcpDatabase = {
  getAgent: BoundQuery<typeof getAgent>;
  listBindingsCovering: BoundQuery<typeof listBindingsCovering>;
  listMessages: BoundQuery<typeof listMessages>;
};

/** The db/ functions the server reads an agent's live offer and a run's tool calls through, on `db`. */
export function harnessMcpDatabase(db: Queryable): HarnessMcpDatabase {
  return {
    getAgent: bindQuery(db, getAgent),
    listBindingsCovering: bindQuery(db, listBindingsCovering),
    listMessages: bindQuery(db, listMessages),
  };
}

/** What the server serves with, built once by the loop: where its calls run and are kept. */
export type HarnessMcpServices = { db: HarnessMcpDatabase; toolCalls: ToolCalls };

/** The SHA-256 digest a token is kept and compared as. */
function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** The bearer token an `Authorization` header carries; null when it carries none. */
export function bearerToken(authorization: string | undefined): string | null {
  const match = /^Bearer ([A-Za-z0-9_-]{1,256})$/i.exec(authorization?.trim() ?? "");
  return match?.[1] ?? null;
}

/** The protocol version the server answers a client asking for `asked` with. */
export function servedProtocolVersion(asked: string | undefined): string {
  return asked !== undefined && PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST_PROTOCOL_VERSION;
}

/** The tools a generation offers under the names its agent's live bindings and settings still grant. */
export function narrowedTools(tools: GenerationTools, live: Set<string>): GenerationTools {
  const offered = tools.run.offered_tools;
  const names = new Set([...live].filter((name) => offered === null || offered.has(name)));
  const dynamic = names.has("script_run") ? tools.run.dynamic_tools : {};
  return {
    ...tools,
    run: { ...tools.run, offered_tools: names, dynamic_tools: dynamic },
    schemas: tools.schemas.filter((tool) => names.has(toolSchemaName(tool)) || toolSchemaName(tool) in dynamic),
    connections: new Map([...tools.connections].filter(([name]) => names.has(name))),
  };
}

/** A tool as the server lists it, from its schema as a model is offered it. */
function servedTool(tool: GenerationTools["schemas"][number]): ServedTool {
  return { name: tool.function.name, description: tool.function.description, inputSchema: tool.function.parameters };
}

/** A call's result that is the server's own refusal: its text, failed. */
function refusedCall(text: string): ServedCallResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** What a call made after a turn's stop is refused with. */
function stopText(stop: HarnessTurnStop): string {
  return stop.kind === "blocked" ? new GenerationBlocked(stop.issueId).message : TOOL_CALL_LIMIT_MESSAGE;
}

/**
 * The orchestrator's MCP server for subscription agents' harness turns: the grants of the turns
 * running in this process, and the requests their harnesses send.
 */
export class HarnessMcpServer {
  /** Each agent's grant, while its generation runs; an agent generates one run at a time. */
  private readonly grants = new Map<string, HarnessGrant>();

  constructor(
    private readonly services: HarnessMcpServices,
    /** The URL the server is reached at from a sandbox; the agent's path follows it. */
    private readonly baseUrl: string,
  ) {}

  /**
   * Opens the generation's grant: a new token, bound to its agent and run, that the server accepts
   * until `close`, and that the run's rows are redacted of. An agent's earlier grant is revoked.
   */
  open(gen: SubscriptionGeneration, tools: GenerationTools): HarnessMcpOpening {
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const secrets = { ...tools.secrets, [HARNESS_MCP_TOKEN_SECRET]: token };
    const redacting: GenerationTools = { ...tools, secrets, run: { ...tools.run, secrets: { ...tools.run.secrets, [HARNESS_MCP_TOKEN_SECRET]: token } } };
    const grant: HarnessGrant = { gen, tools: redacting, digest: tokenDigest(token), calls: new AsyncLock(), stop: null };
    this.grants.set(gen.agent.id, grant);
    return { grant, access: { url: `${this.baseUrl}/mcp/${encodeURIComponent(gen.agent.id)}`, token } };
  }

  /** Revokes the grant, then waits for the call it is running; a call still waiting is refused. */
  async close(grant: HarnessGrant): Promise<void> {
    if (this.grants.get(grant.gen.agent.id) === grant) {
      this.grants.delete(grant.gen.agent.id);
    }
    await grant.calls.run(() => undefined);
  }

  /** Whether the grant is still the one its agent holds. */
  private isOpen(grant: HarnessGrant): boolean {
    return this.grants.get(grant.gen.agent.id) === grant;
  }

  /**
   * The grant a request to agent `agentId`'s path holds by its `Authorization` header; refused
   * with `HarnessMcpRefused` when it holds none, whatever the reason.
   */
  private grantOf(agentId: string, authorization: string | undefined): HarnessGrant {
    const token = bearerToken(authorization);
    const grant = this.grants.get(agentId);
    if (token === null || grant === undefined || !timingSafeEqual(tokenDigest(token), grant.digest)) {
      throw new HarnessMcpRefused();
    }
    return grant;
  }

  /**
   * Answers a message to agent `agentId`'s path: the response to a request, or null for a
   * notification. A message without the token of the agent's running generation is refused with
   * `HarnessMcpRefused`.
   */
  async answer(agentId: string, authorization: string | undefined, message: HarnessMcpMessage): Promise<HarnessMcpResponse | null> {
    const grant = this.grantOf(agentId, authorization);
    if (message.id === undefined) {
      return null;
    }
    const params = message.params ?? {};
    switch (message.method) {
      case "initialize":
        return this.respond(message.id, {
          protocolVersion: servedProtocolVersion(keepMatching(InitializeParams, params)?.protocolVersion),
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      case "ping":
        return this.respond(message.id, {});
      case "tools/list":
        return this.respond(message.id, { tools: (await this.liveTools(grant)).schemas.map(servedTool) });
      case "tools/call":
        return this.answerCall(grant, message.id, params);
      default:
        return this.fail(message.id, METHOD_NOT_FOUND, `method ${message.method} not found`);
    }
  }

  private respond(id: string | number, result: ServedResult): HarnessMcpResponse {
    return { jsonrpc: "2.0", id, result };
  }

  private fail(id: string | number, code: number, message: string): HarnessMcpResponse {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }

  /** Answers a `tools/call`: its params checked, then the call run after the grant's earlier calls. */
  private async answerCall(grant: HarnessGrant, id: string | number, params: JsonObject): Promise<HarnessMcpResponse> {
    const call = keepMatching(CallToolParams, params);
    if (call === null) {
      return this.fail(id, INVALID_PARAMS, "tools/call takes a tool name and its arguments");
    }
    const result = await grant.calls.run(() => this.runCall(grant, call));
    return result === null ? this.fail(id, INVALID_PARAMS, `unknown tool ${call.name}`) : this.respond(id, result);
  }

  /**
   * Runs one call of the grant's turn as the run's tool call; null for a tool the run does not
   * offer now. A call after the turn's stop, or past the run's tool-call limit, is refused, and
   * the one that reaches the limit, or that files a blocking issue, asks the turn to stop.
   */
  private async runCall(grant: HarnessGrant, params: CallToolParams): Promise<ServedCallResult | null> {
    if (!this.isOpen(grant)) {
      throw new HarnessMcpRefused();
    }
    if (grant.stop !== null) {
      return refusedCall(stopText(grant.stop));
    }
    const tools = await this.liveTools(grant);
    const name = params.name;
    if (!tools.run.offered_tools?.has(name) && !(name in tools.run.dynamic_tools)) {
      return null;
    }
    if (executedToolCalls(await this.services.db.listMessages(grant.gen.runId)) >= tools.maxToolCalls) {
      grant.stop = { kind: "max_tool_calls" };
      return refusedCall(TOOL_CALL_LIMIT_MESSAGE);
    }
    const call: ToolCall = { id: newId("mcp"), type: "function", function: { name, arguments: JSON.stringify(params.arguments ?? {}) } };
    const [payload, metadata] = await this.services.toolCalls.executeHarnessCall(grant.gen, tools, call);
    if (metadata.blocking_issue_id !== undefined) {
      grant.stop = { kind: "blocked", issueId: metadata.blocking_issue_id };
    }
    return { content: [{ type: "text", text: payload.content }], isError: metadata.error !== null };
  }

  /** The grant's tools as its agent's live bindings and settings offer them now. */
  private async liveTools(grant: HarnessGrant): Promise<GenerationTools> {
    const { db } = this.services;
    const { agent, run } = grant.gen;
    const live = await db.getAgent(agent.id);
    if (live === null) {
      throw new HarnessMcpRefused();
    }
    const scope: ToolBindingScope = { orgId: agent.org_id || null, guildId: agent.guild_id, agentId: agent.id };
    const rows = await db.listBindingsCovering(scope);
    const names = liveOfferedNames(snapshotOfferedNames(grant.gen.snapshot.tools), rows, scope, offeredToolSettings(live.config, run.kind));
    return narrowedTools(grant.tools, names);
  }
}
