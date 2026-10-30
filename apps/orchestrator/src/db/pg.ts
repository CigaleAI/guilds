import type pg from "pg";

/**
 * The connection a query runs on: the pool, or the client of a transaction already open. A
 * function whose writes commit together opens its transaction on it with `withTransaction`.
 */
export type Queryable = pg.Pool | pg.PoolClient;

/**
 * `query` with its connection bound. A domain whose unit tests fake the database takes a
 * dependencies object of these, built from the db/ functions it calls.
 */
export function bindQuery<C, A extends unknown[], R>(
  db: C,
  query: (db: C, ...args: A) => R,
): (...args: A) => R {
  return (...args) => query(db, ...args);
}

/** The type `bindQuery` gives `F`: the query with its connection, or its store, bound. */
export type BoundQuery<F> = F extends (db: never, ...args: infer A) => infer R ? (...args: A) => R : never;

/** Runs `work` in one transaction, on the dependencies object of its client. */
export type Transaction<D> = <T>(work: (tx: D) => Promise<T>) => Promise<T>;

/**
 * A transaction on `db` that hands `work` the dependencies object `database` builds on its
 * client. A domain whose unit tests fake the database keeps one beside its bound queries, so a
 * write and the change it records commit together.
 */
export function bindTransaction<D>(db: Queryable, database: (db: Queryable) => D): Transaction<D> {
  return (work) => withTransaction(db, (client) => work(database(client)));
}

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

/**
 * Runs `fn` in a transaction on `db`: a new one on a client of the pool, or, on the client of a
 * transaction already open, a savepoint inside it, so the caller's transaction commits or rolls
 * back the whole.
 */
export async function withTransaction<T>(
  db: Queryable,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  if ("release" in db) {
    return withSavepoint(db, fn);
  }
  const client = await db.connect();
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

async function withSavepoint<T>(
  client: pg.PoolClient,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  await client.query("SAVEPOINT nested");
  try {
    const result = await fn(client);
    await client.query("RELEASE SAVEPOINT nested");
    return result;
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT nested");
    await client.query("RELEASE SAVEPOINT nested");
    throw error;
  }
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
