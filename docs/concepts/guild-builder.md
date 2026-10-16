# Guild builder

The Guild builder turns a sentence or two about what you want into a
[recipe](recipes.md): a full design for a [guild](guilds.md). You
describe an outcome. A coach, an AI designer, interviews you, splits
the work into specialised [agents](agents.md), writes their Tasks and
[routines](routines.md), and names the access each one needs. The
result is a draft recipe you review, approve, and deploy.

The Builder is a design surface only. The coach never logs into
anything, never creates a live agent, and never holds a credential.
**Deploy guild** hands the recipe to the same
[apply](applying-recipes.md) flow as the Recipes library.
[Prompt Studio](prompt-studio.md) is its counterpart for a guild that
already runs: it improves a live guild and does not design new ones.

## When you use it

- You know what a guild should achieve but not how to split the work
  into agents.
- You want a design grounded in the connectors and limits of your own
  organisation, before anything is created.
- You want to review and edit a blueprint, and discuss it, before it
  costs anything to run.

## How it works

```mermaid
flowchart LR
  O[Operator describes the guild] --> C[Coach]
  C -->|asks questions, connects org logins| O
  C -->|reads| K[Capabilities: connectors, models, limits]
  C -->|writes and validates| R[Draft recipe]
  O -->|edits Tasks, cuts tools| R
  R -->|Approve| Y[Ready recipe]
  Y -->|Deploy guild| A[Apply preview and checklist]
```

### A session owns one draft

Starting the Builder opens a *session* and creates its draft recipe at
once. Every message to the coach is one generation. The coach reads
the draft, the organisation's capabilities, and your answers, and
rewrites the draft as a whole. The draft is an ordinary recipe in the
library: you can open it from **Recipes** too.

### How the coach designs

The coach follows a design method:

- **Ground every system.** The coach looks up what the organisation
  can actually use. It never names a connector that is not in the
  catalog. Each system you name becomes a catalog connector, a native
  substitute, a browser role, a narrower scope, or a refusal.
- **Specialise.** Work with more than one standing purpose becomes two
  or more agents. One agent stays one only when the whole job is one
  skill, one cadence, one login, and one playbook, and the coach
  records why.
- **Hand off through a collection.** Agents pass work through a queue
  [collection](collections.md) by default. Tagged messages in
  [group chat](group-chat.md) are only for small, budgeted batches.
- **Remember what was seen in a collection.** A routine that watches
  for new items keeps the items it has seen in a collection with a
  unique key, not in Memory.
- **Ask, do not guess.** Interview questions come as option cards. A
  login the organisation can make now comes as a connect card. Both
  pause the coach until you answer.

### Reviewing what the coach wrote

Everything the coach writes is marked as written by the Builder and
not reviewed. That is provenance, not a gate. You read the blueprint,
edit a Task yourself or ask the coach to revise, switch off tools or
drop connectors, and approve. A cut you make is sent back to the coach
so it can fix the Tasks that relied on it, or ask why.

### Looks

When the coach writes a draft, the Builder picks one
[DiceBear](https://www.dicebear.com/) family for the guild and a
unique variant and identity colour for each role. The coach does not
choose the mascots.

## In the app

### Landing

**Builder** opens the landing page, *Describe the guild you want.*

- A text box takes a sentence or two about the guild.
- **Coach** picks the coach's model, from the organisation's chosen
  marketplace models, preselected with its default. While no provider
  is connected, a guide to [Model keys](model-keys.md) shows instead.
  The coach's model is written into the roles it drafts without one,
  as their recommendation.
- **Draft the recipe** (or Cmd/Ctrl+Enter) starts a session with that
  description as its first message.
- **Try** offers example descriptions that fill the box to edit before
  sending.
- **Your drafts** lists your earlier sessions.

### Workspace

A session's workspace has two panes: the blueprint of its draft recipe
and the coach chat. A draggable bar splits them, and its share
persists. On a narrow screen one pane shows at a time, switched with
**Show**: **Coach** or **Blueprint**.

The header shows the recipe's name, its body version, and a status:
*draft* or *approved*, and *coach designing…*, *waiting for you*, or
*coach ready*. Its buttons are:

- **Builder**, back to the landing
- **Approve**, on a draft: it moves the recipe to ready so it can be
  applied. A later Builder write returns it to draft.
- **Deploy guild**: it approves when needed and opens the
  [apply preview](applying-recipes.md#in-the-app)

The blueprint is the same plan as a [recipe's page](recipes.md#a-recipes-page).
In it you rewrite Tasks, switch connector tools per role, or drop
connectors. **Save and tell the coach** writes those access cuts and
posts them to the coach.

The coach chat shows the coach's reasoning as it streams, then its
reply. Connect cards and question cards appear inline. A question card
offers options plus **Other**. A connector that is not set up on the
box shows as **Not set up**, with Connect disabled. Open questions the
coach recorded in the design show as a question card above the message
box. While a card waits for an answer, the message box is disabled.
When the session reaches the coach's input limit, a banner says so:
the session stays readable, its draft stays in Recipes, and a new
session continues the design.

## Rules and limits

| Rule | Value |
|---|---|
| Coach model | A marketplace model whose provider the organisation has connected |
| Coach temperature | 0.2 by default |
| Steps per generation | 24 |
| Output tokens per generation | 25,000 by default |
| Tool calls per generation | 40 by default |
| Input tokens | 200,000 by default; when a generation's projected input passes it, the session is blocked |
| Monthly runs | Each generation counts against the organisation's monthly Studio and Builder runs, when a limit is set |
| One generation at a time | A message while the coach works is refused |
| Sessions | Visible only to the user who started them |
| Drafts | One recipe per session |
| Coach writes | Refused when every role has an empty Task, or when they drop roles from a roster of two or more |
| Connectors | Only those in the catalog; never invented |
| Credentials | The coach never holds one |
| Logins in chat | Organisation logins only; guild and agent logins wait for the apply checklist; browser logins happen on the live agent after apply |

## Reference

### Contract

A Builder session creates and owns one draft recipe immediately.

Optional non-runtime `design` metadata records specialisation, keyed
routines, hand-offs, browser viability, and how each named system was
resolved (see [Recipe format](recipe-format.md#design)). Decisions
keep `proposed_by: operator | builder` and an independent `accepted`
flag.

Default to two or more specialised roles whenever the work has more
than one standing purpose. One role needs that reason recorded in
`design.specialization`. A durable queue collection or an explicitly
budgeted tagged protocol is required when there are multiple roles.

Routine keys are stable. Validation enforces structural facts.
Prose checks are out of scope.

Capability fallback, in order:

1. published connector
2. native capability
3. reviewed script adapter plus named secret
4. browser role plus operator login
5. narrowed composition
6. an explicit refusal

Builder-written scripts are documents and cannot run in the Builder.

A role that reads, changes, runs, and ships code sets `config.coding`.
Its code tools (`code_task`, `shell`, `shell_status`, `file_read`,
`code_search`) come with the flag (see
[Code tools](coding/code-tools.md)). The coach sets `config.harness`
(`claude-code`, `codex`, or `cursor`) only when the operator named
one; otherwise apply asks for it. It sets `config.harness_model` only
when the operator named a model for that harness,
`config.harness_effort` only when the operator named an effort, and
`config.secret_aliases` only when the operator asked for one.

The recipe lists the repositories the guild works in by name and
purpose, never a URL or credential. Each coding role's Task names its
repositories, the checks it runs, and how work reaches its reviewer.

Deploy is enabled only for a `ready` recipe. It creates the same apply
row as recipe apply.

### Design method

`builder_list_capabilities` is the grounding tool. The coach may not
name a server that is not in that result.

Every named system resolves to one of:

- catalog server
- native substitute
- browser role
- narrowed scope
- refusal

Triggers become a routine plus a cadence plus a dedupe key. Dedupe is
a collection whose unique column carries the identity, not Memory.

Hand-off defaults to a queue collection. Tagged `group_post` is only
for small, budgeted batches. N items never produce N group messages.

Every collection the Builder declares carries typed columns designed
from how the records are used
(`apps/orchestrator/src/builder/system.md`):

- a queue or hand-off collection has one required `text` column with
  `values`, the closed list of states whose first value is what the
  producer writes
- a collection whose records are entities carries their natural
  identity in one `unique` column, so `record_add` merges a repeat
- a seen-set is a collection with a unique key column
- each collection holds one record shape
- free text lives in a named text column
- a category lives in a text column with `values`
- a short list of text lives in an `array` column
- a count lives in a `number`
- a moment lives in a `datetime`
- no id or timestamp column is declared
- `purpose` says what one record is and who writes it

Both Tasks name the state column. The producer writes every required
column with `record_add`. The consumer finds work with `record_list`
and `where` on it. The consumer moves the record to the next state
with `record_update` by id.

`scope` decides who owns the collection. `guild` is for the guild
being built, whose agents all read and write it. `org` is for a
collection other guilds can share. On an organisation collection,
access is a grant, never a default: `guild` is the mode every member
gets, and `writers` is the roles that get their own `write` grant.

A column that breaks a rule is refused at write
(`collections[i].columns: column "x": …`).

Validation errors on:

- a collection without columns (`design.untyped_collection`)
- a hand-off collection without a required text column with `values`
  (`design.handoff_state`)
- a role that must write a collection it cannot
  (`design.collection_access`: a hand-off producer or consumer, or the
  role of a dedupe routine, when `guild` is not `write` and the role is
  not in `writers`)
- a writer that is not a role (`collection.writer`)

Apply preview adds `collection.conflict` when a live collection of the
same name has different columns.

Specialise when any of these requires it:

- craft
- capability (`browser`, `coding`)
- access
- throughput (one generation per agent; a due schedule on a busy agent
  is skipped)
- failure isolation
- volume

Keep one role only when the entire job is:

- one skill
- one cadence
- one login
- one playbook

Tasks name systems and outcomes, not namespaced tool ids.

The coach is a system designer. It isolates each durable element into
a named file or specialist so the guild can evolve and the operator
can inspect Files.

Shared schema and field maps are one guild- or org-level note. A Task
that must see them every wake embeds `![[guild/<key>]]` or
`![[org/<key>]]` (see [Task](task.md)).

Working files the agent revises are named and read with `note_get`. A
bare filename or "inlined from: …" is not an embed.

Prompt placement is the shared block in
`apps/orchestrator/src/conversation/prompt-placement.md`.

Setup text lands as `author: { by: "builder", reviewed: false }`.
That is provenance.

The operator previews, edits or asks the coach to revise, then
validates. Per-field confirm is not required.

### Writes

`builder_write_recipe` replaces the whole draft. It sends the
`expected_body_version` it last saw; a stale one returns
`recipe body_version conflict` with the current `body_version`. A
write is refused when every role has an empty `task.body`, and when it
would drop roles from a roster of two or more. Each accepted write:

- recommends the coach's model on every role without `config.model`
- keeps a reviewed field's author when its content did not change, and
  marks every other field `{ by: "builder", reviewed: false }`
- assigns the guild's looks: one DiceBear family, and a unique variant
  and colour per role, keeping the looks roles already had
- returns the recipe to `draft` and emits `recipe.changed`

Approve assigns looks too when a role still lacks one.

### Tools

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
(`apps/orchestrator/src/conversation/`). Studio tools are absent.

Catalog copy (`description`, `limitations`, `setup_hint`) comes from
each connector's manifest, with the instance admin's overrides applied
(see [Catalog](../tools-and-connectors/catalog.md)). Platform admins
edit it at **Admin → Connector catalog** (`/admin`). The Builder names
the enabled connectors' manifest tools, and the tools the
organisation's own logins have listed.

An empty stored tool list means "not connected here yet", never "this
server cannot do that."

A connector whose `oauth_setup_state` is `unsupported` is not set up
on this box. The coach says that a platform admin fills its keys under
**Admin**, **Platform keys** before anyone can connect it, and asks
the operator to do that or to pick another service. The connect widget
shows the connector as **Not set up** with Connect disabled.

### Validation

`builder_validate_recipe` runs the same checks as a recipe's
validation (every finding is listed in
[Recipe format](recipe-format.md#findings)). Errors block
`status=ready`, among them:

- no dedupe store on a watch role (`design.poll_dedupe`)
- an invented connector (`server.unknown`)
- browser or coding roles beyond the organisation's remaining browser
  or coding capacity (`capacity.browser`, `capacity.coding`)
- a browser role without a login-failure policy
  (`design.browser_login_policy`)

Advisory findings cover, among others, a consumer that shares its
producer's cadence (`design.cadence_collision`), a browser site that
failed a viability test, and a role with no routine.

Operator tool and connector removals from the blueprint become
`access.tool_removed` / `access.connector_removed` info findings so
the coach can update standing prompts or ask why they were cut.

### Connected workspaces

When Notion is connected at organisation scope, the coach searches
that workspace and asks which databases to use for **long-lived**
records. Confirmed ones land on `connections[].resources` and a local
map note.

Queues, seen-sets, drafts, playbooks, and Memory stay in local notes at
organisation, guild, or agent scope, or in organisation collections.

Organisation logins can happen in the Builder chat. Guild and agent
connector logins stay on the apply checklist.

A connect widget pauses the coach until the operator authenticates or
skips.

Interview questions use `builder_ask_question`. It is an option card
(plus Other) that pauses until the operator submits.

Browser logins happen on the live agent after apply.

### Stream

The workspace follows the session's stream: `generation.started`,
`assistant.delta`, `assistant.reasoning.delta`, `message.committed`,
`recipe.changed`, `generation.finished`, `session.error`. The stream
sends a keepalive every 15 s. While the coach works, the workspace
also re-reads the session and its messages every 2.5 s.

### Storage

```text
builder_sessions (
  id, org_id, created_by_user_id, created_by_name,
  recipe_id,                        -- unique
  config_snapshot jsonb,
  status,                           -- active | blocked | archived
  blocked_reason,                   -- input_token_limit
  generation_state,                 -- idle | generating | cancelling
  generation_number, generation_token, generation_started_at,
  errors jsonb,
  created_at, updated_at, archived_at
)
builder_messages (id, session_id, seq, generation, payload, metadata, cost_usd, created_at)
```

One session owns one `recipes` row, with `source_kind=builder` and
`source_builder_session_id` pointing back at it. The recipe cannot be
deleted while its session exists. `config_snapshot` holds the coach's
model, temperature, run limits, system prompt hash, and tool schemas.
The first message (`seq` 0) is the system prompt. Usage joins
Studio's non-agent bucket.

### HTTP

```text
GET    /api/builder/sessions
POST   /api/builder/sessions                    { model, temperature? }
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

- `GET /api/builder/sessions` lists the current user's sessions in the
  organisation.
- A session of another user or organisation is 404.
- `POST /api/builder/sessions` is 422 without a model, or with one that
  is not a marketplace model of a connected provider.
- Posting an empty message is 422. Posting while the coach generates,
  or to a session that is not active, is 409. A month past
  `monthlyCoachRuns` is 409.
- `review`, `access`, `validate`, and `publish` behave like the recipe
  routes of the same names (see [Recipes](recipes.md#recipe-http)).
  `publish` is 422 with the blocking errors.
- `deploy` takes the apply choices and creates the apply, exactly like
  `POST /api/recipes/:id/apply` (see
  [Applying recipes](applying-recipes.md#create)).

### Screens

| Screen | Route |
|---|---|
| Landing | `/builder` |
| Workspace | `/builder/<session_id>` |
