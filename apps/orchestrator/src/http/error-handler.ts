import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { logHttpError, requestPath } from "../observability/http.js";
import { writeLog, type LogLevel } from "../observability/log.js";
import { HttpError, domainHttp } from "./errors.js";

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
  if (error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number") {
    return error.statusCode;
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

/**
 * Answers every thrown error: an `HttpError` or a domain error with its status and detail, any
 * other error with its own status or 500. A 5xx is logged at error, and a 4xx no domain error
 * maps at warn.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    try {
      const http = unwrapHttpError(error);
      const status = http ? http.status : statusOf(error, http);
      const level = httpLogLevel(status, http);
      if (level) {
        logHttpError(level, error, request, status);
      }
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
