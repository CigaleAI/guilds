import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { orchestratorRoot, repoRoot } from "../../src/lib/paths.js";

const DROP_OBJECTS = ["__drizzle_migrations", "drizzle"];

const ADMIN_URL =
  process.env.R1_ADMIN_DATABASE_URL ??
  "postgresql://agent_platform:agent_platform@127.0.0.1:5432/postgres";

function pgConn(): { host: string; port: string; user: string; password: string } {
  const url = new URL(ADMIN_URL);
  return {
    host: url.hostname,
    port: url.port || "5432",
    user: decodeURIComponent(url.username) || "agent_platform",
    password: decodeURIComponent(url.password) || "agent_platform",
  };
}

function runPgTool(
  tool: "psql" | "pg_dump",
  databaseName: string,
  extraArgs: string[],
  input?: string,
): string {
  const { port, user, password } = pgConn();
  const env = { ...process.env, PGPASSWORD: password };
  const pgArgs = ["-p", port, "-U", user, "-d", databaseName, ...extraArgs];
  // Same major as compose/CI (postgres:17). Host pg_dump on Ubuntu is 16
  // and refuses to dump a 17 server.
  const dockerRun =
    process.platform === "linux"
      ? [
          "run",
          "--rm",
          "-i",
          "--network",
          "host",
          "-e",
          "PGPASSWORD",
          "postgres:17",
          tool,
          "-h",
          "127.0.0.1",
          ...pgArgs,
        ]
      : [
          "run",
          "--rm",
          "-i",
          "--add-host",
          "host.docker.internal:host-gateway",
          "-e",
          "PGPASSWORD",
          "postgres:17",
          tool,
          "-h",
          "host.docker.internal",
          ...pgArgs,
        ];
  try {
    return execFileSync("docker", dockerRun, { encoding: "utf8", env, input });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  // Local Compose: project declares env_file: .env on orchestrator, so exec
  // must not require a repo-root .env (CI has none).
  return execFileSync(
    "docker",
    [
      "compose",
      "--env-file",
      "/dev/null",
      "exec",
      "-T",
      "postgres",
      tool,
      "-U",
      user,
      "-d",
      databaseName,
      ...extraArgs,
    ],
    {
      encoding: "utf8",
      cwd: repoRoot(import.meta.url),
      input,
      env: { ...env, COMPOSE_DISABLE_ENV_FILE: "1" },
    },
  );
}

export function dumpSchema(databaseName: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(databaseName)) {
    throw new Error(`unsafe database name ${databaseName}`);
  }
  return runPgTool("pg_dump", databaseName, ["--schema-only", "--no-owner", "--no-privileges"]);
}

export function applySql(databaseName: string, sql: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(databaseName)) {
    throw new Error(`unsafe database name ${databaseName}`);
  }
  runPgTool("psql", databaseName, ["-v", "ON_ERROR_STOP=1", "-f", "-"], sql);
}

export function normalizeDump(sql: string): string {
  const lines: string[] = [];
  for (const line of sql.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("-- Dumped from database version")) continue;
    if (line.startsWith("-- Dumped by pg_dump version")) continue;
    if (line.startsWith("-- PostgreSQL database dump")) continue;
    if (line.startsWith("\\restrict") || line.startsWith("\\unrestrict")) continue;
    if (line.startsWith("SET ") || line.startsWith("SELECT pg_catalog.set_config")) {
      continue;
    }
    lines.push(line);
  }
  const stripped = lines.join("\n");
  const objects = stripped.split(/\n(?=--\n-- Name: )/);
  const kept = objects.filter((block) => {
    const match = /^(?:--\n)?-- Name: ([^\n]+)/.exec(block);
    if (!match) {
      return true;
    }
    const name = match[1] ?? "";
    return DROP_OBJECTS.every((dropped) => !name.includes(dropped));
  });
  return `${kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .trimEnd()}\n`;
}

export function drizzleMigrationSql(): string {
  const dir = path.join(orchestratorRoot(import.meta.url), "drizzle");
  return readdirSync(dir)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort()
    .map((name) => readFileSync(path.join(dir, name), "utf8"))
    .join("\n");
}
