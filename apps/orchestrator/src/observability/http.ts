import type { FastifyInstance, FastifyRequest } from "fastify";
import { writeLog, type LogLevel } from "./log.js";

export const REQUEST_ID_HEADER = "x-request-id";

export function fastifyRequestIdOptions() {
  return {
    requestIdHeader: REQUEST_ID_HEADER,
    genReqId() {
      return crypto.randomUUID();
    },
  };
}

export function requestPath(request: FastifyRequest): string {
  const route = request.routeOptions?.url;
  if (typeof route === "string" && route.length > 0) {
    return route;
  }
  const raw = request.url ?? "";
  const query = raw.indexOf("?");
  return query === -1 ? raw : raw.slice(0, query);
}

/** Writes the line of a request that failed with `status`, at `level`, with its request id and path. */
export function logHttpError(level: LogLevel, error: unknown, request: FastifyRequest, status: number): void {
  const message = error instanceof Error ? error.message : "internal error";
  writeLog(
    level,
    message,
    {
      source: "backend",
      operation: "http.request",
      request_id: String(request.id).slice(0, 128),
      method: request.method,
      path: requestPath(request),
      status,
      error_type: error instanceof Error ? error.name : "Error",
    },
    error,
  );
}

export function registerHttpObservability(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Request-Id", request.id);
    reply.header("X-Frame-Options", "SAMEORIGIN");
  });
}
