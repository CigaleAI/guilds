import type { FastifyInstance } from "fastify";
import { loadOperatorActor } from "../artifacts/actors.js";
import { displayPathFor } from "../artifacts/paths.js";
import { requireVisibleAgent } from "../agents/access.js";
import { maxScriptsOf } from "../agents/validation.js";
import type { AgentRow } from "../db/agents.js";
import { scriptItem, type AgentScript } from "../scripts/catalog.js";
import type { AppDeps } from "./deps.js";
import { missingBodyFields } from "./errors.js";
import { currentUser } from "./identity.js";
import { identityDatabase } from "../users/identity.js";
import { publishGroup } from "./publish.js";
import { bodyOf, param } from "./request.js";
import type { UserRow } from "../db/users.js";

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
export async function registerScriptRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db, scripts } = deps;
  const identityDb = identityDatabase(db);

  async function scriptOperator(user: UserRow, agent: AgentRow) {
    return loadOperatorActor(db, user, {
      orgId: agent.org_id,
      guildId: agent.guild_id,
      agentId: agent.id,
    });
  }

  app.get("/api/agents/:agent_id/scripts", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const agent = await requireVisibleAgent(db, param(request, "agent_id"), user.id);
    return (await scripts.listForAgent(agent.id)).map((script) => listedScript(agent, script));
  });

  app.post("/api/agents/:agent_id/scripts", async (request, reply) => {
    const user = await currentUser(identityDb, request, deps);
    const agent = await requireVisibleAgent(db, param(request, "agent_id"), user.id);
    const missing = missingBodyFields(request.body, ["name", "description", "source"]);
    if (missing) {
      throw missing;
    }
    const body = bodyOf(request);
    const row = await scripts.create(
      await scriptOperator(user, agent),
      agent.id,
      body.name,
      body.description,
      body.source,
      body.parameters ?? null,
      { maxScripts: maxScriptsOf(agent.config) },
    );
    await publishGroup(deps, agent.guild_id, "agent.scripts.changed", {
      agent_id: agent.id,
      action: "create",
      name: row.name,
    });
    return reply.code(201).send(scriptItem(row));
  });

  app.delete("/api/agents/:agent_id/scripts", async (request, reply) => {
    const user = await currentUser(identityDb, request, deps);
    const agent = await requireVisibleAgent(db, param(request, "agent_id"), user.id);
    await scripts.deleteAll(await scriptOperator(user, agent), agent.id);
    await publishGroup(deps, agent.guild_id, "agent.scripts.changed", {
      agent_id: agent.id,
      action: "clear",
    });
    return reply.code(204).send();
  });

  app.get("/api/agents/:agent_id/scripts/:name", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const agent = await requireVisibleAgent(db, param(request, "agent_id"), user.id);
    return scriptItem(await scripts.get(agent.id, param(request, "name")));
  });

  app.delete("/api/agents/:agent_id/scripts/:name", async (request, reply) => {
    const user = await currentUser(identityDb, request, deps);
    const agent = await requireVisibleAgent(db, param(request, "agent_id"), user.id);
    const name = param(request, "name");
    await scripts.delete(await scriptOperator(user, agent), agent.id, name);
    await publishGroup(deps, agent.guild_id, "agent.scripts.changed", {
      agent_id: agent.id,
      action: "delete",
      name,
    });
    return reply.code(204).send();
  });
}
