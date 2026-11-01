import type { FastifyReply, FastifyRequest } from "fastify";
import type { EventPayloads, EventQueue, StreamEvent } from "../lib/event.js";
import { isObjectNode, type JsonObject, type JsonValue } from "../lib/json.js";

const FLOAT_KEYS = new Set(["cost_usd"]);

/** A number JSON writes without a fraction or an exponent. */
const WHOLE_NUMBER = /^-?\d+$/;

/**
 * The value as the stream's JSON: `, ` and `: ` between items, every non-ASCII character escaped,
 * an object's left-out fields skipped, and a number under a key listed in FLOAT_KEYS written as a
 * float even when it is whole.
 */
export function dumpsSse(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(dumpsSse).join(", ")}]`;
  }
  if (isObjectNode(value)) {
    const parts: string[] = [];
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) {
        continue;
      }
      parts.push(`${encodeScalar(key)}: ${encodeEntryValue(key, item)}`);
    }
    return `{${parts.join(", ")}}`;
  }
  return encodeScalar(value);
}

function encodeEntryValue(key: string, item: JsonValue): string {
  const text = dumpsSse(item);
  return FLOAT_KEYS.has(key) && WHOLE_NUMBER.test(text) ? `${text}.0` : text;
}

/** A string, number, boolean or null as JSON text; a number JSON cannot carry is refused. */
function encodeScalar(value: string | number | boolean | null): string {
  const json = JSON.stringify(value);
  if (json === "null" && value !== null) {
    throw new TypeError("sse json cannot encode non-finite numbers");
  }
  return json.replace(/[\u007f-\uffff]/g, (char) => {
    const code = char.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${code}`;
  });
}

export function frameSse(event: string, data: JsonObject): string {
  return `event: ${event}\ndata: ${dumpsSse(data)}\n\n`;
}

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

/** Streams a subscription's events to the request as SSE until the client goes away. */
export async function pipeSse<Event extends StreamEvent<EventPayloads>>(
  request: FastifyRequest,
  reply: FastifyReply,
  subscribe: () => EventQueue<Event>,
  unsubscribe: (queue: EventQueue<Event>) => void,
): Promise<void> {
  const queue = subscribe();
  reply.hijack();
  reply.raw.writeHead(200, SSE_HEADERS);
  reply.raw.write(": connected\n\n");
  const abort = new AbortController();
  const onClose = () => {
    abort.abort();
  };
  request.raw.on("close", onClose);
  try {
    while (!abort.signal.aborted) {
      const [event, data] = await queue.get(abort.signal);
      reply.raw.write(frameSse(event, data));
    }
  } catch (error) {
    // The queue refuses a read once the client has gone away, which ends the stream.
    if (!abort.signal.aborted) {
      throw error;
    }
  } finally {
    request.raw.off("close", onClose);
    unsubscribe(queue);
  }
}
