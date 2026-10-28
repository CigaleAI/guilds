import { syncInstanceLogins } from "../connectors/instance.js";
import { GITHUB_SERVER_ID } from "../github/index.js";
import type { McpPool } from "../mcp/pool.js";
import { GITHUB_APP, type Integration } from "./integrations.js";
import { InstanceKeyError } from "./keys.js";
import { countServerConnections, disconnectServerConnections } from "../db/mcp.js";
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

/**
 * What the process does once an instance key changed: platform logins follow their integration,
 * and a GitHub App that is replaced or removed disconnects every login installed with it, since
 * their installations belong to the old App. Returns how many it disconnected.
 */
export async function applyKeyChange(
  ctx: { db: Queryable; masterKey?: Buffer | undefined; mcp?: McpPool | undefined },
  integrationId: string,
  previous: Record<string, string> | null,
  next: Record<string, string> | null,
  now = new Date(),
): Promise<{ disconnected: number }> {
  await syncInstanceLogins(ctx.db, ctx.masterKey, now);
  let disconnected = 0;
  if (integrationId === GITHUB_APP.id && replacesGithubApp(previous, next)) {
    disconnected = await disconnectServerConnections(ctx.db, GITHUB_SERVER_ID, now);
  }
  ctx.mcp?.forgetListings();
  return { disconnected };
}
