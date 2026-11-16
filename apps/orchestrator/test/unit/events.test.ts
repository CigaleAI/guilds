import assert from "node:assert/strict";
import { test } from "node:test";
import { RunEventBus as RunEventBusClass, type RunEventBus, type RunEventsDatabase } from "../../src/generation/events.js";
import { EventQueue } from "../../src/lib/event.js";
import { tempDir } from "../helpers/env.js";
import { FakeSandboxes, makeLoop } from "../helpers/generation.js";
import { overflowStream, sseApp } from "../helpers/sse.js";

/** A run's event bus with nothing behind it. */
function runEventBus(): RunEventBus {
  return makeLoop({}, {}, tempDir("guilds-events-"), new FakeSandboxes()).events;
}

/** An app whose `/stream` pipes run `r_1`'s events from `bus`. */
function runStreamApp(bus: RunEventBus) {
  return sseApp(
    () => bus.subscribe("r_1"),
    (queue) => bus.unsubscribe("r_1", queue),
  );
}

test("a_dropped_queue_discards_what_it_holds_and_refuses_the_next_read", async () => {
  const queue = new EventQueue<string>();
  await queue.put("held");
  queue.drop();
  assert.equal(queue.dropped, true);
  assert.equal(queue.size, 0);
  await assert.rejects(queue.get());
});

test("a_dropped_queue_refuses_a_read_that_waits", async () => {
  const queue = new EventQueue<string>();
  const read = queue.get();
  queue.drop();
  await assert.rejects(read);
});

test("a_slow_subscriber_is_closed_not_silenced", async () => {
  const bus = runEventBus();
  const { app, opened } = runStreamApp(bus);
  const { body, queue } = await overflowStream(app, opened, () =>
    Array.from({ length: 8192 }, () => bus.publish("r_1", "assistant.delta", { text: "x" })),
  );
  assert.equal(queue.dropped, true);
  assert.ok(body.startsWith(": connected\n\n"), body.slice(0, 40));
  await bus.publish("r_1", "assistant.delta", { text: "after" });
  assert.equal(queue.size, 0, "the dropped subscriber is no longer sent events");
  await app.close();
});

test("a_stream_is_sent_a_keepalive_every_15_seconds_until_its_client_goes_away", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { app, opened } = runStreamApp(runEventBus());
  const response = app.inject({ method: "GET", url: "/stream" });
  const { request, reply } = await opened;
  const writes = t.mock.method(reply.raw, "write");
  t.mock.timers.tick(14_999);
  assert.equal(writes.mock.callCount(), 0);
  t.mock.timers.tick(1);
  t.mock.timers.tick(15_000);
  request.raw.emit("close");
  const ended = await response;
  t.mock.timers.tick(15_000);
  assert.equal(writes.mock.callCount(), 2, "nothing is written once the client is gone");
  assert.equal(ended.body, ": connected\n\n: keepalive\n\n: keepalive\n\n");
  await app.close();
});

test("messages a run keeps at once each take the next sequence number, in the order they came", async () => {
  const rows: Array<{ run_id: string; seq: number; payload: unknown }> = [];
  const bus = new RunEventBusClass({
    nextSeq: async (runId: string) => {
      const seen = rows.filter((row) => row.run_id === runId).length;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return seen;
    },
    insertMessage: async (message: { runId: string; seq: number; payload: unknown }) => {
      if (rows.some((row) => row.run_id === message.runId && row.seq === message.seq)) {
        throw new Error("duplicate key value violates unique constraint messages_run_id_seq_key");
      }
      const row = { id: rows.length + 1, run_id: message.runId, seq: message.seq, payload: message.payload, metadata: {}, created_at: new Date() };
      rows.push(row);
      return row;
    },
    appendRunError: async () => undefined,
  } as unknown as RunEventsDatabase);
  const kept = await Promise.all([
    bus.commitMessage("r_1", { role: "assistant", content: "one" }, {}),
    bus.commitMessage("r_1", { role: "assistant", content: "two" }, {}),
    bus.commitMessage("r_2", { role: "assistant", content: "other run" }, {}),
    bus.commitMessage("r_1", { role: "assistant", content: "three" }, {}),
  ]);
  assert.deepEqual(kept.map((row) => [row.run_id, row.seq]), [["r_1", 0], ["r_1", 1], ["r_2", 0], ["r_1", 2]]);
  const later = await bus.commitMessage("r_1", { role: "assistant", content: "four" }, {});
  assert.equal(later.seq, 3, "a run whose appends all ended appends again");
});

test("a run's failed append leaves its next one to go on", async () => {
  let fail = true;
  const bus = new RunEventBusClass({
    nextSeq: async () => 0,
    insertMessage: async (message: { runId: string; seq: number }) => {
      if (fail) {
        fail = false;
        throw new Error("database gone");
      }
      return { id: 1, run_id: message.runId, seq: message.seq, payload: {}, metadata: {}, created_at: new Date() };
    },
  } as unknown as RunEventsDatabase);
  const [first, second] = await Promise.allSettled([
    bus.commitMessage("r_1", { role: "assistant", content: "one" }, {}),
    bus.commitMessage("r_1", { role: "assistant", content: "two" }, {}),
  ]);
  assert.equal(first.status, "rejected");
  assert.equal(second.status, "fulfilled");
});
