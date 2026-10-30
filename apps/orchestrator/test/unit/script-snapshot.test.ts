import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { operatorActor } from "../../src/artifacts/actors.js";
import { repoRoot } from "../../src/lib/paths.js";
import {
  SCRIPT_ARGS_ENV,
  SCRIPT_LAUNCHER,
  launcherCommand,
  materialiseScripts,
  scriptsDirectory,
  writeThroughLiveExtra,
} from "../../src/scripts/materialise.js";
import {
  RUN_SCRIPT_SNAPSHOT_FIELDS,
  firstClassSnapshots,
  liveExtraRows,
  snapshotAgentScripts,
  toRunScriptSnapshot,
} from "../../src/scripts/snapshot.js";
import type { RunScriptSnapshot } from "../../src/db/schema/index.js";
import { type AgentScript, Scripts } from "../../src/scripts/catalog.js";
import { NATIVE_TOOL_NAMES, ScriptError, scriptSourceHash } from "../../src/scripts/validation.js";
import {
  REGISTRY,
  dynamicScriptTools,
  firstClassScriptSchemas,
  invokeTool,
} from "../../src/toolbox/index.js";
import { loadJsonFixture } from "../helpers/fixtures.js";
import { MemoryScriptDB } from "../helpers/generation.js";
import { toolFixture, type ToolFixture } from "../helpers/toolbox.js";

function liveScript(fields: Omit<AgentScript, "agent_id" | "source_hash">): AgentScript {
  return { ...fields, agent_id: "a_1", source_hash: scriptSourceHash(fields.source) };
}

const HOME = "/home/a_1";
const SCRIPTS = scriptsDirectory(HOME);

type ScriptFixture = {
  run_script_snapshot_fields: string[];
  cases: Array<Record<string, unknown>>;
};

const fixture = loadJsonFixture<ScriptFixture>("scripts/cases.json");


const scriptOperator = operatorActor({
  orgId: "org_1",
  actorId: "user_1",
  actorName: "test operator",
  guildId: "guild_1",
  agentId: "a_1",
});

class MemoryFiles {
  writes: Array<{ path: string; data: string }> = [];
  moves: Array<{ src: string; dest: string }> = [];
  deletes: string[] = [];
  files = new Map<string, string>();

  async writeFiles(entries: Array<{ path: string; data: string }>) {
    for (const entry of entries) {
      this.writes.push(entry);
      this.files.set(entry.path, entry.data);
    }
  }

  async moveFiles(entries: Array<{ src: string; dest: string }>) {
    for (const entry of entries) {
      if (this.files.has(entry.dest)) {
        throw new Error(`error accessing file: destination path already exists: ${entry.dest}`);
      }
      this.moves.push(entry);
      const data = this.files.get(entry.src);
      this.files.delete(entry.src);
      if (data !== undefined) {
        this.files.set(entry.dest, data);
      }
    }
  }

  async listDirectory(_entry: { path: string; depth?: number }) {
    return [...this.files.keys()]
      .filter((item) => !path.basename(item).startsWith("."))
      .map((item) => ({ path: item, type: "file" }));
  }

  async deleteFiles(paths: string[]) {
    this.deletes.push(...paths);
    for (const item of paths) {
      this.files.delete(item);
    }
  }
}

function caseById(id: string): Record<string, unknown> {
  const row = fixture.cases.find((item) => item.id === id);
  assert.ok(row, id);
  return row;
}

async function invoke(
  ctx: ToolFixture,
  name: string,
  arguments_: Record<string, unknown>,
) {
  const [payload, metadata] = await invokeTool(
    ctx.services, ctx.run, ctx.hooks,
    { id: "call_1", type: "function", function: { name, arguments: JSON.stringify(arguments_) } },
  );
  return { content: String(payload.content), metadata };
}

test("RunScriptSnapshot fields match the Phase 3 fixture", () => {
  assert.deepEqual([...RUN_SCRIPT_SNAPSHOT_FIELDS], fixture.run_script_snapshot_fields);
});

test("snapshot-pin-ignores-live-edit", async () => {
  const row = caseById("snapshot-pin-ignores-live-edit");
  const given = row.given as {
    run_scripts: Array<Record<string, unknown>>;
    live_edit: { name: string; source: string };
  };
  const snapshot = snapshotAgentScripts(
    given.run_scripts.map((item) => ({
      ...item,
      source_hash: scriptSourceHash(String(item.source)),
    })) as AgentScript[],
  );
  const db = new MemoryScriptDB();
  db.rows = snapshot.map((item) => ({
    ...item,
    agent_id: "a_1",
    created_at: "2026-10-12T09:00:00.000Z",
    updated_at: "2026-10-12T09:00:00.000Z",
  }));
  const scripts = new Scripts(db);
  await scripts.create(scriptOperator, "a_1", given.live_edit.name, "Sign and send USDC", given.live_edit.source, {
    type: "object",
    properties: { amount: { type: "string" } },
    required: ["amount"],
  });
  const live = await scripts.get("a_1", "send_usdc");
  assert.equal(live.source, given.live_edit.source);
  const pinned = snapshot.find((item) => item.name === "send_usdc");
  assert.ok(pinned);
  assert.equal(pinned.source, "print('snap')\n");
  assert.equal(firstClassSnapshots(snapshot).length, 1);
  const files = new MemoryFiles();
  await materialiseScripts(files, HOME,
    snapshot,
    liveExtraRows(snapshot, db.rows).map((item) => ({ name: item.name, source: item.source })),
  );
  assert.equal(files.files.get(`${SCRIPTS}/send_usdc.py`), "print('snap')\n");
  const commands: string[] = [];
  const ctx = toolFixture({
    run_id: "r_1",
    agent_id: "a_1",
    guild_id: "guild_1",
    sandbox: {
      commands: {
        async run(command) {
          commands.push(command);
          return { exit_code: 0, logs: { stdout: [{ text: "snap" }], stderr: [] } };
        },
      },
    },
    secrets: {},
    scripts,
    run_scripts: snapshot,
    dynamic_tools: dynamicScriptTools(snapshot),
  });
  const ran = await invoke(ctx, "script_run", { name: "send_usdc" });
  assert.equal(ran.content, "snap");
  assert.deepEqual(commands, [launcherCommand(HOME, "send_usdc")]);
  assert.ok(ctx.run.dynamic_tools.send_usdc);
});

test("deleted-live-row-still-executable", async () => {
  const snapshot: RunScriptSnapshot[] = [
    toRunScriptSnapshot(liveScript({
      id: "script_1",
      name: "send_usdc",
      description: "Sign and send USDC",
      parameters: null,
      source: "print('snap')\n",
    })),
  ];
  const db = new MemoryScriptDB();
  const scripts = new Scripts(db);
  const commands: string[] = [];
  const ctx = toolFixture({
    run_id: "r_1",
    agent_id: "a_1",
    guild_id: "guild_1",
    sandbox: {
      commands: {
        async run(command) {
          commands.push(command);
          return { exit_code: 0, logs: { stdout: [{ text: "snap" }], stderr: [] } };
        },
      },
    },
    secrets: {},
    scripts,
    run_scripts: snapshot,
  });
  const ran = await invoke(ctx, "script_run", { name: "send_usdc" });
  assert.equal(ran.content, "snap");
  assert.deepEqual(commands, [launcherCommand(HOME, "send_usdc")]);
  assert.equal(firstClassSnapshots(snapshot).length, 0);
  assert.deepEqual(dynamicScriptTools(snapshot), {});
});

test("live-extra-same-generation", async () => {
  const files = new MemoryFiles();
  const db = new MemoryScriptDB();
  const scripts = new Scripts(db);
  const snapshot: RunScriptSnapshot[] = [];
  const ctx = toolFixture({
    run_id: "r_1",
    agent_id: "a_1",
    guild_id: "guild_1",
    sandbox: {
      commands: {
        async run(command) {
          assert.equal(command, launcherCommand(HOME, "scratch"));
          return { exit_code: 0, logs: { stdout: [{ text: "extra" }], stderr: [] } };
        },
      },
      files,
    },
    secrets: {},
    scripts,
    artifact_actor: scriptOperator,
    run_scripts: snapshot,
  });
  const created = await invoke(ctx, "script_create", {
    name: "scratch",
    description: "ad hoc",
    source: "print('extra')\n",
  });
  assert.equal(created.content, "wrote scratch\nad hoc");
  assert.equal(files.files.get(`${SCRIPTS}/scratch.py`), "print('extra')\n");
  const ran = await invoke(ctx, "script_run", { name: "scratch" });
  assert.equal(ran.content, "extra");
  assert.equal(firstClassSnapshots(snapshot).length, 0);
  assert.deepEqual(dynamicScriptTools(snapshot), {});
});

test("parameterised-next-run-only", async () => {
  const db = new MemoryScriptDB();
  const scripts = new Scripts(db);
  const snapshot: RunScriptSnapshot[] = [];
  const ctx = toolFixture({
    run_id: "r_1",
    agent_id: "a_1",
    guild_id: "guild_1",
    sandbox: null,
    secrets: {},
    scripts,
    artifact_actor: scriptOperator,
    run_scripts: snapshot,
    dynamic_tools: dynamicScriptTools(snapshot),
  });
  const schema = {
    type: "object",
    properties: { symbol: { type: "string" } },
    required: ["symbol"],
  };
  await invoke(ctx, "script_create", {
    name: "priced",
    description: "price a bag",
    source: "import json,sys; print(json.load(sys.stdin)['symbol'])\n",
    parameters: schema,
  });
  assert.equal(Object.keys(ctx.run.dynamic_tools).length, 0);
  const next = snapshotAgentScripts(await scripts.listForAgent("a_1"));
  assert.equal(firstClassSnapshots(next).length, 1);
  assert.ok(dynamicScriptTools(next).priced);
  assert.equal(NATIVE_TOOL_NAMES.has("priced"), false);
  const offered = firstClassScriptSchemas(next);
  assert.equal(offered.length, 1);
  assert.deepEqual(offered[0], {
    type: "function",
    function: {
      name: "priced",
      description: "price a bag",
      parameters: {
        type: "object",
        properties: { symbol: { type: "string" } },
        required: ["symbol"],
      },
    },
  });
});

test("first-class schema drops required names that are not properties", () => {
  const schemas = firstClassScriptSchemas([
    toRunScriptSnapshot(liveScript({
      id: "script_1",
      name: "priced",
      description: "price a bag",
      parameters: {
        type: "object",
        properties: { symbol: { type: "string" } },
        required: ["symbol", "missing"],
      },
      source: "print(1)\n",
    })),
  ]);
  assert.deepEqual(
    (schemas[0] as { function: { parameters: { required: string[] } } }).function.parameters.required,
    ["symbol"],
  );
});

test("materialise-temp-then-move", async () => {
  const files = new MemoryFiles();
  files.files.set(`${SCRIPTS}/stale.py`, "print('old')\n");
  const snapshot: RunScriptSnapshot[] = [
    toRunScriptSnapshot(liveScript({
      id: "script_1",
      name: "send_usdc",
      description: "Sign and send USDC",
      parameters: null,
      source: "print('snap')\n",
    })),
  ];
  const extra = [{ name: "scratch", source: "print('extra')\n" }];
  await materialiseScripts(files, HOME, snapshot, extra);
  assert.equal(files.writes.length, 2);
  for (const write of files.writes) {
    assert.match(write.path, new RegExp(`^${SCRIPTS}/\\.[a-z0-9_-]+\\.[0-9a-f]+\\.tmp$`));
    assert.equal(write.path.includes(`${SCRIPTS}/send_usdc.py`), false);
  }
  assert.deepEqual(
    files.moves.map((item) => item.dest).sort(),
    [`${SCRIPTS}/scratch.py`, `${SCRIPTS}/send_usdc.py`],
  );
  assert.deepEqual(files.deletes, [`${SCRIPTS}/stale.py`]);
  assert.equal(files.files.get(`${SCRIPTS}/send_usdc.py`), "print('snap')\n");
  assert.equal(files.files.get(`${SCRIPTS}/scratch.py`), "print('extra')\n");
  const catalog = readFileSync(path.join(repoRoot(import.meta.url), "apps/orchestrator/src/scripts/catalog.ts"), "utf8");
  const tools = readFileSync(path.join(repoRoot(import.meta.url), "apps/orchestrator/src/toolbox/script.ts"), "utf8");
  assert.equal(catalog.includes("WORKSPACE_ROOT"), false);
  assert.equal(tools.includes("WORKSPACE_ROOT"), false);
  assert.equal(catalog.includes("manifest.json"), false);
});

test("materialise replaces an existing managed script", async () => {
  const files = new MemoryFiles();
  files.files.set(`${SCRIPTS}/utc_now.py`, "print('old')\n");
  const snapshot: RunScriptSnapshot[] = [
    toRunScriptSnapshot(liveScript({
      id: "script_1",
      name: "utc_now",
      description: "utc clock",
      parameters: null,
      source: "print('new')\n",
    })),
  ];
  await materialiseScripts(files, HOME, snapshot);
  assert.equal(files.files.get(`${SCRIPTS}/utc_now.py`), "print('new')\n");
  assert.deepEqual(files.deletes, [`${SCRIPTS}/utc_now.py`]);
});

test("materialise retries after a files API failure", async () => {
  let remaining = 1;
  const files = new MemoryFiles();
  const original = files.writeFiles.bind(files);
  files.writeFiles = async (entries) => {
    if (remaining > 0) {
      remaining -= 1;
      throw new Error("files api");
    }
    return original(entries);
  };
  const snapshot: RunScriptSnapshot[] = [
    toRunScriptSnapshot(liveScript({
      id: "script_1",
      name: "send_usdc",
      description: "why",
      parameters: null,
      source: "print('snap')\n",
    })),
  ];
  await assert.rejects(() => materialiseScripts(files, HOME, snapshot), /files api/);
  await materialiseScripts(files, HOME, snapshot);
  assert.equal(files.files.get(`${SCRIPTS}/send_usdc.py`), "print('snap')\n");
});

test("json-stdin-launcher", async () => {
  const row = caseById("json-stdin-launcher");
  const given = row.given as { arguments: Record<string, unknown> };
  const snapshot: RunScriptSnapshot[] = [
    toRunScriptSnapshot(liveScript({
      id: "script_1",
      name: "priced",
      description: "price a bag",
      parameters: {
        type: "object",
        properties: {
          quoted: { type: "string" },
          newline: { type: "string" },
          unicode: { type: "string" },
          large: { type: "string" },
        },
        required: ["quoted", "newline", "unicode", "large"],
      },
      source: "import json,sys; print(json.load(sys.stdin)['quoted'])\n",
    })),
  ];
  let envs: Record<string, string> | undefined;
  const ctx = toolFixture({
    run_id: "r_1",
    agent_id: "a_1",
    guild_id: "guild_1",
    sandbox: {
      commands: {
        async run(command, opts) {
          assert.equal(command, launcherCommand(HOME, "priced"));
          envs = opts?.envs as Record<string, string>;
          return { exit_code: 0, logs: { stdout: [{ text: "say \"hello\"" }], stderr: [] } };
        },
      },
    },
    secrets: {},
    run_scripts: snapshot,
    dynamic_tools: dynamicScriptTools(snapshot),
  });
  const ran = await invoke(ctx, "priced", given.arguments);
  assert.equal(ran.content, "say \"hello\"");
  assert.equal(ran.metadata.error, null);
  assert.ok(envs);
  assert.deepEqual(JSON.parse(envs[SCRIPT_ARGS_ENV] ?? ""), given.arguments);
  assert.ok(launcherCommand(HOME, "priced").includes(SCRIPT_LAUNCHER));
});

test("schema-collision-rejection", async () => {
  const scripts = new Scripts(new MemoryScriptDB());
  await assert.rejects(
    () => scripts.create(scriptOperator, "a_1", "note_find", "why", "print(1)\n"),
    (error: unknown) =>
      error instanceof ScriptError && error.message === "collides with a native or connection tool name",
  );
  await assert.rejects(
    () =>
      scripts.create(scriptOperator, "a_1", "priced", "why", "print(1)\n", {
        type: "string",
      }),
    (error: unknown) =>
      error instanceof ScriptError && error.message === "parameters must be a JSON Schema object",
  );
});

test("write-through skips names pinned on the snapshot", async () => {
  const files = new MemoryFiles();
  const snapshot: RunScriptSnapshot[] = [
    toRunScriptSnapshot(liveScript({
      id: "script_1",
      name: "send_usdc",
      description: "why",
      parameters: null,
      source: "print('snap')\n",
    })),
  ];
  const wrote = await writeThroughLiveExtra(files, HOME, "send_usdc", "print('live')\n", snapshot);
  assert.equal(wrote, false);
  assert.equal(files.writes.length, 0);
});

test("reconcile-after-sandbox-recreate", async () => {
  const files = new MemoryFiles();
  files.files.set(`${SCRIPTS}/send_usdc.py`, "gone");
  files.files.set(`${SCRIPTS}/scratch.py`, "gone");
  files.files.set(`${SCRIPTS}/unmanaged.py`, "keep out");
  const snapshot: RunScriptSnapshot[] = [
    toRunScriptSnapshot(liveScript({
      id: "script_1",
      name: "send_usdc",
      description: "why",
      parameters: null,
      source: "print('snap')\n",
    })),
  ];
  const extra = [{ name: "scratch", source: "print('extra')\n" }];
  await materialiseScripts(files, HOME, snapshot, extra);
  assert.equal(files.files.get(`${SCRIPTS}/send_usdc.py`), "print('snap')\n");
  assert.equal(files.files.get(`${SCRIPTS}/scratch.py`), "print('extra')\n");
  assert.equal(files.files.has(`${SCRIPTS}/unmanaged.py`), false);
  assert.ok(files.deletes.includes(`${SCRIPTS}/unmanaged.py`));
});

test("native registry excludes bash", () => {
  assert.equal("bash" in REGISTRY, false);
});
