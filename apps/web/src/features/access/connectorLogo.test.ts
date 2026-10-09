import assert from "node:assert/strict";
import { test } from "node:test";
import { connectorLogo } from "./connectorLogo";

test("a connector mark exists only when the server has a logo", () => {
  assert.equal(connectorLogo(null), null);
  assert.equal(connectorLogo(undefined), null);
  assert.notEqual(connectorLogo("/api/mcp/servers/mcp_notion/logo"), null);
});
