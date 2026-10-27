import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { writeBinding } from "../../src/access/bindings.js";
import { operatorActor } from "../../src/artifacts/index.js";
import { CONNECTORS } from "../../src/connectors/index.js";
import { insertAgent, upsertAgentScript } from "../../src/db/agents.js";
import { insertAttachment } from "../../src/db/attachments.js";
import { insertBindingIfAbsent, upsertPlatformBinding } from "../../src/db/bindings.js";
import type { Database } from "../../src/db/client.js";
import { connect } from "../../src/seed/connect.js";
import type { ChangeActor } from "../../src/lib/change-actor.js";
import { insertConnector } from "../../src/db/connectors.js";
import { RowMissing } from "../../src/db/errors.js";
import { postAgentGroupMessage, postUserGroupMessage } from "../../src/db/group-chat.js";
import { insertGuild, insertGuildRepository } from "../../src/db/guilds.js";
import { insertIssue, type NewIssue, setIssueStatus } from "../../src/db/issues.js";
import { insertMachine, updateMachine } from "../../src/db/machines.js";
import { connectMcp, type NewMcpConnection, replaceMcpTools } from "../../src/db/mcp.js";
import { insertOrg, upsertOrgModelProvider } from "../../src/db/orgs.js";
import { createRun, insertMessage } from "../../src/db/runs.js";
import { insertSchedule } from "../../src/db/schedules.js";
import { insertSecret } from "../../src/db/secrets.js";
import { insertUser } from "../../src/db/users.js";
import type { MachineInput } from "../../src/machines/index.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const dbName = uniqueDbName("agent_platform_row_missing");
let database: Database;
let machineId: string;

const GUILD = "guild_errors";
const AGENT = "a_errors";
const RUN = "r_errors";
const SERVER = "mcp_notion";
const ACTOR: ChangeActor = {
  actorType: "user",
  actorId: "user_operator",
  actorName: "operator",
  toolCall: null,
};
const MACHINE_INPUT: MachineInput = {
  name: "errors-box",
  box: "standard",
  cpu: null,
  memory_mib: null,
  max_workspace_mib: 1024,
};
const AGENT_CONFIG = {
  model: "openrouter/openai/gpt-5.6-luna",
  temperature: 1,
  max_tokens: 8192,
  max_steps: 30,
  max_tool_calls: 50,
  max_input_tokens: 100000,
  browser: false,
};

function newIssue(issueId: string): NewIssue {
  return {
    issueId,
    guildId: GUILD,
    orgId: "org_home",
    agentId: AGENT,
    agentName: "errors-agent",
    runId: null,
    kind: "other",
    severity: "low",
    summary: "Something broke.",
    detail: "",
    toolName: null,
  };
}

function newConnection(connectionId: string, ownerId: string): NewMcpConnection {
  return {
    connectionId,
    bindingId: `bind_${connectionId}`,
    serverId: SERVER,
    ownerScope: "org",
    ownerId,
    ciphertext: Buffer.from("ciphertext"),
    nonce: Buffer.from("nonce"),
    bind: false,
  };
}

/** Runs `write` while every row of `event` on `table` is dropped before it is written. */
async function withSkippedRows<T>(
  table: string,
  event: "INSERT" | "UPDATE",
  write: () => Promise<T>,
): Promise<T> {
  await database.pool.query(
    `CREATE TRIGGER skip_rows BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION test_skip_row()`,
  );
  try {
    return await write();
  } finally {
    await database.pool.query(`DROP TRIGGER skip_rows ON ${table}`);
  }
}

/** Runs `write` while every row updated on `table` is deleted once the statement wrote it. */
async function withDeletedAfterUpdate<T>(table: string, write: () => Promise<T>): Promise<T> {
  await database.pool.query(
    `CREATE TRIGGER delete_rows AFTER UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION test_delete_row()`,
  );
  try {
    return await write();
  } finally {
    await database.pool.query(`DROP TRIGGER delete_rows ON ${table}`);
  }
}

function rowMissing(message: string) {
  return (error: unknown) => error instanceof RowMissing && error.message === message;
}

before(async () => {
  const databaseUrl = await createIsolatedDatabase(dbName);
  database = await connect(databaseUrl);
  await database.pool.query(`
    CREATE FUNCTION test_skip_row() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RETURN NULL;
    END $$;
    CREATE FUNCTION test_delete_row() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      EXECUTE format('DELETE FROM %I WHERE id = $1', TG_TABLE_NAME) USING NEW.id;
      RETURN NULL;
    END $$;
  `);
  const now = new Date();
  await insertGuild(
    database.pool,
    { guildId: GUILD, name: "errors-guild", orgId: "org_home" },
    now,
  );
  await insertAgent(
    database.pool,
    { agentId: AGENT, guildId: GUILD, name: "errors-agent", config: AGENT_CONFIG },
    now,
  );
  await createRun(
    database.pool,
    {
      runId: RUN,
      agentId: AGENT,
      configSnapshot: AGENT_CONFIG,
      systemContent: "system",
      taskContent: "task",
      userContent: null,
      systemPromptHash: "system",
      taskPromptHash: "task",
      memoryPromptHash: "memory",
    },
    now,
  );
  const machine = await insertMachine(
    database.pool,
    "org_home",
    { ...MACHINE_INPUT, name: "errors-existing" },
    now,
  );
  machineId = machine.id;
});

after(async () => {
  await database.close();
  await dropIsolatedDatabase(dbName);
});

describe("RowMissing", { concurrency: 1 }, () => {
  const cases: Array<{
    name: string;
    table?: string;
    event?: "INSERT" | "UPDATE";
    write: () => Promise<unknown>;
    message: string;
  }> = [
    {
      name: "a user insert that writes no row raises RowMissing",
      table: "users",
      event: "INSERT",
      write: () =>
        insertUser(database.pool, { userId: "user_skipped", name: "skipped" }, new Date()),
      message: "user insert failed",
    },
    {
      name: "an agent insert into a missing guild raises RowMissing",
      write: () =>
        insertAgent(
          database.pool,
          { agentId: "a_orphan", guildId: "guild_missing", name: "orphan", config: AGENT_CONFIG },
          new Date(),
        ),
      message: "agent insert failed: guild not found",
    },
    {
      name: "a script upsert for a missing agent raises RowMissing",
      write: () =>
        upsertAgentScript(
          database.pool,
          {
            scriptId: "scr_orphan",
            agentId: "a_missing",
            name: "orphan",
            description: "",
            parameters: null,
            source: "print(1)\n",
            sourceHash: "hash",
          },
          operatorActor({
            orgId: "org_home",
            actorId: "user_operator",
            actorName: "operator",
          }),
          new Date(),
        ),
      message: "agent script upsert failed",
    },
    {
      name: "a script upsert that writes no row raises RowMissing",
      table: "artifacts",
      event: "INSERT",
      write: () =>
        upsertAgentScript(
          database.pool,
          {
            scriptId: "scr_skipped",
            agentId: AGENT,
            name: "skipped",
            description: "",
            parameters: null,
            source: "print(1)\n",
            sourceHash: "hash",
          },
          operatorActor({
            orgId: "org_home",
            actorId: "user_operator",
            actorName: "operator",
          }),
          new Date(),
        ),
      message: "agent script upsert failed",
    },
    {
      name: "a machine insert that writes no row raises RowMissing",
      table: "machines",
      event: "INSERT",
      write: () => insertMachine(database.pool, "org_home", MACHINE_INPUT, new Date()),
      message: "machine insert failed",
    },
    {
      name: "a machine update that writes no row raises RowMissing",
      table: "machines",
      event: "UPDATE",
      write: () => updateMachine(database.pool, "org_home", machineId, MACHINE_INPUT, new Date()),
      message: "machine update failed",
    },
    {
      name: "an org insert that writes no row raises RowMissing",
      table: "orgs",
      event: "INSERT",
      write: () =>
        insertOrg(
          database.pool,
          { orgId: "org_skipped", name: "Skipped", slug: "skipped", userId: "user_operator" },
          new Date(),
        ),
      message: "org insert failed",
    },
    {
      name: "a model provider upsert that writes no row raises RowMissing",
      table: "org_model_providers",
      event: "INSERT",
      write: () =>
        upsertOrgModelProvider(
          database.pool,
          {
            providerId: "mp_skipped",
            orgId: "org_home",
            provider: "openai",
            ciphertext: null,
            nonce: null,
            keyHint: null,
            models: [],
          },
          new Date(),
        ),
      message: "model provider upsert failed",
    },
    {
      name: "a schedule insert that writes no row raises RowMissing",
      table: "schedules",
      event: "INSERT",
      write: () =>
        insertSchedule(
          database.pool,
          {
            scheduleId: "sch_skipped",
            agentId: AGENT,
            timing: { cron: "0 * * * *", window: null },
            description: "Hourly",
            instruction: "Check in.",
            wake: { at: new Date(), windowFires: 0 },
          },
          new Date(),
        ),
      message: "schedule insert failed",
    },
    {
      name: "a binding insert that writes no row raises RowMissing",
      table: "bindings",
      event: "INSERT",
      write: () =>
        insertBindingIfAbsent(
          database.pool,
          {
            bindingId: "bind_absent",
            catalogKind: "mcp",
            catalogId: SERVER,
            scope: "agent",
            scopeId: AGENT,
            enabled: true,
          },
          new Date(),
        ),
      message: "binding insert failed",
    },
    {
      name: "a binding upsert that inserts no row raises RowMissing",
      table: "bindings",
      event: "INSERT",
      write: () =>
        writeBinding(
          database.pool,
          {
            bindingId: "bind_upsert_insert",
            catalogKind: "mcp_tool",
            catalogId: "notion__upsert_insert",
            scope: "agent",
            scopeId: AGENT,
            enabled: true,
            connectionId: null,
          },
          new Date(),
          ACTOR,
        ),
      message: "binding insert failed",
    },
    {
      name: "a platform binding upsert that inserts no row raises RowMissing",
      table: "bindings",
      event: "INSERT",
      write: () =>
        upsertPlatformBinding(
          database.pool,
          {
            bindingId: "bind_platform_insert",
            catalogKind: "mcp_tool",
            catalogId: "notion__platform_insert",
            enabled: true,
            connectionId: null,
          },
          new Date(),
        ),
      message: "platform binding insert failed",
    },
    {
      name: "a connector insert that writes no row raises RowMissing",
      table: "connectors",
      event: "INSERT",
      write: () => {
        const notion = CONNECTORS.bySlug("notion");
        assert.ok(notion);
        return insertConnector(
          database.pool,
          {
            id: "mcp_skipped",
            slug: "skipped",
            toolPrefix: "skipped",
            ownerOrgId: "org_home",
            manifest: { ...notion.manifest, slug: "skipped" },
            source: "local",
            verified: false,
            publisher: "",
            enabled: true,
          },
          new Date(),
        );
      },
      message: "connector insert failed",
    },
    {
      name: "an attachment insert that writes no row raises RowMissing",
      table: "attachments",
      event: "INSERT",
      write: () =>
        insertAttachment(
          database.pool,
          {
            id: "att_skipped",
            orgId: "org_home",
            uploadedBy: "user_operator",
            filename: "pixel.png",
            mime: "image/png",
            bytes: 1,
            sha256: "hash",
            kind: "image",
          },
          new Date(),
        ),
      message: "attachment insert failed",
    },
    {
      name: "a message insert that writes no row raises RowMissing",
      table: "messages",
      event: "INSERT",
      write: () =>
        insertMessage(
          database.pool,
          { runId: RUN, seq: 99, payload: { role: "assistant", content: "skipped" }, metadata: {} },
          new Date(),
        ),
      message: "message insert failed",
    },
    {
      name: "a guild repository insert that writes no row raises RowMissing",
      table: "guild_repositories",
      event: "INSERT",
      write: () =>
        insertGuildRepository(
          database.pool,
          {
            id: "repo_skipped",
            guildId: GUILD,
            name: "acme/skipped",
            url: "https://github.com/acme/skipped",
            defaultBranch: "main",
            connectionId: null,
            githubId: null,
          },
          new Date(),
        ),
      message: "guild repository insert failed",
    },
    {
      name: "a secret insert that writes no row raises RowMissing",
      table: "secrets",
      event: "INSERT",
      write: () =>
        insertSecret(
          database.pool,
          {
            secretId: "sec_skipped",
            orgId: "org_home",
            name: "SKIPPED",
            description: "",
            access: { org_wide: true, guild_ids: [], agent_ids: [] },
            ciphertext: Buffer.from("ciphertext"),
            nonce: Buffer.from("nonce"),
          },
          new Date(),
        ),
      message: "secret insert failed",
    },
    {
      name: "a user's group message whose sequence update writes no row raises RowMissing",
      table: "guilds",
      event: "UPDATE",
      write: () =>
        postUserGroupMessage(
          database.pool,
          {
            guildId: GUILD,
            content: "hello",
            taggedNames: [],
            taggedAgentIds: [],
            taggedUserIds: [],
          },
          new Date(),
        ),
      message: "group chat sequence update failed",
    },
    {
      name: "an agent's group message whose sequence update writes no row raises RowMissing",
      table: "guilds",
      event: "UPDATE",
      write: () =>
        postAgentGroupMessage(
          database.pool,
          {
            guildId: GUILD,
            agentId: AGENT,
            authorName: "errors-agent",
            sourceRunId: RUN,
            content: "hello",
            taggedNames: [],
            taggedAgentIds: [],
            taggedUserIds: [],
          },
          new Date(),
        ),
      message: "group chat sequence update failed",
    },
    {
      name: "a new mcp connection that writes no row raises RowMissing",
      table: "mcp_connections",
      event: "INSERT",
      write: () => connectMcp(database.pool, newConnection("conn_skipped", "org_home"), new Date()),
      message: "mcp connection write failed",
    },
    {
      name: "a tool listing for a missing mcp connection raises RowMissing",
      write: () => replaceMcpTools(database.pool, "conn_missing", [], new Date()),
      message: "mcp connection not found",
    },
    {
      name: "an issue insert that writes no row raises RowMissing",
      table: "guild_issues",
      event: "INSERT",
      write: () => insertIssue(database.pool, newIssue("iss_skipped"), new Date()),
      message: "issue insert failed",
    },
  ];

  for (const item of cases) {
    test(item.name, async () => {
      const { table, event } = item;
      const write = table && event ? () => withSkippedRows(table, event, item.write) : item.write;
      await assert.rejects(write, rowMissing(item.message));
    });
  }

  test("a binding upsert that updates no row raises RowMissing", async () => {
    const binding = {
      bindingId: "bind_upsert_update",
      catalogKind: "mcp_tool",
      catalogId: "notion__upsert_update",
      scope: "agent",
      scopeId: AGENT,
      enabled: true,
      connectionId: null,
    };
    await writeBinding(database.pool, binding, new Date(), ACTOR);
    await assert.rejects(
      withSkippedRows("bindings", "UPDATE", () =>
        writeBinding(database.pool, { ...binding, enabled: false }, new Date(), ACTOR),
      ),
      rowMissing("binding update failed"),
    );
  });

  test("a platform binding upsert that updates no row raises RowMissing", async () => {
    const binding = {
      bindingId: "bind_platform_update",
      catalogKind: "mcp_tool",
      catalogId: "notion__platform_update",
      enabled: true,
      connectionId: null,
    };
    await upsertPlatformBinding(database.pool, binding, new Date());
    await assert.rejects(
      withSkippedRows("bindings", "UPDATE", () =>
        upsertPlatformBinding(database.pool, { ...binding, enabled: false }, new Date()),
      ),
      rowMissing("platform binding update failed"),
    );
  });

  test("a stored mcp connection whose rewrite writes no row raises RowMissing", async () => {
    await connectMcp(database.pool, newConnection("conn_rewritten", "org_home"), new Date());
    await assert.rejects(
      withSkippedRows("mcp_connections", "UPDATE", () =>
        connectMcp(database.pool, newConnection("conn_rewrite", "org_home"), new Date()),
      ),
      rowMissing("mcp connection write failed"),
    );
  });

  test("an issue status change returns the issue hydrated with its agent", async () => {
    await insertIssue(database.pool, newIssue("iss_resolved"), new Date());
    const resolvedAt = new Date();
    const row = await setIssueStatus(
      database.pool,
      GUILD,
      "iss_resolved",
      { status: "resolved", resolvedAt, resolvedBy: "operator" },
      resolvedAt,
    );
    assert.ok(row);
    assert.equal(row.id, "iss_resolved");
    assert.equal(row.status, "resolved");
    assert.equal(row.resolved_by, "operator");
    assert.equal(row.live_agent_name, "errors-agent");
  });

  test("an issue status change on an issue the guild does not have returns null", async () => {
    const now = new Date();
    const row = await setIssueStatus(
      database.pool,
      GUILD,
      "iss_missing",
      { status: "resolved", resolvedAt: now, resolvedBy: "operator" },
      now,
    );
    assert.equal(row, null);
  });

  test("an issue status change whose issue is gone before it is read back raises RowMissing", async () => {
    await insertIssue(database.pool, newIssue("iss_vanishing"), new Date());
    const now = new Date();
    await assert.rejects(
      withDeletedAfterUpdate("guild_issues", () =>
        setIssueStatus(
          database.pool,
          GUILD,
          "iss_vanishing",
          { status: "resolved", resolvedAt: now, resolvedBy: "operator" },
          now,
        ),
      ),
      rowMissing("issue status update failed: the updated issue was not found"),
    );
  });
});
