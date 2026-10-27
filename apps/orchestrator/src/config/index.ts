import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { parseHarnessesOff, type Harness } from "../coding/harnesses.js";
import { normalizeEmail } from "../lib/email.js";
import { orchestratorRoot } from "../lib/paths.js";

/** The modes core identifies a request in; an extension names its own when it loads the configuration. */
export const AUTH_MODES = ["compat-cookie", "trusted-header"] as const;
export type AuthMode = string;
/** Set to `1` on a development stack, which runs on the all-zero master key. */
export const ALLOW_ZERO_MASTER_KEY = "ALLOW_ZERO_MASTER_KEY";

export type AppConfig = {
  databaseUrl: string;
  notesRoot: string;
  workspaceRoot: string;
  templatesRoot: string;
  opensandboxUrl: string;
  opensandboxApiKey: string;
  /** The image every machine runs: coding tools and Chromium. */
  sandboxImage: string;
  secretsMasterKey: string;
  authMode: AuthMode;
  host: string;
  port: number;
  toolResultMaxBytes: number;
  publicBaseUrl: string;
  trustedHeaderName: string;
  trustedProxySecret: string;
  /** The address a proxy sends for the box's first user, which boot gives that user; empty leaves it as it is. */
  operatorEmail: string;
  /** Generations running at once across every organisation; 0 leaves it to each organisation's cap. */
  maxConcurrentGenerations: number;
  /** Directory chat attachments are kept in; empty keeps their bytes in process memory. */
  attachmentsRoot: string;
  /** The coding harnesses the box turns off: kept in the image, neither offered nor run. */
  harnessesOff: Harness[];
};

function readRequired(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readDir(env: NodeJS.ProcessEnv, name: string): string {
  const value = readRequired(env, name);
  if (!existsSync(value) || !statSync(value).isDirectory()) {
    throw new Error(`${name} must be an existing directory: ${value}`);
  }
  return path.resolve(value);
}

export function defaultTemplatesRoot(metaUrl = import.meta.url): string {
  return path.join(orchestratorRoot(metaUrl), "src", "prompts");
}

export function decodeMasterKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("SECRETS_MASTER_KEY is required");
  }
  const std = decodeValidatedBase64(trimmed, "standard");
  if (std?.length === 32) {
    return std;
  }
  const url = decodeValidatedBase64(trimmed, "url");
  if (url?.length === 32) {
    return url;
  }
  const hex = decodeHexBytes(trimmed);
  if (hex?.length === 32) {
    return hex;
  }
  if ([...trimmed].every((char) => char.charCodeAt(0) < 128)) {
    const ascii = Buffer.from(trimmed, "ascii");
    if (ascii.length === 32) {
      return ascii;
    }
  }
  throw new Error("SECRETS_MASTER_KEY must be 32 bytes (base64 or hex)");
}

function decodeValidatedBase64(raw: string, alphabet: "standard" | "url"): Buffer | null {
  const charset = alphabet === "standard" ? /^[A-Za-z0-9+/]+={0,2}$/ : /^[A-Za-z0-9_-]+={0,2}$/;
  if (!charset.test(raw)) {
    return null;
  }
  const stripped = raw.replace(/=+$/, "");
  const padded =
    alphabet === "url"
      ? stripped + "=".repeat((4 - (stripped.length % 4)) % 4)
      : raw;
  if (padded.length % 4 !== 0) {
    return null;
  }
  const encoding = alphabet === "standard" ? "base64" : "base64url";
  const key = Buffer.from(padded, encoding);
  const roundTrip = key.toString(encoding).replace(/=+$/, "");
  if (roundTrip !== stripped) {
    return null;
  }
  return key;
}

function decodeHexBytes(raw: string): Buffer | null {
  if (/[^0-9a-fA-F\s]/.test(raw)) {
    return null;
  }
  const hex = raw.replace(/\s+/g, "");
  if (hex.length % 2 !== 0 || hex.length === 0) {
    return null;
  }
  return Buffer.from(hex, "hex");
}

/**
 * Core's settings from the environment. `authModes` are the modes an extension identifies requests
 * in, accepted beside core's.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { authModes?: readonly string[] } = {},
): AppConfig {
  const databaseUrl = readRequired(env, "DATABASE_URL");
  const notesRoot = readDir(env, "NOTES_ROOT");
  const workspaceRoot = readDir(env, "WORKSPACE_ROOT");
  const templatesRoot = env.TEMPLATES_ROOT
    ? readDir(env, "TEMPLATES_ROOT")
    : defaultTemplatesRoot();
  if (!existsSync(templatesRoot) || !statSync(templatesRoot).isDirectory()) {
    throw new Error(`agent templates missing: ${templatesRoot}`);
  }
  const authModes = [...AUTH_MODES, ...(options.authModes ?? [])];
  const authMode = env.AUTH_MODE ?? "compat-cookie";
  if (!authModes.includes(authMode)) {
    throw new Error(`AUTH_MODE must be ${authModes.join(", ")}`);
  }
  const secretsMasterKey = readRequired(env, "SECRETS_MASTER_KEY");
  if (decodeMasterKey(secretsMasterKey).every((byte) => byte === 0) && env[ALLOW_ZERO_MASTER_KEY] !== "1") {
    throw new Error(
      `SECRETS_MASTER_KEY is the all-zero development key: set 32 random bytes (${ALLOW_ZERO_MASTER_KEY}=1 accepts it on a development stack)`,
    );
  }
  const maxConcurrentGenerations = Number(env.MAX_CONCURRENT_GENERATIONS ?? "0");
  if (!Number.isInteger(maxConcurrentGenerations) || maxConcurrentGenerations < 0) {
    throw new Error("MAX_CONCURRENT_GENERATIONS must be a non-negative integer");
  }
  const publicBaseUrl = (env.PUBLIC_BASE_URL ?? "").trim();
  const trustedProxySecret = (env.TRUSTED_PROXY_SECRET ?? "").trim();
  const sandboxImage = readRequired(env, "SANDBOX_IMAGE");
  const operatorEmail = normalizeEmail(env.OPERATOR_EMAIL ?? "");
  if ((env.OPERATOR_EMAIL ?? "").trim() && operatorEmail === null) {
    throw new Error("OPERATOR_EMAIL must be an email address");
  }
  if (authMode === "trusted-header") {
    if (!trustedProxySecret) {
      throw new Error("TRUSTED_PROXY_SECRET is required when AUTH_MODE=trusted-header");
    }
    if (!publicBaseUrl) {
      // The proxy forwards its own hostname, which is served only when it is PUBLIC_BASE_URL's.
      throw new Error("PUBLIC_BASE_URL is required when AUTH_MODE=trusted-header");
    }
    if (operatorEmail === null) {
      // A user is identified by their email, and a box starts with a user who has none.
      throw new Error("OPERATOR_EMAIL is required when AUTH_MODE=trusted-header");
    }
  }
  return {
    databaseUrl,
    notesRoot,
    workspaceRoot,
    templatesRoot,
    opensandboxUrl: readRequired(env, "OPENSANDBOX_URL"),
    opensandboxApiKey: readRequired(env, "OPENSANDBOX_API_KEY"),
    sandboxImage,
    secretsMasterKey,
    authMode,
    host: env.HOST ?? "0.0.0.0",
    port: Number(env.PORT ?? "8080"),
    toolResultMaxBytes: Number(env.TOOL_RESULT_MAX_BYTES ?? "65536"),
    publicBaseUrl,
    trustedHeaderName: (env.TRUSTED_HEADER_EMAIL ?? "X-Forwarded-Email").trim() || "X-Forwarded-Email",
    trustedProxySecret,
    operatorEmail: operatorEmail ?? "",
    maxConcurrentGenerations,
    attachmentsRoot: (env.ATTACHMENTS_ROOT ?? "").trim() ? path.resolve((env.ATTACHMENTS_ROOT ?? "").trim()) : "",
    harnessesOff: parseHarnessesOff(env.HARNESSES_OFF),
  };
}

/**
 * Core's settings for a command-line tool. A tool identifies no request, so it takes whatever
 * mode the box runs in.
 */
export function loadToolConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return loadConfig(env, { authModes: env.AUTH_MODE ? [env.AUTH_MODE] : [] });
}
