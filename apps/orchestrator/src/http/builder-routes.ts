import { Type } from "@sinclair/typebox";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { BuilderService } from "../builder/index.js";
import type { AppDeps, RouteApp } from "./deps.js";
import { HttpError } from "./errors.js";
import { currentOrg, currentUser } from "./identity.js";
import { frameSse, SSE_HEADERS } from "./sse.js";
import { ApplyChoicesSchema } from "../recipes/apply.js";
import { parseReviewAction, ReviewSchema } from "../recipes/review.js";

/** A new Builder session: the coach's model and, optionally, its temperature. */
const BuilderSessionSchema = Type.Object({
  model: Type.Optional(Type.String()),
  temperature: Type.Optional(Type.Number()),
});

/** The path of one Builder session. */
const SessionParams = Type.Object({ session_id: Type.String() });

/** The operator's message to the coach. */
const BuilderMessageSchema = Type.Object({ content: Type.Optional(Type.String()) });

/** The session's recipe as the operator writes it, over the version they read; the recipe's own rules check it. */
const RecipeWriteSchema = Type.Object({
  expected_body_version: Type.Number(),
  recipe: Type.Unknown(),
});

/** The access edits to apply to the session's recipe, which the recipe's own rules check. */
const AccessEditsSchema = Type.Object({ edits: Type.Unknown() });

function builderOf(deps: AppDeps): BuilderService {
  if (!deps.builder) {
    throw new HttpError(422, "builder is not available");
  }
  return deps.builder;
}

export async function registerBuilderSessionRoutes(app: RouteApp, deps: AppDeps): Promise<void> {
  const { db } = deps;

  app.get("/api/builder/sessions", async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    return builderOf(deps).listSessions(String(org.id), user.id);
  });

  app.post("/api/builder/sessions", { schema: { body: BuilderSessionSchema } }, async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    const { model, temperature } = request.body;
    return await builderOf(deps).createSession({
      user,
      org,
      model: model ?? "",
      ...(temperature !== undefined ? { temperature } : {}),
    });
  });

  app.get(
    "/api/builder/sessions/:session_id",
    { schema: { params: SessionParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const builder = builderOf(deps);
      const session = await builder.getOwnedSession(request.params.session_id, user, org);
      return await builder.loadSessionView(session);
    },
  );

  app.get(
    "/api/builder/sessions/:session_id/messages",
    { schema: { params: SessionParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const builder = builderOf(deps);
      const session = await builder.getOwnedSession(request.params.session_id, user, org);
      return builder.messages(session);
    },
  );

  app.post(
    "/api/builder/sessions/:session_id/messages",
    { schema: { params: SessionParams, body: BuilderMessageSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const builder = builderOf(deps);
      const session = await builder.getOwnedSession(request.params.session_id, user, org);
      return await builder.postMessage(session, user, request.body.content ?? "");
    },
  );

  app.post(
    "/api/builder/sessions/:session_id/cancel",
    { schema: { params: SessionParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const builder = builderOf(deps);
      const session = await builder.getOwnedSession(request.params.session_id, user, org);
      return await builder.cancel(session);
    },
  );

  app.put(
    "/api/builder/sessions/:session_id/recipe",
    { schema: { params: SessionParams, body: RecipeWriteSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const { expected_body_version: expected, recipe } = request.body;
      const builder = builderOf(deps);
      const session = await builder.getOwnedSession(request.params.session_id, user, org);
      return await builder.writeRecipe(session, expected, recipe);
    },
  );

  app.post(
    "/api/builder/sessions/:session_id/access",
    { schema: { params: SessionParams, body: AccessEditsSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const builder = builderOf(deps);
      const session = await builder.getOwnedSession(request.params.session_id, user, org);
      return await builder.editAccess(session, request.body);
    },
  );

  app.post(
    "/api/builder/sessions/:session_id/review",
    { schema: { params: SessionParams, body: ReviewSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const body = request.body;
      const builder = builderOf(deps);
      const session = await builder.getOwnedSession(request.params.session_id, user, org);
      return await builder.reviewField(session, body.path ?? "", parseReviewAction(body));
    },
  );

  app.post(
    "/api/builder/sessions/:session_id/validate",
    { schema: { params: SessionParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const builder = builderOf(deps);
      const session = await builder.getOwnedSession(request.params.session_id, user, org);
      return await builder.validate(session);
    },
  );

  app.post(
    "/api/builder/sessions/:session_id/publish",
    { schema: { params: SessionParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const builder = builderOf(deps);
      const session = await builder.getOwnedSession(request.params.session_id, user, org);
      return await builder.publish(session);
    },
  );

  app.post(
    "/api/builder/sessions/:session_id/deploy",
    { schema: { params: SessionParams, body: ApplyChoicesSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const builder = builderOf(deps);
      const session = await builder.getOwnedSession(request.params.session_id, user, org);
      return await builder.deploy(session, org, user, request.body);
    },
  );

  app.get(
    "/api/builder/sessions/:session_id/stream",
    { schema: { params: SessionParams } },
    async (request, reply) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const builder = builderOf(deps);
      const session = await builder.getOwnedSession(request.params.session_id, user, org);
      await pipeBuilderSse(request, reply, builder, String(session.id));
    },
  );
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
