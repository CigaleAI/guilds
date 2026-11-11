import assert from "node:assert/strict";
import { test } from "node:test";
import type { Queryable } from "../../src/db/pg.js";
import type { GuildRow } from "../../src/db/guilds.js";
import type { RoutineChange } from "../../src/schedules/operator.js";
import { propagateAppliedEdit, type EditAnswerDeps } from "../../src/studio/edit-answers.js";
import type { EditRecord } from "../../src/studio/edits.js";
import type { LiveStudioSession } from "../../src/studio/session.js";

// What an applied edit request carries past its target: the session's record of its guild, and
// the guild's routine and files channels.

/** What the fake services were sent: the database's statements, and each channel's announcements. */
type Sent = { queries: string[]; files: string[]; routines: Array<[string, RoutineChange]> };

function answerDeps(): { deps: EditAnswerDeps; sent: Sent } {
  const sent: Sent = { queries: [], files: [], routines: [] };
  const db = {
    query: async (text: string) => {
      sent.queries.push(text);
      return { rows: [] };
    },
  } as unknown as Queryable;
  const deps: EditAnswerDeps = {
    db,
    artifacts: {} as never,
    schedules: {} as never,
    publishFilesChanged: async (guildId) => {
      sent.files.push(guildId);
    },
    publishRoutinesChanged: async (guildId, change) => {
      sent.routines.push([guildId, change]);
    },
  };
  return { deps, sent };
}

const session = { id: "s_1", org_id: "org_1", source_guild_id: "guild_1" } as LiveStudioSession;

function record(toolName: EditRecord["toolName"]): EditRecord {
  return { toolName } as EditRecord;
}

const guild = { id: "guild_1", name: "digest", about: "News", description: "Coordinate the digest." } as GuildRow;

test("an_applied_guild_edit_rewrites_the_sessions_guild_and_announces_nothing", async () => {
  const { deps, sent } = answerDeps();
  await propagateAppliedEdit(deps, session, record("studio_edit_guild"), { version: null, guild });
  assert.equal(sent.queries.length, 1);
  assert.match(sent.queries[0] ?? "", /^UPDATE studio_sessions/);
  assert.deepEqual(sent.files, []);
  assert.deepEqual(sent.routines, []);
});

test("an_applied_routine_edit_is_announced_on_the_guilds_routine_channel", async () => {
  const { deps, sent } = answerDeps();
  const routine: RoutineChange = { agentId: "a_1", action: "create", scheduleId: "sch_1" };
  await propagateAppliedEdit(deps, session, record("studio_edit_routine"), { version: null, routine });
  assert.deepEqual(sent.routines, [["guild_1", routine]]);
  assert.deepEqual(sent.files, []);
  assert.deepEqual(sent.queries, []);
});

test("an_applied_memory_edit_is_announced_on_the_guilds_files_channel", async () => {
  const { deps, sent } = answerDeps();
  await propagateAppliedEdit(deps, session, record("studio_edit_memory"), { version: 3 });
  assert.deepEqual(sent.files, ["guild_1"]);
  assert.deepEqual(sent.routines, []);
  assert.deepEqual(sent.queries, []);
});

test("an_applied_access_edit_is_not_announced", async () => {
  const { deps, sent } = answerDeps();
  await propagateAppliedEdit(deps, session, record("studio_edit_access"), { version: null });
  assert.deepEqual(sent, { queries: [], files: [], routines: [] });
});

test("an_applied_file_edit_on_a_box_without_a_files_channel_is_not_announced", async () => {
  const { deps, sent } = answerDeps();
  const { publishFilesChanged: _, ...withoutFiles } = deps;
  await propagateAppliedEdit(withoutFiles, session, record("studio_edit_note"), { version: 2 });
  assert.deepEqual(sent, { queries: [], files: [], routines: [] });
});
