// The tools a connector's code runs: each one's parameters declared once as a TypeBox schema, and
// every call's arguments decoded against it before the tool's work, as a native tool's are.
import { Type, type Static, type TObject } from "typebox";
import { decodeArguments } from "../lib/tool-schema.js";
import { LIST_CAP, LIST_DEFAULT } from "./format.js";
import { ConnectorError, type Adapter, type AdapterTool, type ConnectorContext, type Credentials } from "./types.js";

/**
 * A tool a connector's code runs, as it is written: its name, the TypeBox schema of its
 * parameters, and the work it does on a call's arguments decoded against them.
 */
export type ConnectorToolDefinition<P extends TObject> = {
  name: string;
  parameters: P;
  run: (input: Static<P>, creds: Credentials, ctx: ConnectorContext) => Promise<string>;
};

/**
 * The parameters of a tool that lists rows a page at a time: the rows the page holds, which
 * `listRows` keeps within the cap, and the key of the page a previous one named.
 */
export const Paged = {
  limit: Type.Optional(Type.Integer({ description: `Rows this page. Default ${LIST_DEFAULT}, max ${LIST_CAP}.` })),
  page_key: Type.Optional(Type.String({ description: "Continue from a previous page_key." })),
};

const PagedParameters = Type.Object(Paged);

/** The arguments of a call for one page of rows. */
export type PagedArguments = Static<typeof PagedParameters>;

/** An adapter's hooks beside its tools. Its `call`, when it has one, runs a call to a name none of the tools has. */
export type AdapterHooks = Omit<Adapter, "tools">;

/** What a call whose arguments do not match its tool's parameters is refused with. */
function argumentError(problem: string): ConnectorError {
  return new ConnectorError(problem, 422);
}

/** The tool `definition` describes: its calls' arguments are decoded against its parameters before it runs. */
export function adapterTool<P extends TObject>(definition: ConnectorToolDefinition<P>): AdapterTool {
  const { name, parameters, run } = definition;
  return {
    name,
    parameters,
    call: async (args, creds, ctx) => run(decodeArguments(parameters, args, argumentError), creds, ctx),
  };
}

/**
 * The adapter of a connector whose code runs `tools`, with its other `hooks`. Its `call` runs the
 * tool a call names; a call to another name goes to the hooks' `call`, and without one is a 404
 * `ConnectorError`.
 */
export function toolsAdapter(tools: readonly AdapterTool[], hooks: AdapterHooks = {}): Adapter {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    ...hooks,
    tools,
    async call(name, args, creds, ctx) {
      const tool = byName.get(name);
      if (tool !== undefined) {
        return tool.call(args, creds, ctx);
      }
      if (hooks.call !== undefined) {
        return hooks.call(name, args, creds, ctx);
      }
      throw new ConnectorError(`unknown tool ${name}`, 404);
    },
  };
}
