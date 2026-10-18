import assert from "node:assert/strict";
import { test } from "node:test";
import {
  messageCostUsd,
  usageCounterKey,
  usageDelta,
  usageFields,
  usageTree,
  utcMonth,
} from "../../src/usage.js";

test("usage_delta_reads_assistant_metadata", () => {
  const delta = usageDelta({
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      cache_read_tokens: 2,
    },
    cost_usd: 0.001,
  });
  assert.ok(delta);
  assert.equal(delta.input_tokens, 10);
  assert.equal(delta.output_tokens, 4);
  assert.equal(delta.cache_read_tokens, 2);
  assert.equal(delta.cost_usd, 0.001);
});

test("usage_delta_ignores_rows_without_usage", () => {
  assert.equal(usageDelta({ source: "tool", tool_name: "note_read" }), null);
  assert.equal(usageDelta({}), null);
});

test("message_cost_usd_null_without_usage", () => {
  assert.equal(messageCostUsd({ source: "tool", tool_name: "note_read" }), null);
  assert.equal(messageCostUsd({}), null);
});

test("message_cost_usd_reads_assistant_cost", () => {
  assert.equal(
    messageCostUsd({
      usage: { input_tokens: 10, output_tokens: 4, cache_read_tokens: 2 },
      cost_usd: 0.001,
    }),
    0.001,
  );
  assert.equal(messageCostUsd({ usage: {} }), 0);
});

test("usage_fields_zeros_missing_row", () => {
  assert.deepEqual(usageFields(null), {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0,
    cost_usd: 0.0,
    calls: 0,
    updated_at: null,
  });
});

test("usage_fields_formats_row", () => {
  const updated = new Date(Date.UTC(2026, 8, 13));
  const fields = usageFields({
    input_tokens: 8,
    output_tokens: 2,
    cache_read_tokens: 1,
    cost_usd: 0.25,
    calls: 3,
    updated_at: updated,
  });
  assert.equal(fields.total_tokens, 10);
  assert.equal(fields.cost_usd, 0.25);
  assert.equal(
    usageFields({
      cost_usd: 0.011984499999999999,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      calls: 0,
      updated_at: null,
    }).cost_usd,
    0.0119845,
  );
  assert.equal(fields.calls, 3);
  assert.equal(fields.updated_at, "2026-09-13T00:00:00+00:00");
});

test("usage_tree_nests_resources_under_organisations", () => {
  const counters = new Map<string, unknown>([
    [
      usageCounterKey("global", ""),
      {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: 0,
        cost_usd: 0.02,
        calls: 1,
        updated_at: null,
      },
    ],
    [
      usageCounterKey("org", "org_manu"),
      {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: 0,
        cost_usd: 0.02,
        calls: 1,
        updated_at: null,
      },
    ],
    [
      usageCounterKey("guild", "guild_1"),
      {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: 0,
        cost_usd: 0.02,
        calls: 1,
        updated_at: null,
      },
    ],
    [
      usageCounterKey("agent", "agent_1"),
      {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: 0,
        cost_usd: 0.02,
        calls: 1,
        updated_at: null,
      },
    ],
  ]);
  const tree = usageTree({
    orgs: [
      { id: "org_manu", name: "manu", slug: "manu" },
      { id: "org_adel", name: "adel", slug: "adel" },
    ],
    guilds: [{ id: "guild_1", name: "research", org_id: "org_manu" }],
    agents: [
      {
        id: "agent_1",
        guild_id: "guild_1",
        name: "reader",
        avatar_shape: "hex",
        avatar_color: "#3b82f6",
      },
    ],
    counters,
  });
  const global = tree.global as Record<string, unknown>;
  const organisations = tree.organisations as Array<Record<string, unknown>>;
  assert.equal(global.total_tokens, 15);
  assert.deepEqual(
    organisations.map((account) => account.name),
    ["manu", "adel"],
  );
  const manu = organisations[0] as Record<string, unknown>;
  const adel = organisations[1] as Record<string, unknown>;
  const guilds = manu.guilds as Array<Record<string, unknown>>;
  const agents = guilds[0]?.agents as Array<Record<string, unknown>>;
  assert.equal(guilds[0]?.name, "research");
  assert.equal(agents[0]?.name, "reader");
  assert.equal(agents[0]?.total_tokens, 15);
  assert.equal(adel.total_tokens, 0);
  assert.deepEqual(adel.guilds, []);
  assert.equal((manu.studio as Record<string, unknown>).total_tokens, 0);
  assert.equal(manu.archived, null);
});

test("usage_tree_exposes_studio_and_archived_residual", () => {
  const counters = new Map<string, unknown>([
    [
      usageCounterKey("org", "org_manu"),
      {
        input_tokens: 30,
        output_tokens: 10,
        cache_read_tokens: 0,
        cost_usd: 0.05,
        calls: 3,
        updated_at: null,
      },
    ],
    [
      usageCounterKey("guild", "guild_1"),
      {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: 0,
        cost_usd: 0.02,
        calls: 1,
        updated_at: null,
      },
    ],
  ]);
  const tree = usageTree({
    orgs: [{ id: "org_manu", name: "manu", slug: "manu" }],
    guilds: [{ id: "guild_1", name: "research", org_id: "org_manu" }],
    agents: [],
    counters,
    studioByOrg: new Map([
      [
        "org_manu",
        {
          input_tokens: 8,
          output_tokens: 2,
          cache_read_tokens: 0,
          cost_usd: 0.01,
          calls: 1,
          updated_at: null,
        },
      ],
    ]),
  });
  const manu = (tree.organisations as Array<Record<string, unknown>>)[0];
  assert.ok(manu);
  const studio = manu.studio as Record<string, unknown>;
  const archived = manu.archived as Record<string, unknown>;
  assert.equal(studio.total_tokens, 10);
  assert.equal(studio.cost_usd, 0.01);
  assert.equal(archived.total_tokens, 15);
  assert.equal(archived.calls, 1);
});

test("builder spend is its own line, not part of deleted guilds and agents", () => {
  const totals = (tokens: number, cost: number) => ({
    input_tokens: tokens,
    output_tokens: 0,
    cache_read_tokens: 0,
    cost_usd: cost,
    calls: 1,
    updated_at: null,
  });
  const tree = usageTree({
    orgs: [{ id: "org_manu", name: "manu", slug: "manu" }],
    guilds: [],
    agents: [],
    counters: new Map([[usageCounterKey("org", "org_manu"), { ...totals(30, 0.03), calls: 2 }]]),
    studioByOrg: new Map([["org_manu", totals(10, 0.01)]]),
    builderByOrg: new Map([["org_manu", totals(20, 0.02)]]),
  });
  const manu = (tree.organisations as Array<Record<string, unknown>>)[0];
  assert.ok(manu);
  assert.equal((manu.builder as Record<string, unknown>).total_tokens, 20);
  assert.equal(manu.archived, null);
});

test("utcMonth is YYYY-MM in UTC", () => {
  assert.equal(utcMonth(new Date("2026-09-15T23:00:00.000Z")), "2026-09");
});
