import assert from "node:assert/strict";
import { test } from "node:test";
import type pg from "pg";
import { bindingChange } from "../../src/access/changes.js";
import {
  collectionCleared,
  collectionColumnsChanged,
  collectionDeleted,
} from "../../src/artifacts/collection-changes.js";
import { artifactStore } from "../../src/artifacts/store.js";
import { actorColumns, studioLink } from "../../src/db/config-changes.js";
import { runActor, userActor } from "../../src/lib/change-actor.js";
import type { ScheduleRow } from "../../src/db/schedules.js";
import { guildTextChange } from "../../src/guilds/service.js";
import { routineChange, routineUpdateSummary } from "../../src/schedules/changes.js";
import { editActor } from "../../src/studio/actor.js";
import type { EditScope } from "../../src/studio/edits.js";

const ROUTINE = {
  id: "sch_1",
  agent_id: "a_1",
  cron: "0 9 * * 1",
  wake_window: null,
  window_fires: 0,
  description: "Weekly sweep",
  instruction: "Sweep the feed.",
  paused: false,
  next_run_at: "2026-10-19T09:00:00.000Z",
  last_run_at: null,
  created_at: "2026-10-12T09:00:00.000Z",
  updated_at: "2026-10-12T09:00:00.000Z",
} satisfies ScheduleRow;

test("a routine coming into existence is logged as a create against its agent", () => {
  assert.deepEqual(routineChange(null, ROUTINE), {
    targetKind: "routine",
    targetId: "sch_1",
    agentId: "a_1",
    operation: "create",
    summary: 'Created "Weekly sweep"',
  });
});

test("a deleted routine is logged as a delete, named by its id when it has no description", () => {
  const change = routineChange({ ...ROUTINE, description: " " }, null);
  assert.equal(change?.operation, "delete");
  assert.equal(change?.summary, 'Deleted "sch_1"');
});

test("a routine edit names what it paused, resumed, or changed", () => {
  assert.equal(
    routineUpdateSummary(ROUTINE, { ...ROUTINE, paused: true }),
    'Paused "Weekly sweep"',
  );
  assert.equal(
    routineUpdateSummary({ ...ROUTINE, paused: true }, ROUTINE),
    'Resumed "Weekly sweep"',
  );
  assert.equal(
    routineUpdateSummary(ROUTINE, {
      ...ROUTINE,
      cron: "0 10 * * 1",
      instruction: "Sweep and post.",
    }),
    'Changed the timing and instruction of "Weekly sweep"',
  );
  assert.equal(
    routineUpdateSummary(ROUTINE, {
      ...ROUTINE,
      paused: true,
      description: "Daily",
      instruction: "Look.",
      cron: "0 8 * * *",
    }),
    'Paused and changed the timing, description and instruction of "Daily"',
  );
  assert.equal(routineChange(ROUTINE, { ...ROUTINE, paused: true })?.operation, "update");
});

test("a routine change with neither a before nor an after logs nothing", () => {
  assert.equal(routineChange(null, null), null);
});

test("a routine write that changes nothing logs nothing", () => {
  assert.equal(routineUpdateSummary(ROUTINE, { ...ROUTINE }), null);
  assert.equal(routineChange(ROUTINE, { ...ROUTINE }), null);
  assert.equal(routineChange(null, null), null);
});

test("a binding change names the setting and where it sits", () => {
  const key = {
    catalogKind: "native_tool",
    catalogId: "schedule_list",
    scope: "agent",
    scopeId: "a_1",
  };
  assert.deepEqual(bindingChange(key, null, false), {
    orgId: null,
    guildId: null,
    agentId: "a_1",
    targetKind: "access",
    targetId: "schedule_list",
    operation: "create",
    summary: "Turned off tool schedule_list",
  });
  assert.equal(bindingChange(key, false, true)?.summary, "Turned on tool schedule_list");
  assert.equal(bindingChange(key, false, true)?.operation, "update");
  const removed = bindingChange(
    { ...key, catalogKind: "mcp", scope: "guild", scopeId: "g_1" },
    true,
    null,
  );
  assert.equal(removed?.operation, "delete");
  assert.equal(removed?.guildId, "g_1");
  assert.equal(removed?.summary, "Reset connector schedule_list to inherit");
  assert.equal(
    bindingChange({ ...key, catalogKind: "other" }, null, true)?.summary,
    "Turned on other schedule_list",
  );
});

test("a platform binding and a binding set to what it was log nothing", () => {
  const key = { catalogKind: "native_tool", catalogId: "shell", scope: "platform", scopeId: null };
  assert.equal(bindingChange(key, null, true), null);
  assert.equal(bindingChange({ ...key, scope: "org", scopeId: "org_1" }, true, true), null);
});

test("a guild text change names the fields that moved", () => {
  const before = { about: "Leads", description: "Find leads." };
  assert.equal(guildTextChange("g_1", before, { ...before }), null);
  assert.equal(
    guildTextChange("g_1", before, { ...before, about: "Deals" })?.summary,
    "Changed the about",
  );
  assert.deepEqual(
    guildTextChange("g_1", before, { about: "Deals", description: "Close deals." }),
    {
      guildId: "g_1",
      targetKind: "guild_text",
      targetId: "g_1",
      operation: "update",
      summary: "Changed the about and description",
    },
  );
});

test("table deletes, delete all, and column renames or removals are logged against the table", () => {
  const ref = { id: "acol_1", name: "leads", orgId: "org_1", guildId: "g_1" };
  assert.deepEqual(collectionDeleted(ref), {
    orgId: "org_1",
    guildId: "g_1",
    targetKind: "collection",
    targetId: "acol_1",
    operation: "delete",
    summary: "Deleted the table leads",
  });
  assert.equal(collectionCleared(ref, 0), null);
  assert.equal(collectionCleared(ref, 1)?.summary, "Deleted all 1 record of leads");
  assert.equal(collectionCleared(ref, 12)?.summary, "Deleted all 12 records of leads");
  assert.equal(collectionColumnsChanged(ref, { renamed: [], removed: [] }), null);
  assert.equal(
    collectionColumnsChanged(ref, { renamed: [{ from: "url", to: "link" }], removed: ["notes"] })
      ?.summary,
    "Renamed the column url to link, removed the column notes in leads",
  );
});

test("change actors fill the shared actor, run, call, and coach columns", () => {
  const person = userActor({ id: "user_ada", name: "ada" });
  assert.equal(person.actorName, "ada");
  assert.deepEqual(actorColumns({ ...person, studio: { sessionId: "ss_1", seq: 7 } }), [
    "user",
    "user_ada",
    "ada",
    null,
    null,
    null,
    "ss_1",
    7,
  ]);
  const run = runActor(
    { runId: "r_1", agentName: "scout" },
    { id: "call_1", name: "schedule_pause" },
  );
  assert.deepEqual(actorColumns(run), [
    "run",
    "r_1",
    "scout",
    "r_1",
    "call_1",
    "schedule_pause",
    null,
    null,
  ]);
});

test("a stored change links to its coach message only when it has both session and sequence", () => {
  assert.deepEqual(studioLink({ studio_session_id: "ss_1", studio_seq: 7 }), {
    session_id: "ss_1",
    seq: 7,
  });
  assert.equal(studioLink({ studio_session_id: "ss_1", studio_seq: null }), null);
  assert.equal(studioLink({ studio_session_id: null, studio_seq: 7 }), null);
});

test("a Studio edit writes as the operator, linked to the coach message being applied", () => {
  const scope = {
    orgId: "org_1",
    sourceGuildId: "g_1",
    sessionId: "ss_1",
    user: { id: "user_ada", name: "ada" },
    artifacts: artifactStore({} as pg.Pool),
  } as unknown as EditScope;
  const reading = editActor(scope, { agentId: "a_1" });
  assert.equal(reading.studio, undefined);
  assert.equal(reading.guildId, "g_1");
  assert.equal(reading.agentId, "a_1");
  const applying = editActor({ ...scope, origin: { sessionId: "ss_1", seq: 7 } });
  assert.deepEqual(applying.studio, { sessionId: "ss_1", seq: 7 });
  assert.equal(applying.actorId, "user_ada");
});
