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
] as const satisfies readonly (keyof LogLine)[];

/** The extras that are text, redacted before they are written. */
const TEXT_EXTRA_KEYS = [
  "machine_id",
  "source",
  "request_id",
  "session_id",
  "path",
  "method",
] as const satisfies readonly (keyof LogExtras & keyof LogFields)[];

export const LOG_EXTRA_KEYS = [...TEXT_EXTRA_KEYS, "status"] as const satisfies readonly (keyof LogExtras)[];

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

/** The fields a line carries after its `LOG_KEYS` when they are set, redacted, in `LOG_EXTRA_KEYS` order. */
type LogExtras = {
  machine_id?: string;
  source?: string;
  request_id?: string;
  session_id?: string;
  path?: string;
  method?: string;
  status?: number;
};

/** A log line as written to stdout: the fields every line has, in `LOG_KEYS` order, then its extras. */
export type LogLine = {
  timestamp: string;
  level: LogLevel;
  run_id: string | null;
  guild_id: string | null;
  agent_id: string | null;
  operation: string | null;
  error_type: string | null;
  message: string;
  traceback: string | null;
} & LogExtras;

/** The secret values this process's environment holds, by variable name. */
function envSecrets(): Map<string, string> {
  const secrets = new Map<string, string>();
  for (const [name, value] of Object.entries(process.env)) {
    if (value && SECRET_NAME_RE.test(name)) {
      secrets.set(name, value);
    }
  }
  return secrets;
}

export function redactText(
  text: string,
  extra: Record<string, string> = {},
): string {
  const merged = new Map([...envSecrets(), ...Object.entries(extra)]);
  const items = [...merged].sort((a, b) => b[1].length - a[1].length);
  let redacted = text;
  for (const [name, value] of items) {
    if (value) {
      redacted = redacted.split(value).join(`[REDACTED:${name}]`);
    }
  }
  return redacted;
}

function formatTimestamp(date: Date): string {
  return date.toISOString();
}

/** The extras `fields` sets, text redacted; an empty text or a status that is not finite is left out. */
function lineExtras(fields: LogFields): LogExtras {
  const extras: LogExtras = {};
  for (const key of TEXT_EXTRA_KEYS) {
    const value = fields[key];
    if (value) {
      extras[key] = redactText(value);
    }
  }
  if (fields.status != null && Number.isFinite(fields.status)) {
    extras.status = fields.status;
  }
  return extras;
}

/** Writes lines; `warn` and `error` take the value thrown, when there is one, as their `cause`. */
export type Logger = {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields, cause?: unknown): void;
  error(message: string, fields?: LogFields, cause?: unknown): void;
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
    try {
      handle?.setBlocking?.(true);
    } catch {
      /* ignore */
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

/** What a line reports of a thrown value: the Error it is or wraps, and its stack or the value as text. */
type ThrownReport = {
  error: Error;
  traceback: string;
};

/**
 * Decides once what a thrown value is. An Error reports itself and its stack; any other value is
 * wrapped in an Error with the line's message that carries it as its cause, and is reported as
 * text. Nothing thrown reports nothing.
 */
function thrownReport(message: string, cause: unknown): ThrownReport | null {
  if (cause instanceof Error) {
    return { error: cause, traceback: cause.stack ?? cause.message };
  }
  if (cause === undefined || cause === null) {
    return null;
  }
  return { error: new Error(message, { cause }), traceback: String(cause) };
}

/** Writes one line at `level`, with `fields` and, when there is one, the value thrown as its `cause`. */
export function writeLog(
  level: LogLevel,
  message: string,
  fields: LogFields = {},
  cause?: unknown,
): void {
  const thrown = thrownReport(message, cause);
  const line: LogLine = {
    timestamp: formatTimestamp(new Date()),
    level,
    run_id: fields.run_id ?? null,
    guild_id: fields.guild_id ?? null,
    agent_id: fields.agent_id ?? null,
    operation: fields.operation ?? null,
    error_type: fields.error_type ?? thrown?.error.name ?? null,
    message: redactText(message),
    traceback: thrown ? redactText(thrown.traceback) : null,
    ...lineExtras(fields),
  };
  try {
    logWriter.write(`${JSON.stringify(line)}\n`);
    mirrorToConsole(level, line.message, fields, line.traceback);
  } catch (failed) {
    const fallback = `[error] log write failed: ${failed instanceof Error ? failed.message : String(failed)}\n[${level}] ${message}\n`;
    writeFd(2, fallback, process.stderr);
  }
  captureLog(level, line.message, logAttributes(line));
  captureLogError(level, line.message, fields, thrown?.error ?? null);
}

const NOT_ATTRIBUTES = new Set(["timestamp", "level", "message"]);

/** The fields of a written line, already redacted, without the ones Sentry Logs sets itself. */
function logAttributes(line: LogLine): LogAttributes {
  const attributes: LogAttributes = {};
  for (const [key, value] of Object.entries(line)) {
    if (!NOT_ATTRIBUTES.has(key) && value !== null && value !== undefined) {
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
    warn(message, fields, cause) {
      writeLog("warn", message, fields, cause);
    },
    error(message, fields, cause) {
      writeLog("error", message, fields, cause);
    },
  };
}

export function configureLogging(): Logger {
  unblockStdio();
  return createLogger();
}

/** The class name of a thrown value for a log line's `error_type`: an Error's name, or `Error`. */
export function errorName(cause: unknown): string {
  return cause instanceof Error && cause.name ? cause.name : "Error";
}

/** The message of a thrown value: an Error's message, or the value as text. */
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
