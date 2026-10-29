import { agentSecrets, applySecretAliases, snapshotEnvValues } from "../access/runtime.js";
import { instanceRedactions } from "../connectors/instance.js";
import { decryptPayload } from "../credentials/crypto.js";
import { getAgent, type AgentRow } from "../db/agents.js";
import { getMcpConnection, type McpConnectionRow } from "../db/mcp.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import { listActiveRuns, listRuns, updateRunSecrets } from "../db/runs.js";
import type { RunConfigSnapshot, SecretRef } from "../db/schema/index.js";
import { listActiveRunAgentIdsForSecret } from "../db/secrets.js";
import { tokenRedactions } from "../oauth/index.js";
import { readSecretFile, removeSecretFile, storeAgentSecret } from "../secrets/agent.js";
import type { AgentSecretStore } from "../toolbox/types.js";
import type { AgentMachines } from "./machines.js";

/** Where a run's connection tokens are read from to redact them. */
export type ConnectionPayloads = {
  getMcpConnection(connectionId: string): Promise<Pick<McpConnectionRow, "ciphertext" | "nonce"> | null>;
};

/** The tokens of one connection, as redaction values; a payload that cannot be read holds none the run can use. */
async function connectionRedactions(db: ConnectionPayloads, connectionId: string): Promise<Record<string, string>> {
  const connection = await db.getMcpConnection(connectionId);
  if (connection === null) {
    return {};
  }
  try {
    return tokenRedactions(decryptPayload(connection.ciphertext, connection.nonce), connectionId);
  } catch {
    return {};
  }
}

/** The tokens of every connection the run's snapshot names, as redaction values. */
export async function mcpRedactions(
  db: ConnectionPayloads,
  snapshot: RunConfigSnapshot,
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const group of snapshot.mcp) {
    Object.assign(values, await connectionRedactions(db, group.connection_id));
  }
  return values;
}

/** The db/ functions a run's secrets are read and refreshed through, and the store of an agent's secret, on `db`. */
export function runSecretsDatabase(db: Queryable) {
  return {
    agentSecrets: bindQuery(db, agentSecrets),
    snapshotEnvValues: bindQuery(db, snapshotEnvValues),
    getAgent: bindQuery(db, getAgent),
    getMcpConnection: bindQuery(db, getMcpConnection),
    listRuns: bindQuery(db, listRuns),
    listActiveRuns: bindQuery(db, listActiveRuns),
    listActiveRunAgentIdsForSecret: bindQuery(db, listActiveRunAgentIdsForSecret),
    updateRunSecrets: bindQuery(db, updateRunSecrets),
    storeAgentSecret: bindQuery(db, storeAgentSecret),
  };
}

export type RunSecretsDatabase = ReturnType<typeof runSecretsDatabase>;

/**
 * A generation's secrets: the references its snapshot keeps, the environment its commands get,
 * and every value its output is redacted with.
 */
export type GenerationSecrets = {
  refs: SecretRef[];
  env: Record<string, string>;
  values: Record<string, string>;
};

/**
 * The secrets of a loop's runs. An active run's snapshot follows each change to the secrets
 * its agent is granted, so its next generation runs with the current values.
 */
export class RunSecrets {
  constructor(
    private readonly db: RunSecretsDatabase,
    private readonly machines: AgentMachines,
  ) {}

  /** A secret's value, name, or description changed: the active runs it reaches get a fresh snapshot. */
  async secretChanged(secretId: string): Promise<void> {
    await this.refresh(await this.db.listActiveRunAgentIdsForSecret(secretId));
  }

  /** These agents gained or lost a secret: their active runs get a fresh snapshot. */
  async secretAccessChanged(agentIds: string[]): Promise<void> {
    if (!agentIds.length) {
      return;
    }
    const live = new Set((await this.db.listActiveRuns()).map((row) => row.agent_id));
    await this.refresh(agentIds.filter((id) => live.has(id)));
  }

  /** Writes the agent's current secret references into each of its active runs that holds others. */
  async sync(agent: AgentRow): Promise<SecretRef[]> {
    const refs = await this.db.agentSecrets(agent);
    const now = new Date();
    for (const run of await this.db.listRuns(agent.id)) {
      if (run.status !== "active" || JSON.stringify(run.config_snapshot.secrets) === JSON.stringify(refs)) {
        continue;
      }
      await this.db.updateRunSecrets(run.id, refs, now);
      run.config_snapshot.secrets = refs;
    }
    return refs;
  }

  /** The generation's secrets, synced into its snapshot first, with its aliases applied. */
  async resolve(agent: AgentRow, snapshot: RunConfigSnapshot): Promise<GenerationSecrets> {
    const refs = await this.sync(agent);
    snapshot.secrets = refs;
    const env = applySecretAliases(await this.db.snapshotEnvValues(refs), snapshot.secret_aliases);
    return { refs, env, values: { ...env, ...(await mcpRedactions(this.db, snapshot)), ...instanceRedactions() } };
  }

  /**
   * `secret_store` for one agent: reads the value file from its workspace, saves the
   * secret granted to it, removes the file, and refreshes environments the change reaches.
   */
  secretStore(agent: AgentRow): AgentSecretStore {
    return {
      store: async (input) => {
        const file = await readSecretFile(await this.machines.agentWorkspace(agent), input.file);
        const stored = await this.db.storeAgentSecret(
          { id: agent.id, orgId: agent.org_id },
          { name: input.name, description: input.description, value: file.value },
        );
        await removeSecretFile(file.path);
        if (stored.rotated) {
          await this.secretChanged(stored.secretId);
        } else {
          await this.secretAccessChanged([agent.id]);
        }
        return { name: stored.name, rotated: stored.rotated, value: stored.value };
      },
    };
  }

  private async refresh(agentIds: string[]): Promise<void> {
    for (const agentId of [...new Set(agentIds)].sort()) {
      const agent = await this.db.getAgent(agentId);
      if (agent !== null) {
        await this.sync(agent);
      }
    }
  }
}
