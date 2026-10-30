import type pg from "pg";
import { type Queryable, withTransaction } from "../db/pg.js";
import { lockStudioSession, type StudioSessionRow } from "../db/studio.js";
import { StudioNotFoundError } from "./errors.js";

/** Runs `fn` in a transaction that holds the session's lock, with the session as it was locked. */
export function withLockedSession<T>(
  db: Queryable,
  sessionId: string,
  fn: (client: pg.PoolClient, session: StudioSessionRow) => Promise<T>,
): Promise<T> {
  return withTransaction(db, async (client) => {
    const session = await lockStudioSession(client, sessionId);
    if (!session) {
      throw new StudioNotFoundError("studio session not found");
    }
    return fn(client, session);
  });
}
