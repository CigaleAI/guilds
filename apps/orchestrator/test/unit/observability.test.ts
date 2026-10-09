import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { HttpError } from "../../src/http/errors.js";
import { registerClientErrorRoute } from "../../src/observability/client-errors.js";
import {
  fastifyRequestIdOptions,
  registerHttpObservability,
} from "../../src/observability/http.js";
import { LOG_KEYS, logWriter } from "../../src/observability/log.js";
import { sentryCapture } from "../../src/observability/sentry.js";
import { McpDisconnectedError, McpPool } from "../../src/mcp/index.js";

function captureStdout(run: () => Promise<void> | void): Promise<{
  lines: Record<string, unknown>[];
  sentry: unknown[][];
}> {
  const chunks: string[] = [];
  const sentry: unknown[][] = [];
  const originalWrite = logWriter.write;
  const originalCapture = sentryCapture.exception;
  logWriter.write = (chunk: string) => {
    chunks.push(chunk);
  };
  sentryCapture.exception = ((...args) => {
    sentry.push(args);
  }) as typeof sentryCapture.exception;
  return Promise.resolve()
    .then(() => run())
    .finally(() => {
      logWriter.write = originalWrite;
      sentryCapture.exception = originalCapture;
    })
    .then(() => ({
      lines: chunks
        .join("")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("{"))
        .flatMap((line) => {
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            return typeof parsed.level === "string" ? [parsed] : [];
          } catch {
            return [];
          }
        }),
      sentry,
    }));
}

async function testApp() {
  const app = Fastify({
    logger: false,
    ...fastifyRequestIdOptions(),
  });
  registerHttpObservability(app);
  registerClientErrorRoute(app);
  app.get("/boom", async () => {
    throw new Error("kaboom");
  });
  app.get("/fail", async () => {
    throw new HttpError(500, "store exploded");
  });
  app.get("/missing", async () => {
    throw new HttpError(404, "agent not found");
  });
  return app;
}

test("HTTP 500s are logged with request correlation", async () => {
  const app = await testApp();
  try {
    const captured = await captureStdout(async () => {
      const response = await app.inject({
        method: "GET",
        url: "/boom",
        headers: { "x-request-id": "req-test-1" },
      });
      assert.equal(response.statusCode, 500);
      assert.equal(response.headers["x-request-id"], "req-test-1");
      assert.equal(response.headers["x-frame-options"], "SAMEORIGIN");
      assert.deepEqual(response.json(), { detail: "kaboom" });
    });
    const errorLine = captured.lines.find((line) => line.operation === "http.request");
    assert.ok(errorLine);
    assert.deepEqual(Object.keys(errorLine).slice(0, LOG_KEYS.length), [...LOG_KEYS]);
    assert.equal(errorLine.level, "error");
    assert.equal(errorLine.source, "backend");
    assert.equal(errorLine.request_id, "req-test-1");
    assert.equal(errorLine.method, "GET");
    assert.equal(errorLine.path, "/boom");
    assert.equal(errorLine.status, 500);
    assert.equal(errorLine.message, "kaboom");
    assert.equal(captured.sentry.length, 1);
    assert.equal(captured.sentry[0]?.[0], "error");
    assert.equal(captured.sentry[0]?.[1], "kaboom");
  } finally {
    await app.close();
  }
});

test("HttpError 500 is logged with request correlation", async () => {
  const app = await testApp();
  try {
    const captured = await captureStdout(async () => {
      const response = await app.inject({
        method: "GET",
        url: "/fail",
        headers: { "x-request-id": "req-test-500" },
      });
      assert.equal(response.statusCode, 500);
      assert.deepEqual(response.json(), { detail: "store exploded" });
    });
    const errorLine = captured.lines.find((line) => line.operation === "http.request");
    assert.ok(errorLine);
    assert.equal(errorLine.level, "error");
    assert.equal(errorLine.source, "backend");
    assert.equal(errorLine.request_id, "req-test-500");
    assert.equal(errorLine.path, "/fail");
    assert.equal(errorLine.status, 500);
    assert.equal(errorLine.message, "store exploded");
    assert.equal(captured.sentry.length, 1);
  } finally {
    await app.close();
  }
});

test("expected HttpError 4xx is not logged", async () => {
  const app = await testApp();
  try {
    const captured = await captureStdout(async () => {
      const response = await app.inject({ method: "GET", url: "/missing" });
      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.json(), { detail: "agent not found" });
    });
    assert.equal(captured.lines.some((line) => line.operation === "http.request"), false);
    assert.equal(captured.sentry.length, 0);
  } finally {
    await app.close();
  }
});

test("client errors are ingested as frontend stdout logs", async () => {
  const app = await testApp();
  try {
    const captured = await captureStdout(async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/client-errors",
        headers: { "x-request-id": "req-client-1" },
        payload: {
          kind: "onerror",
          message: "ui exploded",
          stack: "Error: ui exploded\n    at render",
          href: "https://example.test/#/builder/abc",
          request_id: "req-client-1",
        },
      });
      assert.equal(response.statusCode, 204);
    });
    const errorLine = captured.lines.find((line) => line.operation === "client.error");
    assert.ok(errorLine);
    assert.equal(errorLine.level, "error");
    assert.equal(errorLine.source, "frontend");
    assert.equal(errorLine.request_id, "req-client-1");
    assert.equal(errorLine.path, "/#/builder/abc");
    assert.equal(errorLine.message, "ui exploded");
    assert.equal(errorLine.error_type, "client.onerror");
    assert.equal(captured.sentry.length, 1);
    assert.equal((captured.sentry[0]?.[2] as { source?: string }).source, "frontend");
  } finally {
    await app.close();
  }
});

test("MCP disconnected calls log at warn and rethrow", async () => {
  const pool = new McpPool();
  const captured = await captureStdout(async () => {
    await assert.rejects(
      () =>
        pool.call(
          {} as never,
          { id: "conn_1", status: "disconnected" },
          { slug: "notion" },
          "search",
          {},
        ),
      (error: unknown) => error instanceof McpDisconnectedError,
    );
  });
  const line = captured.lines.find((item) => item.operation === "mcp.call");
  assert.ok(line);
  assert.equal(line.level, "warn");
  assert.equal(line.source, "backend");
  assert.equal(line.error_type, "McpDisconnectedError");
  assert.equal(captured.sentry.length, 0);
});
