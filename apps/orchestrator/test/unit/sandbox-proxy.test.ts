import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import Fastify from "fastify";
import { joinUpstream, proxyHttp, requestedSubprotocol } from "../../src/http/sandbox-proxy.js";

// Mirrors websockify's static handler: Last-Modified, no Cache-Control.
let upstream: Server;
let base = "";

before(async () => {
  upstream = createServer((request, response) => {
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

test("proxied sandbox responses are never cached by the browser", async () => {
  const app = Fastify();
  app.get("/vnc/*", async (request, reply) => {
    await proxyHttp(request, reply, base, {}, (request.params as { "*": string })["*"]);
  });
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
  const app = Fastify();
  app.get("/vnc/*", async (request, reply) => {
    await proxyHttp(request, reply, base, {}, (request.params as { "*": string })["*"]);
  });
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

test("a proxied path that resolves outside the daemon's base path is a 404", () => {
  assert.equal(
    joinUpstream("http://10.0.0.5:6080/novnc", "vnc.html", ""),
    "http://10.0.0.5:6080/novnc/vnc.html",
  );
  assert.throws(() => joinUpstream("http://10.0.0.5:6080/novnc", "%2e%2e/%2e%2e/admin", ""), {
    statusCode: 404,
  });
  assert.throws(() => joinUpstream("http://10.0.0.5:6080/novnc", "../admin", ""), {
    statusCode: 404,
  });
});
