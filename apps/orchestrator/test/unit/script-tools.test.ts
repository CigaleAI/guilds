import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { agentActor, type ArtifactActor } from "../../src/artifacts/index.js";
import { DEFAULT_ARTIFACT_GRANTS } from "../../src/artifacts/types.js";
import { Scripts, scriptItem } from "../../src/scripts/catalog.js";
import { SCRIPT_ARGS_ENV, launcherCommand } from "../../src/scripts/materialise.js";
import { scriptSourceHash } from "../../src/scripts/validation.js";
import { createToolContext, dynamicScriptTools, invokeTool } from "../../src/toolbox/index.js";
import { tempDir } from "../helpers/env.js";

class MemoryScriptDB {
  rows: Array<Record<string, unknown>> = [];
  actors: ArtifactActor[] = [];

  async listAgentScripts(agentId: string) {
    return this.rows.filter((row) => row.agent_id === agentId);
  }

  async upsertAgentScript(
    actor: ArtifactActor,
    scriptId: string,
    agentId: string,
    name: string,
    description: string,
    parameters: Record<string, unknown> | null,
    source: string,
    sourceHash: string,
    now: Date,
  ) {
    this.actors.push(actor);
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

class MemoryFiles {
  files = new Map<string, string>();
  writes: Array<{ path: string; data: string }> = [];
  moves: Array<{ src: string; dest: string }> = [];

  async writeFiles(entries: Array<{ path: string; data: string }>) {
    for (const entry of entries) {
      this.writes.push(entry);
      this.files.set(entry.path, entry.data);
    }
  }

  async moveFiles(entries: Array<{ src: string; dest: string }>) {
    for (const entry of entries) {
      this.moves.push(entry);
      const data = this.files.get(entry.src);
      this.files.delete(entry.src);
      if (data !== undefined) {
        this.files.set(entry.dest, data);
      }
    }
  }

  async deleteFiles(paths: string[]) {
    for (const item of paths) {
      this.files.delete(item);
    }
  }
}

async function invoke(
  ctx: ReturnType<typeof createToolContext>,
  name: string,
  arguments_: Record<string, unknown>,
) {
  const [payload, metadata] = await invokeTool(
    ctx,
    { id: "call_1", function: { name, arguments: arguments_ } },
    {},
    1024,
  );
  return { content: String(payload.content), metadata };
}

function toolCtx(
  scripts: Scripts,
  extra: {
    commands?: string[];
    envs?: Array<Record<string, string> | undefined>;
    files?: MemoryFiles;
    published?: Array<[string, string, Record<string, unknown>]>;
  } = {},
) {
  return createToolContext({
    run_id: "r_1",
    agent_id: "a_1",
    guild_id: "guild_1",
    sandbox: {
      commands: {
        async run(command, opts) {
          extra.commands?.push(command);
          extra.envs?.push(opts?.envs as Record<string, string> | undefined);
          return { exit_code: 0, logs: { stdout: [{ text: "ok" }], stderr: [] } };
        },
      },
      ...(extra.files ? { files: extra.files } : {}),
    },
    secrets: {},
    scripts,
    artifact_actor: agentActor({
      orgId: "org_1",
      guildId: "guild_1",
      agentId: "a_1",
      agentName: "agent",
      grants: DEFAULT_ARTIFACT_GRANTS,
      runId: "r_1",
    }),
    ...(extra.published
      ? {
          group_chat: {
            async publish(guildId: string, event: string, data: Record<string, unknown>) {
              extra.published!.push([guildId, event, data]);
            },
          },
        }
      : {}),
  });
}

test("script tools create list read run delete", async () => {
  const workspace = tempDir("guilds-script-tools-");
  mkdirSync(path.join(workspace, "a_1", "scripts"), { recursive: true });
  const db = new MemoryScriptDB();
  const scripts = new Scripts(db);
  const commands: string[] = [];
  const files = new MemoryFiles();
  const published: Array<[string, string, Record<string, unknown>]> = [];
  const ctx = toolCtx(scripts, { commands, files, published });
  const created = await invoke(ctx, "script_create", {
    name: "send_usdc",
    description: "Sign and send USDC from the treasury",
    source: "print('sent')\n",
  });
  assert.equal(created.content, "wrote send_usdc\nSign and send USDC from the treasury");
  assert.deepEqual(db.actors[0]?.toolCall, { id: "call_1", name: "script_create" });
  assert.deepEqual(published.at(-1), [
    "guild_1",
    "agent.scripts.changed",
    { agent_id: "a_1", action: "create", name: "send_usdc" },
  ]);
  const listed = await invoke(ctx, "script_list", {});
  assert.equal(listed.content, "send_usdc  Sign and send USDC from the treasury");
  const read = await invoke(ctx, "script_read", { name: "send_usdc" });
  assert.equal(read.content, "send_usdc\nSign and send USDC from the treasury\n\nprint('sent')\n");
  const ran = await invoke(ctx, "script_run", { name: "send_usdc" });
  assert.equal(ran.content, "ok");
  assert.deepEqual(commands, [launcherCommand("send_usdc")]);
  assert.equal(files.files.get("/home/agent/scripts/send_usdc.py"), "print('sent')\n");
  const hostPath = path.join(workspace, "a_1", "scripts", "send_usdc.py");
  assert.equal(existsSync(hostPath), false);
  assert.equal(existsSync(path.join(workspace, "a_1", "scripts", "manifest.json")), false);
  const deleted = await invoke(ctx, "script_delete", { name: "send_usdc" });
  assert.equal(deleted.content, "deleted send_usdc");
  assert.equal(files.files.has("/home/agent/scripts/send_usdc.py"), false);
  const empty = await invoke(ctx, "script_list", {});
  assert.equal(empty.content, "no scripts");
  assert.equal(published.at(-1)?.[1], "agent.scripts.changed");
});

test("script_run passes arguments to the script as JSON on stdin", async () => {
  const scripts = new Scripts(new MemoryScriptDB());
  const commands: string[] = [];
  const envs: Array<Record<string, string> | undefined> = [];
  const ctx = toolCtx(scripts, { commands, envs, files: new MemoryFiles() });
  await invoke(ctx, "script_create", {
    name: "greet",
    description: "greet a name",
    source: "import json,sys; print('Hello ' + json.load(sys.stdin)['text'])\n",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  });
  const ran = await invoke(ctx, "script_run", { name: "greet", arguments: { text: "a \"b\"\nc" } });
  assert.equal(ran.metadata.error, null);
  const bare = await invoke(ctx, "script_run", { name: "greet" });
  assert.equal(bare.metadata.error, null);
  const stringified = await invoke(ctx, "script_run", { name: "greet", arguments: '{"text":"d"}' });
  assert.equal(stringified.metadata.error, null);
  assert.deepEqual(commands, [launcherCommand("greet"), launcherCommand("greet"), launcherCommand("greet")]);
  assert.deepEqual(
    envs.map((env) => JSON.parse(env?.[SCRIPT_ARGS_ENV] ?? "")),
    [{ text: "a \"b\"\nc" }, {}, { text: "d" }],
  );
  for (const bad of [["x"], "[1]", "not json", 3]) {
    const refused = await invoke(ctx, "script_run", { name: "greet", arguments: bad });
    assert.equal(refused.metadata.error, "arguments must be a JSON object");
  }
  assert.equal(commands.length, 3);
});

test("script create on a name this run started with says the new version waits", async () => {
  const scripts = new Scripts(new MemoryScriptDB());
  const files = new MemoryFiles();
  const ctx = toolCtx(scripts, { files });
  await invoke(ctx, "script_create", { name: "ping", description: "old why", source: "print(1)\n" });
  ctx.run_scripts = await scripts.snapshot("a_1");
  const replaced = await invoke(ctx, "script_create", {
    name: "ping",
    description: "new why",
    source: "print(2)\n",
  });
  assert.equal(
    replaced.content,
    "wrote ping\nnew why\nThis run keeps running the version it started with; the new version runs from the next run.",
  );
  assert.equal(files.files.get("/home/agent/scripts/ping.py"), "print(1)\n");
});

test("script delete drops the name from this run so script_run stops", async () => {
  const db = new MemoryScriptDB();
  const scripts = new Scripts(db);
  const files = new MemoryFiles();
  let persisted: unknown[] | null = null;
  const ctx = toolCtx(scripts, { files });
  ctx.persist_run_scripts = async (rows) => {
    persisted = rows;
  };
  await invoke(ctx, "script_create", {
    name: "send_usdc",
    description: "Sign and send USDC",
    source: "print('snap')\n",
    parameters: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
  });
  ctx.run_scripts = await scripts.snapshot("a_1");
  ctx.dynamic_tools = dynamicScriptTools(ctx.run_scripts);
  assert.ok(ctx.dynamic_tools.send_usdc);
  const deleted = await invoke(ctx, "script_delete", { name: "send_usdc" });
  assert.equal(deleted.content, "deleted send_usdc");
  assert.equal(files.files.has("/home/agent/scripts/send_usdc.py"), false);
  assert.equal(ctx.run_scripts.length, 0);
  assert.equal(ctx.dynamic_tools.send_usdc, undefined);
  assert.deepEqual(persisted, []);
  const ran = await invoke(ctx, "script_run", { name: "send_usdc" });
  assert.equal(ran.metadata.error, "script not found");
  const first = await invoke(ctx, "send_usdc", { to: "0x1" });
  assert.equal(first.metadata.error, "unknown tool send_usdc");
});

test("script create stores parameters in catalog", async () => {
  const scripts = new Scripts(new MemoryScriptDB());
  const ctx = toolCtx(scripts);
  const schema = {
    type: "object",
    properties: { to: { type: "string" } },
    required: ["to"],
  };
  const created = await invoke(ctx, "script_create", {
    name: "send_usdc",
    description: "Sign and send USDC",
    source: "print('sent')\n",
    parameters: schema,
  });
  assert.equal(created.content, "wrote send_usdc\nSign and send USDC");
  const listed = await invoke(ctx, "script_list", {});
  assert.equal(listed.content, "send_usdc  Sign and send USDC");
  const row = await scripts.get("a_1", "send_usdc");
  assert.deepEqual(row.parameters, schema);
  assert.deepEqual(await scripts.catalog("a_1"), [
    {
      name: "send_usdc",
      description: "Sign and send USDC",
      parameters: schema,
    },
  ]);
  assert.deepEqual(scriptItem(row, { source: true }).parameters, schema);
  assert.equal(row.source_hash, scriptSourceHash("print('sent')\n"));
});

test("script create replaces existing", async () => {
  const scripts = new Scripts(new MemoryScriptDB());
  const ctx = toolCtx(scripts);
  await invoke(ctx, "script_create", {
    name: "ping",
    description: "old why",
    source: "print(1)\n",
  });
  await invoke(ctx, "script_create", {
    name: "ping",
    description: "new why",
    source: "print(2)\n",
  });
  const listed = await invoke(ctx, "script_list", {});
  assert.equal(listed.content, "ping  new why");
  const read = await invoke(ctx, "script_read", { name: "ping" });
  assert.ok(read.content.includes("print(2)"));
});

test("script create refuses a new name past max_scripts", async () => {
  const scripts = new Scripts(new MemoryScriptDB());
  const ctx = toolCtx(scripts);
  ctx.max_scripts = 1;
  await invoke(ctx, "script_create", {
    name: "one",
    description: "first",
    source: "print(1)\n",
  });
  const refused = await invoke(ctx, "script_create", {
    name: "two",
    description: "second",
    source: "print(2)\n",
  });
  assert.equal(refused.metadata.error, "this agent is limited to 1 scripts");
  assert.equal(refused.content, "ERROR: this agent is limited to 1 scripts");
});

test("script read missing", async () => {
  const scripts = new Scripts(new MemoryScriptDB());
  const ctx = toolCtx(scripts);
  const stored = await invoke(ctx, "script_read", { name: "missing" });
  assert.equal(stored.metadata.error, "script not found");
  assert.equal(stored.content, "ERROR: script not found");
});
