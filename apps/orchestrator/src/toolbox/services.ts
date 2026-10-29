import { clearHarnessLogin, markHarnessLogin } from "../db/agents.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import { mergeRunMetadata, updateRunScripts } from "../db/runs.js";

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
export function toolboxDatabase(db: Queryable): ToolboxDatabase {
  return {
    updateRunScripts: bindQuery(db, updateRunScripts),
    mergeRunMetadata: bindQuery(db, mergeRunMetadata),
    markHarnessLogin: bindQuery(db, markHarnessLogin),
    clearHarnessLogin: bindQuery(db, clearHarnessLogin),
  };
}

/** The stream a run's subscribers read, which a running tool call publishes its progress on. */
export type ToolEvents = {
  publish(runId: string, event: string, data: Record<string, unknown>): Promise<void>;
};
