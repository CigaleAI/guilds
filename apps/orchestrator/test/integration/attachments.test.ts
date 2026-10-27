import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AttachmentService } from "../../src/attachments/index.js";
import { MemoryBlobStore } from "../../src/lib/blob-store.js";
import { buildApp } from "../../src/app.js";
import { ArtifactStore } from "../../src/artifacts/index.js";
import { connect } from "../../src/db/client.js";
import { generationDatabase, GenerationLoop } from "../../src/generation/index.js";
import { newId } from "../../src/lib/ids.js";
import { TEST_MODEL, connectModelProvider } from "../helpers/models.js";
import { NotesStore } from "../../src/notes/store.js";
import { scriptDatabase, Scripts } from "../../src/scripts/catalog.js";
import { scheduleDatabase, Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { ExportSandboxes } from "../helpers/live.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { insertOrg } from "../../src/db/orgs.js";
import { attachmentDatabase } from "../../src/attachments/store.js";

const OWNER = {
  "X-Guilds-User": "user_operator",
  "X-Guilds-Org": "org_home",
};

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const dbName = uniqueDbName("agent_platform_attachments");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("operators upload images, attach them to a run, and cannot read another org's file", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const databaseUrl = await createIsolatedDatabase(dbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-attachments-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  await connectModelProvider(db, "org_home", "deepinfra", {
    models: [TEST_MODEL, "deepinfra/Qwen/Qwen3.8-2.4T-A95B"],
  });
  const attachments = new AttachmentService(attachmentDatabase(db), new MemoryBlobStore());
  const artifacts = new ArtifactStore(database.pool, notes.templates);
  const workspaceRoot = tempDir("guilds-attachments-workspaces-");
  const generation = new GenerationLoop(generationDatabase(db), notes, workspaceRoot, new ExportSandboxes(workspaceRoot), {
    attachments,
    artifacts,
  });
  generation.generateInBackground = () => undefined;
  const app = await buildApp(database, {
    db,
    notes,
    artifacts,
    scripts: new Scripts(scriptDatabase(db)),
    schedules: new Schedules(scheduleDatabase(db)),
    attachments,
    generation,
  });

  try {
    const catalog = await app.inject({ method: "GET", url: "/api/orgs/org_home/models", headers: OWNER });
    assert.equal(catalog.statusCode, 200);
    const glm = (catalog.json().models as Array<{ id: string; attachments: boolean }>).find(
      (item) => item.id === TEST_MODEL,
    );
    assert.equal(glm?.attachments, true);

    const rejected = await app.inject({
      method: "POST",
      url: "/api/attachments",
      headers: { ...OWNER, "content-type": "application/octet-stream", "x-filename": "icon.svg" },
      payload: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"),
    });
    assert.equal(rejected.statusCode, 422);

    const uploaded = await app.inject({
      method: "POST",
      url: "/api/attachments",
      headers: { ...OWNER, "content-type": "application/octet-stream", "x-filename": "shot.png" },
      payload: PNG,
    });
    assert.equal(uploaded.statusCode, 201, uploaded.body);
    const row = uploaded.json() as { id: string; filename: string; mime: string; url: string };
    assert.equal(row.filename, "shot.png");
    assert.equal(row.mime, "image/png");
    assert.equal(row.url, `/api/attachments/${row.id}`);

    const fetched = await app.inject({
      method: "GET",
      url: `/api/attachments/${row.id}`,
      headers: OWNER,
    });
    assert.equal(fetched.statusCode, 200);
    assert.equal(fetched.headers["content-type"], "image/png");
    assert.deepEqual(fetched.rawPayload, PNG);

    const otherOrg = String(
      (
        await insertOrg(db, { orgId: newId("org"), name: "Elsewhere", slug: "elsewhere", userId: "user_operator" }, new Date())
      ).id,
    );
    const hidden = await app.inject({
      method: "GET",
      url: `/api/attachments/${row.id}`,
      headers: { "X-Guilds-User": "user_operator", "X-Guilds-Org": otherOrg },
    });
    assert.equal(hidden.statusCode, 404);

    const guild = await app.inject({
      method: "POST",
      url: "/api/guilds",
      headers: { ...OWNER, "content-type": "application/json" },
      payload: { name: "attach-desk" },
    });
    assert.equal(guild.statusCode, 201, guild.body);
    const guildId = String(guild.json().id);
    const agent = await app.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/agents`,
      headers: { ...OWNER, "content-type": "application/json" },
      payload: { name: "looker", config: { model: TEST_MODEL, browser: false } },
    });
    assert.equal(agent.statusCode, 201, agent.body);
    const agentId = String(agent.json().id);

    const refused = await app.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/agents`,
      headers: { ...OWNER, "content-type": "application/json" },
      payload: { name: "text-only", config: { model: "deepinfra/Qwen/Qwen3.8-2.4T-A95B", browser: false } },
    });
    assert.equal(refused.statusCode, 201, refused.body);
    const blocked = await app.inject({
      method: "POST",
      url: `/api/agents/${String(refused.json().id)}/runs`,
      headers: { ...OWNER, "content-type": "application/json" },
      payload: { message: "see this", attachment_ids: [row.id] },
    });
    assert.equal(blocked.statusCode, 422);

    const created = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/runs`,
      headers: { ...OWNER, "content-type": "application/json" },
      payload: { attachment_ids: [row.id] },
    });
    assert.equal(created.statusCode, 202, created.body);
    const runId = String(created.json().id);
    const messages = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}/messages`,
      headers: OWNER,
    });
    assert.equal(messages.statusCode, 200);
    const user = (messages.json() as Array<{ payload: { role: string; content: string }; metadata: { attachments?: unknown } }>).find(
      (item) => item.payload.role === "user",
    );
    assert.equal(user?.payload.content, "");
    assert.deepEqual(user?.metadata.attachments, [
      { id: row.id, filename: "shot.png", mime: "image/png", kind: "image" },
    ]);
  } finally {
    await app.close();
    await database.close();
  }
});
