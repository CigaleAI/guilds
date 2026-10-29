import assert from "node:assert/strict";
import { test } from "node:test";
import { parseColumnChange, parseColumns } from "../../src/artifacts/columns.js";
import {
  type GuildTableBefore,
  type GuildTableLive,
  guildTableEditEffects,
  planGuildTableChange,
} from "../../src/artifacts/guild-tables.js";
import type { AccessEntry } from "../../src/artifacts/types.js";

const COLUMNS = [
  { name: "project", type: "text", description: "project name", required: true },
  { name: "status", type: "text", description: "queue state", values: ["new", "done"] },
  { name: "owner", type: "text", description: "who follows it" },
];

function row(type: AccessEntry["type"], guildId: string | null): AccessEntry {
  return {
    type,
    id: guildId ?? "org_1",
    name: guildId ?? "org",
    mode: "read",
    guild_id: guildId,
    guild_name: guildId,
  };
}

const OWN = row("guild", "guild_own");
const ORG = row("org", null);
const OUTSIDE = row("guild", "guild_other");

function table(count: number, entries: AccessEntry[] = [OWN, ORG]): GuildTableBefore {
  return { name: "leads", columns: parseColumns(COLUMNS), count, entries };
}

test("guildTableEditEffects gives nothing for an edit that keeps the name and the columns", () => {
  const before = table(3, [OWN, ORG, OUTSIDE]);
  assert.deepEqual(
    guildTableEditEffects(before, "guild_own", { name: "leads", columns: null }),
    [],
  );
});

test("guildTableEditEffects names a rename, then the rows of other guilds that reach the table", () => {
  const before = table(3, [OWN, ORG, OUTSIDE, row("agent", "guild_other")]);
  assert.deepEqual(
    guildTableEditEffects(before, "guild_own", { name: "prospects", columns: null }),
    [
      { kind: "table_renamed", from: "leads", to: "prospects" },
      { kind: "reached_outside_guild", rows: [OUTSIDE, row("agent", "guild_other")] },
    ],
  );
});

test("guildTableEditEffects counts neither the organisation's row nor the guild's own rows as outside", () => {
  const before = table(3, [OWN, ORG, row("agent", "guild_own")]);
  assert.deepEqual(
    guildTableEditEffects(before, "guild_own", { name: "prospects", columns: null }),
    [{ kind: "table_renamed", from: "leads", to: "prospects" }],
  );
});

test("guildTableEditEffects names dropped and moved columns with the records they touch", () => {
  const before = table(2);
  const columns = parseColumnChange(before.columns, [
    COLUMNS[0],
    { ...COLUMNS[1], name: "stage", rename_from: "status" },
  ]);
  assert.deepEqual(guildTableEditEffects(before, "guild_own", { name: "leads", columns }), [
    { kind: "column_dropped", column: "owner", records: 2 },
    { kind: "column_moved", from: "status", to: "stage", records: 2 },
  ]);
});

test("guildTableEditEffects names a required column added only to a table with records", () => {
  const added = parseColumnChange(table(0).columns, [
    ...COLUMNS,
    { name: "budget", type: "number", description: "budget", required: true },
  ]);
  const optional = parseColumnChange(table(0).columns, [
    ...COLUMNS,
    { name: "budget", type: "number", description: "budget" },
  ]);
  assert.deepEqual(
    guildTableEditEffects(table(4), "guild_own", { name: "leads", columns: added }),
    [{ kind: "required_column_added", column: "budget", records: 4 }],
  );
  assert.deepEqual(
    guildTableEditEffects(table(0), "guild_own", { name: "leads", columns: added }),
    [],
  );
  assert.deepEqual(
    guildTableEditEffects(table(4), "guild_own", { name: "leads", columns: optional }),
    [],
  );
});

test("guildTableEditEffects names a kept column whose type or allowed values change", () => {
  const columns = parseColumnChange(table(1).columns, [
    COLUMNS[0],
    { ...COLUMNS[1], values: ["new", "done", "lost"] },
    { ...COLUMNS[2], type: "number" },
  ]);
  assert.deepEqual(guildTableEditEffects(table(1), "guild_own", { name: "leads", columns }), [
    { kind: "column_retyped", column: "status" },
    { kind: "column_retyped", column: "owner" },
  ]);
});

test("guildTableEditEffects names a kept column made required only on a table with records", () => {
  const columns = parseColumnChange(table(0).columns, [
    COLUMNS[0],
    COLUMNS[1],
    { ...COLUMNS[2], required: true },
  ]);
  assert.deepEqual(guildTableEditEffects(table(1), "guild_own", { name: "leads", columns }), [
    { kind: "column_made_required", column: "owner" },
  ]);
  assert.deepEqual(guildTableEditEffects(table(0), "guild_own", { name: "leads", columns }), []);
});

test("guildTableEditEffects names a kept column made unique, records or not", () => {
  const columns = parseColumnChange(table(0).columns, [
    { ...COLUMNS[0], unique: true },
    COLUMNS[1],
    COLUMNS[2],
  ]);
  assert.deepEqual(guildTableEditEffects(table(0), "guild_own", { name: "leads", columns }), [
    { kind: "column_made_unique", column: "project" },
  ]);
});

test("guildTableEditEffects judges a renamed column against the column it was", () => {
  const columns = parseColumnChange(table(1).columns, [
    COLUMNS[0],
    COLUMNS[1],
    { ...COLUMNS[2], name: "lead", rename_from: "owner", required: true },
  ]);
  assert.deepEqual(guildTableEditEffects(table(1), "guild_own", { name: "leads", columns }), [
    { kind: "column_moved", from: "owner", to: "lead", records: 1 },
    { kind: "column_made_required", column: "lead" },
  ]);
});

test("guildTableEditEffects names the rows outside the guild after a column change", () => {
  const before = table(0, [OWN, OUTSIDE]);
  const columns = parseColumnChange(before.columns, [COLUMNS[0], COLUMNS[1]]);
  assert.deepEqual(guildTableEditEffects(before, "guild_own", { name: "leads", columns }), [
    { kind: "column_dropped", column: "owner", records: 0 },
    { kind: "reached_outside_guild", rows: [OUTSIDE] },
  ]);
});

const LIVE_AT = "2026-10-01T00:00:00.000Z";
const NO_ROWS = { guild: null, agents: [] };

function live(guildId: string | null): GuildTableLive {
  return {
    id: "col_1",
    name: "leads",
    purpose: "Leads",
    guildId,
    columns: parseColumns(COLUMNS),
    updatedAt: LIVE_AT,
    access: { guild: guildId ? "write" : null, org: guildId ? null : "read", agents: new Map() },
  };
}

test("planGuildTableChange creates a guild's table with its row at write and the proposed rows on top", () => {
  const plan = planGuildTableChange({
    action: "create",
    orgId: "org_1",
    guildId: "guild_own",
    collection: { name: " leads ", purpose: "Leads", columns: COLUMNS, guildId: "guild_own" },
    access: { guild: null, agents: [{ id: "agent_1", mode: "read" }] },
    isNameTaken: false,
  });
  assert.ok(plan.action === "create");
  assert.equal(plan.href, "org/org_1/collections/leads");
  assert.deepEqual(plan.shape.access, {
    guild: "write",
    org: null,
    agents: new Map([["agent_1", "read"]]),
  });
  assert.deepEqual(plan.step, {
    action: "create",
    collection: {
      name: "leads",
      purpose: "Leads",
      columns: parseColumns(COLUMNS),
      guildId: "guild_own",
    },
    access: [{ type: "agent", id: "agent_1", mode: "read" }],
  });
});

test("planGuildTableChange starts an organisation table with the organisation's row at read", () => {
  const plan = planGuildTableChange({
    action: "create",
    orgId: "org_1",
    guildId: "guild_own",
    collection: { name: "leads", purpose: "Leads", columns: COLUMNS, guildId: null },
    access: { guild: "read", agents: [] },
    isNameTaken: false,
  });
  assert.ok(plan.action === "create");
  assert.deepEqual(plan.shape.access, { guild: "read", org: "read", agents: new Map() });
  assert.deepEqual(plan.step.access, [{ type: "guild", id: "guild_own", mode: "read" }]);
});

test("planGuildTableChange refuses a create of a name a table in the guild's reach holds", () => {
  const taken = {
    name: "GuildTableNameTaken",
    status: 409,
    message: "a table named leads already exists",
  };
  assert.throws(
    () =>
      planGuildTableChange({
        action: "create",
        orgId: "org_1",
        guildId: "guild_own",
        collection: { name: "leads", purpose: "Leads", columns: COLUMNS, guildId: "guild_own" },
        access: NO_ROWS,
        isNameTaken: true,
      }),
    taken,
  );
});

test("planGuildTableChange refuses deleting an organisation table and deletes a guild's own", () => {
  assert.throws(() => planGuildTableChange({ action: "delete", table: live(null) }), {
    name: "OrgTableChangeRefused",
    status: 422,
    tableName: "leads",
    refusal: { kind: "delete" },
  });
  assert.deepEqual(planGuildTableChange({ action: "delete", table: live("guild_own") }).step, {
    action: "delete",
    id: "col_1",
  });
});
