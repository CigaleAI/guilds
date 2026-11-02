import { Type, type Static } from "typebox";
import { requireVisibleAgent } from "../agents/access.js";
import { encryptPayload } from "../credentials/crypto.js";
import {
  secretPayload,
  type SecretPayload,
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
  type SecretPatch,
} from "../db/secrets.js";
import type { RunSecrets } from "../generation/run-secrets.js";
import { requireVisibleGuild } from "../guilds/access.js";
import { newId } from "../lib/ids.js";
import {
  accessOf,
  canCreateSecret,
  canManageSecret,
  grantSeen,
  managesOrgSecrets,
  SecretAccessSchema,
  secretMetadata,
  validateSecretAccess,
  type Secret,
  type SecretAccess,
  type SecretAccessRequest,
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
  /** The secrets of the runs under way; absent on a box without a generation loop. */
  runSecrets: Pick<RunSecrets, "secretAccessChanged" | "secretChanged"> | null;
};

/** A new secret as it is asked for, before validation: the name, description and value, and who gets it. */
export const SecretDraftSchema = Type.Evaluate(
  Type.Intersect([
    Type.Object({ name: Type.String(), description: Type.String(), value: Type.String() }),
    SecretAccessSchema,
  ]),
);

export type SecretDraft = Static<typeof SecretDraftSchema>;

/** The fields a secret change sets; an absent or null one stays as it is. */
export const SecretChangeSchema = Type.Object({
  name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

export type SecretChange = Static<typeof SecretChangeSchema>;

/** A secret of an organisation as one of its members holds it: the row, and what the member may see and do. */
export type HeldSecret = {
  row: NonNullable<Awaited<ReturnType<typeof getSecret>>>;
  viewer: SecretViewer;
};

/** Which secrets a listing shows: the organisation's, or the ones that reach a guild or an agent. */
export type SecretListScope = { guildId: string | null; agentId: string | null };

/** The secrets a listing shows its viewer. */
export type SecretListing = { secrets: Secret[] };

function encrypt(services: SecretServices, payload: SecretPayload): [Buffer, Buffer] {
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

/** The organisation's secrets the user sees, or the ones that reach a guild or agent of it they see. */
export async function listOrgSecrets(
  db: Queryable,
  orgId: string,
  userId: string,
  scope: SecretListScope,
): Promise<SecretListing> {
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
): Promise<Secret> {
  const { db } = services;
  const name = validateSecretName(draft.name);
  const description = validateSecretDescription(draft.description);
  const payload = secretPayload(draft.value);
  const access = validateSecretAccess(draft);
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
    throw error instanceof SecretNameTaken ? new SecretError(409, error.message) : error;
  }
  await services.runSecrets?.secretAccessChanged(await listAgentIdsReached(db, orgId, access));
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

export function viewHeldSecret(held: HeldSecret): Secret {
  return secretMetadata(held.row, held.viewer);
}

/** What a change writes: its name and description validated and its value encrypted; a field it leaves out stays. */
function secretPatch(services: SecretServices, change: SecretChange): SecretPatch {
  const name = change.name ?? null;
  const description = change.description ?? null;
  const value = change.value ?? null;
  if (name === null && description === null && value === null) {
    throw new SecretError(422, "name, description, or value is required");
  }
  const [ciphertext, nonce] = value === null ? [null, null] : encrypt(services, secretPayload(value));
  return {
    name: name === null ? null : validateSecretName(name),
    description: description === null ? null : validateSecretDescription(description),
    ciphertext,
    nonce,
  };
}

/** Renames a secret, rewrites its description, or replaces its value, for a member who manages it. */
export async function changeSecret(
  services: SecretServices,
  held: HeldSecret,
  change: SecretChange,
): Promise<Secret> {
  if (!canManageSecret(held.row, held.viewer)) {
    throw new SecretError(403, "only an org owner or admin can change this secret");
  }
  let updated;
  try {
    updated = await updateSecret(services.db, held.row.id, secretPatch(services, change), new Date());
  } catch (error) {
    throw error instanceof SecretNameTaken ? new SecretError(409, error.message) : error;
  }
  if (updated === null) {
    throw new SecretError(404, "secret not found");
  }
  await services.runSecrets?.secretChanged(held.row.id);
  return secretMetadata(updated, held.viewer);
}

/** The access asked for, with the grants in guilds the viewer cannot see kept: they cannot name them. */
function keepUnseenGrants(held: HeldSecret, access: SecretAccess): SecretAccess {
  if (access.org_wide) {
    return access;
  }
  const unseen = held.row.grants.filter((grant) => !grantSeen(grant, held.viewer.visibleGuildIds));
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
  requested: SecretAccessRequest,
): Promise<Secret> {
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
  await services.runSecrets?.secretAccessChanged([
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
  await services.runSecrets?.secretAccessChanged(reached);
}
