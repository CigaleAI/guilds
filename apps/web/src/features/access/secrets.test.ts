import assert from "node:assert/strict";
import { test } from "node:test";
import type { Secret } from "../../api/types";
import {
  askedRequest,
  availableTo,
  managesSecrets,
  reachLabel,
  requestState,
  secretOrigin,
  visibleAccess,
  whitespaceAroundNote,
  whitespaceInsideNote,
  whitespaceNotes,
  withAgent,
} from "./secrets";

function secret(overrides: Partial<Secret> = {}): Secret {
  return {
    id: "sec_1",
    name: "ACME_KEY",
    description: "Calls Acme",
    org_wide: false,
    grants: [],
    created_by: { kind: "user", id: "user_1", name: "ada" },
    created_at: "2026-09-30T09:00:00+00:00",
    updated_at: "2026-09-30T09:00:00+00:00",
    rotated_at: "2026-09-30T09:00:00+00:00",
    can_manage: true,
    ...overrides,
  };
}

test("available to reads Organisation, Unassigned, each grant, or Private guild", () => {
  assert.deepEqual(availableTo(secret({ org_wide: true })).map(reachLabel), ["Organisation"]);
  assert.deepEqual(availableTo(secret()).map(reachLabel), ["Unassigned"]);
  const granted = secret({
    grants: [
      { kind: "guild", id: "guild_1", name: "desk" },
      { kind: "agent", id: null, name: null },
      { kind: "agent", id: "a_1", name: "scout" },
    ],
  });
  assert.deepEqual(availableTo(granted).map(reachLabel), ["desk", "Private guild", "scout"]);
});

test("the origin names the operator who added it or the agent that stored it", () => {
  assert.equal(secretOrigin(secret()), "Added by ada");
  assert.equal(
    secretOrigin(secret({ created_by: { kind: "agent", id: "a_1", name: "scout" } })),
    "Stored by scout",
  );
  assert.equal(secretOrigin(secret({ created_by: null })), null);
});

test("granting an agent keeps the grants the viewer can name and adds the agent once", () => {
  const granted = secret({
    grants: [
      { kind: "guild", id: "guild_1", name: "desk" },
      { kind: "guild", id: null, name: null },
      { kind: "agent", id: "a_1", name: "scout" },
    ],
  });
  assert.deepEqual(visibleAccess(granted), {
    org_wide: false,
    guild_ids: ["guild_1"],
    agent_ids: ["a_1"],
  });
  assert.deepEqual(withAgent(granted, "a_2"), {
    org_wide: false,
    guild_ids: ["guild_1"],
    agent_ids: ["a_1", "a_2"],
  });
  assert.deepEqual(withAgent(granted, "a_1").agent_ids, ["a_1"]);
});

test("the request card shows missing, elsewhere, or set", () => {
  const acme = secret();
  assert.deepEqual(requestState("ACME_KEY", [], []), { kind: "missing" });
  assert.deepEqual(requestState("ACME_KEY", [acme], []), { kind: "elsewhere", secret: acme });
  assert.deepEqual(requestState("ACME_KEY", [acme], [acme]), { kind: "set" });
});

test("only a result that asked the operator becomes a card", () => {
  const args = JSON.stringify({
    name: "ACME_KEY",
    description: "Calls Acme",
    reason: "Report needs it",
  });
  const asked = `${JSON.stringify({ widget: "secret_request", name: "ACME_KEY", status: "asked" })}\nThe operator has been asked.`;
  assert.deepEqual(askedRequest(args, asked), {
    name: "ACME_KEY",
    description: "Calls Acme",
    reason: "Report needs it",
  });
  assert.equal(askedRequest(args, '{"status":"available"}'), null);
  assert.equal(askedRequest(args, "ERROR: reason must contain non-whitespace text"), null);
  assert.equal(askedRequest(args, undefined), null);
});

test("owners and admins manage secrets; members do not", () => {
  assert.equal(managesSecrets("owner"), true);
  assert.equal(managesSecrets("admin"), true);
  assert.equal(managesSecrets("member"), false);
});

test("a value without whitespace gets no note", () => {
  assert.deepEqual(whitespaceNotes("sk-ant-oat01-abc"), []);
  assert.deepEqual(whitespaceNotes(""), []);
});

test("whitespace around a value gets the note that saving removes it", () => {
  assert.deepEqual(whitespaceNotes("sk-live-123  "), [whitespaceAroundNote]);
  assert.deepEqual(whitespaceNotes("\tsk-live-123"), [whitespaceAroundNote]);
  assert.deepEqual(whitespaceNotes("   "), [whitespaceAroundNote]);
});

test("whitespace inside a value gets the note that it is kept", () => {
  assert.deepEqual(whitespaceNotes("correct horse battery"), [whitespaceInsideNote]);
  assert.deepEqual(whitespaceNotes(" correct horse "), [
    whitespaceAroundNote,
    whitespaceInsideNote,
  ]);
});
