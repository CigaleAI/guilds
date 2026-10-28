import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  USER_HEADER,
  UserIdentityError,
  UserValidationError,
  resolveUser,
  userItem,
  validateUserName,
} from "../../src/users/index.js";
import {
  ORG_HEADER,
  OrgIdentityError,
  SEED_ORG_FOUNDERS,
  SEED_ORG_HOME_USER_ID,
  SEED_ORG_ID,
  SEED_ORG_NAME,
  SEED_ORG_SLUG,
  canManageMembers,
  canManageOwners,
  canManageSettings,
  memberItem,
  orgItem,
  OrgValidationError,
  resolveOrg,
  validateOrgName,
  validateRole,
  validateSlug,
} from "../../src/organisations/index.js";
import { repoRoot } from "../../src/lib/paths.js";
import { groupMessageItem, iso, isoOrNull, messageItem, runItem } from "../../src/db/views.js";
import { runSnapshot } from "../helpers/generation.js";

test("validate user name", () => {
  assert.equal(validateUserName("operator"), "operator");
  assert.equal(validateUserName("ada-2"), "ada-2");
  assert.throws(() => validateUserName("user"), UserValidationError);
  assert.throws(() => validateUserName("Ada"), UserValidationError);
});

test("resolve_user uses token then sole user", () => {
  const operator = { id: "user_operator", name: "operator" };
  const ada = { id: "user_ada", name: "ada" };
  assert.equal(resolveUser([operator, ada], "user_ada"), ada);
  assert.equal(resolveUser([operator], null), operator);
});

test("resolve_user requires header when several", () => {
  const users = [
    { id: "user_operator", name: "operator" },
    { id: "user_ada", name: "ada" },
  ];
  try {
    resolveUser(users, null);
    assert.fail("expected error");
  } catch (error) {
    assert.ok(error instanceof UserIdentityError);
    assert.equal(error.status, 400);
    assert.match(error.message, new RegExp(USER_HEADER));
  }
  try {
    resolveUser(users, "user_missing");
    assert.fail("expected error");
  } catch (error) {
    assert.ok(error instanceof UserIdentityError);
    assert.equal(error.status, 404);
    assert.match(error.message, /user not found/);
  }
});

test("user_item formats timestamps and optional fields", () => {
  const item = userItem({
    id: "user_operator",
    name: "operator",
    created_at: "2026-09-12T00:00:00+00:00",
    updated_at: "2026-09-12T00:00:00+00:00",
  });
  assert.equal(item.email, null);
  assert.equal(item.image, null);
  const emailed = userItem({
    id: "user_operator",
    name: "operator",
    email: "Ada@Example.com",
    created_at: "2026-09-12T00:00:00+00:00",
    updated_at: "2026-09-12T00:00:00+00:00",
  });
  assert.equal(emailed.email, "Ada@Example.com");
});

test("the seed organisation is Home, owned by the operator", () => {
  assert.equal(SEED_ORG_ID, "org_home");
  assert.equal(SEED_ORG_NAME, "Home");
  assert.equal(SEED_ORG_SLUG, "home");
  assert.deepEqual([...SEED_ORG_FOUNDERS], ["user_operator"]);
  assert.equal(SEED_ORG_HOME_USER_ID, "user_operator");
});

test("validate slug name and role", () => {
  assert.equal(validateSlug("acme"), "acme");
  assert.equal(validateSlug("degen-capital"), "degen-capital");
  assert.throws(() => validateSlug("Acme"), OrgValidationError);
  assert.equal(validateOrgName(" Acme "), "Acme");
  assert.throws(() => validateOrgName("  "), /required/);
  assert.equal(validateRole("owner"), "owner");
  assert.throws(() => validateRole("guest"), /role must be/);
});

test("resolve_org identity", () => {
  const personal = { id: "org_personal", slug: "manu", name: "manu" };
  const shared = { id: "org_acme", slug: "acme", name: "Acme" };
  assert.equal(resolveOrg([personal, shared], "org_acme"), shared);
  assert.equal(resolveOrg([personal], null), personal);
  try {
    resolveOrg([personal, shared], null);
    assert.fail("expected error");
  } catch (error) {
    assert.ok(error instanceof OrgIdentityError);
    assert.equal(error.status, 400);
    assert.match(error.message, new RegExp(ORG_HEADER));
  }
  try {
    resolveOrg([personal, shared], "org_missing");
    assert.fail("expected error");
  } catch (error) {
    assert.ok(error instanceof OrgIdentityError);
    assert.equal(error.status, 404);
  }
});

test("owner admin and member permissions", () => {
  assert.equal(canManageMembers("owner"), true);
  assert.equal(canManageMembers("admin"), true);
  assert.equal(canManageMembers("member"), false);
  assert.equal(canManageOwners("owner"), true);
  assert.equal(canManageOwners("admin"), false);
  assert.equal(canManageSettings("owner"), true);
  assert.equal(canManageSettings("member"), false);
});

test("org and member items", () => {
  const org = orgItem({
    id: "org_acme",
    name: "Acme",
    slug: "acme",
    role: "owner",
    created_at: "2026-09-15T00:00:00+00:00",
    updated_at: "2026-09-15T00:00:00+00:00",
  });
  assert.equal(org.role, "owner");
  const member = memberItem({
    user_id: "user_manu",
    name: "manu",
    image: "/static/users/manu.jpeg",
    email: null,
    color: null,
    role: "owner",
    created_at: "2026-09-15T00:00:00+00:00",
  });
  assert.equal(member.image, "/static/users/manu.jpeg");
});

test("run and message views match R0 fixtures", () => {
  const fixture = JSON.parse(
    readFileSync(path.join(repoRoot(import.meta.url), "fixtures/compat/views/run-message.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(
    messageItem({
      id: 4294967303,
      seq: 3,
      payload: { role: "user", content: "hi" },
      metadata: { generation: 1 },
      created_at: "2026-09-13T12:00:00.123456+00:00",
    }),
    fixture.message_us,
  );
  assert.deepEqual(
    messageItem({
      id: 1,
      seq: 0,
      payload: { role: "system", content: "sys" },
      metadata: {},
      created_at: "2026-09-13T12:00:00+00:00",
    }),
    fixture.message_whole,
  );
  assert.deepEqual(
    runItem(
      {
        id: "r_1",
        agent_id: "a_1",
        status: "active",
        config_snapshot: runSnapshot(),
        errors: [],
        system_prompt_hash: "abc",
        task_prompt_hash: "def",
        memory_prompt_hash: "ghi",
        metadata: {},
        created_at: "2026-09-13T12:00:00.123456+00:00",
        updated_at: "2026-09-13T12:00:00.123456+00:00",
        kind: "direct",
        group_chat_through_seq: null,
        schedule_id: null,
      },
      true,
    ),
    Object.assign({}, fixture.run, { config_snapshot: runSnapshot() }),
  );
  assert.deepEqual(
    groupMessageItem({
      id: 9,
      guild_id: "guild_1",
      seq: 1,
      author_type: "user",
      author_name: "operator",
      author_agent_id: null,
      author_user_id: null,
      source_run_id: null,
      content: "hello @ada",
      tagged_names: ["ada"],
      tagged_agent_ids: [],
      tagged_user_ids: ["user_ada"],
      created_at: "2026-09-13T12:00:00.123456+00:00",
    }),
    fixture.group_message,
  );
  assert.deepEqual(
    userItem({
      id: "user_operator",
      name: "operator",
      email: null,
      image: null,
      created_at: "2026-09-13T12:00:00+00:00",
      updated_at: "2026-09-13T12:00:00+00:00",
    }),
    fixture.user,
  );
});

test("iso formats a timestamp column and rejects a missing one", () => {
  assert.equal(iso("2024-05-01 10:00:00+00"), "2024-05-01T10:00:00+00:00");
  assert.equal(iso("2024-05-01T10:00:00+00:00"), "2024-05-01T10:00:00+00:00");
  assert.equal(iso(new Date("2024-05-01T10:00:00Z")), "2024-05-01T10:00:00.000Z");
  assert.throws(() => iso(null), TypeError);
});

test("isoOrNull returns null for a missing timestamp and formats the rest", () => {
  assert.equal(isoOrNull(null), null);
  assert.equal(isoOrNull(undefined), null);
  assert.equal(isoOrNull("2024-05-01 10:00:00+00"), "2024-05-01T10:00:00+00:00");
  assert.throws(() => isoOrNull(42), TypeError);
});
