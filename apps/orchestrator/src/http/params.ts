import { Type } from "typebox";
import { Value } from "typebox/value";
import type { FastifyRequest } from "fastify";
import { HttpError } from "./errors.js";

/** The path of a route under one guild. */
export const GuildParams = Type.Object({ guild_id: Type.String() });

/** The path of a route under one agent. */
export const AgentParams = Type.Object({ agent_id: Type.String() });

/** The path of a route under one organisation. */
export const OrgParams = Type.Object({ org_id: Type.String() });

/** The path a wildcard route matched, as Fastify names it. */
const WildcardParams = Type.Object({ "*": Type.String() });

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
  if (Value.Check(WildcardParams, params) && params["*"]) {
    return params["*"];
  }
  const marker = "/notes/";
  const index = pathname.lastIndexOf(marker);
  if (index >= 0) {
    return pathname.slice(index + marker.length);
  }
  return "";
}
