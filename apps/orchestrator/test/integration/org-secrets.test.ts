import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { decodeMasterKey } from "../../src/config/index.js";
import { connect } from "../../src/db/client.js";
import { Repositories } from "../../src/db/repositories.js";
import { DEFAULT_MODEL } from "../../src/llm/catalog.js";
import { NotesStore } from "../../src/notes/store.js";
import { Scripts } from "../../src/scripts/catalog.js";
import { Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const dbName = uniqueDbName("agent_platform_org_secrets");
const as = (user: string) => ({ "X-Guilds-User": user, "X-Guilds-Org": "org_home" });
const OWNER = as("user_operator");
const ADMIN = as("user_secret_admin");
const MEMBER = as("user_secret_member");

type Meta = {
  id: string;
  name: string;
  org_wide: boolean;
  grants: Array<{ kind: string; id: string | null; name: string | null }>;
  created_by: { kind: string; id: string | null; name: string | null } | null;
  can_manage: boolean;
};

let app: FastifyInstance;
let repo: Repositories;
let closeDb: () => Promise<void>;
const accessChanges: string[][] = [];
const valueChanges: string[] = [];

before(async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const database = await connect(await createIsolatedDatabase(dbName));
  closeDb = () => database.close();
  const notes = new NotesStore(tempDir("guilds-secrets-notes-"), templatesRoot(), "notes");
  await notes.ensureSystemPrompt();
  repo = new Repositories(database.pool);
  const generation = {
    group_chat: { observe: () => undefined },
    agent_is_busy: () => false,
    secretAccessChanged: async (agentIds: string[]) => {
      accessChanges.push([...agentIds].sort());
    },
    secretChanged: async (secretId: string) => {
      valueChanges.push(secretId);
    },
  };
  app = await buildApp(database, {
    repo,
    notes,
    scripts: new Scripts(repo),
    schedules: new Schedules(repo, notes),
    masterKey: decodeMasterKey(HEX_MASTER_KEY),
    generation: generation as never,
  });
  const now = new Date();
  await repo.insertUser("user_secret_admin", "secret-admin", now, null, "secret-admin@example.com");
  await repo.insertMember("org_home", "user_secret_admin", "admin", now);
  await repo.insertUser("user_secret_member", "secret-member", now, null, "secret-member@example.com");
  await repo.insertMember("org_home", "user_secret_member", "member", now);
  await repo.insertGuild("guild_open", "open-desk", now, "org_home");
  await repo.insertGuild("guild_side", "side-desk", now, "org_home");
  await repo.insertGuild("guild_hidden", "hidden-lab", now, "org_home", "", 20, "private", "user_operator");
  const config = { model: DEFAULT_MODEL };
  await repo.insertAgent("a_open", "guild_open", "opener", config, now);
  await repo.insertAgent("a_open_two", "guild_open", "second", config, now);
  await repo.insertAgent("a_side", "guild_side", "sider", config, now);
  await repo.insertAgent("a_hidden", "guild_hidden", "hider", config, now);
  await repo.insertOrg("org_elsewhere", "Elsewhere", "elsewhere", "user_secret_member", now);
});

after(async () => {
  await app?.close();
  await closeDb?.();
  await dropIsolatedDatabase(dbName);
});

async function call(
  headers: Record<string, string>,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  payload?: Record<string, unknown>,
) {
  return app.inject({
    method,
    url,
    headers: payload ? { ...headers, "content-type": "application/json" } : headers,
    ...(payload ? { payload } : {}),
  });
}

async function create(headers: Record<string, string>, body: Record<string, unknown>) {
  return call(headers, "POST", "/api/secrets", { description: "used in tests", value: "v", ...body });
}

async function environment(agentId: string, guildId: string): Promise<string[]> {
  const rows = await repo.listAgentSecrets({ orgId: "org_home", guildId, agentId });
  return rows.map((row) => String(row.name));
}

test("a name is one secret per organisation", async () => {
  const first = await create(OWNER, { name: "SHARED_NAME", org_wide: true });
  assert.equal(first.statusCode, 201);
  const clash = await create(OWNER, { name: "SHARED_NAME", agent_ids: ["a_open"] });
  assert.equal(clash.statusCode, 409);
  assert.match(clash.json().detail, /SHARED_NAME already exists in this organisation/);
  const other = await create(OWNER, { name: "OTHER_NAME", guild_ids: ["guild_side"] });
  const rename = await call(OWNER, "PATCH", `/api/secrets/${other.json().id}`, { name: "SHARED_NAME" });
  assert.equal(rename.statusCode, 409);
  const elsewhere = await create(
    { ...as("user_secret_member"), "X-Guilds-Org": "org_elsewhere" },
    { name: "SHARED_NAME", org_wide: true },
  );
  assert.equal(elsewhere.statusCode, 201);
});

test("owners and admins write any secret; members write secrets local to their guilds", async () => {
  for (const [who, headers] of [
    ["owner", OWNER],
    ["admin", ADMIN],
  ] as const) {
    const created = await create(headers, { name: `WIDE_${who.toUpperCase()}`, org_wide: true });
    assert.equal(created.statusCode, 201, who);
    const id = created.json().id;
    assert.equal((await call(headers, "PATCH", `/api/secrets/${id}`, { value: "v2" })).statusCode, 200, who);
    const access = await call(headers, "PUT", `/api/secrets/${id}/access`, {
      org_wide: false,
      guild_ids: ["guild_open"],
      agent_ids: [],
    });
    assert.equal(access.statusCode, 200, who);
    assert.equal((await call(headers, "DELETE", `/api/secrets/${id}`)).statusCode, 204, who);
  }

  assert.equal((await create(MEMBER, { name: "MEMBER_WIDE", org_wide: true })).statusCode, 403);
  assert.equal((await create(MEMBER, { name: "MEMBER_UNASSIGNED" })).statusCode, 403);
  assert.equal((await create(MEMBER, { name: "MEMBER_HIDDEN", guild_ids: ["guild_hidden"] })).statusCode, 403);
  assert.equal((await create(MEMBER, { name: "MEMBER_HIDDEN_AGENT", agent_ids: ["a_hidden"] })).statusCode, 403);
  const local = await create(MEMBER, { name: "MEMBER_LOCAL", guild_ids: ["guild_open"], agent_ids: ["a_side"] });
  assert.equal(local.statusCode, 201);
  const localId = local.json().id;
  assert.equal(local.json().can_manage, true);
  assert.deepEqual(local.json().created_by, { kind: "user", id: "user_secret_member", name: "secret-member" });
  assert.equal((await call(MEMBER, "PATCH", `/api/secrets/${localId}`, { description: "rotated" })).statusCode, 200);
  const memberAccess = await call(MEMBER, "PUT", `/api/secrets/${localId}/access`, {
    org_wide: false,
    guild_ids: ["guild_open"],
  });
  assert.equal(memberAccess.statusCode, 403);

  const wide = await create(OWNER, { name: "OWNER_WIDE_FOR_MEMBER", org_wide: true });
  const wideId = wide.json().id;
  const seen = await call(MEMBER, "GET", `/api/secrets/${wideId}`);
  assert.equal(seen.statusCode, 200);
  assert.equal(seen.json().can_manage, false);
  assert.equal((await call(MEMBER, "PATCH", `/api/secrets/${wideId}`, { value: "x" })).statusCode, 403);
  assert.equal((await call(MEMBER, "DELETE", `/api/secrets/${wideId}`)).statusCode, 403);
  const mixed = await create(OWNER, { name: "OWNER_MIXED", guild_ids: ["guild_open", "guild_hidden"] });
  assert.equal((await call(MEMBER, "PATCH", `/api/secrets/${mixed.json().id}`, { value: "x" })).statusCode, 403);
  assert.equal((await call(MEMBER, "DELETE", `/api/secrets/${localId}`)).statusCode, 204);

  const foreign = await create({ ...MEMBER, "X-Guilds-Org": "org_elsewhere" }, { name: "FOREIGN", org_wide: true });
  assert.equal((await call(ADMIN, "GET", `/api/secrets/${foreign.json().id}`)).statusCode, 404);
  assert.equal((await call(ADMIN, "DELETE", `/api/secrets/${foreign.json().id}`)).statusCode, 404);
});

test("a grant in a guild the caller cannot see is masked and kept", async () => {
  const created = await create(OWNER, { name: "MASKED", guild_ids: ["guild_open", "guild_hidden"], agent_ids: ["a_hidden"] });
  const id = created.json().id;
  const owner = (await call(OWNER, "GET", `/api/secrets/${id}`)).json() as Meta;
  assert.deepEqual(
    owner.grants.map((grant) => [grant.kind, grant.id]),
    [
      ["guild", "guild_hidden"],
      ["guild", "guild_open"],
      ["agent", "a_hidden"],
    ],
  );
  const member = (await call(MEMBER, "GET", `/api/secrets/${id}`)).json() as Meta;
  assert.equal(member.name, "MASKED");
  assert.deepEqual(member.grants, [
    { kind: "guild", id: null, name: null },
    { kind: "guild", id: "guild_open", name: "open-desk" },
    { kind: "agent", id: null, name: null },
  ]);
  // The admin cannot see the private guild either: replacing the access keeps what it cannot name.
  const replaced = await call(ADMIN, "PUT", `/api/secrets/${id}/access`, {
    org_wide: false,
    guild_ids: ["guild_side"],
    agent_ids: [],
  });
  assert.equal(replaced.statusCode, 200);
  const after = (await call(OWNER, "GET", `/api/secrets/${id}`)).json() as Meta;
  assert.deepEqual(
    after.grants.map((grant) => grant.id),
    ["guild_hidden", "guild_side", "a_hidden"],
  );
});

test("an agent gets organisation-wide secrets, its guild's grants, and its own", async () => {
  await create(OWNER, { name: "RES_WIDE", org_wide: true });
  await create(OWNER, { name: "RES_TWO_GUILDS", guild_ids: ["guild_open", "guild_side"] });
  await create(OWNER, { name: "RES_AGENT", agent_ids: ["a_open"] });
  await create(OWNER, { name: "RES_UNASSIGNED" });
  const open = await environment("a_open", "guild_open");
  const openTwo = await environment("a_open_two", "guild_open");
  const side = await environment("a_side", "guild_side");
  assert.ok(["RES_WIDE", "RES_TWO_GUILDS", "RES_AGENT"].every((name) => open.includes(name)));
  assert.ok(openTwo.includes("RES_TWO_GUILDS") && !openTwo.includes("RES_AGENT"));
  assert.ok(side.includes("RES_TWO_GUILDS") && side.includes("RES_WIDE") && !side.includes("RES_AGENT"));
  for (const env of [open, openTwo, side]) {
    assert.equal(env.includes("RES_UNASSIGNED"), false);
  }
  const listed = (await call(OWNER, "GET", "/api/secrets?agent_id=a_open")).json().secrets as Meta[];
  assert.deepEqual(listed.map((row) => row.name), open);
  const guildView = (await call(OWNER, "GET", "/api/secrets?guild_id=guild_open")).json().secrets as Meta[];
  assert.ok(guildView.some((row) => row.name === "RES_AGENT"));
  assert.equal(guildView.some((row) => row.name === "RES_UNASSIGNED"), false);
  const all = (await call(MEMBER, "GET", "/api/secrets")).json().secrets as Meta[];
  assert.ok(all.some((row) => row.name === "RES_UNASSIGNED"));
  assert.equal((await call(MEMBER, "GET", "/api/secrets?guild_id=guild_hidden")).statusCode, 404);
  const agent = await call(OWNER, "GET", "/api/agents/a_open");
  assert.deepEqual(
    (agent.json().access.secrets as Array<{ name: string }>).map((row) => row.name),
    open,
  );
  assert.equal("secrets" in (await call(OWNER, "GET", "/api/access")).json(), false);
});

test("access changes replace the set and refresh the agents they reach", async () => {
  const created = await create(OWNER, { name: "ACCESS_FLOW", guild_ids: ["guild_open"] });
  const id = created.json().id;
  assert.deepEqual(accessChanges.at(-1), ["a_open", "a_open_two"]);
  const moved = await call(OWNER, "PUT", `/api/secrets/${id}/access`, {
    org_wide: false,
    guild_ids: [],
    agent_ids: ["a_side", "a_open"],
  });
  assert.equal(moved.statusCode, 200);
  assert.deepEqual(
    (moved.json() as Meta).grants.map((grant) => grant.id),
    ["a_open", "a_side"],
  );
  assert.deepEqual(accessChanges.at(-1), ["a_open_two", "a_side"]);
  const wide = await call(OWNER, "PUT", `/api/secrets/${id}/access`, {
    org_wide: true,
    guild_ids: ["guild_open"],
    agent_ids: ["a_side"],
  });
  assert.equal((wide.json() as Meta).org_wide, true);
  assert.deepEqual((wide.json() as Meta).grants, []);
  const rotated = await call(OWNER, "PATCH", `/api/secrets/${id}`, { value: "fresh" });
  assert.equal(rotated.statusCode, 200);
  assert.equal(valueChanges.at(-1), id);
  const refused = await call(OWNER, "PUT", "/api/bindings", {
    catalog_kind: "secret",
    catalog_id: id,
    scope: "agent",
    scope_id: "a_open",
    enabled: true,
  });
  assert.equal(refused.statusCode, 422);
  const unknown = await call(OWNER, "PUT", `/api/secrets/${id}/access`, { org_wide: false, guild_ids: ["guild_nope"] });
  assert.equal(unknown.statusCode, 422);
});

test("a secret goes with the guild or agent that held its last grant", async () => {
  const now = new Date();
  const config = { model: DEFAULT_MODEL };
  await repo.insertGuild("guild_doomed", "doomed-desk", now, "org_home");
  await repo.insertAgent("a_doomed", "guild_doomed", "doomed", config, now);
  await repo.insertAgent("a_gone", "guild_side", "leaver", config, now);
  const inGuild = (await create(OWNER, { name: "ONLY_DOOMED", guild_ids: ["guild_doomed"], agent_ids: ["a_doomed"] })).json().id;
  const shared = (await create(OWNER, { name: "DOOMED_AND_SIDE", guild_ids: ["guild_doomed", "guild_side"] })).json().id;
  const onlyAgent = (await create(OWNER, { name: "ONLY_LEAVER", agent_ids: ["a_gone"] })).json().id;
  const agentAndGuild = (await create(OWNER, { name: "LEAVER_AND_SIDE", agent_ids: ["a_gone"], guild_ids: ["guild_side"] })).json().id;
  const unassigned = (await create(OWNER, { name: "NEVER_GRANTED" })).json().id;

  await repo.deleteAgent("a_gone");
  assert.equal(await repo.getSecret(onlyAgent), null);
  const kept = await repo.getSecret(agentAndGuild);
  assert.ok(kept);
  assert.deepEqual((kept.grants as Array<{ guild_id: string }>).map((grant) => grant.guild_id), ["guild_side"]);

  await repo.deleteGuild("guild_doomed");
  assert.equal(await repo.getSecret(inGuild), null);
  const survivor = await repo.getSecret(shared);
  assert.ok(survivor);
  assert.deepEqual((survivor.grants as Array<{ guild_id: string }>).map((grant) => grant.guild_id), ["guild_side"]);
  assert.ok(await repo.getSecret(unassigned));
});
