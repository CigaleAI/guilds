import assert from "node:assert/strict";
import { after, test } from "node:test";
import { LOG_KEYS, logWriter, redactText, writeLog } from "../../src/observability/log.js";
import { sentryCapture } from "../../src/observability/sentry.js";

const originalKey = process.env.OPENROUTER_API_KEY;

after(() => {
  if (originalKey === undefined) {
    delete process.env.OPENROUTER_API_KEY;
  } else {
    process.env.OPENROUTER_API_KEY = originalKey;
  }
});

test("redactText masks env secrets", () => {
  process.env.OPENROUTER_API_KEY = "sk-secret-value";
  assert.equal(redactText("failed sk-secret-value"), "failed [REDACTED:OPENROUTER_API_KEY]");
});

test("json logs redact secrets and keep LOG_KEYS order", () => {
  process.env.OPENROUTER_API_KEY = "sk-secret-value";
  const chunks: string[] = [];
  const originalWrite = logWriter.write;
  logWriter.write = (chunk: string) => {
    chunks.push(chunk);
  };
  try {
    writeLog("error", "provider failed sk-secret-value", {
      run_id: "r_1",
      guild_id: "guild_1",
      agent_id: "a_1",
      operation: "llm.complete",
      error_type: "LLMError",
    });
  } finally {
    logWriter.write = originalWrite;
  }
  const captured = chunks.join("").trim().split("\n").at(-1) ?? "";
  const payload = JSON.parse(captured) as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload).slice(0, LOG_KEYS.length), [...LOG_KEYS]);
  assert.equal(payload.run_id, "r_1");
  assert.equal(payload.guild_id, "guild_1");
  assert.equal(payload.agent_id, "a_1");
  assert.equal(payload.operation, "llm.complete");
  assert.equal(payload.error_type, "LLMError");
  assert.equal(payload.level, "error");
  assert.equal(typeof payload.timestamp, "string");
  assert.match(String(payload.timestamp), /Z$/);
  assert.equal(payload.traceback, null);
  assert.ok(!captured.includes("sk-secret-value"));
  assert.equal(payload.message, "provider failed [REDACTED:OPENROUTER_API_KEY]");
  assert.ok(!("prompt" in payload));
  assert.ok(!("payload" in payload));
  assert.ok(!("source" in payload));
  assert.ok(!("request_id" in payload));
});

test("json logs append optional extras after LOG_KEYS", () => {
  const chunks: string[] = [];
  const originalWrite = logWriter.write;
  logWriter.write = (chunk: string) => {
    chunks.push(chunk);
  };
  try {
    writeLog(
      "warn",
      "builder failed",
      {
        operation: "builder.session",
        source: "frontend",
        request_id: "req_1",
        session_id: "sess_1",
        path: "/#/builder",
        method: "POST",
        status: 500,
      },
      new Error("boom"),
    );
  } finally {
    logWriter.write = originalWrite;
  }
  const captured = chunks.join("").trim().split("\n").at(-1) ?? "";
  const payload = JSON.parse(captured) as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload).slice(0, LOG_KEYS.length), [...LOG_KEYS]);
  assert.equal(payload.level, "warn");
  assert.equal(payload.source, "frontend");
  assert.equal(payload.request_id, "req_1");
  assert.equal(payload.session_id, "sess_1");
  assert.equal(payload.path, "/#/builder");
  assert.equal(payload.method, "POST");
  assert.equal(payload.status, 500);
  assert.equal(payload.error_type, "Error");
  assert.equal(typeof payload.traceback, "string");
});

test("error logs flush through logWriter instead of buffered stdout.write", () => {
  const chunks: string[] = [];
  const originalWriter = logWriter.write;
  const originalStdout = process.stdout.write;
  logWriter.write = (chunk: string) => {
    chunks.push(chunk);
  };
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    writeLog("error", "visible in docker", { operation: "http.request" });
  } finally {
    logWriter.write = originalWriter;
    process.stdout.write = originalStdout;
  }
  assert.equal(chunks.length, 1);
  const payload = JSON.parse(chunks[0]?.trim() ?? "") as Record<string, unknown>;
  assert.equal(payload.level, "error");
  assert.equal(payload.message, "visible in docker");
  assert.equal(payload.operation, "http.request");
});

test("error logs are forwarded to sentryCapture and warns are not", () => {
  const calls: unknown[][] = [];
  const originalCapture = sentryCapture.exception;
  const originalWrite = logWriter.write;
  sentryCapture.exception = ((...args) => {
    calls.push(args);
  }) as typeof sentryCapture.exception;
  logWriter.write = () => {};
  try {
    writeLog("error", "boom", { operation: "http.request", source: "backend" }, new Error("boom"));
    writeLog("warn", "skip", { operation: "mcp.call" });
  } finally {
    sentryCapture.exception = originalCapture;
    logWriter.write = originalWrite;
  }
  assert.equal(calls.length, 1);
  const [level, message, fields, error] = calls[0] ?? [];
  assert.equal(level, "error");
  assert.equal(message, "boom");
  assert.equal((fields as { operation?: string }).operation, "http.request");
  assert.ok(error instanceof Error);
});

test("info, warn, and error logs are sent to Sentry Logs with their fields and debug is not", () => {
  const calls: unknown[][] = [];
  const originalLog = sentryCapture.log;
  const originalWrite = logWriter.write;
  sentryCapture.log = ((...args) => {
    calls.push(args);
  }) as typeof sentryCapture.log;
  logWriter.write = () => {};
  try {
    writeLog("debug", "skip", { operation: "mcp.call" });
    writeLog("info", "listening", { operation: "http.listen" });
    writeLog("warn", "slow", { operation: "db.pool", status: 503, path: "/health" });
    writeLog("error", "boom", { operation: "http.request" }, new Error("boom"));
  } finally {
    sentryCapture.log = originalLog;
    logWriter.write = originalWrite;
  }
  assert.deepEqual(
    calls.map(([level, message]) => [level, message]),
    [
      ["info", "listening"],
      ["warn", "slow"],
      ["error", "boom"],
    ],
  );
  assert.deepEqual(calls[1]?.[2], { operation: "db.pool", path: "/health", status: 503 });
  const errorAttributes = calls[2]?.[2] as Record<string, unknown>;
  assert.equal(errorAttributes.error_type, "Error");
  assert.match(String(errorAttributes.traceback), /boom/);
  assert.equal("message" in errorAttributes, false);
});

test("Sentry Logs attributes carry the redacted values", () => {
  process.env.OPENROUTER_API_KEY = "sk-or-sentry-log-secret";
  const calls: unknown[][] = [];
  const originalLog = sentryCapture.log;
  const originalWrite = logWriter.write;
  sentryCapture.log = ((...args) => {
    calls.push(args);
  }) as typeof sentryCapture.log;
  logWriter.write = () => {};
  try {
    writeLog("warn", "key sk-or-sentry-log-secret", { path: "/x/sk-or-sentry-log-secret" });
  } finally {
    sentryCapture.log = originalLog;
    logWriter.write = originalWrite;
  }
  const [, message, attributes] = calls[0] ?? [];
  assert.equal(message, "key [REDACTED:OPENROUTER_API_KEY]");
  assert.deepEqual(attributes, { path: "/x/[REDACTED:OPENROUTER_API_KEY]" });
});
