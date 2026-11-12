import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { IssueRow, NewIssue } from "../../src/db/issues.js";
import { generationLive } from "../../src/generation/completion.js";
import { AgentDisabledError, ConflictError } from "../../src/generation/errors.js";
import { INTERRUPTED_CONTENT } from "../../src/generation/tool-calls.js";
import { tempDir } from "../helpers/env.js";
import { DeliveryDisabledError } from "../../src/groupchat/delivery.js";
import {
  FakeDB,
  FakeSandboxes,
  fakeStream,
  makeLoop,
  scheduleRow,
  seededLoop,
  toolCall,
} from "../helpers/generation.js";

const live = generationLive;
const originalStream = live.streamCompletion;

after(() => {
  live.streamCompletion = originalStream;
});

/** A run store that also keeps the issues its agent reports. */
class IssueDB extends FakeDB {
  issues: IssueRow[] = [];

  override async getGuild(guildId: string) {
    return guildId === "guild_1" ? { id: "guild_1", name: "research", org_slug: "acme", org_id: "org_1" } : null;
  }

  async getGroupChatState(guildId: string) {
    return { guild_id: guildId, chat_seq: 0, agent_message_count: 0, agent_message_limit: 0, errors: [], pending_agent_count: 0 };
  }

  async countOpenIssues(_guildId: string) {
    return this.issues.length;
  }

  async insertIssue(issue: NewIssue, now: Date): Promise<IssueRow> {
    const row: IssueRow = {
      id: issue.issueId,
      guild_id: issue.guildId,
      org_id: issue.orgId,
      agent_id: issue.agentId,
      agent_name: issue.agentName,
      run_id: issue.runId,
      kind: issue.kind,
      severity: issue.severity,
      status: "open",
      summary: issue.summary,
      detail: issue.detail,
      tool_name: issue.toolName,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      resolved_at: null,
      resolved_by: null,
    };
    this.issues.push(row);
    return row;
  }
}

const REPORT_TOOL = { type: "function" as const, function: { name: "report_issue", description: "", parameters: { type: "object" } } };

function report(id: string, severity: string) {
  return toolCall(id, "report_issue", { summary: `${severity} problem`, detail: "the login was revoked", kind: "api", severity });
}

function toolResults(db: FakeDB): string[] {
  return db.messages
    .map((row) => row.payload as { role?: string; content?: string })
    .filter((payload) => payload.role === "tool")
    .map((payload) => String(payload.content));
}

test("an agent with an open blocking issue is refused a generation, and admitted once it has none", async () => {
  const db = new FakeDB({});
  db.blockingIssue = { id: "iss_1", summary: "Gmail login revoked" };
  const loop = makeLoop(db, {}, tempDir("guilds-blocking-"), new FakeSandboxes());

  await assert.rejects(
    () => loop.beginGeneration("r_1", "a_1"),
    (error: unknown) => {
      assert.ok(error instanceof AgentDisabledError);
      assert.equal(error instanceof ConflictError, false, "a disabled agent is not a busy one");
      assert.match(error.message, /disabled by a blocking issue: Gmail login revoked/);
      assert.match(error.message, /Resolve the issue first/);
      return true;
    },
  );
  assert.equal(loop.isAgentBusy("a_1"), false);

  db.blockingIssue = null;
  await loop.beginGeneration("r_1", "a_1");
  assert.equal(loop.isAgentBusy("a_1"), true);
  loop.endGeneration("r_1");
});

test("a tool call that files a blocking issue ends the generation before the next call and the next model step", async () => {
  const db = new IssueDB({ tools: [REPORT_TOOL] });
  const loop = makeLoop(db, {}, tempDir("guilds-blocking-"), new FakeSandboxes());
  live.streamCompletion = fakeStream(db, [report("call_1", "blocking"), report("call_2", "low")]);

  await loop.generator.generate("r_1", 1);

  assert.equal(db.llm_histories.length, 1);
  assert.deepEqual(db.issues.map((issue) => issue.severity), ["blocking"]);
  const results = toolResults(db);
  assert.equal(results.length, 2);
  assert.match(results[0] ?? "", /severity=blocking status=open/);
  assert.match(results[0] ?? "", /disabled until the operator resolves the issue\. The run ends now\./);
  assert.ok((results[1] ?? "").startsWith(INTERRUPTED_CONTENT));
  const errors = db.run.errors as Array<{ operation: string; message: string }>;
  assert.equal(errors.at(-1)?.operation, "generation.blocked");
  assert.match(errors.at(-1)?.message ?? "", new RegExp(`blocking issue ${db.issues[0]?.id}`));
  assert.equal(db.run.status, "active");
  assert.equal(loop.isAgentBusy("a_1"), false);
});

test("a tool call that files an issue below blocking lets the generation go on", async () => {
  const db = new IssueDB({ tools: [REPORT_TOOL] });
  const loop = makeLoop(db, {}, tempDir("guilds-blocking-"), new FakeSandboxes());
  live.streamCompletion = fakeStream(db, [report("call_1", "high")]);

  await loop.generator.generate("r_1", 1);

  assert.equal(db.llm_histories.length, 2);
  assert.deepEqual(db.run.errors, []);
});

test("a delivery to an agent a blocking issue disabled meanwhile is put off, not made to wait for a lock", async () => {
  const { loop, db } = await seededLoop();
  db.blockingIssue = { id: "iss_1", summary: "Gmail login revoked" };

  await assert.rejects(
    () => loop.runs.deliverGroupRun({ agentId: "a_1", throughSeq: 0, deliveredThrough: 0, recipients: null }),
    (error: unknown) => error instanceof DeliveryDisabledError && /Gmail login revoked/.test(error.message),
  );
  await assert.rejects(
    () => loop.runs.deliverScheduleRun(scheduleRow()),
    (error: unknown) => error instanceof DeliveryDisabledError,
  );
  assert.equal(db.run, null);
  assert.equal(loop.isAgentBusy("a_1"), false);
});

test("a due routine whose agent a blocking issue disabled meanwhile stays due", async () => {
  const { loop, db } = await seededLoop();
  db.due_schedules = [scheduleRow()];
  db.blockingIssue = { id: "iss_1", summary: "Gmail login revoked" };

  await loop.runs.fireDueSchedules(new Date());
  assert.equal(db.fired.length, 0);

  db.blockingIssue = null;
  await loop.runs.fireDueSchedules(new Date());
  assert.equal(db.fired[0]?.id, "sch_1");
  await loop.close();
});
