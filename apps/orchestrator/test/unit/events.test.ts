import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { RunEvent, RunEventBus } from "../../src/generation/events.js";
import { pipeSse } from "../../src/http/sse.js";
import { EventQueue } from "../../src/lib/event.js";
import { tempDir } from "../helpers/env.js";
import { deferred, FakeSandboxes, makeLoop } from "../helpers/generation.js";

/** A run's event bus with nothing behind it. */
function runEventBus(): RunEventBus {
  return makeLoop({}, {}, tempDir("guilds-events-"), new FakeSandboxes()).events;
}

/** A stream as it opens: its subscription, and the request it answers with its reply. */
type OpenedStream = { queue: EventQueue<RunEvent>; request: FastifyRequest; reply: FastifyReply };

/** An app whose `/stream` pipes run `r_1`'s events from `bus`, and the stream once it opens. */
function runStreamApp(bus: RunEventBus) {
  const app = Fastify();
  const opened = deferred<OpenedStream>();
  app.get("/stream", async (request, reply) => {
    await pipeSse(
      request,
      reply,
      () => {
        const queue = bus.subscribe("r_1");
        opened.resolve({ queue, request, reply });
        return queue;
      },
      (queue) => bus.unsubscribe("r_1", queue),
    );
  });
  return { app, opened: opened.promise };
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
  const response = app.inject({ method: "GET", url: "/stream" });
  const { queue } = await opened;
  // Published without waiting, the events pile up faster than the stream sends them.
  const publishes: Array<Promise<void>> = [];
  for (let index = 0; index < 8192; index += 1) {
    publishes.push(bus.publish("r_1", "assistant.delta", { text: "x" }));
  }
  await Promise.all(publishes);
  assert.equal(queue.dropped, true);
  const ended = await response;
  assert.equal(ended.statusCode, 200);
  assert.ok(ended.body.startsWith(": connected\n\n"), ended.body.slice(0, 40));
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
