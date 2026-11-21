// Runs on a worker thread with no execArgv, so Node strips its types itself: erasable syntax only.
import { parentPort, workerData } from "node:worker_threads";
import type { TiktokenEncoding } from "js-tiktoken";
import type { MessagePayload } from "../db/schema/index.js";
import type { FunctionTool } from "../lib/tool-schema.js";

/** The input the worker is asked to count, with the id its reply carries. */
export type TokenCountJob = {
  id: number;
  messages: readonly MessagePayload[];
  tools: readonly FunctionTool[] | null | undefined;
};

/** The token length of the job's input text. */
export type TokenCountReply = { id: number; tokens: number };

/** The text input tokens are counted on: the JSON text of the messages, then of the tools when any are offered. */
export function inputText(messages: readonly MessagePayload[], tools: readonly FunctionTool[] | null | undefined): string {
  let text = JSON.stringify(messages);
  if (tools && tools.length) {
    text += JSON.stringify(tools);
  }
  return text;
}

const port = parentPort;
if (port) {
  const { getEncoding } = await import("js-tiktoken");
  const encodingName: TiktokenEncoding = workerData;
  const encoding = getEncoding(encodingName);
  port.on("message", (job: TokenCountJob) => {
    const reply: TokenCountReply = { id: job.id, tokens: encoding.encode(inputText(job.messages, job.tools)).length };
    port.postMessage(reply);
  });
}
