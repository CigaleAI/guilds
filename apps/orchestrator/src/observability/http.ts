import type { FastifyInstance, FastifyRequest } from "fastify";
import { writeLog, type LogLevel } from "./log.js";

export const REQUEST_ID_HEADER = "x-request-id";

export function fastifyRequestIdOptions() {
  return {
    requestIdHeader: REQUEST_ID_HEADER,
    genReqId(): string {
      return crypto.randomUUID();
    },
  };
}

export function requestPath(request: FastifyRequest): string {
  const route = request.routeOptions?.url;
  if (route) {
    return route;
  }
  const raw = request.url ?? "";
  const query = raw.indexOf("?");
  return query === -1 ? raw : raw.slice(0, query);
}

/**
 * Writes the line of a request that failed with `status`, at `level`, with its request id and path.
 * `cause` is the value thrown: the line reports it, its type and its stack or text.
 */
export function logHttpError(level: LogLevel, cause: unknown, request: FastifyRequest, status: number): void {
  const message = cause instanceof Error ? cause.message : "internal error";
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
    },
    cause,
  );
}

export function registerHttpObservability(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Request-Id", request.id);
    reply.header("X-Frame-Options", "SAMEORIGIN");
  });
}
