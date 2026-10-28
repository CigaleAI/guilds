import { GROUP_ROUTING, integrationValue, type IntegrationSources } from "../instance/integrations.js";
import { httpRequest, readJson, type FetchFn } from "../net/http.js";
import type { TypeSafeUsage } from "../db/schema/index.js";
import { redactApiKey } from "../llm/client.js";

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

export type TypeSafeEvaluateFn = (args: {
  state: unknown;
  questions: Record<string, TypeSafeQuestion>;
}) => Promise<TypeSafeResult>;

export type TypeSafeClient = {
  configured: boolean;
  evaluate: TypeSafeEvaluateFn;
};

export type TypeSafeRetryOptions = {
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
};

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

function answerRow(value: unknown, id: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeSafeError(`missing TypeSafe answer ${id}`);
  }
  return value as Record<string, unknown>;
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function numberMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "number" && Number.isFinite(item)) {
      out[key] = item;
    }
  }
  return out;
}

function noulAnswer(value: unknown, id: string): TypeSafeNoulAnswer {
  const row = answerRow(value, id);
  if (row.type !== "noul" || !isUnitInterval(row.noul)) {
    throw new TypeSafeError(`invalid TypeSafe noul answer ${id}`);
  }
  return { type: "noul", noul: row.noul };
}

export function requireNoul(result: TypeSafeResult, id: string): number {
  return noulAnswer(result.answers[id], id).noul;
}

function choiceAnswer(
  value: unknown,
  id: string,
  options?: ReadonlySet<string>,
): TypeSafeChoiceAnswer {
  const row = answerRow(value, id);
  if (row.type !== "choice" || typeof row.choice !== "string" || !row.choice) {
    throw new TypeSafeError(`invalid TypeSafe choice answer ${id}`);
  }
  if (options && !options.has(row.choice)) {
    throw new TypeSafeError(`TypeSafe choice answer ${id} picked unknown option ${row.choice}`);
  }
  return {
    type: "choice",
    choice: row.choice,
    probabilities: numberMap(row.probabilities),
    confidence: isUnitInterval(row.confidence) ? row.confidence : 0,
  };
}

export function requireChoice(result: TypeSafeResult, id: string): TypeSafeChoiceAnswer {
  return choiceAnswer(result.answers[id], id);
}

function scoreAnswer(value: unknown, id: string): TypeSafeScoreAnswer {
  const row = answerRow(value, id);
  if (row.type !== "score" || typeof row.score !== "number" || !Number.isFinite(row.score)) {
    throw new TypeSafeError(`invalid TypeSafe score answer ${id}`);
  }
  const legend: Record<string, string> = {};
  if (row.legend && typeof row.legend === "object" && !Array.isArray(row.legend)) {
    for (const [key, item] of Object.entries(row.legend as Record<string, unknown>)) {
      if (typeof item === "string") {
        legend[key] = item;
      }
    }
  }
  return {
    type: "score",
    score: row.score,
    legend,
    probabilities: numberMap(row.probabilities),
    confidence: isUnitInterval(row.confidence) ? row.confidence : 0,
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
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const row = payload as { message?: unknown; error?: unknown };
    const message = typeof row.message === "string" ? row.message.trim() : "";
    if (message) {
      return message;
    }
    const error = typeof row.error === "string" ? row.error.trim() : "";
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

export async function evaluateSystemOne(args: {
  state: unknown;
  questions: Record<string, TypeSafeQuestion>;
  model?: string;
  apiKey?: string;
  fetch?: FetchFn;
  timeoutMs?: number;
  sources?: IntegrationSources;
  retry?: TypeSafeRetryOptions;
}): Promise<TypeSafeResult> {
  const apiKey = (args.apiKey ?? typeSafeApiKey(args.sources)).trim();
  if (!apiKey) {
    throw new TypeSafeError(KEY_NOT_SET);
  }
  const model = (args.model ?? typeSafeModel(args.sources)).trim() || TYPESAFE_MODEL;
  const timeoutMs = args.timeoutMs ?? TYPESAFE_TIMEOUT_MS;
  const maxRetries = Math.max(0, args.retry?.maxRetries ?? TYPESAFE_MAX_RETRIES);
  const sleep = args.retry?.sleep ?? defaultSleep;
  const init: RequestInit = {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      state: args.state,
      questions: args.questions,
    }),
  };
  const send = args.fetch
    ? () => fetchWithTimeout(args.fetch as FetchFn, TYPESAFE_URL, init, timeoutMs)
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
      const payload = await readJson(response);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new TypeSafeError("TypeSafe response must be an object");
      }
      const row = payload as Record<string, unknown>;
      const answers = row.answers;
      if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
        throw new TypeSafeError("TypeSafe response is missing answers");
      }
      const result: TypeSafeResult = {
        model: typeof row.model === "string" && row.model ? row.model : model,
        answers: parseAnswers(args.questions, answers as Record<string, unknown>),
      };
      if (row.usage && typeof row.usage === "object" && !Array.isArray(row.usage)) {
        result.usage = row.usage as TypeSafeUsage;
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
export function createTypeSafeClient(
  options: {
    apiKey?: string | null;
    evaluate?: TypeSafeEvaluateFn;
    fetch?: FetchFn;
    sources?: IntegrationSources;
    timeoutMs?: number;
    model?: string;
    retry?: TypeSafeRetryOptions;
  } = {},
): TypeSafeClient {
  if (options.evaluate) {
    return { configured: true, evaluate: options.evaluate };
  }
  const key = () => (options.apiKey ?? typeSafeApiKey(options.sources)).trim();
  return {
    get configured() {
      return Boolean(key());
    },
    evaluate: (args) => {
      const apiKey = key();
      if (!apiKey) {
        return Promise.reject(new TypeSafeError(KEY_NOT_SET));
      }
      const request: Parameters<typeof evaluateSystemOne>[0] = {
        ...args,
        apiKey,
        ...(options.sources ? { sources: options.sources } : {}),
      };
      if (options.fetch) {
        request.fetch = options.fetch;
      }
      if (options.timeoutMs !== undefined) {
        request.timeoutMs = options.timeoutMs;
      }
      if (options.model !== undefined) {
        request.model = options.model;
      }
      if (options.retry !== undefined) {
        request.retry = options.retry;
      }
      return evaluateSystemOne(request);
    },
  };
}
