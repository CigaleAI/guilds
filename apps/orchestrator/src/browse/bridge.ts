import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { request as undiciRequest } from "undici";
import WebSocket, { WebSocketServer } from "ws";
import { filterHeaders, HOP_REQ, HOP_RESP, wsUrl } from "../lib/forwarding.js";
import { errorMessage, errorName, writeLog } from "../observability/log.js";

/**
 * An agent's DevTools relay as its sandbox host serves it: the base URL, and the headers every
 * request to it carries.
 */
export type CdpTarget = [string, Record<string, string>];

/** A loopback DevTools endpoint in front of one agent's relay: the port a CDP client is given. */
export type CdpBridge = {
  port: number;
  /** Ends every open connection and stops listening. */
  close(): Promise<void>;
};

/** The bridge could not start listening on the loopback interface. */
export class CdpBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CdpBridgeError";
  }
}

const LOOPBACK = "127.0.0.1";

// The bridge asks for bodies unencoded, since it rewrites them, so a client's accept-encoding
// stays behind with the hop-by-hop headers.
const DROPPED_REQUEST_HEADERS = new Set([...HOP_REQ, "accept-encoding"]);

const DEBUGGER_URL = /("webSocketDebuggerUrl"\s*:\s*")wss?:\/\/[^/"]*\/devtools\//g;

/**
 * A request's target read as a path and a query. A target written as a URL (`//host/...`) stays
 * a path, so a request never names a host of its own.
 */
function requestTarget(requestPath: string): URL {
  return new URL(`http://bridge.invalid${requestPath.startsWith("/") ? "" : "/"}${requestPath}`);
}

/** The relay URL a bridged request names: its path and query under the relay's base path. */
function relayUrl(base: string, requestPath: string): string {
  const requested = requestTarget(requestPath);
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${requested.pathname}`;
  url.search = requested.search;
  return url.toString();
}

/** Whether a request path is one of Chrome's DevTools HTTP endpoints (`/json`, `/json/...`). */
function isDevToolsHttpPath(requestPath: string): boolean {
  const { pathname } = requestTarget(requestPath);
  return pathname === "/json" || pathname.startsWith("/json/");
}

/** Whether a request path is a DevTools WebSocket (`/devtools/browser/...`, `/devtools/page/...`). */
function isDevToolsSocketPath(requestPath: string): boolean {
  return requestTarget(requestPath).pathname.startsWith("/devtools/");
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Forwards a DevTools HTTP request to the relay and answers with the relay's status, headers,
 * and body, every advertised WebSocket URL pointing at the bridge on `port`.
 */
async function forwardDevToolsRequest(
  target: CdpTarget,
  port: number,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const [base, headers] = target;
  const requestPath = request.url ?? "/";
  if (!isDevToolsHttpPath(requestPath)) {
    response.writeHead(404).end();
    return;
  }
  const method = (request.method ?? "GET").toUpperCase();
  const body = await readRequestBody(request);
  const upstream = await undiciRequest(relayUrl(base, requestPath), {
    method,
    headers: {
      ...filterHeaders(request.headers, DROPPED_REQUEST_HEADERS),
      ...headers,
      "accept-encoding": "identity",
    },
    body: method === "GET" || method === "HEAD" ? null : body,
  });
  const text = await upstream.body.text();
  response.writeHead(upstream.statusCode, filterHeaders(upstream.headers, HOP_RESP));
  response.end(text.replace(DEBUGGER_URL, `$1ws://${LOOPBACK}:${port}/devtools/`));
}

/** Answers a request the relay did not answer with a 502, or ends it when its answer had begun. */
function answerRelayFailure(request: IncomingMessage, response: ServerResponse, error: unknown): void {
  writeLog("warn", `CDP bridge request: ${errorMessage(error)}`, {
    operation: "browse.bridge",
    error_type: errorName(error),
    method: request.method ?? null,
  });
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(502).end();
}

/** The bytes of a frame as ws delivers it: one buffer, the fragments of one, or an ArrayBuffer. */
function frameBytes(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}

/** Relays every frame both ways, text as text and binary as binary, and closes each side with the other. */
function pipeFrames(client: WebSocket, upstream: WebSocket): void {
  client.on("message", (data, isBinary) => {
    upstream.send(frameBytes(data), { binary: isBinary });
  });
  upstream.on("message", (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(frameBytes(data), { binary: isBinary });
    }
  });
  // ws makes close() a no-op on a socket already closing or closed, so no close here is guarded.
  client.on("close", () => {
    upstream.close();
  });
  client.on("error", () => {
    client.terminate();
  });
  upstream.on("close", () => {
    client.close();
  });
}

/** One bridge: the relay it forwards to, the client WebSockets it accepted, and the relay's it opened. */
type BridgeConnections = {
  target: CdpTarget;
  sockets: WebSocketServer;
  upstreams: Set<WebSocket>;
};

/**
 * Opens the relay's WebSocket for a client's upgrade and completes the client's handshake once it
 * is open, so a client is only ever connected to a live relay. A relay that cannot be reached
 * ends the client's socket.
 */
function bridgeDevToolsSocket(
  connections: BridgeConnections,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  const { sockets, upstreams } = connections;
  const [base, headers] = connections.target;
  const requestPath = request.url ?? "/";
  if (!isDevToolsSocketPath(requestPath)) {
    socket.destroy();
    return;
  }
  const upstream = new WebSocket(wsUrl(relayUrl(base, requestPath)), {
    headers,
    perMessageDeflate: false,
  });
  upstreams.add(upstream);
  upstream.on("close", () => {
    upstreams.delete(upstream);
  });
  upstream.on("error", (error) => {
    writeLog("warn", `CDP bridge socket: ${errorMessage(error)}`, {
      operation: "browse.bridge",
      error_type: errorName(error),
    });
    upstream.terminate();
    socket.destroy();
  });
  socket.on("close", () => {
    upstream.terminate();
  });
  upstream.once("open", () => {
    sockets.handleUpgrade(request, socket, head, (client) => {
      pipeFrames(client, upstream);
    });
  });
}

async function listenOnLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new CdpBridgeError("the CDP bridge has no TCP port");
  }
  return address.port;
}

/**
 * Opens a DevTools endpoint on an ephemeral loopback port that forwards to an agent's DevTools
 * relay with the relay's headers: Chrome's `/json` endpoints, their WebSocket URLs rewritten to
 * the bridge, and the `/devtools/` WebSockets they name. It is for a CDP client that connects
 * only to a local port and cannot add headers.
 */
export async function openCdpBridge(target: CdpTarget): Promise<CdpBridge> {
  const connections: BridgeConnections = {
    target,
    sockets: new WebSocketServer({ noServer: true, perMessageDeflate: false }),
    upstreams: new Set(),
  };
  let port = 0;
  const server = createServer((request, response) => {
    forwardDevToolsRequest(target, port, request, response).then(undefined, (error: unknown) => {
      answerRelayFailure(request, response, error);
    });
  });
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    bridgeDevToolsSocket(connections, request, socket, head);
  });
  port = await listenOnLoopback(server);
  let closing: Promise<void> | null = null;
  return {
    port,
    close() {
      closing ??= new Promise<void>((resolve) => {
        for (const client of connections.sockets.clients) {
          client.terminate();
        }
        for (const upstream of connections.upstreams) {
          upstream.terminate();
        }
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
