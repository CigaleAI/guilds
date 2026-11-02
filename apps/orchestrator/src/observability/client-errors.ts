import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type, type Static } from "typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { writeLog } from "./log.js";

const MESSAGE_MAX = 500;
const STACK_MAX = 4_000;
const HREF_MAX = 500;
const KIND_MAX = 32;
const REQUEST_ID_MAX = 128;
const MAX_PER_MINUTE = 30;
const RATE_WINDOW_MS = 60_000;

/**
 * A failure the operator app reports from a page: its kind (`onerror`, `unhandledrejection`,
 * `react` or `api`), its message and stack, the page's address, and the tab's request id.
 */
const ClientErrorReport = Type.Object({
  kind: Type.String(),
  message: Type.String(),
  stack: Type.Optional(Type.String()),
  href: Type.Optional(Type.String()),
  request_id: Type.Optional(Type.String()),
});
export type ClientErrorReport = Static<typeof ClientErrorReport>;

const hits = new Map<string, number[]>();

/** The text trimmed and cut to `max`; null when it is absent or blank. */
function clip(value: string | undefined, max: number): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, max);
}

function allow(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((stamp) => now - stamp < RATE_WINDOW_MS);
  if (recent.length >= MAX_PER_MINUTE) {
    hits.set(ip, recent);
    return false;
  }
  recent.push(now);
  hits.set(ip, recent);
  return true;
}

function clientPath(href: string | null): string | null {
  if (!href) {
    return null;
  }
  try {
    const url = new URL(href);
    return `${url.pathname}${url.hash}`.slice(0, HREF_MAX);
  } catch {
    return href.split("?")[0]?.slice(0, HREF_MAX) ?? null;
  }
}

/** Logs a page's report as a frontend error line, unless its address has sent its minute's quota. */
export function ingestClientError(report: ClientErrorReport, request: FastifyRequest): void {
  if (!allow(request.ip || "unknown")) {
    return;
  }
  const message = clip(report.message, MESSAGE_MAX) ?? "client error";
  const stack = clip(report.stack, STACK_MAX);
  const href = clip(report.href, HREF_MAX);
  const kind = clip(report.kind, KIND_MAX) ?? "onerror";
  const requestId = clip(report.request_id, REQUEST_ID_MAX) ?? request.id;
  const err = new Error(message);
  err.name = kind.startsWith("client.") ? kind : `client.${kind}`;
  if (stack) {
    err.stack = stack;
  }
  writeLog(
    "error",
    message,
    {
      source: "frontend",
      operation: "client.error",
      request_id: requestId,
      path: clientPath(href),
      error_type: err.name,
    },
    err,
  );
}

/** `POST /api/client-errors`: the route's schema reads the report, and every report taken answers 204. */
export function registerClientErrorRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<TypeBoxTypeProvider>();
  typed.post("/api/client-errors", { schema: { body: ClientErrorReport } }, async (request, reply) => {
    try {
      ingestClientError(request.body, request);
    } catch {
      /* never fail the reporter */
    }
    return reply.code(204).send();
  });
}
