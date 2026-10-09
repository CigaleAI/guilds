import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import Fastify from "fastify";
import { registerWebApp } from "../../src/http/web-app.js";

const dist = mkdtempSync(path.join(tmpdir(), "web-dist-"));
mkdirSync(path.join(dist, "assets"));
mkdirSync(path.join(dist, "storybook"));
writeFileSync(path.join(dist, "index.html"), "<!doctype html><div id=root></div>");
writeFileSync(path.join(dist, "assets", "app-3f2a.js"), "export {};");
writeFileSync(path.join(dist, "storybook", "index.html"), "<!doctype html><title>Storybook</title>");
writeFileSync(path.join(dist, "storybook", "iframe.html"), "<!doctype html><title>iframe</title>");

after(() => rmSync(dist, { recursive: true, force: true }));

async function appWith(distDir: string) {
  const app = Fastify();
  await registerWebApp(app, distDir);
  app.get("/api/ping", async () => ({ ok: true }));
  return app;
}

const html = { accept: "text/html,application/xhtml+xml" };

test("serves the app shell for app pages and hashed assets as immutable", async () => {
  const app = await appWith(dist);
  try {
    for (const url of ["/", "/guilds/g_01", "/guilds/g_01?seq=4", "/login", "/invite/tok_1"]) {
      const page = await app.inject({ method: "GET", url, headers: html });
      assert.equal(page.statusCode, 200, url);
      assert.match(page.headers["content-type"] ?? "", /text\/html/);
      assert.equal(page.headers["cache-control"], "no-cache, no-store, must-revalidate");
      assert.match(page.body, /id=root/);
    }
    const asset = await app.inject({ method: "GET", url: "/assets/app-3f2a.js" });
    assert.equal(asset.statusCode, 200);
    assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable");
  } finally {
    await app.close();
  }
});

test("missing assets, API paths and non-page requests stay JSON 404s", async () => {
  const app = await appWith(dist);
  try {
    for (const [url, headers] of [
      ["/assets/gone.js", html],
      ["/api/nothing", html],
      ["/guilds/g_01", { accept: "application/json" }],
    ] as const) {
      const response = await app.inject({ method: "GET", url, headers });
      assert.equal(response.statusCode, 404, url);
      assert.deepEqual(response.json(), { detail: "Not Found" });
    }
    const post = await app.inject({ method: "POST", url: "/guilds", headers: html });
    assert.equal(post.statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/api/ping" })).statusCode, 200);
  } finally {
    await app.close();
  }
});

test("serves the Storybook build at /storybook and does not fall back to the app", async () => {
  const app = await appWith(dist);
  try {
    for (const url of ["/storybook", "/storybook/"]) {
      const page = await app.inject({ method: "GET", url, headers: html });
      assert.equal(page.statusCode, 200, url);
      assert.match(page.headers["content-type"] ?? "", /text\/html/);
      assert.match(page.body, /Storybook/);
      assert.doesNotMatch(page.body, /id=root/);
    }
    const iframe = await app.inject({ method: "GET", url: "/storybook/iframe.html" });
    assert.equal(iframe.statusCode, 200);
    assert.match(iframe.body, /iframe/);
    const missing = await app.inject({
      method: "GET",
      url: "/storybook/gone.js",
      headers: html,
    });
    assert.equal(missing.statusCode, 404);
    assert.deepEqual(missing.json(), { detail: "Not Found" });
  } finally {
    await app.close();
  }
});

test("without a build, app pages are 404s", async () => {
  const app = await appWith(path.join(dist, "absent"));
  try {
    const response = await app.inject({ method: "GET", url: "/guilds/g_01", headers: html });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { detail: "Not Found" });
  } finally {
    await app.close();
  }
});
