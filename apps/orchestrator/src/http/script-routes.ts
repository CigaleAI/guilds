import { Type } from "@sinclair/typebox";
import { loadOperatorActor } from "../artifacts/actors.js";
import { displayPathFor } from "../artifacts/paths.js";
import { requireVisibleAgent } from "../agents/access.js";
import type { AgentRow } from "../db/agents.js";
import { scriptItem, type AgentScript } from "../scripts/catalog.js";
import { clearScripts, createScript, deleteScript } from "../scripts/operator.js";
import type { AppDeps, RouteApp } from "./deps.js";
import { currentUser } from "./identity.js";
import { AgentParams } from "./params.js";
import type { UserRow } from "../db/users.js";

/** A new script: its name, what it does, its source, and the parameters it takes, checked by the catalog. */
const ScriptDraftSchema = Type.Object({
  name: Type.String(),
  description: Type.String(),
  source: Type.String(),
  parameters: Type.Optional(Type.Unknown()),
});

/** The path of one script of an agent. */
const ScriptParams = Type.Object({ agent_id: Type.String(), name: Type.String() });

/** A script of the agent's listing, with the path it shows under in the agent's files. */
function listedScript(agent: AgentRow, script: AgentScript) {
  const displayPath = displayPathFor({
    orgId: agent.org_id,
    level: "agent",
    ownerId: agent.id,
    kind: "script",
    path: "scripts",
    key: script.name,
  });
  return { ...scriptItem(script), display_path: displayPath };
}

/** An agent's scripts: listed, read, written and deleted by its operators. */
export async function registerScriptRoutes(app: RouteApp, deps: AppDeps): Promise<void> {
  const { db, scripts } = deps;

  async function scriptOperator(user: UserRow, agent: AgentRow) {
    return loadOperatorActor(db, user, {
      orgId: agent.org_id,
      guildId: agent.guild_id,
      agentId: agent.id,
    });
  }

  app.get("/api/agents/:agent_id/scripts", { schema: { params: AgentParams } }, async (request) => {
    const user = await currentUser(db, request, deps);
    const agent = await requireVisibleAgent(db, request.params.agent_id, user.id);
    return (await scripts.listForAgent(agent.id)).map((script) => listedScript(agent, script));
  });

  app.post(
    "/api/agents/:agent_id/scripts",
    { schema: { params: AgentParams, body: ScriptDraftSchema } },
    async (request, reply) => {
      const user = await currentUser(db, request, deps);
      const agent = await requireVisibleAgent(db, request.params.agent_id, user.id);
      const body = request.body;
      const row = await createScript(deps, await scriptOperator(user, agent), agent, {
        name: body.name,
        description: body.description,
        source: body.source,
        parameters: body.parameters ?? null,
      });
      return reply.code(201).send(scriptItem(row));
    },
  );

  app.delete(
    "/api/agents/:agent_id/scripts",
    { schema: { params: AgentParams } },
    async (request, reply) => {
      const user = await currentUser(db, request, deps);
      const agent = await requireVisibleAgent(db, request.params.agent_id, user.id);
      await clearScripts(deps, await scriptOperator(user, agent), agent);
      return reply.code(204).send();
    },
  );

  app.get(
    "/api/agents/:agent_id/scripts/:name",
    { schema: { params: ScriptParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const agent = await requireVisibleAgent(db, request.params.agent_id, user.id);
      return scriptItem(await scripts.get(agent.id, request.params.name));
    },
  );

  app.delete(
    "/api/agents/:agent_id/scripts/:name",
    { schema: { params: ScriptParams } },
    async (request, reply) => {
      const user = await currentUser(db, request, deps);
      const agent = await requireVisibleAgent(db, request.params.agent_id, user.id);
      await deleteScript(deps, await scriptOperator(user, agent), agent, request.params.name);
      return reply.code(204).send();
    },
  );
}
