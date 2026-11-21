// Runs on a worker thread with no execArgv, so Node strips its types itself: erasable syntax only.
import { parentPort, workerData } from "node:worker_threads";
import { getEncoding, type TiktokenEncoding } from "js-tiktoken";

/** A text the worker is asked to count, with the id its reply carries. */
export type TokenCountJob = { id: number; text: string };

/** The token length of the job's text. */
export type TokenCountReply = { id: number; tokens: number };

const encodingName: TiktokenEncoding = workerData;
const encoding = getEncoding(encodingName);

parentPort?.on("message", (job: TokenCountJob) => {
  const reply: TokenCountReply = { id: job.id, tokens: encoding.encode(job.text).length };
  parentPort?.postMessage(reply);
});
