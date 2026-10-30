import type { ToolboxDatabase, ToolEvents, ToolServices } from "../../src/toolbox/services.js";
import { createToolRun, type ToolHooks, type ToolInvocation, type ToolRun } from "../../src/toolbox/types.js";

/** A toolbox database that writes nothing, with `overrides` in place of its functions. */
export function fakeToolboxDatabase(overrides: Partial<ToolboxDatabase> = {}): ToolboxDatabase {
  return {
    updateRunScripts: async () => {},
    mergeRunMetadata: async () => {},
    markHarnessLogin: async () => {},
    clearHarnessLogin: async () => {},
    ...overrides,
  };
}

/** A run stream that hands each event it is given to `received`. */
export function fakeToolEvents(
  received: (event: string, data: Record<string, unknown>) => Promise<void> | void = () => {},
): ToolEvents {
  return {
    publish: async (_runId, event, data) => {
      await received(event, data);
    },
  };
}

/** A call of the tool `name` with `args`, as the model makes it, under the provider id `id`. */
export function toolInvocation(name: string, args: Record<string, unknown> = {}, id = "call_1"): ToolInvocation {
  return { id, name, arguments: args, exit_code: null, metadata: null };
}

/** What a test sets up a run's tools with: the run's fields, and any service or hook it gives. */
export type ToolFixtureFields = Pick<ToolRun, "run_id" | "agent_id" | "guild_id" | "sandbox" | "secrets"> &
  Partial<ToolRun & ToolHooks & ToolServices>;

/** The services, the run record, and the hooks a test calls its tools with. */
export type ToolFixture = { services: ToolServices; run: ToolRun; hooks: ToolHooks };

/** The services, run record, and hooks of `fields`; what it leaves out is null or the run's default. */
export function toolFixture(fields: ToolFixtureFields): ToolFixture {
  const {
    notes = null,
    artifacts = null,
    files = null,
    group_chat = null,
    issues = null,
    schedules = null,
    scripts = null,
    db = null,
    events = null,
    track_command = null,
    ensure_browser = null,
    before_command = null,
    secret_store = null,
    ...run
  } = fields;
  return {
    services: { notes, artifacts, files, group_chat, issues, schedules, scripts, db, events },
    run: createToolRun(run),
    hooks: { track_command, ensure_browser, before_command, secret_store },
  };
}
