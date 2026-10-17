# Operators

Operators are the people a [guild](guilds.md) works for. Each one is
a member of the guild's [organisation](organisations.md) with a role
in that guild: `admin` or `operator`. Agents know who the operators
are, tag them in the [group chat](group-chat.md), and report issues
to them. Each operator follows what needs them in the **Inbox**.

A [user](users.md) is an account. An operator is that user in one
guild. The same person can operate several guilds with a different
role in each.

## Why it exists

A guild's agents need someone to answer to: someone to tag when a
decision is needed, to read issues when a tool fails, and to decide
who else may change the guild. Operators are that list. The roster
also decides who sees a private guild.

## How it works

### Roles

| Role | Can |
|---|---|
| `admin` | Everything an operator can, plus add operators, change roles, remove operators, change visibility, clear the group chat, and delete the guild |
| `operator` | Every other guild action |

Every other guild action is open to anyone who can see the guild:
any organisation member for a guild open to the organisation, and
the operators alone for a private guild.

Whoever creates a guild, from the create dialog or a recipe apply,
is its first admin.

### The last admin

A guild keeps at least one admin. These are refused while the user
is the guild's only admin:

- demoting them
- removing them from the guild
- removing them from the organisation
- deleting their user

Name another admin first.

### Operators are members

Operators are organisation members. Leaving the organisation removes
them from every guild in it.

### Tag names

Agents and operators share the guild's tag names. An agent cannot be
created or renamed to an operator's name. A member named like one of
the guild's agents cannot be added as an operator.

Agents tag an operator by name, or every operator with `@user`
([Group chat](group-chat.md)). Neither tag selects an agent.

### What agents see

Agents see the roster in the State snapshot of their system prompt:
each operator's name and role ([System prompt](system-prompt.md)).

### The Inbox

Each operator's inbox holds, for the current organisation and the
guilds they operate:

- the open issues agents reported
- the messages that tag them, by name or `@user`, past their read
  cursor for that guild

Nothing is stored for the inbox itself. It is a view over issues and
group-chat messages. Resolving the issue, or reading the chat, clears
an entry for that reason alone. Issues stay until resolved.

## In the app

### Operators in guild Settings

The guild's **Settings** tab has an **Operators** section. It lists
each operator with their role. An admin adds an organisation member
with a role (**Operator** or **Admin**), changes roles, and removes
operators. Others see the list read-only ([Guilds](guilds.md)).

When every organisation member already operates the guild, the
section says so and links to **Settings**, **Members**, where owners
and admins add people to the organisation
([Organisations](organisations.md)). Someone with no account yet gets
one from **Admin**, **Users** ([Users](users.md)).

### Inbox

**Inbox** (`/inbox`) sits in the sidebar footer, with a count badge.
The badge counts both issues and tags and updates live.

Filters: **All**, **Tags**, **Issues**, each with its count. **Mark
tags as read** is shown while any tags remain. It marks every guild
chat with a tag in the inbox as read.

A tag card names the author and the guild and shows the message.
**Open in chat** opens that guild's group chat at the message, which
marks the chat read up to it.

An issue card shows agent, guild, kind, severity, failing tool,
detail, and **Open run**, with two actions:

- **Mark as resolved** resolves it for every operator. A resolved
  card offers **Reopen**.
- **Investigate in Studio**, on an open issue, creates a Studio
  session on the issue's guild with the organisation's default
  model. A toast asks for one on Model keys when none is set. It
  opens the inspector on the reporting agent's History tab at the
  run that raised the issue, and pins the issue to the coach
  composer with a drafted question ([Prompt Studio](prompt-studio.md)).

### The guild Issues tab

The guild's **Issues** tab, with the open count, lists the issues
agents filed with `report_issue`, as the same issue cards as the
Inbox. Filters: **Open**, **Resolved**, and **All**. **Mark all as
resolved** resolves every open issue for every operator.

## Rules and limits

| Rule | Value or behaviour |
|---|---|
| Roles | `admin` or `operator` |
| First admin | Whoever creates the guild |
| Admins per guild | At least one |
| Who changes the roster | Admins only |
| Who may be an operator | Members of the guild's organisation |
| Tag names | Shared by agents and operators; a clash is refused |
| `@user` | Tags every operator; no user may be named `user` |
| Inbox issues | The 200 newest |
| Inbox tags | The 100 newest |
| Resolving an issue | Resolves it for every operator |

## Reference

### Storage

`guild_operators` holds `org_id`, `guild_id`, `user_id`, `role`
(`admin` or `operator`), and `created_at`. Its primary key is guild
and user. It references the guild and the organisation membership;
deleting either deletes the row.

Guild payloads carry `operators` (`user_id`, `name`, `role`, oldest
first). Agents read State `group.operators` (`name`, `role`).

### HTTP

- `PUT /api/guilds/:id/operators/:user_id` with `{ role }` adds an
  organisation member or changes their role. It returns the guild.
  422 for a role other than `admin` or `operator`. 422 `operators
  must be members of the organisation`. 409 when the change would
  leave no admin. 409 when an agent of the guild has that name.
- `DELETE /api/guilds/:id/operators/:user_id` removes one. It returns
  the guild. 404 `operator not found`. 409 when they are the last
  admin.

Both take a guild admin. A guild the caller cannot see is 404. A
caller who sees it but is not an admin gets 403 `only a guild admin
can do this`.

Removing a member from the organisation, or deleting a user, who is
the only admin of a guild is 409 `user is the only admin of <guilds>;
name another admin first`. Creating or renaming an agent to an
operator's name is 409.

### Inbox HTTP

- `GET /api/notifications` returns `{ issues, mentions }` for the
  current organisation, newest first. A mention carries `id`,
  `guild_id`, `guild_name`, `seq`, `author_type`, `author_name`,
  `content`, `created_at`, and `agent` (id, name, avatar) when an
  agent wrote it.
- `POST /api/notifications/read` advances the viewer's read cursor
  through every guild that currently has a tag in the inbox, so those
  chats are read. It returns the inbox. Issues stay until resolved.
- `GET /api/notifications/stream` is a per-user SSE stream. It sends
  `notifications.changed` when:
  - an issue in an operated guild changes
  - a message tags the viewer
  - the viewer's read cursor moves

**Open in chat** opens `/guilds/<id>?seq=<n>`.

Code: `apps/orchestrator/src/notifications/index.ts`.

### Issues HTTP

- `GET /api/guilds/:id/issues`, with an optional `status` filter.
- `POST /api/guilds/:id/issues/resolve` resolves every open issue and
  returns `{ resolved }`.
- `PATCH /api/guilds/:id/issues/:issue_id` with `status`. 422 without
  one. 404 for an unknown issue.

Each change publishes `guild.issues.changed` on the guild's stream.
An agent files an issue with `report_issue`: a `summary`, a `detail`,
a `kind` (`tool_failure`, `truncated`, `api`, or `other`), an
optional `severity` (`low`, `medium`, or `high`; default `medium`),
and an optional `tool_name`
([Native tools](../tools-and-connectors/native.md)).

Code: `apps/orchestrator/src/issues/index.ts`,
`apps/orchestrator/src/toolbox/report.ts`.
