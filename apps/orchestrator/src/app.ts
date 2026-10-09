import path from "node:path";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { Type } from "@sinclair/typebox";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import fastifyWebsocket from "@fastify/websocket";
import {
  DEFAULT_AVATAR_COLOR,
  DEFAULT_AVATAR_SHAPE,
  validateAvatarColor,
  validateAvatarShape,
} from "./agents/validation.js";
import { ArtifactStore } from "./artifacts/index.js";
import { renderAvatarSvg } from "./avatars/index.js";
import type { Database } from "./db/client.js";
import {
  extensionIdentity,
  extensionInstanceAdmin,
  extensionPolicy,
  extensionWebApp,
  type ServerExtension,
} from "./extension.js";
import type { AppDeps } from "./http/deps.js";
import { registerRequestOrigin } from "./http/origin.js";
import { registerDomainRoutes } from "./http/routes.js";
import { sandboxSubprotocol } from "./http/sandbox-proxy.js";
import { registerWebApp } from "./http/web-app.js";
import { CORE_INTEGRATIONS } from "./instance/integrations.js";
import { repoRoot } from "./lib/paths.js";
import { registerClientErrorRoute } from "./observability/client-errors.js";
import { fastifyRequestIdOptions, registerHttpObservability } from "./observability/http.js";

export type { AppDeps } from "./http/deps.js";

/** Core's build of the React app, served at the site root unless an edition serves its own. */
const WEB_DIST = path.join(repoRoot(import.meta.url), "apps", "web", "dist");

export async function buildApp(
  database: Database,
  deps?: Omit<AppDeps, "database">,
  extensions: ServerExtension[] = [],
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    forceCloseConnections: true,
    bodyLimit: 10 * 1024 * 1024 + 4096,
    ...fastifyRequestIdOptions(),
  }).withTypeProvider<TypeBoxTypeProvider>();
  registerHttpObservability(app);
  app.addContentTypeParser(
    [
      "application/octet-stream",
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/gif",
      "image/webp",
    ],
    { parseAs: "buffer" },
    (_request, body, done) => {
      done(null, body);
    },
  );
  app.addHook("preParsing", async (request) => {
    if (
      !request.headers["content-type"] &&
      (request.method === "POST" || request.method === "PUT" || request.method === "PATCH")
    ) {
      request.headers["content-type"] = "application/octet-stream";
    }
  });
  await app.register(fastifyWebsocket, {
    options: {
      handleProtocols: sandboxSubprotocol,
    },
  });
  // After the WebSocket plugin, so a handshake this refuses is one the plugin closes; before
  // every route, so none is reached past it.
  registerRequestOrigin(app, deps?.config?.publicBaseUrl ?? "");
  registerClientErrorRoute(app);
  await registerWebApp(app, extensionWebApp(extensions) ?? WEB_DIST);
  app.get(
    "/health",
    {
      schema: {
        response: {
          200: Type.Object({ status: Type.Literal("ok") }),
        },
      },
    },
    async () => {
      await database.ping();
      return { status: "ok" as const };
    },
  );
  app.get(
    "/avatars/:style.svg",
    {
      schema: {
        params: Type.Object({
          style: Type.String(),
        }),
        querystring: Type.Object({
          seed: Type.Optional(Type.String()),
          color: Type.Optional(Type.String()),
        }),
      },
    },
    async (request, reply) => {
      const { style } = request.params;
      const query = request.query;
      let seed = DEFAULT_AVATAR_SHAPE;
      try {
        seed = validateAvatarShape(query.seed);
      } catch {
        /* keep default */
      }
      const rawColor = (query.color ?? "").trim();
      let color = DEFAULT_AVATAR_COLOR;
      try {
        color = validateAvatarColor(
          rawColor.startsWith("#") || rawColor === "" ? rawColor : `#${rawColor}`,
        );
      } catch {
        /* keep default */
      }
      return reply
        .type("image/svg+xml; charset=utf-8")
        .header("Cache-Control", "public, max-age=31536000, immutable")
        .send(renderAvatarSvg(style, seed, color));
    },
  );
  if (deps) {
    const artifacts = deps.artifacts ?? new ArtifactStore(database.pool, deps.notes.templates);
    const integrations = [
      ...CORE_INTEGRATIONS,
      ...extensions.flatMap((extension) => extension.integrations ?? []),
    ];
    const policy = deps.policy ?? extensionPolicy(extensions, deps);
    const identity = deps.identity ?? extensionIdentity(extensions, deps);
    const instanceAdmin = deps.instanceAdmin ?? extensionInstanceAdmin(extensions, deps);
    const full = {
      database,
      ...deps,
      artifacts,
      integrations,
      ...(policy ? { policy } : {}),
      ...(identity ? { identity } : {}),
      ...(instanceAdmin ? { instanceAdmin } : {}),
    };
    for (const extension of extensions) {
      await extension.routes?.(app, full);
    }
    await registerDomainRoutes(app, full);
  }
  return app;
}
