import { randomBytes } from "node:crypto";
import { Client } from "pg";

const ADMIN_URL =
  process.env.R1_ADMIN_DATABASE_URL ??
  "postgresql://agent_platform:agent_platform@127.0.0.1:5432/postgres";

export function r1DatabaseUrl(name: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

export function uniqueDbName(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

export async function createIsolatedDatabase(name: string): Promise<string> {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${quoteIdent(name)}`);
  } finally {
    await admin.end();
  }
  return r1DatabaseUrl(name);
}

export async function dropIsolatedDatabase(name: string): Promise<void> {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [name],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
  } finally {
    await admin.end();
  }
}

function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`unsafe database name ${name}`);
  }
  return `"${name}"`;
}
