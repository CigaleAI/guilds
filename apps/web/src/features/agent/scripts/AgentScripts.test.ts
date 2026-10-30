import assert from "node:assert/strict";
import { test } from "node:test";
import type { Script } from "../../../api/types/scripts";
import { defaultAgentConfig } from "../settings/configForm";
import { scriptCap, scriptDraft, scriptNameError, scriptNameHint } from "./AgentScripts";

const script: Script = {
  name: "send_usdc",
  description: "Pays an invoice.",
  parameters: { type: "object", properties: {} },
  source: "print('paid')",
};

test("an agent keeps its own number of scripts, and the default before it loads", () => {
  assert.equal(scriptCap({ ...defaultAgentConfig, max_scripts: 3 }), 3);
  assert.equal(scriptCap(undefined), defaultAgentConfig.max_scripts);
});

test("a script's fields fill the form, its parameters as JSON; a new script's are empty", () => {
  assert.deepEqual(scriptDraft(script), {
    name: "send_usdc",
    description: "Pays an invoice.",
    source: "print('paid')",
    parameters: '{\n  "type": "object",\n  "properties": {}\n}',
  });
  assert.deepEqual(scriptDraft({ ...script, parameters: null }).parameters, "");
  assert.deepEqual(scriptDraft(null), { name: "", description: "", source: "", parameters: "" });
});

test("a script name the server refuses says why; a valid or empty one does not", () => {
  assert.equal(scriptNameError(""), undefined);
  assert.equal(scriptNameError("send_usdc"), undefined);
  assert.equal(
    scriptNameError("Send"),
    "Lowercase letters, digits, _ and -, starting with a letter.",
  );
  assert.equal(scriptNameError("manifest"), "That name is reserved.");
});

test("the name's hint says an edited script keeps its name, and a taken name is replaced", () => {
  assert.equal(
    scriptNameHint(script, [script], "send_usdc"),
    "A script keeps its name; add a new script to use another.",
  );
  assert.equal(
    scriptNameHint(null, [script], "send_usdc"),
    "A script with this name exists; saving replaces it.",
  );
  assert.equal(scriptNameHint(null, [script], "other"), undefined);
  assert.equal(scriptNameHint(null, undefined, "send_usdc"), undefined);
});
