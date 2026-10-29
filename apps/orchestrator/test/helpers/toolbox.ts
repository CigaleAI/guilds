import type { ToolboxDatabase, ToolEvents } from "../../src/toolbox/services.js";
import type { ToolInvocation } from "../../src/toolbox/types.js";

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
