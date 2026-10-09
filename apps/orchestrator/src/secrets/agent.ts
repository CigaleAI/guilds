import { unlink } from "node:fs/promises";
import { SecretNameTaken } from "../db/errors.js";
import { AGENT_HOME, AgentFileError, readAgentFile } from "../lib/agent-file.js";
import { CredentialError, secretPayload, validateSecretDescription, validateSecretName } from "../credentials/validate.js";
import { encryptPayload } from "../credentials/crypto.js";
import { newId } from "../lib/ids.js";
import { secretGrants } from "./access.js";

/** Secrets one agent may have created in its organisation. */
export const AGENT_SECRET_CAP = 20;
/** Largest value file `secret_store` reads. */
export const SECRET_FILE_MAX_BYTES = 16 * 1024;

export class AgentSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentSecretError";
  }
}

export type AgentSecretsDatabase = {
  getSecretByName(orgId: string, name: string): Promise<Record<string, unknown> | null>;
  countSecretsCreatedByAgent(agentId: string): Promise<number>;
  insertSecret(input: {
    secretId: string;
    orgId: string;
    name: string;
    description: string;
    access: { org_wide: boolean; guild_ids: string[]; agent_ids: string[] };
    ciphertext: Buffer;
    nonce: Buffer;
    createdByAgentId?: string | null;
    now: Date;
  }): Promise<Record<string, unknown>>;
  updateSecret(
    secretId: string,
    changes: { description?: string | null; ciphertext?: Buffer | null; nonce?: Buffer | null },
    now: Date,
  ): Promise<Record<string, unknown> | null>;
};

/** What `secret_store` changed, for the caller to refresh environments with. */
export type StoredSecret = {
  secretId: string;
  name: string;
  rotated: boolean;
  value: string;
};

/**
 * Reads a value file from the agent's workspace: a regular file under /home/agent (see
 * `readAgentFile`), at most 16 KiB of UTF-8 with no NUL byte. One trailing newline is stripped;
 * an empty value is refused.
 */
export async function readSecretFile(workspaceDir: string, file: string): Promise<{ value: string; path: string }> {
  let read: { path: string; bytes: Buffer };
  try {
    read = await readAgentFile(workspaceDir, file, { maxBytes: SECRET_FILE_MAX_BYTES });
  } catch (error) {
    if (!(error instanceof AgentFileError)) {
      throw error;
    }
    const message = {
      outside: `file must be a path under ${AGENT_HOME}, not a link out of it`,
      missing: `file not found: ${file}`,
      not_file: "file must be a regular file",
      too_large: `file is larger than ${SECRET_FILE_MAX_BYTES / 1024} KiB`,
    }[error.problem];
    throw new AgentSecretError(message);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
  } catch {
    throw new AgentSecretError("file must be UTF-8 text");
  }
  if (text.includes("\0")) {
    throw new AgentSecretError("file must not contain a NUL byte");
  }
  const value = text.replace(/\r?\n$/, "");
  if (!value) {
    throw new AgentSecretError("file is empty");
  }
  return { value, path: read.path };
}

/**
 * Saves a value as a secret granted to the agent that produced it. A taken name is
 * rotated when this agent created that secret and is its only grant; otherwise refused.
 */
export async function storeAgentSecret(
  db: AgentSecretsDatabase,
  agent: { id: string; orgId: string },
  input: { name: unknown; description: unknown; value: string },
  now: Date = new Date(),
): Promise<StoredSecret> {
  let name: string;
  let description: string;
  try {
    name = validateSecretName(input.name);
    description = validateSecretDescription(input.description);
    secretPayload(input.value);
  } catch (error) {
    if (error instanceof CredentialError) {
      throw new AgentSecretError(error.message);
    }
    throw error;
  }
  const [ciphertext, nonce] = encryptPayload({ value: input.value });
  const existing = await db.getSecretByName(agent.orgId, name);
  if (existing !== null) {
    if (!ownsAlone(existing, agent.id)) {
      throw new AgentSecretError(`${name} is taken in this organisation; choose another name`);
    }
    const row = await db.updateSecret(String(existing.id), { description, ciphertext, nonce }, now);
    if (row === null) {
      throw new AgentSecretError(`${name} is taken in this organisation; choose another name`);
    }
    return { secretId: String(row.id), name, rotated: true, value: input.value };
  }
  if ((await db.countSecretsCreatedByAgent(agent.id)) >= AGENT_SECRET_CAP) {
    throw new AgentSecretError(
      `this agent already stored ${AGENT_SECRET_CAP} secrets; an operator must delete one first`,
    );
  }
  try {
    const row = await db.insertSecret({
      secretId: newId("sec"),
      orgId: agent.orgId,
      name,
      description,
      access: { org_wide: false, guild_ids: [], agent_ids: [agent.id] },
      ciphertext,
      nonce,
      createdByAgentId: agent.id,
      now,
    });
    return { secretId: String(row.id), name, rotated: false, value: input.value };
  } catch (error) {
    if (error instanceof SecretNameTaken) {
      throw new AgentSecretError(`${name} is taken in this organisation; choose another name`);
    }
    throw error;
  }
}

/** This agent created the secret and is its only grant. */
function ownsAlone(row: Record<string, unknown>, agentId: string): boolean {
  if (row.org_wide || row.created_by_agent_id !== agentId) {
    return false;
  }
  const grants = secretGrants(row);
  return grants.length === 1 && grants[0]!.agent_id === agentId;
}

/** Removes the value file once its secret is saved. */
export async function removeSecretFile(resolved: string): Promise<void> {
  await unlink(resolved).catch(() => undefined);
}
