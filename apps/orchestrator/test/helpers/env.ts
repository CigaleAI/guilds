import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AppConfig } from "../../src/config/index.js";
import { GITHUB_APP, GOOGLE_CONNECTORS } from "../../src/instance/integrations.js";

export const HEX_MASTER_KEY = "0".repeat(64);

/**
 * Drops the connector instance keys from this test process, so a connector's setup state reads as
 * it does on the box the recordings come from, whatever the shell exports.
 */
export function clearConnectorKeys(): void {
  for (const integration of [GITHUB_APP, GOOGLE_CONNECTORS]) {
    for (const variable of integration.variables) {
      delete process.env[variable.name];
    }
  }
}

export function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function testEnv(
  databaseUrl: string,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const notesRoot = extra.NOTES_ROOT ?? tempDir("guilds-notes-");
  const workspaceRoot = extra.WORKSPACE_ROOT ?? tempDir("guilds-workspaces-");
  return {
    DATABASE_URL: databaseUrl,
    NOTES_ROOT: notesRoot,
    WORKSPACE_ROOT: workspaceRoot,
    OPENSANDBOX_URL: extra.OPENSANDBOX_URL ?? "http://127.0.0.1:18080",
    OPENSANDBOX_API_KEY: extra.OPENSANDBOX_API_KEY ?? "guilds-dev",
    SANDBOX_IMAGE: extra.SANDBOX_IMAGE ?? "agent-runtime:0.3",
    SECRETS_MASTER_KEY: extra.SECRETS_MASTER_KEY ?? HEX_MASTER_KEY,
    ALLOW_ZERO_MASTER_KEY: "1",
    AUTH_MODE: extra.AUTH_MODE ?? "compat-cookie",
    HOST: extra.HOST ?? "127.0.0.1",
    PORT: extra.PORT ?? "0",
    REGISTRY_URL: extra.REGISTRY_URL ?? "",
    ...extra,
  };
}

export function requiredConfigKeys(): (keyof AppConfig)[] {
  return [
    "databaseUrl",
    "notesRoot",
    "workspaceRoot",
    "templatesRoot",
    "opensandboxUrl",
    "opensandboxApiKey",
    "sandboxImage",
    "secretsMasterKey",
    "authMode",
    "host",
    "port",
    "toolResultMaxBytes",
    "obsidianVaultName",
  ];
}
