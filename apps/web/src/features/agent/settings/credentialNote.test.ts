import assert from "node:assert/strict";
import { test } from "node:test";
import type { HarnessCredential } from "../../../api/types";
import { harnessCredentialNote, type CredentialCheck, type NotePart } from "./credentialNote";

const now = new Date("2026-05-01T12:00:00Z");

const claude: HarnessCredential = {
  harness: "claude-code",
  label: "Claude Code",
  secret: "CLAUDE_CODE_OAUTH_TOKEN",
  secret_source: "CLAUDE_CODE_OAUTH_TOKEN",
  secret_granted: false,
  secret_shadowed: false,
  login: null,
  login_seen_at: null,
  login_account: null,
};

const cursor: HarnessCredential = {
  harness: "cursor",
  label: "Cursor",
  secret: null,
  secret_source: null,
  secret_granted: false,
  secret_shadowed: false,
  login: null,
  login_seen_at: null,
  login_account: null,
};

function check(entry: Partial<HarnessCredential>, patch: Partial<CredentialCheck> = {}) {
  const credential = { ...claude, ...entry };
  return {
    credentials: [credential],
    error: null,
    harness: credential.harness,
    cli: false,
    ...patch,
  };
}

/** The note as a reader sees it: code as its text, a tab link as the tab's name in brackets. */
function read(check: CredentialCheck): string | null {
  const note = harnessCredentialNote(check, now);
  return note ? note.parts.map(readPart).join("") : null;
}

function readPart(part: NotePart): string {
  if (typeof part === "string") return part;
  return "code" in part ? part.code : `[${part.tab}]`;
}

test("says why the credentials could not be checked, muted", () => {
  const note = harnessCredentialNote(check({}, { error: "Network down" }), now);
  assert.deepEqual(note, { muted: true, parts: ["Couldn't check its credentials: Network down"] });
});

test("says nothing while the credentials load", () => {
  assert.equal(read(check({}, { credentials: undefined })), null);
});

test("says nothing for a harness the credentials do not list", () => {
  assert.equal(read(check({}, { harness: "codex" })), null);
});

test("names the granted secret the harness runs on", () => {
  const note = harnessCredentialNote(check({ secret_granted: true }), now);
  assert.equal(note?.muted, false);
  assert.equal(
    read(check({ secret_granted: true })),
    "Runs on the secret CLAUDE_CODE_OAUTH_TOKEN.",
  );
  assert.equal(
    read(check({ secret_granted: true, secret_source: "BOB_TOKEN" })),
    "Runs on the secret BOB_TOKEN as CLAUDE_CODE_OAUTH_TOKEN.",
  );
});

test("says a harness without a secret needs the CLI on to log in", () => {
  assert.equal(
    read(check(cursor)),
    "Cursor runs only on a login, and logging in needs the CLI: turn on CLI, then log in from its tab.",
  );
});

test("offers to pick a token or turn on the CLI when the harness has no credential", () => {
  assert.equal(
    read(check({})),
    "Claude Code has no credential yet. To set one up, choose a subscription token above, or turn on CLI, then log in from its tab.",
  );
});

test("says to save with the CLI on before the CLI tab offers a login", () => {
  assert.equal(
    read(check(cursor, { cli: true })),
    "Cursor has no credential yet. To set one up, save with CLI on, then log in from its tab.",
  );
});

test("gives the login command to run in the CLI tab", () => {
  assert.equal(
    read(check({ ...cursor, login: "cursor-agent login" }, { cli: true })),
    "Cursor has no credential yet. To set one up, log in from the [cli] tab with cursor-agent login.",
  );
});

test("says when a login was last seen and how to log in again if it lapses", () => {
  assert.equal(
    read(check({ login: "claude", login_seen_at: "2026-05-01T10:00:00Z" }, { cli: true })),
    "Runs on its login, last seen 2h ago. If it lapses, choose a subscription token above, or log in again from the [cli] tab with claude.",
  );
});

test("keeps a seen login's note for a harness without a secret while the CLI is off", () => {
  assert.equal(
    read(check({ ...cursor, login_seen_at: "2026-05-01T11:30:00Z" })),
    "Runs on its login, last seen 30m ago. If it lapses, turn on CLI, then log in from its tab.",
  );
});
