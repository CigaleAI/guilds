import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { IdentityError, loadIdentity } from "./identity";

const realFetch = globalThis.fetch;

/** Answers each API path with its JSON; any other path is a 404. */
function serve(replies: Record<string, object>): void {
  globalThis.fetch = async (input) => {
    const reply = replies[String(input)];
    return reply === undefined ? new Response("", { status: 404 }) : Response.json(reply);
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const user = {
  id: "u1",
  name: "Ada",
  email: null,
  image: null,
  timezone: null,
  color: null,
  created_at: "2026-01-01T00:00:00Z",
};

test("loadIdentity fails with an IdentityError when no user exists yet", async () => {
  serve({ "/api/auth/config": { mode: "compat-cookie" }, "/api/users": [] });
  await assert.rejects(loadIdentity(), IdentityError);
});

test("loadIdentity fails with an IdentityError when the operator belongs to no organisation", async () => {
  serve({ "/api/auth/config": { mode: "session" }, "/api/auth/me": user, "/api/orgs": [] });
  await assert.rejects(loadIdentity(), (error) => {
    assert.ok(error instanceof IdentityError);
    assert.equal(error.message, "This account does not belong to an organisation yet.");
    return true;
  });
});
