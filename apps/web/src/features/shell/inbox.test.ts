import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { MentionNotice, Notifications } from "../../api/types/chat";
import type { InboxIssue, IssueSeverity } from "../../api/types/issues";
import {
  disabledAgentsSummary,
  disablingIssueByAgent,
  disablingIssues,
  faviconForInboxCount,
  inboxCount,
  inboxCountsByGuild,
} from "./inbox";

function tag(id: number, guildId: string): MentionNotice {
  return {
    id,
    guild_id: guildId,
    guild_name: guildId,
    seq: id,
    author_type: "agent",
    author_name: "scout",
    content: "@operator",
    created_at: "2026-01-01T00:00:00.000Z",
    agent: null,
  };
}

function openIssue(id: string, guildId: string, severity: IssueSeverity = "medium"): InboxIssue {
  return {
    id,
    guild_id: guildId,
    guild_name: guildId,
    agent_id: null,
    agent_name: "scout",
    run_id: null,
    kind: "tool_failure",
    severity,
    status: "open",
    summary: "The tool failed",
    detail: "It timed out",
    tool_name: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    resolved_at: null,
    resolved_by: null,
    agent: null,
  };
}

test("each guild counts its inbox tags and its open issues apart", () => {
  const counts = inboxCountsByGuild(
    {
      issues: [openIssue("i1", "guild_1"), openIssue("i2", "guild_1"), openIssue("i3", "guild_2")],
      mentions: [tag(1, "guild_1"), tag(2, "guild_3"), tag(3, "guild_3"), tag(4, "guild_3")],
      unread: [],
    },
    "low",
  );
  assert.deepEqual(counts.get("guild_1"), { tags: 1, issues: 2 });
  assert.deepEqual(counts.get("guild_2"), { tags: 0, issues: 1 });
  assert.deepEqual(counts.get("guild_3"), { tags: 3, issues: 0 });
  assert.equal(counts.has("guild_4"), false);
});

test("tags count no guild while no guild has an open issue", () => {
  const inbox: Notifications = {
    issues: [],
    mentions: [tag(1, "guild_1"), tag(2, "guild_2")],
    unread: [{ guild_id: "guild_1", count: 5 }],
  };
  assert.equal(inboxCountsByGuild(inbox, "low").size, 0);
});

test("one open issue in any guild shows the tags of every guild", () => {
  const counts = inboxCountsByGuild(
    {
      issues: [openIssue("i1", "guild_2")],
      mentions: [tag(1, "guild_1")],
      unread: [],
    },
    "low",
  );
  assert.deepEqual(counts.get("guild_1"), { tags: 1, issues: 0 });
  assert.deepEqual(counts.get("guild_2"), { tags: 0, issues: 1 });
});

test("unread chat messages that tag no one are not counted", () => {
  const counts = inboxCountsByGuild(
    {
      issues: [openIssue("i1", "guild_1")],
      mentions: [tag(1, "guild_1")],
      unread: [
        { guild_id: "guild_1", count: 40 },
        { guild_id: "guild_2", count: 7 },
      ],
    },
    "low",
  );
  assert.deepEqual(counts.get("guild_1"), { tags: 1, issues: 1 });
  assert.equal(counts.has("guild_2"), false);
});

test("an inbox not loaded yet counts no guild", () => {
  assert.equal(inboxCountsByGuild(undefined, "low").size, 0);
});

test("issues below the operator's alert severity count in no guild and not in the inbox", () => {
  const inbox: Notifications = {
    issues: [
      openIssue("i1", "guild_1", "low"),
      openIssue("i2", "guild_1", "high"),
      openIssue("i3", "guild_2", "medium"),
      openIssue("i4", "guild_3", "blocking"),
    ],
    mentions: [tag(1, "guild_2")],
    unread: [],
  };
  const counts = inboxCountsByGuild(inbox, "high");
  assert.deepEqual(counts.get("guild_1"), { tags: 0, issues: 1 });
  assert.deepEqual(counts.get("guild_2"), { tags: 1, issues: 0 });
  assert.deepEqual(counts.get("guild_3"), { tags: 0, issues: 1 });
  assert.equal(inboxCount(inbox, "low"), 5);
  assert.equal(inboxCount(inbox, "high"), 3);
  assert.equal(inboxCount(inbox, "blocking"), 2);
});

test("with every issue below the alert severity, no guild shows a count", () => {
  const inbox: Notifications = {
    issues: [openIssue("i1", "guild_1", "low")],
    mentions: [tag(1, "guild_1")],
    unread: [],
  };
  assert.equal(inboxCountsByGuild(inbox, "medium").size, 0);
  assert.equal(inboxCount(inbox, "medium"), 1, "the tag still waits in the inbox");
});

test("the issues that disable agents are the open blocking ones with an agent, oldest first", () => {
  const blocking = (id: string, at: string, agentId: string | null): InboxIssue => ({
    ...openIssue(id, "guild_1", "blocking"),
    agent_id: agentId,
    created_at: at,
  });
  const inbox: Notifications = {
    issues: [
      blocking("newer", "2026-01-03T00:00:00.000Z", "agent_1"),
      openIssue("high", "guild_1", "high"),
      blocking("gone", "2026-01-01T00:00:00.000Z", null),
      blocking("older", "2026-01-02T00:00:00.000Z", "agent_2"),
    ],
    mentions: [],
    unread: [],
  };
  assert.deepEqual(
    disablingIssues(inbox).map((issue) => issue.id),
    ["older", "newer"],
  );
  assert.deepEqual(disablingIssues(undefined), []);
  const again = blocking("again", "2026-01-04T00:00:00.000Z", "agent_2");
  const byAgent = disablingIssueByAgent(
    disablingIssues({ ...inbox, issues: [...inbox.issues, again] }),
  );
  assert.deepEqual([...byAgent.keys()].sort(), ["agent_1", "agent_2"]);
  assert.equal(byAgent.get("agent_2")?.id, "older", "an agent's oldest blocking issue");
});

test("an inbox count above zero uses the static unread favicon", () => {
  const path = faviconForInboxCount(2);
  assert.equal(path, "/favicon-unread.svg");
  assert.equal(path.startsWith("data:"), false);
  const svg = readFileSync(
    fileURLToPath(new URL(`../../../public${path}`, import.meta.url)),
    "utf8",
  );
  assert.match(svg, /<svg[\s>]/);
  assert.equal(svg.includes("data:"), false);
  assert.match(svg, /#d9d5c7/);
  assert.match(svg, /#120e11/);
});

test("an empty inbox uses the plain favicon", () => {
  assert.equal(faviconForInboxCount(0), "/favicon.svg");
});

test("an inbox count that has not loaded uses the plain favicon", () => {
  assert.equal(faviconForInboxCount(undefined), "/favicon.svg");
});

test("the disabled agents are named up to two, counted past that, each once", () => {
  assert.equal(disabledAgentsSummary([]), "");
  assert.equal(
    disabledAgentsSummary(["scout", "scout"]),
    "scout is disabled until its blocking issue is resolved",
  );
  assert.equal(
    disabledAgentsSummary(["scout", "mailroom"]),
    "scout and mailroom are disabled until their blocking issues are resolved",
  );
  assert.equal(
    disabledAgentsSummary(["scout", "mailroom", "closer"]),
    "3 agents are disabled until their blocking issues are resolved",
  );
});
