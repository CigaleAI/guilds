import { Value } from "@sinclair/typebox/value";
import { SYSTEM_ONE, integrationValue, type IntegrationSources } from "../instance/integrations.js";
import { httpRequest, readJson, type FetchFn } from "../net/http.js";
import type { TypeSafeUsage } from "../db/schema/index.js";
import { redactApiKey } from "../llm/completion.js";
import { decode } from "../lib/decode.js";
import {
  ChoiceAnswerBody,
  ErrorBody,
  Fields,
  NoulAnswerBody,
  ScoreAnswerBody,
  SystemOneResponse,
  Usage,
} from "./responses.js";

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

export type TypeSafeInstructions = string | Record<string, unknown> | unknown[];
export type TypeSafeCriteriaValue = string | null | Record<string, unknown> | unknown[];

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

export type TypeSafeNoulAnswer = {
  type: "noul";
  noul: number;
};

export type TypeSafeChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};

export type TypeSafeScoreAnswer = {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
};

export type TypeSafeAnswer = TypeSafeNoulAnswer | TypeSafeChoiceAnswer | TypeSafeScoreAnswer;

export type TypeSafeResult = {
  model: string;
  answers: Record<string, TypeSafeAnswer>;
  usage?: TypeSafeUsage;
};

/** One evaluation: the state TypeSafe reads and the questions it answers about it, by id. */
export type TypeSafeRequest = {
  state: unknown;
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

function asTypeSafeError(error: unknown, apiKey: string | null, attempts: number): TypeSafeError {
  if (error instanceof TypeSafeError) {
    error.message = redactApiKey(error.message, apiKey);
    error.attempts = attempts;
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new TypeSafeError(redactApiKey(message, apiKey), null, attempts);
}

function requireAnswerObject(value: unknown, id: string): void {
  if (!Value.Check(Fields, value)) {
    throw new TypeSafeError(`missing TypeSafe answer ${id}`);
  }
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string";
}

/** The fields of `value` that pass `keep`, each other one dropped; empty when it is no object. */
function keptFields<T>(value: unknown, keep: (item: unknown) => item is T): Record<string, T> {
  const out: Record<string, T> = {};
  if (!Value.Check(Fields, value)) {
    return out;
  }
  for (const [key, item] of Object.entries(value)) {
    if (keep(item)) {
      out[key] = item;
    }
  }
  return out;
}

function noulAnswer(value: unknown, id: string): TypeSafeNoulAnswer {
  requireAnswerObject(value, id);
  if (!Value.Check(NoulAnswerBody, value)) {
    throw new TypeSafeError(`invalid TypeSafe noul answer ${id}`);
  }
  return { type: "noul", noul: value.noul };
}

export function requireNoul(result: TypeSafeResult, id: string): number {
  return noulAnswer(result.answers[id], id).noul;
}

function choiceAnswer(
  value: unknown,
  id: string,
  options?: ReadonlySet<string>,
): TypeSafeChoiceAnswer {
  requireAnswerObject(value, id);
  if (!Value.Check(ChoiceAnswerBody, value)) {
    throw new TypeSafeError(`invalid TypeSafe choice answer ${id}`);
  }
  if (options && !options.has(value.choice)) {
    throw new TypeSafeError(`TypeSafe choice answer ${id} picked unknown option ${value.choice}`);
  }
  return {
    type: "choice",
    choice: value.choice,
    probabilities: keptFields(value.probabilities, isFiniteNumber),
    confidence: isUnitInterval(value.confidence) ? value.confidence : 0,
  };
}

export function requireChoice(result: TypeSafeResult, id: string): TypeSafeChoiceAnswer {
  return choiceAnswer(result.answers[id], id);
}

function scoreAnswer(value: unknown, id: string): TypeSafeScoreAnswer {
  requireAnswerObject(value, id);
  if (!Value.Check(ScoreAnswerBody, value)) {
    throw new TypeSafeError(`invalid TypeSafe score answer ${id}`);
  }
  return {
    type: "score",
    score: value.score,
    legend: keptFields(value.legend, isText),
    probabilities: keptFields(value.probabilities, isFiniteNumber),
    confidence: isUnitInterval(value.confidence) ? value.confidence : 0,
  };
}

export function requireScore(result: TypeSafeResult, id: string): TypeSafeScoreAnswer {
  return scoreAnswer(result.answers[id], id);
}

function choiceOptions(question: TypeSafeChoiceQuestion): ReadonlySet<string> | undefined {
  const criteria: unknown = question.criteria;
  if (!criteria || typeof criteria !== "object" || Array.isArray(criteria)) {
    return undefined;
  }
  return new Set(Object.keys(criteria));
}

function parseAnswers(
  questions: Record<string, TypeSafeQuestion>,
  answers: Record<string, unknown>,
): Record<string, TypeSafeAnswer> {
  const parsed: Record<string, TypeSafeAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === "noul") {
      parsed[id] = noulAnswer(answers[id], id);
    } else if (question.type === "choice") {
      parsed[id] = choiceAnswer(answers[id], id, choiceOptions(question));
    } else {
      parsed[id] = scoreAnswer(answers[id], id);
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
  if (Value.Check(ErrorBody, payload)) {
    const message = typeof payload.message === "string" ? payload.message.trim() : "";
    if (message) {
      return message;
    }
    const error = typeof payload.error === "string" ? payload.error.trim() : "";
    if (error) {
      return error;
    }
  }
  return `TypeSafe HTTP ${response.status}`;
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

/** A System One reply as the result of `questions`; its model is `model` when it names none. */
function systemOneResult(
  payload: unknown,
  questions: Record<string, TypeSafeQuestion>,
  model: string,
): TypeSafeResult {
  const reply = decode(SystemOneResponse, payload, unexpected);
  const result: TypeSafeResult = {
    model: typeof reply.model === "string" && reply.model ? reply.model : model,
    answers: parseAnswers(questions, reply.answers),
  };
  if (Value.Check(Usage, reply.usage)) {
    result.usage = reply.usage;
  }
  return result;
}

/** One System One call: how it is sent, and the questions and model its reply is read against. */
type SystemOneCall = {
  send: () => Promise<Response>;
  questions: Record<string, TypeSafeQuestion>;
  model: string;
};

/** What one attempt came to: System One's result, or the wait before the next attempt. */
type SystemOneAttempt = { result: TypeSafeResult } | { waitMs: number };

/**
 * Attempt number `attempt` of `call`. While it is below `maxRetries`, a connection failure or
 * timeout, or a 408, 429 or 5xx reply, comes back as the wait before the next attempt, like the
 * SDK; any other failure is thrown as a TypeSafeError.
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
    throw asTypeSafeError(error, null, attempt + 1);
  }
  if (!response.ok) {
    const detail = await errorDetail(response);
    if (retryable && retryableStatus(response.status)) {
      return { waitMs: retryAfterMs(response.headers) ?? backoffMs(attempt) };
    }
    throw new TypeSafeError(detail, response.status);
  }
  return { result: systemOneResult(await readJson(response), call.questions, call.model) };
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
      throw asTypeSafeError(error, apiKey, attempt + 1);
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
