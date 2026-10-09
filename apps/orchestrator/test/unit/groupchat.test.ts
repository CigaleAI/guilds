import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { AgentMessageLimitReached, GuildInactive } from "../../src/db/errors.js";
import { groupMessageItem } from "../../src/db/views.js";
import {
  CONTEXT_HISTORY_LIMIT,
  DeliveryCreateError,
  GroupChat,
  GroupChatError,
  groupChatHistory,
  groupChatUserMessage,
  limitError,
  parseTags,
  recognizedTags,
  type GroupChatDatabase,
  type GroupRunner,
} from "../../src/groupchat/index.js";
import { AsyncEvent, sleep } from "../../src/lib/event.js";
import { AsyncLock } from "../../src/lib/lock.js";
import { orchestratorRoot } from "../../src/lib/paths.js";
import { createToolContext, invokeTool } from "../../src/toolbox/index.js";
import {
  createGroupRouter,
  createTypeSafeClient,
  type GroupRouter,
} from "../../src/typesafe/index.js";

class MemoryGroupDB implements GroupChatDatabase {
  private readonly lock = new AsyncLock();
  guilds: Record<string, Record<string, unknown>> = {};
  agents: Record<string, Record<string, unknown>> = {};
  runs: Record<string, Record<string, unknown>> = {};
  messages: Array<Record<string, unknown>> = [];
  private nextId = 1;
  private created = 0;

  addGuild(guildId: string, options: { seq?: number; limit?: number } = {}): void {
    this.guilds[guildId] = {
      id: guildId,
      archived_at: null,
      group_chat_seq: options.seq ?? 0,
      group_agent_message_count: 0,
      group_agent_message_limit: options.limit ?? 20,
      group_chat_errors: [],
    };
  }

  addAgent(
    agentId: string,
    guildId: string,
    name: string,
    options: { deliveredThrough?: number } = {},
  ): void {
    const seq = Number(this.guilds[guildId]?.group_chat_seq ?? 0);
    this.created += 1;
    this.agents[agentId] = {
      id: agentId,
      guild_id: guildId,
      name,
      archived_at: null,
      created_at: this.created,
      group_chat_delivered_through:
        options.deliveredThrough === undefined ? seq : options.deliveredThrough,
    };
  }

  addRun(runId: string, agentId: string): void {
    this.runs[runId] = { id: runId, agent_id: agentId };
  }

  async getGuild(guildId: string) {
    return this.guilds[guildId] ?? null;
  }

  async getAgent(agentId: string) {
    return this.agents[agentId] ?? null;
  }

  async listAgents(guildId: string) {
    return Object.values(this.agents).filter((agent) => agent.guild_id === guildId);
  }

  async getRun(runId: string) {
    return this.runs[runId] ?? null;
  }

  async getGroupChatState(guildId: string) {
    const guild = this.guilds[guildId];
    if (!guild) {
      return null;
    }
    const seq = Number(guild.group_chat_seq);
    const pending = Object.values(this.agents).filter(
      (agent) =>
        agent.guild_id === guildId &&
        (agent.archived_at === null || agent.archived_at === undefined) &&
        Number(agent.group_chat_delivered_through) < seq,
    ).length;
    return {
      guild_id: guildId,
      chat_seq: seq,
      agent_message_count: guild.group_agent_message_count,
      agent_message_limit: guild.group_agent_message_limit,
      errors: guild.group_chat_errors,
      pending_agent_count: pending,
    };
  }

  async updateGroupAgentMessageLimit(guildId: string, limit: number, _now: Date) {
    const guild = this.guilds[guildId];
    if (!guild) {
      return null;
    }
    guild.group_agent_message_limit = limit;
    return this.getGroupChatState(guildId);
  }

  async listGroupMessages(guildId: string, options: { throughSeq?: number | null } = {}) {
    let rows = this.messages.filter((row) => row.guild_id === guildId);
    if (options.throughSeq !== undefined && options.throughSeq !== null) {
      rows = rows.filter((row) => Number(row.seq) <= options.throughSeq!);
    }
    return rows;
  }

  async listPendingGroupAgents(guildId: string, chatSeq: number) {
    const pending = Object.values(this.agents).filter(
      (agent) =>
        agent.guild_id === guildId &&
        (agent.archived_at === null || agent.archived_at === undefined) &&
        Number(agent.group_chat_delivered_through) < chatSeq,
    );
    pending.sort(
      (left, right) =>
        Number(left.group_chat_delivered_through) - Number(right.group_chat_delivered_through) ||
        Number(left.created_at) - Number(right.created_at),
    );
    return pending;
  }

  async advanceGroupCursor(agentId: string, seq: number) {
    const agent = this.agents[agentId];
    if (!agent) {
      return;
    }
    agent.group_chat_delivered_through = Math.max(Number(agent.group_chat_delivered_through), seq);
  }

  async appendGroupChatError(guildId: string, entry: Record<string, unknown>, _now: Date) {
    const guild = this.guilds[guildId];
    if (!guild) {
      return [];
    }
    guild.group_chat_errors = [...((guild.group_chat_errors as unknown[]) ?? []), entry];
    return guild.group_chat_errors as unknown[];
  }

  async postUserGroupMessage(
    guildId: string,
    content: string,
    taggedNames: string[],
    taggedAgentIds: string[],
    taggedUserIds: string[],
    now: Date,
    options: { authorName?: string } = {},
  ) {
    return this.lock.run(async () => {
      const guild = this.guilds[guildId];
      if (!guild) {
        return null;
      }
      if (guild.archived_at !== null && guild.archived_at !== undefined) {
        throw new GuildInactive();
      }
      guild.group_chat_seq = Number(guild.group_chat_seq) + 1;
      guild.group_agent_message_count = 0;
      return this.insert(
        guildId,
        Number(guild.group_chat_seq),
        "user",
        options.authorName ?? "user",
        null,
        null,
        content,
        taggedNames,
        taggedAgentIds,
        taggedUserIds,
        now,
      );
    });
  }

  async postAgentGroupMessage(
    guildId: string,
    agentId: string,
    authorName: string,
    sourceRunId: string,
    content: string,
    taggedNames: string[],
    taggedAgentIds: string[],
    taggedUserIds: string[],
    now: Date,
  ) {
    return this.lock.run(async () => {
      const guild = this.guilds[guildId];
      if (!guild) {
        return null;
      }
      if (guild.archived_at !== null && guild.archived_at !== undefined) {
        throw new GuildInactive();
      }
      const limit = Number(guild.group_agent_message_limit);
      if (Number(guild.group_agent_message_count) >= limit) {
        throw new AgentMessageLimitReached(limit);
      }
      guild.group_chat_seq = Number(guild.group_chat_seq) + 1;
      guild.group_agent_message_count = Number(guild.group_agent_message_count) + 1;
      const seq = Number(guild.group_chat_seq);
      const agent = this.agents[agentId];
      if (agent) {
        agent.group_chat_delivered_through = Math.max(
          Number(agent.group_chat_delivered_through),
          seq,
        );
      }
      return this.insert(
        guildId,
        seq,
        "agent",
        authorName,
        agentId,
        sourceRunId,
        content,
        taggedNames,
        taggedAgentIds,
        taggedUserIds,
        now,
      );
    });
  }

  private insert(
    guildId: string,
    seq: number,
    authorType: string,
    authorName: string,
    authorAgentId: string | null,
    sourceRunId: string | null,
    content: string,
    taggedNames: string[],
    taggedAgentIds: string[],
    taggedUserIds: string[],
    now: Date,
  ) {
    const row = {
      id: this.nextId,
      guild_id: guildId,
      seq,
      author_type: authorType,
      author_name: authorName,
      author_agent_id: authorAgentId,
      source_run_id: sourceRunId,
      content,
      tagged_names: taggedNames,
      tagged_agent_ids: taggedAgentIds,
      tagged_user_ids: taggedUserIds,
      created_at: now,
    };
    this.nextId += 1;
    this.messages.push(row);
    return row;
  }
}

function chatFor(
  db: MemoryGroupDB,
  deleting: Set<string> = new Set(),
  router?: GroupRouter,
): GroupChat {
  return new GroupChat(db, {
    is_deleting: (guildId) => deleting.has(guildId),
    ...(router ? { router } : {}),
  });
}

function seedWithRouter(router: GroupRouter): { db: MemoryGroupDB; chat: GroupChat } {
  const db = new MemoryGroupDB();
  db.addGuild("guild_1");
  db.addAgent("a_1", "guild_1", "researcher");
  db.addAgent("a_2", "guild_1", "writer");
  db.addRun("r_1", "a_1");
  db.addRun("r_2", "a_2");
  return { db, chat: chatFor(db, new Set(), router) };
}

function choiceEvaluate(
  choice: string,
  options: { confidence?: number; onCriteria?: (names: string[]) => void } = {},
) {
  const confidence = options.confidence ?? 0.9;
  return createGroupRouter({
    client: createTypeSafeClient({
      evaluate: async ({ questions }) => {
        const question = questions.recipient;
        if (question?.type === "choice") {
          options.onCriteria?.(Object.keys(question.criteria));
        }
        return {
          model: "jev-latest",
          answers: {
            recipient: {
              type: "choice" as const,
              choice,
              probabilities: { [choice]: confidence },
              confidence,
            },
          },
        };
      },
    }),
  });
}

function seed(limit = 20): { db: MemoryGroupDB; chat: GroupChat } {
  const db = new MemoryGroupDB();
  db.addGuild("guild_1", { limit });
  db.addAgent("a_1", "guild_1", "researcher");
  db.addAgent("a_2", "guild_1", "writer");
  db.addRun("r_1", "a_1");
  db.addRun("r_2", "a_2");
  return { db, chat: chatFor(db) };
}

class FakeRunner implements GroupRunner {
  busy = new Set<string>();
  deliveries: Array<[string, number]> = [];
  delivery_cursors: number[] = [];
  fail_agents = new Set<string>();
  lock_generation = 0;
  private readonly lockEvent = new AsyncEvent();
  gate: AsyncEvent | null = null;

  agent_is_busy(agentId: string): boolean {
    return this.busy.has(agentId);
  }

  async wait_lock_release(seen: number): Promise<void> {
    while (this.lock_generation <= seen) {
      this.lockEvent.clear();
      if (this.lock_generation > seen) {
        return;
      }
      await this.lockEvent.wait();
    }
  }

  release(): void {
    this.lock_generation += 1;
    this.lockEvent.set();
  }

  async deliver_group_run(
    agentId: string,
    throughSeq: number,
    deliveredThrough: number,
  ): Promise<void> {
    if (this.fail_agents.has(agentId)) {
      throw new DeliveryCreateError("invalid prompt files");
    }
    if (this.gate) {
      await this.gate.wait();
    }
    this.deliveries.push([agentId, throughSeq]);
    this.delivery_cursors.push(deliveredThrough);
  }
}

async function waitDispatch(chat: GroupChat, guildId = "guild_1"): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const handle = chat._dispatch_tasks.get(guildId);
    if (handle) {
      await handle.promise;
      return;
    }
    await sleep(10);
  }
  const handle = chat._dispatch_tasks.get(guildId);
  if (handle) {
    await handle.promise;
  }
}

function chatRow(seq: number, content: string, author = "user"): Record<string, unknown> {
  const agent = author !== "user";
  return {
    id: seq,
    seq,
    author_type: agent ? "agent" : "user",
    author_name: author,
    author_agent_id: agent ? "a_1" : null,
    content,
    tagged_names: [],
    tagged_agent_ids: [],
  };
}

describe("groupchat", { concurrency: 1 }, () => {
  test("user_post_makes_every_agent_pending", async () => {
    const { chat } = seed();
    const message = await chat.post_user("guild_1", "Plan the release.");
    assert.equal(message.seq, 1);
    assert.equal(message.author_type, "user");
    assert.equal(message.author_name, "user");
    const state = await chat.state("guild_1");
    assert.equal(state.chat_seq, 1);
    assert.equal(state.pending_agent_count, 2);
    assert.equal(state.agent_message_count, 0);
    assert.equal(state.dispatching, false);
  });

  test("user_post_snapshots_author_name", async () => {
    const { chat } = seed();
    const message = await chat.post_user("guild_1", "From ada.", { author_name: "ada" });
    assert.equal(message.author_type, "user");
    assert.equal(message.author_name, "ada");
  });

  test("posting_agent_advances_own_cursor", async () => {
    const { db, chat } = seed();
    await chat.post_user("guild_1", "Plan the release.");
    const ack = await chat.post_from_run(
      "r_1",
      "a_1",
      "guild_1",
      "researcher",
      "I found the constraints.",
    );
    assert.equal(ack, "posted id=2 seq=2");
    assert.equal(db.agents.a_1?.group_chat_delivered_through, 2);
    assert.equal(db.agents.a_2?.group_chat_delivered_through, 0);
    const state = await chat.state("guild_1");
    assert.equal(state.pending_agent_count, 1);
    assert.equal(state.agent_message_count, 1);
    const listed = await chat.list_messages("guild_1");
    assert.deepEqual(
      listed.map((item) => item.author_type),
      ["user", "agent"],
    );
    assert.equal(listed[1]?.author_name, "researcher");
    assert.equal(listed[1]?.source_run_id, "r_1");
  });

  test("user_post_resets_agent_message_count", async () => {
    const { chat } = seed();
    await chat.post_user("guild_1", "start");
    await chat.post_from_run("r_1", "a_1", "guild_1", "researcher", "one");
    await chat.post_user("guild_1", "continue");
    const state = await chat.state("guild_1");
    assert.equal(state.agent_message_count, 0);
    assert.equal(state.chat_seq, 3);
  });

  test("nth_agent_message_commits_and_next_is_rejected", async () => {
    const { chat } = seed(2);
    await chat.post_user("guild_1", "start");
    await chat.post_from_run("r_1", "a_1", "guild_1", "researcher", "one");
    await chat.post_from_run("r_2", "a_2", "guild_1", "writer", "two");
    const rejected = await chat.post_from_run("r_1", "a_1", "guild_1", "researcher", "three");
    assert.equal(rejected, limitError(2));
    const listed = await chat.list_messages("guild_1");
    assert.deepEqual(
      listed.map((item) => item.seq),
      [1, 2, 3],
    );
    const state = await chat.state("guild_1");
    assert.equal(state.limit_reached, true);
    assert.equal(state.agent_message_count, 2);
  });

  test("concurrent_user_posts_get_unique_sequences", async () => {
    const { chat } = seed();
    const results = await Promise.all([
      chat.post_user("guild_1", "one"),
      chat.post_user("guild_1", "two"),
      chat.post_user("guild_1", "three"),
    ]);
    assert.deepEqual(
      results.map((item) => Number(item.seq)).sort((a, b) => a - b),
      [1, 2, 3],
    );
    assert.equal(new Set(results.map((item) => item.id)).size, 3);
  });

  test("empty_guild_post_publishes_idle", async () => {
    const db = new MemoryGroupDB();
    db.addGuild("guild_1");
    const chat = chatFor(db);
    const queue = chat.subscribe("guild_1");
    await chat.post_user("guild_1", "hello");
    const events: Array<[string, Record<string, unknown>]> = [];
    while (!queue.empty()) {
      events.push(await queue.get());
    }
    assert.deepEqual(
      events.map(([name]) => name),
      ["group.message.committed", "group.idle"],
    );
  });

  test("limit_reached_publishes_notice", async () => {
    const { chat } = seed(1);
    const queue = chat.subscribe("guild_1");
    await chat.post_user("guild_1", "start");
    await chat.post_from_run("r_1", "a_1", "guild_1", "researcher", "one");
    const events: Array<[string, Record<string, unknown>]> = [];
    while (!queue.empty()) {
      events.push(await queue.get());
    }
    const names = events.map(([name]) => name);
    assert.ok(names.includes("group.limit_reached"));
  });

  test("post_rejected_while_deleting", async () => {
    const { db } = seed();
    const chat = chatFor(db, new Set(["guild_1"]));
    await assert.rejects(
      () => chat.post_user("guild_1", "nope"),
      (error: unknown) => {
        assert.ok(error instanceof GroupChatError);
        assert.equal(error.status, 409);
        return true;
      },
    );
  });

  test("blank_content_is_rejected", async () => {
    const { chat } = seed();
    await assert.rejects(
      () => chat.post_user("guild_1", "   "),
      (error: unknown) => {
        assert.ok(error instanceof GroupChatError);
        assert.equal(error.status, 422);
        return true;
      },
    );
  });

  test("set_limit_requires_positive_integer", async () => {
    const { chat } = seed();
    await assert.rejects(
      () => chat.set_limit("guild_1", 0),
      (error: unknown) => {
        assert.ok(error instanceof GroupChatError);
        assert.equal(error.status, 422);
        return true;
      },
    );
    const state = await chat.set_limit("guild_1", 5);
    assert.equal(state.agent_message_limit, 5);
  });

  test("new_agent_cursor_starts_at_current_seq", async () => {
    const { db, chat } = seed();
    await chat.post_user("guild_1", "already happened");
    db.addAgent("a_3", "guild_1", "latecomer");
    const state = await chat.state("guild_1");
    assert.equal(db.agents.a_3?.group_chat_delivered_through, 1);
    assert.equal(state.pending_agent_count, 2);
  });

  test("recognized_tags_survive_membership_changes", async () => {
    const { db, chat } = seed();
    const message = await chat.post_user("guild_1", "@writer handle this.");
    assert.deepEqual(message.tagged, ["writer"]);
    assert.deepEqual(message.tagged_agent_ids, ["a_2"]);
    if (db.agents.a_2) {
      db.agents.a_2.archived_at = new Date();
    }
    db.addAgent("a_3", "guild_1", "writer", { deliveredThrough: 0 });
    const listed = await chat.list_messages("guild_1");
    assert.deepEqual(listed[0]?.tagged, ["writer"]);
    assert.deepEqual(listed[0]?.tagged_agent_ids, ["a_2"]);
    const runner = new FakeRunner();
    chat.bind(runner);
    await chat.wake("guild_1");
    await waitDispatch(chat);
    assert.deepEqual(runner.deliveries, []);
  });

  test("operator_tags_are_stored_and_observed", async () => {
    const { db, chat } = seed();
    const guild = db.guilds.guild_1 as Record<string, unknown>;
    guild.operators = [{ user_id: "user_ada", name: "ada", role: "admin" }];
    const observed: Array<[string, Record<string, unknown>]> = [];
    chat.observe(async (_guildId, event, data) => {
      observed.push([event, data]);
    });
    db.addRun("r_1", "a_1");
    await chat.post_from_run("r_1", "a_1", "guild_1", "researcher", "@ada the digest is ready");
    const [stored] = await chat.list_messages("guild_1");
    assert.deepEqual(stored?.tagged, ["ada"]);
    assert.deepEqual(stored?.tagged_agent_ids, []);
    assert.deepEqual(stored?.tagged_user_ids, ["user_ada"]);
    const committed = observed.find(([event]) => event === "group.message.committed");
    assert.deepEqual(committed?.[1].tagged_user_ids, ["user_ada"]);
  });

  test("group_post_tool_writes_public_message", async () => {
    const { chat } = seed();
    await chat.post_user("guild_1", "start");
    const ctx = createToolContext({
      run_id: "r_1",
      agent_id: "a_1",
      guild_id: "guild_1",
      sandbox: null,
      secrets: {},
      group_chat: chat,
      agent_name: "researcher",
    });
    const [payload, metadata] = await invokeTool(
      ctx,
      {
        id: "call_1",
        function: { name: "group_post", arguments: '{"content":"shared finding"}' },
      },
      {},
      1024,
    );
    assert.equal(payload.content, "posted id=2 seq=2");
    assert.equal(metadata.error, null);
    const listed = await chat.list_messages("guild_1");
    assert.equal(listed[listed.length - 1]?.content, "shared finding");
  });

  test("group_post_tool_returns_waiting_error_at_limit", async () => {
    const { db, chat } = seed(1);
    await chat.post_user("guild_1", "start");
    await chat.post_from_run("r_1", "a_1", "guild_1", "researcher", "one");
    const ctx = createToolContext({
      run_id: "r_2",
      agent_id: "a_2",
      guild_id: "guild_1",
      sandbox: null,
      secrets: {},
      group_chat: chat,
      agent_name: "writer",
    });
    const [payload] = await invokeTool(
      ctx,
      {
        id: "call_2",
        function: { name: "group_post", arguments: '{"content":"too many"}' },
      },
      {},
      1024,
    );
    assert.equal(payload.content, limitError(1));
    assert.deepEqual(
      db.messages.map((item) => item.content),
      ["start", "one"],
    );
  });

  test("purge_guild_deletes_the_guild_row", () => {
    const source = readFileSync(
      path.join(orchestratorRoot(import.meta.url), "src/db/repositories.ts"),
      "utf8",
    );
    assert.ok(source.includes("DELETE FROM guilds"));
    assert.match(source, /group_chat_seq/);
    assert.match(source, /group_chat_delivered_through/);
  });

  test("purge_agent_deletes_the_agent_row", () => {
    const source = readFileSync(
      path.join(orchestratorRoot(import.meta.url), "src/db/repositories.ts"),
      "utf8",
    );
    assert.ok(source.includes("DELETE FROM agents"));
  });

  test("group_message_item_shape", () => {
    const now = new Date();
    const item = groupMessageItem({
      id: 42,
      seq: 7,
      author_type: "agent",
      author_name: "researcher",
      author_agent_id: "a_1",
      source_run_id: "r_1",
      content: "found it",
      tagged_names: ["writer"],
      tagged_agent_ids: ["a_2"],
      created_at: now,
    });
    assert.equal(item.id, 42);
    assert.equal(item.seq, 7);
    assert.deepEqual(item.tagged, ["writer"]);
    assert.deepEqual(item.tagged_agent_ids, ["a_2"]);
    assert.equal(item.created_at, now.toISOString());
  });

  test("group_chat_user_message_is_slim_wake", () => {
    const [payload, meta] = groupChatUserMessage({
      members: [
        { id: "a_1", name: "agent1" },
        { id: "a_2", name: "agent2" },
      ],
      rows: [
        {
          id: 1,
          seq: 1,
          author_type: "user",
          author_name: "user",
          author_agent_id: null,
          content: "Plan the release.",
          tagged_names: [],
          tagged_agent_ids: [],
        },
        {
          id: 2,
          seq: 2,
          author_type: "agent",
          author_name: "agent1",
          author_agent_id: "a_1",
          content: "I found the relevant constraints.",
          tagged_names: [],
          tagged_agent_ids: [],
        },
      ],
    });
    assert.equal(payload.role, "user");
    const content = String(payload.content);
    assert.ok(content.startsWith("Group Chat info: "));
    const info = JSON.parse(content.slice("Group Chat info: ".length)) as Record<string, unknown>;
    assert.deepEqual(Object.keys(info), ["latestMessage", "youWereTagged"]);
    assert.deepEqual(info.latestMessage, {
      sentBy: "agent1",
      content: "I found the relevant constraints.",
      tagged: [],
    });
    assert.equal(info.youWereTagged, false);
    assert.equal(meta.source, "group_chat");
    assert.equal(meta.group_seq, 2);
    assert.equal(meta.author_name, "agent1");
  });

  test("group_chat_history_returns_all_rows_by_default", () => {
    const rows = Array.from({ length: 12 }, (_, index) => chatRow(index + 1, `m${index + 1}`));
    const history = groupChatHistory(rows);
    assert.deepEqual(
      history.map((item) => item.content),
      Array.from({ length: 12 }, (_, index) => `m${index + 1}`),
    );
  });

  test("group_chat_history_keeps_last_n", () => {
    const rows = Array.from({ length: 12 }, (_, index) => chatRow(index + 1, `m${index + 1}`));
    const history = groupChatHistory(rows, { limit: CONTEXT_HISTORY_LIMIT });
    assert.deepEqual(
      history.map((item) => item.content),
      Array.from({ length: 10 }, (_, index) => `m${index + 3}`),
    );
    assert.deepEqual(groupChatHistory(rows, { limit: 0 }), []);
    assert.deepEqual(groupChatHistory(rows.slice(0, 3), { limit: 10 }), [
      { sentBy: "user", content: "m1", tagged: [] },
      { sentBy: "user", content: "m2", tagged: [] },
      { sentBy: "user", content: "m3", tagged: [] },
    ]);
  });

  test("parse_tags_matches_members_and_user", () => {
    const names = new Set(["researcher", "writer", "user"]);
    assert.deepEqual(parseTags("ask @writer and @user", names), ["writer", "user"]);
    assert.deepEqual(parseTags("no tags here", names), []);
    assert.deepEqual(parseTags("email@writer.com @unknown @researcher", names), ["researcher"]);
    assert.deepEqual(parseTags("@writer-extra @writer", names), ["writer"]);
  });

  test("recognized_tags_resolve_agents_and_operators", () => {
    const members = [
      { id: "a_1", name: "researcher", archived_at: null },
      { id: "a_2", name: "writer", archived_at: null },
    ];
    const operators = [
      { user_id: "user_ada", name: "ada", role: "admin" as const },
      { user_id: "user_bo", name: "bo", role: "operator" as const },
    ];
    assert.deepEqual(recognizedTags("@writer draft it, then @ada reviews", members, operators), {
      names: ["writer", "ada"],
      agentIds: ["a_2"],
      userIds: ["user_ada"],
    });
    assert.deepEqual(recognizedTags("@user and @bo, please decide", members, operators), {
      names: ["user", "bo"],
      agentIds: [],
      userIds: ["user_ada", "user_bo"],
    });
    assert.deepEqual(recognizedTags("@cy is not an operator", members, operators).names, []);
  });

  test("history_names_the_person_who_posted", () => {
    const history = groupChatHistory([
      { seq: 1, author_type: "user", author_name: "ada", content: "hi", tagged_names: [] },
      { seq: 2, author_type: "agent", author_name: "writer", content: "@ada done", tagged_names: ["ada"] },
    ]);
    assert.deepEqual(history, [
      { sentBy: "ada", content: "hi", tagged: [] },
      { sentBy: "writer", content: "@ada done", tagged: ["ada"] },
    ]);
  });

  test("group_chat_user_message_flags_viewer_tag", () => {
    const [payload, meta] = groupChatUserMessage({
      members: [
        { id: "a_1", name: "researcher", archived_at: null },
        { id: "a_2", name: "writer" },
      ],
      rows: [
        {
          id: 1,
          seq: 1,
          author_type: "user",
          author_name: "user",
          author_agent_id: null,
          content: "@writer please take this.",
          tagged_names: ["writer"],
          tagged_agent_ids: ["a_2"],
        },
      ],
      viewerName: "writer",
    });
    const info = JSON.parse(String(payload.content).slice("Group Chat info: ".length)) as Record<
      string,
      unknown
    >;
    assert.deepEqual((info.latestMessage as { tagged: string[] }).tagged, ["writer"]);
    assert.equal(info.youWereTagged, true);
    assert.deepEqual(meta.tagged, ["writer"]);
    assert.equal(meta.you_were_tagged, true);
  });

  test("group_chat_user_message_flags_tag_anywhere_after_cursor", () => {
    const rows = [
      {
        id: 1,
        seq: 1,
        author_type: "user",
        author_name: "user",
        author_agent_id: null,
        content: "@writer please take this.",
        tagged_names: ["writer"],
        tagged_agent_ids: ["a_2"],
      },
      {
        id: 2,
        seq: 2,
        author_type: "agent",
        author_name: "researcher",
        author_agent_id: "a_1",
        content: "Status update.",
        tagged_names: [],
        tagged_agent_ids: [],
      },
    ];
    const members = [
      { id: "a_1", name: "researcher" },
      { id: "a_2", name: "writer" },
    ];
    let [payload, meta] = groupChatUserMessage({
      members,
      rows,
      viewerName: "writer",
      deliveredThrough: 0,
    });
    let info = JSON.parse(String(payload.content).slice("Group Chat info: ".length)) as Record<
      string,
      unknown
    >;
    assert.equal(info.youWereTagged, true);
    assert.equal(meta.you_were_tagged, true);
    assert.deepEqual(meta.recipients, ["writer"]);
    [payload, meta] = groupChatUserMessage({
      members,
      rows,
      viewerName: "writer",
      deliveredThrough: 1,
    });
    info = JSON.parse(String(payload.content).slice("Group Chat info: ".length)) as Record<
      string,
      unknown
    >;
    assert.equal(info.youWereTagged, false);
    assert.equal(meta.you_were_tagged, false);
    assert.deepEqual(meta.recipients, []);
  });

  test("dispatcher_runs_each_pending_agent_in_order", async () => {
    const { db, chat } = seed();
    const runner = new FakeRunner();
    chat.bind(runner);
    await chat.post_user("guild_1", "Plan the release.");
    await waitDispatch(chat);
    assert.deepEqual(runner.deliveries, [
      ["a_1", 1],
      ["a_2", 1],
    ]);
    assert.equal(db.agents.a_1?.group_chat_delivered_through, 1);
    assert.equal(db.agents.a_2?.group_chat_delivered_through, 1);
    const state = await chat.state("guild_1");
    assert.equal(state.pending_agent_count, 0);
    assert.equal(state.dispatching, false);
  });

  test("dispatcher_skips_busy_agent_for_idle_peer", async () => {
    const { db, chat } = seed();
    const runner = new FakeRunner();
    runner.busy.add("a_1");
    chat.bind(runner);
    await chat.post_user("guild_1", "Plan the release.");
    await sleep(50);
    assert.deepEqual(runner.deliveries, [["a_2", 1]]);
    assert.equal(db.agents.a_1?.group_chat_delivered_through, 0);
    runner.busy.clear();
    runner.release();
    await waitDispatch(chat);
    assert.deepEqual(runner.deliveries, [
      ["a_2", 1],
      ["a_1", 1],
    ]);
  });

  test("message_during_delivery_leaves_agent_pending", async () => {
    const { db, chat } = seed();
    const runner = new FakeRunner();
    runner.gate = new AsyncEvent();
    chat.bind(runner);
    await chat.post_user("guild_1", "first");
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (chat.is_dispatching("guild_1")) {
        break;
      }
      await sleep(10);
    }
    await chat.post_user("guild_1", "second");
    runner.gate.set();
    await waitDispatch(chat);
    assert.equal(db.agents.a_1?.group_chat_delivered_through, 2);
    assert.equal(db.agents.a_2?.group_chat_delivered_through, 2);
    assert.equal(Math.max(...runner.deliveries.map((item) => item[1])), 2);
    assert.ok(runner.deliveries.length >= 2);
  });

  test("invalid_agent_does_not_block_peers", async () => {
    const { db, chat } = seed();
    const runner = new FakeRunner();
    runner.fail_agents.add("a_1");
    chat.bind(runner);
    await chat.post_user("guild_1", "Plan the release.");
    await waitDispatch(chat);
    assert.deepEqual(runner.deliveries, [["a_2", 1]]);
    assert.equal(db.agents.a_1?.group_chat_delivered_through, 1);
    const errors = db.guilds.guild_1?.group_chat_errors as Array<Record<string, unknown>>;
    assert.equal(errors[errors.length - 1]?.agent_id, "a_1");
    const state = await chat.state("guild_1");
    assert.equal(state.pending_agent_count, 0);
  });

  test("untagged_agent_post_does_not_wake_peers", async () => {
    const { db, chat } = seed();
    const runner = new FakeRunner();
    chat.bind(runner);
    await chat.post_user("guild_1", "Plan the release.");
    await waitDispatch(chat);
    runner.deliveries = [];
    await chat.post_from_run("r_1", "a_1", "guild_1", "researcher", "Status only, no tag.");
    await waitDispatch(chat);
    assert.deepEqual(runner.deliveries, []);
    assert.equal(db.agents.a_2?.group_chat_delivered_through, 2);
  });

  test("earlier_user_post_still_wakes_peer_after_untagged_agent_post", async () => {
    const { db, chat } = seed();
    await chat.post_user("guild_1", "Plan the release.");
    await chat.post_from_run("r_1", "a_1", "guild_1", "researcher", "Status only, no tag.");
    const runner = new FakeRunner();
    chat.bind(runner);
    await chat.wake("guild_1");
    await waitDispatch(chat);
    assert.deepEqual(runner.deliveries, [["a_2", 2]]);
    assert.deepEqual(runner.delivery_cursors, [0]);
    assert.equal(db.agents.a_2?.group_chat_delivered_through, 2);
  });

  test("tagged_agent_post_wakes_only_tagged_peer", async () => {
    const { db, chat } = seed();
    const runner = new FakeRunner();
    chat.bind(runner);
    await chat.post_user("guild_1", "Plan the release.");
    await waitDispatch(chat);
    runner.deliveries = [];
    await chat.post_from_run("r_1", "a_1", "guild_1", "researcher", "@writer please check this.");
    await waitDispatch(chat);
    assert.deepEqual(runner.deliveries, [["a_2", 2]]);
    assert.equal(db.agents.a_2?.group_chat_delivered_through, 2);
  });

  test("user_tag_targets_one_agent", async () => {
    const { db, chat } = seed();
    const runner = new FakeRunner();
    chat.bind(runner);
    await chat.post_user("guild_1", "@writer handle this.");
    await waitDispatch(chat);
    assert.deepEqual(runner.deliveries, [["a_2", 1]]);
    assert.equal(db.agents.a_1?.group_chat_delivered_through, 1);
    assert.equal(db.agents.a_2?.group_chat_delivered_through, 1);
  });

  test("agent_user_tag_does_not_wake_peers", async () => {
    const { db, chat } = seed();
    const runner = new FakeRunner();
    chat.bind(runner);
    await chat.post_user("guild_1", "Plan the release.");
    await waitDispatch(chat);
    runner.deliveries = [];
    await chat.post_from_run("r_1", "a_1", "guild_1", "researcher", "Done @user");
    await waitDispatch(chat);
    assert.deepEqual(runner.deliveries, []);
    assert.equal(db.agents.a_2?.group_chat_delivered_through, 2);
  });

  test("typesafe_untagged_user_wakes_only_selected_agent", async () => {
    const { db, chat } = seedWithRouter(choiceEvaluate("writer"));
    const runner = new FakeRunner();
    chat.bind(runner);
    await chat.post_user("guild_1", "Write the release note.");
    await waitDispatch(chat);
    assert.deepEqual(runner.deliveries, [["a_2", 1]]);
    assert.equal(db.agents.a_1?.group_chat_delivered_through, 1);
    assert.equal(db.agents.a_2?.group_chat_delivered_through, 1);
    assert.equal(chat.lastRecipientDecision?.source, "typesafe");
    const state = await chat.state("guild_1");
    assert.deepEqual(state.last_recipient_decision, {
      through_seq: 1,
      source: "typesafe",
      names: ["writer"],
      choice: "writer",
      confidence: 0.9,
      probabilities: { writer: 0.9 },
      model: "jev-latest",
    });
  });

  test("typesafe_keeps_explicit_tags_when_model_picks_nobody", async () => {
    const { db, chat } = seedWithRouter(choiceEvaluate("none"));
    const runner = new FakeRunner();
    chat.bind(runner);
    await chat.post_user("guild_1", "@writer handle this.");
    await waitDispatch(chat);
    assert.deepEqual(runner.deliveries, [["a_2", 1]]);
    assert.equal(db.agents.a_1?.group_chat_delivered_through, 1);
  });

  test("typesafe_low_confidence_falls_back_to_tag_rules", async () => {
    const { db, chat } = seedWithRouter(choiceEvaluate("writer", { confidence: 0.3 }));
    const runner = new FakeRunner();
    chat.bind(runner);
    await chat.post_user("guild_1", "Hmm, what do we do next?");
    await waitDispatch(chat);
    assert.deepEqual(runner.deliveries, [
      ["a_1", 1],
      ["a_2", 1],
    ]);
    assert.equal(db.agents.a_1?.group_chat_delivered_through, 1);
    assert.equal(chat.lastRecipientDecision?.source, "low_confidence");
    assert.equal(chat.lastRecipientDecision?.choice, "writer");
  });

  test("typesafe_agent_post_offers_only_pending_peers", async () => {
    const seen: string[][] = [];
    const { db, chat } = seedWithRouter(
      choiceEvaluate("writer", { onCriteria: (names) => seen.push(names) }),
    );
    const runner = new FakeRunner();
    chat.bind(runner);
    await chat.post_user("guild_1", "Plan the release.");
    await waitDispatch(chat);
    runner.deliveries = [];
    seen.length = 0;
    await chat.post_from_run(
      "r_1",
      "a_1",
      "guild_1",
      "researcher",
      "Sources gathered, draft next.",
    );
    await waitDispatch(chat);
    // The author is never pending for its own post, so it is not an option.
    assert.deepEqual(seen, [["none", "writer"]]);
    assert.deepEqual(runner.deliveries, [["a_2", 2]]);
    assert.equal(db.agents.a_1?.group_chat_delivered_through, 2);
    assert.equal(db.agents.a_2?.group_chat_delivered_through, 2);
  });

  test("typesafe_api_failure_delivers_to_everyone", async () => {
    const { chat } = seedWithRouter(
      createGroupRouter({
        client: createTypeSafeClient({
          evaluate: async () => {
            throw new Error("TypeSafe HTTP 503");
          },
        }),
      }),
    );
    const runner = new FakeRunner();
    chat.bind(runner);
    await chat.post_user("guild_1", "@writer handle this.");
    await waitDispatch(chat);
    assert.deepEqual(runner.deliveries, [
      ["a_1", 1],
      ["a_2", 1],
    ]);
    assert.equal(chat.lastRecipientDecision?.source, "fallback");
  });
});
