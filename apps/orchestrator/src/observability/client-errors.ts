import type { FastifyInstance, FastifyRequest } from "fastify";
import { writeLog } from "./log.js";

const MESSAGE_MAX = 500;
const STACK_MAX = 4_000;
const HREF_MAX = 500;
const KIND_MAX = 32;
const REQUEST_ID_MAX = 128;
const MAX_PER_MINUTE = 30;
const RATE_WINDOW_MS = 60_000;

const hits = new Map<string, number[]>();

function clip(value: unknown, max: number): string | null {
  if (typeof value !== "string") {
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

function asObject(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body) && !Buffer.isBuffer(body)) {
    return body as Record<string, unknown>;
  }
  const raw = Buffer.isBuffer(body)
    ? body.toString("utf8")
    : typeof body === "string"
      ? body
      : "";
  if (!raw.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* ignore */
  }
  return {};
}

export function ingestClientError(body: unknown, request: FastifyRequest): void {
  if (!allow(request.ip || "unknown")) {
    return;
  }
  const payload = asObject(body);
  const message = clip(payload.message, MESSAGE_MAX) ?? "client error";
  const stack = clip(payload.stack, STACK_MAX);
  const href = clip(payload.href, HREF_MAX);
  const kind = clip(payload.kind, KIND_MAX) ?? "onerror";
  const requestId = clip(payload.request_id, REQUEST_ID_MAX) ?? request.id;
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

export function registerClientErrorRoute(app: FastifyInstance): void {
  app.post("/api/client-errors", async (request, reply) => {
    try {
      ingestClientError(request.body, request);
    } catch {
      /* never fail the reporter */
    }
    return reply.code(204).send();
  });
}
