import assert from "node:assert/strict";
import { after, test } from "node:test";
import { artifactStore } from "../../src/artifacts/store.js";
import { buildApp } from "../../src/app.js";
import { hiddenGuildsFor } from "../../src/db/guilds.js";
import { insertMember } from "../../src/db/orgs.js";
import { getStudioSession } from "../../src/db/studio.js";
import { getUser, insertUser, type UserRow } from "../../src/db/users.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { connect } from "../../src/seed/connect.js";
import { studioFindArtifacts, studioGetArtifact, studioListFileChanges } from "../../src/studio/file-tools.js";
import { resolveStudioFocus } from "../../src/studio/focus.js";
import { StudioService } from "../../src/studio/index.js";
import type { GuildReferences } from "../../src/studio/references.js";
import type { StudioToolCall, StudioToolDeps } from "../../src/studio/tools.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { TEST_MODEL, connectModelProvider } from "../helpers/models.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const OWNER = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const JSON_BODY = { "content-type": "application/json" };

const dbName = uniqueDbName("agent_platform_studio_home_guild");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test(
  "studio leaves out of every list, read, and pin a note homed in a private guild the session's user does not operate",
  { timeout: 60_000 },
  async () => {
    process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
    const database = await connect(await createIsolatedDatabase(dbName));
    const notes = new NotesStore(tempDir("guilds-studio-home-guild-notes-"), templatesRoot());
    await notes.ensureSystemPrompt();
    const db = database.pool;
    await connectModelProvider(db, "org_home", "deepinfra");
    const artifacts = artifactStore(db, templatesRoot());
    const scripts = agentScripts(db);
    const schedules = agentSchedules(db);
    const studio = new StudioService({ db, artifacts, scripts, schedules, notesSystemPath: notes.systemPath() });
    const app = await buildApp(database, { db, notes, artifacts, scripts, schedules, studio });
    const insider = await insertUser(
      db,
      { userId: "user_vault_keeper", name: "keeper", image: null, email: "keeper@example.com" },
      new Date(),
    );
    await insertMember(db, { org_id: "org_home", user_id: insider.id, role: "member" }, new Date());
    const INSIDER = { "X-Guilds-User": insider.id, "X-Guilds-Org": "org_home" };

    const call = async (method: "GET" | "POST" | "PUT", url: string, headers: Record<string, string>, payload?: object) => {
      const response = await app.inject({
        method,
        url,
        headers: payload ? { ...headers, ...JSON_BODY } : headers,
        ...(payload ? { payload: { ...payload } } : {}),
      });
      assert.ok(response.statusCode < 300, `${method} ${url}: ${response.statusCode} ${response.body}`);
      return response.json() as Record<string, unknown>;
    };

    try {
      // A private guild only the insider operates, and a note homed there that an organisation row reaches.
      const vault = await call("POST", "/api/guilds", INSIDER, { name: "vault", visibility: "private" });
      const homed = await call("PUT", "/api/org/notes/vault-plan.md", INSIDER, {
        content: "kept in the vault",
        home_guild_id: String(vault.id),
        access: { type: "org", id: "org_home", mode: "read" },
      });
      const homedPath = String(homed.display_path);

      // An open guild both operators see, each with a Studio session on it.
      const desk = await call("POST", "/api/guilds", OWNER, { name: "desk" });
      await call("POST", `/api/guilds/${String(desk.id)}/agents`, OWNER, {
        name: "writer",
        config: { model: TEST_MODEL, browser: false },
      });
      const session = async (headers: Record<string, string>) =>
        String(
          (
            await call("POST", "/api/studio/sessions", headers, {
              mode: "optimize",
              source_guild_id: String(desk.id),
              coach_config: { model: TEST_MODEL, temperature: 0.2 },
            })
          ).id,
        );
      const toolDeps: StudioToolDeps = {
        artifacts,
        db,
        schedules,
        drafts: studio.drafts,
        preview: studio.previewDeps(),
        notesSystemPath: notes.systemPath(),
      };
      const succeeds = (pending: Promise<unknown>) => pending.then(() => true, () => false);

      /** What one operator's Studio session on the desk shows of the homed note. */
      const seen = async (headers: Record<string, string>, user: UserRow, sessionId: string) => {
        const state = (await call("GET", `/api/studio/sessions/${sessionId}/state`, headers)) as {
          items: Array<{ display_path: string }>;
        };
        const refs = (await call("GET", `/api/studio/sessions/${sessionId}/references`, headers)) as unknown as GuildReferences;
        const operator = {
          orgId: "org_home",
          sourceGuildId: String(desk.id),
          user,
          hidden: await hiddenGuildsFor(db, "org_home", user.id),
        };
        const toolCall: StudioToolCall = { ...operator, session: (await getStudioSession(db, sessionId))!, generation: 1 };
        const found = (await studioFindArtifacts.handler(toolDeps, toolCall, { query: "vault" })) as {
          artifacts: Array<{ display_path: string }>;
        };
        const changes = (await studioListFileChanges.handler(toolDeps, toolCall, { display_path: homedPath })) as {
          changes: unknown[];
        };
        return {
          state: state.items.some((item) => item.display_path === homedPath),
          references: refs.nodes.some((node) => node.id === homedPath && node.kind === "note"),
          found: found.artifacts.some((item) => item.display_path === homedPath),
          read: await succeeds(studioGetArtifact.handler(toolDeps, toolCall, { display_path: homedPath })),
          changes: changes.changes.length > 0,
          pinned: await succeeds(
            resolveStudioFocus({ db, artifacts, ...operator }, { kind: "file", display_path: homedPath }),
          ),
        };
      };

      const owner = await getUser(db, "user_operator");
      assert.ok(owner);
      const ownerSession = await session(OWNER);
      assert.deepEqual(await seen(OWNER, owner, ownerSession), {
        state: false,
        references: false,
        found: false,
        read: false,
        changes: false,
        pinned: false,
      });
      // A message pinning the note is refused before the coach runs.
      const pinnedOnMessage = await app.inject({
        method: "POST",
        url: `/api/studio/sessions/${ownerSession}/messages`,
        headers: { ...OWNER, ...JSON_BODY },
        payload: { content: "What does this note hold?", focus: { kind: "file", display_path: homedPath } },
      });
      assert.equal(pinnedOnMessage.statusCode, 422, pinnedOnMessage.body);

      assert.deepEqual(await seen(INSIDER, insider, await session(INSIDER)), {
        state: true,
        references: true,
        found: true,
        read: true,
        changes: true,
        pinned: true,
      });
    } finally {
      await app.close();
      await database.close();
    }
  },
);
