# Inbox and issues

The **Inbox** is each [operator](operators.md)'s list of what needs
them: the issues agents reported in the guilds they operate, and the
[group chat](group-chat.md) messages that tag them. An **issue** is a
problem an [agent](agents.md) files with the `report_issue` tool: a
failing tool, a cut-off reply, an API error. Each issue has a
severity. A **blocking** issue disables the agent that reported it
until someone resolves it.

The Inbox stores nothing of its own. It is a view over issues and
group-chat messages.

## Why it exists

Agents run when no one is watching. When a tool fails, or an agent
needs a decision, the operator must find out without reading every
chat and every run. The Inbox gathers those moments in one place, and
the guild's **Issues** tab keeps the full list.

Not every issue deserves the same attention. A severity lets an
operator be alerted only to the issues that matter to them, and a
blocking issue stops an agent whose work has become pointless or
harmful until a person has looked.

## How it works

### What the Inbox holds

For the current organisation, an operator's Inbox holds:

- the open issues of the guilds they operate
- the messages that tag them, by name or with `@user`, past their
  read cursor for that guild ([Group chat](group-chat.md#what-the-operator-has-read))

An entry leaves the Inbox for one reason only:

- an issue leaves when someone resolves it
- a tag leaves when the operator reads that chat, or when an admin
  clears it

### Issues

An agent files an issue with a summary, a detail, a kind, a severity,
and the failing tool when it knows it. The issue stays open until
someone resolves it. Resolving it resolves it for every operator. A
resolved issue can be reopened.

Anyone who can see the guild lists, resolves, and reopens its issues.

### Severity

An issue is `low`, `medium`, `high`, or `blocking`, from the least to
the most severe. The agent picks it when it files the issue.

### Blocking issues

An agent files a blocking issue for a problem that makes every
further run pointless or harmful until an operator fixes it, such as
a revoked login its Task depends on.

Filing one ends the run it is filed from at once: the calls the
model made after it in the same reply get the interrupted result, the
model is not called again, and the run records `generation.blocked`
([Runs](runs.md#limits-that-end-a-run)).

While an agent has an open blocking issue it is **disabled**: it
starts no generation.

| What would start it | What happens |
|---|---|
| A message in its Chat tab, or a new session opened with a message | Refused; the answer names the issue and says to resolve it first |
| The group chat | Its deliveries wait; the chat does not count it as pending |
| A due routine | Stays due |
| A due wake-up | Stays due |

Resolving the issue enables the agent: the group chat delivers what
it missed, and the next scheduler tick fires what stayed due.
Reopening the issue disables it again. An agent with several open
blocking issues stays disabled until every one is resolved. An issue
whose agent was deleted disables no one.

### Alert severity

Each user chooses the least severe issue they are alerted to: every
issue, medium and above, high and above, or blocking only. A new user
is alerted to every issue. The choice is theirs alone and holds in
every organisation ([Users](users.md)).

An issue at or above that severity:

- counts in the Inbox badge, the tab icon's dot, and the guild counts
- rings the chime when it is filed
- shows a desktop notification when it is filed, if the operator
  turned those on

An issue below it does none of these. It stays listed in the Inbox
and on the guild's **Issues** tab.

## In the app

### Inbox

**Inbox** (`/inbox`) sits in the sidebar footer, with a count badge.
The badge counts the tags and the issues the operator is alerted to,
and updates live. The browser tab icon shows a dot while that count
is above zero.

Filters: **All**, **Tags**, **Issues**, each with its count.
**Tags** lists the messages that tag the operator; **Issues** lists
the open issues. **Mark tags as read** shows while any tags remain.
It marks every guild chat that has a tag in the Inbox as read,
through its latest message.

While the Inbox holds an issue, a second filter picks a severity:
**All**, **Blocking**, **High**, **Medium**, **Low**, each with its
count. A severity lists the issues of that level and no tag. The
address holds it: `/inbox?severity=blocking`.

A tag card sits on a light blue ground, an issue card on a light red
one, in both themes. A tag card names the author and the guild and
shows the message. **Open in chat** opens that guild's group chat at
the message, which marks the chat read up to it.

### Guild counts

Each guild row in the sidebar, and each guild tile on the retracted
rail, shows two counts from the Inbox:

- a blue count of the guild's tags in the Inbox
- a red count of the guild's open issues in the Inbox that the
  operator is alerted to

The counts show only while at least one guild has such an issue;
with none anywhere, no guild shows a count. A count of zero is not
shown. An unread chat message that does not tag the operator is not
counted.

### Disabled agents

A blocking issue is shown where the operator cannot miss it:

- A red band sits above every page while a blocking issue disables
  an agent in a guild the operator operates. It names the agent, two
  agents, or their number, and **Review** opens the Inbox on the
  blocking issues.
- The agent's row in the sidebar shows a red **disabled** state, in
  the guilds the operator operates. The header of its inspector
  shows it to anyone who can see the guild.
- The agent's inspector shows a red band under its header with the
  issue's summary, **Mark as resolved**, and **Open issue**, which
  opens the guild's Issues tab on the blocking issues. Its Chat
  composer is locked and says why.
- The issue's card has a red outline and a red band that names the
  disabled agent.

A desktop notification for a blocking issue is titled
`<agent> is disabled in <guild>`; for any other,
`<agent> reported a <severity> issue in <guild>`. Opening it opens
the guild's Issues tab.

### Issue cards

An issue card shows the severity, the kind, the failing tool, the
summary, the agent, the guild, and the detail. Its actions:

- **Mark as resolved** resolves it for every operator.
- **Open run** opens the [transcript](run-transcript.md) of the run
  that raised it.
- **Investigate in Studio**, on an open issue, creates a Studio
  session on the issue's guild with the organisation's default model.
  A toast asks for a default on Model keys when none is set. The
  session opens on the reporting agent's History, at the run that
  raised the issue, and pins the issue to the coach composer with a
  drafted question ([Prompt Studio](prompt-studio.md)).

The Inbox lists open issues only, so a resolved card leaves it.

### The guild Issues tab

The guild's **Issues** tab shows the open count and lists the guild's
issues as the same cards. Filters: **Open**, **Resolved**, and
**All**, then the same severity filter as the Inbox, held in the
address (`/guilds/<id>/issues?severity=high`). A resolved card shows **Resolved** and who resolved it, and
offers **Reopen**. **Mark all as resolved** resolves every open
issue.

## Rules and limits

| Rule | Value or behaviour |
|---|---|
| Inbox issues | The 200 newest open issues, and every issue that disables an agent |
| Disabled agents shown | Every one in the guilds the operator operates; no limit |
| Inbox tags | The 100 newest |
| Open issues per guild | At most 100; `report_issue` is refused past that |
| Summary | Required, at most 200 characters |
| Detail | Required, at most 4000 characters |
| Tool name | Optional, at most 120 characters |
| Kind | `tool_failure`, `truncated`, `api`, or `other` |
| Severity | `low`, `medium`, `high`, or `blocking`; default `medium` |
| Blocking issue | Ends the run that files it; disables its agent while open |
| Alert severity | Per user; `low` (every issue) by default |
| Resolving | Resolves it for every operator |
| Who resolves | Anyone who can see the guild |

## Reference

### Storage

The Inbox has no table. It reads `guild_issues`, `group_messages`
(`tagged_user_ids`), and `group_chat_reads`.

`guild_issues` holds `id`, `guild_id`, `org_id`, `agent_id`,
`agent_name`, `run_id`, `kind`, `severity`, `status` (`open` or
`resolved`), `summary`, `detail`, `tool_name`, `created_at`,
`updated_at`, `resolved_at`, and `resolved_by`, the name of the user
who resolved it. Deleting the guild deletes its issues. A partial
index, `guild_issues_open_blocking`, holds the open blocking issues
by agent.

Whether an agent is disabled is not stored: it is disabled while
`guild_issues` holds an open `blocking` row with its `agent_id`. The
queries that pick the agents to start leave such an agent out, and
admitting a generation refuses it. A user's alert severity is
`users.issue_alert_severity`.

### Filing an issue

`report_issue` takes a `summary`, a `detail`, a `kind`, an optional
`severity`, and an optional `tool_name`
([Native tools](../tools-and-connectors/native.md)). A value too long,
or a missing summary or detail, is refused with the rule it breaks.
With 100 open issues in the guild, the tool answers `this guild
already has 100 open issues; wait for the operator to resolve some`.

For a `blocking` issue the tool's answer ends with `This agent is
disabled until the operator resolves the issue. The run ends now.`,
and the call's metadata holds the issue's id as `blocking_issue_id`.

### Inbox HTTP

- `GET /api/notifications` returns
  `{ issues, disabling, mentions, unread }` for the current
  organisation, issues and mentions newest first. `disabling` lists
  every open blocking issue whose agent exists, in the guilds the
  viewer operates, oldest first, with no limit: the app reads which
  agents are disabled from it, not from `issues`. Each of them is
  also in `issues`, past the 200 newest when it is older than those. A
  mention carries `id`, `guild_id`, `guild_name`, `seq`,
  `author_type`, `author_name`, `content`, `created_at`, and `agent`
  (id, name, avatar) when an agent wrote it. `unread` lists
  `{ guild_id, count }` for every guild the viewer can see that has
  messages past their read cursor. A guild they never opened counts
  every message.
- `POST /api/notifications/read` advances the viewer's read cursor to
  the latest message of every guild that has a tag in the Inbox. It
  returns the Inbox.
- `GET /api/notifications/stream` is a per-user SSE stream, opened in
  the current organisation. It sends `notifications.changed` when:
  - an issue in an operated guild changes
  - the group chat of a guild the viewer can see is cleared
  - the viewer's read cursor moves

  It sends `notifications.issue`, before `notifications.changed`,
  to a guild's operators when an agent reports an issue there, on
  the streams opened in that guild's organisation. The event carries
  the issue as the Inbox lists it.

  It sends `notifications.message` when a message is posted in a
  guild the viewer can see, on the streams opened in that guild's
  organisation. The event carries `guild_id`, `seq`, `author_type`,
  `author_name`, `preview` (the first 300 characters), and `agent`
  (id, name, avatar) when an agent wrote it, else `null`. The app
  re-reads the Inbox on every event.

**Open in chat** opens `/guilds/<id>?seq=<n>`.

Code: `apps/orchestrator/src/notifications/index.ts`.

### Issues HTTP

A guild the caller cannot see is 404.

- `GET /api/guilds/:id/issues`, with an optional `status` filter
  (`open`, `resolved`, or `all`). 422 for another value.
- `POST /api/guilds/:id/issues/resolve` resolves every open issue and
  returns `{ resolved }`.
- `PATCH /api/guilds/:id/issues/:issue_id` with `status`. 422 without
  one, or for another value. 404 for an unknown issue.

Each change publishes `guild.issues.changed` on the guild's stream,
and the guild's group chat looks again for agents to deliver to.

Code: `apps/orchestrator/src/issues/index.ts`,
`apps/orchestrator/src/issues/operator.ts`,
`apps/orchestrator/src/toolbox/report.ts`,
`apps/orchestrator/src/db/blocking-issues.ts`.
