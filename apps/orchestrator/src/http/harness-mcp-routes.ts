import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type } from "typebox";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { HarnessMcpRefused } from "../generation/errors.js";
import { HarnessMcpMessage, type HarnessMcpServer } from "../generation/harness-mcp.js";
import { logHttpError } from "../observability/http.js";
import { AgentParams } from "./params.js";

// The listener a subscription agent's harness reaches the orchestrator's MCP server on, apart from
// the API: `/mcp/{agentId}` and a liveness check. Its answers name no more than their status.

/** What the listener answers an error of each status with: its status's name and nothing else. */
const STATUS_TEXT = new Map([
  [400, "bad request"],
  [401, "unauthorized"],
  [404, "not found"],
  [405, "method not allowed"],
  [413, "request too large"],
  [415, "unsupported media type"],
]);

/** The status a thrown error answers on the listener: 401 for a request that holds no grant, a client error's own, else 500. */
function listenerStatus(error: FastifyError): number {
  if (error instanceof HarnessMcpRefused) {
    return 401;
  }
  const status = error.statusCode ?? 500;
  return status >= 400 && status < 500 ? status : 500;
}

/** Answers every error on the listener with its status alone; a request with no grant is told to send its bearer. */
function registerHarnessMcpErrors(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const status = listenerStatus(error);
    if (status >= 500) {
      logHttpError("error", error, request, status);
    }
    if (status === 401) {
      reply.header("WWW-Authenticate", "Bearer");
    }
    reply.code(status).send({ error: STATUS_TEXT.get(status) ?? "internal error" });
  });
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: STATUS_TEXT.get(404) });
  });
}

/**
 * The routes of the orchestrator's MCP server: a JSON-RPC message posted to an agent's path is
 * answered with JSON, a notification with 202; the transport's stream and session ending are not
 * served. `/health` says only that the listener is up.
 */
export function registerHarnessMcpRoutes(app: FastifyInstance, server: HarnessMcpServer): void {
  const typed = app.withTypeProvider<TypeBoxTypeProvider>();
  registerHarnessMcpErrors(app);
  typed.get("/health", { schema: { response: { 200: Type.Object({ status: Type.Literal("ok") }) } } }, async () => ({
    status: "ok" as const,
  }));
  typed.post("/mcp/:agent_id", { schema: { params: AgentParams, body: HarnessMcpMessage } }, async (request, reply) => {
    const answer = await server.answer(request.params.agent_id, request.headers.authorization, request.body);
    return answer === null ? reply.code(202).send() : reply.send(answer);
  });
  for (const method of ["GET", "DELETE"] as const) {
    typed.route({
      method,
      url: "/mcp/:agent_id",
      handler: async (_request, reply) => reply.code(405).header("Allow", "POST").send({ error: STATUS_TEXT.get(405) }),
    });
  }
}
