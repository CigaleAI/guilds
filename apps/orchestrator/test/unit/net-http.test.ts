import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { test } from "node:test";
import { httpRequest } from "../../src/net/http.js";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test("httpRequest with a proxy URL sends the request through the proxy and returns the target's response", async () => {
  const target = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      response.writeHead(201, { "content-type": "application/json", "x-seen-method": request.method ?? "" });
      response.end(JSON.stringify({ body }));
    });
  });
  const proxied: string[] = [];
  const proxy = http.createServer((request, response) => {
    proxied.push(`${request.method} ${request.url}`);
    const upstream = http.request(request.url ?? "", { method: request.method, headers: request.headers }, (reply) => {
      response.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(response);
    });
    request.pipe(upstream);
  });
  proxy.on("connect", (request, socket, head) => {
    proxied.push(`CONNECT ${request.url}`);
    const [host, port] = (request.url ?? "").split(":");
    const upstream = net.connect(Number(port), host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
  });
  const targetPort = await listen(target);
  const proxyPort = await listen(proxy);
  try {
    const response = await httpRequest(
      `http://127.0.0.1:${targetPort}/echo`,
      { method: "POST", headers: { "content-type": "text/plain" }, body: "hello" },
      { proxyUrl: `http://127.0.0.1:${proxyPort}`, timeoutMs: 5_000 },
    );
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("x-seen-method"), "POST");
    assert.deepEqual(await response.json(), { body: "hello" });
    assert.equal(proxied.length, 1, "the request went through the proxy");
  } finally {
    await close(proxy);
    await close(target);
  }
});

test("httpRequest with a proxy URL that refuses the connection rejects", async () => {
  const closed = http.createServer();
  const port = await listen(closed);
  await close(closed);
  await assert.rejects(() =>
    httpRequest("http://127.0.0.1:1/never", {}, { proxyUrl: `http://127.0.0.1:${port}`, timeoutMs: 5_000 }),
  );
});
