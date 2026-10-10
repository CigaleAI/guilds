# Recipes

A recipe is a portable snapshot of a guild's **configuration**. It is
not a clone of a live guild. It is not runnable.

The snapshot holds:

- roster
- prompts
- collection columns and grants
- routines
- scripts
- seed notes
- intended grants
- the repositories its coding roles work in
- the operator setup those grants require

Three surfaces share `guilds.recipe` v2:

- the [guild builder](guild-builder.md) authors one from a conversation
- capture takes one from a live guild
- apply turns one into a live guild and a setup checklist

This page is the format, capture, and apply.
[Prompt Studio](prompt-studio.md) improves guilds that already exist.
It does not deal in recipes.

## Contract

Format is `guilds.recipe` v2. Unknown keys are rejected.

Caps:

- 4 MiB body
- 20 roles
- 256 KiB task/script
- 64 notes
- 8 KiB setup
- 50 list items

Model-written prompt/setup fields carry `{ by: operator | builder,
reviewed }`. That is provenance, not a publish gate.

Edit changes `by` to operator.
File import resets destination review state.

Routine keys are `^[a-z][a-z0-9-]{0,62}$`. Design metadata never uses
array indexes.

Collections are tables: `{ name, purpose, columns, scope, guild,
writers }`.

`columns` is the typed column list (name, type, description, required,
unique, values). The list is parsed by the same rules as the Databases
page ([Notes and collections](notes-and-collections.md)). Every
collection declares one.

`scope` is `guild` for a table the applied guild owns.
Every member reads and writes that table.
`scope` is `org` (the default) for an organisation table.

A `guild` scope takes `guild: "write"` and no `writers`.
Both are rejected otherwise.

On an `org` table, `guild` (`read` or `write`, default `read`) is the
grant the new guild gets.
`writers` lists the roles whose agents get their own `write` grant.

Apply creates the table, or reuses a live organisation table whose
columns accept the recipe's.

Capture never includes:

- credentials
- memory
- collection records
- browser profiles
- repository URLs
- local ids

Export and share are refused while the recipe is draft.
Structural validation (then `status=ready`) is the gate.

Access is resolved, not stored as a matrix.

The document stores **effective** per-role state plus recommended
scopes. The per-role state is:

- servers
- tools
- grants
- secret names

Binding row ids and `connection_id`s stay out.

## Document shape

Stored in PostgreSQL; downloadable as JSON.

```text
{
  format: "guilds.recipe",
  version: 2,
  meta: { name, description, created_at, source },
  guild: { name_suggestion, about, objective, group_agent_message_limit },
  roles: [{
    role, name_suggestion, focus, wake_triggers?, avatar_*, config,
    task: { body, embeds[] },
    scripts, schedules,
    grants, native_tools,
    browser: { required, instructions, author }
  }],
  collections: [{ name, purpose, columns, scope?: "guild" | "org", guild?: "read" | "write", writers?: [role] }],
  notes: [{ id, level, role?, key, body, kind: "seed" }],
  connections: [{
    server, auth, recommended_scope, recommended_role, hint,
    setup, resources?, author,
    roles: { [role]: { enabled, tools: { [namespaced]: boolean } } }
  }],
  secrets: [{ name, description, recommended_scope, recommended_role, roles[] }],
  external: [{ kind, title, setup, author }],
  repositories?: [{ name, purpose }],
  design?: { ... }   // builder metadata; optional
}
```

Rules:

The document has none of:

- `connection_id`
- `secret_id`
- ciphertext
- tokens
- workspace paths

`config.coding` (boolean) makes a role a coding agent.

`repositories` lists the git repositories the guild's coding roles
work in, by `name` and a one-line `purpose`.

`name` matches `^[a-z][a-z0-9_-]{0,62}$`.
It is unique.
It is the folder under `/home/agent/repos`.

`purpose` is at most 400 characters.

A URL, an owner, or any other key is rejected.

Validation errors with `capacity.agents`, `capacity.browser`, or
`capacity.coding` when the roles, the browser roles, or the coding
roles exceed what the organisation may still create under its limits.
A limit that is not set never fires.
Core sets none.

Validation errors with `coding.flag` when `config.coding` is not a
boolean.

It warns with `repositories.unused` when repositories are listed and
no role sets `config.coding`.

Optional `connections[].resources` names confirmed long-lived external
tables (`kind`, `id`, `title`, `url?`, `use?`).
It is not a live row dump.

Optional `connections[].manifest` carries an organisation's own remote
server whole, in the `connector.json` format, so a box that lacks it
can add it. Its slug is the connection's `server`, and it must be
endpoint-only and hold nothing at instance level: an endpoint, no
`auth.instance` of any form, OAuth only `dynamic`, no `state` hook
(`recipeManifestProblem`). Capture writes it for a server the
organisation added of its own.

A connection whose server the box lacks is a blocking error:

- `server.organisation` when the connection carries its manifest
- `server.registry` when the registry offers the slug, naming the
  newest version
- `server.unknown` otherwise

Notes are flat.
`notes[].key` is a `.md` file name with no `/`.
A note carrying `path` is rejected on import and write.

`task.body` embed syntax after capture is the destination file:

- `![[guild/<key>]]`
- `![[org/<key>]]`
- `![[agent/<role>/<key>]]`

A leftover `![[recipe:<note-id>]]` still applies when `notes[].id`
matches.

Apply rewrites those markers to live display paths.
It fails if any stay unresolved.

Agent tags are `@{role}` until apply. They appear in:

- `task`
- schedule `instruction`
- notes
- script source

`@user` is never rewritten.
The rewrite uses the group-chat tag grammar, not a string replace.

`author` is `{ by: "operator" | "builder", reviewed }`.
That is provenance only.
`reviewed: false` does not block export, share, or apply.

`version` must be 2.
Any other value is rejected (`unsupported recipe version`).

A collection carrying `level`, `role`, `schema`, or `key` is rejected
with a hint naming `scope`, `guild`, `writers`, `columns`, and `name`.

Always captured:

- the guild `description` (stored as `guild.objective`)
- notes a `task` embeds
- empty `memory` on agent create (then overwritten by recipe `task`)

These stay out unless the operator includes them:

- lived agent notes
- org notes
- memory bodies
- collection records

Schedules capture `cron` or `window`, description, and instruction.
Apply inserts them paused.

`config.browser` plus login instructions travel.
Chromium profiles do not.

`config.coding` travels.
The guild's repositories are captured by name with an empty
`purpose`.
Their URLs, branches, and GitHub connections stay with the guild.

The GitHub connection is not captured under `connections`.
`repositories` stands for it.

## Capture

`POST /api/guilds/:guild_id/recipes` writes a `recipes` row with
`status=draft` and `source_kind=guild`.

Capture rewrites display-path embeds to recipe-local refs.
It rewrites source agent names to `@{role}`.

It writes the guild's own tables as `scope: "guild"`.

It writes every organisation table the guild reaches as
`scope: "org"`.
The guild reaches a table through its own grant or through a member
agent's own grant.

`guild` is the guild's grant (`read` when only members hold grants).
`writers` is the roles whose agents override it to `write`.

An agent override of `read` or `none` is not carried into a recipe.

Secrets come from each role's environment.
There is one entry per name.
The entry has its description and the roles whose agents get it.

`recommended_scope` is:

- `org` when the secret is organisation-wide
- `guild` when it is granted to the source guild
- otherwise `agent`

The first role holding it is `recommended_role`.
Values are never captured.

The blueprint is a preview.

**Approve**, in the builder or on the recipe's page, moves the row to
`status=ready` when structural validation passes.

Any later body write returns it to `draft` so apply cannot run
mid-construction.
Those writes are builder chat, edit, and PUT.

`POST /api/recipes/:id/review` can still edit provenance.

Expanding a connector lists catalog tools.
The operator can uncheck tools or remove the connector, then save the
access.

Save is **Save access** on the recipe's page.
It is **Save and tell the coach** in the builder.

That write sets `connections[].roles[role].tools[name]=false`.
Or it drops the connection (recording `design.systems` as
operator-refused).

Validation returns `access.tool_removed` / `access.connector_removed`
so the builder can update prompts or ask why.

## Storage

```text
recipes (
  id, org_id, created_by_user_id,
  name, description, visibility,     -- private | org
  status,                            -- draft | ready
  body jsonb, body_version int,
  source_kind, source_guild_id, source_builder_session_id,
  created_at, updated_at
)
```

`visibility=org` covers restore and intra-org share.
File import is the cross-org path (`POST /api/recipes/import`).
Cross-org reads stay 404.

## Recipe HTTP

```text
GET    /api/recipes
POST   /api/guilds/:guild_id/recipes
GET    /api/recipes/:id
PUT    /api/recipes/:id
POST   /api/recipes/:id/review
POST   /api/recipes/:id/access
POST   /api/recipes/:id/validate
POST   /api/recipes/:id/publish
DELETE /api/recipes/:id
GET    /api/recipes/:id/export
POST   /api/recipes/import
GET    /api/recipes/registry
POST   /api/recipes/registry/import   { name, version? }
```

The registry routes list the recipes the box's registry offers and
add one to the organisation's library as a private draft, as a file
import does, after checking it against the index's size and SHA-256.

Export is 409 while `status=draft`.
PUT sends the expected `body_version`.
It takes 409 on a stale head.

## Library and recipe page

`/recipes` is the library.
It has **From a guild** to capture one and **Import JSON**.

The guild menu's **Save as recipe** captures that guild and opens the
draft.

`/recipes/<id>` shows:

- the apply plan (everything the recipe creates and needs)
- each Task with a copy button
- Task rewrites
- access cuts
- **Approve**
- **Export** on a ready recipe
- **Apply**, or **Approve and apply** on a draft

Apply starts at `/recipes/<id>/apply`.

## Apply

Apply turns a `guilds.recipe` v2 document into a live guild.
The guild gets:

- roster
- prompts
- collections
- scripts
- paused routines

Then it walks the operator through:

- logins
- secret values
- browser sessions
- external systems

Builder Deploy uses this same flow.
There is no builder-specific credential path.

### Contract

Apply may reuse existing organisation or platform connections, and
the organisation's secrets.

It creates new connections only at guild or agent scope.
It writes overlays only at guild or agent scope after tool listing.

Apply never writes a secret value.
It never makes a secret organisation-wide.
The operator adds each secret the apply plan creates from the guild's
Secrets view.

Preview resolves these before writes:

- names
- models
- current capacity
- note/secret collisions

Skeleton creates:

- the guild
- agents
- notes
- tasks
- scripts
- schedules (paused at create)
- collections with their grants

It uses compensating cleanup.

A recipe collection is created when its name is free in the
organisation.
It is reused when the live table of that name accepts every recipe
column.
Otherwise it is a blocking `collection.conflict`.

A reused table keeps its records and its other grants.

Apply never writes an org-scope or platform-scope **binding**.

It may reuse an org login.
The grant lands on the new guild or one of its agents.

Overlays are upserted after Connect, at the resolved connection's
owner scope.

A namespaced tool the destination does not list is a warning, not a
failure.

Destination is a guild apply creates, or an **empty** guild (no
agents).

In-place restore onto a live roster is out of scope.
Live task edits stay in Prompt Studio.

### Flow

`recipe_applies.status`: `preview`, then `skeleton`, then `checklist`,
then `ready`, or `aborted`.

A role's `config.model` is a recommendation, kept exactly as written.
Validation warns about one that is unknown, not connected for the
organisation, or a coding-API model on a role without `coding`, and
never refuses a recipe for a model reason. The apply preview shows a
picker per role, preselected with the recommendation when the
organisation has it, else the organisation's default, else nothing;
the apply request carries `models`, the model chosen for each role,
and nothing is created while a role has none. The Builder writes the
coach's model into the roles it drafts without one; capturing a guild
keeps each agent's live model.

#### Preview

`POST /api/recipes/:id/preview` resolves, without writing:

- guild name in this organisation
- each role's `name_suggestion` against charset, reserved `user`, and
  names visible here (a global agent-name 409 is handled at insert)
- each role's model: the operator's choice, else the role's
  recommendation when the organisation has its provider, else the
  organisation's default, else none; the preview's `models` lists
  each role's `recommended` and resolved `model`
- the organisation's remaining capacity for the whole batch: agents,
  browser agents, and coding agents (roles with `config.coding: true`),
  each against the organisation's limit, `null` where nothing caps it
  The preview's `remaining` carries `agents`, `browser_agents`, and
  `coding_agents`
- catalog presence of each `connections.server`; the preview's
  `installs` lists each one the box lacks that can be added: from the
  registry (`server`, `from: "registry"`, `version`, `verified`), which
  an instance admin installs, or from the recipe (`server`,
  `from: "recipe"`, `display_name`, `description`, `url`, `auth`),
  which an owner or admin adds as the organisation's own server
- which of the connectors the recipe needs the box has but a platform
  admin has not set up, GitHub included when the recipe lists
  repositories; the preview's `setups` lists each one (`server`,
  `integration`, `label`). The apply goes on; those connections
  cannot connect until the integration is filled under **Admin**,
  **Platform keys**
- existing destination org connections that can satisfy a server
- each secret name against the organisation's secrets
  A name the organisation holds is a collision and defaults to
  `reuse`.
  The operator may `rename` or `skip`.
  A free one is `create`.
  A recommended `org` scope becomes `guild`
- org-level seed note collisions
- each recipe collection against the organisation's live tables
  - `create` when the name is free
  - `reuse` when every recipe column exists there with the same type
    and, for a closed value list, every recipe value is accepted
    (extra live columns are fine)
  - otherwise `conflict`, a blocking `collection.conflict` finding
    listing the differences
  The operator resolves a conflict by renaming the recipe collection
- provenance of builder-authored fields (informational; not a gate)

#### Skeleton

`POST /api/recipes/:id/apply` requires `status=ready` and no blocking
validation errors. Ordered so no intermediate state is broken:

1. assert the whole batch against the organisation's limits once
2. create guild (or attach an empty one)
3. create guild- and org-level seed notes
4. create agents
5. create agent-level seed notes, then rewrite destination-file embeds
   (`guild/…`, `org/…`, `agent/<role>/…`, leftover `recipe:<id>`) to
   live display paths.
   Unresolved links fail the apply.
6. write each `task` once, with embeds and `@{role}` tags already
   final
7. insert scripts
8. insert schedules paused
9. write grant and native-tool bindings at guild or agent scope
10. create each `create` collection with the recipe's columns.
    A table that appeared under that name since preview is a
    conflict: preview again.
    A `scope: "guild"` collection is created for the new guild.
    It takes no grant.
    It conflicts when the organisation already holds that name.
    An `org` collection is granted the recipe's `guild` mode, and
    each `writers` role's agent `write`, on every created or reused
    table
11. open the checklist

Notes precede tasks because embed hydration throws on a missing
target.

A retried apply is idempotent per destination guild.

Failure deletes a guild apply created (`created_guild`) and the
collections this apply created.
Reused tables stay.
An empty guild the operator already made stays standing.

Once the apply is saved, and when the applying user is an org owner or
admin, each `reuse` secret that is not organisation-wide and does not
reach the guild yet is granted to it.
Secret steps that then pass close.

#### Checklist

Each step has a derived id. Examples:

- `conn:notion`
- `secret:TAVILY_KEY`
- `repo:api`
- `overlays:notion`
- `browser:scout`
- `external:…`

A recipe with `repositories` adds a `conn:github` step (Connect GitHub)
when its connections do not already name `github`
([GitHub](../tools-and-connectors/github.md)).
It adds one `repo:<name>` step per repository.
That step's setup is the repository's purpose and where to add it
(the guild's Settings, under Repositories, with that name).

The Connect GitHub setup also tells the operator to set Commit author
email in the guild's Settings to a verified email on the GitHub
account that owns any deploy project.
Recipes do not store that email.

Agents from roles with `config.coding: true` are created with coding
on.

| Step | Closes when |
|---|---|
| Reuse or Connect server S | connection `status=connected` (verified), or operator skips with a warning |
| Secret `NAME` | a secret of the destination name reaches every agent of the roles that need it, the recipe secret's `roles` or else every planned role (verified), or skipped |
| Tool overlays for S | planned `mcp_tool` bindings match (verified); skipped with the Connect step |
| Repository `name` | the guild has a repository of that name (verified), or skipped |
| Browser for role R | deferred until after activate; the live agent asks the operator to log in |
| External item | operator attests (confirmed) |

A connection step whose connector a platform admin has not set up on
the box shows that gap, keeps Connect disabled, and offers **Set up**
(Admin, Platform keys) to a platform admin; it closes once the login
is connected or the step is skipped.

Connect, secret, repository, and overlay steps can be skipped
(`POST …/confirm` with `skip: true`).

Skip records a warning.
Agents that need that login will fail those tasks until it is
connected later from Tools.

Browser login is not an apply checklist task.

After activate, each agent the recipe required a browser login for
shows a **Browser login needed** strip on its inspector.
The strip has **Open Browser** (the agent's Browser tab, where the
operator takes control and logs in) and **Mark as done**.
The strip stays hidden while the guild's checklist is open.

`POST /api/applies/:id/steps/:step_id/verify` re-derives destination
state.
A secret step that does not pass names the agents the secret does not
reach yet.
A repository step says the guild has no repository of that name yet.

`…/confirm` is for browser and external steps, and for skipping a
connection, secret, or repository.

`POST /api/applies/:id/overlays` writes planned tool overlays after
listing.

#### Activate

`POST /api/applies/:id/activate` unpauses the schedules the operator
kept, defers any remaining browser logins, and moves the row to
`ready`.

Abort deletes a guild apply created and the collections the apply
created.
Reused tables and their records stay.
Org-level logins created during the checklist stay.

### Apply HTTP

```text
POST   /api/recipes/:id/preview
POST   /api/recipes/:id/apply
GET    /api/applies/:id
GET    /api/guilds/:guild_id/apply
POST   /api/applies/:id/overlays
POST   /api/applies/:id/steps/:step_id/verify
POST   /api/applies/:id/steps/:step_id/confirm
POST   /api/applies/:id/activate
POST   /api/applies/:id/abort
```

`GET /api/guilds/:guild_id/apply` returns `{ apply, browser_logins }`.
`apply` is the open checklist, or null once it is done or aborted.
`browser_logins` is the agent ids a ready apply still asks to log
in by hand.

### Apply screens

`/recipes/<recipe_id>/apply` previews the apply.
It shows:

- the new guild's name
- each agent's name
- for each connector, a live login to reuse or one to connect
  afterwards

`/applies/<apply_id>` is the checklist of an apply.

A connect step opens the same Connect dialog as the Tools view.
Connect and secret steps link to the guild's Tools and Secrets.

Steps are checked, confirmed, or skipped there.
Then **Activate routines** or abort.

A guild whose checklist is still open shows a strip under its tabs.
The strip says the routines stay paused until the checklist is done.
It links to the checklist.
