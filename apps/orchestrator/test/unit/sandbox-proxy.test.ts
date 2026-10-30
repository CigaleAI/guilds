import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { gzipSync } from "node:zlib";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import WebSocket, { WebSocketServer } from "ws";
import { registerErrorHandler } from "../../src/http/error-handler.js";
import {
  joinUpstream,
  proxyHttp,
  requestedSubprotocol,
  SandboxProxyError,
  startSandboxWsProxy,
} from "../../src/http/sandbox-proxy.js";

// Mirrors websockify's static handler: Last-Modified, no Cache-Control. A few paths answer with a
// body in, or claiming, an encoding.
const ENCODED: Record<string, [Record<string, string>, Buffer]> = {
  "/gzip": [{ "Content-Encoding": "gzip" }, gzipSync("decoded")],
  "/gzip-corrupt": [{ "Content-Encoding": "gzip" }, Buffer.from("not gzip")],
  "/deflate-corrupt": [{ "Content-Encoding": "deflate" }, Buffer.from("not deflate")],
  "/gzip-lookalike": [{}, Buffer.from([0x1f, 0x8b, 0x00, 0x01, 0x02])],
};
let upstream: Server;
let base = "";

before(async () => {
  upstream = createServer((request, response) => {
    const encoded = ENCODED[request.url ?? ""];
    if (encoded) {
      response.writeHead(200, encoded[0]);
      response.end(encoded[1]);
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/html",
      "Last-Modified": "Mon, 01 Jan 2024 00:00:00 GMT",
      "x-upstream": "1",
    });
    response.end(`<!doctype html>${request.url}`);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

/** An app that proxies `/vnc/*` to the upstream and answers errors as the orchestrator does. */
function proxyApp(): FastifyInstance {
  const app = Fastify();
  registerErrorHandler(app);
  app.get("/vnc/*", async (request, reply) => {
    await proxyHttp(request, reply, base, {}, (request.params as { "*": string })["*"]);
  });
  return app;
}

test("proxied sandbox responses are never cached by the browser", async () => {
  const app = proxyApp();
  try {
    const response = await app.inject({ method: "GET", url: "/vnc/vnc.html?autoconnect=1" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["x-upstream"], "1");
    assert.equal(response.headers["last-modified"], "Mon, 01 Jan 2024 00:00:00 GMT");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.body, "<!doctype html>/vnc.html?autoconnect=1");
  } finally {
    await app.close();
  }
});

test("a body the daemon encodes reaches the browser decoded, without its content-encoding", async () => {
  const app = proxyApp();
  try {
    const response = await app.inject({ method: "GET", url: "/vnc/gzip" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-encoding"], undefined);
    assert.equal(response.body, "decoded");
  } finally {
    await app.close();
  }
});

test("a body that is not in the encoding the daemon names is a 502", async () => {
  const app = proxyApp();
  try {
    const cases: Array<[string, string]> = [
      ["gzip-corrupt", "gzip"],
      ["deflate-corrupt", "deflate"],
    ];
    for (const [path, encoding] of cases) {
      const response = await app.inject({ method: "GET", url: `/vnc/${path}` });
      assert.equal(response.statusCode, 502, path);
      assert.deepEqual(response.json(), {
        detail: `The sandbox daemon sent a body that is not valid ${encoding}`,
      });
    }
  } finally {
    await app.close();
  }
});

test("a body with no encoding that only starts as gzip does is passed on as it is", async () => {
  const app = proxyApp();
  try {
    const response = await app.inject({ method: "GET", url: "/vnc/gzip-lookalike" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.rawPayload, ENCODED["/gzip-lookalike"]?.[1]);
  } finally {
    await app.close();
  }
});

test("the proxy forwards the subprotocol a sandbox daemon speaks", () => {
  const withHeader = (value?: string) =>
    ({ headers: value === undefined ? {} : { "sec-websocket-protocol": value } }) as Parameters<
      typeof requestedSubprotocol
    >[0];
  assert.equal(requestedSubprotocol(withHeader("binary")), "binary");
  assert.equal(requestedSubprotocol(withHeader("tty")), "tty");
  assert.equal(requestedSubprotocol(withHeader("chat, tty")), "tty");
  assert.equal(requestedSubprotocol(withHeader("chat")), null);
  assert.equal(requestedSubprotocol(withHeader()), null);
});

test("a proxied path written as a URL stays a path on the sandbox daemon", async () => {
  const hits: string[] = [];
  const other = createServer((request, response) => {
    hits.push(request.url ?? "");
    response.end("other");
  });
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  const otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  const app = proxyApp();
  try {
    for (const path of [
      `${otherBase}/metadata`,
      `\\\\${otherBase.slice("http://".length)}/x`,
      `//${otherBase.slice("http://".length)}/x`,
    ]) {
      const response = await app.inject({ method: "GET", url: `/vnc/${path}` });
      assert.equal(response.statusCode, 200, path);
      assert.equal(response.headers["x-upstream"], "1", path);
    }
    assert.deepEqual(hits, []);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => other.close(() => resolve()));
  }
});

test("a proxied path that resolves outside the daemon's base path is a 404", async () => {
  assert.equal(
    joinUpstream("http://10.0.0.5:6080/novnc", "vnc.html", ""),
    "http://10.0.0.5:6080/novnc/vnc.html",
  );
  for (const path of ["%2e%2e/%2e%2e/admin", "../admin"]) {
    assert.throws(() => joinUpstream("http://10.0.0.5:6080/novnc", path, ""), (error) => {
      return error instanceof SandboxProxyError && error.status === 404;
    });
  }
  const app = proxyApp();
  try {
    const response = await app.inject({ method: "GET", url: "/vnc/%2e%2e/%2e%2e/admin" });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
  }
});

/** The largest client frame the bridge under test accepts, so a larger one is a socket error. */
const MAX_PAYLOAD = 64;

type Bridge = { url: string; app: FastifyInstance };

/** An app whose `/ws` socket the sandbox proxy bridges to the daemon at `daemonBase`. */
async function startBridge(daemonBase: () => Promise<string>, refusedCode: number): Promise<Bridge> {
  const app = Fastify();
  await app.register(fastifyWebsocket, { options: { maxPayload: MAX_PAYLOAD } });
  app.get("/ws", { websocket: true }, (socket, request) => {
    startSandboxWsProxy(
      socket,
      request,
      async () => ({ base: await daemonBase(), extraHeaders: {}, pathPart: "" }),
      () => refusedCode,
    );
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;
  return { url: `ws://127.0.0.1:${port}/ws`, app };
}

async function startDaemon(): Promise<{ server: WebSocketServer; base: string }> {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** The close code `socket` ends with. */
async function closeCodeOf(socket: WebSocket): Promise<number> {
  const [code] = (await once(socket, "close")) as [number];
  return code;
}

test("a sandbox target that cannot be resolved closes the client with the refusal's code", async () => {
  const bridge = await startBridge(async () => {
    throw new Error("agent not visible");
  }, 1013);
  try {
    assert.equal(await closeCodeOf(new WebSocket(bridge.url)), 1013);
  } finally {
    await bridge.app.close();
  }
});

test("a sandbox daemon that cannot be reached closes the client", async () => {
  const port = await closedPort();
  const bridge = await startBridge(async () => `http://127.0.0.1:${port}`, 1013);
  try {
    assert.equal(await closeCodeOf(new WebSocket(bridge.url)), 1005);
  } finally {
    await bridge.app.close();
  }
});

test("a sandbox daemon that closes its socket closes the client", async () => {
  const daemon = await startDaemon();
  daemon.server.on("connection", (socket) => socket.close(1000));
  const bridge = await startBridge(async () => daemon.base, 1013);
  try {
    assert.equal(await closeCodeOf(new WebSocket(bridge.url)), 1005);
  } finally {
    await bridge.app.close();
    daemon.server.close();
  }
});

test("a client that closes its socket closes the daemon's", async () => {
  const daemon = await startDaemon();
  const bridge = await startBridge(async () => daemon.base, 1013);
  try {
    const client = new WebSocket(bridge.url);
    const [upstream] = (await once(daemon.server, "connection")) as [WebSocket];
    client.close(1000);
    assert.equal(await closeCodeOf(upstream), 1005);
  } finally {
    await bridge.app.close();
    daemon.server.close();
  }
});

test("a client socket that errors is closed, and so is the daemon's", async () => {
  const daemon = await startDaemon();
  const bridge = await startBridge(async () => daemon.base, 1013);
  try {
    const client = new WebSocket(bridge.url);
    const [upstream] = (await once(daemon.server, "connection")) as [WebSocket];
    const clientClosed = closeCodeOf(client);
    client.send(Buffer.alloc(MAX_PAYLOAD + 1));
    assert.equal(await clientClosed, 1009);
    assert.equal(await closeCodeOf(upstream), 1005);
  } finally {
    await bridge.app.close();
    daemon.server.close();
  }
});
