import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPublicHttpsUrl, EndpointError } from "../../src/net/endpoints.js";
import {
  generateToolPrefix,
  isReservedSlug,
  RESERVED_MCP_SLUGS,
} from "../../src/mcp/policy.js";
import { namespacedName } from "../../src/connectors/naming.js";
import { effectiveTool } from "../../src/connectors/servers.js";
import { oauthSetupState, oauthStrategy, startsBrowserOauth } from "../../src/oauth/index.js";
import { McpError } from "../../src/mcp/errors.js";
import { LIST_TOOLS_MAX, McpSession } from "../../src/mcp/session.js";
import { storeKeys } from "../helpers/env.js";
import { serverRow } from "../helpers/servers.js";

test("reserved slugs and generated prefixes stay collision-proof", () => {
  assert.equal(isReservedSlug("note"), true);
  assert.equal(isReservedSlug("builder"), true);
  assert.equal(isReservedSlug("notion"), false);
  assert.ok(RESERVED_MCP_SLUGS.has("user"));
  assert.equal(generateToolPrefix("notion", []), "notion");
  assert.equal(generateToolPrefix("note", ["note"]), "note2");
  assert.equal(namespacedName("coingecko", "search"), "coingecko_search");
});

test("listed tools start Off for gmail send, drive writes, and opensea management", () => {
  const startsOff = (slug: string, name: string) =>
    effectiveTool(serverRow(slug), { name, description: "", input_schema: { type: "object" } })?.default_enabled === false;
  assert.equal(startsOff("gmail", "send_message"), true);
  assert.equal(startsOff("qonto", "upload_invoice"), true);
  assert.equal(startsOff("opensea", "get_instant_api_key"), true);
  assert.equal(startsOff("gmail", "list_messages"), false);
  assert.equal(startsOff("drive", "create_file"), true);
  assert.equal(startsOff("drive", "copy_file"), true);
  assert.equal(startsOff("drive", "search_files"), false);
  assert.equal(startsOff("opensea", "manage_wallets"), true);
});

test("public https endpoints reject private and local networks", () => {
  assert.equal(assertPublicHttpsUrl("https://mcp.notion.com/mcp").hostname, "mcp.notion.com");
  assert.throws(() => assertPublicHttpsUrl("http://example.com"), EndpointError);
  assert.throws(() => assertPublicHttpsUrl("https://127.0.0.1/mcp"), EndpointError);
  assert.throws(() => assertPublicHttpsUrl("https://10.0.0.4/mcp"), EndpointError);
  assert.throws(() => assertPublicHttpsUrl("https://192.168.1.9/mcp"), EndpointError);
  assert.throws(() => assertPublicHttpsUrl("https://169.254.169.254/latest"), EndpointError);
  assert.throws(() => assertPublicHttpsUrl("https://localhost/mcp"), EndpointError);
});

test("oauth setup state distinguishes configured, dynamic, and unsupported", () => {
  assert.equal(oauthStrategy(serverRow("cigale", { auth: "token" })), "none");
  assert.equal(oauthStrategy(serverRow("gmail", { auth: "oauth" })), "configured");
  assert.equal(oauthStrategy(serverRow("drive", { auth: "oauth" })), "configured");
  assert.equal(oauthStrategy(serverRow("notion", { auth: "oauth" })), "dynamic");
  assert.equal(startsBrowserOauth(serverRow("custom", { auth: "oauth" })), true);
  assert.equal(
    oauthSetupState(serverRow("gmail", { auth: "oauth", oauth_strategy: "configured" }), { keys: {} }),
    "unsupported",
  );
  assert.equal(
    oauthSetupState(
      serverRow("gmail", { auth: "oauth", oauth_strategy: "configured" }),
      { keys: storeKeys({ "google-connectors": { client_id: "id", client_secret: "secret" } }) },
    ),
    "configured",
  );
  assert.equal(oauthSetupState(serverRow("notion", { auth: "oauth", oauth_strategy: "dynamic" })), "dynamic");
});

test("tools/list enforces tool count and byte limits", async () => {
  const tooMany = Array.from({ length: LIST_TOOLS_MAX + 1 }, (_, index) => ({ name: `t${index}` }));
  let calls = 0;
  const session = new McpSession("https://example.com/mcp", {}, async (_url, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
    if (body.method === "tools/list") {
      return {
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => JSON.stringify({ result: { tools: tooMany } }),
      } as unknown as Response;
    }
    return {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({ result: {} }),
    } as unknown as Response;
  });
  await assert.rejects(
    () => session.listTools(),
    (error: unknown) => error instanceof McpError && /more than/.test(error.message),
  );
  assert.ok(calls >= 1);

  let listed = 0;
  const huge = new McpSession("https://example.com/mcp", {}, async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
    if (body.method === "tools/list") {
      listed += 1;
      return {
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => "x".repeat(1_000_001),
      } as unknown as Response;
    }
    return {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({ result: {} }),
    } as unknown as Response;
  });
  await assert.rejects(
    () => huge.listTools(),
    (error: unknown) => error instanceof McpError && /byte limit/.test(error.message),
  );
  assert.equal(listed, 1);
});
