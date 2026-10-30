import { GITHUB_APP, GITHUB_SERVER_ID, type Integration } from "./integrations.js";
import { InstanceKeyError } from "./keys.js";
import { countServerConnections } from "../db/mcp.js";
import type { Queryable } from "../db/pg.js";

/** Whether a GitHub App write puts another App in place of the one connections were installed with, or takes it away. */
export function replacesGithubApp(
  previous: Record<string, string> | null,
  next: Record<string, string> | null,
): boolean {
  if (previous === null || !previous.app_id) {
    return false;
  }
  return next === null || next.app_id !== previous.app_id;
}

/**
 * Refuses an unconfirmed GitHub App write that puts another App in place, or takes it away, while
 * logins are installed with the old one: they would be stranded, so the admin confirms with the
 * count first.
 */
export async function assertKeyChangeConfirmed(
  db: Queryable,
  integration: Integration,
  previous: Record<string, string> | null,
  next: Record<string, string> | null,
): Promise<void> {
  if (integration.id !== GITHUB_APP.id || !replacesGithubApp(previous, next)) {
    return;
  }
  const connections = await countServerConnections(db, GITHUB_SERVER_ID);
  if (connections === 0) {
    return;
  }
  const message = `Replacing the GitHub App disconnects ${connections} GitHub login${connections === 1 ? "" : "s"}.`;
  throw new InstanceKeyError(message, 409, { message, replaces_app: true, connections });
}
