# Inbox and issues

The **Inbox** is each [operator](operators.md)'s list of what needs
them: the issues agents reported in the guilds they operate, and the
[group chat](group-chat.md) messages that tag them. An **issue** is a
problem an [agent](agents.md) files with the `report_issue` tool: a
failing tool, a cut-off reply, an API error.

The Inbox stores nothing of its own. It is a view over issues and
group-chat messages.

## Why it exists

Agents run when no one is watching. When a tool fails, or an agent
needs a decision, the operator must find out without reading every
chat and every run. The Inbox gathers those moments in one place, and
the guild's **Issues** tab keeps the full list.

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

## In the app

### Inbox

**Inbox** (`/inbox`) sits in the sidebar footer, with a count badge.
The badge counts both issues and tags and updates live.

Filters: **All**, **Tags**, **Issues**, each with its count.
**Mark tags as read** shows while any tags remain. It marks every
guild chat that has a tag in the Inbox as read, through its latest
message.

A tag card names the author and the guild and shows the message.
**Open in chat** opens that guild's group chat at the message, which
marks the chat read up to it.

### Issue cards

An issue card shows the severity, the kind, the failing tool, the
summary, the agent, the guild, and the detail. Its actions:

- **Mark as resolved** resolves it for every operator.
- **Open run** opens the [transcript](run-transcript.md) of the run
  that raised it.
- **Investigate in Studio**, on an open issue, creates a Studio
  session on the issue's guild with the organisation's default model.
  A toast asks for a default on Model keys when none is set. It opens
  the inspector on the reporting agent's History tab at the run that
  raised the issue, and pins the issue to the coach composer with a
  drafted question ([Prompt Studio](prompt-studio.md)).

The Inbox lists open issues only, so a resolved card leaves it.

### The guild Issues tab

The guild's **Issues** tab shows the open count and lists the guild's
issues as the same cards. Filters: **Open**, **Resolved**, and
**All**. A resolved card shows **Resolved** and who resolved it, and
offers **Reopen**. **Mark all as resolved** resolves every open
issue.

## Rules and limits

| Rule | Value or behaviour |
|---|---|
| Inbox issues | The 200 newest open issues |
| Inbox tags | The 100 newest |
| Open issues per guild | At most 100; `report_issue` is refused past that |
| Summary | Required, at most 200 characters |
| Detail | Required, at most 4000 characters |
| Tool name | Optional, at most 120 characters |
| Kind | `tool_failure`, `truncated`, `api`, or `other` |
| Severity | `low`, `medium`, or `high`; default `medium` |
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
who resolved it. Deleting the guild deletes its issues.

### Filing an issue

`report_issue` takes a `summary`, a `detail`, a `kind`, an optional
`severity`, and an optional `tool_name`
([Native tools](../tools-and-connectors/native.md)). A value too long,
or a missing summary or detail, is refused with the rule it breaks.
With 100 open issues in the guild, the tool answers `this guild
already has 100 open issues; wait for the operator to resolve some`.

### Inbox HTTP

- `GET /api/notifications` returns `{ issues, mentions, unread }` for
  the current organisation, issues and mentions newest first. A
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

  It sends `notifications.message` when a message is posted in a
  guild the viewer can see, on the streams opened in that guild's
  organisation. The event carries `guild_id`, `seq`, `author_type`,
  `author_name`, `preview` (the first 300 characters), and `agent`
  (id, name, avatar) when an agent wrote it, else `null`. The app
  re-reads the Inbox on either event.

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

Each change publishes `guild.issues.changed` on the guild's stream.

Code: `apps/orchestrator/src/issues/index.ts`,
`apps/orchestrator/src/issues/operator.ts`,
`apps/orchestrator/src/toolbox/report.ts`.
