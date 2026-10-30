import * as Sentry from "@sentry/node";
import type { Scope } from "@sentry/node";
import type { LogFields, LogLevel } from "./log.js";

function sampleRate(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    return fallback;
  }
  return value;
}

/** The box's error reporting: where Sentry receives this process's errors, traces and logs. */
export type ErrorReporting = {
  /** Empty leaves error reporting off. */
  dsn: string;
};

export function initSentry(reporting: ErrorReporting): boolean {
  if (Sentry.getClient()) {
    return true;
  }
  if (process.env.NODE_TEST_CONTEXT) {
    return false;
  }
  if (!reporting.dsn) {
    return false;
  }
  Sentry.init({
    dsn: reporting.dsn,
    environment:
      (process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development").trim() || "development",
    tracesSampleRate: sampleRate("SENTRY_TRACES_SAMPLE_RATE", 1),
    // The CPU profiler runs while a sampled trace is open.
    profileSessionSampleRate: sampleRate("SENTRY_PROFILE_SESSION_SAMPLE_RATE", 1),
    profileLifecycle: "trace",
    enableLogs: true,
    enableMetrics: true,
    debug: process.env.SENTRY_DEBUG === "1",
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpBodies: [],
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
    },
  });
  return Boolean(Sentry.getClient());
}

export function sentryEnabled(): boolean {
  return Boolean(Sentry.getClient());
}

function asError(message: string, error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  const wrapped = new Error(message);
  if (error !== undefined && error !== null) {
    wrapped.cause = error;
  }
  return wrapped;
}

function setTag(scope: Scope, key: string, value: string | number | null | undefined): void {
  if (value === undefined || value === null || value === "") {
    return;
  }
  scope.setTag(key, String(value));
}

export const sentryCapture = {
  exception(level: LogLevel, message: string, fields: LogFields, error?: unknown): void {
    if (level !== "error") {
      return;
    }
    if (!Sentry.getClient()) {
      return;
    }
    Sentry.withScope((scope) => {
      scope.setLevel("error");
      setTag(scope, "source", fields.source ?? "backend");
      setTag(scope, "operation", fields.operation);
      setTag(scope, "run_id", fields.run_id);
      setTag(scope, "guild_id", fields.guild_id);
      setTag(scope, "agent_id", fields.agent_id);
      setTag(scope, "request_id", fields.request_id);
      setTag(scope, "session_id", fields.session_id);
      setTag(scope, "path", fields.path);
      setTag(scope, "method", fields.method);
      if (fields.status != null) {
        scope.setTag("status", String(fields.status));
      }
      if (fields.error_type) {
        scope.setTag("error_type", fields.error_type);
      }
      scope.setExtra("message", message);
      Sentry.captureException(asError(message, error));
    });
  },
  log(level: LogLevel, message: string, attributes: LogAttributes): void {
    if (!Sentry.getClient()) {
      return;
    }
    Sentry.logger[level](message, attributes);
  },
};

export type LogAttributes = Record<string, string | number>;

const SENTRY_LOG_LEVELS: ReadonlySet<LogLevel> = new Set(["info", "warn", "error"]);

/** Sends an info, warn, or error line to Sentry Logs with its fields as attributes. */
export function captureLog(level: LogLevel, message: string, attributes: LogAttributes): void {
  if (!SENTRY_LOG_LEVELS.has(level)) {
    return;
  }
  try {
    sentryCapture.log(level, message, attributes);
  } catch {
    /* never break logging */
  }
}

export function captureLogError(
  level: LogLevel,
  message: string,
  fields: LogFields,
  error?: unknown,
): void {
  if (level !== "error") {
    return;
  }
  try {
    sentryCapture.exception(level, message, fields, error);
  } catch {
    /* never break logging */
  }
}

export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!Sentry.getClient()) {
    return;
  }
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    /* shutdown continues */
  }
}
