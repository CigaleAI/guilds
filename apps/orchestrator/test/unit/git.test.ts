import assert from "node:assert/strict";
import { test } from "node:test";
import { agentGitIdentity, cloneFailures } from "../../src/coding/git.js";

test("agent git identity defaults to the platform domain", () => {
  assert.deepEqual(agentGitIdentity({ id: "a_1", name: "researcher" }), {
    name: "researcher",
    email: "a_1@agents.guilds.run",
  });
});

test("agent git identity uses a guild commit author email when set", () => {
  assert.deepEqual(agentGitIdentity({ id: "a_1", name: "researcher" }, { email: "  dev@example.com  " }), {
    name: "researcher",
    email: "dev@example.com",
  });
});

test("agent git identity treats a blank guild email as the default", () => {
  assert.deepEqual(agentGitIdentity({ id: "a_1", name: "coder" }, { email: "   " }), {
    name: "coder",
    email: "a_1@agents.guilds.run",
  });
  assert.deepEqual(agentGitIdentity({ id: "a_1", name: "coder" }, { email: null }), {
    name: "coder",
    email: "a_1@agents.guilds.run",
  });
});

test("a clone that needed credentials says whether the repository had a token or no login", () => {
  const prompt = (url: string) => `fatal: could not read Username for '${url}': terminal prompts disabled`;
  const detail = cloneFailures(
    [
      { name: "private", error: prompt("https://github.com/acme/private") },
      { name: "picked", error: prompt("https://github.com/acme/picked") },
      { name: "mirror", error: "fatal: Authentication failed for 'https://git.example.com/mirror.git/'" },
      { name: "moved", error: "fatal: repository 'https://git.example.com/moved.git/' not found" },
    ],
    [
      { name: "private", url: "https://github.com/acme/private", connection_id: null },
      { name: "picked", url: "https://github.com/acme/picked", connection_id: "conn_a" },
      { name: "mirror", url: "https://git.example.com/mirror.git", connection_id: null },
      { name: "moved", url: "https://git.example.com/moved.git", connection_id: null },
    ],
    { picked: { token: "ghs_x", expires_at: "2099-01-01T00:00:00Z", host: "github.com", path: "acme/picked" } },
  );
  const parts = detail.split("; ");
  assert.match(parts[0]!, /^private: it has no GitHub login, so it was cloned without credentials: pick a private repository on the GitHub integration instead \(fatal: could not read Username/);
  assert.match(parts[1]!, /^picked: git did not use the GitHub token issued for it \(fatal: could not read Username/);
  assert.match(parts[2]!, /^mirror: it was cloned without credentials, which only a public repository allows \(fatal: Authentication failed/);
  assert.equal(parts[3], "moved: fatal: repository 'https://git.example.com/moved.git/' not found");
});
