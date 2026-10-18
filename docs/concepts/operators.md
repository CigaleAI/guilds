# Operators

Operators are the people a [guild](guilds.md) works for. Each one is
a member of the guild's [organisation](organisations.md) with a role
in that guild: `admin` or `operator`. Agents know who the operators
are, tag them in the [group chat](group-chat.md), and report issues
to them in their [Inbox](inbox.md).

A [user](users.md) is an account. An operator is that user in one
guild. The same person can operate several guilds with a different
role in each.

## Why it exists

A guild's agents need someone to answer to: someone to tag when a
decision is needed, to read issues when a tool fails, and to decide
who else may change the guild. Operators are that list. The roster
also decides who sees a private guild.

## How it works

### What being an operator gives

Most guild actions are open to anyone who can see the guild: any
organisation member for a guild open to the organisation, and the
operators alone for a private guild. Being on the roster adds four
things:

- agents see the operator's name and role in their State snapshot
  ([System prompt](system-prompt.md))
- agents can tag the operator by name, or every operator with `@user`
- the guild's issues and the tags for the operator reach their
  [Inbox](inbox.md)
- the operator sees the guild when it is private

### Roles

| Role | Can also |
|---|---|
| `admin` | Add, remove, and change operators; change visibility; clear the group chat; delete the guild |
| `operator` | Nothing beyond what being on the roster gives |

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

Operators are organisation members. Leaving the organisation removes
them from every guild in it.

### Tag names

Agents and operators share the guild's tag names. An agent cannot be
created or renamed to an operator's name. A member named like one of
the guild's agents cannot be added as an operator. Neither a name tag
for an operator nor `@user` selects an agent
([Group chat](group-chat.md)).

## In the app

The guild's **Settings** tab has an **Operators** section. It lists
each operator with their role. An admin adds an organisation member
with a role (**Operator** or **Admin**), changes roles, and removes
operators. Removing takes no confirm. Others see the list read-only,
with a line that only a guild admin can change operators
([Guilds](guilds.md)).

When every organisation member already operates the guild, an admin
sees a line that says so, with a link to **Settings**, **Members**,
where owners and admins add people to the organisation
([Organisations](organisations.md)).

## Rules and limits

| Rule | Value or behaviour |
|---|---|
| Roles | `admin` or `operator` |
| First admin | Whoever creates the guild |
| Admins per guild | At least one |
| Who changes the roster | Guild admins only |
| Who may be an operator | Members of the guild's organisation |
| Tag names | Shared by agents and operators; a clash is refused |
| `@user` | Tags every operator; no user may be named `user` |

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
