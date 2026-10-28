import type { McpConnectionRow } from "../db/mcp.js";

/** Whether a login is signed in and waits only for its settings: pending, with no sign-in under way. */
export function awaitingSettings(connection: McpConnectionRow): boolean {
  return connection.status === "pending" && !connection.oauth_state;
}
