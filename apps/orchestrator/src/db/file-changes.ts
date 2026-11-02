import type { InferSelectModel } from "drizzle-orm";
import type { ChangeActor } from "../lib/change-actor.js";
import { newId } from "../lib/ids.js";
import { actorColumns, type ChangeLink, studioLink } from "./config-changes.js";
import { type Queryable, stamp } from "./pg.js";
import type { agents, fileChanges, runs } from "./schema/index.js";
import { iso, isoOrNull } from "./views.js";

type Run = InferSelectModel<typeof runs>;

/** A change with the run that made it, when a run did. */
type FileChangeRow = Omit<InferSelectModel<typeof fileChanges>, "org_id"> & {
  run_agent_id: Run["agent_id"] | null;
  run_kind: Run["kind"] | null;
  run_status: Run["status"] | null;
  run_schedule_id: Run["schedule_id"] | null;
  run_created_at: Run["created_at"] | null;
  run_guild_id: InferSelectModel<typeof agents>["guild_id"] | null;
};

export type FileChangeOperation = FileChangeRow["operation"];

/** One change to a file to record: the file, what the operation did, and the version it left. */
export type NewFileChange = {
  orgId: string;
  artifactId?: string;
  taskAgentId?: string;
  displayPath: string;
  operation: FileChangeOperation;
  version: number;
  createdAt?: Date;
};

export async function recordFileChange(
  db: Queryable,
  actor: ChangeActor,
  args: NewFileChange,
): Promise<string> {
  const id = newId("fchg");
  await db.query(
    `INSERT INTO file_changes (
       id, org_id, artifact_id, task_agent_id, display_path, operation, version,
       actor_type, actor_id, actor_name, run_id, tool_call_id, tool_name,
       studio_session_id, studio_seq, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      id,
      args.orgId,
      args.artifactId ?? null,
      args.taskAgentId ?? null,
      args.displayPath,
      args.operation,
      args.version,
      ...actorColumns(actor),
      stamp(args.createdAt ?? new Date()),
    ],
  );
  return id;
}

export type FileChangeView = {
  id: string;
  artifact_id: string | null;
  task_agent_id: string | null;
  display_path: string;
  operation: FileChangeOperation;
  version: number;
  actor: { type: string; id: string; name: string };
  run: {
    id: string;
    agent_id: string | null;
    guild_id: string | null;
    org_id: string;
    kind: string | null;
    status: string | null;
    schedule_id: string | null;
    created_at: string | null;
  } | null;
  tool: { call_id: string; name: string | null } | null;
  /** The coach message the change was applied from, for an edit applied in the Studio. */
  studio: ChangeLink | null;
  created_at: string;
};

const CHANGE_SELECT = `
  SELECT fc.id, fc.artifact_id, fc.task_agent_id, fc.display_path,
         fc.operation, fc.version, fc.actor_type, fc.actor_id, fc.actor_name,
         fc.run_id, fc.tool_call_id, fc.tool_name, fc.studio_session_id, fc.studio_seq, fc.created_at,
         r.agent_id AS run_agent_id, r.kind AS run_kind, r.status AS run_status,
         r.schedule_id AS run_schedule_id, r.created_at AS run_created_at,
         a.guild_id AS run_guild_id
    FROM file_changes fc
    LEFT JOIN runs r ON r.id = fc.run_id
    LEFT JOIN agents a ON a.id = r.agent_id`;

function mapChange(orgId: string, row: FileChangeRow): FileChangeView {
  return {
    id: row.id,
    artifact_id: row.artifact_id,
    task_agent_id: row.task_agent_id,
    display_path: row.display_path,
    operation: row.operation,
    version: row.version,
    actor: { type: row.actor_type, id: row.actor_id, name: row.actor_name },
    run: row.run_id
      ? {
          id: row.run_id,
          agent_id: row.run_agent_id || null,
          guild_id: row.run_guild_id || null,
          org_id: orgId,
          kind: row.run_kind || null,
          status: row.run_status || null,
          schedule_id: row.run_schedule_id || null,
          created_at: isoOrNull(row.run_created_at),
        }
      : null,
    tool: row.tool_call_id ? { call_id: row.tool_call_id, name: row.tool_name || null } : null,
    studio: studioLink(row),
    created_at: iso(row.created_at),
  };
}

/**
 * What a history is read for: the artifacts whose changes it holds, live or deleted, and the agent
 * whose Task's changes it holds. A display path names one of these; it never selects changes itself,
 * since a name an item held may be held by another item later.
 */
export type ChangeTarget = { artifactIds: string[]; taskAgentId: string | null };

/** The changes of a target, newest first. */
export async function listFileChanges(db: Queryable, orgId: string, target: ChangeTarget): Promise<FileChangeView[]> {
  if (!target.artifactIds.length && target.taskAgentId === null) {
    return [];
  }
  const result = await db.query<FileChangeRow>(
    `SELECT * FROM (
       ${CHANGE_SELECT} WHERE fc.org_id = $1 AND fc.artifact_id = ANY($2::text[])
       UNION ALL
       ${CHANGE_SELECT} WHERE fc.org_id = $1 AND fc.task_agent_id = $3
     ) changes
     ORDER BY created_at DESC, id DESC`,
    [orgId, target.artifactIds, target.taskAgentId],
  );
  return result.rows.map((row) => mapChange(orgId, row));
}

// The newest change of each of several targets, by the display path a listing names it by, so
// a listing can label its rows with one query.
export async function listLatestFileChanges(
  db: Queryable,
  orgId: string,
  targets: ReadonlyMap<string, ChangeTarget>,
): Promise<Record<string, FileChangeView>> {
  const paths: string[] = [];
  const artifactIds: Array<string | null> = [];
  const taskAgentIds: Array<string | null> = [];
  for (const [path, target] of targets) {
    for (const id of target.artifactIds) {
      paths.push(path);
      artifactIds.push(id);
      taskAgentIds.push(null);
    }
    if (target.taskAgentId !== null) {
      paths.push(path);
      artifactIds.push(null);
      taskAgentIds.push(target.taskAgentId);
    }
  }
  if (!paths.length) {
    return {};
  }
  const result = await db.query<FileChangeRow & { requested_path: string }>(
    `SELECT DISTINCT ON (p.path) p.path AS requested_path, latest.*
       FROM unnest($2::text[], $3::text[], $4::text[]) AS p(path, artifact_id, task_agent_id)
       CROSS JOIN LATERAL (
         (${CHANGE_SELECT} WHERE fc.org_id = $1 AND fc.artifact_id = p.artifact_id
           ORDER BY fc.created_at DESC, fc.id DESC LIMIT 1)
         UNION ALL
         (${CHANGE_SELECT} WHERE fc.org_id = $1 AND fc.task_agent_id = p.task_agent_id
           ORDER BY fc.created_at DESC, fc.id DESC LIMIT 1)
       ) latest
      ORDER BY p.path, latest.created_at DESC, latest.id DESC`,
    [orgId, paths, artifactIds, taskAgentIds],
  );
  const latest: Record<string, FileChangeView> = {};
  for (const row of result.rows) {
    latest[row.requested_path] = mapChange(orgId, row);
  }
  return latest;
}
