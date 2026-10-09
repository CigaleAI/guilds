import { Buffer } from "node:buffer";
import { runCommand } from "./shell.js";
import { argString, functionSchema } from "./schema.js";
import { identityOutput } from "./output.js";
import type { Tool, ToolContext } from "./types.js";

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

async function run(ctx: ToolContext, spec: Record<string, unknown>): Promise<string> {
  return runCommand(ctx, encodeSpec(spec), { timeoutSeconds: BROWSER_TIMEOUT_SECONDS });
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  handler: (ctx: ToolContext, args: Record<string, unknown>) => Promise<string>,
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
  "Navigate the sandbox Chromium tab to a URL. Call browser_snapshot " +
    "afterward to read the page and pick locators.",
  { url: { type: "string" } },
  ["url"],
  (ctx, args) => run(ctx, { op: "navigate", url: argString(args, "url") }),
);

export const browserSnapshot = tool(
  "browser_snapshot",
  "Return the current page URL, title, and accessibility snapshot. " +
    "Use locators from this snapshot for browser_click, browser_type, " +
    "and browser_fill (CSS, role=..., or text=...).",
  {},
  [],
  (ctx) => run(ctx, { op: "snapshot" }),
);

export const browserClick = tool(
  "browser_click",
  'Click a locator from the latest browser_snapshot (CSS, ' +
    'role=button[name="Go"], or text=...).',
  { target: { type: "string" } },
  ["target"],
  (ctx, args) => run(ctx, { op: "click", target: argString(args, "target") }),
);

export const browserType = tool(
  "browser_type",
  "Type text into a locator from the latest browser_snapshot " +
    "(CSS, role=..., or text=...).",
  { target: { type: "string" }, text: { type: "string" } },
  ["target", "text"],
  (ctx, args) => run(ctx, { op: "type", target: argString(args, "target"), text: argString(args, "text") }),
);

export const browserFill = tool(
  "browser_fill",
  "Fill a form field locator from the latest browser_snapshot, " +
    "replacing its current value (CSS, role=..., or text=...).",
  { target: { type: "string" }, value: { type: "string" } },
  ["target", "value"],
  (ctx, args) => run(ctx, { op: "fill", target: argString(args, "target"), value: argString(args, "value") }),
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
  (ctx, args) => {
    const spec: Record<string, unknown> = { op: "scroll", direction: argString(args, "direction") };
    const target = argString(args, "target").trim();
    if (target) {
      spec.target = target;
    }
    return run(ctx, spec);
  },
);

export const browserScreenshot = tool(
  "browser_screenshot",
  "Save a JPEG of the current page to /home/agent/screenshots/latest.jpg " +
    "and return that path.",
  {},
  [],
  (ctx) => run(ctx, { op: "screenshot" }),
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
  (ctx, args) => run(ctx, { op: "evaluate", expression: argString(args, "expression") }),
);
