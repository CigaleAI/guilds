import { operatorActor } from "../../src/artifacts/actors.js";
import { artifactStore } from "../../src/artifacts/store.js";
import type { ArtifactActor } from "../../src/artifacts/types.js";
import { addAgent } from "../../src/agents/service.js";
import type { AgentRow, NewAgent } from "../../src/db/agents.js";
import type { Queryable } from "../../src/db/pg.js";
import { NotesStore } from "../../src/notes/store.js";
import { tempDir } from "./env.js";
import { templatesRoot } from "./fixtures.js";

/** The system operator a seeded agent's creation is logged against, writing as that agent. */
export function systemActor(orgId: string, agent: Pick<NewAgent, "guildId" | "agentId">): ArtifactActor {
  return operatorActor({
    orgId,
    actorId: "system",
    actorName: "system",
    guildId: agent.guildId,
    agentId: agent.agentId,
  });
}

/**
 * Adds an agent to a guild of the organisation `orgId` the way the app does: on the
 * organisation's only machine, with the fallback task and its Memory, logged against the system
 * operator.
 */
export async function addTestAgent(
  db: Queryable,
  orgId: string,
  agent: NewAgent,
  now: Date = new Date(),
): Promise<AgentRow> {
  const services = {
    db,
    notes: new NotesStore(tempDir("guilds-test-agent-notes-"), templatesRoot()),
    artifacts: artifactStore(db),
  };
  return addAgent(services, { agent, task: "", placement: {} }, systemActor(orgId, agent), now);
}
