import { Buffer } from "node:buffer";
import { Type } from "typebox";
import { commandOutput, executeCommand } from "./shell.js";
import { nativeTool, type ToolHooks, type ToolInvocation, type ToolRun } from "./types.js";

/** The step-by-step browser tools: the run drives the agent's Chrome one action at a time. */
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
/** The tool that delegates a whole web task on the agent's Chrome to the agent-optimized browser. */
export const BROWSE_TOOL = "browse";
/** The browser tools of the agent-optimized browser: `browse`, and `browser_eval` for page scripts. */
export const OPTIMIZED_BROWSER_TOOLS = [BROWSE_TOOL, "browser_eval"] as const;
export const BROWSER_TIMEOUT_SECONDS = 60;
export const HELPER = "/usr/local/bin/guilds-browser";

/** One op of the browser helper, as it reads it: what to do, and the locator, text, or script the op takes. */
export type BrowserOp =
  | { op: "navigate"; url: string }
  | { op: "snapshot" }
  | { op: "click"; target: string }
  | { op: "type"; target: string; text: string }
  | { op: "fill"; target: string; value: string }
  | { op: "scroll"; direction: string; target?: string }
  | { op: "screenshot" }
  | { op: "evaluate"; expression: string };

/** A browser op as the helper is sent it: the op, and the DevTools port of the agent's Chrome when it has its own. */
type BrowserRequest = BrowserOp & { cdp_port?: number };

export function encodeSpec(spec: BrowserRequest): string {
  const blob = Buffer.from(JSON.stringify(spec), "utf8").toString("base64");
  return `python3 ${HELPER} ${blob}`;
}

/** Runs one helper op against the agent's own Chrome, which starts first when it is not up. */
async function runBrowserOp(
  run: ToolRun,
  hooks: ToolHooks,
  call: ToolInvocation,
  spec: BrowserOp,
): Promise<string> {
  if (hooks.ensure_browser) {
    await hooks.ensure_browser();
  }
  const request: BrowserRequest = run.cdp_port === null ? spec : { ...spec, cdp_port: run.cdp_port };
  return commandOutput(call, await executeCommand(run, hooks, encodeSpec(request), { timeoutSeconds: BROWSER_TIMEOUT_SECONDS }));
}

/** A locator from the latest `browser_snapshot`: CSS, role=..., or text=.... */
const Locator = Type.String();

export const browserNavigate = nativeTool({
  name: "browser_navigate",
  description:
    "Navigate your Chromium tab to a URL. Call browser_snapshot " +
    "afterward to read the page and pick locators.",
  parameters: Type.Object({ url: Type.String() }),
  handler: (_services, run, hooks, call) => runBrowserOp(run, hooks, call, { op: "navigate", url: call.arguments.url }),
});

export const browserSnapshot = nativeTool({
  name: "browser_snapshot",
  description:
    "Return the current page URL, title, and accessibility snapshot. " +
    "Use locators from this snapshot for browser_click, browser_type, " +
    "and browser_fill (CSS, role=..., or text=...).",
  parameters: Type.Object({}),
  handler: (_services, run, hooks, call) => runBrowserOp(run, hooks, call, { op: "snapshot" }),
});

export const browserClick = nativeTool({
  name: "browser_click",
  description:
    'Click a locator from the latest browser_snapshot (CSS, ' +
    'role=button[name="Go"], or text=...).',
  parameters: Type.Object({ target: Locator }),
  handler: (_services, run, hooks, call) => runBrowserOp(run, hooks, call, { op: "click", target: call.arguments.target }),
});

export const browserType = nativeTool({
  name: "browser_type",
  description:
    "Type text into a locator from the latest browser_snapshot " +
    "(CSS, role=..., or text=...).",
  parameters: Type.Object({ target: Locator, text: Type.String() }),
  handler: (_services, run, hooks, call) => {
    const { target, text } = call.arguments;
    return runBrowserOp(run, hooks, call, { op: "type", target, text });
  },
});

export const browserFill = nativeTool({
  name: "browser_fill",
  description:
    "Fill a form field locator from the latest browser_snapshot, " +
    "replacing its current value (CSS, role=..., or text=...).",
  parameters: Type.Object({ target: Locator, value: Type.String() }),
  handler: (_services, run, hooks, call) => {
    const { target, value } = call.arguments;
    return runBrowserOp(run, hooks, call, { op: "fill", target, value });
  },
});

export const browserScroll = nativeTool({
  name: "browser_scroll",
  description:
    "Scroll one viewport up, down, left, or right. Prefers a visible list " +
    "panel (overflow) over the window. Optional target is a locator from " +
    "browser_snapshot to pick the panel (CSS, role=..., or text=...). " +
    "The result names the container and how much remains.",
  parameters: Type.Object({
    direction: Type.String({ enum: ["up", "down", "left", "right"] }),
    target: Type.Optional(Locator),
  }),
  handler: (_services, run, hooks, call) => {
    const { direction } = call.arguments;
    const target = call.arguments.target?.trim();
    return runBrowserOp(run, hooks, call, { op: "scroll", direction, ...(target ? { target } : {}) });
  },
});

export const browserScreenshot = nativeTool({
  name: "browser_screenshot",
  description:
    "Save a JPEG of the current page to screenshots/latest.jpg in your home " +
    "and return that path.",
  parameters: Type.Object({}),
  handler: (_services, run, hooks, call) => runBrowserOp(run, hooks, call, { op: "screenshot" }),
});

const EVAL_DESCRIPTION =
  "Run JavaScript in the current page (same origin, cookies, and DOM). " +
  "expression is the body of an async function; use return to send a " +
  "JSON-serializable value back. DOM nodes and functions are not " +
  "serializable. console.log is not captured. To collect matching links " +
  "or file text, return them; this tool does not write Chrome downloads " +
  "into the workspace. To reuse a snippet later, write it to an agent " +
  "note with note_write and read it back with note_get before calling " +
  "this tool. Do not use script_create for page JavaScript.";

export const browserEval = nativeTool({
  name: "browser_eval",
  description: EVAL_DESCRIPTION,
  parameters: Type.Object({ expression: Type.String() }),
  handler: (_services, run, hooks, call) => runBrowserOp(run, hooks, call, { op: "evaluate", expression: call.arguments.expression }),
});
