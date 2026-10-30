import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { mkdirSync } from "node:fs";
import { createServer } from "../../src/compose.js";
import { installConnectors } from "../../src/connectors/index.js";
import { folderEntry } from "../../src/connectors/registry.js";
import { loadConfig } from "../../src/config/index.js";
import { tempDir, testEnv } from "../helpers/env.js";
import { managers } from "../helpers/opensandbox-sdk-stub.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const OPERATOR = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const coreDb = uniqueDbName("agent_platform_compose_core");
const connectorDb = uniqueDbName("agent_platform_compose_connector");
const saved: Record<string, string | undefined> = {};

before(() => {
  saved.OPENSANDBOX_SDK_MODULE = process.env.OPENSANDBOX_SDK_MODULE;
  process.env.OPENSANDBOX_SDK_MODULE = pathToFileURL(
    path.join(import.meta.dirname, "../helpers/opensandbox-sdk-stub.ts"),
  ).href;
});

after(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  await dropIsolatedDatabase(coreDb);
  await dropIsolatedDatabase(connectorDb);
});

async function createOrg(
  server: Awaited<ReturnType<typeof createServer>>,
  headers: Record<string, string>,
  slug: string,
): Promise<string> {
  const response = await server.app.inject({
    method: "POST",
    url: "/api/orgs",
    headers: { ...headers, "content-type": "application/json" },
    payload: { name: slug, slug },
  });
  assert.equal(response.statusCode, 201, response.body);
  return String(response.json().id);
}

test("core starts alone: one OpenSandbox from its configuration, no cap, nothing hosted", { timeout: 60_000 }, async () => {
  const env = testEnv(await createIsolatedDatabase(coreDb), {
    OPENSANDBOX_URL: "http://core-sandbox:8080",
    ATTACHMENTS_ROOT: tempDir("guilds-compose-attachments-"),
  });
  process.env.SECRETS_MASTER_KEY = env.SECRETS_MASTER_KEY;
  let server = await createServer(loadConfig(env));
  try {
    assert.deepEqual(managers.at(-1), { domain: "core-sandbox:8080", apiKey: "guilds-dev" });

    assert.equal((await server.app.inject({ method: "GET", url: "/health" })).statusCode, 200);
    assert.equal((await server.app.inject({ method: "GET", url: "/api/guilds", headers: OPERATOR })).statusCode, 200);
    for (const url of ["/api/platform/hosts", "/api/orgs/org_home/plan", "/api/admin/users"]) {
      assert.equal((await server.app.inject({ method: "GET", url, headers: OPERATOR })).statusCode, 404, url);
    }

    // What the operator app reads first: how the box identifies a request, then who they are.
    const authConfig = await server.app.inject({ method: "GET", url: "/api/auth/config" });
    assert.deepEqual(authConfig.json(), { mode: "compat-cookie" });
    const me = await server.app.inject({ method: "GET", url: "/api/auth/me", headers: OPERATOR });
    assert.equal(me.statusCode, 200, me.body);
    assert.equal(me.json().id, "user_operator");
    assert.equal(me.json().email, null);
    const users = await server.app.inject({ method: "GET", url: "/api/users" });
    assert.deepEqual(
      users.json().map((user: { id: string }) => user.id),
      ["user_operator"],
      "a fresh box starts with the operator alone",
    );
    assert.equal(me.json().platform_admin, true, "the seed organisation's owner administers the instance");

    const capabilities = await server.app.inject({ method: "GET", url: "/api/builder/capabilities", headers: OPERATOR });
    assert.equal(capabilities.statusCode, 200, capabilities.body);
    assert.equal(capabilities.json().limits.max_agents, null);

    const instance = await server.app.inject({ method: "GET", url: "/api/instance", headers: OPERATOR });
    assert.equal(
      instance.json().integrations.some((item: { id: string }) => item.id === "billing"),
      false,
    );

    const orgId = await createOrg(server, OPERATOR, "core-made");
    const rows = await server.app.inject({ method: "GET", url: "/api/orgs", headers: OPERATOR });
    assert.ok(rows.json().some((org: { id: string }) => org.id === orgId));

    // An attachment is a file on the box: it is still there after the server restarts.
    const uploaded = await server.app.inject({
      method: "POST",
      url: "/api/attachments",
      headers: { ...OPERATOR, "content-type": "application/octet-stream", "x-filename": "shot.png" },
      payload: PNG,
    });
    assert.equal(uploaded.statusCode, 201, uploaded.body);
    await server.close();
    server = await createServer(loadConfig(env));
    const fetched = await server.app.inject({
      method: "GET",
      url: `/api/attachments/${uploaded.json().id}`,
      headers: OPERATOR,
    });
    assert.equal(fetched.statusCode, 200, fetched.body);
    assert.deepEqual(fetched.rawPayload, PNG);
  } finally {
    await server.close();
  }
});

test("an extension's connector is installed with core's and listed like one", { timeout: 60_000 }, async () => {
  const folder = path.join(tempDir("guilds-compose-connector-"), "acme_notes");
  mkdirSync(folder);
  const manifest = {
    slug: "acme_notes",
    display_name: "Acme Notes",
    endpoint: { url: "https://mcp.acme.example/mcp" },
    auth: { kind: "token" },
    description: "Read the operator's Acme notes.",
  };
  const entry = folderEntry(manifest, {}, folder, "acme");
  const env = testEnv(await createIsolatedDatabase(connectorDb), {
    ATTACHMENTS_ROOT: tempDir("guilds-compose-attachments-"),
  });
  process.env.SECRETS_MASTER_KEY = env.SECRETS_MASTER_KEY;
  try {
    const server = await createServer(loadConfig(env), { extensions: [{ name: "acme", connectors: [entry] }] });
    try {
      const listed = await server.app.inject({ method: "GET", url: "/api/mcp/servers", headers: OPERATOR });
      assert.equal(listed.statusCode, 200, listed.body);
      const acme = listed.json().servers.find((item: { id: string }) => item.id === "mcp_acme_notes");
      assert.ok(acme, "the extension's connector is listed");
      assert.deepEqual(
        { slug: acme.slug, config: acme.config, publisher: acme.publisher, source: acme.source, verified: acme.verified },
        { slug: "acme_notes", config: { url: "https://mcp.acme.example/mcp" }, publisher: "acme", source: "core", verified: true },
      );
    } finally {
      await server.close();
    }
    const qonto = folderEntry({ ...manifest, slug: "qonto" }, {}, path.join(path.dirname(folder), "qonto"));
    await assert.rejects(
      () => createServer(loadConfig(env), { extensions: [{ name: "acme", connectors: [qonto] }] }),
      /registered twice/,
    );
  } finally {
    installConnectors([]);
  }
});
