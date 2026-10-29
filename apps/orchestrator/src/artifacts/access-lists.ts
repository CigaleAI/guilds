import { getAccessSubject, listAccessEntries } from "../db/artifact-access.js";
import { getLiveArtifact, listReachedNotes } from "../db/artifacts.js";
import { recordConfigChange, type ConfigChange } from "../db/config-changes.js";
import { type Queryable, withTransaction } from "../db/pg.js";
import {
  type AccessRaise,
  accessRaises,
  diffGrants,
  grantKey,
  grantSummary,
  parseGrant,
  parseGrants,
  subjectAt,
} from "./access.js";
import { accessibleCollections, assertOperator, collectionView, loadCollectionById } from "./collections.js";
import { ArtifactError } from "./errors.js";
import { removeGrants, writeGrants } from "./grants.js";
import { reachesOwner, type ArtifactStore, type ReachedNote, type ReachedTable, rowDisplayPath } from "./store.js";
import type { AccessMode } from "../db/schema/index.js";
import {
  type AccessEntry,
  type AccessGrant,
  type AccessList,
  type AccessSubject,
  type AccessTarget,
  type AgentAccessMode,
  type ArtifactActor,
} from "./types.js";

/** An item whose access list is being changed, as its change-log entries name it. */
type AccessItem = {
  target: AccessTarget;
  orgId: string;
  guildId: string | null;
  /** The agent that owns an agent-level note, which always writes it. */
  ownerAgentId: string | null;
  label: string;
};

/** How a change-log line names a subject. */
function subjectLabel(type: AccessSubject, name: string): string {
  return type === "org" ? "the organisation" : `${type} ${name}`;
}

/** Refuses a row naming the agent that owns the item: it always writes its own note or file. */
function assertNotOwner(item: AccessItem, grant: AccessGrant, where = ""): void {
  if (grant.type === "agent" && grant.id === item.ownerAgentId) {
    throw new ArtifactError(`${where}the agent that owns the ${item.target.kind} always writes it`, 422);
  }
}

function accessChange(item: AccessItem, subject: string, mode: AgentAccessMode | null, existed: boolean): ConfigChange {
  return {
    orgId: item.orgId,
    guildId: item.guildId,
    targetKind: item.target.kind,
    targetId: item.target.id,
    operation: mode === null ? "delete" : existed ? "update" : "create",
    summary: grantSummary(subject, item.label, mode),
  };
}

/** The note, file, or live collection an access call names, or a 404. */
async function requireTarget(store: ArtifactStore, actor: ArtifactActor, target: AccessTarget): Promise<AccessItem> {
  if (target.kind === "collection") {
    const collection = await loadCollectionById(store, actor, target.id);
    if (!collection) {
      throw new ArtifactError("unknown collection", 404);
    }
    return {
      target,
      orgId: collection.org_id,
      guildId: collection.guild_id,
      ownerAgentId: null,
      label: `the table ${collection.name}`,
    };
  }
  const row = await getLiveArtifact(store.db, actor.orgId, { id: target.id, kind: target.kind });
  if (!row || !reachesOwner(actor, row.level, row.owner_id)) {
    throw new ArtifactError(`${target.kind} not found`, 404);
  }
  return {
    target,
    orgId: row.org_id,
    guildId: row.guild_id,
    ownerAgentId: row.level === "agent" ? row.owner_id : null,
    label: `the ${target.kind} ${rowDisplayPath(row)}`,
  };
}

/**
 * The name of the organisation, guild, or agent a grant names. A subject
 * that does not exist, is in another organisation, or is in a guild the
 * actor cannot see is a 422 prefixed by `where`.
 */
async function requireSubject(
  store: ArtifactStore,
  actor: ArtifactActor,
  subject: { type: AccessSubject; id: string },
  where = "",
): Promise<string> {
  const row = await getAccessSubject(store.db, actor.orgId, subject);
  if (!row || (row.guild_id !== null && actor.hidden.guildIds.includes(row.guild_id))) {
    throw new ArtifactError(`${where}unknown ${subject.type}`, 422);
  }
  return row.name;
}

/** An item's access list, without the guilds, and their agents, the actor cannot see. */
async function loadEntries(db: Queryable, actor: ArtifactActor, target: AccessTarget): Promise<AccessEntry[]> {
  const entries = await listAccessEntries(db, target);
  return entries.filter((entry) => !entry.guild_id || !actor.hidden.guildIds.includes(entry.guild_id));
}

/** An item's access list, without the subjects of guilds the actor cannot see. */
export async function listAccess(store: ArtifactStore, actor: ArtifactActor, target: AccessTarget): Promise<AccessEntry[]> {
  return (await accessList(store, actor, target)).subjects;
}

/** An item's access list with the agent that owns it, when one does. */
export async function accessList(store: ArtifactStore, actor: ArtifactActor, target: AccessTarget): Promise<AccessList> {
  assertOperator(actor);
  const item = await requireTarget(store, actor, target);
  return { subjects: await loadEntries(store.db, actor, target), owner_agent_id: item.ownerAgentId };
}

/**
 * Replaces an item's access list with `subjects`, the full list, and logs
 * one change per subject whose row changes. The rows of subjects in guilds
 * the actor cannot see stay as they are. Only the subjects whose row is
 * written must exist, so a row whose subject is gone can still be removed.
 */
export async function replaceAccess(
  store: ArtifactStore,
  actor: ArtifactActor,
  target: AccessTarget,
  subjects: unknown,
): Promise<AccessList> {
  assertOperator(actor);
  const item = await requireTarget(store, actor, target);
  const wanted = parseGrants(subjects);
  return withTransaction(store.db, async (client) => {
    const before = await loadEntries(client, actor, target);
    const names = new Map(before.map((entry) => [grantKey(entry), subjectLabel(entry.type, entry.name)]));
    const { upserts, removals } = diffGrants(before, wanted);
    for (const grant of upserts) {
      const where = subjectAt(wanted.indexOf(grant));
      assertNotOwner(item, grant, where);
      names.set(grantKey(grant), subjectLabel(grant.type, await requireSubject(store, actor, grant, where)));
    }
    const known = new Set(before.map(grantKey));
    await writeGrants(client, actor, target, upserts);
    await removeGrants(client, target, removals);
    const changes = [
      ...upserts.map((grant) => accessChange(item, names.get(grantKey(grant)) ?? grant.id, grant.mode, known.has(grantKey(grant)))),
      ...removals.map((grant) => accessChange(item, names.get(grantKey(grant)) ?? grant.id, null, true)),
    ];
    for (const change of changes) {
      await recordConfigChange(client, actor, change);
    }
    return { subjects: await loadEntries(client, actor, target), owner_agent_id: item.ownerAgentId };
  });
}

/** One subject's row a change sets on an item's access list; a null mode removes the row. */
export type AccessRowChange = { type: AccessSubject; id: string; mode: AgentAccessMode | null };

/**
 * Sets one subject's row on an item, or removes it when the row's `mode` is null, and
 * logs the change. Only a subject whose row is written must exist.
 */
export async function grantAccess(
  store: ArtifactStore,
  actor: ArtifactActor,
  target: AccessTarget,
  row: AccessRowChange,
): Promise<void> {
  assertOperator(actor);
  const item = await requireTarget(store, actor, target);
  const mode = row.mode;
  const grant = parseGrant({ type: row.type, id: row.id, mode: mode ?? "read" });
  await withTransaction(store.db, async (client) => {
    const before = (await loadEntries(client, actor, target)).find((entry) => grantKey(entry) === grantKey(grant));
    if ((before?.mode ?? null) === mode) {
      return;
    }
    let name = before?.name ?? grant.id;
    if (mode === null) {
      await removeGrants(client, target, [grant]);
    } else {
      assertNotOwner(item, grant);
      name = await requireSubject(store, actor, grant);
      await writeGrants(client, actor, target, [{ ...grant, mode }]);
    }
    await recordConfigChange(client, actor, accessChange(item, subjectLabel(grant.type, name), mode, before !== undefined));
  });
}

/**
 * What a guild or an agent reaches: the notes and tables its rows give it,
 * with the mode it ends up with. An agent also reaches its own notes. A
 * guild reaches what its own and its organisation's rows give.
 */
export async function reachOf(
  store: ArtifactStore,
  actor: ArtifactActor,
  subject: { type: "guild" | "agent"; id: string; guildId: string },
): Promise<{ notes: ReachedNote[]; tables: ReachedTable[] }> {
  assertOperator(actor);
  const reacher: ArtifactActor = {
    ...actor,
    operator: false,
    guildId: subject.guildId,
    agentId: subject.type === "agent" ? subject.id : null,
  };
  return { notes: await reachedNotes(store, actor, reacher), tables: await reachedTables(store, actor, reacher) };
}

/** The live notes `reacher` reads, without those of guilds `actor` cannot see. */
async function reachedNotes(store: ArtifactStore, actor: ArtifactActor, reacher: ArtifactActor): Promise<ReachedNote[]> {
  return (await listReachedNotes(store.db, actor, reacher)).map((row) => ({
    id: row.id,
    display_path: rowDisplayPath(row),
    title: row.title ?? row.key,
    level: row.level,
    owner_id: row.owner_id,
    owner_name: row.owner_name,
    guild_id: row.guild_id,
    mode: row.access,
  }));
}

/** The live tables `reacher` reads, without those of guilds `actor` cannot see. */
async function reachedTables(store: ArtifactStore, actor: ArtifactActor, reacher: ArtifactActor): Promise<ReachedTable[]> {
  const visible = new Set((await accessibleCollections(store, actor)).map((item) => item.row.id));
  return (await accessibleCollections(store, reacher))
    .filter((item) => visible.has(item.row.id))
    .map((item) => {
      const view = collectionView(item.row, item.mode);
      return {
        id: view.id,
        name: view.name,
        purpose: view.purpose,
        display_path: view.display_path,
        scope: view.scope,
        guild: view.guild,
        mode: item.mode,
      };
    });
}

/**
 * The rows of an item's access list that reach one guild: its own row, its agents' rows, and
 * the organisation's row. A null mode means the list has no such row.
 */
export type GuildAccess = { guild: AccessMode | null; org: AccessMode | null; agents: Map<string, AgentAccessMode> };

/** The modes a proposal gives a guild's row: `none` removes the row. */
export const GUILD_ROW_MODES = ["read", "write", "none"] as const;
export type GuildRowMode = (typeof GUILD_ROW_MODES)[number];

/** The modes a proposal gives an agent's row: `none` shuts the agent out, `inherit` removes the row so the agent takes its guild's mode. */
export const AGENT_ROW_MODES = ["read", "write", "none", "inherit"] as const;
export type AgentRowMode = (typeof AGENT_ROW_MODES)[number];

export function isGuildRowMode(value: unknown): value is GuildRowMode {
  return GUILD_ROW_MODES.some((mode) => mode === value);
}

export function isAgentRowMode(value: unknown): value is AgentRowMode {
  return AGENT_ROW_MODES.some((mode) => mode === value);
}

/** The rows a proposal names among those that reach a guild: the guild's own, null to leave it, and some of its agents'. */
export type GuildAccessProposal = { guild: GuildRowMode | null; agents: Array<{ id: string; mode: AgentRowMode }> };

/** The rows that reach a guild once a proposal is applied, and the row changes that get them there. */
export type GuildAccessPlan = { access: GuildAccess; rowChanges: AccessRowChange[] };

/**
 * What a proposal does to the rows that reach guild `guildId`: only the subjects it names change,
 * and a subject's row changes only when its mode differs from `base`. The organisation's row stays.
 */
export function planGuildAccess(base: GuildAccess, guildId: string, proposal: GuildAccessProposal): GuildAccessPlan {
  const access: GuildAccess = { guild: base.guild, org: base.org, agents: new Map(base.agents) };
  const rowChanges: AccessRowChange[] = [];
  if (proposal.guild !== null) {
    const mode = proposal.guild === "none" ? null : proposal.guild;
    if (mode !== access.guild) {
      access.guild = mode;
      rowChanges.push({ type: "guild", id: guildId, mode });
    }
  }
  for (const agent of proposal.agents) {
    const mode = agent.mode === "inherit" ? null : agent.mode;
    if (mode === (access.agents.get(agent.id) ?? null)) {
      continue;
    }
    if (mode === null) access.agents.delete(agent.id);
    else access.agents.set(agent.id, mode);
    rowChanges.push({ type: "agent", id: agent.id, mode });
  }
  return { access, rowChanges };
}

/** Raises an item's access list as the operator to what `raise` names, writing only the rows `accessRaises` gives. */
export async function raiseAccess(store: ArtifactStore, actor: ArtifactActor, target: AccessTarget, raise: AccessRaise): Promise<void> {
  const entries = await listAccess(store, actor, target);
  for (const grant of accessRaises(entries, raise)) {
    await grantAccess(store, actor, target, grant);
  }
}
