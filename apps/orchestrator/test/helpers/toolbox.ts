import type { ToolboxDatabase, ToolEvents } from "../../src/toolbox/services.js";

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
