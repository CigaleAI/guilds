import { DEFAULT_MAX_SCRIPTS } from "../agents/validation.js";
import { AsyncLock } from "../lib/lock.js";
import { newId } from "../lib/ids.js";
import type { ArtifactActor } from "../artifacts/types.js";
import { snapshotAgentScripts, type RunScriptSnapshot } from "./snapshot.js";
import {
  ScriptError,
  assertAvailableScriptName,
  scriptSourceHash,
  validateScriptDescription,
  validateScriptName,
  validateScriptParameters,
  validateScriptSource,
} from "./validation.js";
import {
  type AgentScriptRow,
  deleteAgentScript,
  getAgentScript,
  listAgentScripts,
  upsertAgentScript,
} from "../db/agents.js";
import { bindQuery, type Queryable } from "../db/pg.js";

/** An agent's script: its row without the timestamps. */
export type AgentScript = Omit<AgentScriptRow, "created_at" | "updated_at">;

/** A script as the agent's catalog lists it: the parameters only when the script declares them. */
export type ScriptCatalogItem = Pick<AgentScript, "name" | "description"> & {
  parameters?: Record<string, unknown>;
};

/** A script as the API shows it. */
export type ScriptItem = Pick<AgentScript, "name" | "description" | "parameters" | "source">;

export function agentScript(row: AgentScriptRow): AgentScript {
  return {
    id: row.id,
    agent_id: row.agent_id,
    name: row.name,
    description: row.description,
    parameters: row.parameters,
    source: row.source,
    source_hash: row.source_hash,
  };
}

export function catalogItem(script: AgentScript): ScriptCatalogItem {
  return {
    name: script.name,
    description: script.description,
    ...(script.parameters !== null ? { parameters: script.parameters } : {}),
  };
}

export function scriptItem(script: AgentScript): ScriptItem {
  return {
    name: script.name,
    description: script.description,
    parameters: script.parameters,
    source: script.source,
  };
}

/** The db/ functions an agent's scripts are read and written through, on `db`. */
export function scriptDatabase(db: Queryable) {
  return {
    getAgentScript: bindQuery(db, getAgentScript),
    upsertAgentScript: bindQuery(db, upsertAgentScript),
    listAgentScripts: bindQuery(db, listAgentScripts),
    deleteAgentScript: bindQuery(db, deleteAgentScript),
  };
}

export type ScriptDatabase = ReturnType<typeof scriptDatabase>;

export class Scripts {
  private readonly lock = new AsyncLock();

  constructor(public db: ScriptDatabase) {}

  async create(
    actor: ArtifactActor,
    agentId: string,
    name: unknown,
    description: unknown,
    source: unknown,
    parameters: unknown = null,
    options: { reservedNames?: Iterable<string>; maxScripts?: number } = {},
  ): Promise<AgentScript> {
    const token = validateScriptName(name);
    assertAvailableScriptName(token, options.reservedNames ?? []);
    const text = validateScriptDescription(description);
    const body = validateScriptSource(source);
    const schema = validateScriptParameters(parameters);
    const digest = scriptSourceHash(body);
    const now = new Date();
    const maxScripts = options.maxScripts ?? DEFAULT_MAX_SCRIPTS;
    return this.lock.run(async () => {
      const existing = await this.db.getAgentScript(agentId, token);
      if (!existing) {
        const count = (await this.db.listAgentScripts(agentId)).length;
        if (count >= maxScripts) {
          throw new ScriptError(`this agent is limited to ${maxScripts} scripts`);
        }
      }
      const row = await this.db.upsertAgentScript(
        {
          scriptId: existing ? existing.id : newId("scr"),
          agentId,
          name: token,
          description: text,
          parameters: schema,
          source: body,
          sourceHash: digest,
        },
        actor,
        now,
      );
      return agentScript(row);
    });
  }

  async listForAgent(agentId: string): Promise<AgentScript[]> {
    return this.lock.run(async () =>
      (await this.db.listAgentScripts(agentId)).map(agentScript),
    );
  }

  async get(agentId: string, name: unknown): Promise<AgentScript> {
    const token = validateScriptName(name);
    return this.lock.run(async () => {
      const row = await this.db.getAgentScript(agentId, token);
      if (row === null) {
        throw new ScriptError("script not found", 404);
      }
      return agentScript(row);
    });
  }

  async delete(actor: ArtifactActor, agentId: string, name: unknown): Promise<AgentScript> {
    const token = validateScriptName(name);
    return this.lock.run(async () => {
      const row = await this.db.deleteAgentScript(actor, agentId, token);
      if (row === null) {
        throw new ScriptError("script not found", 404);
      }
      return agentScript(row);
    });
  }

  async deleteAll(actor: ArtifactActor, agentId: string): Promise<AgentScript[]> {
    return this.lock.run(async () => {
      const deleted: AgentScript[] = [];
      for (const row of await this.db.listAgentScripts(agentId)) {
        const gone = await this.db.deleteAgentScript(actor, agentId, row.name);
        if (gone) {
          deleted.push(agentScript(gone));
        }
      }
      return deleted;
    });
  }

  async catalog(agentId: string): Promise<ScriptCatalogItem[]> {
    return (await this.listForAgent(agentId)).map(catalogItem);
  }

  async snapshot(agentId: string): Promise<RunScriptSnapshot[]> {
    return snapshotAgentScripts(await this.listForAgent(agentId));
  }

  async formatList(agentId: string): Promise<string> {
    const rows = await this.catalog(agentId);
    if (!rows.length) {
      return "no scripts";
    }
    return rows.map((row) => `${row.name}  ${row.description}`).join("\n");
  }
}
