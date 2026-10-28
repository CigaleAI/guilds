import type { RemoteInfo } from "../connectors/types.js";
import { assertPublicHost, EndpointError, type HostLookup } from "../net/endpoints.js";
import { proxyFetch, type FetchFn } from "../net/http.js";
import { McpError, McpSessionGoneError } from "./errors.js";

export const PROTOCOL_VERSION = "2025-03-26";
export const LIST_TOOLS_TIMEOUT_MS = 15_000;
export const CALL_TOOL_TIMEOUT_MS = 90_000;
export const LIST_TOOLS_MAX_BYTES = 1_000_000;
export const LIST_TOOLS_MAX = 200;

function parseBody(contentType: string, text: string): unknown {
  if (contentType.includes("text/event-stream")) {
    let data: unknown = null;
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        const raw = line.slice(5).trim();
        if (raw) {
          data = JSON.parse(raw);
        }
      }
    }
    return data;
  }
  if (!text) {
    return {};
  }
  return JSON.parse(text);
}

/** The body as JSON-RPC, or an `McpError` with the status and the start of the body when it is not JSON. */
function parsedPayload(contentType: string, response: { status: number; body: string }): unknown {
  try {
    return parseBody(contentType, response.body);
  } catch {
    const said = response.body.trim().slice(0, 200);
    throw new McpError(`mcp ${response.status}: ${said || "a body that is not JSON"}`, response.status);
  }
}

export function rpcPayload(response: { status: number; headers?: Headers | Record<string, string>; body: string }): unknown {
  const headerValue =
    response.headers instanceof Headers
      ? response.headers.get("content-type") ?? ""
      : String((response.headers ?? {})["content-type"] ?? "");
  const payload = parsedPayload(headerValue, response);
  if (response.status < 400) {
    return payload;
  }
  if (
    payload
    && typeof payload === "object"
    && !Array.isArray(payload)
    && "result" in payload
    && !(payload as { error?: unknown }).error
  ) {
    return payload;
  }
  throw new McpError(`mcp ${response.status}`, response.status);
}

function callText(result: unknown): string {
  if (result === null || result === undefined) {
    return "";
  }
  if (typeof result === "string") {
    return result;
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return JSON.stringify(result);
  }
  const body = result as Record<string, unknown>;
  const content = body.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (item && typeof item === "object" && !Array.isArray(item) && typeof (item as { text?: unknown }).text === "string") {
        parts.push((item as { text: string }).text);
      } else if (typeof item === "string") {
        parts.push(item);
      }
    }
    if (parts.length) {
      return parts.join("\n");
    }
  }
  return JSON.stringify(result);
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
    const payload = parseBody(contentType, body);
    return !payload || typeof payload !== "object" || !("jsonrpc" in payload);
  } catch {
    return true;
  }
}

export class McpSession {
  url: string;
  headers: Record<string, string>;
  private rpcId = 0;
  private sessionId: string | null = null;
  private initialized = false;
  private fetchFn: FetchFn;

  constructor(url: string, headers: Record<string, string> = {}, fetchFn: FetchFn = proxyFetch("", CALL_TOOL_TIMEOUT_MS)) {
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
    const body = result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : {};
    const info = body.serverInfo && typeof body.serverInfo === "object" ? (body.serverInfo as Record<string, unknown>) : {};
    return {
      name: typeof info.title === "string" && info.title.trim() ? info.title.trim() : typeof info.name === "string" ? info.name.trim() : "",
      instructions: typeof body.instructions === "string" ? body.instructions.trim() : "",
    };
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

  async listTools(): Promise<Array<Record<string, unknown>>> {
    const result = await this.onSession(() =>
      this.rpc("tools/list", {}, {
        timeoutMs: LIST_TOOLS_TIMEOUT_MS,
        maxBytes: LIST_TOOLS_MAX_BYTES,
      }),
    );
    const tools = result && typeof result === "object" && !Array.isArray(result)
      ? (result as { tools?: unknown }).tools
      : undefined;
    if (!Array.isArray(tools)) {
      return [];
    }
    const listed = tools.filter((tool): tool is Record<string, unknown> => Boolean(tool) && typeof tool === "object" && !Array.isArray(tool));
    if (listed.length > LIST_TOOLS_MAX) {
      throw new McpError(`mcp tools/list returned more than ${LIST_TOOLS_MAX} tools`);
    }
    return listed;
  }

  async callToolResult(name: string, arguments_: Record<string, unknown>): Promise<unknown> {
    return this.onSession(() => this.rpc("tools/call", { name, arguments: arguments_ }));
  }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<string> {
    return callText(await this.callToolResult(name, arguments_));
  }

  async aclose(): Promise<void> {
    return undefined;
  }

  private async notify(method: string): Promise<void> {
    await this.post({ jsonrpc: "2.0", method });
  }

  private async rpc(
    method: string,
    params: Record<string, unknown>,
    options: { timeoutMs?: number; maxBytes?: number } = {},
  ): Promise<unknown> {
    this.rpcId += 1;
    const payload = await this.post({ jsonrpc: "2.0", id: this.rpcId, method, params }, options);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new McpError(`${method} returned a non-object`);
    }
    if ((payload as { error?: unknown }).error) {
      throw new McpError(String((payload as { error: unknown }).error));
    }
    return (payload as { result?: unknown }).result;
  }

  private async post(
    body: Record<string, unknown>,
    options: { timeoutMs?: number; maxBytes?: number } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this.headers,
    };
    const carried = this.sessionId;
    if (carried) {
      headers["Mcp-Session-Id"] = carried;
    }
    const controller = options.timeoutMs ? new AbortController() : null;
    const timer = controller && options.timeoutMs
      ? setTimeout(() => controller.abort(), options.timeoutMs)
      : null;
    let response: Response;
    try {
      response = await this.fetchFn(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        ...(controller ? { signal: controller.signal } : {}),
      });
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
