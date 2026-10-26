import type pg from "pg";

/** A pool or a transaction's client: what a read or a single-statement write runs on. */
export type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function firstRow(result: pg.QueryResult): Record<string, unknown> | null {
  const row = result.rows[0];
  return row ? (row as Record<string, unknown>) : null;
}

export function stamp(now: Date): string {
  return now.toISOString();
}

/** The next instant after `previous` when `now` is not later, so two writes in the same millisecond stay ordered. */
export function stampAfter(previous: Date | null, now: Date): Date {
  if (!previous || now.getTime() > previous.getTime()) {
    return now;
  }
  return new Date(previous.getTime() + 1);
}
