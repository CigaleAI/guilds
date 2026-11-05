import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunWakeRow } from "../../src/db/wakes.js";
import type { ActiveGenerations } from "../../src/generation/active-generations.js";
import { ConflictError } from "../../src/generation/errors.js";
import type { RunEvents } from "../../src/generation/events.js";
import {
  RunWakes,
  type RunWakesDatabase,
  type WakeFiringQueries,
} from "../../src/generation/wakes.js";
import { logWriter } from "../../src/observability/log.js";
import { wakeUserMessage } from "../../src/wakes/message.js";
import { wakeUpsLeft } from "../../src/wakes/rules.js";
import { runSnapshot } from "../helpers/generation.js";

const NOW = "2026-11-05T14:12:30.000Z";

function wakeRow(overrides: Partial<RunWakeRow> = {}): RunWakeRow {
  return {
    id: "wk_1",
    run_id: "r_1",
    root_run_id: "r_1",
    agent_id: "a_1",
    due_at: "2026-11-05T14:12:11.000Z",
    message: "check deploy 4812",
    state: "pending",
    cancel_reason: null,
    set_tool_call_id: "call_1",
    created_at: "2026-11-05T14:02:11.000Z",
    fired_at: null,
    ...overrides,
  };
}

function runRow(id: string) {
  const now = new Date(NOW).toISOString();
  return {
    id,
    agent_id: "a_1",
    status: "active" as const,
    kind: "direct" as const,
    config_snapshot: runSnapshot(),
    errors: [],
    created_at: now,
    updated_at: now,
    metadata: {},
    system_prompt_hash: null,
    task_prompt_hash: null,
    memory_prompt_hash: null,
    group_chat_through_seq: null,
    schedule_id: null,
  };
}

/** A loop's wake-ups over a fake store holding `due`, whose firing transaction `fired` answers. */
function fakeWakes(due: RunWakeRow[], fired: (wakeId: string) => RunWakeRow | null) {
  const calls: string[] = [];
  const inserted: string[] = [];
  let conflict = false;
  const tx = {
    markRunWakeFired: async (wakeId: string) => fired(wakeId),
    reopenForWake: async () => false,
    countFiredRunWakes: async () => 1,
    nextGeneration: async () => 2,
    nextSeq: async () => 3,
    insertMessage: async (message: { runId: string; seq: number }) => {
      inserted.push(message.runId);
      return { run_id: message.runId, seq: message.seq };
    },
  } as unknown as WakeFiringQueries;
  const db = {
    getRun: async (runId: string) => runRow(runId),
    nextGeneration: async () => 2,
    listDueRunWakes: async () => due,
    getPendingRunWake: async () => null,
    cancelRunWake: async () => null,
    movePendingRunWake: async () => null,
    wakeFiring: async <T>(work: (queries: WakeFiringQueries) => Promise<T>) => work(tx),
  } as unknown as RunWakesDatabase;
  const wakes = new RunWakes({
    db,
    events: {
      recordError: async () => undefined,
      publishCommitted: async (row: { run_id: string; seq: number }) => {
        calls.push(`published ${row.run_id} ${row.seq}`);
      },
    } as unknown as RunEvents,
    generations: { isAgentBusy: () => false } as unknown as ActiveGenerations,
    starter: {
      beginGeneration: async (runId: string) => {
        calls.push(`begin ${runId}`);
        if (conflict) {
          throw new ConflictError("agent is already generating");
        }
      },
      endGeneration: (runId: string) => {
        calls.push(`end ${runId}`);
      },
      generateInBackground: (runId: string, generation: number) => {
        calls.push(`generate ${runId} ${generation}`);
      },
    },
  });
  return {
    wakes,
    calls,
    inserted,
    conflictOnBegin: () => {
      conflict = true;
    },
  };
}

test("a wake-up no longer pending when its transaction marks it appends nothing and frees the agent", async () => {
  const fake = fakeWakes([wakeRow()], () => null);
  await fake.wakes.fireDueWakes(new Date(NOW));
  assert.deepEqual(fake.calls, ["begin r_1", "end r_1"]);
  assert.deepEqual(fake.inserted, []);
});

test("a wake-up whose agent another generation takes first stays due without a transaction", async () => {
  const fake = fakeWakes([wakeRow()], (wakeId) =>
    wakeRow({ id: wakeId, state: "fired", fired_at: NOW }),
  );
  fake.conflictOnBegin();
  await fake.wakes.fireDueWakes(new Date(NOW));
  assert.deepEqual(fake.calls, ["begin r_1"]);
  assert.deepEqual(fake.inserted, []);
});

test("a wake-up that fails to fire is logged, frees its agent, and the next one still fires", async () => {
  const lines: string[] = [];
  const write = logWriter.write;
  logWriter.write = (chunk: string) => {
    lines.push(chunk);
  };
  const fake = fakeWakes([wakeRow(), wakeRow({ id: "wk_2", run_id: "r_2" })], (wakeId) => {
    if (wakeId === "wk_1") {
      throw new Error("database gone");
    }
    return wakeRow({ id: wakeId, run_id: "r_2", state: "fired", fired_at: NOW });
  });
  try {
    await fake.wakes.fireDueWakes(new Date(NOW));
  } finally {
    logWriter.write = write;
  }
  assert.deepEqual(fake.calls, [
    "begin r_1",
    "end r_1",
    "begin r_2",
    "published r_2 3",
    "generate r_2 2",
  ]);
  assert.match(lines.join(""), /"operation":"wake.fire"/);
});

test("the wake-up message carries when it was set, due and fired, its note, and the wake-ups left", () => {
  const [payload, metadata] = wakeUserMessage(
    wakeRow({ state: "fired", fired_at: NOW }),
    7,
    4,
    true,
  );
  assert.equal(
    payload.content,
    `Wake-up: ${JSON.stringify(
      {
        id: "wk_1",
        set_at: "2026-11-05T14:02:11.000Z",
        due_at: "2026-11-05T14:12:11.000Z",
        fired_at: NOW,
        message: "check deploy 4812",
        wake_ups_left: 7,
      },
      null,
      2,
    )}`,
  );
  assert.deepEqual(metadata, {
    generation: 4,
    source: "wake",
    wake_id: "wk_1",
    reopened_run: true,
  });
});

test("the wake-ups left never go below none", () => {
  assert.equal(wakeUpsLeft(10, 3), 7);
  assert.equal(wakeUpsLeft(2, 5), 0);
});
