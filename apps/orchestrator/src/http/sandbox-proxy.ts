import type { FastifyReply, FastifyRequest } from "fastify";
import { inflateSync, gunzipSync } from "node:zlib";
import { request as undiciRequest } from "undici";
import WebSocket from "ws";
import { HttpError } from "./errors.js";

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
    throw new HttpError(404, "Not Found");
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

function decodeUpstreamBody(body: Buffer, encoding: string | undefined): Buffer {
  const enc = (encoding ?? "").toLowerCase();
  if (enc === "gzip" || enc === "x-gzip") {
    try {
      return gunzipSync(body);
    } catch {
      return body;
    }
  }
  if (enc === "deflate") {
    try {
      return inflateSync(body);
    } catch {
      return body;
    }
  }
  if (body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b) {
    try {
      return gunzipSync(body);
    } catch {
      return body;
    }
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
  socket.on("error", () => {
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  });
  void (async () => {
    try {
      const target = await resolve();
      sendUp = connectUpstream(socket, request, target.base, target.extraHeaders, target.pathPart, pending);
    } catch (error) {
      const code = closeCode(error);
      try {
        socket.close(code);
      } catch {
        /* already closed */
      }
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
  const closeBoth = (code?: number) => {
    try {
      socket.close(code);
    } catch {
      /* already closed */
    }
    try {
      upstream.close();
    } catch {
      /* already closed */
    }
  };
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
    closeBoth();
  });
  upstream.on("close", () => {
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  });
  socket.on("close", () => {
    try {
      upstream.close();
    } catch {
      /* already closed */
    }
  });
  return sendUp;
}
