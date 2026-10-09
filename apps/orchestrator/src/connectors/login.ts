import { jsonObj } from "../db/json.js";

/** What a login stores beside its credentials: the document its connector's `settings_schema` describes. */
export function connectionSettings(connection: Record<string, unknown>): Record<string, unknown> {
  const settings = jsonObj(connection.settings);
  return settings && typeof settings === "object" && !Array.isArray(settings) ? { ...(settings as Record<string, unknown>) } : {};
}

/** Whether a login is signed in and waits only for its settings: pending, with no sign-in under way. */
export function awaitingSettings(connection: Record<string, unknown>): boolean {
  return connection.status === "pending" && !connection.oauth_state;
}
