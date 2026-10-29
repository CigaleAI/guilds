import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/seed/connect.js";
import { addTestAgent } from "../helpers/agents.js";
import { insertGuild } from "../../src/db/guilds.js";
import { insertIssue } from "../../src/db/issues.js";
import { insertMember } from "../../src/db/orgs.js";
import { insertRun } from "../../src/db/runs.js";
import { insertUser } from "../../src/db/users.js";
import { NotesStore } from "../../src/notes/store.js";
import { StudioError } from "../../src/studio/errors.js";
import { readGuildRun } from "../../src/studio/inspector.js";
import { usageForOrg, usageForPlatform } from "../../src/usage/view.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { agentConfig, runSnapshot } from "../helpers/generation.js";

const OWNER = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const JSON_OWNER = { ...OWNER, "content-type": "application/json" };

const dbName = uniqueDbName("agent_platform_agent_items");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test(
  "an operator's scripts, routines, issues, runs, notes, tables, bindings, machines and repositories answer for what is there and what is not",
  { timeout: 60_000 },
  async () => {
    process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
    const database = await connect(await createIsolatedDatabase(dbName));
    const notes = new NotesStore(tempDir("guilds-agent-items-"), templatesRoot());
    await notes.ensureSystemPrompt();
    const db = database.pool;
    const app = await buildApp(database, {
      db,
      notes,
      scripts: agentScripts(db),
      schedules: agentSchedules(db),
    });
    await insertGuild(
      db,
      { guildId: "guild_items", name: "items-desk", orgId: "org_home" },
      new Date(),
    );
    await addTestAgent(
      db,
      "org_home",
      { agentId: "a_items", guildId: "guild_items", name: "keeper", config: agentConfig({}) },
      new Date(),
    );
    const agent = "/api/agents/a_items";
    const guild = "/api/guilds/guild_items";

    try {
      const script = { name: "tally", description: "Counts.", source: "print(1)\n" };
      for (const name of ["tally", "sum"]) {
        const created = await app.inject({
          method: "POST",
          url: `${agent}/scripts`,
          headers: JSON_OWNER,
          payload: { ...script, name },
        });
        assert.equal(created.statusCode, 201, created.body);
      }
      const sourceless = await app.inject({
        method: "POST",
        url: `${agent}/scripts`,
        headers: JSON_OWNER,
        payload: { ...script, name: "lines", source: ["print(1)"] },
      });
      assert.equal(sourceless.statusCode, 422);
      assert.deepEqual(sourceless.json().detail[0].loc, ["body", "source"]);
      const listed = await app.inject({ method: "GET", url: `${agent}/scripts`, headers: OWNER });
      assert.deepEqual(
        listed
          .json()
          .map((row: { name: string; display_path: string }) => [
            row.name,
            row.display_path.endsWith(`/scripts/${row.name}`),
          ]),
        [
          ["sum", true],
          ["tally", true],
        ],
      );
      assert.equal(
        (await app.inject({ method: "DELETE", url: `${agent}/scripts/tally`, headers: OWNER }))
          .statusCode,
        204,
      );
      assert.equal(
        (await app.inject({ method: "GET", url: `${agent}/scripts/tally`, headers: OWNER }))
          .statusCode,
        404,
      );
      assert.equal(
        (await app.inject({ method: "DELETE", url: `${agent}/scripts/tally`, headers: OWNER }))
          .statusCode,
        404,
      );
      assert.equal(
        (await app.inject({ method: "DELETE", url: `${agent}/scripts`, headers: OWNER }))
          .statusCode,
        204,
      );
      assert.deepEqual(
        (await app.inject({ method: "GET", url: `${agent}/scripts`, headers: OWNER })).json(),
        [],
      );

      const patched = await app.inject({
        method: "PATCH",
        url: `${agent}/schedules/sch_missing`,
        headers: JSON_OWNER,
        payload: { paused: true },
      });
      assert.equal(patched.statusCode, 404);
      assert.equal(
        (
          await app.inject({
            method: "DELETE",
            url: `${agent}/schedules/sch_missing`,
            headers: OWNER,
          })
        ).statusCode,
        404,
      );

      assert.equal(
        (await app.inject({ method: "GET", url: `${guild}/issues?status=closed`, headers: OWNER }))
          .statusCode,
        422,
      );
      assert.deepEqual(
        (
          await app.inject({ method: "POST", url: `${guild}/issues/resolve`, headers: OWNER })
        ).json(),
        { resolved: 0 },
      );
      const issue = await insertIssue(
        db,
        {
          issueId: "iss_items",
          guildId: "guild_items",
          orgId: "org_home",
          agentId: "a_items",
          agentName: "keeper",
          runId: null,
          kind: "other",
          severity: "low",
          summary: "Odd.",
          detail: "",
          toolName: null,
        },
        new Date(),
      );
      const unsaid = await app.inject({
        method: "PATCH",
        url: `${guild}/issues/${issue.id}`,
        headers: JSON_OWNER,
        payload: {},
      });
      assert.equal(unsaid.statusCode, 422);
      assert.deepEqual(unsaid.json().detail[0].loc, ["body", "status"]);
      const numbered = await app.inject({
        method: "PATCH",
        url: `${guild}/issues/${issue.id}`,
        headers: JSON_OWNER,
        payload: { status: 1 },
      });
      assert.equal(numbered.statusCode, 422);
      const twice = await app.inject({
        method: "GET",
        url: `${guild}/issues?status=open&status=resolved`,
        headers: OWNER,
      });
      assert.equal(twice.statusCode, 422);
      const missing = await app.inject({
        method: "PATCH",
        url: `${guild}/issues/iss_missing`,
        headers: JSON_OWNER,
        payload: { status: "resolved" },
      });
      assert.equal(missing.statusCode, 404);
      const resolved = await app.inject({
        method: "PATCH",
        url: `${guild}/issues/${issue.id}`,
        headers: JSON_OWNER,
        payload: { status: "resolved" },
      });
      assert.equal(resolved.statusCode, 200, resolved.body);
      assert.equal(resolved.json().status, "resolved");

      const runs = `${agent}/runs`;
      const start = (payload: object) =>
        app.inject({ method: "POST", url: runs, headers: JSON_OWNER, payload });
      assert.equal((await start({ message: "  " })).statusCode, 422, "an empty message");
      assert.equal(
        (await start({ attachment_ids: "att_1" })).statusCode,
        422,
        "ids that are not a list",
      );
      assert.equal((await start({ attachment_ids: [" "] })).statusCode, 422, "a blank id");
      const numberedMessage = await start({ message: 7 });
      assert.equal(numberedMessage.statusCode, 422, "a message that is not text");
      assert.deepEqual(numberedMessage.json().detail[0].loc, ["body", "message"]);
      const images = await start({ attachment_ids: ["att_1"] });
      assert.equal(images.statusCode, 503, "a box without an image store takes no images");
      assert.match(String(images.json().detail), /attachments/);
      const queued = await start({ message: "hello" });
      assert.equal(queued.statusCode, 503, "a box without a generation loop opens no run");
      assert.match(String(queued.json().detail), /generation/);

      await insertRun(
        db,
        {
          runId: "run_items",
          agentId: "a_items",
          kind: "direct",
          configSnapshot: runSnapshot(),
          systemContent: "",
          taskContent: "",
          opening: [],
          systemPromptHash: "",
          taskPromptHash: "",
          memoryPromptHash: "",
        },
        new Date(),
      );
      const say = (payload: object) =>
        app.inject({
          method: "POST",
          url: "/api/runs/run_items/messages",
          headers: JSON_OWNER,
          payload,
        });
      const contentless = await say({});
      assert.equal(contentless.statusCode, 422, "a message needs content or images");
      assert.equal(contentless.json().detail, "content must not be empty");
      const listedContent = await say({ content: ["more"] });
      assert.equal(listedContent.statusCode, 422, "content that is not text");
      assert.deepEqual(listedContent.json().detail[0].loc, ["body", "content"]);
      assert.equal((await say({ content: " " })).statusCode, 422, "blank content");
      assert.equal((await say({ content: "more" })).statusCode, 503);
      const messages = await app.inject({
        method: "GET",
        url: "/api/runs/run_items/messages",
        headers: OWNER,
      });
      assert.equal(messages.statusCode, 200, messages.body);
      const usage = await app.inject({ method: "GET", url: `${guild}/usage`, headers: OWNER });
      assert.equal(usage.statusCode, 200, usage.body);
      assert.deepEqual(
        [usage.json().name, usage.json().agents.map((row: { name: string }) => row.name)],
        ["items-desk", ["keeper"]],
      );
      const image = await app.inject({
        method: "GET",
        url: "/api/attachments/att_1",
        headers: OWNER,
      });
      assert.equal(image.statusCode, 503, "a box without an image store serves none");
      const whole = await usageForOrg({ db }, { id: "org_home", name: "Home", slug: "home" }, null);
      assert.ok(
        Array.isArray(whole.guilds),
        "an organisation's usage lists every guild for the instance admin",
      );
      assert.ok(Array.isArray((await usageForPlatform({ db })).organisations));

      const repos = `${guild}/repositories`;
      const repo = { name: "docs", url: "https://git.example.com/docs.git" };
      const addRepo = () =>
        app.inject({ method: "POST", url: repos, headers: JSON_OWNER, payload: repo });
      assert.equal((await addRepo()).statusCode, 201);
      assert.equal((await addRepo()).statusCode, 409, "a guild names each repository once");
      assert.equal(
        (await app.inject({ method: "DELETE", url: `${repos}/repo_missing`, headers: OWNER }))
          .statusCode,
        404,
      );
      const check = await app.inject({
        method: "POST",
        url: `${agent}/harness/check`,
        headers: JSON_OWNER,
        payload: { harness: "abacus" },
      });
      assert.equal(check.statusCode, 422);
      assert.deepEqual(
        (
          await app.inject({ method: "GET", url: "/api/runs/run_items/changes", headers: OWNER })
        ).json(),
        {
          repositories: [],
        },
      );
      const unchanged = await app.inject({
        method: "GET",
        url: "/api/runs/run_items/changes/docs/diff",
        headers: OWNER,
      });
      assert.equal(unchanged.statusCode, 404, "a run that changed nothing has no diff");

      const member = await insertUser(
        db,
        { userId: "user_items_member", name: "items-member" },
        new Date(),
      );
      await insertMember(
        db,
        { org_id: "org_home", user_id: member.id, role: "member" },
        new Date(),
      );
      const MEMBER = {
        "X-Guilds-User": member.id,
        "X-Guilds-Org": "org_home",
        "content-type": "application/json",
      };
      const machines = "/api/orgs/org_home/machines";
      assert.equal(
        (await app.inject({ method: "GET", url: machines, headers: MEMBER })).statusCode,
        200,
      );
      const byMember = await app.inject({
        method: "POST",
        url: machines,
        headers: MEMBER,
        payload: { name: "spare" },
      });
      assert.equal(byMember.statusCode, 403, "a member does not manage machines");
      const orphans = await app.inject({
        method: "GET",
        url: "/api/studio/orphan-drafts",
        headers: MEMBER,
      });
      assert.equal(orphans.statusCode, 403, "only an owner or admin sees drafts nobody holds");
      const inspector = { db, schedules: agentSchedules(db), generation: null };
      const read = await readGuildRun(inspector, "guild_items", "run_items");
      assert.deepEqual(
        [read.run, read.messages].map((part) => typeof part),
        ["object", "object"],
      );
      const strangers: Array<[string, string]> = [
        ["guild_elsewhere", "run_items"],
        ["guild_items", "run_missing"],
      ];
      for (const [guildId, runId] of strangers) {
        await assert.rejects(readGuildRun(inspector, guildId, runId), (error: unknown) => {
          assert.ok(error instanceof StudioError);
          assert.equal(error.status, 404);
          return true;
        });
      }
      const unknownMachine = await app.inject({
        method: "PATCH",
        url: `${machines}/mach_missing`,
        headers: JSON_OWNER,
        payload: { name: "renamed" },
      });
      assert.equal(unknownMachine.statusCode, 404);
      assert.equal(
        (await app.inject({ method: "DELETE", url: `${machines}/mach_missing`, headers: OWNER }))
          .statusCode,
        404,
      );

      const bind = (payload: object) =>
        app.inject({ method: "PUT", url: "/api/bindings", headers: JSON_OWNER, payload });
      const tool = { catalog_kind: "native_tool", catalog_id: "script_list", enabled: false };
      const platform = await bind({ ...tool, scope: "platform" });
      assert.equal(platform.statusCode, 400, platform.body);
      assert.equal((await bind({ ...tool, scope: "galaxy", scope_id: "x" })).statusCode, 422);
      const mistyped = await bind({ ...tool, enabled: "no", scope: "agent", scope_id: "a_items" });
      assert.equal(mistyped.statusCode, 422);
      assert.deepEqual(mistyped.json().detail[0].loc, ["body", "enabled"]);
      const bound = await bind({ ...tool, scope: "agent", scope_id: "a_items" });
      assert.equal(bound.statusCode, 200, bound.body);
      assert.equal(bound.json().enabled, false);
      const unbind = (query: string) =>
        app.inject({
          method: "DELETE",
          url: `/api/bindings?catalog_kind=native_tool&catalog_id=script_list&${query}`,
          headers: OWNER,
        });
      const unscoped = await unbind("scope_id=a_items");
      assert.equal(unscoped.statusCode, 422);
      assert.deepEqual(unscoped.json().detail[0], {
        type: "missing",
        loc: ["querystring", "scope"],
        msg: "Field required",
        input: { catalog_kind: "native_tool", catalog_id: "script_list", scope_id: "a_items" },
      });
      assert.equal((await unbind("scope=agent&scope_id=a_items")).statusCode, 204);
      assert.equal(
        (await unbind("scope=agent&scope_id=a_items")).statusCode,
        404,
        "a binding goes once",
      );

      const table = await app.inject({
        method: "POST",
        url: "/api/collections",
        headers: JSON_OWNER,
        payload: {
          name: "leads",
          purpose: "people to call",
          columns: [{ name: "who", type: "text", description: "their name", required: true }],
        },
      });
      assert.equal(table.statusCode, 201, table.body);
      const records = `/api/collections/${String(table.json().id)}/records`;
      const added = await app.inject({
        method: "POST",
        url: records,
        headers: JSON_OWNER,
        payload: { body: { who: "Ada" } },
      });
      assert.equal(added.statusCode, 201, added.body);
      const recordId = String(added.json().record.id);
      const changed = await app.inject({
        method: "PATCH",
        url: `${records}/${recordId}`,
        headers: JSON_OWNER,
        payload: { body: { who: "Grace" } },
      });
      assert.equal(changed.json().record.who, "Grace", changed.body);
      assert.equal(
        (await app.inject({ method: "GET", url: `${records}/${recordId}`, headers: OWNER })).json()
          .who,
        "Grace",
      );
      assert.equal(
        (await app.inject({ method: "GET", url: records, headers: OWNER })).json().total,
        1,
      );
      const exported = await app.inject({
        method: "GET",
        url: `/api/collections/${String(table.json().id)}/export`,
        headers: OWNER,
      });
      assert.match(String(exported.headers["content-disposition"]), /leads\.jsonl/);
      assert.equal(
        (await app.inject({ method: "DELETE", url: `${records}/${recordId}`, headers: OWNER }))
          .statusCode,
        204,
      );
      assert.equal(
        (await app.inject({ method: "DELETE", url: records, headers: OWNER })).statusCode,
        204,
      );
      assert.equal(
        (await app.inject({ method: "GET", url: `${guild}/reach`, headers: OWNER })).statusCode,
        200,
      );
      assert.equal(
        (await app.inject({ method: "GET", url: `${agent}/reach`, headers: OWNER })).statusCode,
        200,
      );

      const get = (url: string) => app.inject({ method: "GET", url, headers: OWNER });
      const put = (url: string, payload: object) =>
        app.inject({ method: "PUT", url, headers: JSON_OWNER, payload });
      const remove = (url: string) => app.inject({ method: "DELETE", url, headers: OWNER });
      const brief = "/api/org/notes/brief.md";
      const written = await put(brief, { content: "# Brief\n" });
      assert.equal(written.statusCode, 200, written.body);
      const displayPath = String(written.json().display_path);
      assert.equal((await get(brief)).json().content, "# Brief\n");
      assert.deepEqual(
        (await get("/api/org/notes")).json().map((row: { path: string }) => row.path),
        ["brief.md"],
      );
      const embeddable = await get(
        `/api/org/embeddable-notes?display_path=${encodeURIComponent(displayPath)}`,
      );
      assert.equal(embeddable.json().content, "# Brief\n");
      assert.equal(
        (await get("/api/org/embeddable-notes?display_path=org%2Fmissing")).statusCode,
        404,
      );
      assert.equal((await get("/api/file-changes")).statusCode, 422, "a change log names its path");
      const changes = await get(
        `/api/file-changes?display_path=${encodeURIComponent(displayPath)}`,
      );
      assert.equal(changes.json().length, 1);
      assert.equal((await remove(brief)).statusCode, 204);
      assert.equal((await get(brief)).statusCode, 404);

      const log = `${agent}/notes/log.md`;
      const stale = await put(log, { content: "day one\n", expected_version: "first" });
      assert.equal(stale.statusCode, 422, "an expected version is a number");
      assert.equal((await put(log, { content: "day one\n" })).statusCode, 200);
      assert.equal((await remove(log)).statusCode, 204);
      assert.equal((await get(`${agent}/memory`)).statusCode, 200);
    } finally {
      await app.close();
      await database.close();
    }
  },
);
