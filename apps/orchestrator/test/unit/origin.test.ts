import assert from "node:assert/strict";
import { test } from "node:test";
import { requestOrigins } from "../../src/http/origin.js";

test("a request is served for a loopback host or the public host, whatever the port", () => {
  const local = requestOrigins("");
  for (const host of ["localhost", "localhost:8080", "127.0.0.1:5173", "[::1]:8080", "LOCALHOST:80"]) {
    assert.equal(local.hostAllowed(host), true, host);
  }
  for (const host of [undefined, "", "evil.example", "evil.example:8080", "127.0.0.1.evil.example", "192.168.1.20:8080"]) {
    assert.equal(local.hostAllowed(host), false, String(host));
  }
  const hosted = requestOrigins("https://app.guilds.test");
  assert.equal(hosted.hostAllowed("app.guilds.test"), true);
  assert.equal(hosted.hostAllowed("app.guilds.test:443"), true);
  assert.equal(hosted.hostAllowed("127.0.0.1:8080"), true);
  assert.equal(hosted.hostAllowed("other.guilds.test"), false);
});

test("a page drives the server from the host it names, the public origin, or loopback to loopback", () => {
  const local = requestOrigins("");
  assert.equal(local.originAllowed("http://127.0.0.1:8080", "127.0.0.1:8080"), true, "same origin");
  assert.equal(local.originAllowed("http://127.0.0.1:5173", "127.0.0.1:8080"), true, "a dev server proxying");
  assert.equal(local.originAllowed("http://localhost:5173", "127.0.0.1:8080"), true);
  assert.equal(local.originAllowed("https://evil.example", "127.0.0.1:8080"), false);
  assert.equal(local.originAllowed("null", "127.0.0.1:8080"), false);
  assert.equal(local.originAllowed("not a url", "127.0.0.1:8080"), false);
  assert.equal(local.originAllowed("http://127.0.0.1:8080", undefined), false);

  const hosted = requestOrigins("https://app.guilds.test");
  assert.equal(hosted.originAllowed("https://app.guilds.test", "app.guilds.test"), true);
  assert.equal(hosted.originAllowed("https://app.guilds.test", "127.0.0.1:8080"), true, "the public origin, behind a proxy");
  assert.equal(hosted.originAllowed("http://localhost:3000", "app.guilds.test"), false, "loopback page, public host");
  assert.equal(hosted.originAllowed("https://evil.example", "app.guilds.test"), false);
  assert.equal(hosted.originAllowed("http://app.guilds.test.evil.example", "app.guilds.test"), false);
});
