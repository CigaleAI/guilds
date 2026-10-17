import { writeSync } from "node:fs";
import { captureLog, captureLogError, type LogAttributes } from "./sentry.js";

const SECRET_NAME_RE = /(API_KEY|SECRET|TOKEN|PASSWORD|PASSWD)$/i;

export const LOG_KEYS = [
  "timestamp",
  "level",
  "run_id",
  "guild_id",
  "agent_id",
  "operation",
  "error_type",
  "message",
  "traceback",
] as const;

export const LOG_EXTRA_KEYS = [
  "machine_id",
  "source",
  "request_id",
  "session_id",
  "path",
  "method",
  "status",
] as const;

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogSource = "backend" | "frontend";

export type LogFields = {
  run_id?: string | null;
  guild_id?: string | null;
  agent_id?: string | null;
  machine_id?: string | null;
  operation?: string | null;
  error_type?: string | null;
  source?: LogSource | null;
  request_id?: string | null;
  session_id?: string | null;
  path?: string | null;
  method?: string | null;
  status?: number | null;
};

function envSecrets(): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value && SECRET_NAME_RE.test(name)) {
      secrets[name] = value;
    }
  }
  return secrets;
}

export function redactText(
  text: string,
  extra: Record<string, string> = {},
): string {
  const merged = { ...envSecrets(), ...extra };
  const items = Object.entries(merged).sort((a, b) => b[1].length - a[1].length);
  let redacted = text;
  for (const [name, value] of items) {
    if (value) {
      redacted = redacted.split(value).join(`[REDACTED:${name}]`);
    }
  }
  return redacted;
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/Z$/, "Z");
}

function extraValue(value: string | number | null | undefined): string | number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  return redactText(value);
}

export type Logger = {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields, error?: unknown): void;
  error(message: string, fields?: LogFields, error?: unknown): void;
};

function writeFd(fd: number, chunk: string, fallback: NodeJS.WriteStream): void {
  try {
    writeSync(fd, chunk);
  } catch {
    fallback.write(chunk);
  }
}

/** Sync stdout so Docker/json-file picks up lines immediately (piped stdout is block-buffered). */
export const logWriter = {
  write(chunk: string): void {
    writeFd(1, chunk, process.stdout);
  },
};

function unblockStdio(): void {
  for (const stream of [process.stdout, process.stderr]) {
    const handle = (stream as { _handle?: { setBlocking?: (v: boolean) => void } })._handle;
    if (handle && typeof handle.setBlocking === "function") {
      try {
        handle.setBlocking(true);
      } catch {
        /* ignore */
      }
    }
  }
}

function consoleLine(level: LogLevel, message: string, fields: LogFields): string {
  const bits = [`[${level}]`];
  if (fields.operation) {
    bits.push(fields.operation);
  }
  if (fields.method && fields.path) {
    bits.push(`${fields.method} ${fields.path}`);
  } else if (fields.path) {
    bits.push(fields.path);
  }
  if (fields.status != null) {
    bits.push(String(fields.status));
  }
  bits.push(message);
  return bits.join(" ");
}

function mirrorToConsole(level: LogLevel, message: string, fields: LogFields, traceback: string | null): void {
  if (level !== "error" && level !== "warn") {
    return;
  }
  // node --test sets this; keep TAP output clean while still flushing JSON.
  if (process.env.NODE_TEST_CONTEXT) {
    return;
  }
  let text = `${consoleLine(level, message, fields)}\n`;
  if (traceback) {
    text += `${traceback}\n`;
  }
  writeFd(2, text, process.stderr);
}

export function writeLog(
  level: LogLevel,
  message: string,
  fields: LogFields = {},
  error?: unknown,
): void {
  let errorType = fields.error_type ?? null;
  let traceback: string | null = null;
  if (error instanceof Error) {
    errorType = errorType ?? error.name;
    traceback = redactText(error.stack ?? error.message);
  } else if (error !== undefined && error !== null) {
    traceback = redactText(String(error));
  }
  const payload: Record<(typeof LOG_KEYS)[number], unknown> = {
    timestamp: formatTimestamp(new Date()),
    level,
    run_id: fields.run_id ?? null,
    guild_id: fields.guild_id ?? null,
    agent_id: fields.agent_id ?? null,
    operation: fields.operation ?? null,
    error_type: errorType,
    message: redactText(message),
    traceback,
  };
  const ordered: Record<string, unknown> = {};
  for (const key of LOG_KEYS) {
    ordered[key] = payload[key];
  }
  const extras: Record<(typeof LOG_EXTRA_KEYS)[number], string | number | null | undefined> = {
    machine_id: fields.machine_id,
    source: fields.source,
    request_id: fields.request_id,
    session_id: fields.session_id,
    path: fields.path,
    method: fields.method,
    status: fields.status,
  };
  for (const key of LOG_EXTRA_KEYS) {
    const value = extraValue(extras[key]);
    if (value !== null) {
      ordered[key] = value;
    }
  }
  try {
    logWriter.write(`${JSON.stringify(ordered)}\n`);
    mirrorToConsole(level, String(payload.message), fields, traceback);
  } catch (failed) {
    const fallback = `[error] log write failed: ${failed instanceof Error ? failed.message : String(failed)}\n[${level}] ${message}\n`;
    writeFd(2, fallback, process.stderr);
  }
  captureLog(level, String(payload.message), logAttributes(ordered));
  captureLogError(level, String(payload.message), fields, error);
}

const NOT_ATTRIBUTES = new Set(["timestamp", "level", "message"]);

function isAttributeValue(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

/** The fields of a written line, already redacted, without the ones Sentry Logs sets itself. */
function logAttributes(ordered: Record<string, unknown>): LogAttributes {
  const attributes: LogAttributes = {};
  for (const [key, value] of Object.entries(ordered)) {
    if (!NOT_ATTRIBUTES.has(key) && isAttributeValue(value)) {
      attributes[key] = value;
    }
  }
  return attributes;
}

export function createLogger(): Logger {
  return {
    debug(message, fields) {
      writeLog("debug", message, fields);
    },
    info(message, fields) {
      writeLog("info", message, fields);
    },
    warn(message, fields, error) {
      writeLog("warn", message, fields, error);
    },
    error(message, fields, error) {
      writeLog("error", message, fields, error);
    },
  };
}

export function configureLogging(): Logger {
  unblockStdio();
  return createLogger();
}
