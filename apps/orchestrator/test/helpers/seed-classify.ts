import { readFileSync } from "node:fs";
import path from "node:path";
import type pg from "pg";
import { repoRoot } from "../../src/lib/paths.js";
import {
  MCP_SEED_SERVERS,
  NATIVE_TOOLS,
  PLATFORM_NATIVE_TOOLS,
} from "../../src/db/seed/catalog.js";

export type SeedManifest = {
  system: {
    connectors: Array<{
      id: string;
      slug: string;
      display_name: string;
      auth: string;
      source: string;
    }>;
    expected_mcp_slugs: string[];
    platform_native_tool_bindings: Array<{ catalog_id: string; enabled: boolean }>;
    expected_platform_native_tools: string[];
    bash_absent: boolean;
    native_tools_constant: string[];
  };
  operator: {
    users: Array<{ id: string; name: string; email: string | null }>;
    orgs: Array<{ id: string; name: string; slug: string }>;
    org_members: Array<{ org_id: string; user_id: string; role: string }>;
  };
  row_counts: Record<string, number>;
};

export function loadSeedManifest(): SeedManifest {
  const file = path.join(repoRoot(import.meta.url), "fixtures/compat/seed/manifest.json");
  return JSON.parse(readFileSync(file, "utf8")) as SeedManifest;
}

export async function classifySeed(pool: pg.Pool) {
  const mcp = await pool.query(
    `
    SELECT id, slug, manifest->>'display_name' AS display_name, manifest->'auth'->>'kind' AS auth, source
    FROM connectors
    ORDER BY id
    `,
  );
  const bindings = await pool.query(
    `
    SELECT catalog_id, enabled
    FROM bindings
    WHERE catalog_kind = 'native_tool' AND scope = 'platform'
    ORDER BY catalog_id
    `,
  );
  const users = await pool.query(
    `SELECT id, name, email FROM users ORDER BY id`,
  );
  const orgs = await pool.query(
    `SELECT id, name, slug FROM orgs ORDER BY id`,
  );
  const members = await pool.query(
    `SELECT org_id, user_id, role FROM org_members ORDER BY org_id, user_id`,
  );
  const counts = await pool.query(
    `
    SELECT
      (SELECT count(*)::int FROM users) AS users,
      (SELECT count(*)::int FROM orgs) AS orgs,
      (SELECT count(*)::int FROM org_members) AS org_members,
      (SELECT count(*)::int FROM connectors) AS connectors,
      (SELECT count(*)::int FROM bindings) AS bindings,
      (SELECT count(*)::int FROM secrets) AS secrets
    `,
  );
  return {
    connectors: mcp.rows,
    platform_native_tool_bindings: bindings.rows.map((row) => ({
      catalog_id: row.catalog_id as string,
      enabled: row.enabled as boolean,
    })),
    users: users.rows,
    orgs: orgs.rows,
    org_members: members.rows,
    bash_absent: !bindings.rows.some((row) => row.catalog_id === "bash"),
    row_counts: counts.rows[0] as Record<string, number>,
    constants: {
      expected_mcp_slugs: MCP_SEED_SERVERS.map((server) => server.slug),
      expected_platform_native_tools: [...PLATFORM_NATIVE_TOOLS],
      native_tools_constant: [...NATIVE_TOOLS],
    },
  };
}
