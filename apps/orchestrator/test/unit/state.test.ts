import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTEXT_HISTORY_LIMIT } from "../../src/groupchat/history.js";
import { STATE_PREFIX, attachState } from "../../src/prompts/index.js";
import { collectRunState } from "../../src/state/index.js";
import { loadJsonFixture } from "../helpers/fixtures.js";

const fixture = loadJsonFixture<{
  state: Record<string, unknown>;
  embedded: string;
  attached: string;
  without_database: Record<string, unknown>;
}>("state/snapshot.json");

class FakeNotes {
  constructor(
    public privateNotes: string[],
    public shared: string[],
  ) {}

  listPrivateNotes(_orgSlug: string, _guildName: string, _agentName: string, _prefix: string): string[] {
    return this.privateNotes;
  }

  listSharedNotes(_orgSlug: string, _guildName: string, _prefix: string): string[] {
    return this.shared;
  }
}

function chatRow(seq: number, content: string): Record<string, unknown> {
  return {
    id: seq,
    seq,
    author_type: "user",
    author_name: "ada",
    author_agent_id: null,
    content,
    tagged_names: [],
    tagged_agent_ids: [],
  };
}

test("collect_run_state matches the R0 fixture", () => {
  const notes = new FakeNotes(
    [
      "orgs/acme/guilds/research/agents/researcher/notes/alpha.md",
      "orgs/acme/guilds/research/agents/researcher/notes/history-archive/",
      "orgs/acme/guilds/research/agents/researcher/history-archive/",
    ],
    ["orgs/acme/guilds/research/shared/brief.md"],
  );
  const rows = Array.from({ length: 12 }, (_, index) => chatRow(index + 1, `m${index + 1}`));
  const state = collectRunState(notes, "acme", "research", "researcher", {
    members: [
      { name: "researcher", focus: "read papers" },
      { name: "writer", focus: "" },
    ],
    operators: [{ user_id: "user_ada", name: "ada", role: "admin" }],
    historyRows: rows,
    guildAbout: "weekly synthesis",
    collections: [{ name: "papers", purpose: "reading list", count: 3 }],
    secrets: [{ id: "sec_1", name: "WALLET_PRIVATE_KEY", description: "signs sends" }],
    scripts: [
      {
        name: "send_usdc",
        description: "Sign and send USDC",
        parameters: { type: "object" },
      },
    ],
    now: new Date("2026-09-13T09:00:12.000Z"),
  });
  assert.deepEqual(state, fixture.state);
  assert.equal(STATE_PREFIX + JSON.stringify(state, null, 2), fixture.embedded);
  assert.equal(attachState("You are an agent.\n", state), fixture.attached);
  assert.equal((state.group as { history: unknown[] }).history.length, CONTEXT_HISTORY_LIMIT);
});

test("collect_run_state lists each collection with its access, display path, and columns", () => {
  const columns = [
    { name: "name", type: "text", required: true, unique: true, description: "token name" },
    { name: "status", type: "text", values: ["new", "done"], description: "queue state" },
  ];
  const state = collectRunState(new FakeNotes([], []), "acme", "research", "researcher", {
    members: [{ name: "researcher" }],
    historyRows: [],
    collections: [
      { name: "metas", purpose: "tokens", access: "write", scope: "guild", display_path: "org/org_1/collections/metas", columns },
      { name: "loose", purpose: "free-form", access: "read", scope: "org", columns: [] },
      { name: "…", purpose: "more collections exist", truncated: true, columns: [] },
    ],
  });
  assert.deepEqual(state.collections, [
    { name: "metas", purpose: "tokens", access: "write", scope: "guild", display_path: "org/org_1/collections/metas", columns },
    { name: "loose", purpose: "free-form", access: "read", scope: "org", columns: [] },
    { name: "…", purpose: "more collections exist", columns: [], truncated: true },
  ]);
});

test("collect_run_state always lists collections", () => {
  const notes = new FakeNotes(
    ["orgs/acme/guilds/research/agents/researcher/notes/alpha.md"],
    ["orgs/acme/guilds/research/shared/brief.md"],
  );
  const state = collectRunState(notes, "acme", "research", "researcher", {
    members: [],
    historyRows: [],
    collections: [{ name: "papers", purpose: "reading list" }],
    now: new Date("2026-09-13T09:00:12.000Z"),
  });
  assert.deepEqual(state, fixture.without_database);
});

test("collect_run_state uses supplied max_tool_calls", () => {
  const state = collectRunState(new FakeNotes([], []), "acme", "research", "researcher", {
    members: [{ name: "researcher" }],
    historyRows: [],
    maxToolCalls: 12,
  });
  assert.equal(state.max_tool_calls, 12);
});

test("collect_run_state stamps the UTC clock", () => {
  const state = collectRunState(new FakeNotes([], []), "acme", "research", "researcher", {
    members: [{ name: "researcher" }],
    historyRows: [],
    now: new Date("2026-09-17T19:14:00.500Z"),
  });
  assert.equal(state.utc_now, "2026-09-17T19:14:00Z");
  assert.equal(state.utc_date, "Thursday, 17 September 2026");
});
