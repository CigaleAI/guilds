import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BuilderError } from "../builder/errors.js";
import type { BuilderService } from "../builder/index.js";
import { PolicyError } from "../policy/index.js";
import { RecipeConflictError, RecipeError } from "../recipes/errors.js";
import type { AppDeps } from "./deps.js";
import { HttpError, recipeConflictHttp } from "./errors.js";
import { currentOrg, currentUser } from "./identity.js";
import { identityDatabase } from "../users/identity.js";
import { frameSse, SSE_HEADERS } from "./sse.js";
import { bodyOf, param } from "./request.js";
import { parseReviewAction } from "../recipes/review.js";


function builderOf(deps: AppDeps): BuilderService {
  if (!deps.builder) {
    throw new HttpError(422, "builder is not available");
  }
  return deps.builder;
}

function mapError(error: unknown): never {
  if (error instanceof RecipeConflictError) {
    throw recipeConflictHttp(error);
  }
  if (
    error instanceof BuilderError ||
    error instanceof RecipeError ||
    error instanceof PolicyError
  ) {
    throw new HttpError(error.status, error.message);
  }
  throw error;
}

export async function registerBuilderSessionRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const identityDb = identityDatabase(db);

  app.get("/api/builder/sessions", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    return builderOf(deps).listSessions(String(org.id), user.id);
  });

  app.post("/api/builder/sessions", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    const body = bodyOf(request);
    try {
      return await builderOf(deps).createSession({
        user,
        org,
        model: String(body.model ?? ""),
        ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
      });
    } catch (error) {
      mapError(error);
    }
  });

  app.get("/api/builder/sessions/:session_id", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      const builder = builderOf(deps);
      const session = await builder.getOwnedSession(param(request, "session_id"), user, org);
      const recipe = await builder.recipeFor(session);
      return builder.viewSession(session, recipe);
    } catch (error) {
      mapError(error);
    }
  });

  app.get("/api/builder/sessions/:session_id/messages", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      const builder = builderOf(deps);
      const session = await builder.getOwnedSession(param(request, "session_id"), user, org);
      return builder.messages(session);
    } catch (error) {
      mapError(error);
    }
  });

  app.post("/api/builder/sessions/:session_id/messages", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      const builder = builderOf(deps);
      const session = await builder.getOwnedSession(param(request, "session_id"), user, org);
      return await builder.postMessage(session, user, String(bodyOf(request).content ?? ""));
    } catch (error) {
      mapError(error);
    }
  });

  app.post("/api/builder/sessions/:session_id/cancel", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      const builder = builderOf(deps);
      const session = await builder.getOwnedSession(param(request, "session_id"), user, org);
      return await builder.cancel(session);
    } catch (error) {
      mapError(error);
    }
  });

  app.put("/api/builder/sessions/:session_id/recipe", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    const body = bodyOf(request);
    try {
      const builder = builderOf(deps);
      const session = await builder.getOwnedSession(param(request, "session_id"), user, org);
      return await builder.writeRecipe(session, Number(body.expected_body_version), body.recipe);
    } catch (error) {
      mapError(error);
    }
  });

  app.post("/api/builder/sessions/:session_id/access", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    const body = bodyOf(request);
    try {
      const builder = builderOf(deps);
      const session = await builder.getOwnedSession(param(request, "session_id"), user, org);
      return await builder.editAccess(session, body);
    } catch (error) {
      mapError(error);
    }
  });

  app.post("/api/builder/sessions/:session_id/review", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    const body = bodyOf(request);
    try {
      const builder = builderOf(deps);
      const session = await builder.getOwnedSession(param(request, "session_id"), user, org);
      return await builder.reviewField(session, String(body.path ?? ""), parseReviewAction(body));
    } catch (error) {
      mapError(error);
    }
  });

  app.post("/api/builder/sessions/:session_id/validate", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      const builder = builderOf(deps);
      const session = await builder.getOwnedSession(param(request, "session_id"), user, org);
      return await builder.validate(session);
    } catch (error) {
      mapError(error);
    }
  });

  app.post("/api/builder/sessions/:session_id/publish", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      const builder = builderOf(deps);
      const session = await builder.getOwnedSession(param(request, "session_id"), user, org);
      return await builder.publish(session);
    } catch (error) {
      mapError(error);
    }
  });

  app.post("/api/builder/sessions/:session_id/deploy", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      const builder = builderOf(deps);
      const session = await builder.getOwnedSession(param(request, "session_id"), user, org);
      return await builder.deploy(session, org, user, bodyOf(request));
    } catch (error) {
      mapError(error);
    }
  });

  app.get("/api/builder/sessions/:session_id/stream", async (request, reply) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    const builder = builderOf(deps);
    try {
      const session = await builder.getOwnedSession(param(request, "session_id"), user, org);
      await pipeBuilderSse(request, reply, builder, String(session.id));
    } catch (error) {
      mapError(error);
    }
  });
}

async function pipeBuilderSse(
  request: FastifyRequest,
  reply: FastifyReply,
  builder: BuilderService,
  sessionId: string,
): Promise<void> {
  const queue = builder.subscribe(sessionId);
  reply.hijack();
  reply.raw.writeHead(200, SSE_HEADERS);
  reply.raw.write(": connected\n\n");
  const abort = new AbortController();
  const onClose = () => abort.abort();
  request.raw.on("close", onClose);
  const heartbeat = setInterval(() => {
    try {
      reply.raw.write(": keepalive\n\n");
    } catch {
      abort.abort();
    }
  }, 15_000);
  try {
    while (!abort.signal.aborted) {
      const [event, data] = await queue.get(abort.signal);
      try {
        reply.raw.write(frameSse(event, data));
      } catch {
        /* skip a bad frame; keep the stream open */
      }
    }
  } catch {
    /* disconnected */
  } finally {
    clearInterval(heartbeat);
    request.raw.off("close", onClose);
    builder.unsubscribe(sessionId, queue);
  }
}
