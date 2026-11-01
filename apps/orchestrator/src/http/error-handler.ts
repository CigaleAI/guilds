import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { logHttpError, requestPath } from "../observability/http.js";
import { writeLog, type LogLevel } from "../observability/log.js";
import { HttpError, domainHttp, isDomainError } from "./errors.js";

/** An error that names the status it answers, as Fastify's own errors and its plugins' do. */
type StatusCodeError = Error & Required<Pick<FastifyError, "statusCode">>;

function hasStatusCode(error: Error): error is StatusCodeError {
  return "statusCode" in error && typeof error.statusCode === "number";
}

/** The HTTP answer an error names: itself, the `HttpError` it wraps, or a domain error's. */
function httpErrorOf(error: Error): HttpError | null {
  if (error instanceof HttpError) {
    return error;
  }
  if (error.cause instanceof HttpError) {
    return error.cause;
  }
  return isDomainError(error) ? domainHttp(error) : null;
}

/** The status a thrown error answers: its HTTP answer's, the one it carries, or 500. */
function statusOf(error: Error | null, http: HttpError | null): number {
  if (http) {
    return http.status;
  }
  if (error && hasStatusCode(error)) {
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
  // Fastify hands the handler whatever was thrown; a value that is not an Error answers 500.
  app.setErrorHandler((error, request: FastifyRequest, reply: FastifyReply) => {
    try {
      const thrown = error instanceof Error ? error : null;
      const http = thrown ? httpErrorOf(thrown) : null;
      const status = statusOf(thrown, http);
      const level = httpLogLevel(status, http);
      if (level) {
        logHttpError(level, error, request, status);
      }
      reply.header("X-Request-Id", request.id);
      if (http) {
        reply.code(http.status).send({ detail: http.detail });
        return;
      }
      const message = thrown ? thrown.message : "internal error";
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
