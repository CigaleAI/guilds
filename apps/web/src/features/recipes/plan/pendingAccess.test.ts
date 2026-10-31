import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyPendingAccess,
  pendingAccessEdits,
  pendingAccessSummary,
  toolKey,
} from "./pendingAccess";

test("pending access edits drop tool switches on removed connectors and summarise removals", () => {
  const pending = emptyPendingAccess();
  assert.equal(pendingAccessSummary(pending), null);
  pending.tools.set(toolKey("crm", "writer", "crm_read"), false);
  pending.tools.set(toolKey("crm", "writer", "crm_write"), true);
  pending.tools.set(toolKey("mail", "writer", "mail_send"), false);
  pending.removed.add("mail");
  assert.deepEqual(pendingAccessEdits(pending), [
    { action: "set_tool", server: "crm", role: "writer", tool: "crm_read", enabled: false },
    { action: "set_tool", server: "crm", role: "writer", tool: "crm_write", enabled: true },
    { action: "remove_connection", server: "mail" },
  ]);
  const summary = pendingAccessSummary(pending);
  assert.equal(summary?.removedTools, 1);
  assert.equal(summary?.removedConnectors, 1);
  assert.equal(
    summary?.text,
    "Pending: 1 tool and 1 connector removed. Validate to save and tell the coach.",
  );
  assert.deepEqual(summary?.removed, ["mail"]);
});
