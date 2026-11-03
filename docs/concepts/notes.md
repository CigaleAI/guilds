# Notes

A note is a Markdown file in the [artifact store](artifacts.md). It
holds long-form knowledge: a finding, a procedure, a glossary, a
decision. Agents write notes with tools, and operators read and edit
them in the app.

A note has an [access list](access.md#access-lists-for-notes-collections-and-files),
which decides who reads and writes it, and a home guild, which groups
it in the app's lists. A note's name is unique in its organisation:
one name is one note. Structured
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

### Home guild

Every note has a home guild: the guild it was made in, or none when
it is the organisation's.

| Made by | Home |
|---|---|
| an agent, with `note_write` | the agent's guild |
| an operator, in the app | the guild of the page the note is created on: the guild's, or the agent's guild |
| an operator, over HTTP | the guild `home_guild_id` names; none when it names none |
| a recipe | the guild the recipe is applied to |
| a Prompt Studio proposal | the session's guild |

The home is set when the note is made, and no write changes it;
rewriting a note keeps it. One deletion gives a note with no home a
home: deleting an agent of a private guild homes in that guild every
note with no home whose rows named only that agent
([Access](access.md#access-lists)). It does two things. It groups the lists in the app: a guild's page
lists the notes homed in it apart from the notes shared with it
([In the app](#in-the-app)). And it hides: an operator who cannot see
a private guild sees none of the notes homed in it, whatever their
rows say, and a note homed in a guild they can see is never hidden
from them by its rows. The home decides nothing about which agent reaches a note;
that is the access list alone.

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
| an operator, in the app | the subject and mode the **New note** dialog names, the page's guild or agent at `write` by default |
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

An operator writes every note that is not hidden from them: a note
homed in a private guild they do not operate, or one with no home
whose rows all name such guilds or their agents, is hidden; a note
homed in a guild they can see never is
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
one notes browser over the organisation's one set of notes. It lists
them in two sections:

- **Guild notes**: the notes homed in the page's guild, whatever their
  rows. On an agent's page, the page's guild is the agent's.
- **Shared with this guild**: the notes homed in another guild or in
  the organisation whose access list has a row for the guild, one of
  its agents, or the organisation. Each one names its home under its
  name: the guild's name, or **Organisation**.

A note is in one section at most. A note hidden from the operator is
in neither.

Each section has a label with its count and folds open and closed.
It lists its notes by name, with no folders, and says what it holds
when it holds nothing. The search box filters both sections by name
and title.

Each note carries a tag that says how the page reaches it:

| Page | Tag |
|---|---|
| A guild's | **All agents · read & write** when an organisation row or the guild's own row gives write and no row for one of the guild's agents gives less; **All agents · read** when such a row reaches every agent and no row for one of them is at none, so every agent reads at least; **Some agents** when a row at none shuts one of its agents out, or only rows for some of its agents reach them; **No access** when no row reaches any |
| An agent's | **Read & write** or **Read**, the agent's own mode; **No access** when no row reaches the agent |

A note tagged **No access** is greyed. Clicking it opens its access
dialog instead of the note, so the operator can give the page a row.
Any other note opens in the editor. The browser opens the note a link
names, or else the first note the page reaches; it never opens a
greyed note by itself. The open note stays open when the list
refreshes, after an access change or an agent's write, even when it
becomes greyed. A link that names a note the page does not list opens
no other note: the editor pane says **Not listed on this page**, and
no note is selected. When every listed note is greyed, the editor
pane says that no row reaches them.

- **New note** takes a name, `untitled` at first, and the note's
  first access row: a subject and a mode. The row starts as the
  page's guild or agent at `write`; any subject and mode can be
  picked instead. The dialog shows the note's **Home**, the page's
  guild, read only, beside the row. The name cannot hold a `/`, and
  it gets `.md` added. It cannot be the name of a note the
  organisation already holds: the dialog creates the note only while
  no note of that name is live, and shows the refusal otherwise.
- A note opens in the same Markdown editor as the Task, in preview
  first. Its header shows its name, with **Access**, a copy button,
  and a delete button. In Studio it also has **Ask the coach**.
- **Insert** adds a note, a table, or a column. A note goes in as
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
with its mode ([Access](access.md#the-access-panel)). A greyed note
opens the same dialog. A change to the list refreshes both sections,
the files lists, and the notes a Task can embed at once, so a note
the change reaches loses its grey, and one it no longer reaches
gains it.

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
| Home guild | the guild the note is made in, or none; no write changes it; groups the lists and hides the note from operators who cannot see that guild; never decides an agent's reach |
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
- A successful write or delete publishes `guild.artifacts.changed`
  to the guilds an operator's write of that note is published to
  ([HTTP](#http)): the note's private home alone, otherwise its home
  and the guilds in its scope.

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

`?path=` is optional. It opens that note first, in whichever section
lists it, greyed or not. A path neither section lists opens no note;
the editor pane says **Not listed on this page**.

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
GET    /api/org/embeddable-notes?agent_id=…       { own, shared }: the agent's page, each note with its text
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
page lists the sections of its guild's page. Each section is ordered
by key.

`viewer_mode` is what the page's viewer reaches:

| List | `viewer_mode` |
|---|---|
| The organisation's | `all_write` from an organisation row at `write` with no agent row at `read` or `none`; `all_read` from an organisation row with no agent row at `none`; `some` when an agent row at `none` shuts an agent out of the organisation row, or only guild or agent rows reach agents; `none` when no row reaches one |
| A guild's | `all_write` from an organisation row or the guild's own row at `write`, with no row at `read` or `none` for one of the guild's agents; `all_read` from either row with no row at `none` for one of the guild's agents; `some` when such a row shuts one of them out, or only rows of the guild's agents reach them; `none` when no row reaches one |
| An agent's | the agent's mode: `write`, `read`, or `none` when no row reaches it |

Each listing reads every note's `viewer_mode` and home in the same
query as the notes.

With `agent_id`, the embeddable notes are the two sections of that
agent's page, each note as `note_find` gives it, with its `id`,
`home`, and the agent's `viewer_mode`; an agent the caller cannot see
is 404. `display_path` names one note, whatever `agent_id` says.

A read or a write answers `{ id, path, display_path, content, version }`;
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
created note is homed in; without it, or empty, the note is the
organisation's. The New note dialog sends the page's guild. An update
keeps the note's home, whatever `home_guild_id` names. A
`home_guild_id` naming a guild that does not exist, is outside the
organisation, or is a private guild the caller does not operate is
404 `unknown guild`, and so is a guild deleted between that check and
the note's insert. A note that exists and
is hidden from the caller is 422 `write not allowed`.

A note write or delete publishes `guild.artifacts.changed` on the
stream of each guild whose page lists the note: its home guild, and
each guild in its scope, which is every guild of the organisation when
its access list has an organisation row, otherwise each guild a row
names, through a row for the guild or for one of its agents. A note
homed in a private guild is announced on that guild's stream alone,
so its name reaches no other guild's listeners. The guilds come from
every row of the list, those of guilds hidden from the writer
included. A replaced access list publishes it the same way, to the
guilds named before the change and those named after
([Access](access.md#access-lists)). A Task or Memory write publishes
it on the agent's guild.

A write's `content` is a string, empty when left out. Its
`expected_version` is an integer on `PUT /api/org/notes/*`, and a
number or null on the `task.md` and `memory.md` routes. A body that is not a JSON object,
a field of another type, and a `display_path` given more than once are
422 naming the field, before the caller is identified.

The routes go through `apps/orchestrator/src/notes/operator.ts` and
`apps/orchestrator/src/artifacts/host-files.ts`. The guild and agent
routes need a guild the caller can see. The `/api/org/…` routes need
only organisation membership, and leave out or refuse every note
hidden from the caller, by its rows
([SEC-55](../architecture/security-register.md#sec-55--a-notes-or-a-files-reach-came-from-its-owner-as-well-as-its-access-list))
or by its home
([SEC-57](../architecture/security-register.md#sec-57--an-operator-could-see-a-private-guilds-notes-and-files-through-an-organisation-row)).

### Storage

A note's display path is `org/<org_id>/<key>`
([Artifact store](artifacts.md#display-paths)).

A note is an `artifacts` row with `kind` `note`, no `agent_id`, a
`key` ending in `.md` with no `/` or `\`, a `title`, and
`content_text`. Its `origin_guild_id` is its home guild, null for the
organisation's ([Artifact store](artifacts.md#kinds)). The key is
unique among the organisation's live notes. Its search document is
the content; its search text is the title and key. Deletion sets
`deleted_at`; the tombstone keeps its access rows and its home, so a
note hidden from an operator stays hidden once deleted. Deleting a
private guild removes, live or deleted, with its change history,
every note homed in it and every note with no home whose rows named
only the guild or its agents; deleting another guild leaves its notes
to the organisation. Deleting an agent removes only its rows, after
an agent of a private guild has homed in that guild the notes with no
home that only its rows reached
([Access](access.md#access-lists)).

Code: `apps/orchestrator/src/artifacts/notes.ts`,
`apps/orchestrator/src/artifacts/memory.ts`,
`apps/orchestrator/src/db/artifacts.ts`,
`apps/orchestrator/src/db/artifact-lists.ts`,
`apps/orchestrator/src/toolbox/artifacts.ts`.
