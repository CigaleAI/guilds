import { clearHarnessLogin, markHarnessLogin } from "../db/agents.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import { mergeRunMetadata, updateRunScripts } from "../db/runs.js";
import type { ArtifactFiles } from "../artifacts/files.js";
import type { Issues } from "../issues/index.js";
import type { NotesStore } from "../notes/store.js";
import type { Schedules } from "../schedules/service.js";
import type { Scripts } from "../scripts/catalog.js";
import type { ToolArtifacts } from "./artifacts.js";
import type { GroupChat } from "./types.js";

/** What the tools call, built once where the loop is composed; null for a service the caller has none of. */
export type ToolServices = {
  notes: NotesStore | null;
  artifacts: ToolArtifacts | null;
  /** The shared files, reached with the run's `artifact_actor`. */
  files: ArtifactFiles | null;
  group_chat: GroupChat | null;
  issues: Issues | null;
  schedules: Schedules | null;
  scripts: Scripts | null;
  /** Where the tools keep the run's state: its pinned scripts, its harness task, and the agent's harness logins. */
  db: ToolboxDatabase | null;
  /** The runs' streams, where a running tool call publishes its progress. */
  events: ToolEvents | null;
};

/** The db/ functions the tools keep their run's state and its agent's harness logins through. */
export type ToolboxDatabase = {
  updateRunScripts: BoundQuery<typeof updateRunScripts>;
  mergeRunMetadata: BoundQuery<typeof mergeRunMetadata>;
  markHarnessLogin: BoundQuery<typeof markHarnessLogin>;
  clearHarnessLogin: BoundQuery<typeof clearHarnessLogin>;
};

/** A db/ function with its connection bound. */
type BoundQuery<F> = F extends (db: Queryable, ...args: infer A) => infer R ? (...args: A) => R : never;

/** The toolbox's db/ functions on `db`. */
function toolboxDatabase(db: Queryable): ToolboxDatabase {
  return {
    updateRunScripts: bindQuery(db, updateRunScripts),
    mergeRunMetadata: bindQuery(db, mergeRunMetadata),
    markHarnessLogin: bindQuery(db, markHarnessLogin),
    clearHarnessLogin: bindQuery(db, clearHarnessLogin),
  };
}

/** What the tools call beside their database. */
export type ToolServicesBesideDatabase = Omit<ToolServices, "db">;

/** The tools' services: `services`, with the toolbox's db/ functions on `db` as their database. */
export function toolServices(db: Queryable, services: ToolServicesBesideDatabase): ToolServices {
  return { ...services, db: toolboxDatabase(db) };
}

/** The stream a run's subscribers read, which a running tool call publishes its progress on. */
export type ToolEvents = {
  publish(runId: string, event: string, data: Record<string, unknown>): Promise<void>;
};
