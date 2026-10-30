import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { HARNESSES, type Harness } from "../db/schema/index.js";
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

/** What an extension adds to core's settings: the modes it identifies requests in. */
export type ConfigExtension = {
  authModes?: readonly string[];
};

/** A setting the configuration refuses; `setting` is the variable it concerns. */
export class ConfigError extends Error {
  readonly setting: string;

  constructor(setting: string, message: string) {
    super(message);
    this.name = "ConfigError";
    this.setting = setting;
  }
}

function readRequired(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new ConfigError(name, `${name} is required`);
  }
  return value;
}

/** An optional setting's value, trimmed; empty when it is unset. */
function readTrimmed(env: NodeJS.ProcessEnv, name: string): string {
  return (env[name] ?? "").trim();
}

function isDirectory(value: string): boolean {
  return existsSync(value) && statSync(value).isDirectory();
}

function readDir(env: NodeJS.ProcessEnv, name: string): string {
  const value = readRequired(env, name);
  if (!isDirectory(value)) {
    throw new ConfigError(name, `${name} must be an existing directory: ${value}`);
  }
  return path.resolve(value);
}

export function defaultTemplatesRoot(metaUrl = import.meta.url): string {
  return path.join(orchestratorRoot(metaUrl), "src", "prompts");
}

export function decodeMasterKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ConfigError("SECRETS_MASTER_KEY", "SECRETS_MASTER_KEY is required");
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
  throw new ConfigError("SECRETS_MASTER_KEY", "SECRETS_MASTER_KEY must be 32 bytes (base64 or hex)");
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
 * The harnesses a `HARNESSES_OFF` value names, separated by commas or spaces; throws on a name
 * that is not a harness, so a typo fails boot.
 */
export function parseHarnessesOff(value: string | undefined): Harness[] {
  const names = (value ?? "").split(/[\s,]+/).filter(Boolean);
  const harnesses = names.map((name) => {
    const harness = HARNESSES.find((known) => known === name);
    if (harness === undefined) {
      throw new ConfigError("HARNESSES_OFF", `HARNESSES_OFF names an unknown harness ${name}: use ${HARNESSES.join(", ")}`);
    }
    return harness;
  });
  return [...new Set(harnesses)];
}

/** `TEMPLATES_ROOT`, or the templates the package ships; either must be a directory. */
function readTemplatesRoot(env: NodeJS.ProcessEnv): string {
  const templatesRoot = env.TEMPLATES_ROOT ? readDir(env, "TEMPLATES_ROOT") : defaultTemplatesRoot();
  if (!isDirectory(templatesRoot)) {
    throw new ConfigError("TEMPLATES_ROOT", `agent templates missing: ${templatesRoot}`);
  }
  return templatesRoot;
}

/** `AUTH_MODE`, one of `authModes`; `compat-cookie` when it is unset. */
function readAuthMode(env: NodeJS.ProcessEnv, authModes: readonly string[]): AuthMode {
  const authMode = env.AUTH_MODE ?? "compat-cookie";
  if (!authModes.includes(authMode)) {
    throw new ConfigError("AUTH_MODE", `AUTH_MODE must be ${authModes.join(", ")}`);
  }
  return authMode;
}

/** `SECRETS_MASTER_KEY`, which may be the all-zero development key only with `ALLOW_ZERO_MASTER_KEY=1`. */
function readSecretsMasterKey(env: NodeJS.ProcessEnv): string {
  const secretsMasterKey = readRequired(env, "SECRETS_MASTER_KEY");
  if (decodeMasterKey(secretsMasterKey).every((byte) => byte === 0) && env[ALLOW_ZERO_MASTER_KEY] !== "1") {
    throw new ConfigError(
      "SECRETS_MASTER_KEY",
      `SECRETS_MASTER_KEY is the all-zero development key: set 32 random bytes (${ALLOW_ZERO_MASTER_KEY}=1 accepts it on a development stack)`,
    );
  }
  return secretsMasterKey;
}

function readMaxConcurrentGenerations(env: NodeJS.ProcessEnv): number {
  const maxConcurrentGenerations = Number(env.MAX_CONCURRENT_GENERATIONS ?? "0");
  if (!Number.isInteger(maxConcurrentGenerations) || maxConcurrentGenerations < 0) {
    throw new ConfigError("MAX_CONCURRENT_GENERATIONS", "MAX_CONCURRENT_GENERATIONS must be a non-negative integer");
  }
  return maxConcurrentGenerations;
}

/** `OPERATOR_EMAIL` normalised, or null when it is unset or blank. */
function readOperatorEmail(env: NodeJS.ProcessEnv): string | null {
  const raw = readTrimmed(env, "OPERATOR_EMAIL");
  const operatorEmail = normalizeEmail(raw);
  if (raw && operatorEmail === null) {
    throw new ConfigError("OPERATOR_EMAIL", "OPERATOR_EMAIL must be an email address");
  }
  return operatorEmail;
}

/** The settings `AUTH_MODE=trusted-header` cannot run without. */
function requireTrustedHeaderSettings(
  trustedProxySecret: string,
  publicBaseUrl: string,
  operatorEmail: string | null,
): void {
  if (!trustedProxySecret) {
    throw new ConfigError("TRUSTED_PROXY_SECRET", "TRUSTED_PROXY_SECRET is required when AUTH_MODE=trusted-header");
  }
  if (!publicBaseUrl) {
    // The proxy forwards its own hostname, which is served only when it is PUBLIC_BASE_URL's.
    throw new ConfigError("PUBLIC_BASE_URL", "PUBLIC_BASE_URL is required when AUTH_MODE=trusted-header");
  }
  if (operatorEmail === null) {
    // A user is identified by their email, and a box starts with a user who has none.
    throw new ConfigError("OPERATOR_EMAIL", "OPERATOR_EMAIL is required when AUTH_MODE=trusted-header");
  }
}

/**
 * Core's settings from the environment. `extension.authModes` are the modes an extension
 * identifies requests in, accepted beside core's. A setting it refuses throws a `ConfigError`.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, extension: ConfigExtension = {}): AppConfig {
  const databaseUrl = readRequired(env, "DATABASE_URL");
  const notesRoot = readDir(env, "NOTES_ROOT");
  const workspaceRoot = readDir(env, "WORKSPACE_ROOT");
  const templatesRoot = readTemplatesRoot(env);
  const authMode = readAuthMode(env, [...AUTH_MODES, ...(extension.authModes ?? [])]);
  const secretsMasterKey = readSecretsMasterKey(env);
  const maxConcurrentGenerations = readMaxConcurrentGenerations(env);
  const publicBaseUrl = readTrimmed(env, "PUBLIC_BASE_URL");
  const trustedProxySecret = readTrimmed(env, "TRUSTED_PROXY_SECRET");
  const sandboxImage = readRequired(env, "SANDBOX_IMAGE");
  const operatorEmail = readOperatorEmail(env);
  if (authMode === "trusted-header") {
    requireTrustedHeaderSettings(trustedProxySecret, publicBaseUrl, operatorEmail);
  }
  const attachmentsRoot = readTrimmed(env, "ATTACHMENTS_ROOT");
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
    trustedHeaderName: readTrimmed(env, "TRUSTED_HEADER_EMAIL") || "X-Forwarded-Email",
    trustedProxySecret,
    operatorEmail: operatorEmail ?? "",
    maxConcurrentGenerations,
    attachmentsRoot: attachmentsRoot ? path.resolve(attachmentsRoot) : "",
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
