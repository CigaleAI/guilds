# Guilds

A guild is a standing team of [agents](agents.md) inside an
[organisation](organisations.md). It has one [group chat](group-chat.md)
where its agents and its [operators](operators.md) talk, shared
[notes](notes.md) and [collections](collections.md) its agents write
together, and a short statement of what it is for. The operator can
create an empty guild and add agents later.

Each agent belongs to one guild. The guild sets the agents' common
goal; each agent's [Task](task.md) sets its own part of the work.

## Why it exists

One agent with one prompt covers one job. A guild splits a larger job
into roles that work side by side, see each other's posts, and keep
their shared knowledge in one place. The guild is also the unit an
operator watches, saves as a [recipe](recipes.md), and deletes.

## How it works

### What a guild owns

```mermaid
flowchart TD
  guild[Guild] --> agents[Agents, up to max_agents]
  guild --> chat[One group chat]
  guild --> ops[Operators]
  guild --> notes[Guild-level notes]
  guild --> tables[The guild's own collections]
  guild --> repos[Repositories]
```

- **Agents.** Zero or more, up to the guild's agent limit. Each one
  also owns its own Task, Memory, scripts, and agent-level notes.
- **One group chat.** Its public history is shared by every member
  ([Group chat](group-chat.md)).
- **Operators.** The people the guild works for
  ([Operators](operators.md)).
- **Guild-level notes.** Each starts read and written by its agents
  ([Notes](notes.md)).
- **Its own collections.** A collection that belongs to the guild
  starts read and written by its agents
  ([Collections](collections.md)).
- **Repositories** its coding agents work in
  ([Repositories](coding/repositories.md)).

Which notes and collections an agent reaches is set on each item,
in its access list. A row for the guild covers every agent of the
guild ([Access](access.md#access-lists-for-notes-collections-and-files)).

### Purpose: short description and description

A guild has an optional **short description** (at most 200
characters) and an optional **description** (at most 8000
characters, Markdown). Both go into every agent's system prompt, in
the State snapshot. Members then know the guild's goal and each
other's role ([System prompt](system-prompt.md)). The short
description also shows in the guild header.

### The agent limit

The agent limit (default 15) is how many agents the guild can hold.
Creating another agent is refused when that would pass the limit.
Applying a recipe that would pass it is also refused
([Applying recipes](applying-recipes.md)). The limit can be set below
the current number of agents. The agents stay, and no new one fits.

### Visibility

A guild is open to the organisation or private.

- An organisation guild is listed to every organisation member.
- A private guild is listed and readable only by its operators.

The create dialog defaults to private. Only a guild admin changes
visibility.

### Other guild settings

- **Routines** can be held for the whole guild with one switch
  ([Routines](routines.md)).
- **Agent turns in a row** is how many agent messages the group chat
  takes before an operator must post
  ([Group chat](group-chat.md#the-agent-message-limit)).
- **Commit author email** is the address coding agents put on
  commits. Empty, each agent uses its own platform address
  ([Repositories](coding/repositories.md)).

### Renaming

A new name follows the same rules as at create and stays unique in
the organisation. A guild cannot be renamed while it is being
deleted, or while one of its agents is generating. Its host notes
folder moves with the name. Artifact paths use the guild's id, so
they do not change.

### Deleting

Deleting a guild is an admin action. It is refused while an agent of
the guild is generating or while the group chat is delivering. The
guild takes with it its agents and everything they own, its group
chat, operators, issues, notes, own collections, repositories, and
the secrets that only it or its agents held. Organisation collections
and secrets granted elsewhere stay, and so do the machines
([Delete](#delete) has the full list).

## In the app

### The sidebar

The sidebar lists the current organisation's guilds.

- A guild row shows its name, a lock when private, and its unread
  count ([Group chat](group-chat.md#what-the-operator-has-read)).
- It folds open to its agents and an **Add agent** row
  ([Agents](agents.md#sidebar)).
- **+** on the **Guilds** header opens the create-guild dialog.

The footer links to **Inbox** ([Inbox and issues](inbox.md)),
**Builder** ([Guild builder](guild-builder.md)), **Recipes**
([Recipes](recipes.md)), and **Tables**
([Collections](collections.md)). The account button sits below them
([Users](users.md#the-account-menu)).

The sidebar retracts to a rail of guild initials, the footer's tool
icons, and a **Settings** icon. A guild's unread count sits on its
tile. ⌘B, or Ctrl+B, folds it and opens it again. On a phone it opens
as a drawer from a top bar. Folded guilds and the retracted state are
remembered in the browser.

### Create a guild

**Create a guild** says that the creator becomes its admin. It takes:

- **Name**, required, with a hint on the allowed characters
- **Short description**, optional, 200 characters, shown in the
  guild header and to agents
- **Description**, optional, Markdown, 8000 characters; agents read
  it on every run
- **Private**, on by default: only the guild's operators see it, and
  operators are added from Settings

**Create guild** opens the new guild. A refusal shows in the dialog.

### The guild header

A guild opens at `/guilds/<id>` under its header. The header shows:

- the name
- a lock when private
- the first five agent avatars; a click opens that agent's inspector
- the agent count against the agent limit
- a **Routines off** chip while the guild's routines are held
- an **N agents active** pill while agents generate
- on a wide screen, the short description
- the message-budget button
  ([Group chat](group-chat.md#the-message-budget-button))

The options menu offers:

- **Open in Studio**: the guild's live Studio session if there is
  one, otherwise the Studio landing for the guild
  ([Prompt Studio](prompt-studio.md))
- **New agent**, which reads **New agent (full at N)** and is
  disabled once the guild is full
- **Save as recipe**: captures the guild as a draft recipe and opens
  it ([Recipes](recipes.md))
- **Guild settings**
- **Clear group chat**, for admins, after a separator: deletes every
  message for everyone once confirmed
  ([Group chat](group-chat.md#clearing-the-chat))

While a recipe apply is still open, a strip under the tabs says the
routines stay paused until its checklist is done, and links to it
([Applying recipes](applying-recipes.md)).

The tabs, one route each:

| Tab | Explained in |
|---|---|
| **Group chat** | [Group chat](group-chat.md) |
| **Settings** | Below |
| **State** (Files, Tables, Access) | [Notes](notes.md), [Collections](collections.md#what-a-guild-or-an-agent-reaches), [Access](access.md#what-a-guild-or-an-agent-reaches) |
| **Routines** | [Routines](routines.md) |
| **Issues** | [Inbox and issues](inbox.md) |
| **Tools**, **Secrets** | [Access](access.md) |
| **Usage** | [Usage](usage.md) |

### The Settings tab

The guild's **Settings** tab, in this order:

- **Identity**: **Name**, shown in the sidebar and header.
- **Purpose**: **Short description**, and **Description** with
  **Write** and **Preview**.
- **Limits**: **Agents**, the agent limit, with the guild's current
  agent count; and **Agent turns in a row**.
- **Behaviour**: **Routines fire on schedule**. Turning it off holds
  every routine; paused routines stay paused. For admins, **Private**.
- **Operators**: the roster ([Operators](operators.md)).
- **Git**: **Commit author email**, with a hint that empty uses each
  agent's platform address.
- **Repositories**: the guild's repositories
  ([Repositories](coding/repositories.md)).
- **Delete**, for admins.

A bar at the bottom shows **Unsaved changes**, with **Discard** and
**Save**. **Save** writes the name, purpose, limits, routines,
visibility, and commit author email together.

**Delete guild** explains that the guild's group chat and its agents,
with their sessions, notes, and homes, are removed, and that their
machines stay. The confirm asks for the guild's name to be typed. The
app then returns to `/`.

## Rules and limits

| Rule | Value or behaviour |
|---|---|
| Name | Lowercase letter first, then lowercase letters, digits, and hyphens; 63 characters at most |
| Name in the organisation | Unique |
| Short description | At most 200 characters |
| Description | At most 8000 characters |
| Commit author email | Empty, or one address with a dotted domain; at most 254 characters; no `.invalid` domain |
| Agent limit | Default 15; a whole number of at least 1; may sit below the current count |
| Agents past the limit | Refused, by create and by recipe apply |
| Visibility | Organisation or private; private in the create dialog |
| First admin | The creator |
| Visibility change, clearing the group chat, and delete | Guild admins only |
| Rename | Refused while being deleted or while an agent generates |
| Delete | Refused while an agent generates or the group chat is delivering |
| Guilds per organisation | No cap in core; an extension's policy may set one |

## Reference

### Fields

The `guilds` table:

| Column | Meaning |
|---|---|
| `id` | The guild id |
| `org_id` | The owning organisation |
| `name` | Matches `^[a-z][a-z0-9-]{0,62}$`, unique per organisation (`guilds_org_name_unique`) |
| `about` | The short description, trimmed, at most 200 characters |
| `description` | The description, trimmed, at most 8000 characters |
| `max_agents` | The agent limit, default 15, positive |
| `visibility` | `org` or `private`; default `org`. An empty value or `null` also means `org` |
| `routines_enabled` | Whether routines fire, default true ([Routines](routines.md)) |
| `git_author_email` | The commit author email, empty for none ([Repositories](coding/repositories.md)) |
| `group_chat_seq`, `group_agent_message_count`, `group_agent_message_limit`, `group_chat_errors`, `group_chat_cleared_at` | Group-chat state ([Group chat](group-chat.md)). Every create path sets `group_agent_message_limit` to 200 |
| `created_at`, `updated_at` | Timestamps |

About and description reach the State snapshot as `group.about` and
`group.description`. Guild payloads carry `operators`
([Operators](operators.md)).

Code: `apps/orchestrator/src/guilds/validation.ts`,
`apps/orchestrator/src/guilds/service.ts`.

### Create

`POST /api/guilds` takes `name`, and optional `about`, `description`,
and `visibility` (default `org` when left out). It writes the guild
row in PostgreSQL with `about`, `description`, and `max_agents`
(default 15), makes the caller its first admin, and creates its host
notes folder `orgs/<org slug>/guilds/<name>/shared` under the notes
root. 201.

- 422 for an invalid name, about, description, or visibility.
- 409 `guild name already exists`.
- 409 when the organisation policy caps guilds.
- A host folder that already exists refuses the create, and the row
  is removed.

`GET /api/guilds` lists the guilds of the current organisation the
caller can see. `GET /api/guilds/:id` returns one. A guild the caller
cannot see is 404.

### Edit

`PUT /api/guilds/:id` takes `name`, `about`, `description`,
`max_agents`, `git_author_email`, `visibility`, and
`routines_enabled`. A field left out keeps its value. It returns the
guild. `name`, `about` and `description` are strings, `max_agents` a
number, `git_author_email` and `visibility` a string or null, and
`routines_enabled` a boolean; a create takes the same types.

- 422 for a field of another type, naming it.
- 422 for an invalid value: `max_agents must be a positive integer`,
  `visibility must be org or
  private`, `git_author_email must be a single email address`,
  `git_author_email must not use a .invalid domain`, and the name,
  about, description, and email length rules.
- A visibility change takes a guild admin (403 otherwise).
- 409 `guild name already exists`.
- 409 `guild is being deleted` on a rename during deletion.
- 409 `a member agent is already generating` on a rename while an
  agent generates.
- A rename moves the host notes folder. When the move fails, the name
  goes back.
- Turning `routines_enabled` back on releases the guild's due
  routines ([Routines](routines.md)).

`PUT /api/guilds/:id/group-chat` takes `agent_message_limit`
([Group chat](group-chat.md)).

The Settings tab saves the name, about, description, `max_agents`,
commit author email, visibility, and routines through the first
route, and the message limit through the second.

### Delete

`DELETE /api/guilds/:id` takes a guild admin (403 otherwise; 404 when
the caller cannot see the guild). 204.

- 409 `guild is already being deleted`.
- 409 `guild group chat is delivering`.
- 409 `a member agent is already generating`.

It holds every agent of the guild while it runs. It then:

- for each agent, stops its Chrome and terminal on its machine, and
  removes its home and its `/run/guilds/<agent id>/` files; the
  machine's container stays up for the other agents on it
  ([Machines](machines.md))
- removes the guild's host notes folder
- deletes the guild's and its agents' usage counters
- soft-deletes the guild's own collections with their records
- deletes the access-list rows that name the guild or its agents,
  and the rows on its own collections and on its and its agents'
  notes
- deletes every secret, not organisation-wide, whose grants all name
  the guild or its agents
- deletes the guild row

PostgreSQL cascades:

- agents
- runs
- group history and read cursors
- operators
- secret grants
- connections
- scoped bindings
- guild issues
- guild-level artifacts
- guild repositories

Studio sessions, Studio drafts, recipes, and recipe applies that name
the guild stay, with that reference cleared.

Organisation collections and their records stay. Organisation and
global usage totals stay.

These stay:

- organisation-wide and unassigned secrets
- secrets with a grant elsewhere
- instance bindings
- the connector catalog

Names may be reused.
