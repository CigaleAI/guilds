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
  extensionModelCredentials,
  extensionOrgCreated,
  extensionPolicy,
  extensionWebApp,
  type ServerExtension,
} from "./extension.js";
import type { AppDeps } from "./http/deps.js";
import { registerRequestOrigin } from "./http/origin.js";
import { registerDomainRoutes } from "./http/routes.js";
import { sandboxSubprotocol } from "./http/sandbox-proxy.js";
import { registerWebApp } from "./http/web-app.js";
import { installIntegrations } from "./instance/integrations.js";
import { InstanceKeys } from "./instance/keys.js";
import { repoRoot } from "./lib/paths.js";
import { coreModelCredentials, modelProviderStore } from "./llm/credentials.js";
import { modelsDatabase, ModelsService } from "./llm/models.js";
import { registerClientErrorRoute } from "./observability/client-errors.js";
import { fastifyRequestIdOptions, registerHttpObservability } from "./observability/http.js";

export type { AppDeps } from "./http/deps.js";

/** Core's build of the React app, served at the site root unless an extension serves its own. */
const WEB_DIST = path.join(repoRoot(import.meta.url), "apps", "web", "dist");

/**
 * Builds the HTTP server and returns it. The caller listens, and owns the database and the
 * generation loop. With no `deps` only the shell is mounted (the operator app, `/health`, and
 * avatars); tests use that form.
 */
export async function buildApp(
  database: Database,
  deps?: Omit<AppDeps, "database">,
  extensions: ServerExtension[] = [],
): Promise<FastifyInstance> {
  const app = Fastify({
    // The process logs through registerHttpObservability. Fastify's own logger stays off.
    logger: false,
    // Close sockets still held open, so shutdown finishes while a stream or a pane is connected.
    forceCloseConnections: true,
    // 4 KiB above the 10 MiB file cap, so a slightly oversize upload reaches the route's own check.
    bodyLimit: 10 * 1024 * 1024 + 4096,
    // Keep an incoming X-Request-Id, or mint one. The response echoes it.
    ...fastifyRequestIdOptions(),
  }).withTypeProvider<TypeBoxTypeProvider>();
  registerHttpObservability(app);
  // File and image uploads are raw bytes. This parser accepts those types and keeps the body
  // as a buffer.
  app.addContentTypeParser(
    ["application/octet-stream", "image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"],
    { parseAs: "buffer" },
    (_request, body, done) => {
      done(null, body);
    },
  );
  // An upload with no Content-Type would miss the parser above. Treat its body as raw bytes.
  app.addHook("preParsing", async (request) => {
    if (
      !request.headers["content-type"] &&
      (request.method === "POST" || request.method === "PUT" || request.method === "PATCH")
    ) {
      request.headers["content-type"] = "application/octet-stream";
    }
  });
  // Browser and terminal panes open a socket through to the sandbox, on the subprotocols its
  // daemons speak.
  await app.register(fastifyWebsocket, {
    options: {
      handleProtocols: sandboxSubprotocol,
    },
  });
  // After the WebSocket plugin, so a handshake this refuses is one the plugin closes; before
  // every route, so none is reached past it.
  registerRequestOrigin(app, deps?.config?.publicBaseUrl ?? "");
  // The browser posts its own errors here. The route sits on the shell, beside the app it serves.
  registerClientErrorRoute(app);
  // An extension's build takes the place of core's.
  await registerWebApp(app, extensionWebApp(extensions) ?? WEB_DIST);
  // The probe pings PostgreSQL, so a database that is down fails the check.
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
  // Avatars are image URLs. A seed or color the validator rejects keeps the default, so the
  // image still loads. The URL decides the picture, so the response caches for a year.
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
      // A color query may omit the leading '#'. The validator requires it.
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
    // Fill what the caller left out. An extension's value replaces core's where the extension
    // offers one.
    const artifacts = deps.artifacts ?? new ArtifactStore(database.pool, deps.notes.templates);
    // Tests call buildApp on its own, so an extension's integrations are installed here too.
    installIntegrations(extensions.flatMap((extension) => extension.integrations ?? []));
    const policy = deps.policy ?? extensionPolicy(extensions, deps);
    const identity = deps.identity ?? extensionIdentity(extensions, deps);
    const instanceAdmin = deps.instanceAdmin ?? extensionInstanceAdmin(extensions, deps);
    const modelCredentials =
      deps.modelCredentials ??
      extensionModelCredentials(extensions, deps) ??
      coreModelCredentials(modelProviderStore(deps.db), deps.masterKey);
    const models =
      deps.models ??
      new ModelsService({
        db: modelsDatabase(deps.db),
        credentials: modelCredentials,
        masterKey: deps.masterKey,
      });
    const instanceKeys = deps.instanceKeys ?? new InstanceKeys(database.pool, deps.masterKey);
    const orgCreated = deps.orgCreated ?? extensionOrgCreated(extensions);
    const full = {
      database,
      ...deps,
      artifacts,
      instanceKeys,
      modelCredentials,
      models,
      // An absent field is core's own rule: the open policy, core's sign-in modes, core's
      // instance admin.
      ...(policy ? { policy } : {}),
      ...(identity ? { identity } : {}),
      ...(instanceAdmin ? { instanceAdmin } : {}),
      ...(orgCreated ? { orgCreated } : {}),
    };
    // An extension's routes and hooks land first, so they are in place for the routes
    // registered next.
    for (const extension of extensions) {
      await extension.routes?.(app, full);
    }
    await registerDomainRoutes(app, full);
  }
  return app;
}
