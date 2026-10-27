import type { InferSelectModel } from "drizzle-orm";
import { newId } from "../lib/ids.js";
import { actorColumns, type ChangeActor, type ChangeLink, studioLink } from "./config-changes.js";
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

export async function recordFileChange(
  db: Queryable,
  actor: ChangeActor,
  args: {
    orgId: string;
    artifactId?: string;
    taskAgentId?: string;
    displayPath: string;
    operation: FileChangeOperation;
    version: number;
    createdAt?: Date;
  },
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

export async function listFileChanges(db: Queryable, orgId: string, displayPath: string): Promise<FileChangeView[]> {
  const result = await db.query<FileChangeRow>(
    `${CHANGE_SELECT}
      WHERE fc.org_id = $1 AND fc.display_path = $2
      ORDER BY fc.created_at DESC, fc.id DESC`,
    [orgId, displayPath],
  );
  return result.rows.map((row) => mapChange(orgId, row));
}

// The newest change for each of several display paths, so a listing can
// label its rows with one query.
export async function listLatestFileChanges(
  db: Queryable,
  orgId: string,
  displayPaths: string[],
): Promise<Record<string, FileChangeView>> {
  const unique = [...new Set(displayPaths.filter((path) => path))];
  if (!unique.length) {
    return {};
  }
  const result = await db.query<FileChangeRow>(
    `${CHANGE_SELECT}
      WHERE fc.id IN (
        SELECT DISTINCT ON (display_path) id
          FROM file_changes
         WHERE org_id = $1 AND display_path = ANY($2::text[])
         ORDER BY display_path, created_at DESC, id DESC
      )`,
    [orgId, unique],
  );
  const latest: Record<string, FileChangeView> = {};
  for (const row of result.rows) {
    const change = mapChange(orgId, row);
    latest[change.display_path] = change;
  }
  return latest;
}
