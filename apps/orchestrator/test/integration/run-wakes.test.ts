import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Database } from "../../src/db/client.js";
import { insertGuild } from "../../src/db/guilds.js";
import { isUniqueViolation } from "../../src/db/pg.js";
import { createRun } from "../../src/db/runs.js";
import {
  cancelRunWake,
  countFiredRunWakes,
  getPendingRunWake,
  listDueRunWakes,
  markRunWakeFired,
  movePendingRunWake,
  setRunWake,
  type NewRunWake,
} from "../../src/db/wakes.js";
import { newId } from "../../src/lib/ids.js";
import { connect } from "../../src/seed/connect.js";
import { addTestAgent } from "../helpers/agents.js";
import { agentConfig, runSnapshot } from "../helpers/generation.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const dbName = uniqueDbName("agent_platform_run_wakes");
const NOW = new Date("2026-11-05T14:00:00.000Z");
const MINUTE = 60_000;
let database: Database;

before(async () => {
  database = await connect(await createIsolatedDatabase(dbName));
  await insertGuild(
    database.pool,
    { guildId: "guild_wakes", name: "wakes", orgId: "org_home", about: "" },
    NOW,
  );
  await addTestAgent(database.pool, "org_home", {
    agentId: "a_waker",
    guildId: "guild_wakes",
    name: "waker",
    config: agentConfig(),
  });
});

after(async () => {
  await database.close();
  await dropIsolatedDatabase(dbName);
});

async function addRun(): Promise<string> {
  const runId = newId("run");
  await createRun(
    database.pool,
    {
      runId,
      agentId: "a_waker",
      configSnapshot: runSnapshot(agentConfig()),
      systemContent: "system",
      taskContent: "task",
      userContent: "start",
      systemPromptHash: "s",
      taskPromptHash: "t",
      memoryPromptHash: "m",
    },
    NOW,
  );
  return runId;
}

function wakeFor(runId: string, minutes: number, rootRunId = runId): NewRunWake {
  return {
    wakeId: newId("wk"),
    runId,
    rootRunId,
    agentId: "a_waker",
    dueAt: new Date(NOW.getTime() + minutes * MINUTE),
    message: `check after ${minutes} minutes`,
    setToolCallId: `call_${minutes}`,
  };
}

describe("run wakes", { concurrency: 1 }, () => {
  test("sets a pending wake-up with nothing replaced", async () => {
    const runId = await addRun();
    const wake = wakeFor(runId, 10);
    const set = await setRunWake(database.pool, wake, NOW);
    assert.equal(set.replaced, null);
    assert.equal(set.wake.id, wake.wakeId);
    assert.equal(set.wake.state, "pending");
    assert.equal(set.wake.cancel_reason, null);
    assert.equal(set.wake.fired_at, null);
    assert.equal(set.wake.message, "check after 10 minutes");
    assert.equal(set.wake.set_tool_call_id, "call_10");
    assert.equal(new Date(set.wake.due_at).getTime(), wake.dueAt.getTime());
    assert.equal((await getPendingRunWake(database.pool, runId))?.id, wake.wakeId);
  });

  test("setting again cancels the pending one as replaced", async () => {
    const runId = await addRun();
    const first = await setRunWake(database.pool, wakeFor(runId, 10), NOW);
    const second = await setRunWake(database.pool, wakeFor(runId, 20), NOW);
    assert.equal(second.replaced?.id, first.wake.id);
    assert.equal(second.replaced?.state, "cancelled");
    assert.equal(second.replaced?.cancel_reason, "replaced");
    assert.equal((await getPendingRunWake(database.pool, runId))?.id, second.wake.id);
  });

  test("concurrent sets on one run leave one pending wake-up", async () => {
    const runId = await addRun();
    const sets = await Promise.all(
      [1, 2, 3].map((minutes) => setRunWake(database.pool, wakeFor(runId, minutes), NOW)),
    );
    const pending = await database.pool.query<{ id: string }>(
      "SELECT id FROM run_wakes WHERE run_id = $1 AND state = 'pending'",
      [runId],
    );
    assert.equal(pending.rows.length, 1);
    assert.equal(sets.filter((set) => set.replaced === null).length, 1);
  });

  test("the index refuses a second pending wake-up for a run", async () => {
    const runId = await addRun();
    await setRunWake(database.pool, wakeFor(runId, 10), NOW);
    await assert.rejects(
      database.pool.query(
        `INSERT INTO run_wakes (id, run_id, root_run_id, agent_id, due_at, state, set_tool_call_id, created_at)
         VALUES ($1, $2, $2, 'a_waker', $3, 'pending', 'call_x', $3)`,
        [newId("wk"), runId, NOW.toISOString()],
      ),
      isUniqueViolation,
    );
  });

  test("the checks refuse a cancel reason outside cancelled and a fired wake-up without its time", async () => {
    const runId = await addRun();
    const insert = (state: string, reason: string | null, firedAt: string | null) =>
      database.pool.query(
        `INSERT INTO run_wakes (id, run_id, root_run_id, agent_id, due_at, state, cancel_reason, set_tool_call_id, created_at, fired_at)
         VALUES ($1, $2, $2, 'a_waker', $3, $4, $5, 'call_x', $3, $6)`,
        [newId("wk"), runId, NOW.toISOString(), state, reason, firedAt],
      );
    await assert.rejects(insert("pending", "agent", null), /run_wakes_cancelled_has_reason/);
    await assert.rejects(insert("cancelled", null, null), /run_wakes_cancelled_has_reason/);
    await assert.rejects(insert("cancelled", "bored", null), /run_wakes_cancel_reason_check/);
    await assert.rejects(insert("fired", null, null), /run_wakes_fired_has_time/);
    await assert.rejects(insert("asleep", null, null), /run_wakes_state_check/);
  });

  test("cancels the pending wake-up with its reason and answers null without one", async () => {
    const runId = await addRun();
    const set = await setRunWake(database.pool, wakeFor(runId, 10), NOW);
    const cancelled = await cancelRunWake(database.pool, runId, "operator");
    assert.equal(cancelled?.id, set.wake.id);
    assert.equal(cancelled?.state, "cancelled");
    assert.equal(cancelled?.cancel_reason, "operator");
    assert.equal(await getPendingRunWake(database.pool, runId), null);
    assert.equal(await cancelRunWake(database.pool, runId, "agent"), null);
  });

  test("lists pending wake-ups due at a time earliest first", async () => {
    await database.pool.query("DELETE FROM run_wakes");
    const [early, late, future, cancelled] = [
      await addRun(),
      await addRun(),
      await addRun(),
      await addRun(),
    ];
    const earlyWake = await setRunWake(database.pool, wakeFor(early, -5), NOW);
    const lateWake = await setRunWake(database.pool, wakeFor(late, 0), NOW);
    await setRunWake(database.pool, wakeFor(future, 1), NOW);
    await setRunWake(database.pool, wakeFor(cancelled, -10), NOW);
    await cancelRunWake(database.pool, cancelled, "agent");
    const due = await listDueRunWakes(database.pool, NOW);
    assert.deepEqual(
      due.map((wake) => wake.id),
      [earlyWake.wake.id, lateWake.wake.id],
    );
  });

  test("marks a pending wake-up fired once", async () => {
    const runId = await addRun();
    const set = await setRunWake(database.pool, wakeFor(runId, 0), NOW);
    const firedAt = new Date(NOW.getTime() + 19_000);
    const fired = await markRunWakeFired(database.pool, set.wake.id, firedAt);
    assert.equal(fired?.state, "fired");
    assert.equal(new Date(fired?.fired_at ?? "").getTime(), firedAt.getTime());
    assert.equal(await markRunWakeFired(database.pool, set.wake.id, firedAt), null);
    assert.equal(await getPendingRunWake(database.pool, runId), null);
  });

  test("a cancelled wake-up is not marked fired", async () => {
    const runId = await addRun();
    const set = await setRunWake(database.pool, wakeFor(runId, 0), NOW);
    await cancelRunWake(database.pool, runId, "limit");
    assert.equal(await markRunWakeFired(database.pool, set.wake.id, NOW), null);
  });

  test("moves the pending wake-up to the continuation keeping its chain", async () => {
    const [previous, continuation] = [await addRun(), await addRun()];
    const set = await setRunWake(database.pool, wakeFor(previous, 10), NOW);
    const moved = await movePendingRunWake(database.pool, previous, continuation);
    assert.equal(moved?.id, set.wake.id);
    assert.equal(moved?.run_id, continuation);
    assert.equal(moved?.root_run_id, previous);
    assert.equal(await getPendingRunWake(database.pool, previous), null);
    assert.equal((await getPendingRunWake(database.pool, continuation))?.id, set.wake.id);
    assert.equal(await movePendingRunWake(database.pool, previous, continuation), null);
  });

  test("counts fired wake-ups across a chain and not replaced or cancelled ones", async () => {
    const [root, continuation, other] = [await addRun(), await addRun(), await addRun()];
    const first = await setRunWake(database.pool, wakeFor(root, 0), NOW);
    await markRunWakeFired(database.pool, first.wake.id, NOW);
    await setRunWake(database.pool, wakeFor(root, 5), NOW);
    await setRunWake(database.pool, wakeFor(root, 6), NOW);
    await movePendingRunWake(database.pool, root, continuation);
    const moved = await getPendingRunWake(database.pool, continuation);
    assert.ok(moved);
    await markRunWakeFired(database.pool, moved.id, NOW);
    await setRunWake(database.pool, wakeFor(continuation, 9, root), NOW);
    await cancelRunWake(database.pool, continuation, "agent");
    const elsewhere = await setRunWake(database.pool, wakeFor(other, 0), NOW);
    await markRunWakeFired(database.pool, elsewhere.wake.id, NOW);
    assert.equal(await countFiredRunWakes(database.pool, root), 2);
    assert.equal(await countFiredRunWakes(database.pool, newId("run")), 0);
  });

  test("deleting a run deletes its wake-ups", async () => {
    const runId = await addRun();
    await setRunWake(database.pool, wakeFor(runId, 10), NOW);
    await database.pool.query("DELETE FROM runs WHERE id = $1", [runId]);
    const left = await database.pool.query("SELECT id FROM run_wakes WHERE run_id = $1", [runId]);
    assert.equal(left.rows.length, 0);
  });
});
