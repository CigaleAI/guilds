import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { pipeSse } from "../../src/http/sse.js";
import type { EventPayloads, EventQueue, StreamEvent } from "../../src/lib/event.js";
import { deferred } from "./generation.js";

/** A stream as it opens: its subscription, and the request it answers with its reply. */
export type OpenedStream<Event> = {
  queue: EventQueue<Event>;
  request: FastifyRequest;
  reply: FastifyReply;
};

/** An app whose `/stream` pipes the subscription `subscribe` opens, and the stream once it opens. */
export function sseApp<Event extends StreamEvent<EventPayloads>>(
  subscribe: () => EventQueue<Event>,
  unsubscribe: (queue: EventQueue<Event>) => void,
): { app: FastifyInstance; opened: Promise<OpenedStream<Event>> } {
  const app = Fastify();
  const opened = deferred<OpenedStream<Event>>();
  app.get("/stream", async (request, reply) => {
    await pipeSse(
      request,
      reply,
      () => {
        const queue = subscribe();
        opened.resolve({ queue, request, reply });
        return queue;
      },
      unsubscribe,
    );
  });
  return { app, opened: opened.promise };
}

/**
 * Opens `/stream` on `app`, runs `overflow` without waiting on the stream so the events pile up
 * faster than it sends them, and returns the response once the stream ends, with the subscription.
 */
export async function overflowStream<Event>(
  app: FastifyInstance,
  opened: Promise<OpenedStream<Event>>,
  overflow: () => Array<Promise<void>>,
): Promise<{ body: string; queue: EventQueue<Event> }> {
  const response = app.inject({ method: "GET", url: "/stream" });
  const { queue } = await opened;
  await Promise.all(overflow());
  const ended = await response;
  return { body: ended.body, queue };
}
