import { Type, type Static } from "typebox";
import type { RemoteInfo } from "../connectors/types.js";
import { ToolInputSchema } from "../db/schema/index.js";
import { keepMatching } from "../lib/decode.js";
import { isJsonObject, isObjectNode, type JsonObject, type JsonValue } from "../lib/json.js";
import { assertPublicHost, EndpointError, type HostLookup } from "../net/endpoints.js";
import { proxyFetch, type FetchFn } from "../net/http.js";
import { McpError, McpSessionGoneError } from "./errors.js";

export const PROTOCOL_VERSION = "2025-03-26";
export const LIST_TOOLS_TIMEOUT_MS = 15_000;
export const CALL_TOOL_TIMEOUT_MS = 90_000;
export const LIST_TOOLS_MAX_BYTES = 1_000_000;
export const LIST_TOOLS_MAX = 200;

/** A reply from an MCP endpoint: its status, its headers when known, and its body as text. */
export type RpcResponse = { status: number; headers?: Headers | Record<string, string>; body: string };

/** The headers a session sends with each request, by name: the connector's own, and a login's credential. */
export type SessionHeaders = Record<string, string>;

/** How long a request may take and how large its reply may be; each one left out is unbounded. */
type RequestLimits = { timeoutMs?: number; maxBytes?: number };

/** What a server says it is in its `initialize` result (MCP `Implementation`): its name, and the title it is shown by. */
const Implementation = Type.Object({ name: Type.String(), title: Type.Optional(Type.String()) });

/** A server's `initialize` result (MCP `InitializeResult`): what it is, and how it says to use it. */
const InitializeResult = Type.Object({
  serverInfo: Type.Optional(Implementation),
  instructions: Type.Optional(Type.String()),
});

/** What a tool says of its effects (MCP `ToolAnnotations`): whether it only reads, and whether it may destroy. */
const ToolAnnotations = Type.Object({
  readOnlyHint: Type.Optional(Type.Boolean()),
  destructiveHint: Type.Optional(Type.Boolean()),
});

/**
 * A tool a server's `tools/list` offers (MCP `Tool`): its name, which holds more than whitespace,
 * what it does, the JSON Schema of its input, and what it says of its effects. An input schema
 * that is not a JSON Schema the box reads is left out, so the tool takes any object.
 */
const McpTool = Type.Object({
  name: Type.String({ pattern: "\\S" }),
  description: Type.Optional(Type.String()),
  inputSchema: Type.Optional(ToolInputSchema),
  annotations: Type.Optional(ToolAnnotations),
});
export type McpTool = Static<typeof McpTool>;

/** A server's `tools/list` result (MCP `ListToolsResult`): the tools it offers, each read on its own. */
const ListToolsResult = Type.Object({ tools: Type.Array(Type.Unknown()) });

/** A text part of a tool result's content (MCP `TextContent`): its text. */
const TextContent = Type.Object({ text: Type.String() });

/**
 * A JSON-RPC 2.0 message as a server sends it: the protocol version it names, and the result of
 * the request or the error it failed with, each the JSON the server chose.
 */
export type JsonRpcMessage = { jsonrpc?: JsonValue; result?: JsonValue; error?: JsonValue };

/** A server's `tools/call` result (MCP `CallToolResult`): its content, a list of parts, which some servers send as bare text. */
type CallToolResult = { content?: JsonValue };

/**
 * The JSON-RPC message a reply body carries: the JSON object of an event stream's last `data:`
 * line, or of the body; an empty body is an empty message. Null when the stream has no data or
 * the JSON is not an object. A body that is not JSON throws.
 */
function parseMessage(contentType: string, text: string): JsonRpcMessage | null {
  if (!contentType.includes("text/event-stream")) {
    return text ? jsonObjectOf(text) : {};
  }
  let message: JsonRpcMessage | null = null;
  for (const line of text.split(/\r?\n/)) {
    const raw = line.startsWith("data:") ? line.slice(5).trim() : "";
    if (raw) {
      message = jsonObjectOf(raw);
    }
  }
  return message;
}

/** The JSON object `text` holds, or null when it holds another JSON value. Text that is not JSON throws. */
function jsonObjectOf(text: string): JsonObject | null {
  const parsed: unknown = JSON.parse(text);
  return isJsonObject(parsed) ? parsed : null;
}

/** The body as a JSON-RPC message, or an `McpError` with the status and the start of the body when it is not JSON. */
function parsedPayload(contentType: string, response: RpcResponse): JsonRpcMessage | null {
  try {
    return parseMessage(contentType, response.body);
  } catch {
    const said = response.body.trim().slice(0, 200);
    throw new McpError(`mcp ${response.status}: ${said || "a body that is not JSON"}`, response.status);
  }
}

/**
 * The JSON-RPC message a reply carries; null when it carries no JSON object. A reply that fails
 * is an `McpError` with its status, unless its message still holds a result and no error.
 */
export function rpcPayload(response: RpcResponse): JsonRpcMessage | null {
  const headerValue =
    response.headers instanceof Headers
      ? response.headers.get("content-type") ?? ""
      : String((response.headers ?? {})["content-type"] ?? "");
  const payload = parsedPayload(headerValue, response);
  if (response.status < 400) {
    return payload;
  }
  if (payload !== null && payload.result !== undefined && !payload.error) {
    return payload;
  }
  throw new McpError(`mcp ${response.status}`, response.status);
}

/** Whether a tool result, or a part of its content, is bare text rather than a structured value. */
function isText(value: JsonValue): value is string {
  return typeof value === "string";
}

/** The text of each part of a tool result's content: a part's `text`, or the part itself when it is text. */
function textParts(content: JsonValue[]): string[] {
  return content.flatMap((item) => {
    if (isText(item)) {
      return [item];
    }
    const part = isObjectNode(item) ? keepMatching(TextContent, item) : null;
    return part === null ? [] : [part.text];
  });
}

/**
 * A tool result as text (MCP `CallToolResult`): its content when that is text, the text of its
 * content's parts, or the result as JSON when it holds neither; empty when there is none.
 */
function callText(result: JsonValue | undefined): string {
  if (result === undefined || result === null) {
    return "";
  }
  if (isText(result)) {
    return result;
  }
  const call: CallToolResult | null = isObjectNode(result) ? result : null;
  const content = call?.content;
  if (content !== undefined && isText(content)) {
    return content;
  }
  const parts = Array.isArray(content) ? textParts(content) : [];
  if (parts.length) {
    return parts.join("\n");
  }
  return JSON.stringify(result);
}

/** What a server's `initialize` result says of it: its title, else its name, and its instructions; each empty when it says none. */
function remoteInfo(result: JsonValue | undefined): RemoteInfo {
  const body = (result !== undefined && isObjectNode(result) ? keepMatching(InitializeResult, result) : null) ?? {};
  const { title = "", name = "" } = body.serverInfo ?? {};
  return { name: title.trim() || name.trim(), instructions: (body.instructions ?? "").trim() };
}

/** The tool a `tools/list` entry describes; one that names none fails the listing. */
function listedTool(entry: JsonObject): McpTool {
  const tool = keepMatching(McpTool, entry);
  if (tool === null) {
    throw new McpError("mcp tool is missing a name");
  }
  return tool;
}

/**
 * A fetch that refuses an endpoint whose host resolves to a private or local address, checked
 * before each request so a name that moves inward is caught.
 */
export function publicOnly(fetchFn: FetchFn, resolve?: HostLookup): FetchFn {
  return async (url, init) => {
    try {
      await assertPublicHost(new URL(String(url)).hostname, resolve);
    } catch (error) {
      if (error instanceof EndpointError) {
        throw new McpError(error.message, 403);
      }
      throw error;
    }
    return fetchFn(url, init);
  };
}

/** Whether a reply to a request that carried a session says the server no longer knows it. */
function sessionGone(status: number, contentType: string, body: string): boolean {
  if (status === 404) {
    return true;
  }
  if (status !== 400) {
    return false;
  }
  try {
    const payload = parseMessage(contentType, body);
    return payload === null || payload.jsonrpc === undefined;
  } catch {
    return true;
  }
}

export class McpSession {
  url: string;
  headers: SessionHeaders;
  private rpcId = 0;
  private sessionId: string | null = null;
  private initialized = false;
  private fetchFn: FetchFn;

  constructor(url: string, headers: SessionHeaders = {}, fetchFn: FetchFn = proxyFetch("", CALL_TOOL_TIMEOUT_MS)) {
    this.url = url;
    this.headers = headers;
    this.fetchFn = fetchFn;
  }

  /** Starts the session; answers the server's name and instructions from its `initialize` result. */
  async initialize(): Promise<RemoteInfo> {
    const result = await this.rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "guilds", version: "0.1" },
    });
    await this.notify("notifications/initialized");
    this.initialized = true;
    return remoteInfo(result);
  }

  /** Runs `work` on a started session. A session the server no longer knows starts over, once. */
  private async onSession<T>(work: () => Promise<T>): Promise<T> {
    try {
      if (!this.initialized) {
        await this.initialize();
      }
      return await work();
    } catch (error) {
      if (!(error instanceof McpSessionGoneError)) {
        throw error;
      }
      this.sessionId = null;
      this.initialized = false;
      await this.initialize();
      return work();
    }
  }

  /** The tools the server lists; an entry that is not an object is skipped, and more than `LIST_TOOLS_MAX` fail. */
  async listTools(): Promise<McpTool[]> {
    const result = await this.onSession(() =>
      this.rpc("tools/list", {}, {
        timeoutMs: LIST_TOOLS_TIMEOUT_MS,
        maxBytes: LIST_TOOLS_MAX_BYTES,
      }),
    );
    const listing = result !== undefined && isObjectNode(result) ? keepMatching(ListToolsResult, result) : null;
    const listed = (listing?.tools ?? []).filter(isJsonObject);
    if (listed.length > LIST_TOOLS_MAX) {
      throw new McpError(`mcp tools/list returned more than ${LIST_TOOLS_MAX} tools`);
    }
    return listed.map(listedTool);
  }

  /** Calls one of the server's tools with the arguments the model wrote, and answers its result as text. */
  async callTool(name: string, arguments_: JsonObject): Promise<string> {
    return callText(await this.onSession(() => this.rpc("tools/call", { name, arguments: arguments_ })));
  }

  async aclose(): Promise<void> {
    return undefined;
  }

  private async notify(method: string): Promise<void> {
    await this.post({ jsonrpc: "2.0", method });
  }

  /** The result of a JSON-RPC request; a reply with no JSON-RPC message, or with an error, is an `McpError`. */
  private async rpc(
    method: string,
    params: JsonObject,
    options: RequestLimits = {},
  ): Promise<JsonValue | undefined> {
    this.rpcId += 1;
    const payload = await this.post({ jsonrpc: "2.0", id: this.rpcId, method, params }, options);
    if (payload === null) {
      throw new McpError(`${method} returned a non-object`);
    }
    if (payload.error) {
      throw new McpError(String(payload.error));
    }
    return payload.result;
  }

  /** Sends `init` to the endpoint, aborted once `timeoutMs` passes, when given; an abort is an `McpError`. */
  private async send(init: RequestInit, timeoutMs: number | undefined): Promise<Response> {
    const controller = timeoutMs ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      return await this.fetchFn(this.url, controller ? { ...init, signal: controller.signal } : init);
    } catch (error) {
      if (controller?.signal.aborted) {
        throw new McpError("mcp tools/list timed out");
      }
      throw error;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /** Posts a JSON-RPC message on the session, and answers the message the reply carries. */
  private async post(
    body: JsonObject,
    options: RequestLimits = {},
  ): Promise<JsonRpcMessage | null> {
    const carried = this.sessionId;
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this.headers,
      ...(carried ? { "Mcp-Session-Id": carried } : {}),
    };
    const response = await this.send({ method: "POST", headers, body: JSON.stringify(body) }, options.timeoutMs);
    const session = response.headers.get("mcp-session-id");
    if (session) {
      this.sessionId = session;
    }
    const text = await response.text();
    if (options.maxBytes !== undefined && Buffer.byteLength(text, "utf8") > options.maxBytes) {
      throw new McpError("mcp tools/list response exceeded byte limit");
    }
    if (carried && sessionGone(response.status, response.headers.get("content-type") ?? "", text)) {
      throw new McpSessionGoneError(response.status);
    }
    return rpcPayload({
      status: response.status,
      headers: response.headers,
      body: text,
    });
  }
}
