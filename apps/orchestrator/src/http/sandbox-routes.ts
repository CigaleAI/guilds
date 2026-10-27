import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { requireVisibleAgent } from "../agents/access.js";
import { RunRequestError } from "../generation/index.js";
import { generationLoopOf } from "../generation/operator.js";
import type { AppDeps } from "./deps.js";
import { currentUser } from "./identity.js";
import { identityDatabase } from "../users/identity.js";
import { filePathParam, param } from "./request.js";
import { proxyHttp, startSandboxWsProxy } from "./sandbox-proxy.js";

/** How often operator input on a proxied sandbox view restarts its idle timer. */
const SANDBOX_TOUCH_INTERVAL_MS = 30_000;

/** The daemon an agent's sandbox view is served by: its base URL and the headers it takes. */
type SandboxTarget = (agentId: string) => Promise<[string, Record<string, string>]>;

/** An agent's browser and terminal: started on request, then proxied over HTTP and WebSocket. */
export async function registerSandboxRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const identityDb = identityDatabase(db);
  const loop = () => generationLoopOf({ loop: deps.generation ?? null });

  async function visibleAgentId(request: FastifyRequest): Promise<string> {
    const user = await currentUser(identityDb, request, deps);
    return (await requireVisibleAgent(db, param(request, "agent_id"), String(user.id))).id;
  }

  async function proxySandbox(
    request: FastifyRequest,
    reply: FastifyReply,
    target: SandboxTarget,
    pathPart: string,
  ): Promise<void> {
    const [base, headers] = await target(await visibleAgentId(request));
    await proxyHttp(request, reply, base, headers, pathPart);
  }

  function proxySandboxWs(socket: WebSocket, request: FastifyRequest, target: SandboxTarget): void {
    const agentId = param(request, "agent_id");
    let touchedAt = 0;
    startSandboxWsProxy(
      socket,
      request,
      async () => {
        const [base, extraHeaders] = await target(await visibleAgentId(request));
        return { base, extraHeaders, pathPart: filePathParam(request) };
      },
      (error) => (error instanceof RunRequestError ? 1013 : 1008),
      () => {
        const now = Date.now();
        if (now - touchedAt < SANDBOX_TOUCH_INTERVAL_MS) {
          return;
        }
        touchedAt = now;
        loop().touch_sandbox(agentId);
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
        handler: async (request, reply) => {
          await proxySandbox(request, reply, target, pathOf(request));
        },
        wsHandler: (socket, request) => {
          proxySandboxWs(socket, request, target);
        },
      });
      app.route({
        method: [...methods],
        url,
        handler: async (request, reply) => {
          await proxySandbox(request, reply, target, pathOf(request));
        },
      });
    }
  }

  app.get("/api/agents/:agent_id/browser", async (request) => {
    await loop().ensure_browser(await visibleAgentId(request));
    return { status: "ready" };
  });

  registerSandboxProxy("/api/agents/:agent_id/browser/vnc", (agentId) =>
    loop().browser_proxy_target(agentId),
  );

  app.post("/api/agents/:agent_id/cli", async (request) => {
    await loop().ensure_cli(await visibleAgentId(request));
    return { status: "ready" };
  });

  registerSandboxProxy("/api/agents/:agent_id/cli/tty", (agentId) =>
    loop().cli_proxy_target(agentId),
  );
}
