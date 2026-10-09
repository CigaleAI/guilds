import assert from "node:assert/strict";
import { test } from "node:test";
import { operatorActor, type ArtifactActor } from "../../src/artifacts/index.js";
import {
  REGISTRY,
  capBytes,
  createToolContext,
  encodeSpec,
  formatExecution,
  invokeTool,
  parseArguments,
  processOutput,
  remainingAfter,
  schemasFor,
  LOW_TOOL_CALL_WRAP_UP,
  stampToolResult,
  withRemainingToolCalls,
} from "../../src/toolbox/index.js";
import { functionSchema, omitEmptyOptionalStrings } from "../../src/toolbox/schema.js";
import { HELPER } from "../../src/toolbox/browser.js";
import { Scripts } from "../../src/scripts/catalog.js";
import { CancelEvent } from "../../src/toolbox/types.js";

class MemoryScriptDB {
  rows: Array<Record<string, unknown>> = [];

  async listAgentScripts(agentId: string) {
    return this.rows.filter((row) => row.agent_id === agentId);
  }

  async upsertAgentScript(
    _actor: ArtifactActor,
    scriptId: string,
    agentId: string,
    name: string,
    description: string,
    parameters: Record<string, unknown> | null,
    source: string,
    sourceHash: string,
    now: Date,
  ) {
    const index = this.rows.findIndex((row) => row.agent_id === agentId && row.name === name);
    if (index >= 0) {
      const updated = {
        ...this.rows[index],
        description,
        parameters,
        source,
        source_hash: sourceHash,
        updated_at: now,
      };
      this.rows[index] = updated;
      return updated;
    }
    const row = {
      id: scriptId,
      agent_id: agentId,
      name,
      description,
      parameters,
      source,
      source_hash: sourceHash,
      created_at: now,
      updated_at: now,
    };
    this.rows.push(row);
    return row;
  }

  async getAgentScript(agentId: string, name: string) {
    return this.rows.find((row) => row.agent_id === agentId && row.name === name) ?? null;
  }

  async deleteAgentScript(_actor: ArtifactActor, agentId: string, name: string) {
    const index = this.rows.findIndex((row) => row.agent_id === agentId && row.name === name);
    if (index < 0) {
      return null;
    }
    return this.rows.splice(index, 1)[0] ?? null;
  }
}

function schemaRequired(name: string): unknown {
  const schema = REGISTRY[name]?.schema as {
    function: { parameters: { required: string[] } };
  };
  return schema.function.parameters.required;
}

test("omitEmptyOptionalStrings drops empty optional keys only", () => {
  const schema = {
    type: "object",
    properties: {
      tweetId: { type: "string" },
      agentId: { type: "string" },
      campaignId: { type: "string" },
      prompt: { type: "string" },
    },
    required: ["tweetId", "agentId"],
  };
  assert.deepEqual(
    omitEmptyOptionalStrings(
      {
        tweetId: "",
        agentId: "11111111-1111-1111-1111-111111111111",
        campaignId: "",
        prompt: "Reply",
      },
      schema,
    ),
    {
      tweetId: "",
      agentId: "11111111-1111-1111-1111-111111111111",
      prompt: "Reply",
    },
  );
  assert.deepEqual(
    omitEmptyOptionalStrings({ campaignId: "", keep: "x" }, { type: "object" }),
    { campaignId: "", keep: "x" },
  );
  assert.deepEqual(
    omitEmptyOptionalStrings({ extra: "", campaignId: "" }, schema),
    { extra: "" },
  );
});

test("functionSchema drops format from optional properties", () => {
  const schema = functionSchema(
    "lookup",
    "Look up a record",
    {
      id: { type: "string", format: "uuid" },
      campaignId: { type: "string", format: "uuid" },
    },
    ["id"],
  );
  const properties = (
    schema.function as {
      parameters: { properties: { id: Record<string, unknown>; campaignId: Record<string, unknown> } };
    }
  ).parameters.properties;
  assert.equal(properties.id.format, "uuid");
  assert.equal("format" in properties.campaignId, false);
  assert.match(String(properties.campaignId.description), /Omit this key when unused/);
  assert.equal("description" in properties.id, false);
});

test("script_run schema from type hints", () => {
  assert.equal("bash" in REGISTRY, false);
  assert.ok("script_run" in REGISTRY);
  assert.deepEqual(schemasFor(["script_run", "note_write"]), [
    REGISTRY.script_run!.schema,
    REGISTRY.note_write!.schema,
  ]);
  assert.deepEqual(schemaRequired("script_run"), ["name"]);
  assert.deepEqual(schemaRequired("note_find"), []);
  assert.deepEqual(schemaRequired("note_get"), ["path"]);
  assert.deepEqual(schemaRequired("record_search"), ["query"]);
  assert.deepEqual(schemaRequired("record_list"), ["collection"]);
  assert.deepEqual(schemaRequired("note_write"), ["level", "key", "content"]);
  const noteWrite = REGISTRY.note_write!.schema as {
    function: {
      description: string;
      parameters: { properties: Record<string, { description?: string }> };
    };
  };
  assert.match(noteWrite.function.description, /\.md file name/);
  assert.match(noteWrite.function.description, /notes have no folders/);
  assert.equal(noteWrite.function.parameters.properties.path, undefined);
  assert.equal(
    noteWrite.function.parameters.properties.key?.description,
    "the .md file name, for example queries.md",
  );
  assert.deepEqual(schemaRequired("group_post"), ["content"]);
  assert.deepEqual(schemaRequired("report_issue"), ["summary", "detail", "kind"]);
  const reportIssue = REGISTRY.report_issue!.schema as {
    function: { parameters: { properties: { severity: { enum: string[] } } } };
  };
  assert.deepEqual(reportIssue.function.parameters.properties.severity.enum, [
    "medium",
    "low",
    "high",
  ]);
  assert.deepEqual(schemaRequired("browser_navigate"), ["url"]);
  assert.deepEqual(schemaRequired("browser_snapshot"), []);
  assert.deepEqual(schemaRequired("browser_click"), ["target"]);
  assert.deepEqual(schemaRequired("browser_type"), ["target", "text"]);
  assert.deepEqual(schemaRequired("browser_fill"), ["target", "value"]);
  assert.deepEqual(schemaRequired("browser_scroll"), ["direction"]);
  assert.deepEqual(schemaRequired("browser_screenshot"), []);
  assert.deepEqual(schemaRequired("browser_eval"), ["expression"]);
  assert.match(String(REGISTRY.browser_eval!.description), /note_write/);
  assert.match(String(REGISTRY.browser_eval!.description), /script_create/);
  assert.equal("collection_create" in REGISTRY, false);
  assert.equal("object_put" in REGISTRY, false);
  assert.deepEqual(schemaRequired("record_add"), ["collection", "body"]);
  assert.deepEqual(schemaRequired("record_update"), ["collection", "id", "body"]);
  assert.deepEqual(schemaRequired("record_remove"), ["collection", "id"]);
  const recordList = REGISTRY.record_list!.schema as {
    function: {
      parameters: { properties: Record<string, { type?: string; description?: string }> };
    };
  };
  assert.equal(recordList.function.parameters.properties.where?.type, "object");
  assert.match(
    String(recordList.function.parameters.properties.where?.description),
    /substring or similar spelling/,
  );
  assert.equal(recordList.function.parameters.properties.order?.type, "object");
  const recordAdd = REGISTRY.record_add!.schema as {
    function: {
      description: string;
      parameters: { properties: Record<string, { type?: string; description?: string }> };
    };
  };
  assert.match(recordAdd.function.description, /assigns its id/);
  assert.match(REGISTRY.record_add!.description, /Do not pass id, created_at, or updated_at/);
  assert.equal(recordAdd.function.parameters.properties.body?.type, "object");
  const recordUpdate = REGISTRY.record_update!.schema as {
    function: { parameters: { properties: Record<string, { type?: string }> } };
  };
  assert.equal(recordUpdate.function.parameters.properties.id?.type, "integer");
  assert.deepEqual(schemaRequired("note_delete"), ["path"]);
  assert.equal("schedule_create" in REGISTRY, false);
  assert.deepEqual(schemaRequired("schedule_create_cron"), ["cron", "description", "instruction"]);
  const cronCreate = REGISTRY.schedule_create_cron!.schema as {
    function: { description: string; parameters: { properties: Record<string, unknown> } };
  };
  assert.equal(cronCreate.function.parameters.properties.window, undefined);
  assert.match(cronCreate.function.description, /fixed UTC clock/);
  assert.match(cronCreate.function.description, /schedule_create_window/);
  assert.deepEqual(schemaRequired("schedule_create_window"), [
    "timezone",
    "start",
    "end",
    "max_wakes",
    "description",
    "instruction",
  ]);
  const windowCreate = REGISTRY.schedule_create_window!.schema as {
    function: { description: string; parameters: { properties: Record<string, unknown> } };
  };
  assert.equal(windowCreate.function.parameters.properties.cron, undefined);
  assert.match(windowCreate.function.description, /random times/);
  assert.match(windowCreate.function.description, /schedule_create_cron/);
  assert.deepEqual(schemaRequired("schedule_list"), []);
  assert.deepEqual(schemaRequired("schedule_pause"), ["schedule_id"]);
  assert.deepEqual(schemaRequired("schedule_resume"), ["schedule_id"]);
  assert.deepEqual(schemaRequired("schedule_delete"), ["schedule_id"]);
  assert.deepEqual(schemaRequired("script_create"), ["name", "description", "source"]);
  const scriptCreate = REGISTRY.script_create!.schema as {
    function: { parameters: { properties: { parameters: unknown } } };
  };
  assert.deepEqual(scriptCreate.function.parameters.properties.parameters, { type: "object" });
  assert.deepEqual(schemaRequired("script_list"), []);
  assert.deepEqual(schemaRequired("script_read"), ["name"]);
  assert.deepEqual(schemaRequired("script_run"), ["name"]);
  assert.deepEqual(schemaRequired("script_delete"), ["name"]);
});

test("custom filter then redaction and cap", () => {
  const secrets = { TOKEN: "secret-value" };
  const [stored, meta] = processOutput(
    "raw secret-value and padding-" + "x".repeat(40),
    (text) => text.replace("raw", "clean"),
    secrets,
    64,
  );
  assert.ok(stored.startsWith("clean [REDACTED:TOKEN]"));
  assert.ok(stored.endsWith("\n[truncated]"));
  assert.equal(meta.truncated, true);
  assert.ok(Number(meta.original_bytes) > Number(meta.stored_bytes));
  assert.ok(Number(meta.stored_bytes) <= 64);
  assert.equal(meta.error, null);
});

test("identity filter redacts and caps", () => {
  const secrets = { TOKEN: "abcdefghij" };
  const [stored, meta] = processOutput("abcdefghij" + "y".repeat(40), (text) => text, secrets, 40);
  assert.ok(stored.includes("[REDACTED:TOKEN]"));
  assert.equal(stored.includes("abcdefghij"), false);
  assert.equal(meta.truncated, true);
  assert.ok(Number(meta.stored_bytes) <= 40);
});

test("filter failure becomes error result", () => {
  const [stored, meta] = processOutput(
    "hi",
    () => {
      throw new Error("nope");
    },
    {},
    1024,
  );
  assert.equal(stored, "ERROR: tool output filter failed");
  assert.equal(meta.error, "tool output filter failed");
});

test("cap_bytes noop when under limit", () => {
  const [text, truncated] = capBytes("hello", 100);
  assert.equal(text, "hello");
  assert.equal(truncated, false);
});

test("format_execution includes nonzero exit code", () => {
  assert.equal(
    formatExecution({
      exit_code: 1,
      logs: {
        stdout: [{ text: "out" }],
        stderr: [{ text: "err" }],
      },
    }),
    "out\nerr\nexit_code: 1",
  );
});

test("invoke_script_run stores payload and exit_code", async () => {
  const scripts = new Scripts(new MemoryScriptDB());
  await scripts.create(
    operatorActor({
      orgId: "org_1",
      actorId: "user_1",
      actorName: "test operator",
      guildId: "guild_1",
      agentId: "a_1",
    }),
    "a_1",
    "hello",
    "prints hi",
    "print('hi')",
  );
  const commands: string[] = [];
  const ctx = createToolContext({
    run_id: "r_1",
    agent_id: "a_1",
    guild_id: "guild_1",
    sandbox: {
      commands: {
        async run(command, opts) {
          commands.push(command);
          assert.equal(opts?.workingDirectory ?? opts?.working_directory, "/home/agent");
          return {
            exit_code: 0,
            logs: { stdout: [{ text: "hi" }], stderr: [] },
          };
        },
      },
    },
    secrets: {},
    scripts,
  });
  const [payload, metadata] = await invokeTool(
    ctx,
    { id: "call_1", function: { name: "script_run", arguments: '{"name":"hello"}' } },
    {},
    1024,
  );
  assert.deepEqual(payload, { role: "tool", tool_call_id: "call_1", content: "hi" });
  assert.equal(metadata.tool_name, "script_run");
  assert.equal(metadata.tool_call_id, "call_1");
  assert.equal(metadata.exit_code, 0);
  assert.equal(metadata.output_filter, "identity");
  assert.equal(metadata.truncated, false);
  assert.equal(metadata.error, null);
  assert.deepEqual(commands, ["python3 /usr/local/bin/guilds-script-run /home/agent/scripts/hello.py"]);
});

test("invoke unknown tool is error message", async () => {
  const ctx = createToolContext({
    run_id: "r_1",
    agent_id: "a_1",
    guild_id: "guild_1",
    sandbox: null,
    secrets: {},
  });
  const [payload, metadata] = await invokeTool(
    ctx,
    { id: "call_x", function: { name: "nope", arguments: "{}" } },
    {},
    1024,
  );
  assert.equal(payload.content, "ERROR: unknown tool nope");
  assert.equal(metadata.tool_call_id, "call_x");
  assert.equal(metadata.error, "unknown tool nope");
});

test("invoke refuses a native tool the run did not offer", async () => {
  const scripts = new Scripts(new MemoryScriptDB());
  const ctx = createToolContext({
    run_id: "r_1",
    agent_id: "a_1",
    guild_id: "guild_1",
    sandbox: null,
    secrets: {},
    scripts,
    offered_tools: new Set(["note_find"]),
  });
  const [payload, metadata] = await invokeTool(
    ctx,
    {
      id: "call_x",
      function: {
        name: "script_create",
        arguments: '{"name":"scratch","description":"why","source":"print(1)"}',
      },
    },
    {},
    1024,
  );
  assert.equal(payload.content, "ERROR: tool script_create is not offered this run");
  assert.equal(metadata.error, "tool script_create is not offered this run");
  assert.equal((await scripts.listForAgent("a_1")).length, 0);
});

test("invoke still runs a first-class script when it is not in offered_tools", async () => {
  const ctx = createToolContext({
    run_id: "r_1",
    agent_id: "a_1",
    guild_id: "guild_1",
    sandbox: {
      commands: {
        async run() {
          return { exit_code: 0, logs: { stdout: [{ text: "priced" }], stderr: [] } };
        },
      },
    },
    secrets: {},
    offered_tools: new Set(["note_find"]),
    dynamic_tools: {
      priced: {
        name: "priced",
        description: "price a bag",
        output_filter: (result) => result,
        filter_name: "identity",
        schema: {},
        async handler() {
          return "priced";
        },
      },
    },
  });
  const [payload, metadata] = await invokeTool(
    ctx,
    { id: "call_1", function: { name: "priced", arguments: "{}" } },
    {},
    1024,
  );
  assert.equal(payload.content, "priced");
  assert.equal(metadata.error, null);
});

test("run_command cancel raises interrupted", async () => {
  const { runCommand } = await import("../../src/toolbox/shell.js");
  let started: () => void = () => undefined;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const interrupted: string[] = [];
  const cancelEvent = new CancelEvent();
  const tracked: Array<string | null> = [];
  const ctx = createToolContext({
    run_id: "r_1",
    agent_id: "a_1",
    guild_id: "guild_1",
    sandbox: {
      commands: {
        async run(_command, _opts, handlers) {
          if (handlers?.onInit) {
            await handlers.onInit({ id: "exec_1" });
          }
          started();
          await new Promise(() => undefined);
          return { exit_code: 0, logs: { stdout: [], stderr: [] } };
        },
        async interrupt(executionId) {
          interrupted.push(executionId);
        },
      },
    },
    secrets: {},
    cancel_event: cancelEvent,
    track_command: (id) => {
      tracked.push(id);
    },
  });
  const task = runCommand(ctx, "sleep 30");
  await startedPromise;
  assert.deepEqual(tracked, ["exec_1"]);
  cancelEvent.set();
  await assert.rejects(task, /execution interrupted/);
  assert.equal(tracked[tracked.length - 1], null);
});

test("browser_encode_spec is helper command", () => {
  const command = encodeSpec({ op: "navigate", url: "https://example.com" });
  assert.ok(command.startsWith(`python3 ${HELPER} `));
  const blob = command.split(" ").slice(2).join(" ");
  assert.deepEqual(JSON.parse(Buffer.from(blob, "base64").toString("utf8")), {
    op: "navigate",
    url: "https://example.com",
  });
});

test("browser_navigate runs helper", async () => {
  const { browserNavigate } = await import("../../src/toolbox/browser.js");
  const seen: string[] = [];
  const ctx = createToolContext({
    run_id: "r_1",
    agent_id: "a_1",
    guild_id: "guild_1",
    sandbox: {
      commands: {
        async run(command, opts) {
          seen.push(command);
          assert.equal(opts?.workingDirectory ?? opts?.working_directory, "/home/agent");
          return {
            exit_code: 0,
            logs: { stdout: [{ text: "https://example.com\nExample" }], stderr: [] },
          };
        },
      },
    },
    secrets: {},
  });
  const result = await browserNavigate.handler(ctx, { url: "https://example.com" });
  assert.deepEqual(seen, [encodeSpec({ op: "navigate", url: "https://example.com" })]);
  assert.equal(result, "https://example.com\nExample");
  assert.equal(ctx.exit_code, 0);
});

test("browser_scroll runs helper", async () => {
  const { browserScroll } = await import("../../src/toolbox/browser.js");
  const seen: string[] = [];
  const ctx = createToolContext({
    run_id: "r_1",
    agent_id: "a_1",
    guild_id: "guild_1",
    sandbox: {
      commands: {
        async run(command, opts) {
          seen.push(command);
          assert.equal(opts?.timeoutSeconds ?? opts?.timeout_seconds, 60);
          return {
            exit_code: 0,
            logs: { stdout: [{ text: "scrolled down\ncontainer: window\nfrom: 0\nto: 600\nremaining: 0" }], stderr: [] },
          };
        },
      },
    },
    secrets: {},
  });
  const result = await browserScroll.handler(ctx, { direction: "down" });
  assert.deepEqual(seen, [encodeSpec({ op: "scroll", direction: "down" })]);
  assert.match(result, /scrolled down/);
  const withTarget = await browserScroll.handler(ctx, { direction: "down", target: "div.list" });
  assert.deepEqual(seen[1], encodeSpec({ op: "scroll", direction: "down", target: "div.list" }));
  assert.match(withTarget, /scrolled down/);
});

test("browser_eval runs helper", async () => {
  const { browserEval } = await import("../../src/toolbox/browser.js");
  const seen: string[] = [];
  const ctx = createToolContext({
    run_id: "r_1",
    agent_id: "a_1",
    guild_id: "guild_1",
    sandbox: {
      commands: {
        async run(command, opts) {
          seen.push(command);
          assert.equal(opts?.timeoutSeconds ?? opts?.timeout_seconds, 60);
          return {
            exit_code: 0,
            logs: { stdout: [{ text: '"ok"' }], stderr: [] },
          };
        },
      },
    },
    secrets: {},
  });
  const result = await browserEval.handler(ctx, { expression: "return document.title;" });
  assert.deepEqual(seen, [encodeSpec({ op: "evaluate", expression: "return document.title;" })]);
  assert.equal(result, '"ok"');
});

test("parseArguments accepts an object or a JSON object string", () => {
  assert.deepEqual(parseArguments({ function: { arguments: { path: "a.ts" } } }), { path: "a.ts" });
  assert.deepEqual(parseArguments({ function: { arguments: '{"path":"a.ts"}' } }), { path: "a.ts" });
  assert.deepEqual(parseArguments({ function: { arguments: "" } }), {});
  assert.deepEqual(parseArguments({}), {});
});

test("parseArguments throws when JSON is not an object", () => {
  assert.throws(() => parseArguments({ function: { arguments: "[]" } }), /JSON object/);
  assert.throws(() => parseArguments({ function: { arguments: 3 } }), /JSON object/);
});

test("remaining tool calls stamp", () => {
  assert.equal(remainingAfter(50, 1), 49);
  assert.equal(remainingAfter(1, 1), 0);
  assert.equal(remainingAfter(1, 3), 0);
  assert.equal(withRemainingToolCalls("ok", 9), "ok\n\nremaining_tool_calls: 9");
  assert.equal(
    withRemainingToolCalls("ok", 8),
    `ok\n\n${LOW_TOOL_CALL_WRAP_UP}\n\nremaining_tool_calls: 8`,
  );
  assert.equal(
    withRemainingToolCalls("ok", 0),
    `ok\n\n${LOW_TOOL_CALL_WRAP_UP}\n\nremaining_tool_calls: 0`,
  );
  const [payload, metadata] = stampToolResult(
    { role: "tool", tool_call_id: "c1", content: "page found" },
    { tool_name: "note_read" },
    12,
  );
  assert.equal(payload.content, "page found\n\nremaining_tool_calls: 12");
  assert.equal(metadata.remaining_tool_calls, 12);
  assert.equal(metadata.tool_name, "note_read");
});
