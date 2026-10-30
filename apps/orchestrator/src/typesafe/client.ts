import { Value } from "@sinclair/typebox/value";
import { GROUP_ROUTING, integrationValue, type IntegrationSources } from "../instance/integrations.js";
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

/** The group routing key from the instance keys; empty while the integration is off. */
export function typeSafeApiKey(sources?: IntegrationSources): string {
  return integrationValue(GROUP_ROUTING, "api_key", sources);
}

export function typeSafeModel(sources?: IntegrationSources): string {
  return integrationValue(GROUP_ROUTING, "model", sources) || TYPESAFE_MODEL;
}

const KEY_NOT_SET = "the group routing key is not set";

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
  if (!raw) {
    return null;
  }
  const seconds = Number(raw);
  let delay: number;
  if (Number.isFinite(seconds)) {
    delay = seconds * 1000;
  } else {
    const at = Date.parse(raw);
    if (!Number.isFinite(at)) {
      return null;
    }
    delay = at - now;
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

export async function evaluateSystemOne(
  request: TypeSafeRequest,
  connection: TypeSafeConnection = {},
): Promise<TypeSafeResult> {
  const apiKey = (connection.apiKey ?? typeSafeApiKey(connection.sources)).trim();
  if (!apiKey) {
    throw new TypeSafeError(KEY_NOT_SET);
  }
  const model = (connection.model ?? typeSafeModel(connection.sources)).trim() || TYPESAFE_MODEL;
  const timeoutMs = connection.timeoutMs ?? TYPESAFE_TIMEOUT_MS;
  const maxRetries = Math.max(0, connection.retry?.maxRetries ?? TYPESAFE_MAX_RETRIES);
  const sleep = connection.retry?.sleep ?? defaultSleep;
  const init: RequestInit = {
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
  const fetchFn = connection.fetch;
  const send = fetchFn
    ? () => fetchWithTimeout(fetchFn, TYPESAFE_URL, init, timeoutMs)
    : () => httpRequest(TYPESAFE_URL, init, { timeoutMs });

  let attempt = 0;
  for (;;) {
    let response: Response;
    try {
      response = await send();
    } catch (error) {
      // Connection failures and timeouts are retryable, like the SDK.
      if (attempt < maxRetries) {
        await sleep(backoffMs(attempt));
        attempt += 1;
        continue;
      }
      throw asTypeSafeError(error, apiKey, attempt + 1);
    }
    try {
      if (!response.ok) {
        const detail = await errorDetail(response);
        if (attempt < maxRetries && retryableStatus(response.status)) {
          await sleep(retryAfterMs(response.headers) ?? backoffMs(attempt));
          attempt += 1;
          continue;
        }
        throw new TypeSafeError(detail, response.status);
      }
      const reply = decode(SystemOneResponse, await readJson(response), unexpected);
      const result: TypeSafeResult = {
        model: typeof reply.model === "string" && reply.model ? reply.model : model,
        answers: parseAnswers(request.questions, reply.answers),
      };
      if (Value.Check(Usage, reply.usage)) {
        result.usage = reply.usage;
      }
      return result;
    } catch (error) {
      throw asTypeSafeError(error, apiKey, attempt + 1);
    }
  }
}

/**
 * A client over the group routing key. The key is read on every call, so a key the admin enters
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
