import type { Static } from "typebox";
import { SYSTEM_ONE, integrationValue, type IntegrationSources } from "../instance/integrations.js";
import { httpRequest, readJson, type FetchFn } from "../net/http.js";
import type { TypeSafeUsage } from "../db/schema/index.js";
import { redactApiKey } from "../llm/completion.js";
import { keepMatching } from "../lib/decode.js";
import { isJsonObject, isObjectNode, type JsonObject, type JsonValue } from "../lib/json.js";
import { ChoiceAnswer, ErrorBody, NoulAnswer, ScoreAnswer, SystemOneReply } from "./responses.js";

export const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
export const TYPESAFE_MODEL = "jev-latest";
export const TYPESAFE_TIMEOUT_MS = 8_000;
// Retry policy mirrors the official SDK defaults (2 retries, 500ms doubling to
// 5s with 25% jitter, 408/429/5xx plus connection and timeout errors). The
// Retry-After cap is shorter because the group dispatcher blocks on this call.
export const TYPESAFE_MAX_RETRIES = 2;
export const TYPESAFE_BACKOFF_INITIAL_MS = 500;
export const TYPESAFE_BACKOFF_MAX_MS = 5_000;
export const TYPESAFE_BACKOFF_JITTER = 0.25;
export const TYPESAFE_MAX_RETRY_AFTER_MS = 2_000;

export class TypeSafeError extends Error {
  status: number | null;
  attempts: number;

  constructor(message: string, status: number | null = null, attempts = 1) {
    super(message);
    this.name = "TypeSafeError";
    this.status = status;
    this.attempts = attempts;
  }
}

/** What a question asks: text, or JSON that lays the question out. */
export type TypeSafeInstructions = string | JsonObject | JsonValue[];
/** What one option or verdict of a question means: text, JSON that lays it out, or nothing. */
export type TypeSafeCriteriaValue = string | null | JsonObject | JsonValue[];

export type TypeSafeNoulQuestion = {
  type: "noul";
  instructions: TypeSafeInstructions;
  criteria?: { true?: TypeSafeCriteriaValue; false?: TypeSafeCriteriaValue };
};

export type TypeSafeChoiceQuestion = {
  type: "choice";
  instructions: TypeSafeInstructions;
  criteria: Record<string, TypeSafeCriteriaValue>;
};

export type TypeSafeScoreQuestion = {
  type: "score";
  instructions: TypeSafeInstructions;
  criteria: TypeSafeCriteriaValue[];
};

export type TypeSafeQuestion =
  TypeSafeNoulQuestion | TypeSafeChoiceQuestion | TypeSafeScoreQuestion;

export type TypeSafeNoulAnswer = Static<typeof NoulAnswer>;

export type TypeSafeChoiceAnswer = Static<typeof ChoiceAnswer>;

export type TypeSafeScoreAnswer = Static<typeof ScoreAnswer>;

export type TypeSafeAnswer = TypeSafeNoulAnswer | TypeSafeChoiceAnswer | TypeSafeScoreAnswer;

export type TypeSafeResult = {
  model: string;
  answers: Record<string, TypeSafeAnswer>;
  usage?: TypeSafeUsage;
};

/** One evaluation: the state TypeSafe reads and the questions it answers about it, by id. */
export type TypeSafeRequest = {
  state: JsonValue;
  questions: Record<string, TypeSafeQuestion>;
};

export type TypeSafeEvaluateFn = (request: TypeSafeRequest) => Promise<TypeSafeResult>;

export type TypeSafeClient = {
  configured: boolean;
  evaluate: TypeSafeEvaluateFn;
};

export type TypeSafeRetryOptions = {
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * How System One is reached: the key, model, transport, timeout and retry policy. An unset key or
 * model is read from the instance keys in `sources`; the others fall back to the defaults above.
 */
export type TypeSafeConnection = {
  apiKey?: string | null;
  model?: string;
  fetch?: FetchFn;
  timeoutMs?: number;
  sources?: IntegrationSources;
  retry?: TypeSafeRetryOptions;
};

/** A client's connection, or the `evaluate` that stands in for System One. */
export type TypeSafeClientOptions = TypeSafeConnection & { evaluate?: TypeSafeEvaluateFn };

/** The System One key from the instance keys; empty while the integration is off. */
export function typeSafeApiKey(sources?: IntegrationSources): string {
  return integrationValue(SYSTEM_ONE, "api_key", sources);
}

export function typeSafeModel(sources?: IntegrationSources): string {
  return integrationValue(SYSTEM_ONE, "model", sources) || TYPESAFE_MODEL;
}

const KEY_NOT_SET = "the System One key is not set";

/** `error` as the TypeSafeError a call reports after `attempts` attempts, `apiKey` redacted. */
function asTypeSafeError(error: Error, apiKey: string, attempts: number): TypeSafeError {
  if (error instanceof TypeSafeError) {
    error.message = redactApiKey(error.message, apiKey);
    error.attempts = attempts;
    return error;
  }
  return new TypeSafeError(redactApiKey(error.message, apiKey), null, attempts);
}

/** The answer System One gave question `id`, as the JSON object it is read from. */
function answerFields(answers: JsonObject, id: string): JsonObject {
  const value = answers[id];
  if (value === undefined || !isObjectNode(value)) {
    throw new TypeSafeError(`missing TypeSafe answer ${id}`);
  }
  return value;
}

function invalidAnswer(type: TypeSafeQuestion["type"], id: string): TypeSafeError {
  return new TypeSafeError(`invalid TypeSafe ${type} answer ${id}`);
}

function noulAnswer(answers: JsonObject, id: string): TypeSafeNoulAnswer {
  const answer = keepMatching(NoulAnswer, answerFields(answers, id));
  if (answer === null) {
    throw invalidAnswer("noul", id);
  }
  return answer;
}

function choiceAnswer(
  answers: JsonObject,
  id: string,
  options: ReadonlySet<string>,
): TypeSafeChoiceAnswer {
  const answer = keepMatching(ChoiceAnswer, answerFields(answers, id));
  if (answer === null) {
    throw invalidAnswer("choice", id);
  }
  if (!options.has(answer.choice)) {
    throw new TypeSafeError(`TypeSafe choice answer ${id} picked unknown option ${answer.choice}`);
  }
  return answer;
}

function scoreAnswer(answers: JsonObject, id: string): TypeSafeScoreAnswer {
  const answer = keepMatching(ScoreAnswer, answerFields(answers, id));
  if (answer === null) {
    throw invalidAnswer("score", id);
  }
  return answer;
}

/** The answer `result` holds for question `id`. */
function resultAnswer(result: TypeSafeResult, id: string): TypeSafeAnswer {
  const answer = result.answers[id];
  if (answer === undefined) {
    throw new TypeSafeError(`missing TypeSafe answer ${id}`);
  }
  return answer;
}

export function requireNoul(result: TypeSafeResult, id: string): number {
  const answer = resultAnswer(result, id);
  if (answer.type !== "noul") {
    throw invalidAnswer("noul", id);
  }
  return answer.noul;
}

export function requireChoice(result: TypeSafeResult, id: string): TypeSafeChoiceAnswer {
  const answer = resultAnswer(result, id);
  if (answer.type !== "choice") {
    throw invalidAnswer("choice", id);
  }
  return answer;
}

export function requireScore(result: TypeSafeResult, id: string): TypeSafeScoreAnswer {
  const answer = resultAnswer(result, id);
  if (answer.type !== "score") {
    throw invalidAnswer("score", id);
  }
  return answer;
}

/** The answers System One gave `questions`, each read by the type of its question. */
function parseAnswers(
  questions: TypeSafeRequest["questions"],
  answers: JsonObject,
): TypeSafeResult["answers"] {
  const parsed: TypeSafeResult["answers"] = {};
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === "noul") {
      parsed[id] = noulAnswer(answers, id);
    } else if (question.type === "choice") {
      parsed[id] = choiceAnswer(answers, id, new Set(Object.keys(question.criteria)));
    } else {
      parsed[id] = scoreAnswer(answers, id);
    }
  }
  return parsed;
}

async function errorDetail(response: Response): Promise<string> {
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    const stripped = text.trim();
    return stripped || `TypeSafe HTTP ${response.status}`;
  }
  const body = isJsonObject(payload) ? keepMatching(ErrorBody, payload) : null;
  return body?.message?.trim() || body?.error?.trim() || `TypeSafe HTTP ${response.status}`;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/** A `retry-after` value in ms from `now`: seconds or an HTTP date; null when it is neither. */
function retryAfterValueMs(raw: string, now: number): number | null {
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return seconds * 1000;
  }
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at - now : null;
}

// Server hint in ms, or null when absent, unparseable, or above the cap (the
// SDK falls back to its own backoff in that case too).
export function retryAfterMs(
  headers: Headers,
  now: number = Date.now(),
  maxMs: number = TYPESAFE_MAX_RETRY_AFTER_MS,
): number | null {
  const millis = Number(headers.get("retry-after-ms"));
  if (Number.isFinite(millis) && millis > 0) {
    return millis <= maxMs ? millis : null;
  }
  const raw = (headers.get("retry-after") ?? "").trim();
  const delay = raw ? retryAfterValueMs(raw, now) : null;
  if (delay === null) {
    return null;
  }
  if (delay <= 0) {
    return 0;
  }
  return delay <= maxMs ? delay : null;
}

export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(TYPESAFE_BACKOFF_MAX_MS, TYPESAFE_BACKOFF_INITIAL_MS * 2 ** attempt);
  const jitter = 1 + (random() * 2 - 1) * TYPESAFE_BACKOFF_JITTER;
  return Math.round(base * jitter);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The retry policy `options` sets, each unset field at its default. */
function retryPolicy(options: TypeSafeRetryOptions = {}): Required<TypeSafeRetryOptions> {
  return {
    maxRetries: Math.max(0, options.maxRetries ?? TYPESAFE_MAX_RETRIES),
    sleep: options.sleep ?? defaultSleep,
  };
}

async function fetchWithTimeout(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function unexpected(problem: string): TypeSafeError {
  return new TypeSafeError(`TypeSafe returned an unexpected response at ${problem}`);
}

/** The POST that asks System One `request` under `model`, signed with `apiKey`. */
function systemOneInit(request: TypeSafeRequest, apiKey: string, model: string): RequestInit {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      state: request.state,
      questions: request.questions,
    }),
  };
}

/** Sends `init` to System One over the connection's fetch, or the platform's HTTP client. */
function systemOneSender(
  connection: TypeSafeConnection,
  init: RequestInit,
): () => Promise<Response> {
  const timeoutMs = connection.timeoutMs ?? TYPESAFE_TIMEOUT_MS;
  const fetchFn = connection.fetch;
  return fetchFn
    ? () => fetchWithTimeout(fetchFn, TYPESAFE_URL, init, timeoutMs)
    : () => httpRequest(TYPESAFE_URL, init, { timeoutMs });
}

/**
 * The reply System One sent with `response`, as the result of `call`'s questions; its model is
 * the call's when the reply names none.
 */
async function systemOneResult(response: Response, call: SystemOneCall): Promise<TypeSafeResult> {
  const reply = await readJson(response);
  if (!isJsonObject(reply)) {
    throw unexpected("/: Expected object");
  }
  const answers = reply.answers;
  if (answers === undefined || !isObjectNode(answers)) {
    throw unexpected("/answers: Expected object");
  }
  const envelope = keepMatching(SystemOneReply, reply);
  const result: TypeSafeResult = {
    model: envelope?.model || call.model,
    answers: parseAnswers(call.questions, answers),
  };
  if (envelope?.usage) {
    result.usage = envelope.usage;
  }
  return result;
}

/** One System One call: how it is sent, and the questions and model its reply is read against. */
type SystemOneCall = {
  send: () => Promise<Response>;
  questions: TypeSafeRequest["questions"];
  model: string;
};

/** What one attempt came to: System One's result, or the wait before the next attempt. */
type SystemOneAttempt = { result: TypeSafeResult } | { waitMs: number };

/**
 * Attempt number `attempt` of `call`. While it is below `maxRetries`, a connection failure or
 * timeout, or a 408, 429 or 5xx reply, comes back as the wait before the next attempt, like the
 * SDK; any other failure is thrown, for `evaluateSystemOne` to report as a TypeSafeError.
 */
async function attemptSystemOne(
  call: SystemOneCall,
  attempt: number,
  maxRetries: number,
): Promise<SystemOneAttempt> {
  const retryable = attempt < maxRetries;
  let response: Response;
  try {
    response = await call.send();
  } catch (error) {
    if (retryable) {
      return { waitMs: backoffMs(attempt) };
    }
    throw error;
  }
  if (!response.ok) {
    const detail = await errorDetail(response);
    if (retryable && retryableStatus(response.status)) {
      return { waitMs: retryAfterMs(response.headers) ?? backoffMs(attempt) };
    }
    throw new TypeSafeError(detail, response.status);
  }
  return { result: await systemOneResult(response, call) };
}

export async function evaluateSystemOne(
  request: TypeSafeRequest,
  connection: TypeSafeConnection = {},
): Promise<TypeSafeResult> {
  const apiKey = (connection.apiKey ?? typeSafeApiKey(connection.sources)).trim();
  if (!apiKey) {
    throw new TypeSafeError(KEY_NOT_SET);
  }
  const model = (connection.model ?? typeSafeModel(connection.sources)).trim() || TYPESAFE_MODEL;
  const call: SystemOneCall = {
    send: systemOneSender(connection, systemOneInit(request, apiKey, model)),
    questions: request.questions,
    model,
  };
  const { maxRetries, sleep } = retryPolicy(connection.retry);
  for (let attempt = 0; ; attempt += 1) {
    let outcome: SystemOneAttempt;
    try {
      outcome = await attemptSystemOne(call, attempt, maxRetries);
    } catch (error) {
      const thrown = error instanceof Error ? error : new Error(String(error));
      throw asTypeSafeError(thrown, apiKey, attempt + 1);
    }
    if ("result" in outcome) {
      return outcome.result;
    }
    await sleep(outcome.waitMs);
  }
}

/**
 * A client over the System One key. The key is read on every call, so a key the admin enters
 * or removes under Platform keys takes effect without a restart; `configured` follows it.
 */
export function createTypeSafeClient(options: TypeSafeClientOptions = {}): TypeSafeClient {
  const { evaluate, ...connection } = options;
  if (evaluate) {
    return { configured: true, evaluate };
  }
  const key = (): string => (connection.apiKey ?? typeSafeApiKey(connection.sources)).trim();
  return {
    get configured() {
      return Boolean(key());
    },
    evaluate: (request) => {
      const apiKey = key();
      if (!apiKey) {
        return Promise.reject(new TypeSafeError(KEY_NOT_SET));
      }
      return evaluateSystemOne(request, { ...connection, apiKey });
    },
  };
}
