import { Type } from "@sinclair/typebox";
import { requireVisibleAgent, requireVisibleRun } from "../agents/access.js";
import {
  generationLoopOf,
  listRunMessages,
  postRunMessage,
  startRun,
  validateAttachmentIds,
  type RunOperatorServices,
} from "../generation/operator.js";
import type { AppDeps, RouteApp } from "./deps.js";
import { currentUser } from "./identity.js";
import { AgentParams } from "./params.js";
import { pipeSse } from "./sse.js";

/** The images a message carries, by attachment id; null is none. */
const AttachmentIdsField = Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()]));

/** A new run: the operator's first message, its images, or neither. */
const RunStartSchema = Type.Object({
  message: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  attachment_ids: AttachmentIdsField,
});

/** The operator's message to a run: text, images, or both. */
const RunMessageSchema = Type.Object({
  content: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  attachment_ids: AttachmentIdsField,
});

/** The path of one run. */
const RunParams = Type.Object({ run_id: Type.String() });

/** An agent's runs: opened, read, talked to, resumed, cancelled, and streamed. */
export async function registerRunRoutes(app: RouteApp, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const services: RunOperatorServices = {
    db,
    loop: deps.generation ?? null,
    attachments: deps.attachments ?? null,
  };
  const loop = () => generationLoopOf(services);

  app.get("/api/agents/:agent_id/runs", { schema: { params: AgentParams } }, async (request) => {
    const user = await currentUser(db, request, deps);
    const agent = await requireVisibleAgent(db, request.params.agent_id, user.id);
    return loop().listRunViews(agent.id);
  });

  app.post(
    "/api/agents/:agent_id/runs",
    { schema: { params: AgentParams, body: RunStartSchema } },
    async (request, reply) => {
      const user = await currentUser(db, request, deps);
      const agent = await requireVisibleAgent(db, request.params.agent_id, user.id);
      const start = {
        message: request.body.message,
        attachmentIds: validateAttachmentIds(request.body.attachment_ids),
      };
      const { run, withMessage } = await startRun(services, agent, user.id, start);
      return reply.code(withMessage ? 202 : 201).send(run);
    },
  );

  app.get("/api/runs/:run_id", { schema: { params: RunParams } }, async (request) => {
    const user = await currentUser(db, request, deps);
    return loop().runView(await requireVisibleRun(db, request.params.run_id, user.id));
  });

  app.get("/api/runs/:run_id/messages", { schema: { params: RunParams } }, async (request) => {
    const user = await currentUser(db, request, deps);
    return listRunMessages(db, await requireVisibleRun(db, request.params.run_id, user.id));
  });

  app.post("/api/runs/:run_id/resume", { schema: { params: RunParams } }, async (request) => {
    const user = await currentUser(db, request, deps);
    const run = await requireVisibleRun(db, request.params.run_id, user.id);
    return loop().resumeRun(run.id);
  });

  app.post(
    "/api/runs/:run_id/messages",
    { schema: { params: RunParams, body: RunMessageSchema } },
    async (request, reply) => {
      const user = await currentUser(db, request, deps);
      const run = await requireVisibleRun(db, request.params.run_id, user.id);
      const message = {
        content: request.body.content,
        attachmentIds: validateAttachmentIds(request.body.attachment_ids),
      };
      return reply.code(202).send(await postRunMessage(services, run, message));
    },
  );

  app.post(
    "/api/runs/:run_id/cancel",
    { schema: { params: RunParams } },
    async (request, reply) => {
      const user = await currentUser(db, request, deps);
      const run = await requireVisibleRun(db, request.params.run_id, user.id);
      const cancelled = await loop().cancel(run.id);
      return cancelled === null ? reply.code(204).send() : reply.code(202).send(cancelled);
    },
  );

  app.get("/api/runs/:run_id/stream", { schema: { params: RunParams } }, async (request, reply) => {
    const user = await currentUser(db, request, deps);
    const run = await requireVisibleRun(db, request.params.run_id, user.id);
    const generation = loop();
    await pipeSse(
      request,
      reply,
      () => generation.events.subscribe(run.id),
      (queue) => generation.events.unsubscribe(run.id, queue),
    );
  });
}
