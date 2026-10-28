import assert from "node:assert/strict";
import type { ToolCall } from "../../src/db/schema/index.js";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { applySecretAliases } from "../../src/access/runtime.js";
import { decryptPayload } from "../../src/credentials/crypto.js";
import { offeredToolNames } from "../../src/toolbox/offered.js";
import { SecretNameTaken } from "../../src/db/errors.js";
import {
  AGENT_SECRET_CAP,
  AgentSecretError,
  readSecretFile,
  storeAgentSecret,
  type AgentSecretsDatabase,
} from "../../src/secrets/agent.js";
import { createToolContext, invokeTool, type Tool } from "../../src/toolbox/index.js";

import { agentRow, FakeDB, FakeSandboxes, makeLoop } from "../helpers/generation.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";

process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;

type Row = Record<string, unknown> & { id: string; name: string };

/** In-memory secrets of one organisation. */
class SecretsDb {
  rows: Row[] = [];

  async getSecretByName(_orgId: string, name: string) {
    return this.rows.find((row) => row.name === name) ?? null;
  }

  async countSecretsCreatedByAgent(agentId: string) {
    return this.rows.filter((row) => row.created_by_agent_id === agentId).length;
  }

  async insertSecret(input: Parameters<AgentSecretsDatabase["insertSecret"]>[0]) {
    if (this.rows.some((row) => row.name === input.name)) {
      throw new SecretNameTaken(input.name);
    }
    const row: Row = {
      id: input.secretId,
      name: input.name,
      description: input.description,
      org_wide: input.access.org_wide,
      grants: input.access.agent_ids.map((id) => ({ guild_id: null, agent_id: id, name: id, in_guild_id: "g" })),
      created_by_agent_id: input.createdByAgentId ?? null,
      ciphertext: input.ciphertext,
      nonce: input.nonce,
    };
    this.rows.push(row);
    return row;
  }

  async updateSecret(secretId: string, changes: { description?: string | null; ciphertext?: Buffer | null }) {
    const row = this.rows.find((item) => item.id === secretId);
    if (!row) return null;
    Object.assign(row, { description: changes.description ?? row.description, ciphertext: changes.ciphertext });
    return row;
  }
}

const AGENT = { id: "a_1", orgId: "org_1" };

function workspace(): string {
  const dir = path.join(tempDir("guilds-secret-"), "a_1");
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("readSecretFile reads one value in the agent's home without the whitespace around it", async () => {
  const dir = workspace();
  writeFileSync(path.join(dir, "key.txt"), "  sk-live-123\n\n");
  const read = await readSecretFile(dir, "/home/a_1/key.txt");
  assert.equal(read.value, "sk-live-123");
  assert.equal(read.path, path.join(dir, "key.txt"));
  writeFileSync(path.join(dir, "crlf.txt"), "abc\r\n");
  assert.equal((await readSecretFile(dir, "crlf.txt")).value, "abc");
  writeFileSync(path.join(dir, "phrase.txt"), "correct horse battery\n");
  assert.equal((await readSecretFile(dir, "phrase.txt")).value, "correct horse battery");
});

test("readSecretFile refuses paths out of the workspace, links out of it, and bad contents", async () => {
  const dir = workspace();
  const outside = path.join(path.dirname(dir), "host.env");
  writeFileSync(outside, "MASTER=1");
  symlinkSync(outside, path.join(dir, "link.txt"));
  mkdirSync(path.join(dir, "sub"));
  symlinkSync(path.dirname(dir), path.join(dir, "sub", "up"));
  writeFileSync(path.join(dir, "big.txt"), "x".repeat(16 * 1024 + 1));
  writeFileSync(path.join(dir, "binary.txt"), Buffer.from([0xff, 0xfe, 0xfd]));
  writeFileSync(path.join(dir, "nul.txt"), "a\0b");
  writeFileSync(path.join(dir, "empty.txt"), "\n");
  writeFileSync(path.join(dir, "blank.txt"), " \t\n");
  const cases: Array<[string, RegExp]> = [
    ["/etc/passwd", /under \/home\/a_1/],
    ["/home/a_2/key.txt", /under \/home\/a_1/],
    ["../host.env", /under \/home\/a_1/],
    ["link.txt", /not a link out of it/],
    ["sub/up/host.env", /not a link out of it/],
    ["missing.txt", /file not found/],
    ["sub", /regular file/],
    ["big.txt", /larger than 16 KiB/],
    ["binary.txt", /UTF-8/],
    ["nul.txt", /NUL byte/],
    ["empty.txt", /empty/],
    ["blank.txt", /empty/],
  ];
  for (const [file, reason] of cases) {
    await assert.rejects(() => readSecretFile(dir, file), reason, file);
  }
});

test("storeAgentSecret grants a new secret to the agent that stored it", async () => {
  const db = new SecretsDb();
  const stored = await storeAgentSecret(db as never, AGENT, { name: "ACME_KEY", description: "Calls Acme", value: "v1" });
  assert.equal(stored.rotated, false);
  const row = db.rows[0]!;
  assert.equal(row.name, "ACME_KEY");
  assert.equal(row.created_by_agent_id, "a_1");
  assert.equal(row.org_wide, false);
  assert.deepEqual((row.grants as Array<{ agent_id: string }>).map((grant) => grant.agent_id), ["a_1"]);
});

test("storeAgentSecret stores and returns the value without the whitespace around it", async () => {
  const db = new SecretsDb();
  const stored = await storeAgentSecret(db as never, AGENT, { name: "ACME_KEY", description: "Calls Acme", value: " v1 \n" });
  assert.equal(stored.value, "v1");
  const ciphertext = db.rows[0]!.ciphertext as Buffer;
  assert.deepEqual(decryptPayload(ciphertext, db.rows[0]!.nonce as Buffer), { value: "v1" });
});

test("storeAgentSecret rotates its own secret and refuses a name held otherwise", async () => {
  const db = new SecretsDb();
  await storeAgentSecret(db as never, AGENT, { name: "ACME_KEY", description: "Calls Acme", value: "v1" });
  const before = db.rows[0]!.ciphertext;
  const rotated = await storeAgentSecret(db as never, AGENT, { name: "ACME_KEY", description: "Calls Acme v2", value: "v2" });
  assert.equal(rotated.rotated, true);
  assert.equal(db.rows.length, 1);
  assert.notDeepEqual(db.rows[0]!.ciphertext, before);
  assert.equal(db.rows[0]!.description, "Calls Acme v2");

  await assert.rejects(
    () => storeAgentSecret(db as never, { id: "a_2", orgId: "org_1" }, { name: "ACME_KEY", description: "d", value: "x" }),
    /ACME_KEY is taken in this organisation; choose another name/,
  );
  db.rows[0]!.grants = [
    { guild_id: null, agent_id: "a_1", name: "a", in_guild_id: "g" },
    { guild_id: "g", agent_id: null, name: "g", in_guild_id: "g" },
  ];
  await assert.rejects(
    () => storeAgentSecret(db as never, AGENT, { name: "ACME_KEY", description: "d", value: "x" }),
    /is taken in this organisation/,
  );
  db.rows.push({ id: "sec_op", name: "OPERATOR_KEY", org_wide: true, grants: [], created_by_agent_id: null });
  await assert.rejects(
    () => storeAgentSecret(db as never, AGENT, { name: "OPERATOR_KEY", description: "d", value: "x" }),
    /is taken in this organisation/,
  );
});

test("storeAgentSecret validates its input and stops at the per-agent cap", async () => {
  const db = new SecretsDb();
  await assert.rejects(() => storeAgentSecret(db as never, AGENT, { name: "1BAD", description: "d", value: "x" }), AgentSecretError);
  await assert.rejects(() => storeAgentSecret(db as never, AGENT, { name: "OK", description: "", value: "x" }), AgentSecretError);
  await assert.rejects(
    () => storeAgentSecret(db as never, AGENT, { name: "OK", description: "d", value: " \n" }),
    /value must contain non-whitespace text/,
  );
  await assert.rejects(
    () => storeAgentSecret(db as never, AGENT, { name: "OK", description: "d".repeat(401), value: "x" }),
    /at most 400/,
  );
  for (let index = 0; index < AGENT_SECRET_CAP; index += 1) {
    await storeAgentSecret(db as never, AGENT, { name: `KEY_${index}`, description: "d", value: "x" });
  }
  await assert.rejects(
    () => storeAgentSecret(db as never, AGENT, { name: "ONE_TOO_MANY", description: "d", value: "x" }),
    /already stored 20 secrets/,
  );
  await storeAgentSecret(db as never, AGENT, { name: "KEY_0", description: "rotating is not a new secret", value: "y" });
});

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

test("secret_store redacts the stored value from later results in the generation", async () => {
  const redactions: Record<string, string> = {};
  const echo: Tool = {
    name: "echo_value",
    description: "",
    output_filter: (result) => result,
    filter_name: "identity",
    schema: {},
    handler: async () => "the key is sk-live-999",
  };
  const stores: Array<Record<string, unknown>> = [];
  const ctx = createToolContext({
    run_id: "r_1",
    agent_id: "a_1",
    guild_id: "g_1",
    sandbox: null,
    secrets: redactions,
    dynamic_tools: { echo_value: echo },
    secret_store: {
      store: async (input) => {
        stores.push(input);
        return { name: String(input.name), rotated: false, value: "sk-live-999" };
      },
    },
  });
  const [stored] = await invokeTool(ctx, call("secret_store", { name: "ACME_KEY", description: "d", file: "key.txt" }), redactions, 32768);
  assert.deepEqual(stores, [{ name: "ACME_KEY", description: "d", file: "key.txt" }]);
  assert.match(String(stored.content), /\{"stored":"ACME_KEY","rotated":false\}/);
  assert.match(String(stored.content), /in your environment from the next generation/);
  assert.equal(String(stored.content).includes("sk-live-999"), false);
  const [echoed] = await invokeTool(ctx, call("echo_value", {}), redactions, 32768);
  assert.match(String(echoed.content), /the key is \[REDACTED:ACME_KEY\]/);
});

test("secret_request asks in a direct chat and writes nothing", async () => {
  const ctx = createToolContext({
    run_id: "r_1",
    agent_id: "a_1",
    guild_id: "g_1",
    sandbox: null,
    secrets: {},
    secret_names: ["ALREADY_SET"],
  });
  const args = { name: "ACME_KEY", description: "Calls Acme", reason: "The report needs Acme data." };
  const [asked] = await invokeTool(ctx, call("secret_request", args), {}, 32768);
  const [first, line] = String(asked.content).split("\n");
  assert.deepEqual(JSON.parse(first!), { widget: "secret_request", name: "ACME_KEY", status: "asked" });
  assert.match(String(line), /End your turn now/);
  const [available] = await invokeTool(ctx, call("secret_request", { ...args, name: "ALREADY_SET" }), {}, 32768);
  assert.match(String(available.content), /^\{"status":"available"\}/);
  const [noReason] = await invokeTool(ctx, call("secret_request", { ...args, reason: " " }), {}, 32768);
  assert.match(String(noReason.content), /reason must contain/);
  const groupCtx = { ...ctx, run_kind: "group" };
  const [group] = await invokeTool(groupCtx, call("secret_request", args), {}, 32768);
  assert.match(String(group.content), /only available in a direct chat/);
});

test("secret_request is offered on direct runs only; secret_store on every run", () => {
  const names = ["secret_store", "secret_request", "group_post"];
  assert.deepEqual(offeredToolNames(names, { direct: true }), [...names, "report_issue"]);
  assert.deepEqual(offeredToolNames(names, { schedules: true }), ["secret_store", "group_post", "report_issue"]);
  assert.deepEqual(offeredToolNames(names, {}), ["secret_store", "group_post", "report_issue"]);
});

test("the generation's secret store removes the value file and resyncs the agent's active runs", async () => {
  const secrets = new SecretsDb();
  const db = Object.assign(new FakeDB({ secrets: [] }), {
    getSecretByName: secrets.getSecretByName.bind(secrets),
    countSecretsCreatedByAgent: secrets.countSecretsCreatedByAgent.bind(secrets),
    insertSecret: secrets.insertSecret.bind(secrets),
    updateSecret: secrets.updateSecret.bind(secrets),
  });
  const root = tempDir("guilds-secret-loop-");
  mkdirSync(path.join(root, "mach_1", "a_1"), { recursive: true });
  const file = path.join(root, "mach_1", "a_1", "key.txt");
  writeFileSync(file, "sk-live-777\n");
  const sandboxes = new FakeSandboxes();
  sandboxes.running.add("mach_1");
  const loop = makeLoop(db, {}, root, sandboxes);
  const store = loop.secrets.secretStore(agentRow());
  const stored = await store.store({ name: "ACME_KEY", description: "Calls Acme", file: "/home/a_1/key.txt" });
  assert.deepEqual(stored, { name: "ACME_KEY", rotated: false, value: "sk-live-777" });
  assert.equal(existsSync(file), false);
  assert.equal(secrets.rows[0]?.name, "ACME_KEY");
  assert.deepEqual(sandboxes.destroyed, [], "a secret reaches commands, never the container");
});

test("applySecretAliases sets each alias to its secret's value, wins over a same-named secret, and skips a missing one", () => {
  const env = { BOB_TOKEN: "bob", CLAUDE_CODE_OAUTH_TOKEN: "shared", OTHER: "o" };
  const aliased = applySecretAliases(env, { CLAUDE_CODE_OAUTH_TOKEN: "BOB_TOKEN", GH_PAT: "MISSING" });
  assert.deepEqual(aliased, { BOB_TOKEN: "bob", CLAUDE_CODE_OAUTH_TOKEN: "bob", OTHER: "o" });
  assert.deepEqual(env.CLAUDE_CODE_OAUTH_TOKEN, "shared", "the input is not changed");
  assert.deepEqual(applySecretAliases(env, {}), env);
});
