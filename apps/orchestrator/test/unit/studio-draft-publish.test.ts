import assert from "node:assert/strict";
import { test } from "node:test";
import type { StudioSessionRow } from "../../src/db/studio.js";
import {
  publishDraft,
  type DraftAnnounceDeps,
  type DraftPublication,
  type StudioDraft,
  type StudioDrafts,
} from "../../src/studio/drafts.js";
import { userRow } from "../helpers/users.js";

// Publishing a session's draft: the source guild hears its files changed when the Task did, and
// the outcome says whether the target agent is generating.

function publication(outcome: DraftPublication["outcome"], targetAgentId: string | null): DraftPublication {
  const draft = { id: "std_1", target_agent_id: targetAgentId } as StudioDraft;
  const preflight = {} as DraftPublication["preflight"];
  return outcome === "published"
    ? { outcome, draft, version: 2, prior_effective_hash: "a", published_effective_hash: "b", preflight }
    : { outcome, draft, preflight };
}

/** Deps whose drafts publish `result`, recording each files announcement, with `busy` the agents generating. */
function publishDeps(result: DraftPublication, busy: string[]): { deps: DraftAnnounceDeps; announced: string[] } {
  const announced: string[] = [];
  const drafts = { publish: async () => result } as unknown as StudioDrafts;
  const deps: DraftAnnounceDeps = {
    db: {} as never,
    preview: {} as never,
    notesSystemPath: "system.md",
    drafts,
    publishFilesChanged: async (guildId) => {
      announced.push(guildId);
    },
    isAgentBusy: (agentId) => busy.includes(agentId),
  };
  return { deps, announced };
}

const session = { id: "s_1", org_id: "org_1", source_guild_id: "guild_1" } as StudioSessionRow;
const user = userRow({ id: "user_1", name: "operator" });

test("a_published_draft_tells_the_source_guild_and_says_its_target_is_generating", async () => {
  const { deps, announced } = publishDeps(publication("published", "a_1"), ["a_1"]);
  const result = await publishDraft(deps, session, user, "std_1");
  assert.deepEqual(announced, ["guild_1"]);
  assert.equal(result.outcome, "published");
  assert.equal(result.target_generating, true);
});

test("an_unchanged_draft_tells_no_one_and_says_its_idle_target_is_not_generating", async () => {
  const { deps, announced } = publishDeps(publication("unchanged", "a_1"), []);
  const result = await publishDraft(deps, session, user, "std_1");
  assert.deepEqual(announced, []);
  assert.equal(result.target_generating, false);
});

test("a_draft_without_a_target_is_not_generating", async () => {
  const { deps } = publishDeps(publication("published", null), ["a_1"]);
  assert.equal((await publishDraft(deps, session, user, "std_1")).target_generating, false);
});

test("a_published_draft_of_a_session_whose_source_guild_is_gone_tells_no_one", async () => {
  const { deps, announced } = publishDeps(publication("published", "a_1"), []);
  await publishDraft(deps, { ...session, source_guild_id: null }, user, "std_1");
  assert.deepEqual(announced, []);
});

test("a_published_draft_on_a_box_without_a_files_channel_says_whether_its_target_is_generating", async () => {
  const { deps } = publishDeps(publication("published", "a_1"), ["a_1"]);
  const { publishFilesChanged: _, isAgentBusy: __, ...quiet } = deps;
  assert.equal((await publishDraft(quiet, session, user, "std_1")).target_generating, false);
});
