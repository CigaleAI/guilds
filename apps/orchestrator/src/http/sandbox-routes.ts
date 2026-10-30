import type { FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { requireVisibleAgent } from "../agents/access.js";
import { RunRequestError } from "../generation/index.js";
import { generationLoopOf } from "../generation/operator.js";
import type { AppDeps, RouteApp } from "./deps.js";
import { currentUser } from "./identity.js";
import { AgentParams, filePathParam } from "./params.js";
import { proxyHttp, startSandboxWsProxy } from "./sandbox-proxy.js";

/** How often operator input on a proxied sandbox view restarts its idle timer. */
const SANDBOX_TOUCH_INTERVAL_MS = 30_000;

/** The daemon an agent's sandbox view is served by: its base URL and the headers it takes. */
type SandboxTarget = (agentId: string) => Promise<[string, Record<string, string>]>;

/** An agent's browser and terminal: started on request, then proxied over HTTP and WebSocket. */
export async function registerSandboxRoutes(app: RouteApp, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const loop = () => generationLoopOf({ loop: deps.generation ?? null });

  async function visibleAgentId(request: FastifyRequest, agentId: string): Promise<string> {
    const user = await currentUser(db, request, deps);
    return (await requireVisibleAgent(db, agentId, user.id)).id;
  }

  function proxySandboxWs(
    socket: WebSocket,
    request: FastifyRequest,
    target: SandboxTarget,
    agentId: string,
  ): void {
    let touchedAt = 0;
    startSandboxWsProxy(
      socket,
      request,
      async () => {
        const [base, extraHeaders] = await target(await visibleAgentId(request, agentId));
        return { base, extraHeaders, pathPart: filePathParam(request) };
      },
      (error) => (error instanceof RunRequestError ? 1013 : 1008),
      () => {
        const now = Date.now();
        if (now - touchedAt < SANDBOX_TOUCH_INTERVAL_MS) {
          return;
        }
        touchedAt = now;
        loop().machines.touchSandbox(agentId);
      },
    );
  }

  /** Proxies `prefix` and `prefix/*`, HTTP and WebSocket, to the daemon `target` resolves. */
  function registerSandboxProxy(prefix: string, target: SandboxTarget): void {
    const methods = ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
    for (const url of [prefix, `${prefix}/*`]) {
      const pathOf = url === prefix ? () => "" : filePathParam;
      app.route({
        method: "GET",
        url,
        exposeHeadRoute: false,
        schema: { params: AgentParams },
        handler: async (request, reply) => {
          const agentId = await visibleAgentId(request, request.params.agent_id);
          const [base, headers] = await target(agentId);
          await proxyHttp(request, reply, base, headers, pathOf(request));
        },
        wsHandler: (socket, request) => {
          proxySandboxWs(socket, request, target, request.params.agent_id);
        },
      });
      app.route({
        method: [...methods],
        url,
        schema: { params: AgentParams },
        handler: async (request, reply) => {
          const agentId = await visibleAgentId(request, request.params.agent_id);
          const [base, headers] = await target(agentId);
          await proxyHttp(request, reply, base, headers, pathOf(request));
        },
      });
    }
  }

  app.get("/api/agents/:agent_id/browser", { schema: { params: AgentParams } }, async (request) => {
    await loop().machines.ensureBrowser(await visibleAgentId(request, request.params.agent_id));
    return { status: "ready" };
  });

  registerSandboxProxy("/api/agents/:agent_id/browser/vnc", (agentId) =>
    loop().machines.browserProxyTarget(agentId),
  );

  app.post("/api/agents/:agent_id/cli", { schema: { params: AgentParams } }, async (request) => {
    await loop().machines.ensureCli(await visibleAgentId(request, request.params.agent_id));
    return { status: "ready" };
  });

  registerSandboxProxy("/api/agents/:agent_id/cli/tty", (agentId) =>
    loop().machines.cliProxyTarget(agentId),
  );
}
