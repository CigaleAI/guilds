import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { HttpError, domainHttp } from "../http/errors.js";
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

function unwrapHttpError(error: unknown): HttpError | null {
  if (error instanceof HttpError) {
    return error;
  }
  if (error && typeof error === "object" && "cause" in error && error.cause instanceof HttpError) {
    return error.cause;
  }
  return domainHttp(error);
}

function statusOf(error: unknown, http: HttpError | null): number {
  if (http) {
    return http.status;
  }
  if (error && typeof error === "object" && typeof (error as { statusCode?: unknown }).statusCode === "number") {
    return (error as { statusCode: number }).statusCode;
  }
  return 500;
}

function httpLogLevel(status: number, http: HttpError | null): LogLevel | null {
  if (status >= 500) {
    return "error";
  }
  if (http) {
    return null;
  }
  if (status >= 400) {
    return "warn";
  }
  return null;
}

export function logHttpError(error: unknown, request: FastifyRequest, status: number, http: HttpError | null): void {
  const level = httpLogLevel(status, http);
  if (!level) {
    return;
  }
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
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    try {
      const http = unwrapHttpError(error);
      const status = http ? http.status : statusOf(error, http);
      logHttpError(error, request, status, http);
      reply.header("X-Request-Id", request.id);
      if (http) {
        reply.code(http.status).send({ detail: http.detail });
        return;
      }
      const message = error instanceof Error ? error.message : "internal error";
      reply.code(status).send({ detail: message });
    } catch (failed) {
      writeLog(
        "error",
        failed instanceof Error ? failed.message : String(failed),
        {
          source: "backend",
          operation: "http.error_handler",
          request_id: String(request.id).slice(0, 128),
          method: request.method,
          path: requestPath(request),
          status: 500,
        },
        failed,
      );
      if (!reply.sent) {
        reply.code(500).send({ detail: "internal error" });
      }
    }
  });
}
