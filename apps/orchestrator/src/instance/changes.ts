import { syncInstanceLogins } from "../connectors/instance.js";
import type { Repositories } from "../db/repositories.js";
import { GITHUB_SERVER_ID } from "../github/index.js";
import type { McpPool } from "../mcp/index.js";
import { GITHUB_APP } from "./integrations.js";

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
 * What the process does once an instance key changed: platform logins follow their integration,
 * and a GitHub App that is replaced or removed disconnects every login installed with it, since
 * their installations belong to the old App. Returns how many it disconnected.
 */
export async function applyKeyChange(
  ctx: { repo: Repositories; masterKey?: Buffer | undefined; mcp?: McpPool | undefined },
  integrationId: string,
  previous: Record<string, string> | null,
  next: Record<string, string> | null,
  now = new Date(),
): Promise<{ disconnected: number }> {
  await syncInstanceLogins(ctx.repo, ctx.masterKey, now);
  let disconnected = 0;
  if (integrationId === GITHUB_APP.id && replacesGithubApp(previous, next)) {
    disconnected = await ctx.repo.disconnectServerConnections(GITHUB_SERVER_ID, now);
  }
  ctx.mcp?.forgetListings();
  return { disconnected };
}
