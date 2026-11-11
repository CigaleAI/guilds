import assert from "node:assert/strict";
import { test } from "node:test";
import type { GuildRow } from "../../src/db/guilds.js";
import type { OrgMembershipRow } from "../../src/db/orgs.js";
import type { Queryable } from "../../src/db/pg.js";
import type { StudioSessionRow } from "../../src/db/studio.js";
import { StudioNotFoundError } from "../../src/studio/errors.js";
import { blockOrphanedSession, readOwnedSession } from "../../src/studio/session.js";
import { userRow } from "../helpers/users.js";

// Opening a Studio session: who may read it, and an active session whose source guild is gone.

/** A query the fake database was sent. */
type SentQuery = { text: string; params: unknown[] };

/** A database that holds `session` and `guild`, recording every query it is sent. */
function sessionDatabase(
  session: StudioSessionRow | null,
  guild: GuildRow | null,
): { db: Queryable; queries: SentQuery[] } {
  const queries: SentQuery[] = [];
  const db = {
    query: async (text: string, params: unknown[] = []) => {
      queries.push({ text, params });
      if (text.includes("FROM studio_sessions")) {
        return { rows: session ? [session] : [] };
      }
      if (text.includes("FROM guilds")) {
        return { rows: guild ? [guild] : [] };
      }
      return { rows: [] };
    },
  } as unknown as Queryable;
  return { db, queries };
}

function studioSession(overrides: Partial<StudioSessionRow> = {}): StudioSessionRow {
  return {
    id: "s_1",
    org_id: "org_1",
    created_by_user_id: "user_1",
    source_guild_id: "guild_1",
    status: "active",
    blocked_reason: null,
    ...overrides,
  } as StudioSessionRow;
}

function guildRow(visibility: GuildRow["visibility"], operators: GuildRow["operators"] = []): GuildRow {
  return { id: "guild_1", org_id: "org_1", visibility, operators } as GuildRow;
}

const user = userRow({ id: "user_1", name: "operator" });
const org = { id: "org_1" } as OrgMembershipRow;

test("reads_the_users_own_session_on_a_guild_they_see", async () => {
  const session = studioSession();
  const { db } = sessionDatabase(session, guildRow("org"));
  assert.deepEqual(await readOwnedSession(db, "s_1", user, org), session);
});

test("reads_the_users_own_session_whose_source_guild_is_gone_without_writing", async () => {
  const session = studioSession({ source_guild_id: null });
  const { db, queries } = sessionDatabase(session, null);
  assert.deepEqual(await readOwnedSession(db, "s_1", user, org), session);
  assert.ok(queries.every(({ text }) => !text.startsWith("UPDATE")));
});

const unseen: Array<[string, StudioSessionRow | null, GuildRow | null]> = [
  ["a_missing_session", null, null],
  ["a_session_of_another_organisation", studioSession({ org_id: "org_2" }), guildRow("org")],
  ["a_session_of_another_user", studioSession({ created_by_user_id: "user_2" }), guildRow("org")],
  ["a_session_whose_user_is_gone", studioSession({ created_by_user_id: null }), guildRow("org")],
  ["a_session_on_a_private_guild_the_user_does_not_operate", studioSession(), guildRow("private")],
];

for (const [named, session, guild] of unseen) {
  test(`does_not_find_${named}`, async () => {
    const { db } = sessionDatabase(session, guild);
    await assert.rejects(readOwnedSession(db, "s_1", user, org), StudioNotFoundError);
  });
}

test("reads_the_users_own_session_on_a_private_guild_they_operate", async () => {
  const session = studioSession();
  const { db } = sessionDatabase(session, guildRow("private", [{ user_id: "user_1", role: "operator" }] as GuildRow["operators"]));
  assert.deepEqual(await readOwnedSession(db, "s_1", user, org), session);
});

test("blocks_an_active_session_whose_source_guild_is_gone", async () => {
  const session = studioSession({ source_guild_id: null });
  const { db, queries } = sessionDatabase(session, null);
  const blocked = await blockOrphanedSession(db, session);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blocked_reason, "source_deleted");
  assert.equal(session.status, "active", "the row read is left as it was read");
  const update = queries.find(({ text }) => text.startsWith("UPDATE studio_sessions"));
  assert.ok(update);
  assert.ok(update.params.includes("blocked"));
  assert.ok(update.params.includes("source_deleted"));
});

const untouched: Array<[string, StudioSessionRow]> = [
  ["an_active_session_on_its_guild", studioSession()],
  ["an_archived_session_whose_source_guild_is_gone", studioSession({ source_guild_id: null, status: "archived" })],
  [
    "a_session_already_blocked_on_input_tokens",
    studioSession({ source_guild_id: null, status: "blocked", blocked_reason: "input_token_limit" }),
  ],
];

for (const [named, session] of untouched) {
  test(`leaves_${named}_as_it_is`, async () => {
    const { db, queries } = sessionDatabase(session, null);
    assert.equal(await blockOrphanedSession(db, session), session);
    assert.deepEqual(queries, []);
  });
}
