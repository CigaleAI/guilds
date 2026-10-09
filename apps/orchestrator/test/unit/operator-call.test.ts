import assert from "node:assert/strict";
import { test } from "node:test";
import { encryptPayload } from "../../src/credentials/crypto.js";
import { McpDisconnectedError, McpError } from "../../src/mcp/index.js";
import {
  OPERATOR_TOOL_RESULT_MAX_BYTES,
  OperatorCallError,
  callOwnedConnectionTool,
} from "../../src/mcp/operator-call.js";
import { HEX_MASTER_KEY } from "../helpers/env.js";

const masterKey = Buffer.from(HEX_MASTER_KEY, "hex");

function listed(
  overrides: Partial<{
    remote_name: string;
    namespaced_name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }> = {},
) {
  return {
    remote_name: "search",
    namespaced_name: "coingecko_search",
    description: "Find",
    input_schema: { type: "object" },
    ...overrides,
  };
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn_1",
    status: "connected",
    ciphertext: Buffer.alloc(0),
    nonce: Buffer.alloc(0),
    ...overrides,
  };
}

function call(args: {
  tool?: string;
  arguments?: Record<string, unknown>;
  connection?: Record<string, unknown>;
  tools?: Array<ReturnType<typeof listed>>;
  mcp?: (remoteName: string, arguments_: Record<string, unknown>) => Promise<string>;
}) {
  return callOwnedConnectionTool({
    repo: { listMcpTools: async () => args.tools ?? [listed()] },
    mcp: {
      call: async (_db, _connection, _server, remoteName, arguments_) =>
        (args.mcp ?? (async () => "ok"))(remoteName, arguments_),
    },
    connection: args.connection ?? connection(),
    server: { slug: "coingecko", tool_prefix: "coingecko" },
    tool: args.tool ?? "coingecko_search",
    arguments: args.arguments ?? { query: "eth" },
    masterKey,
  });
}

test("operator call refuses a disconnected login", async () => {
  await assert.rejects(
    () => call({ connection: connection({ status: "pending" }) }),
    (error: unknown) => error instanceof OperatorCallError && error.status === 409,
  );
});

test("operator call refuses an unknown tool", async () => {
  await assert.rejects(
    () => call({ tool: "missing" }),
    (error: unknown) =>
      error instanceof OperatorCallError &&
      error.status === 422 &&
      error.message.includes("not listed"),
  );
});

test("operator call dispatches by namespaced or remote name", async () => {
  const seen: Array<[string, Record<string, unknown>]> = [];
  const mcp = async (remoteName: string, arguments_: Record<string, unknown>) => {
    seen.push([remoteName, arguments_]);
    return "pong";
  };
  assert.deepEqual(await call({ mcp, tool: "coingecko_search" }), {
    remote_name: "search",
    name: "coingecko_search",
    content: "pong",
    truncated: false,
  });
  assert.deepEqual(await call({ mcp, tool: "search" }), {
    remote_name: "search",
    name: "coingecko_search",
    content: "pong",
    truncated: false,
  });
  assert.deepEqual(seen, [
    ["search", { query: "eth" }],
    ["search", { query: "eth" }],
  ]);
});

test("operator call maps credential and remote failures", async () => {
  await assert.rejects(
    () =>
      call({
        mcp: async () => {
          throw new McpError("nope", 401);
        },
      }),
    (error: unknown) =>
      error instanceof OperatorCallError &&
      error.status === 422 &&
      error.message === "api key was rejected",
  );
  await assert.rejects(
    () =>
      call({
        mcp: async () => {
          throw new McpError("timeout", 504);
        },
      }),
    (error: unknown) =>
      error instanceof OperatorCallError &&
      error.status === 502 &&
      error.message.includes("timeout"),
  );
  await assert.rejects(
    () =>
      call({
        mcp: async () => {
          throw new McpDisconnectedError("connection is not connected");
        },
      }),
    (error: unknown) => error instanceof OperatorCallError && error.status === 409,
  );
});

test("operator call redacts stored credentials and caps the result", async () => {
  const [ciphertext, nonce] = encryptPayload({ token: "secret-token" }, masterKey);
  const result = await call({
    connection: connection({ ciphertext, nonce }),
    mcp: async () => `got secret-token back ${"x".repeat(OPERATOR_TOOL_RESULT_MAX_BYTES)}`,
  });
  assert.equal(result.content.includes("secret-token"), false);
  assert.equal(result.truncated, true);
  assert.ok(result.content.endsWith("\n[truncated]"));
});
