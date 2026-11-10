import assert from "node:assert/strict";
import { test } from "node:test";
import type { OrgMembershipRow } from "../../src/db/orgs.js";
import type { Queryable } from "../../src/db/pg.js";
import type { StudioSessionRow } from "../../src/db/studio.js";
import { StudioUnprocessableError } from "../../src/studio/errors.js";
import { StudioService } from "../../src/studio/index.js";
import { userRow } from "../helpers/users.js";

/** A database that refuses every query: a continuation refused up front never reaches it. */
const unreachableDb = {
  query: async () => {
    throw new Error("the database was queried");
  },
} as unknown as Queryable;

function studioService(): StudioService {
  return new StudioService({
    db: unreachableDb,
    artifacts: {} as never,
    scripts: {} as never,
    schedules: {} as never,
    notesSystemPath: "system.md",
  });
}

function studioSession(
  status: StudioSessionRow["status"],
  blockedReason: StudioSessionRow["blocked_reason"],
): StudioSessionRow {
  return { id: "session-1", org_id: "org-1", source_guild_id: "guild-1", status, blocked_reason: blockedReason } as never;
}

const user = userRow({ id: "user-1", name: "operator" });
const org: OrgMembershipRow = { id: "org-1" } as never;

const refused: Array<[string, StudioSessionRow["status"], StudioSessionRow["blocked_reason"]]> = [
  ["an_active_session", "active", null],
  ["an_active_session_that_records_an_input_token_limit", "active", "input_token_limit"],
  ["a_session_blocked_because_its_source_was_deleted", "blocked", "source_deleted"],
];

for (const [named, status, blockedReason] of refused) {
  test(`continue_refuses_${named}`, async () => {
    await assert.rejects(
      studioService().continueSession(studioSession(status, blockedReason), user, org),
      (error) => error instanceof StudioUnprocessableError && error.message === "session is not blocked on input tokens",
    );
  });
}

test("continue_of_a_session_blocked_on_input_tokens_goes_on_to_read_its_drafts", async () => {
  await assert.rejects(
    studioService().continueSession(studioSession("blocked", "input_token_limit"), user, org),
    /the database was queried/,
  );
});
