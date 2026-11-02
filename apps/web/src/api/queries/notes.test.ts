import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { writeOrgNote } from "./notes";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type SentRequest = { url: string; method: string; body: unknown };

/** Answers every request with a written note and keeps what each one sent. */
function recordRequests(): SentRequest[] {
  const sent: SentRequest[] = [];
  globalThis.fetch = async (input, init) => {
    sent.push({ url: String(input), method: init?.method ?? "GET", body: JSON.parse(String(init?.body)) });
    return Response.json({ id: "n1", path: "plan.md", display_path: "org/o1/plan.md", content: "", version: 1 });
  };
  return sent;
}

test("a new note is written at its key in the organisation with its first row and expected version 0", async () => {
  const sent = recordRequests();
  await writeOrgNote({
    path: "plan.md",
    content: "",
    access: { type: "guild", id: "g1", mode: "write" },
    expected_version: 0,
  });
  assert.deepEqual(sent, [
    {
      url: "/api/org/notes/plan.md",
      method: "PUT",
      body: { content: "", access: { type: "guild", id: "g1", mode: "write" }, expected_version: 0 },
    },
  ]);
});

test("a save sends the version the editor loaded, and no access row", async () => {
  const sent = recordRequests();
  await writeOrgNote({ path: "plan.md", content: "# Plan", expected_version: 4 });
  assert.deepEqual(sent[0]?.body, { content: "# Plan", expected_version: 4 });
});

test("a write without a version sends none", async () => {
  const sent = recordRequests();
  await writeOrgNote({ path: "plan.md", content: "x" });
  assert.deepEqual(sent[0]?.body, { content: "x" });
});
