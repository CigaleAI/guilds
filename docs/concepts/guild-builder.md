# Guild builder

The guild builder turns one sentence of intent into a `guilds.recipe`
v2 blueprint.

The operator describes an outcome.

The builder coach:

- interviews
- splits the work into specialized agents
- writes standing prompts and routines
- names the access each role needs
- publishes a blueprint

Deploy creates a `recipe_applies` row and walks the same apply flow as
the Recipes library ([Recipes](recipes.md)).

It is a design surface.

The coach never logs into anything.
It never creates a live agent.
It never holds a credential.

A write picks one [DiceBear](https://www.dicebear.com/) family for the
guild and a unique variant and identity colour for each role. The coach
does not choose the mascots.

[Prompt Studio](prompt-studio.md) stays optimize-only on a live guild.

## Contract

A builder session creates and owns one draft recipe immediately.

Optional non-runtime `design` metadata records:

- specialization
- keyed routines
- hand-offs
- browser viability

Decisions keep `proposed_by: operator | builder` and an independent
`accepted` flag.

Default to two or more specialized roles whenever the work has more
than one standing purpose.
One role needs that reason recorded in `design.specialization`.
A durable queue collection or an explicitly budgeted tagged protocol
is required when there are multiple roles.

Routine keys are stable.
Validation enforces structural facts.
Prose/NLP checks are out of scope.

Capability fallback, in order:

1. published connector
2. native capability
3. reviewed script adapter plus named secret
4. browser role plus operator login
5. narrowed composition
6. an explicit refusal

Builder-written scripts are documents and cannot run in the builder.

Recipe collections are organisation tables with typed columns.
The recipe carries the guild's mode and the roles that write.

A role that reads, changes, runs, and ships code sets
`config.coding`.
Its code tools come with the flag.
The coach sets `config.harness` (`claude-code`, `codex`, or `cursor`)
only when the operator named one; otherwise apply asks for it.

The recipe lists the repositories the guild works in by name and
purpose, never a URL or credential.
Each coding role's Task names its repositories, the checks it runs,
and how work reaches its reviewer.

Deploy is enabled only for a `ready` recipe.
It creates the same apply row as recipe apply.

## Design method

`builder_list_capabilities` is the grounding tool.
The coach may not name a server that is not in that result.

Every named system resolves to one of:

- catalog server
- native substitute
- browser role
- narrowed scope
- refusal

Triggers become a routine plus a cadence plus a dedupe key.
Dedupe is a collection whose unique column carries the identity, not
Memory.

Hand-off defaults to a queue collection.
Tagged `group_post` is only for small, budgeted batches.
N items never produce N group messages.

Every collection the builder declares carries typed columns designed
from how the records are used
(`apps/orchestrator/src/builder/system.md`):

- a queue or hand-off collection has one required `text` column with
  `values`, the closed list of states whose first value is what the
  producer writes
- a collection whose records are entities carries their natural
  identity in one `unique` column, so `record_add` merges a repeat
- a seen-set is a table with a unique key column
- each collection holds one record shape
- free text lives in a named text column
- a category lives in a text column with `values`
- a short list of text lives in an `array` column
- a count lives in a `number`
- a moment lives in a `datetime`
- no id or timestamp column is declared
- `purpose` says what one record is and who writes it

Both Tasks name the state column.

The producer writes every required column with `record_add`.
The consumer finds work with `record_list` and `where` on it.
The consumer moves the record to the next state with `record_update`
by id.

`scope` decides who owns the table.
`guild` is for the guild being built, whose agents all read and write
it.
`org` is for a table other guilds can share.

On an organisation table access is a grant, never a default.
`guild` is the mode every member gets.
`writers` is the roles that get their own `write` grant.

A column that breaks a rule is refused at write
(`collections[i].columns: column "x": …`).

Validation errors on:

- a collection without columns (`design.untyped_collection`)
- a hand-off collection without a required text column with `values`
  (`design.handoff_state`)
- a role that must write a table it cannot
  (`design.collection_access`: a hand-off producer or consumer, or
  the role of a dedupe routine, when `guild` is not `write` and the
  role is not in `writers`)
- a writer that is not a role (`collection.writer`)

Apply preview adds `collection.conflict` when a live table of the
same name has different columns.

Specialize when any of these requires it:

- craft
- capability (`browser`, `coding`)
- access
- throughput (one generation per agent; a due schedule on a busy
  agent is skipped)
- failure isolation
- volume

Keep one role only when the entire job is:

- one skill
- one cadence
- one login
- one playbook

Tasks name systems and outcomes, not namespaced tool ids.

The coach is a system designer.
It isolates each durable element into a named file or specialist so
the guild can evolve and the operator can inspect Files.

Shared schema and field maps are one guild- or org-level note.
A Task that must see them every wake embeds `![[guild/<key>]]` or
`![[org/<key>]]`.

Working files the agent revises are named and read with `note_get`.
A bare filename or "inlined from: …" is not an embed.

Prompt placement is the shared block in
`apps/orchestrator/src/conversation/prompt-placement.md`.

Setup text lands as `author: { by: "builder", reviewed: false }`.
That is provenance.

The operator previews, edits or asks the coach to revise, then
validates.
Per-field confirm is not required.

## Tools

| Tool | Purpose |
|---|---|
| `builder_list_capabilities` | Native tools, the browser and coding capabilities (tools, sandbox cost, the limit each counts against), published connectors, models, the organisation's limits and remaining capacity (agents, browser agents, coding agents; `null` where nothing caps it), reusable connections |
| `builder_search_capabilities` | Search connector copy and canonical tool names |
| `builder_describe_server` | One published connector's catalog record |
| `builder_search_connected` | Search an organisation-connected workspace (Notion databases and pages) |
| `builder_ask_org_connection` | Chat widget: connect one published connector to the organisation now |
| `builder_ask_connection` | Chat widget: connect any published connector at org, guild, or agent scope |
| `builder_ask_question` | Chat widget: option card that pauses until the operator submits an answer |
| `builder_validate_recipe` | Mechanical and design findings against the current blueprint |
| `builder_write_recipe` | Create or revise the draft, sending `body_version` |

The coach uses the shared conversation runner
(`apps/orchestrator/src/conversation/`).
Studio tools are absent.

Catalog copy (`description`, `limitations`, `setup_hint`) comes from
each connector's manifest, with the instance admin's overrides
applied ([Catalog](../tools-and-connectors/catalog.md#catalog-connections-bindings)).
Platform admins edit it at **Admin → Connector catalog** (`/admin`).
The builder names the enabled connectors' manifest tools, and the
tools the organisation's own logins have listed.

An empty stored tool list means "not connected here yet", never "this
server cannot do that."

A connector whose `oauth_setup_state` is `unsupported` is not set up
on this box. The coach says that a platform admin fills its keys
under **Admin**, **Platform keys** before anyone can connect it, and
asks the operator to do that or to pick another service. The connect
widget shows the connector as **Not set up** with Connect disabled.

`builder_validate_recipe` blocks `status=ready` on structural errors:

- no dedupe store on a watch role
- invented connector
- browser or coding roles beyond the organisation's remaining
  browser or coding capacity
- task that instructs schedule creation

Advisory findings cover:

- wake-up cost
- shared producer/consumer crons
- logged-out detection

Operator tool and connector removals from the blueprint become
`access.tool_removed` / `access.connector_removed` info findings so
the coach can update standing prompts or ask why they were cut.

When Notion is connected at organisation scope, the coach searches
that workspace and asks which databases to use for **long-lived**
records.
Confirmed tables land on `connections[].resources` and a local map
note.

Queues, seen-sets, drafts, playbooks, and Memory stay in local notes
at organisation, guild, or agent scope or in organisation
collections.

Organisation logins can happen in the builder chat.
Guild and agent connector logins stay on the apply checklist.

A connect widget pauses the coach until the operator authenticates or
skips.

Interview questions use `builder_ask_question`.
It is an option card (plus Other) that pauses until the operator
submits.

Browser logins happen on the live agent after apply.

## Surfaces

```text
/builder
/builder/<session_id>
```

The landing takes a sentence or two describing the guild and the coach
model, from the organisation's chosen marketplace models and
preselected with its default; while no provider is connected it shows
a guide to Model keys instead. The coach's model is written into the
roles it drafts without one, as their recommendation
([Recipes](recipes.md)).
It starts a session with that description as its first message.
It lists earlier drafts.

**Try** offers example descriptions that fill the box to edit before
sending.

A session's workspace is two panes, the blueprint of its draft recipe
and the coach chat, split by a draggable bar whose share persists
(one pane at a time on a narrow screen).

The workspace follows the session's stream
(`generation.started`, `assistant.delta`,
`assistant.reasoning.delta`, `message.committed`, `recipe.changed`,
`generation.finished`, `session.error`).
The coach log shows reasoning as it streams, then the reply.
While the coach works, it also re-reads the session and its messages
every 2.5 s.

In the blueprint the operator rewrites Tasks and switches connector
tools per role or drops connectors.
**Save and tell the coach** writes those access cuts and posts them
to the coach.

**Approve** moves the recipe to `ready` so it can be applied.
A later builder write returns it to `draft`.

**Deploy guild** approves when needed and opens the apply preview.

## Storage

```text
builder_sessions (
  id, org_id, created_by_user_id, created_by_name,
  recipe_id,
  config_snapshot jsonb,
  status, blocked_reason,           -- input_token_limit
  generation_state, generation_number, generation_token,
  errors jsonb,
  created_at, updated_at, archived_at
)
builder_messages (id, session_id, seq, generation, payload, metadata, cost_usd, created_at)
```

One session owns one `recipes` row.
Usage joins Studio's non-agent bucket.

## HTTP

```text
GET    /api/builder/sessions
POST   /api/builder/sessions
GET    /api/builder/sessions/:id
GET    /api/builder/sessions/:id/messages
POST   /api/builder/sessions/:id/messages
POST   /api/builder/sessions/:id/cancel
GET    /api/builder/sessions/:id/stream
PUT    /api/builder/sessions/:id/recipe
POST   /api/builder/sessions/:id/review
POST   /api/builder/sessions/:id/access
POST   /api/builder/sessions/:id/validate
POST   /api/builder/sessions/:id/publish
POST   /api/builder/sessions/:id/deploy
GET    /api/builder/capabilities
GET    /api/builder/capabilities/search
GET    /api/builder/servers/:server_ref
```
