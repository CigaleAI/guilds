import type { FastifyInstance } from "fastify";
import { HttpError } from "./errors.js";

// Which web pages may drive this server (SEC-15). Nothing here signs anyone in: it keeps a page
// the operator has open in the same browser from reaching the API behind their back, by a
// hostname rebound to this server's address or by a cross-site request.

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** The hostname of a `Host` header or a URL's host, lowercase and without its port. */
function hostnameOf(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? value : value.slice(0, end + 1);
  }
  const colon = value.lastIndexOf(":");
  return colon === -1 ? value : value.slice(0, colon);
}

function urlOf(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export type RequestOrigins = {
  /** A request is served only when its `Host` is a loopback name or the host of `PUBLIC_BASE_URL`. */
  hostAllowed(host: string | undefined): boolean;
  /**
   * A page may change state, or open a WebSocket, when it is served from the host the request
   * names, from `PUBLIC_BASE_URL`'s origin, or from a loopback origin to a loopback host (a
   * development server proxying to this one).
   */
  originAllowed(origin: string, host: string | undefined): boolean;
};

export function requestOrigins(publicBaseUrl: string): RequestOrigins {
  const publicUrl = publicBaseUrl ? urlOf(publicBaseUrl) : null;
  const publicHostname = publicUrl ? publicUrl.hostname.toLowerCase() : null;
  return {
    hostAllowed(host) {
      if (!host) {
        return false;
      }
      const hostname = hostnameOf(host);
      return LOOPBACK.has(hostname) || hostname === publicHostname;
    },
    originAllowed(origin, host) {
      const url = urlOf(origin);
      if (!url || !host) {
        return false;
      }
      if (publicUrl && url.origin === publicUrl.origin) {
        return true;
      }
      if (url.host.toLowerCase() === host.trim().toLowerCase()) {
        return true;
      }
      return LOOPBACK.has(url.hostname.toLowerCase()) && LOOPBACK.has(hostnameOf(host));
    },
  };
}

/** Refuses a request that names another host, and a state change or WebSocket from another origin. */
export function registerRequestOrigin(app: FastifyInstance, publicBaseUrl: string): void {
  const origins = requestOrigins(publicBaseUrl);
  app.addHook("onRequest", async (request) => {
    if ((request.url.split("?")[0] ?? "") === "/health") {
      return;
    }
    const host = request.headers.host;
    if (!origins.hostAllowed(host)) {
      throw new HttpError(
        403,
        "host not allowed: reach this server by a loopback address or the host of PUBLIC_BASE_URL",
      );
    }
    const origin = request.headers.origin;
    if (origin === undefined) {
      return;
    }
    const websocket = String(request.headers.upgrade ?? "").toLowerCase() === "websocket";
    if ((websocket || STATE_CHANGING.has(request.method.toUpperCase())) && !origins.originAllowed(origin, host)) {
      throw new HttpError(403, "origin not allowed");
    }
  });
}
