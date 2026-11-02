// What a connector's client makes of its API's responses: the body of a success decoded once
// with the schema of what the client reads, and the message of a failure.
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { assertMatches } from "../lib/decode.js";

/**
 * The API a connector's client calls, as its responses are read: the name its messages give it,
 * the error the client throws, and the schema of its error bodies with the message one holds.
 */
export type ConnectorApi<E extends TSchema> = {
  name: string;
  /** The error the client throws with `message`, and with the response's status when the response failed. */
  error: (message: string, status?: number) => Error;
  /** The body of a failed response, as far as the client reads it. */
  errorBody: E;
  /** The message an error body holds; null when it holds none. */
  errorMessage: (body: Static<E>) => string | null;
};

/**
 * `text`, the body of one of the API's responses, as `schema` describes it. Text that is not JSON
 * throws the API's error "<name> returned a non-JSON body"; JSON that does not match throws
 * "<name> returned an unexpected response at <pointer>: <problem>".
 */
export function decodeBody<T extends TSchema, E extends TSchema>(api: ConnectorApi<E>, schema: T, text: string): Static<T> {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw api.error(`${api.name} returned a non-JSON body`);
  }
  assertMatches(schema, payload, (problem) => api.error(`${api.name} returned an unexpected response at ${problem}`));
  return payload;
}

/**
 * What a failed response of the API says, its body `text`: the message its error body holds, the
 * text itself when it is not JSON, and "<name> HTTP <status>" when neither says anything.
 */
export function failureMessage<E extends TSchema>(api: ConnectorApi<E>, status: number, text: string): string {
  const fallback = `${api.name} HTTP ${status}`;
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    return text.trim() || fallback;
  }
  return (Value.Check(api.errorBody, payload) ? api.errorMessage(payload) : null) ?? fallback;
}

/**
 * The body of `response` as `schema` describes it. A status of 400 or above throws the API's
 * error with that status and `failureMessage`; the body of any other is read by `decodeBody`.
 */
export async function decodeResponse<T extends TSchema, E extends TSchema>(
  api: ConnectorApi<E>,
  response: Response,
  schema: T,
): Promise<Static<T>> {
  const text = await response.text();
  if (response.status >= 400) {
    throw api.error(failureMessage(api, response.status, text), response.status);
  }
  return decodeBody(api, schema, text);
}
