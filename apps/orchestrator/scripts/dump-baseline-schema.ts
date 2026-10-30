import { writeFileSync } from "node:fs";
import path from "node:path";
import { applyMigrations, createPool } from "../src/db/client.js";
import { startErrorReporting } from "../src/error-reporting.js";
import { reportPoolError } from "../src/observability/runtime.js";
import { orchestratorRoot } from "../src/lib/paths.js";
import {
  createIsolatedDatabase,
  dropIsolatedDatabase,
  uniqueDbName,
} from "../test/helpers/postgres.js";
import { dumpSchema } from "../test/helpers/schema-dump.js";

const DROP_NAMES = ["__drizzle_migrations", "drizzle"];

function keepObject(block: string): boolean {
  const trimmed = block.trim();
  if (!trimmed) return false;
  if (/^(?:--\s*\n)*--\s*$/.test(trimmed)) return false;
  const match = /^(?:--\n)?-- Name: ([^\n]+)/.exec(block);
  if (!match) return true;
  const name = match[1] ?? "";
  return DROP_NAMES.every((dropped) => !name.includes(dropped));
}

function insertBreakpoints(sql: string): string {
  const lines = sql.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    out.push(line);
    if (line.endsWith(";") && !line.trimStart().startsWith("--")) {
      out.push("--> statement-breakpoint");
    }
  }
  return `${out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}

function toMigrationSql(dump: string): string {
  const lines: string[] = [];
  for (const line of dump.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("-- PostgreSQL database dump")) continue;
    if (line.startsWith("-- PostgreSQL database dump complete")) continue;
    if (line.startsWith("-- Dumped from database version")) continue;
    if (line.startsWith("-- Dumped by pg_dump version")) continue;
    if (line.startsWith("\\restrict") || line.startsWith("\\unrestrict")) continue;
    if (line.startsWith("SET statement_timeout")) continue;
    if (line.startsWith("SET lock_timeout")) continue;
    if (line.startsWith("SET idle_in_transaction_session_timeout")) continue;
    if (line.startsWith("SET transaction_timeout")) continue;
    if (line.startsWith("SET client_encoding")) continue;
    if (line.startsWith("SET standard_conforming_strings")) continue;
    if (line.startsWith("SELECT pg_catalog.set_config")) continue;
    if (line.startsWith("SET check_function_bodies")) continue;
    if (line.startsWith("SET xmloption")) continue;
    if (line.startsWith("SET client_min_messages")) continue;
    if (line.startsWith("SET row_security")) continue;
    lines.push(line);
  }
  const stripped = lines.join("\n");
  const objects = stripped.split(/\n(?=--\n-- Name: )/).filter(keepObject);
  const header = `-- Drizzle migration 0001. Core's schema snapshot.
-- Generated from a fully migrated empty database. See 0001.notes.md.

`;
  return (
    header +
    insertBreakpoints(
      objects
        .join("\n")
        .replace(/^\n+/, "")
        .replace(/\n--\n--\s*$/, "\n"),
    )
  );
}

startErrorReporting();
const dbName = uniqueDbName("agent_platform_baseline");
const url = await createIsolatedDatabase(dbName);
const pool = await createPool(url, reportPoolError);
try {
  await applyMigrations(pool);
} finally {
  await pool.end();
}
try {
  const dump = dumpSchema(dbName);
  const sql = toMigrationSql(dump);
  const out = path.join(orchestratorRoot(import.meta.url), "drizzle", "0001_baseline.sql");
  writeFileSync(out, sql);
  console.log(`wrote ${out} (${sql.length} bytes, ${sql.split("\n").length} lines)`);
} finally {
  await dropIsolatedDatabase(dbName);
}
