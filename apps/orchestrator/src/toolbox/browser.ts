import { Buffer } from "node:buffer";
import { commandOutput, executeCommand } from "./shell.js";
import { argString, functionSchema } from "./schema.js";
import { identityOutput } from "./output.js";
import type { Tool, ToolContext, ToolInvocation } from "./types.js";

export const BROWSER_TOOLS = [
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_fill",
  "browser_scroll",
  "browser_screenshot",
  "browser_eval",
] as const;
export const BROWSER_TIMEOUT_SECONDS = 60;
export const HELPER = "/usr/local/bin/guilds-browser";

export function encodeSpec(spec: Record<string, unknown>): string {
  const blob = Buffer.from(JSON.stringify(spec), "utf8").toString("base64");
  return `python3 ${HELPER} ${blob}`;
}

/** Runs one helper op against the agent's own Chrome, which starts first when it is not up. */
async function run(ctx: ToolContext, call: ToolInvocation, spec: Record<string, unknown>): Promise<string> {
  if (ctx.ensure_browser) {
    await ctx.ensure_browser();
  }
  const request = ctx.cdp_port === null ? spec : { ...spec, cdp_port: ctx.cdp_port };
  return commandOutput(call, await executeCommand(ctx, ctx, encodeSpec(request), { timeoutSeconds: BROWSER_TIMEOUT_SECONDS }));
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  handler: Tool["handler"],
): Tool {
  return {
    name,
    description,
    output_filter: identityOutput,
    filter_name: "identity",
    schema: functionSchema(name, description, properties, required),
    handler,
  };
}

export const browserNavigate = tool(
  "browser_navigate",
  "Navigate your Chromium tab to a URL. Call browser_snapshot " +
    "afterward to read the page and pick locators.",
  { url: { type: "string" } },
  ["url"],
  (ctx, call) => run(ctx, call, { op: "navigate", url: argString(call.arguments, "url") }),
);

export const browserSnapshot = tool(
  "browser_snapshot",
  "Return the current page URL, title, and accessibility snapshot. " +
    "Use locators from this snapshot for browser_click, browser_type, " +
    "and browser_fill (CSS, role=..., or text=...).",
  {},
  [],
  (ctx, call) => run(ctx, call, { op: "snapshot" }),
);

export const browserClick = tool(
  "browser_click",
  'Click a locator from the latest browser_snapshot (CSS, ' +
    'role=button[name="Go"], or text=...).',
  { target: { type: "string" } },
  ["target"],
  (ctx, call) => run(ctx, call, { op: "click", target: argString(call.arguments, "target") }),
);

export const browserType = tool(
  "browser_type",
  "Type text into a locator from the latest browser_snapshot " +
    "(CSS, role=..., or text=...).",
  { target: { type: "string" }, text: { type: "string" } },
  ["target", "text"],
  (ctx, call) =>
    run(ctx, call, { op: "type", target: argString(call.arguments, "target"), text: argString(call.arguments, "text") }),
);

export const browserFill = tool(
  "browser_fill",
  "Fill a form field locator from the latest browser_snapshot, " +
    "replacing its current value (CSS, role=..., or text=...).",
  { target: { type: "string" }, value: { type: "string" } },
  ["target", "value"],
  (ctx, call) =>
    run(ctx, call, { op: "fill", target: argString(call.arguments, "target"), value: argString(call.arguments, "value") }),
);

export const browserScroll = tool(
  "browser_scroll",
  "Scroll one viewport up, down, left, or right. Prefers a visible list " +
    "panel (overflow) over the window. Optional target is a locator from " +
    "browser_snapshot to pick the panel (CSS, role=..., or text=...). " +
    "The result names the container and how much remains.",
  {
    direction: { type: "string", enum: ["up", "down", "left", "right"] },
    target: { type: "string" },
  },
  ["direction"],
  (ctx, call) => {
    const spec: Record<string, unknown> = { op: "scroll", direction: argString(call.arguments, "direction") };
    const target = argString(call.arguments, "target").trim();
    if (target) {
      spec.target = target;
    }
    return run(ctx, call, spec);
  },
);

export const browserScreenshot = tool(
  "browser_screenshot",
  "Save a JPEG of the current page to screenshots/latest.jpg in your home " +
    "and return that path.",
  {},
  [],
  (ctx, call) => run(ctx, call, { op: "screenshot" }),
);

const EVAL_DESCRIPTION =
  "Run JavaScript in the current page (same origin, cookies, and DOM). " +
  "expression is the body of an async function; use return to send a " +
  "JSON-serializable value back. DOM nodes and functions are not " +
  "serializable. console.log is not captured. To collect matching links " +
  "or file text, return them; this tool does not write Chrome downloads " +
  "into the workspace. To reuse a snippet later, write it to an agent " +
  "note with note_write and read it back with note_get before calling " +
  "this tool. Do not use script_create for page JavaScript.";

export const browserEval = tool(
  "browser_eval",
  EVAL_DESCRIPTION,
  { expression: { type: "string" } },
  ["expression"],
  (ctx, call) => run(ctx, call, { op: "evaluate", expression: argString(call.arguments, "expression") }),
);
