import { jsonObj } from "../db/json.js";
import type { McpConnectionRow } from "../db/mcp.js";

/** What a login stores beside its credentials: the document its connector's `settings_schema` describes. */
export function connectionSettings(connection: McpConnectionRow): Record<string, unknown> {
  const settings = jsonObj(connection.settings);
  return settings && typeof settings === "object" && !Array.isArray(settings) ? { ...(settings as Record<string, unknown>) } : {};
}

/** Whether a login is signed in and waits only for its settings: pending, with no sign-in under way. */
export function awaitingSettings(connection: McpConnectionRow): boolean {
  return connection.status === "pending" && !connection.oauth_state;
}
