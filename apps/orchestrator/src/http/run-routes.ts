import type { FastifyInstance } from "fastify";
import { requireVisibleAgent, requireVisibleRun } from "../agents/access.js";
import {
  generationLoopOf,
  listRunMessages,
  postRunMessage,
  startRun,
  validateAttachmentIds,
  type RunOperatorServices,
} from "../generation/operator.js";
import type { AppDeps } from "./deps.js";
import { missingBodyFields } from "./errors.js";
import { currentUser } from "./identity.js";
import { identityDatabase } from "../users/identity.js";
import { bodyOf, param } from "./request.js";
import { pipeSse } from "./sse.js";

/** An agent's runs: opened, read, talked to, resumed, cancelled, and streamed. */
export async function registerRunRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const identityDb = identityDatabase(db);
  const services: RunOperatorServices = {
    db,
    loop: deps.generation ?? null,
    attachments: deps.attachments ?? null,
  };
  const loop = () => generationLoopOf(services);

  app.get("/api/agents/:agent_id/runs", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const agent = await requireVisibleAgent(db, param(request, "agent_id"), user.id);
    return loop().listRunViews(agent.id);
  });

  app.post("/api/agents/:agent_id/runs", async (request, reply) => {
    const user = await currentUser(identityDb, request, deps);
    const agent = await requireVisibleAgent(db, param(request, "agent_id"), user.id);
    const body = bodyOf(request);
    const start = {
      message: body.message,
      attachmentIds: validateAttachmentIds(body.attachment_ids),
    };
    const { run, withMessage } = await startRun(services, agent, user.id, start);
    return reply.code(withMessage ? 202 : 201).send(run);
  });

  app.get("/api/runs/:run_id", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    return loop().runView(
      await requireVisibleRun(db, param(request, "run_id"), user.id),
    );
  });

  app.get("/api/runs/:run_id/messages", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    return listRunMessages(
      db,
      await requireVisibleRun(db, param(request, "run_id"), user.id),
    );
  });

  app.post("/api/runs/:run_id/resume", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const run = await requireVisibleRun(db, param(request, "run_id"), user.id);
    return loop().resumeRun(run.id);
  });

  app.post("/api/runs/:run_id/messages", async (request, reply) => {
    const user = await currentUser(identityDb, request, deps);
    const run = await requireVisibleRun(db, param(request, "run_id"), user.id);
    const body = bodyOf(request);
    const attachmentIds = validateAttachmentIds(body.attachment_ids);
    if (!attachmentIds.length) {
      const missing = missingBodyFields(request.body, ["content"]);
      if (missing) {
        throw missing;
      }
    }
    return reply
      .code(202)
      .send(await postRunMessage(services, run, { content: body.content, attachmentIds }));
  });

  app.post("/api/runs/:run_id/cancel", async (request, reply) => {
    const user = await currentUser(identityDb, request, deps);
    const run = await requireVisibleRun(db, param(request, "run_id"), user.id);
    const cancelled = await loop().cancel(run.id);
    return cancelled === null ? reply.code(204).send() : reply.code(202).send(cancelled);
  });

  app.get("/api/runs/:run_id/stream", async (request, reply) => {
    const user = await currentUser(identityDb, request, deps);
    const run = await requireVisibleRun(db, param(request, "run_id"), user.id);
    const generation = loop();
    await pipeSse(
      request,
      reply,
      () => generation.events.subscribe(run.id),
      (queue) => generation.events.unsubscribe(run.id, queue),
    );
  });
}
