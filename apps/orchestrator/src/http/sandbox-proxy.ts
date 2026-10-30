import type { FastifyReply, FastifyRequest } from "fastify";
import { inflateSync, gunzipSync } from "node:zlib";
import { request as undiciRequest } from "undici";
import WebSocket from "ws";

/**
 * A request the sandbox proxy refuses, with the status it answers: a path outside the daemon's
 * base is a 404, and a body the daemon marks with an encoding it is not in is a 502.
 */
export class SandboxProxyError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SandboxProxyError";
    this.status = status;
  }
}

export const HOP_REQ = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
]);

export const HOP_RESP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
]);

/**
 * The daemon URL a proxied path names: `pathPart` under the daemon's `base`, on the daemon's host.
 * The path only ever sets the pathname, so a path written as a URL (`http://host/…`, `\\host/…`)
 * stays a path on the daemon; one that resolves outside the base's path is a 404.
 */
export function joinUpstream(base: string, pathPart: string, query: string): string {
  const root = new URL(base.endsWith("/") ? base : `${base}/`);
  const url = new URL(root);
  url.pathname = `${root.pathname}${pathPart}`;
  if (!url.pathname.startsWith(root.pathname)) {
    throw new SandboxProxyError("Not Found", 404);
  }
  if (query) {
    url.search = query.startsWith("?") ? query : `?${query}`;
  }
  return url.toString();
}

export function wsUrl(httpUrl: string): string {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function filterHeaders(
  headers: Record<string, string | string[] | undefined>,
  excluded: Set<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || excluded.has(key.toLowerCase())) {
      continue;
    }
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function rawQuery(request: FastifyRequest): string {
  const url = request.raw.url ?? request.url;
  const index = url.indexOf("?");
  return index === -1 ? "" : url.slice(index + 1);
}

async function requestBody(request: FastifyRequest): Promise<Buffer> {
  const body = request.body;
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (typeof body === "string") {
    return Buffer.from(body);
  }
  if (body && typeof body === "object" && !Array.isArray(body) && Object.keys(body as object).length === 0) {
    return Buffer.alloc(0);
  }
  if (body !== undefined && body !== null && typeof body === "object") {
    return Buffer.from(JSON.stringify(body));
  }
  return Buffer.alloc(0);
}

/** The decoder for each `content-encoding` the proxy decodes. */
const DECODERS = new Map<string, (body: Buffer) => Buffer>([
  ["gzip", (body) => gunzipSync(body)],
  ["x-gzip", (body) => gunzipSync(body)],
  ["deflate", (body) => inflateSync(body)],
]);

/** `body` decoded by `decode`, or null when `body` is not in that encoding. */
function decodedOrNull(body: Buffer, decode: (body: Buffer) => Buffer): Buffer | null {
  try {
    return decode(body);
  } catch {
    return null;
  }
}

function looksGzipped(body: Buffer): boolean {
  return body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b;
}

/**
 * The body a daemon sent, without its `content-encoding`. A body in an encoding the proxy decodes
 * that does not decode is a `SandboxProxyError` 502. Any other body that starts as gzip does is
 * gunzipped when it is gzip, and passed on as it is when it is not.
 */
function decodeUpstreamBody(body: Buffer, encoding: string | undefined): Buffer {
  if (body.length === 0) {
    return body;
  }
  const name = (encoding ?? "").toLowerCase();
  const decode = DECODERS.get(name);
  if (decode) {
    const decoded = decodedOrNull(body, decode);
    if (!decoded) {
      throw new SandboxProxyError(`The sandbox daemon sent a body that is not valid ${name}`, 502);
    }
    return decoded;
  }
  if (looksGzipped(body)) {
    return decodedOrNull(body, (gzipped) => gunzipSync(gzipped)) ?? body;
  }
  return body;
}

export async function proxyHttp(
  request: FastifyRequest,
  reply: FastifyReply,
  base: string,
  extraHeaders: Record<string, string>,
  pathPart: string,
): Promise<void> {
  const url = joinUpstream(base, pathPart, rawQuery(request));
  const incoming: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    incoming[key] = value as string | string[] | undefined;
  }
  const outgoing = filterHeaders(incoming, HOP_REQ);
  Object.assign(outgoing, extraHeaders);
  const body = await requestBody(request);
  const method = request.method.toUpperCase();
  const init: {
    method: "GET";
    headers: Record<string, string>;
    body?: Buffer;
  } = {
    method: method as "GET",
    headers: outgoing,
  };
  if (method !== "GET" && method !== "HEAD") {
    init.body = body;
  }
  const upstream = await undiciRequest(url, init);
  const rawHeaders: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(upstream.headers)) {
    rawHeaders[key] = value as string | string[] | undefined;
  }
  const encoding = Array.isArray(upstream.headers["content-encoding"])
    ? upstream.headers["content-encoding"][0]
    : upstream.headers["content-encoding"];
  const headers = filterHeaders(rawHeaders, HOP_RESP);
  reply.code(upstream.statusCode);
  for (const [key, value] of Object.entries(headers)) {
    reply.header(key, value);
  }
  // websockify serves noVNC with Last-Modified and no Cache-Control, so the
  // browser heuristically caches vnc.html for months, security headers
  // included. A stale entry kept replaying the old X-Frame-Options DENY as
  // "guilds.run refused to connect" long after the edge stopped sending it.
  reply.header("Cache-Control", "no-store");
  if (method === "HEAD") {
    upstream.body.resume();
    await reply.send();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of upstream.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  await reply.send(decodeUpstreamBody(Buffer.concat(chunks), encoding));
}

/** The subprotocols the sandbox daemons speak: noVNC asks for `binary`, ttyd for `tty`. */
const SUBPROTOCOLS = ["binary", "tty"];

/** The subprotocol to agree on with a client, for the WebSocket server's `handleProtocols`. */
export function sandboxSubprotocol(protocols: Set<string> | Iterable<string>): string | false {
  const requested = protocols instanceof Set ? protocols : new Set(protocols);
  return SUBPROTOCOLS.find((name) => requested.has(name)) ?? false;
}

export function requestedSubprotocol(request: FastifyRequest): string | null {
  const header = request.headers["sec-websocket-protocol"];
  const raw = Array.isArray(header) ? header.join(",") : (header ?? "");
  const requested = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return sandboxSubprotocol(requested) || null;
}

function sendUpstream(upstream: WebSocket, data: WebSocket.RawData, binary: boolean): void {
  if (upstream.readyState !== WebSocket.OPEN) {
    return;
  }
  if (binary) {
    const buf = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data as ArrayBuffer);
    upstream.send(buf, { binary: true });
    return;
  }
  const text =
    typeof data === "string"
      ? data
      : Buffer.isBuffer(data)
        ? data.toString("utf8")
        : Array.isArray(data)
          ? Buffer.concat(data).toString("utf8")
          : Buffer.from(data as ArrayBuffer).toString("utf8");
  upstream.send(text, { binary: false });
}

/**
 * Bridges a client WebSocket to a sandbox port. Client frames sent before the
 * target resolves are queued. `onClientMessage` fires for every frame the
 * client sends, which is what operator input looks like from here.
 */
export function startSandboxWsProxy(
  socket: WebSocket,
  request: FastifyRequest,
  resolve: () => Promise<{ base: string; extraHeaders: Record<string, string>; pathPart: string }>,
  closeCode: (error: unknown) => number | undefined,
  onClientMessage?: () => void,
): void {
  const pending: Array<[WebSocket.RawData, boolean]> = [];
  let sendUp: ((data: WebSocket.RawData, binary: boolean) => void) | undefined;
  socket.on("message", (data, isBinary) => {
    const binary = isBinary === true;
    onClientMessage?.();
    if (sendUp) {
      sendUp(data, binary);
      return;
    }
    pending.push([data, binary]);
  });
  // ws makes close() a no-op on a socket already closing or closed, so no close here is guarded.
  socket.on("error", () => {
    socket.close();
  });
  void (async () => {
    try {
      const target = await resolve();
      sendUp = connectUpstream(socket, request, target.base, target.extraHeaders, target.pathPart, pending);
    } catch (error) {
      socket.close(closeCode(error));
    }
  })();
}

function connectUpstream(
  socket: WebSocket,
  request: FastifyRequest,
  base: string,
  extraHeaders: Record<string, string>,
  pathPart: string,
  pending: Array<[WebSocket.RawData, boolean]>,
): (data: WebSocket.RawData, binary: boolean) => void {
  const subprotocol = requestedSubprotocol(request);
  const url = wsUrl(joinUpstream(base, pathPart, rawQuery(request)));
  const upstream = new WebSocket(url, subprotocol ? [subprotocol] : undefined, {
    headers: extraHeaders,
  });
  const sendUp = (data: WebSocket.RawData, binary: boolean) => {
    if (upstream.readyState !== WebSocket.OPEN) {
      pending.push([data, binary]);
      return;
    }
    sendUpstream(upstream, data, binary);
  };
  upstream.on("open", () => {
    for (const [data, binary] of pending.splice(0)) {
      sendUpstream(upstream, data, binary);
    }
  });
  upstream.on("message", (data, isBinary) => {
    const payload = Array.isArray(data) ? Buffer.concat(data) : data;
    if (isBinary) {
      socket.send(payload, { binary: true });
      return;
    }
    socket.send(typeof payload === "string" ? payload : payload.toString(), { binary: false });
  });
  upstream.on("error", () => {
    socket.close();
    upstream.close();
  });
  upstream.on("close", () => {
    socket.close();
  });
  socket.on("close", () => {
    upstream.close();
  });
  return sendUp;
}
