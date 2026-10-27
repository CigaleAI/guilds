import { requireVisibleAgent } from "../agents/access.js";
import { encryptPayload } from "../credentials/crypto.js";
import {
  secretPayload,
  validateSecretDescription,
  validateSecretName,
} from "../credentials/validate.js";
import { SecretNameTaken } from "../db/errors.js";
import { listGuildsForUser } from "../db/guilds.js";
import { getMembership } from "../db/orgs.js";
import type { Queryable } from "../db/pg.js";
import {
  deleteSecret,
  getSecret,
  insertSecret,
  listAgentIdsReached,
  listSecrets,
  secretGrantTargets,
  setSecretAccess,
  updateSecret,
} from "../db/secrets.js";
import type { GenerationLoop } from "../generation/index.js";
import { requireVisibleGuild } from "../guilds/access.js";
import { newId } from "../lib/ids.js";
import {
  accessOf,
  canCreateSecret,
  canManageSecret,
  managesOrgSecrets,
  secretGrants,
  secretMetadata,
  validateSecretAccess,
  type SecretAccess,
  type SecretViewer,
} from "./access.js";

/** A secret request refused, with the HTTP status it answers with. */
export class SecretError extends Error {
  status: 403 | 404 | 409 | 422;

  constructor(status: 403 | 404 | 409 | 422, message: string) {
    super(message);
    this.name = "SecretError";
    this.status = status;
  }
}

/** What an organisation's secrets are managed through, built once from the app's services. */
export type SecretServices = {
  db: Queryable;
  /** The key secrets are encrypted with; the process's own when absent. */
  masterKey: Buffer | undefined;
  /** The generation loop whose running agents see the secrets; absent on a box without one. */
  generation: Pick<GenerationLoop, "secretAccessChanged" | "secretChanged"> | null;
};

/** A new secret as it is asked for, before validation: the name, description and value, and who gets it. */
export type SecretDraft = {
  name: unknown;
  description: unknown;
  value: unknown;
  access: Record<string, unknown>;
};

/** The fields a secret change sets; an absent one stays as it is. */
export type SecretChange = { name?: unknown; description?: unknown; value?: unknown };

/** A secret of an organisation as one of its members holds it: the row, and what the member may see and do. */
export type HeldSecret = {
  row: NonNullable<Awaited<ReturnType<typeof getSecret>>>;
  viewer: SecretViewer;
};

/** Which secrets a listing shows: the organisation's, or the ones that reach a guild or an agent. */
export type SecretListScope = { guildId: string | null; agentId: string | null };

type Metadata = Record<string, unknown>;

function encrypt(services: SecretServices, payload: Record<string, unknown>): [Buffer, Buffer] {
  return services.masterKey ? encryptPayload(payload, services.masterKey) : encryptPayload(payload);
}

/** The user as a viewer of the organisation's secrets: their role and the guilds they see; null for a non-member. */
async function loadSecretViewer(
  db: Queryable,
  orgId: string,
  userId: string,
): Promise<SecretViewer | null> {
  const membership = await getMembership(db, orgId, userId);
  if (membership === null) {
    return null;
  }
  const guilds = await listGuildsForUser(db, orgId, userId);
  return { role: membership.role, visibleGuildIds: new Set(guilds.map((guild) => guild.id)) };
}

async function requireSecretViewer(
  db: Queryable,
  orgId: string,
  userId: string,
): Promise<SecretViewer> {
  const viewer = await loadSecretViewer(db, orgId, userId);
  if (viewer === null) {
    throw new SecretError(404, "organisation not found");
  }
  return viewer;
}

/** Each granted agent's guild; refuses a guild or agent outside the organisation. */
async function grantTargets(
  db: Queryable,
  orgId: string,
  access: SecretAccess,
): Promise<Map<string, string>> {
  const found = await secretGrantTargets(db, orgId, access.guild_ids, access.agent_ids);
  const unknownGuild = access.guild_ids.find((id) => !found.guildIds.has(id));
  if (unknownGuild !== undefined) {
    throw new SecretError(422, `unknown guild ${unknownGuild}`);
  }
  const unknownAgent = access.agent_ids.find((id) => !found.agentGuilds.has(id));
  if (unknownAgent !== undefined) {
    throw new SecretError(422, `unknown agent ${unknownAgent}`);
  }
  return found.agentGuilds;
}

function nameConflict(error: unknown): unknown {
  return error instanceof SecretNameTaken ? new SecretError(409, error.message) : error;
}

/** The organisation's secrets the user sees, or the ones that reach a guild or agent of it they see. */
export async function listOrgSecrets(
  db: Queryable,
  orgId: string,
  userId: string,
  scope: SecretListScope,
): Promise<{ secrets: Metadata[] }> {
  if (scope.guildId && (await requireVisibleGuild(db, scope.guildId, userId)).org_id !== orgId) {
    throw new SecretError(404, "guild not found");
  }
  if (scope.agentId && (await requireVisibleAgent(db, scope.agentId, userId)).org_id !== orgId) {
    throw new SecretError(404, "agent not found");
  }
  const viewer = await requireSecretViewer(db, orgId, userId);
  const rows = await listSecrets(db, orgId, scope);
  return { secrets: rows.map((row) => secretMetadata(row, viewer)) };
}

/**
 * Creates a secret, encrypted. Only an owner or admin creates one for the whole organisation, one
 * granted to nobody, or one granted outside the guilds they see.
 */
export async function createSecret(
  services: SecretServices,
  orgId: string,
  userId: string,
  draft: SecretDraft,
): Promise<Metadata> {
  const { db } = services;
  const name = validateSecretName(draft.name);
  const description = validateSecretDescription(draft.description);
  const payload = secretPayload(draft.value);
  const access = validateSecretAccess(draft.access);
  const viewer = await requireSecretViewer(db, orgId, userId);
  const agentGuilds = await grantTargets(db, orgId, access);
  if (!canCreateSecret(access, viewer, agentGuilds)) {
    throw new SecretError(
      403,
      "only an org owner or admin can create an organisation-wide or unassigned secret, or grant one outside your guilds",
    );
  }
  const [ciphertext, nonce] = encrypt(services, payload);
  const secret = {
    secretId: newId("sec"),
    orgId,
    name,
    description,
    access,
    ciphertext,
    nonce,
    createdByUserId: userId,
  };
  let row;
  try {
    row = await insertSecret(db, secret, new Date());
  } catch (error) {
    throw nameConflict(error);
  }
  await services.generation?.secretAccessChanged(await listAgentIdsReached(db, orgId, access));
  return secretMetadata(row, viewer);
}

/** A secret of an organisation the user is a member of; any other is a 404. */
export async function requireMemberSecret(
  db: Queryable,
  secretId: string,
  userId: string,
): Promise<HeldSecret> {
  const row = await getSecret(db, secretId);
  const viewer = row === null ? null : await loadSecretViewer(db, row.org_id, userId);
  if (row === null || viewer === null) {
    throw new SecretError(404, "secret not found");
  }
  return { row, viewer };
}

export function viewHeldSecret(held: HeldSecret): Metadata {
  return secretMetadata(held.row, held.viewer);
}

/** Renames a secret, rewrites its description, or replaces its value, for a member who manages it. */
export async function changeSecret(
  services: SecretServices,
  held: HeldSecret,
  change: SecretChange,
): Promise<Metadata> {
  if (!canManageSecret(held.row, held.viewer)) {
    throw new SecretError(403, "only an org owner or admin can change this secret");
  }
  const given = (value: unknown) => value !== undefined && value !== null;
  if (!given(change.name) && !given(change.description) && !given(change.value)) {
    throw new SecretError(422, "name, description, or value is required");
  }
  const [ciphertext, nonce] = given(change.value)
    ? encrypt(services, secretPayload(change.value))
    : [null, null];
  const changes = {
    name: given(change.name) ? validateSecretName(change.name) : null,
    description: given(change.description) ? validateSecretDescription(change.description) : null,
    ciphertext,
    nonce,
  };
  let updated;
  try {
    updated = await updateSecret(services.db, held.row.id, changes, new Date());
  } catch (error) {
    throw nameConflict(error);
  }
  if (updated === null) {
    throw new SecretError(404, "secret not found");
  }
  await services.generation?.secretChanged(held.row.id);
  return secretMetadata(updated, held.viewer);
}

/** The access asked for, with the grants in guilds the viewer cannot see kept: they cannot name them. */
function keepUnseenGrants(held: HeldSecret, access: SecretAccess): SecretAccess {
  if (access.org_wide) {
    return access;
  }
  const unseen = secretGrants(held.row).filter(
    (grant) => !held.viewer.visibleGuildIds.has(grant.in_guild_id),
  );
  const guildIds = new Set(access.guild_ids);
  const agentIds = new Set(access.agent_ids);
  for (const grant of unseen) {
    if (grant.guild_id) {
      guildIds.add(grant.guild_id);
    }
    if (grant.agent_id) {
      agentIds.add(grant.agent_id);
    }
  }
  return { ...access, guild_ids: [...guildIds], agent_ids: [...agentIds] };
}

/** Replaces who gets a secret, for an owner or admin; the agents it reaches or stops reaching are told. */
export async function replaceSecretAccess(
  services: SecretServices,
  held: HeldSecret,
  requested: Record<string, unknown>,
): Promise<Metadata> {
  const { db } = services;
  if (!managesOrgSecrets(held.viewer.role)) {
    throw new SecretError(403, "only an org owner or admin can change who gets a secret");
  }
  const access = keepUnseenGrants(held, validateSecretAccess(requested));
  const orgId = held.row.org_id;
  await grantTargets(db, orgId, access);
  const before = await listAgentIdsReached(db, orgId, accessOf(held.row));
  const updated = await setSecretAccess(db, held.row.id, access, new Date());
  if (updated === null) {
    throw new SecretError(404, "secret not found");
  }
  const after = await listAgentIdsReached(db, orgId, access);
  const reached = new Set(after);
  const left = new Set(before);
  await services.generation?.secretAccessChanged([
    ...before.filter((id) => !reached.has(id)),
    ...after.filter((id) => !left.has(id)),
  ]);
  return secretMetadata(updated, held.viewer);
}

/** Deletes a secret, for a member who manages it; the agents it reached are told. */
export async function deleteOrgSecret(services: SecretServices, held: HeldSecret): Promise<void> {
  if (!canManageSecret(held.row, held.viewer)) {
    throw new SecretError(403, "only an org owner or admin can delete this secret");
  }
  const reached = await listAgentIdsReached(services.db, held.row.org_id, accessOf(held.row));
  if ((await deleteSecret(services.db, held.row.id)) === null) {
    throw new SecretError(404, "secret not found");
  }
  await services.generation?.secretAccessChanged(reached);
}
