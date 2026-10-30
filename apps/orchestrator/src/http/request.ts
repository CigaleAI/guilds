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

/** The request's query string as text values; a missing or empty value is left out. */
export function queryOf(request: FastifyRequest): Record<string, string> {
  const query = request.query;
  if (query && typeof query === "object" && !Array.isArray(query)) {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) {
        continue;
      }
      out[key] = String(value);
    }
    return out;
  }
  return {};
}

/** The path with its percent-encoding decoded, or null when that encoding is malformed. */
function decodedPath(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** The file path a wildcard route names, decoded; a path that climbs out with `..` is a 404. */
export function filePathParam(request: FastifyRequest): string {
  const raw = (request.raw.url ?? request.url).split("?")[0] ?? "";
  const pathname = decodedPath(raw) ?? raw;
  if (pathname.split("/").includes("..")) {
    throw new HttpError(404, "Not Found");
  }
  const params = request.params;
  const named = (key: string) =>
    params && typeof params === "object" && key in params ? Reflect.get(params, key) : undefined;
  const fromParams = named("*") ?? named("file_path");
  if (typeof fromParams === "string" && fromParams) {
    return fromParams;
  }
  const marker = "/notes/";
  const index = pathname.lastIndexOf(marker);
  if (index >= 0) {
    return pathname.slice(index + marker.length);
  }
  return "";
}
