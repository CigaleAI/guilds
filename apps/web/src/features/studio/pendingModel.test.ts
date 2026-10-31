import assert from "node:assert/strict";
import { test } from "node:test";
import type { StudioDraft, StudioMessage } from "../../api/types/studio";
import { countOpen, draftHead, turnProposals, turnReply } from "./pendingModel";

function message(
  seq: number,
  payload: Record<string, unknown>,
  metadata: Record<string, unknown> | null = null,
): StudioMessage {
  return {
    id: seq,
    session_id: "stu_1",
    seq,
    generation: 1,
    payload,
    metadata,
    cost_usd: null,
    created_at: "2026-10-19T10:00:00Z",
  };
}

const tool = (
  seq: number,
  body: Record<string, unknown>,
  metadata: Record<string, unknown> | null = null,
) => message(seq, { role: "tool", content: JSON.stringify(body) }, metadata);

const user = (seq: number) => message(seq, { role: "user", content: "go" });

const edit = (
  seq: number,
  edit: Record<string, unknown>,
  metadata: Record<string, unknown> | null = null,
) => tool(seq, { widget: "studio_edit_request", edit }, metadata);

const login = (seq: number, metadata: Record<string, unknown> | null = null) =>
  tool(
    seq,
    {
      widget: "studio_connection_access",
      connection: { id: "conn_1", server: { slug: "notion" } },
    },
    metadata,
  );

const draftRequest = (seq: number, draftId: string) =>
  tool(seq, {
    widget: "studio_task_draft",
    agent: { id: "a_1", name: "wallet" },
    draft_id: draftId,
  });

function draft(id: string, overrides: Partial<StudioDraft> = {}): StudioDraft {
  return {
    id,
    session_id: "stu_1",
    target_agent_id: "a_1",
    target_snapshot: { name: "wallet" },
    base_version: 3,
    base_content: "",
    proposed_content: "",
    rationale: "",
    risks: [],
    status: "draft",
    draft_number: 1,
    supersedes_draft_id: null,
    created_message_seq: 5,
    created_at: "2026-10-19T10:00:00Z",
    published_resource_version: null,
    size_delta_bytes: 0,
    large_deletion: false,
    ...overrides,
  };
}

test("only the requests after the operator's last message are waiting", () => {
  const proposals = turnProposals(
    [
      edit(2, { kind: "memory", target: { agent_id: "a_1" } }),
      user(3),
      edit(5, { kind: "memory", target: { agent_id: "a_1" } }),
    ],
    [],
    [],
  );
  assert.deepEqual(
    proposals.map((proposal) => [proposal.seq, proposal.state]),
    [[5, "open"]],
  );
  assert.deepEqual(turnProposals([edit(2, { kind: "memory" }), user(3)], [], []), []);
});

test("an edit is open until it is applied or declined, and lands where it changes", () => {
  const proposals = turnProposals(
    [
      edit(
        4,
        { kind: "memory", target: { agent_id: "a_1", agent_name: "wallet" } },
        { edit_status: "applied" },
      ),
      edit(
        5,
        { kind: "routine", target: { agent_id: "a_1", schedule_id: "s_1" } },
        { edit_status: "declined" },
      ),
      edit(6, { kind: "note", target: { display_path: "org/o/guilds/g/notes/a.md" } }),
      edit(7, { kind: "collection", target: { collection_id: "col_1", name: "leads" } }),
      edit(8, { kind: "access", target: { agent_id: "a_1" }, widens: true }),
      edit(9, { kind: "guild", fields: ["about"] }),
      edit(10, { kind: "memory" }),
    ],
    [],
    [],
  );
  assert.deepEqual(
    proposals.map((proposal) => [proposal.state, proposal.decision?.accepted ?? null]),
    [
      ["decided", true],
      ["decided", false],
      ["open", null],
      ["open", null],
      ["open", null],
      ["open", null],
      ["open", null],
    ],
  );
  assert.deepEqual(
    proposals.map((proposal) => proposal.location),
    [
      { section: "agents", agent: "a_1", tab: "memory" },
      { section: "agents", agent: "a_1", tab: "routines", item: "s_1" },
      { section: "state", tab: "list", kind: "note", item: "org/o/guilds/g/notes/a.md" },
      { section: "state", tab: "list", kind: "table", item: "col_1" },
      { section: "tools" },
      { section: "guild" },
      { section: "agents" },
    ],
  );
  assert.deepEqual(
    proposals.map((proposal) => proposal.alone),
    [false, false, false, false, true, false, false],
  );
  assert.equal(proposals[4]?.agentId, "a_1");
});

test("a note or table without a target opens the list", () => {
  const [note, table] = turnProposals(
    [edit(4, { kind: "note" }), edit(5, { kind: "collection" })],
    [],
    [],
  );
  assert.deepEqual(note?.location, { section: "state", tab: "list", kind: "note" });
  assert.deepEqual(table?.location, { section: "state", tab: "list", kind: "table" });
});

test("a login is granted by its answer or by the Logins popover, and is decided alone", () => {
  const [open, granted, declined, popover] = [
    turnProposals([login(4)], [], [])[0],
    turnProposals([login(4, { access_status: "granted" })], [], [])[0],
    turnProposals([login(4, { access_status: "declined" })], [], [])[0],
    turnProposals([login(4)], [], ["conn_1"])[0],
  ];
  assert.equal(open?.state, "open");
  assert.equal(open?.alone, true);
  assert.equal(open?.place, "logins");
  assert.equal(open?.location, null);
  assert.equal(granted?.decision?.accepted, true);
  assert.equal(declined?.decision?.accepted, false);
  assert.equal(popover?.decision?.accepted, true);
});

test("a draft's head follows the operator's edits, not a later coach draft", () => {
  const drafts = [
    draft("d1", { status: "superseded" }),
    draft("d2", { draft_number: 2, supersedes_draft_id: "d1" }),
    draft("d3", { draft_number: 3, supersedes_draft_id: "d2", created_message_seq: 9 }),
  ];
  assert.equal(draftHead(drafts, "d1")?.id, "d2");
  assert.equal(draftHead(drafts, "d3")?.id, "d3");
  assert.equal(draftHead(drafts, "missing"), null);
  assert.equal(
    draftHead(
      [
        draft("d4", { created_message_seq: null }),
        draft("d5", { created_message_seq: null, draft_number: 2 }),
      ],
      "d4",
    )?.id,
    "d4",
  );
});

test("a draft is open until published or discarded; one the coach replaced needs no answer", () => {
  const state = (drafts: StudioDraft[]) => turnProposals([draftRequest(5, "d1")], drafts, [])[0];
  assert.equal(state([])?.state, "open");
  assert.equal(state([draft("d1", { status: "conflicted" })])?.state, "open");
  assert.equal(state([draft("d1", { status: "superseded" })])?.state, "replaced");
  assert.equal(
    state([draft("d1", { status: "discarded" })])?.decision?.line,
    "Discarded the draft for wallet.",
  );
  assert.equal(
    state([draft("d1", { status: "published" })])?.decision?.line,
    "Published the draft for wallet.",
  );
  assert.equal(
    state([
      draft("d1", { status: "superseded" }),
      draft("d2", { status: "unchanged", draft_number: 2 }),
    ])?.decision?.line,
    "Edited and published the draft for wallet.",
  );
  const open = state([draft("d1")]);
  assert.deepEqual(open?.location, { section: "agents", agent: "a_1", tab: "draft" });
  assert.equal(open?.label, "wallet · Task draft");
  assert.equal(open?.draft?.id, "d1");
});

test("the turn's reply waits on every open request and skips a replaced draft", () => {
  const drafts = [
    draft("d1", { status: "superseded" }),
    draft("d2", { created_message_seq: 6, status: "published" }),
  ];
  const settled = turnProposals(
    [
      draftRequest(5, "d1"),
      draftRequest(6, "d2"),
      edit(7, { kind: "guild", target: { guild_name: "degen" } }, { edit_status: "declined" }),
    ],
    drafts,
    [],
  );
  assert.equal(
    turnReply(settled),
    "Published the draft for wallet. Declined the edit to degen · description. Continue without what I declined.",
  );
  assert.equal(turnReply(turnProposals([login(4)], [], [])), null);
});

test("open requests are counted per key, leaving the decided and keyless out", () => {
  const proposals = turnProposals(
    [
      edit(4, { kind: "memory", target: { agent_id: "a_1" } }),
      edit(5, { kind: "routine", target: { agent_id: "a_1" } }),
      edit(6, { kind: "memory", target: { agent_id: "a_2" } }, { edit_status: "applied" }),
      edit(7, { kind: "guild" }),
    ],
    [],
    [],
  );
  assert.deepEqual(
    countOpen(proposals, (proposal) => proposal.place),
    { agents: 2, guild: 1 },
  );
  assert.deepEqual(
    countOpen(proposals, (proposal) => proposal.agentId),
    { a_1: 2 },
  );
});
