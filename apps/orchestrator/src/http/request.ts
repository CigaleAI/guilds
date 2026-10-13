import type { FastifyRequest } from "fastify";
import { HttpError } from "./errors.js";

/** The request's JSON object body; anything else reads as an empty object. */
export function bodyOf(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** A route parameter; a missing one is a 404. */
export function param(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, string | undefined>)[name];
  if (typeof value !== "string") {
    throw new HttpError(404, "Not Found");
  }
  return value;
}
