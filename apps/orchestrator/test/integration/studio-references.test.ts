import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ArtifactStore } from "../../src/artifacts/index.js";
import { unreachableMarker } from "../../src/artifacts/embeds.js";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/seed/connect.js";
import { NotesStore } from "../../src/notes/store.js";
import { scriptDatabase, Scripts } from "../../src/scripts/catalog.js";
import { scheduleDatabase, Schedules } from "../../src/schedules/service.js";
import { StudioService } from "../../src/studio/index.js";
import type { GuildReferences } from "../../src/studio/references.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { TEST_MODEL, connectModelProvider } from "../helpers/models.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { insertUser } from "../../src/db/users.js";
import { insertMember } from "../../src/db/orgs.js";

const OWNER = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const JSON_BODY = { "content-type": "application/json" };

const dbName = uniqueDbName("agent_platform_studio_references");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test(
  "studio references draw what each Task embeds or names, as deep as a run inlines it and as its agent reads",
  { timeout: 60_000 },
  async () => {
    process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
    const database = await connect(await createIsolatedDatabase(dbName));
    const notes = new NotesStore(tempDir("guilds-studio-references-notes-"), templatesRoot());
    await notes.ensureSystemPrompt();
    const db = database.pool;
    await connectModelProvider(db, "org_home", "deepinfra");
    const artifacts = new ArtifactStore(database.pool, templatesRoot());
    const scripts = new Scripts(scriptDatabase(db));
    const schedules = new Schedules(scheduleDatabase(db));
    const studio = new StudioService({
      db,
      artifacts,
      scripts,
      schedules,
      notesSystemPath: notes.systemPath(),
    });
    const app = await buildApp(database, { db, notes, artifacts, scripts, schedules, studio });
    const teammate = await insertUser(db, {
        userId: "user_teammate_refs",
        name: "teammate-refs",
        image: null,
        email: "refs@example.com",
      }, new Date());
    await insertMember(db, "org_home", String(teammate.id), "member", new Date());
    const TEAMMATE = { "X-Guilds-User": String(teammate.id), "X-Guilds-Org": "org_home" };

    const call = async (
      method: "GET" | "POST" | "PUT" | "DELETE",
      url: string,
      headers: Record<string, string>,
      payload?: unknown,
    ) => {
      const response = await app.inject({
        method,
        url,
        headers: payload ? { ...headers, ...JSON_BODY } : headers,
        ...(payload ? { payload: payload as Record<string, unknown> } : {}),
      });
      assert.ok(
        response.statusCode < 300,
        `${method} ${url}: ${response.statusCode} ${response.body}`,
      );
      return response.statusCode === 204 ? {} : (response.json() as Record<string, unknown>);
    };
    const write = async (prefix: string, name: string, content: string) =>
      String((await call("PUT", `${prefix}/notes/${name}`, OWNER, { content })).display_path);

    try {
      // A private guild the operator does not operate, with a note.
      const vault = await call("POST", "/api/guilds", TEAMMATE, {
        name: "vault",
        visibility: "private",
      });
      const vaultNote = await call(
        "PUT",
        `/api/guilds/${String(vault.id)}/notes/plans.md`,
        TEAMMATE,
        { content: "kept in the vault" },
      );
      const vaultPath = String(vaultNote.display_path);

      const desk = await call("POST", "/api/guilds", OWNER, { name: "desk" });
      const guild = `/api/guilds/${String(desk.id)}`;
      const agent = async (name: string) =>
        String(
          (
            await call("POST", `${guild}/agents`, OWNER, {
              name,
              config: { model: TEST_MODEL, browser: false },
            })
          ).id,
        );
      const writer = await agent("writer");
      const reviewer = await agent("reviewer");
      const editor = await agent("editor");

      const deep = await write(guild, "deep.md", "Deepest.");
      const glossary = await write("/api/org", "glossary.md", `Terms. ![[${deep}]]`);
      const style = await write(`/api/agents/${writer}`, "style.md", `Style. ![[${glossary}]]`);
      const rules = await write(guild, "rules.md", `Rules. ![[${style}]]`);
      const temp = await write(guild, "temp.md", "Temporary.");
      const checklist = await write(guild, "checklist.md", `Checklist. ![[${temp}]]`);
      const aside = await write(guild, "aside.md", "Read when asked.");
      const lonely = await write(guild, "lonely.md", "Nobody points here.");
      // Only Task text guards a delete, so a note another note embeds can go.
      await call("DELETE", `${guild}/notes/temp.md`, OWNER);
      await call("POST", "/api/collections", OWNER, {
        name: "leads",
        purpose: "Leads to follow up",
      });
      const leads = "org/org_home/collections/leads";

      const task = (id: string, content: string) =>
        call("PUT", `/api/agents/${id}/notes/task.md`, OWNER, { content });
      await task(
        writer,
        `![[${rules}]] ![[${leads}]] ![[notes/plan.md]] ![[${vaultPath}]] See ${aside}.`,
      );
      await task(reviewer, `![[${checklist}]]`);
      await task(editor, `![[${rules}]]`);

      const session = await call("POST", "/api/studio/sessions", OWNER, {
        mode: "optimize",
        source_guild_id: String(desk.id),
        coach_config: { model: TEST_MODEL, temperature: 0.2 },
      });
      const refs = (await call(
        "GET",
        `/api/studio/sessions/${String(session.id)}/references`,
        OWNER,
      )) as unknown as GuildReferences;
      const node = (id: string) => refs.nodes.find((item) => item.id === id);
      const edge = (from: string, to: string) =>
        refs.edges.find((item) => item.from === from && item.to === to);

      // Every broken embed embed-status reports is on the map, met by that agent's run: a link that
      // does not resolve with its reason, or a file that agent cannot read.
      const status = (await call("GET", `${guild}/embed-status`, OWNER)) as {
        agents: Array<{ id: string; broken_embeds: string[] }>;
      };
      const broken = Object.fromEntries(
        status.agents.map((item) => [item.id, [...item.broken_embeds].sort()]),
      );
      assert.deepEqual(broken[writer], ["notes/plan.md", vaultPath].sort());
      assert.deepEqual(broken[reviewer], [temp]);
      assert.deepEqual(broken[editor], [style]);
      for (const item of status.agents) {
        for (const href of item.broken_embeds) {
          const target = node(href);
          assert.ok(target?.reason || target?.unreachable_for.includes(item.id), href);
          assert.notEqual(target?.hops[item.id], undefined, href);
        }
      }
      assert.equal(node("notes/plan.md")?.reason, "not a file path");
      assert.equal(node(temp)?.reason, "not reachable");
      assert.equal(edge(checklist, temp)?.status, "broken");
      // The writer's own note is out of the editor's reach, so the editor's run marks it.
      assert.deepEqual(node(style)?.unreachable_for, [editor]);
      assert.equal(edge(rules, style)?.status, "broken");

      // The private guild's note is never read or listed.
      assert.equal(
        refs.nodes.filter(
          (item) => item.kind !== "unresolved" && item.id.includes(String(vault.id)),
        ).length,
        0,
      );

      // Depth: the Task's embeds and one more hop are inlined, the next stays text, the rest is listed.
      assert.equal(node(rules)?.depth, 1);
      assert.equal(node(style)?.depth, 2);
      assert.equal(node(glossary)?.depth, 3);
      assert.equal(node(deep)?.depth, 4);
      assert.equal(node(lonely)?.depth, null);
      assert.equal(node(style)?.agent_id, writer);
      assert.equal(edge(style, glossary)?.status, "too_deep");
      assert.equal(edge(`org/org_home/agents/${writer}/task.md`, aside)?.status, "named");
      assert.equal(node(leads)?.kind, "table");
      assert.ok(node(leads)?.collection_id);

      // What the map calls inlined is what the effective prompt inlines, as each agent reads.
      const taskContent = async (id: string) => {
        const inspector = await call(
          "GET",
          `/api/studio/sessions/${String(session.id)}/agents/${id}`,
          OWNER,
        );
        return String((inspector.effective_prompt as { task_content: string }).task_content);
      };
      const inlined = await taskContent(writer);
      assert.match(inlined, /Rules\./);
      assert.match(inlined, /Style\./);
      assert.ok(inlined.includes(`![[${glossary}]]`));
      assert.doesNotMatch(inlined, /Terms\./);
      assert.ok(inlined.includes(unreachableMarker(vaultPath)));
      assert.doesNotMatch(inlined, /kept in the vault/);
      const editorInlined = await taskContent(editor);
      assert.match(editorInlined, /Rules\./);
      assert.ok(editorInlined.includes(unreachableMarker(style)));
      assert.doesNotMatch(editorInlined, /Style\./);
      const inlinedBytes = (id: string) => node(`org/org_home/agents/${id}/task.md`)?.inlined_bytes;
      assert.equal(
        inlinedBytes(writer),
        Buffer.byteLength(`Rules. ![[${style}]]`) + Buffer.byteLength(`Style. ![[${glossary}]]`),
      );
      assert.equal(inlinedBytes(editor), Buffer.byteLength(`Rules. ![[${style}]]`));
      assert.equal(refs.budget, 64 * 1024);

      // Another member cannot read the operator's session.
      const foreign = await app.inject({
        method: "GET",
        url: `/api/studio/sessions/${String(session.id)}/references`,
        headers: TEAMMATE,
      });
      assert.equal(foreign.statusCode, 404);
    } finally {
      await app.close();
      await database.close();
    }
  },
);
