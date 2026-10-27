import type { InferSelectModel } from "drizzle-orm";
import type { ChangeActor } from "../lib/change-actor.js";
import { newId } from "../lib/ids.js";
import { type Queryable, stamp } from "./pg.js";
import type { artifactAccess } from "./schema/index.js";

type AccessRow = InferSelectModel<typeof artifactAccess>;

/** A mode an access list gives: `read` or `write`. */
export type ArtifactMode = Exclude<AccessRow["mode"], "none">;

/** What an access list row names: a note, a file, or a collection. */
export type AccessTargetRef = { kind: AccessRow["target_kind"]; id: string };

/** One row of an access list as written: its subject and the mode it gives. */
export type AccessGrantRow = { type: AccessRow["subject_type"]; id: string; mode: AccessRow["mode"] };

/** One row of an item's access list, with the name of its subject and the guild it sits in. */
export type AccessEntryRow = {
  type: AccessRow["subject_type"];
  id: string;
  mode: AccessRow["mode"];
  name: string;
  guild_id: string | null;
  guild_name: string | null;
};

/**
 * Who reads: the organisation, guild, and agent it reads as, whether it is the operator, and the
 * guilds and agents it never reaches.
 */
export type ArtifactReader = {
  orgId: string;
  guildId: string | null;
  agentId: string | null;
  operator: boolean;
  hidden: { guildIds: readonly string[]; agentIds: readonly string[] };
};

/**
 * The SQL for an agent's mode on the item of `kind` whose id is the SQL `targetId`: its own row
 * when it has one, otherwise the better of its guild's row and its organisation's. It yields
 * `none` for an agent row that shuts the agent out, and NULL when no row reaches it. `max` picks
 * `write` over `read`, and guild and organisation rows are never `none`.
 */
export function agentModeSql(
  kind: AccessRow["target_kind"],
  targetId: string,
  reader: ArtifactReader,
  values: unknown[],
): string {
  values.push(kind, reader.agentId ?? "", reader.guildId ?? "", reader.orgId);
  const org = values.length;
  const [target, agent, guild] = [org - 3, org - 2, org - 1];
  return `COALESCE(
      (SELECT x.mode FROM artifact_access x
        WHERE x.target_kind = $${target} AND x.target_id = ${targetId}
          AND x.subject_type = 'agent' AND x.subject_id = $${agent}),
      (SELECT max(x.mode) FROM artifact_access x
        WHERE x.target_kind = $${target} AND x.target_id = ${targetId}
          AND ((x.subject_type = 'guild' AND x.subject_id = $${guild})
               OR (x.subject_type = 'org' AND x.subject_id = $${org}))))`;
}

/** The mode an agent's access list rows give it on one item, or null when no row reaches it. */
export async function readAgentMode(
  db: Queryable,
  reader: ArtifactReader,
  target: AccessTargetRef,
): Promise<AccessRow["mode"] | null> {
  const values: unknown[] = [target.id];
  const result = await db.query<{ mode: AccessRow["mode"] | null }>(
    `SELECT ${agentModeSql(target.kind, "$1", reader, values)} AS mode`,
    values,
  );
  return result.rows[0]?.mode ?? null;
}

/** An item's access list: the organisation first, then guilds, then agents by guild. */
export async function listAccessEntries(db: Queryable, target: AccessTargetRef): Promise<AccessEntryRow[]> {
  const result = await db.query<AccessEntryRow>(
    `SELECT x.subject_type AS type, x.subject_id AS id, x.mode,
            COALESCE(o.name, g.name, ag.name, x.subject_id) AS name,
            COALESCE(g.id, ag.guild_id) AS guild_id,
            COALESCE(g.name, agg.name) AS guild_name
       FROM artifact_access x
       LEFT JOIN orgs o ON x.subject_type = 'org' AND o.id = x.subject_id
       LEFT JOIN guilds g ON x.subject_type = 'guild' AND g.id = x.subject_id
       LEFT JOIN agents ag ON x.subject_type = 'agent' AND ag.id = x.subject_id
       LEFT JOIN guilds agg ON agg.id = ag.guild_id
      WHERE x.target_kind = $1 AND x.target_id = $2
      ORDER BY CASE x.subject_type WHEN 'org' THEN 0 WHEN 'guild' THEN 1 ELSE 2 END, guild_name, name`,
    [target.kind, target.id],
  );
  return result.rows;
}

/** Writes one subject's row on an item's access list, replacing the mode a row of it already gives. */
export async function upsertAccessRow(
  db: Queryable,
  target: AccessTargetRef & { orgId: string },
  grant: AccessGrantRow,
  actor: ChangeActor,
): Promise<void> {
  await db.query(
    `INSERT INTO artifact_access (
       id, org_id, target_kind, target_id, subject_type, subject_id, mode,
       created_by_type, created_by_id, created_by_name, created_at,
       updated_by_type, updated_by_id, updated_by_name, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$8,$9,$10,$11)
     ON CONFLICT (target_kind, target_id, subject_type, subject_id)
     DO UPDATE SET mode = EXCLUDED.mode, updated_by_type = EXCLUDED.updated_by_type,
                   updated_by_id = EXCLUDED.updated_by_id, updated_by_name = EXCLUDED.updated_by_name,
                   updated_at = EXCLUDED.updated_at`,
    [
      newId("aacc"),
      target.orgId,
      target.kind,
      target.id,
      grant.type,
      grant.id,
      grant.mode,
      actor.actorType,
      actor.actorId,
      actor.actorName,
      stamp(new Date()),
    ],
  );
}

/** Removes one subject's row from an item's access list. */
export async function deleteAccessRow(
  db: Queryable,
  target: AccessTargetRef,
  subject: Pick<AccessGrantRow, "type" | "id">,
): Promise<void> {
  await db.query(
    `DELETE FROM artifact_access
      WHERE target_kind = $1 AND target_id = $2 AND subject_type = $3 AND subject_id = $4`,
    [target.kind, target.id, subject.type, subject.id],
  );
}

/** Removes an item's whole access list. */
export async function deleteAccessList(db: Queryable, target: AccessTargetRef): Promise<void> {
  await db.query(`DELETE FROM artifact_access WHERE target_kind = $1 AND target_id = $2`, [
    target.kind,
    target.id,
  ]);
}

/** The name of an access subject of the organisation, and the guild it sits in; null when it has none such. */
const SUBJECT_SQL: Record<AccessRow["subject_type"], string> = {
  org: `SELECT name, NULL::text AS guild_id FROM orgs WHERE id = $1 AND id = $2`,
  guild: `SELECT name, id AS guild_id FROM guilds WHERE id = $1 AND org_id = $2`,
  agent: `SELECT name, guild_id FROM agents WHERE id = $1 AND org_id = $2`,
};

export async function getAccessSubject(
  db: Queryable,
  orgId: string,
  subject: Pick<AccessGrantRow, "type" | "id">,
): Promise<{ name: string; guild_id: string | null } | null> {
  const result = await db.query<{ name: string; guild_id: string | null }>(SUBJECT_SQL[subject.type], [
    subject.id,
    orgId,
  ]);
  return result.rows[0] ?? null;
}
