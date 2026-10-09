# Notes and collections

Notes, collection records, `memory`, and scripts live in the
PostgreSQL artifact store: one `artifacts` table. Its kinds are:

- `note` (agent, guild, org)
- `object` (a collection record)
- `memory` (agent)
- `script` (agent)

Collections themselves are `artifact_collections` rows, not artifact
kinds. The operator-owned standing task lives on the agent row
(`agents.task`).

Tool families stay split so the model does not mix Markdown,
records, memory, and executable source.

The Host Finder lists, reads, and writes notes over HTTP. Agents
write notes with `note_write` at an explicit level (`agent`,
`guild`, or `org`). They write records with `record_add` /
`record_update` into tables the operator defined and granted.

Agents never mount artifact rows. The orchestrator's tools read and
write them. Records reach a sandbox only inside tool results.

Each durable datum has one canonical home:

- `task` is the operator-owned standing purpose (`agents.task`).
- `memory` is the agent's private free-form text for future runs.
- agent-level notes hold task-specific long-form or personal
  knowledge.
- guild- and organisation-level notes hold collaborative long-form
  knowledge.
- collections hold structured records at the organisation.
- agent-level scripts hold sandbox Python the run materialises.
- PostgreSQL run and group-chat rows hold exact message history.

State is a read-only run-creation projection of those resources
([Prompts and memory](prompts-and-memory.md)). Notes may summarize a
conversation into a durable finding. The exact transcript remains in
run or group history.

## Display paths

Display paths are the unique reference (`org/<org_id>/…`). The owner
prefix is a property of the level.

For a note the model sends `level` and `key`. It never supplies
`org_id`, `guild_id`, or `agent_id`. For a record it sends the
collection name and the id.

```text
org/<org_id>/agents/<agent_id>/task.md
org/<org_id>/agents/<agent_id>/memory.md
org/<org_id>/agents/<agent_id>/history-archive/<stamp>-<source>.md
org/<org_id>/agents/<agent_id>/scripts/<name>
org/<org_id>/agents/<agent_id>/<note>.md
org/<org_id>/guilds/<guild_id>/<note>.md
org/<org_id>/collections/<name>
org/<org_id>/collections/<name>/<id>
org/<org_id>/<note>.md
```

Notes are flat: `{ownerPrefix}{key}`, where `key` is one `.md` file
name with no `/`. Each level holds its notes side by side. The
Finder lists them that way, one scope at a time.

A collection is `org/<org_id>/collections/<name>`. A record is that
path plus the record id. Scripts are `{ownerPrefix}scripts/{name}`
(agent only).

A note key ends in `.md`, so it never shadows `collections/`,
`agents/`, `guilds/`, `scripts/`, or `history-archive/`.

Reserved agent-root keys: `task.md`, `memory.md`.

`task.md` is a virtual Host path over `agents.task`. `memory` is an
artifact. Neither is deletable.

`history-archive/<stamp>-<source>.md` names a previous memory
version. Only the operator resolves it.

Paths use organisation, guild, and agent ids, not names. A renamed
or reused name keeps or gets a fresh path.

Display paths from tool results are the canonical reference. Short
`[[name]]` in prose is not rewritten.

## Notes

Notes exist at three levels: agent, guild, and organisation. Reach
over them is the four grant bindings on the agent:

- `read_guild`
- `read_org`
- `write_guild`
- `write_org`

Defaults: `guild` read, `guild` write, and `org` read on. `org`
write off.

Agent-level read and write are always on for that agent. `guild`
always means the agent's own guild. No agent reads another guild's
guild-level notes.

Cross-team sharing is an org-level note or a collection. There is
one agent type. A curator is an ordinary agent with `org` write.

The four bindings govern notes only. Collection reach is a separate
grant ([below](#access)).

Caps:

- 256 KB per write
- 10 000 live artifacts per owner (records excepted)
- 64 KB embed budget
- `note_find` 20 by default and 100 at most

Authorization is the application store, the four note grants, and
the collection grants. There is no row-level security on these
tables.

### Note tools

```text
note_find    { query, level?, limit? }   results { notes }
note_get     { path }                    display path
note_write   { level, key, content }
note_delete  { path }
```

`note_write` takes `level` (`agent`, `guild`, or `org`) and `key`
(the `.md` file name). A key with a `/` is refused.

`note_get` and `note_delete` answer a `history-archive/…` path as
unknown. The memory archive is not the agent's to read.

Host Insert note and Insert table store `![[display-path]]` in
`task`. A note embed inlines the body and one nested hop.

A collection embed becomes the table name. Inlining does not grant
`note_get`.

The Host rejects the delete or move of a note a live `task` still
embeds.

Crossing families fails with a 422 that names the right tool:

- `note_get` on a collection or record path points at
  `record_search` and `record_list`
- `note_delete` on a record path at `record_remove`
- `note_delete` on a collection path says collections are managed
  by the operator

## Collections

A collection is a typed table at the organisation. The operator
creates it on the Databases page, or applies a Studio coach's
proposal to create, change, or delete one
([Prompt Studio](prompt-studio.md)).

Agents never create, alter, or delete a table.

Records live in the artifact store as `kind` `object`. Tools are:

- `record_search`
- `record_list`
- `record_add`
- `record_update`
- `record_remove`

Names are unique per organisation among live tables and match
`^[a-z][a-z0-9_-]{0,62}$`. `purpose` is required and at most 400
characters.

The row (`artifact_collections`) holds the name, the purpose, the
`columns`, `next_id`, and `guild_id`:

- set, the table belongs to that guild (`scope: "guild"`)
- null, it is an organisation table (`scope: "org"`)

A name is taken at the organisation whatever the scope. Two guilds
cannot both own a `queue`.

Records are organisation-level artifacts. `key` is the decimal id.

`content_json` holds the declared columns only. `identity` holds the
normalised unique value.

There is no guild or agent form and no folder inside a collection.

Caps:

- 100 live collections per organisation
- 10 000 live records per collection
- 64 columns
- 32 KB of indexed value text per record

Not built:

- SQL for agents
- aggregation beyond `record_list`'s `total`
- nested object columns (a many-to-many of records is a second
  collection)
- deny grants and per-column permissions
- sharing a collection across organisations
- sandbox scripts reading the store

### Columns

`apps/orchestrator/src/artifacts/columns.ts` is the column dialect.
Each column is `{ name, type, description, required, unique,
values }`:

| Field | Rule |
|---|---|
| `name` | `^[a-z][a-z0-9_]{0,63}$`, unique in the collection; `id`, `created_at`, `updated_at`, `created_by`, and `updated_by` are reserved |
| `type` | `text`, `number`, `boolean`, `datetime`, or `array` |
| `description` | required, at most 200 characters; State prints it to the agents |
| `required` | default false |
| `unique` | default false; `text` or `number` only; at most one per collection |
| `values` | `text` or `array` only: 1 to 50 distinct non-empty strings of at most 64 characters; the column then accepts only those |

A value is accepted by its column's type only:

- a string for `text` (one of `values` when the column lists them)
- a finite JSON number for `number`
- `true` or `false` for `boolean`
- an ISO 8601 string with a timezone for `datetime` (stored
  normalised to UTC)
- a JSON list of distinct non-empty strings for `array` (at most 50
  items, each at most 200 characters; one of `values` when the
  column lists them)

`[]` is a value, not a missing column. There is no coercion (`"42"`
in a number column is an error). There is no nested object type.

Changing the columns of a live collection is applied to the records
in the same transaction:

- a renamed column (`rename_from` on the new definition) moves its
  key in every live record
- a removed column drops it
- a column that becomes unique is refused with 409 while live
  records repeat a value
- the search text is rebuilt

Retyping a column or changing its `values` leaves stored values as
they are. They surface as `warnings` on the next `record_update` of
that record.

### Writes and ids

`record_add` validates the whole body. An unknown column, a missing
required column, a wrong type, a value outside `values`, or an
unparsable datetime is a problem. Every problem is reported in one
422 with nothing written:

```text
record rejected
- column "status": expected one of new, contacted, won, lost; got "pending"
- column "score": expected number; got "42"
- column "notes": unknown column; declared columns are email, status, score, signed_up_at
```

The store then locks the collection row, takes `next_id` as the
record's id, writes the record with `key` equal to its decimal
form, and increments the counter in the same transaction.

Ids start at 1 and are never reused. A removed record keeps its id.

`record_update` merges a patch. The columns present are validated by
the same rules.

`null` clears an optional column and is a problem on a required
one. The rest of the record is kept.

After the merge the store checks the whole record against the
current columns. It returns problems in columns the patch did not
touch as `warnings` without rejecting the write.

`record_remove` soft-deletes one record.

All three need `write`. An unknown id is 404.

The operator can drop every live record at once without deleting
the table. Ids are still never reused.

### Unique column

The store derives `identity` from the unique column on every write.
Text is NFC-normalised, trimmed, and lowercased. A number is its
decimal string.

A `record_add` whose identity already exists among the live records
becomes an update of that record with the sent body as the patch.
The result carries `note: merged into existing record <id>` (the
HTTP API returns `merged: <id>`).

A `record_update` that moves the unique column onto another
record's value fails with 409 naming that record.

A partial unique index on (`collection_id`, `identity`) over live
records backs the rule. The comparison is exact, never by
similarity.

### Records as returned

Every record a tool or the API returns carries:

- `id`
- `collection`
- the declared columns
- `created_at`
- `updated_at`
- `updated_by`
- `version`

The API adds `display_path`. The body holds declared columns only.

### Record tools

Five tools, each naming the table by `collection`:

```text
record_search  { collection?, query, where?, limit? }
record_list    { collection, where?, since?, order?, limit?, offset? }
record_add     { collection, body }
record_update  { collection, id, body }
record_remove  { collection, id }
```

`record_add` takes `body` (declared columns only). It validates
every value. It rejects with every problem at once (422
`record rejected`).

It assigns the id and returns `{ record }` plus
`note: merged into existing record <id>` when the unique column
matched a live record.

`record_update` takes `id` and a `body` of the columns that change
(`null` clears an optional column). It returns
`{ record, warnings? }`.

`record_remove` soft-deletes by `id` and returns `{ removed }`.

A successful `record_add` publishes `guild.files.changed` for the
collection path. `record_update` and `record_remove` publish it for
the record path.

### Search

Search is lexical (`tsvector`, `simple` configuration), with
`pg_trgm` similarity on one text or open array column at a time.
There are no embeddings.

Each record is indexed on its id and `search_blob`: every value in
the body as text, keys left out so that a column name shared by
every record never matches. `identity` is not indexed.

`record_search` takes `query` in the `websearch_to_tsquery`
grammar:

- terms are ANDed
- `OR` widens
- quotes keep a phrase
- `-` excludes

A query that is one token also matches the value text by substring.
A partial identifier hits.

It is not fuzzy. A misspelled word finds nothing.

Without `collection` it runs over every collection the agent can
read. Each hit carries `collection`.

With `collection`, `where` narrows the hits by column. `where`
without `collection` is a 422.

Results are ranked by `ts_rank_cd` plus the similarity of every
text or open-array `where` term, then by `updated_at`. `limit` is
20 by default and at most 100.

The Databases page's record search runs the same predicate.

`record_list` lists one collection:

- `where`: `{ column: term }`, at most 8 columns, a term at most
  200 characters; `id` is allowed.
- `since`: an ISO 8601 timestamp; only records created or updated
  at or after it.
- `order`: `{ column, direction }` (or the string `"column desc"`)
  over a declared column (not an `array`), `id`, `created_at`, or
  `updated_at`. Default `id asc`. With `since`, default
  `updated_at asc`. A schedule wake-up carries `previous_run_at`, so
  a routine can pick up exactly what changed since it last fired.
- `limit` 20 by default and at most 100; `offset` 0 or more.

A `where` term matches by the column's type:

| Column | Term matches by |
|---|---|
| `text` | substring, plus similar spelling (`word_similarity` ≥ 0.5) when the term has no digit |
| `text` with `values` | exact; a term outside the list is a 422 naming the allowed values |
| `number`, `datetime` | exact, or `{ "gte": v }`, `{ "lte": v }`, or both |
| `boolean`, `id` | exact |
| `array` | an item by substring, plus similar spelling when the term has no digit |
| `array` with `values` | contains that text item exactly; a term outside the list is a 422 |
| any | `null` matches a missing or null value |

The result is `{ total, records }`. `total` counts every record
matching `where` and `since` regardless of paging. `where` with
`id` reads one record.

Similar spelling is scoped to one text or open array column.

Against a whole record's text a short token matches too many
neighbours. A term with a digit (dates, hashes, addresses, versions)
has neighbours that look alike. Both stay substring-only.

The 0.5 floor means a transposition in a five-letter word still
hits. Two six-letter words that merely share a prefix do not.

A narrowed `record_list` (`where` or `since`) that matches nothing
returns a `hint` that explains itself:

- what was asked
- how many records the collection holds and when the newest
  changed
- the declared columns with their types and flags
- that a larger limit will not change the answer

With `since` it adds that existence checks use `where` on the
unique column or `record_search`. Otherwise it restates how `where`
matches by type and that `record_search` matches words in the
values.

A queue or hand-off collection carries its state in a text column
with `values` written on every record. Consumers find work with
`where` on it. Existence checks use `where` on the unique column or
one `record_search` with `OR`.

## Access

A grant is one `collection_access` row: `subject_type` `guild` or
`agent`, `subject_id`, and `mode`, one row per subject and
collection.

A guild row is the base mode for its members and is `read` or
`write`. An agent row is that agent's override and may also be
`none`, the explicit refusal.

The mode an agent ends up with is its own row when it has one,
otherwise its guild's base. `none`, or no base and no row, is no
access:

```text
effective = agent row ?? guild base        write implies read
```

A guild's own table takes no guild grant. Every agent in that guild
has `write` on it as its base. No other guild reaches it.

A guild row on it is refused with 422. Deleting the guild
soft-deletes the table with its records.

An agent row of that guild still overrides that base. A single
member can be held back.

Moving a table to a guild drops every grant. Moving it to the
organisation keeps the former guild's reach as a `write` grant.

A guild grant covers every agent in the guild, including agents
added later. One member is held back with an agent row:

- `none` keeps it out of a table the rest of the guild reaches
- `read` holds it to reading where the guild writes
- `write` raises it above a guild that only reads

An agent row on a guild's own table is accepted only for an agent
of that guild.

A tool call on a collection the agent cannot read fails with 404
(`unknown collection <name>`) as if it did not exist. A write with
`read` fails with 403 naming the collection.

Organisation members reach every collection with `write` through
the Databases page and the HTTP API.

Deleting a guild or an agent deletes its grant rows. Deleting a
collection soft-deletes its records and drops its grants. Clearing
a collection's records leaves the table and its grants.

The four note grant bindings do not touch collections.

State lists every collection the agent is granted, capped at 50,
each with `name`, `purpose`, `access` (`read` or `write`), `scope`
(`guild` or `org`), `display_path`, and `columns`. Past the cap one
more entry carries `truncated: true`.

## File provenance

Every successful note, memory, record, script, or task mutation
appends a `file_changes` row in the same transaction as the write.
The row keeps the canonical display path, operation, resulting
version, actor, and time. A run-owned change also carries the run
id and tool-call id/name.

The orchestrator supplies this context. Agent tool schemas contain
only the arguments needed for the operation. Human edits use the
authenticated user actor.

`GET /api/file-changes?display_path=…` returns the newest-first
history. A run-owned change expands to the run's agent, guild,
kind, status, and routine.

`GET /api/file-changes/latest?display_paths=a,b` (or a POST with
`display_paths` in the body) returns the newest change per path in
one call.

A path with no recorded change but a live row falls back to that
row's last-saved facts (`recorded: false`, the saver's name, the
version, and the time).

The operator sees this as a provenance strip under a file:

- in the notes browser
- on the agent's Prompt tab and State's Memory and Scripts views
- in the Databases page record dialog
- in the Studio inspector

**Open step** opens the writing run at that tool call (in the
agent's Chat tab, or in Studio's History tab inside Studio).
**History** expands the full change list.

## What is not an artifact

Routines stay on `schedules.instruction`. The live standing task
stays on `agents.task`.

Previous `memory` versions stay on `memory_revisions`. Previous
operator `task` saves stay on `task_revisions` (cap 50).

None of those are kinds. None appear in `note_find` or
`record_search`.

Scripts are an artifact kind (`script`, agent only) with their own
tools. They do not appear in note or record search. The Notes view
does not list them.

Collection grants are `collection_access` rows, not artifacts. Run
transcripts are not artifacts. There is no search over runs.

## Operator views

The Host Finder lists notes over HTTP. A laptop or phone sees
current Markdown.

The agent's **State** tab's **Notes** view and the guild's **State**
tab's **Files** view share the notes browser:

- scopes, each listing its notes side by side
- the open note to edit with embeds and provenance
- new and deleted notes

Scripts appear on the agent's State **Scripts** view, not in Files.

Collection records appear on the **Databases** page:

- the organisation's tables by owner
- records with search, filters, sort, paging and refresh
- a record's typed form
- the columns editor
- who reaches it
- create, edit, export and delete

A guild's grants and an agent's own access are edited from their
State and Databases tabs ([Operator app](operator-app.md)).

### HTTP

Organisation-authorized routes behind the Databases page, all
acting as the operator:

```text
GET    /api/collections                          every live collection with its record count
POST   /api/collections                          { name, purpose, columns, guild_id? }
GET    /api/collections/:id                      the collection, its count, and access_list (guilds, agents)
PATCH  /api/collections/:id                      { name?, purpose?, columns?, guild_id? }; a renamed column carries rename_from; guild_id null moves the table to the organisation
DELETE /api/collections/:id
GET    /api/collections/:id/export               the live records as JSONL
GET    /api/collections/:id/records              query, where, since, order, limit, offset; { total, records, columns }
POST   /api/collections/:id/records              { body }; { record, merged }
DELETE /api/collections/:id/records              every live record; the table, grants, and next_id stay
GET    /api/collections/:id/records/:rid
PATCH  /api/collections/:id/records/:rid         { body }; { record, warnings }
DELETE /api/collections/:id/records/:rid
GET    /api/guilds/:id/collection-access         the guild's own tables (scope guild, write) and every organisation table with the guild's grant
PUT    /api/guilds/:id/collection-access         { collection_id, mode }; null removes the grant
GET    /api/agents/:id/collection-access         the guild's own tables and every organisation table with the guild's grant, the agent's grant, and the effective mode
PUT    /api/agents/:id/collection-access         { collection_id, mode }
```

`where` and `order` travel as JSON in the query string. A `query`
runs the text search instead of a listing. Records carry
`display_path` so the provenance strip can look them up.
