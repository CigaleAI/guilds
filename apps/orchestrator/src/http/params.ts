import { Type } from "@sinclair/typebox";
import type { FastifyRequest } from "fastify";
import { HttpError } from "./errors.js";

/** The path of a route under one guild. */
export const GuildParams = Type.Object({ guild_id: Type.String() });

/** The path of a route under one agent. */
export const AgentParams = Type.Object({ agent_id: Type.String() });

/** The path of a route under one organisation. */
export const OrgParams = Type.Object({ org_id: Type.String() });

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
