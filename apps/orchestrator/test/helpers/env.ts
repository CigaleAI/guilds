import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AppConfig } from "../../src/config/index.js";
import { setInstanceKeys, type InstanceKeySnapshot } from "../../src/instance/integrations.js";

export const HEX_MASTER_KEY = "0".repeat(64);

/** Empties this process's instance keys, so every store integration reads as off. */
export function clearInstanceKeys(): void {
  setInstanceKeys({});
}

/** A snapshot holding the given values per integration id, as the store would load them. */
export function storeKeys(values: Record<string, Record<string, string>>, at = "2026-10-10T00:00:00.000Z"): InstanceKeySnapshot {
  return Object.fromEntries(
    Object.entries(values).map(([integration, fields]) => [integration, { values: fields, updated_at: at, set_by: "operator" }]),
  );
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
    SANDBOX_IMAGE: extra.SANDBOX_IMAGE ?? "agent-runtime:0.4",
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
