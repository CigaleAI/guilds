import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { openCdpBridge, type CdpTarget } from "../../src/browse/bridge.js";

// A sandbox host's endpoint for a relay: a base path in front of Chrome's DevTools paths, and a
// header it refuses requests without.
const BASE_PATH = "/sandboxes/sb-1/proxy/9401";
const TARGET_HEADERS = { "x-sandbox-token": "secret" };

let endpoint: Server;
let sockets: WebSocketServer;
let target: CdpTarget;
/** The endpoint's host as its URL names it, which a host-routed front door relies on. */
let endpointHost = "";
/** Every request and upgrade the endpoint received, with the headers it came with. */
const received: IncomingMessage[] = [];

/** What Chrome's /json endpoints answer, as far as these tests read it. */
type DevToolsTarget = { Browser?: string; webSocketDebuggerUrl: string; devtoolsFrontendUrl?: string };

/** Whether a request carries the target's headers and names the endpoint's own host. */
function isAdmitted(request: IncomingMessage): boolean {
  return request.headers["x-sandbox-token"] === "secret" && request.headers.host === endpointHost;
}

function answerDevTools(request: IncomingMessage): [number, string] {
  const url = new URL(request.url ?? "/", "http://endpoint.invalid");
  const host = request.headers.host ?? "";
  const route = url.pathname.slice(BASE_PATH.length);
  if (route === "/json/version") {
    return [200, JSON.stringify({ Browser: "Fake/1", webSocketDebuggerUrl: `ws://${host}/devtools/browser/b-1` })];
  }
  if (route === "/json/list") {
    const page = (id: string) => ({
      id,
      devtoolsFrontendUrl: `/devtools/inspector.html?ws=${host}/devtools/page/${id}`,
      webSocketDebuggerUrl: `ws://${host}/devtools/page/${id}`,
    });
    return [200, JSON.stringify([page("p-1"), page("p-2")], null, 3)];
  }
  if (route === "/json/new") {
    return [200, JSON.stringify({ method: request.method, url: url.search.slice(1) })];
  }
  return [404, "unknown"];
}

before(async () => {
  endpoint = createServer((request, response) => {
    received.push(request);
    if (!isAdmitted(request)) {
      response.writeHead(403).end("refused");
      return;
    }
    const [status, body] = answerDevTools(request);
    response.writeHead(status, { "content-type": "application/json", "x-endpoint": "1" }).end(body);
  });
  sockets = new WebSocketServer({ noServer: true });
  endpoint.on("upgrade", (request, socket, head) => {
    received.push(request);
    if (!isAdmitted(request) || request.url === `${BASE_PATH}/devtools/page/refused`) {
      socket.end("HTTP/1.1 500 Internal Server Error\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => {
      client.on("message", (data, isBinary) => client.send(data, { binary: isBinary }));
    });
  });
  endpoint.listen(0, "127.0.0.1");
  await once(endpoint, "listening");
  const { port } = endpoint.address() as AddressInfo;
  endpointHost = `localhost:${port}`;
  target = [`http://${endpointHost}${BASE_PATH}`, TARGET_HEADERS];
});

after(async () => {
  for (const client of sockets.clients) {
    client.terminate();
  }
  endpoint.closeAllConnections();
  await new Promise<void>((resolve) => endpoint.close(() => resolve()));
});

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await once(socket, "open");
  return socket;
}

/** Resolves when the socket has closed, whether or not it ever opened. */
async function closed(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve) => {
    socket.on("error", () => undefined);
    socket.on("close", () => resolve());
  });
}

async function nextFrame(socket: WebSocket): Promise<[Buffer, boolean]> {
  const [data, isBinary] = await once(socket, "message");
  return [Buffer.from(data as Buffer), isBinary as boolean];
}

test("the bridge listens on an ephemeral loopback port", async () => {
  const bridge = await openCdpBridge(target);
  try {
    assert.ok(bridge.port > 0);
    const response = await fetch(`http://127.0.0.1:${bridge.port}/json/version`);
    assert.equal(response.status, 200);
  } finally {
    await bridge.close();
  }
});

test("/json/version reaches the endpoint with its headers and its own Host, its WebSocket URL rewritten to the bridge", async () => {
  const bridge = await openCdpBridge(target);
  try {
    const response = await fetch(`http://127.0.0.1:${bridge.port}/json/version`, {
      headers: { "accept-encoding": "gzip" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-endpoint"), "1");
    const body = (await response.json()) as DevToolsTarget;
    assert.equal(body.webSocketDebuggerUrl, `ws://127.0.0.1:${bridge.port}/devtools/browser/b-1`);
    const request = received.at(-1);
    assert.equal(request?.url, `${BASE_PATH}/json/version`);
    assert.equal(request?.headers.host, endpointHost);
    assert.equal(request?.headers["x-sandbox-token"], "secret");
    assert.equal(request?.headers["accept-encoding"], "identity");
  } finally {
    await bridge.close();
  }
});

test("every WebSocket URL of /json/list points at the bridge and the frontend URLs stay as they are", async () => {
  const bridge = await openCdpBridge(target);
  try {
    const pages = (await (await fetch(`http://127.0.0.1:${bridge.port}/json/list`)).json()) as DevToolsTarget[];
    assert.deepEqual(
      pages.map((page) => page.webSocketDebuggerUrl),
      [`ws://127.0.0.1:${bridge.port}/devtools/page/p-1`, `ws://127.0.0.1:${bridge.port}/devtools/page/p-2`],
    );
    assert.equal(pages[0]?.devtoolsFrontendUrl, `/devtools/inspector.html?ws=${endpointHost}/devtools/page/p-1`);
  } finally {
    await bridge.close();
  }
});

test("a PUT to /json/new reaches the endpoint with its method and query", async () => {
  const bridge = await openCdpBridge(target);
  try {
    const response = await fetch(`http://127.0.0.1:${bridge.port}/json/new?about:blank`, { method: "PUT" });
    assert.deepEqual(await response.json(), { method: "PUT", url: "about:blank" });
  } finally {
    await bridge.close();
  }
});

test("a path outside Chrome's /json endpoints, or written as a URL, is a 404 that never reaches the endpoint", async () => {
  const bridge = await openCdpBridge(target);
  try {
    const before = received.length;
    for (const requestPath of ["/devtools/inspector.html", "/jsonx", "//elsewhere.invalid/json/version"]) {
      const response = await fetch(`http://127.0.0.1:${bridge.port}${requestPath}`);
      assert.equal(response.status, 404, requestPath);
    }
    assert.equal(received.length, before);
  } finally {
    await bridge.close();
  }
});

test("a relay that cannot be reached is a 502", async () => {
  const closed = createServer();
  closed.listen(0, "127.0.0.1");
  await once(closed, "listening");
  const { port } = closed.address() as AddressInfo;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  const bridge = await openCdpBridge([`http://127.0.0.1:${port}`, {}]);
  try {
    const response = await fetch(`http://127.0.0.1:${bridge.port}/json/version`);
    assert.equal(response.status, 502);
  } finally {
    await bridge.close();
  }
});

test("a DevTools WebSocket relays text and binary frames both ways with the endpoint's headers", async () => {
  const bridge = await openCdpBridge(target);
  try {
    const socket = await openSocket(`ws://127.0.0.1:${bridge.port}/devtools/page/p-1`);
    const upgrade = received.at(-1);
    assert.equal(upgrade?.url, `${BASE_PATH}/devtools/page/p-1`);
    assert.equal(upgrade?.headers.host, endpointHost);
    assert.equal(upgrade?.headers["x-sandbox-token"], "secret");
    socket.send('{"id":1,"method":"Page.navigate"}');
    assert.deepEqual(await nextFrame(socket), [Buffer.from('{"id":1,"method":"Page.navigate"}'), false]);
    socket.send(Buffer.from([0, 1, 2, 255]), { binary: true });
    assert.deepEqual(await nextFrame(socket), [Buffer.from([0, 1, 2, 255]), true]);
    socket.close();
    await once(socket, "close");
  } finally {
    await bridge.close();
  }
});

test("an upgrade the relay refuses ends the client's socket", async () => {
  const bridge = await openCdpBridge(target);
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/devtools/page/refused`);
    await closed(socket);
    assert.equal(socket.readyState, WebSocket.CLOSED);
  } finally {
    await bridge.close();
  }
});

test("an upgrade outside /devtools/ ends the client's socket without reaching the endpoint", async () => {
  const bridge = await openCdpBridge(target);
  try {
    const before = received.length;
    const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/json/version`);
    await closed(socket);
    assert.equal(received.length, before);
  } finally {
    await bridge.close();
  }
});

test("a client that closes closes its relay socket", async () => {
  const bridge = await openCdpBridge(target);
  try {
    const socket = await openSocket(`ws://127.0.0.1:${bridge.port}/devtools/browser/b-1`);
    const [relayed] = sockets.clients;
    assert.ok(relayed);
    socket.close();
    await once(relayed, "close");
  } finally {
    await bridge.close();
  }
});

test("close ends every open socket and stops listening", async () => {
  const bridge = await openCdpBridge(target);
  const socket = await openSocket(`ws://127.0.0.1:${bridge.port}/devtools/browser/b-1`);
  assert.equal(sockets.clients.size, 1);
  const closedClient = once(socket, "close");
  await bridge.close();
  await closedClient;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sockets.clients.size, 0);
  await assert.rejects(fetch(`http://127.0.0.1:${bridge.port}/json/version`));
  await bridge.close();
});

/** The Chrome the gated test launches: BROWSE_BRIDGE_CHROME_BINARY, or the usual install. */
function chromeBinary(): string {
  const candidates = [
    process.env.BROWSE_BRIDGE_CHROME_BINARY ?? "",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? "google-chrome";
}

async function devToolsPort(profile: string): Promise<number> {
  const file = path.join(profile, "DevToolsActivePort");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(file)) {
      const [port] = readFileSync(file, "utf8").split("\n");
      if (port) {
        return Number(port);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Chrome did not open its DevTools port");
}

test(
  "a real Chrome answers /json/version and a CDP command through the bridge",
  { skip: process.env.BROWSE_BRIDGE_CHROME !== "1" },
  async () => {
    const profile = mkdtempSync(path.join(tmpdir(), "browse-bridge-chrome-"));
    const chrome = spawn(
      chromeBinary(),
      ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"],
      { stdio: "ignore" },
    );
    try {
      const port = await devToolsPort(profile);
      const bridge = await openCdpBridge([`http://127.0.0.1:${port}`, {}]);
      try {
        const version = (await (await fetch(`http://127.0.0.1:${bridge.port}/json/version`)).json()) as DevToolsTarget;
        assert.match(version.webSocketDebuggerUrl, new RegExp(`^ws://127\\.0\\.0\\.1:${bridge.port}/devtools/browser/`));
        const socket = await openSocket(version.webSocketDebuggerUrl);
        socket.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
        const [frame] = await nextFrame(socket);
        assert.equal(JSON.parse(frame.toString("utf8")).result.product, version.Browser);
        socket.close();
      } finally {
        await bridge.close();
      }
    } finally {
      chrome.kill();
      await once(chrome, "exit");
      // Chrome's helper processes can still write to the profile just after the browser exits.
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);
