# Notes

A note is a Markdown file in the [artifact store](artifacts.md). It
holds long-form knowledge: a finding, a procedure, a glossary, a
decision. Agents write notes with tools, and operators read and edit
them in the app.

A note has an [access list](access.md#access-lists-for-notes-collections-and-files)
and nothing else. The list decides who reads and writes it. A note's
name is unique in its organisation: one name is one note. Structured
rows belong in a [collection](collections.md) instead, bytes that are
not Markdown in a [file](files.md), and what an agent wants its next
runs to remember in its [Memory](memory.md).

## When you use it

- An agent keeps long-form knowledge for its own work: a note it
  creates, which only it writes until an operator shares it.
- A team shares knowledge every member needs: a note with a row for
  the guild.
- Several guilds share knowledge: a note with a row for each guild,
  or for the organisation.
- An operator wants a rule in every run of an agent: a note embedded
  in the agent's [Task](task.md).

## How it works

### One set of notes, flat files

The organisation holds its notes side by side. There are no folders,
and no note belongs to an agent or a guild. A note's name is one
`.md` file name, its key, and its display path is
`org/<org_id>/<key>`.

### How far an agent reaches

An agent reaches a note through its access list alone: the agent's
own row when it has one, otherwise the better of its guild's row and
the organisation's row. No row is no access
([Access](access.md#access-lists-for-notes-collections-and-files)).
The agent that created a note reaches it through the row its creation
wrote, like any other.

A new note starts with one row:

| Created by | Starting row |
|---|---|
| an agent, with `note_write` | that agent at `write` |
| an operator, in the app | the subject and mode the **New note** dialog names, the browsed scope at `write` by default |
| an operator, over HTTP | the `access` row the write names, the organisation at `write` when it names none |
| a recipe | the rows the recipe states, the new guild at `write` when it states none ([Recipe format](recipe-format.md#notes)) |

An operator changes the rows of one note. Opening a note to a second
guild, letting one agent write a note its guild only reads, or
keeping one agent out of a note is a row on that note.

There is one kind of agent. A curator that maintains shared
knowledge is an ordinary agent with `write` on the notes it keeps.

### Writing a note

An agent writes a note in one of two ways:

- **By key.** The agent names the key. When a live note of that key
  exists, the agent updates it if its access is `write`, and is
  refused otherwise. When none exists, the note is created with the
  agent at `write`.
- **By display path.** The agent rewrites the existing note that
  display path names, when its access is `write`.

The agent never names an organisation, guild, or agent id.

An operator writes every note that is not hidden from them
([Access](access.md#access-lists-for-notes-collections-and-files)).

### Finding and linking

Notes are not listed in the system prompt. An agent searches them
with `note_find`, then reads one with `note_get`. Each note
`note_find` returns carries its `access`: `read` or `write`.

`note_write` returns the note's display path. That path is how the
agent links to the note elsewhere, for example from its Memory.

### Embeds and references

An operator embeds a note in an agent's Task with
`![[display-path]]`. Each run then carries the note's text in its
system prompt. A note can embed other notes and collections the same
way. A Task's embeds expand two levels deep: the Task's own embeds,
and the embeds inside those notes. All embedded text in one run
shares a 64 KB budget ([Task](task.md#embeds)).

Embeds are resolved as the agent whose Task it is. A note is inlined
only when its access list gives that agent, its guild, or the
organisation `read` or `write`. Any other embed, a note the agent
cannot read as much as a deleted one, becomes a marker saying the file
is not reachable, and the run still starts
([Task](task.md#an-embed-the-agent-cannot-reach)).

A note that a live Task embeds cannot be deleted. A note that only
another note embeds can be, and that embed then stops reaching a file.

A reference, `[[display-path]]`, adds only the path. The run keeps it
as text, and the agent reads the note with `note_get` when it needs
it. A display path written without brackets names the note the same
way. Prompt Studio's **References** view shows
what embeds or names each note, which agents' prompts it reaches, and
each broken embed with its reason, including the agents whose runs
cannot reach it ([Prompt Studio](prompt-studio.md#state)).

## In the app

The agent's **State › Notes** and the guild's **State › Notes** are
one notes browser over the organisation's one set of notes.

- The agent's view shows three scopes: **Agent**, the notes that
  agent reads; **Guild**, the notes whose access list has a row for
  the guild, one of its agents, or the organisation; and **Org**,
  every note of the organisation.
- The guild's view shows **Guild** and **Org**.

In both:

- A switch above the list picks the scope, with each scope's count.
  One note shows in every scope that lists it.
- Each scope lists its notes side by side, with no folders. The
  search box filters them by name and title.
- **New note** takes a name, `untitled` at first, and the note's
  first access row: a subject and a mode. The row starts as the
  browsed scope at `write`: the agent on **Agent**, the guild on
  **Guild**, the organisation on **Org**. Any subject and mode can be
  picked instead. The name cannot hold a `/`, and it gets `.md` added.
  It cannot be the name of a note the organisation already holds:
  the dialog creates the note only while no note of that name is
  live, and shows the refusal otherwise.
- A note opens in the same Markdown editor as the Task, in preview
  first. Its header shows its name, with **Access**, a copy button,
  and a delete button. In Studio it also has **Ask the coach**.
- - **Insert** adds a note, a table, or a column. A note goes in as
  **Embed** (`![[…]]`) or **Reference** (`[[…]]`). A table goes in as
  an embed, and a column as `` `table.column` `` ([Task](task.md)).
- Clicking an embed previews it: the note's text, or the table's
  purpose. An embed that leads to no note or table the operator can
  see is marked as not reachable.
- Unsaved edits are kept per note while the operator moves between
  notes. Leaving the page with unsaved edits asks **Leave without
  saving?**, with **Discard changes**.
- Save, or Cmd/Ctrl+S, writes the note over the version the editor
  loaded. When someone saved the note in the meantime, the save is
  refused with the warning **Someone saved the note while you were
  editing**, and the operator's text stays in the editor.
- A provenance strip under the file header says who saved it last.
  **Open step** opens the run that wrote it in its agent's Chat tab
  at that tool call. **History** lists every recorded change of the
  notes that held this name and that the operator reads
  ([Artifact store](artifacts.md#file-provenance)).
- A link with a display path opens that note first. A `note_write`
  chip in the chat leads there.
- Deleting a note asks first. A note a live Task embeds is not
  deleted.

The notes browser lists notes only. The agent's Task and Memory have
their own tabs ([Task](task.md), [Memory](memory.md)). Scripts appear
on the agent's **State › Scripts** view ([Scripts](scripts.md)).

An open note has an **Access** button in its header, wherever notes
are browsed: the guild's **State › Notes**, the agent's
**State › Notes**, and Studio. It opens a dialog titled
**Access to `<path>`** with the note's **Access** panel: the
organisation, the guilds, and the agents on its access list, each
with its mode ([Access](access.md#the-access-panel)).

The **Access** sub-tab of the guild's and the agent's **State** lists
the notes that guild's agents, or that agent, reach, each with its
mode. The listing is read only
([Access](access.md#what-a-guild-or-an-agent-reaches)).

The Prompt Studio coach can propose a new note, an edit to a note,
or a note's deletion. The operator applies or declines each one
([Studio proposals](studio-proposals.md)).

## Rules and limits

| Rule | Value or behaviour |
|---|---|
| Note name | one `.md` file name, no `/`, no folders; unique in the organisation |
| Size of one write | 256 KB |
| Live notes and files per organisation | 10 000 together |
| `note_find` results | 20 by default, 100 at most |
| Who reaches a note | the subjects on its access list, and every operator it is not hidden from |
| Starting access | one row: the creating agent at `write`, or the subject the operator names (the organisation at `write` by default) |
| Changing a note's access list | operators only |
| Deleting a note a live Task embeds | refused (409) |
| Embed depth | two levels from the Task |
| Embedded text per run | 64 KB in total |

## Reference

### Note tools

```text
note_find    { query?, limit? }      results { notes }
note_get     { path }                path is a display path
note_write   { key, content }        returns the display path
note_write   { path, content }       returns the display path
note_delete  { path }                returns the display path
```

- `note_find` searches the notes the agent may read: every note whose
  access list gives it `read` or `write`. With a `query` it matches
  whole words of the content (PostgreSQL `simple` text search,
  `websearch_to_tsquery` grammar) or a substring of the title and key,
  ranked by text rank then `updated_at`. An empty `query` lists notes
  by key. `limit` defaults to 20 and is capped at 100. Each note is
  `{ display_path, kind, key, title, author, version, updated_at,
  access, content }`, with `access` `read` or `write`.
- `note_get` returns the display path and the note's text, for a note
  the agent may read. A soft-deleted note returns a tombstone.
- `note_write` with `key`, the `.md` file name, writes the
  organisation's note of that key. An existing note needs `write`. A
  missing one is created with the agent at `write`. A key with a `/`
  or without `.md` is 422 `note key must be a .md file name; notes
  have no folders`.
- `note_write` with `path` rewrites the live note that display path
  names, with `write` on it. The note keeps its key and title. `key`
  is then ignored.
- `note_delete` soft-deletes the note. It needs `write`. `task.md` and
  `memory.md` cannot be deleted.
- A successful write or delete publishes `guild.artifacts.changed`.

Crossing tool families fails with a 422 that names the right tool:

| Call | Answer |
|---|---|
| `note_get` on a collection or record path | `Use record_search or record_list for collection records.` |
| `note_get` on a script | `use script_read for scripts` |
| `note_delete` on a record path | `use record_remove for collection records` |
| `note_delete` on a collection path | `collections are managed by the operator` |
| `note_delete` on a script | `use script_delete for scripts` |
| `note_get` on a file | `use file_fetch for files` |
| `note_delete` on a file | `use file_delete for files` |

`note_get` and `note_delete` answer a `history-archive/…` path as
unknown (404). The Memory archive is not the agent's to read
([Memory](memory.md)).

Other errors:

| Case | Status |
|---|---|
| reading or deleting a note the agent does not reach, or writing one by `path` | 404 `artifact not found` |
| writing or deleting a note the agent only reads, or writing by `key` a note it cannot write | 422 `write not allowed` |
| `note_write` with neither `path` nor `key` | 422 `key or path is required` |
| `note_write` with a `path` that names no live note | 404 `artifact not found` |
| more than 256 KB | 422 `write exceeds 256 KB` |
| the organisation already holds 10 000 live notes and files | 422 `artifact limit reached` |
| deleting a note embedded in a live Task | 409 `note is embedded in task (<agent ids>)` |

### Access list

A note's access list is its `artifact_access` rows with `target_kind`
`note` and the note's id. Operators read it with
`GET /api/notes/:note_id/access` and replace it with
`PUT /api/notes/:note_id/access`. Each change is logged against the
note ([Access](access.md#access-lists)).

Code: `apps/orchestrator/src/artifacts/access-lists.ts`,
`apps/orchestrator/src/artifacts/access.ts`.

### App routes

| View | Route |
|---|---|
| Agent's notes | `/guilds/<guild_id>/agents/<agent_id>/state/notes?path=<display path>` |
| Guild's notes | `/guilds/<guild_id>/state/notes?path=<display path>` |
| Open step | the agent's Chat tab with `?run=<run_id>&call=<tool_call_id>` |

`?path=` is optional. It opens that note first, in the **Org** list,
which holds every note.

### HTTP

The notes browser reads and writes notes over these routes, acting as
the operator:

```text
GET    /api/org/notes                     every note of the organisation, by key
GET    /api/guilds/:guild_id/notes        { own, shared }: the guild's page, by key
GET    /api/agents/:agent_id/notes        { own, shared }: the agent's page, by key
GET    /api/org/notes/*                   one note, by key
PUT    /api/org/notes/*                   { content, expected_version?, access?, home_guild_id? }
DELETE /api/org/notes/*                   204
GET    /api/agents/:agent_id/notes/task.md, …/memory.md
PUT    /api/agents/:agent_id/notes/task.md, …/memory.md    { content, expected_version? }
GET    /api/org/embeddable-notes          every live note the caller may read, by key (500 at most)
GET    /api/org/embeddable-notes?display_path=…   one note: display_path, title, content; 404 if missing
```

Every listing leaves out the notes hidden from the caller. A listing
gives each note `{ id, path, display_path, kind, title, version, home,
viewer_mode }`: `id` names it to the access routes, `home` is
`{ id, name }` of the guild the note is homed in, null for the
organisation's.

A guild's and an agent's page list two sections. `own` holds the notes
homed in the page's guild, whatever their rows. `shared` holds the
notes homed elsewhere or in the organisation whose access list has a
row for the guild, one of its agents, or the organisation. The agent's
page lists the sections of its guild's page.

`viewer_mode` is what the page's viewer reaches:

| List | `viewer_mode` |
|---|---|
| The organisation's | `all_write` or `all_read` from an organisation row; `some` when only guild or agent rows reach agents; `none` when no row reaches one |
| A guild's | `all_write` or `all_read` from an organisation row or the guild's own row, the better of the two; `some` when only rows of the guild's agents reach them; `none` when no row reaches one |
| An agent's | the agent's mode: `write`, `read`, or `none` when no row reaches it | A
read or a write answers `{ id, path, display_path, content, version }`;
`task.md` and `memory.md` carry no `id`. A deleted or missing note is
404. The agent routes serve `task.md` and `memory.md` alone
([Task](task.md), [Memory](memory.md)); of the two, only `task.md`
checks `expected_version`.

`PUT /api/org/notes/*` updates the live note of that key, or creates
it. `expected_version` is an integer: `0` means the note must not
exist yet, and a live note of that key is 409 `artifact already
exists`; any other value must be the live note's version, else 409
`version conflict`; left out, the write is not checked. The New note
dialog sends `0`, and the editor sends the version it loaded.
`access`, `{ type, id, mode }`, is the row a created note starts
with; without it the organisation writes the note. An update ignores
it. An `access` with a bad type, id, or mode is 422 with the message
the access routes give, prefixed `access: `; a subject that does not
exist or is hidden from the caller is 422 `unknown org`,
`unknown guild`, or `unknown agent`. `home_guild_id` is the guild a
created note is homed in; without it the note is the organisation's.
An update keeps the note's home. A `home_guild_id` naming a guild that
does not exist, is outside the organisation, or is a private guild the
caller does not operate is 404 `unknown guild`. A note that exists and
is hidden from the caller is 422 `write not allowed`.

A note write or delete publishes `guild.artifacts.changed` on the
stream of each guild in the note's scope: every guild of the
organisation when its access list has an organisation row, otherwise
each guild a row names, through a row for the guild or for one of its
agents. A Task or Memory write publishes it
on the agent's guild.

A write's `content` is a string, empty when left out. Its
`expected_version` is an integer on `PUT /api/org/notes/*`, and a
number or null on the `task.md` and `memory.md` routes. A body that is not a JSON object,
a field of another type, and a `display_path` given more than once are
422 naming the field, before the caller is identified.

The routes go through `apps/orchestrator/src/notes/operator.ts` and
`apps/orchestrator/src/artifacts/host-files.ts`. The guild and agent
routes need a guild the caller can see. The `/api/org/…` routes need
only organisation membership, and leave out or refuse every note
hidden from the caller
([SEC-55](../architecture/security-register.md#sec-55--a-notes-or-a-files-reach-came-from-its-owner-as-well-as-its-access-list)).

### Storage

A note's display path is `org/<org_id>/<key>`
([Artifact store](artifacts.md#display-paths)).

A note is an `artifacts` row with `kind` `note`, no `agent_id`, a
`key` ending in `.md` with no `/` or `\`, a `title`, and
`content_text`. The key is unique among the organisation's live
notes. Its search document is the content; its search text is the
title and key. Deletion sets `deleted_at`; the tombstone keeps its
access rows, so a note hidden from an operator stays hidden once
deleted. Deleting a guild or an agent removes every note, live or
deleted, whose only rows named it or its agents, with its change
history ([Access](access.md#access-lists)).

Code: `apps/orchestrator/src/artifacts/notes.ts`,
`apps/orchestrator/src/artifacts/memory.ts`,
`apps/orchestrator/src/db/artifacts.ts`,
`apps/orchestrator/src/toolbox/artifacts.ts`.
