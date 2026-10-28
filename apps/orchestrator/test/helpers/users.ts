import type { UserRow } from "../../src/db/users.js";

const STAMP = "2026-10-12T09:00:00.000Z";

/** A user row as `getUser` returns it: the seed operator unless `overrides` says otherwise. */
export function userRow(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: "user_operator",
    name: "operator",
    created_at: STAMP,
    updated_at: STAMP,
    image: null,
    email: null,
    timezone: null,
    color: null,
    ...overrides,
  };
}
