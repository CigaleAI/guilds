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

export function rowParameters(row: Record<string, unknown>): Record<string, unknown> | null {
  let value = row.parameters;
  if (typeof value === "string") {
    value = JSON.parse(value);
  }
  if (value === null || value === undefined) {
    return null;
  }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ScriptError("parameters must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export function scriptRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    agent_id: row.agent_id,
    name: row.name,
    description: row.description,
    parameters: rowParameters(row),
    source: row.source,
    source_hash: row.source_hash,
  };
}

export function catalogItem(row: Record<string, unknown>): Record<string, unknown> {
  const item: Record<string, unknown> = { name: row.name, description: row.description };
  const parameters = rowParameters(row);
  if (parameters !== null) {
    item.parameters = parameters;
  }
  return item;
}

export function scriptItem(
  row: Record<string, unknown>,
  options: { source?: boolean } = {},
): Record<string, unknown> {
  const item: Record<string, unknown> = {
    name: row.name,
    description: row.description,
    parameters: rowParameters(row),
  };
  if (options.source) {
    item.source = row.source;
  }
  return item;
}

export type ScriptDatabase = {
  getAgentScript(agentId: string, name: string): Promise<Record<string, unknown> | null>;
  upsertAgentScript(
    actor: ArtifactActor,
    scriptId: string,
    agentId: string,
    name: string,
    description: string,
    parameters: Record<string, unknown> | null,
    source: string,
    sourceHash: string,
    now: Date,
  ): Promise<Record<string, unknown>>;
  listAgentScripts(agentId: string): Promise<Array<Record<string, unknown>>>;
  deleteAgentScript(
    actor: ArtifactActor,
    agentId: string,
    name: string,
  ): Promise<Record<string, unknown> | null>;
};

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
  ): Promise<Record<string, unknown>> {
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
        actor,
        existing ? String(existing.id) : newId("scr"),
        agentId,
        token,
        text,
        schema,
        body,
        digest,
        now,
      );
      return scriptRow(row);
    });
  }

  async listForAgent(agentId: string): Promise<Array<Record<string, unknown>>> {
    return this.lock.run(async () =>
      (await this.db.listAgentScripts(agentId)).map(scriptRow),
    );
  }

  async get(agentId: string, name: unknown): Promise<Record<string, unknown>> {
    const token = validateScriptName(name);
    return this.lock.run(async () => {
      const row = await this.db.getAgentScript(agentId, token);
      if (row === null) {
        throw new ScriptError("script not found");
      }
      return scriptRow(row);
    });
  }

  async delete(actor: ArtifactActor, agentId: string, name: unknown): Promise<Record<string, unknown>> {
    const token = validateScriptName(name);
    return this.lock.run(async () => {
      const row = await this.db.deleteAgentScript(actor, agentId, token);
      if (row === null) {
        throw new ScriptError("script not found");
      }
      return scriptRow(row);
    });
  }

  async deleteAll(actor: ArtifactActor, agentId: string): Promise<Array<Record<string, unknown>>> {
    return this.lock.run(async () => {
      const deleted: Array<Record<string, unknown>> = [];
      for (const row of await this.db.listAgentScripts(agentId)) {
        const gone = await this.db.deleteAgentScript(actor, agentId, String(row.name));
        if (gone) {
          deleted.push(scriptRow(gone));
        }
      }
      return deleted;
    });
  }

  async catalog(agentId: string): Promise<Array<Record<string, unknown>>> {
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
