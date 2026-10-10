# Guilds and agents

A guild owns:

- zero or more agents
- guild-level artifacts
- one group chat

The operator can create an empty guild and add agents later.

A guild has an optional `about` (at most 200 characters) and an
optional `description` (at most 8000 characters). Both are columns on
`guilds`.

`max_agents` (default 15) is how many agents the guild can hold.
Creating another agent is refused when that would pass the count.
Applying a recipe that would pass that count is also refused.

The Settings tab edits:

- `name`
- `about`
- `description`
- `max_agents`
- visibility
- routines
- the group-chat message limit

An agent has an optional `focus` (at most 150 characters).

About, description, and focus attach to the hydrated system prompt's
State snapshot (`group.about`, `group.description`, and each member's
`focus`). Members then know the guild's goal and each other's role.

Focus also seeds that agent's `task` at create.

An agent also has optional `wake_triggers` (at most 500 characters).
They name the untagged group-chat messages it should wake for.

The operator writes them to complete "Wake me when…". Empty means its
focus stands in.

Wake triggers are not hydrated into the system prompt. They are not an
option of the recipient Choice
([Group chat](group-chat.md#public-history)).

Every organisation has the artifact store. Notes exist at agent,
guild, and org. Reach over them is the four grant bindings on the
agent.

Collections are organisation-level tables. A table that belongs to the
guild (`guild_id`) is written by every member and reached by nobody
else. An organisation table is reached through a `read` or `write`
grant the operator sets
([Notes and collections](notes-and-collections.md)).

Scripts are agent-level artifacts.

A guild is `org` or `private`. Org-visible guilds are listed to every
organisation member. A private guild is listed and readable only by
its operators.

The create modal defaults to private.

## Repositories

A guild has git repositories in `guild_repositories`. Each row holds:

- the guild
- `name` matching `^[a-z][a-z0-9_-]{0,62}$` and unique in the guild
- `url`
- `default_branch`
- optional `connection_id`
- GitHub's `github_id` for one added through a login

Each coding agent of the guild clones them into
`/home/agent/repos/<name>` ([Runs](runs.md#repositories)).

The guild's Settings tab adds and removes them. Any operator who sees
the guild may.

```text
GET    /api/guilds/:id/repositories
POST   /api/guilds/:id/repositories
DELETE /api/guilds/:id/repositories/:repository_id
```

`GET` returns `{ repositories, github_connections }`.

GitHub-backed repositories are picked on the GitHub integration
(Tools) at organisation, guild, or agent scope
([GitHub](../tools-and-connectors/github.md)). A narrower scope
inherits the wider login's set until it connects its own.

`repositories` are this guild's extra git URLs (anonymous, or a login
that is not the effective one). `github_connections` are the connected
GitHub logins the operator can see in the organisation.

`POST` takes `{ name, url, default_branch?, connection_id? }`. It
returns 201 with the repository. A name the guild already has is 409.

`url` is an `https` git URL without credentials, query, or fragment.

With a `connection_id`:

- the connection must be one of those GitHub logins
- `url` must be `https://github.com/<owner>/<repository>`
- the orchestrator checks that the installation reaches that
  repository (422 otherwise)
- `default_branch` then defaults to the one GitHub reports
- GitHub's id for the repository is recorded

Without a connection:

- `default_branch` defaults to `main`
- the repository is cloned anonymously
- the orchestrator gives the agent no credential for it
- only a public repository clones

The Settings form offers the connected GitHub logins for a
`github.com` URL. It picks the first by default.

A repository payload carries its `connection` (`id`, `status`,
`account_hint`) or null.

Removing a repository leaves the working trees already cloned.

Deleting a guild deletes its repositories. Deleting a connection
deletes the repositories added through it.

A guild's `git_author_email` is the commit author email coding agents
write into git at each generation.

Empty (the default) uses `<agent id>@agents.guilds.run`. A non-empty
value must be a single email address. It must not use a `.invalid`
domain.

Deploy services such as Vercel identify the author from that address.
Set it to a verified email on the GitHub account that owns the
project.

`PUT /api/guilds/:id` accepts `git_author_email`. Omitted leaves the
stored value. An empty string clears it.

The Settings tab edits it next to Repositories.

Coding agents never share a working tree. Each clones its own. Work
moves between agents as branches on the remote.

The `coding` section of the system prompt has an agent:

- work on a branch named `agent/<its name>/<topic>`
- open pull requests with `gh pr create`
- record the URL where the work item is tracked

A guild that divides coding work between roles uses what every guild
has:

- a collection of work items (state, repository, branch, pull
  request, owner) that agents find with `record_list` and claim with
  `record_update`
- a tagged `group_post` that names the item and the branch for the
  next agent
- a guild note per repository holding what the code does not say
  (layout, build and test commands, conventions), embedded in each
  coding agent's Task

## Operators

Operators are the people a guild works for. `guild_operators` holds
guild, user, and role.

The role is `admin` or `operator`. Whoever creates a guild, from the
create modal or a recipe apply, is its first admin.

Operators are organisation members. Leaving the organisation removes
them.

- Agents see the roster as State `group.operators` (`name`, `role`).
  They tag an operator by name, or every operator with `@user`
  ([Group chat](group-chat.md)).
- Each operator's inbox holds the guild's open issues and the
  messages that tag them ([Operator app](operator-app.md)).
- Only an admin adds operators, changes roles, removes operators,
  changes visibility, or deletes the guild. Every other guild action
  is open to anyone who can see the guild.
- A guild keeps at least one admin. Demoting or removing the last
  admin is 409. So is removing from the organisation, or deleting, a
  user who is the only admin of a guild.
- Agents and operators share the guild's tag names. Creating or
  renaming an agent to an operator's name is 409. Adding an operator
  named like one of the guild's agents is also 409.

`PUT /api/guilds/:id/operators/:user_id` with `{ role }` adds an
organisation member or changes their role.
`DELETE /api/guilds/:id/operators/:user_id` removes one. Both return
the guild.

Guild payloads carry `operators` (`user_id`, `name`, `role`, oldest
first).

Each guild carries a consecutive-agent-message limit for group chat
(`group_agent_message_limit`). A new guild starts at 200. The guild
header and the Settings tab edit it.

`routines_enabled` (default true) is the guild switch for schedule
wake-ups. While it is false the ticker skips every schedule in the
guild.

Each schedule keeps its own `paused` flag.

Turning the switch back on recomputes `next_run_at` from now for
unpaused schedules that are already due. Missed wake-ups are not
replayed.

Every agent belongs to exactly one guild for its entire life.

Names are globally unique and match `^[a-z][a-z0-9-]{0,62}$`. The name
`user` is reserved for the tag that reaches every operator in group
chat.

The Settings tab can change a name after create. Database ids stay
stable across a rename, and if a name is later reused after delete.
Display paths use those ids.

## Configuration and appearance

Agent configuration is seventeen required keys:

- `model`
- `temperature`
- `max_tokens`
- `max_steps`
- `max_tool_calls`
- `max_input_tokens`
- `keep_tool_result_generations`
- `max_scripts`
- `max_workspace_mib`
- `cli`
- `browser`
- `browser_language`
- `coding`
- `scripting`
- `memory`
- `thinking_level`
- `box`

Unknown keys are rejected. Missing ones take defaults:

- temperature 1
- 8192 tokens
- 30 steps
- 50 tool calls
- 100000 input tokens
- 1 live generation of tool results
- 10 scripts
- 10240 MiB of workspace
- CLI, scripting, and Memory on
- thinking `none`
- browser language `en-US`

A missing `box` follows the flags: `code` with `coding` on, `standard`
with `browser` alone, `lite` with neither. Missing flags follow the
box:

- `lite` turns `browser` and `coding` off
- `standard` turns `browser` on and `coding` off
- `code` turns both on
- `custom` turns `browser` on and `coding` off
- a payload that names neither makes a lite agent

The box alone is enough to create an agent, except `custom`, which
also needs `cpu` and `memory_mib`.

An agent created with `coding` on and no step or tool-call limit
starts with 200 steps and 200 tool calls instead.

The create and Settings forms offer the box under **Box** as four
buttons: Lite, Standard, Code or Custom. They offer Browser, CLI,
scripting, and Memory under Agent capabilities as four buttons.
Browser is off and unavailable on Lite.

A new agent is Lite. Picking Standard turns the browser on. Picking
Code turns browser and coding on together, with CLI, scripting, and
the coding budgets. Picking Custom turns the browser on, keeps the
coding switch where it is, and asks for the size.

CLI, scripting, and Memory start on. The operator can turn any of
them off on any box.

- `max_scripts` is how many reusable Python scripts the agent may
  keep. Creating a new name past that count is refused. Replacing an
  existing name is not. Lowering the cap below the current count is
  allowed and only blocks further creates. Applying a recipe that
  would pass the count is refused. The Settings tab edits it and can
  remove every script.
- `max_workspace_mib` is how large this agent's workspace may grow,
  in MiB. Stored default is 10240 (10 GiB). After each generation the
  orchestrator measures the workspace and stores it as `workspace_mib`
  on the agent. The Usage tab shows used against this cap. Above the
  effective cap (the agent's max, and never above the host's
  `WORKSPACE_MAX_MIB`, default 10240) the next generation fails at
  start with `workspace.full` until the operator frees space from the
  CLI tab or raises the agent's max.
- `max_tool_calls` is how many tool invocations a run may execute
  before it ends.
- `max_input_tokens` is the largest prompt the run may send to the
  model client after tool-result stubbing. Above that the run stops
  and asks for a new one. A coding run hands off at 70% of it and
  continues in a new run ([Runs](runs.md#run-chains)).
- `keep_tool_result_generations` is how many user turns, including
  the current one, keep full tool output in the model prompt. Default
  1: large tool results from earlier turns are stubbed. The stored
  transcript is unchanged ([Runs](runs.md#tool-result-stubbing)).
- `cli` is whether the operator can open a terminal on this agent's
  machine. It selects the CLI tab and the CLI API. It is not a
  binding. The runtime image already includes ttyd. The flag only
  exposes it.
- `box` is the machine the agent runs on: `lite`, `standard`, `code`,
  or `custom`. Lite is the small guest (0.5 CPU, 256Mi, the lite
  image: Python, the scripts launcher, ttyd) and never has `shell`,
  the code tools, a package manager, or a browser; it has `browser`
  and `coding` off. The other three run the standard image, with
  Chromium and the toolchains. Standard is the browser agent's machine
  (1 CPU, 2Gi) with `coding` off. Code is the coding agent's machine
  (2 CPU, 4Gi) with `coding` on. Custom is sized by the operator,
  `cpu` from 0.5 to 4 in steps of 0.25 and `memory_mib` from 512 to
  8192, with `coding` their choice; the two size keys exist only on a
  custom box. On every box but lite the operator chooses `browser`,
  on by default. A payload whose box disagrees with its flags is
  refused. A stored config without the key reads as the box its flags
  call for. Changing the box, or a custom box's size, replaces the
  sandbox. A toolchain the flags leave off stays in the image and is
  not offered.
- `browser` is whether this agent has Chromium. It selects the Browser
  pane, a live 1280×720 Chromium/noVNC session on the agent's box,
  and the eight Playwright tools on that agent's runs. It is not a
  binding. The two runtime images are instance-wide.
- `browser_language` is Chrome's UI and Accept-Language when
  `browser` is on: a tag from a fixed list, stored default `en-US`.
  Changing it destroys an idle sandbox so the next ensure starts
  Chrome in that language. Timezone still comes from the sandbox
  egress IP.
- `coding` makes the agent a coding agent: `HOME` at `/home/agent`,
  so package caches, toolchains, and git configuration persist across
  idle stops, the code tools
  ([Code tools](../tools-and-connectors/code.md)), and
  the `coding` section of the system prompt. It is on with the code
  box, off with lite and standard, and the operator's with custom. It
  is independent of `browser`. An agent that debugs a web front end
  has both. It is not a binding. The organisation policy's `max_coding_agents` bounds how
  many agents have it. Core sets no bound. Where an edition's policy
  does, creating a coding agent, or turning the flag on, is refused
  above it.
- `scripting` is whether this agent may keep and run Python scripts.
  It selects the State's Scripts view and the five script tools. Those
  tools remain bindings when the flag is on. When it is off they are
  not offered, whatever the bindings say. It is not itself a binding.
- `memory` is whether this agent hydrates Memory and may call
  `memory_write`. When it is off the opening system prompt omits the
  Memory section and the memory instructions in Guidelines, and
  `memory_write` is not offered, whatever the bindings say. The Memory
  tab stays. Missing means on. It is not itself a binding.
- `thinking_level` is `none`, `low`, `medium`, or `high`. Stored
  default is `none`. When it is not `none` the model request carries
  the effort in the field the provider takes
  ([Orchestrator](../architecture/orchestrator.md#model-client)).
  The picker greys it out for a model the catalog flags
  `thinking: false`, and saves `none` for it.
- `temperature` is sent unless the catalog flags the model
  `temperature: false`; the picker greys it out for such a model.
- `attachments` on a model of `GET /api/orgs/:id/models` is true when
  the catalog says it takes image parts. The Chat composer always
  shows a paperclip. It is disabled with a tooltip when the flag is
  false, and when the agent's model is not among the organisation's
  chosen models. Group chat does not take attachments.

Native tools and sandbox env values come from bindings (instance →
organisation → guild → agent), not from this JSON.

A login's settings (the folder a Drive login reads, the
repositories a GitHub login picks) live on that login in Tools.

The browser, code, (when `scripting` is off) script, and (when
`memory` is off) memory tools follow their flags, not only bindings.

Toggling `browser` or `coding` destroys an idle sandbox so the next
generation recreates it. Changing `browser_language` while `browser`
is on does the same. A generating agent keeps its sandbox until the
generation ends.

Toggling `cli`, `scripting`, or `memory` does not replace the
sandbox.

`model` is `{provider}/{model}`: a provider core speaks to
(`openai`, `openrouter`, `xai`, `deepinfra`, `local`, or `kimi`) and
the id that provider knows the model by. On save and on run the
provider must be connected for the organisation under **Settings**,
**Model keys**. Whether the catalog lists the id, or the organisation
chose it, is not checked: a catalog change or an unticked model never
breaks an existing agent.

No model is assumed. A new agent starts on the organisation's default
model when it has one, else the operator chooses; nothing is saved
without a choice.

The picker lists the organisation's chosen models, grouped by
provider, from `GET /api/orgs/:id/models`
([Users and organisations](users-and-organisations.md#model-providers)).
Each model carries what it takes (`thinking`, `temperature`,
`attachments`), its `context` window, and its `price` per million
tokens, as the catalog says. A stored model the organisation no longer
offers still shows as the current value.

Kimi Code ids (`kimi/…`) are only valid when `coding` is on; the
picker lists coding rows only for an agent with `coding` on.

Studio and Builder stay on marketplace models. Each run freezes the
chosen string.

Appearance lives beside config, not inside it.

`avatar_shape` is a seed matching `^[a-z0-9][a-z0-9:-]{0,62}$`,
optionally prefixed with a [DiceBear](https://www.dicebear.com/) style
(`critters`, `cameo`, `clay`, `cutouts`, `voxel-bot`,
`bottts-neutral`, or `pixelbot`) as `style:seed`. With no prefix the
renderer uses `clay`.

The stored default is `teardrop` (clay). The create dialog starts on a
random `critters:<seed>` in the signal identity colour (`#1fafd1`).
A builder write picks one mascot family for the guild and a unique
variant and identity colour for each role.

`avatar_color` is a six-digit hex (default `#7c5cff`).

The orchestrator renders `GET /avatars/:style.svg?seed=…&color=…` with
`apps/orchestrator/src/avatars/`. The create dialog and agent Settings
pick critters, cameo, clay, cutouts, voxel-bot, or bottts-neutral, a
random seed, and one of six identity colours. Stored `pixelbot:`
shapes still render.

`PUT /api/agents/:id/config` accepts the config keys plus optional
`name`, `avatar_shape`, `avatar_color`, `focus`, and `wake_triggers`.
Creating an agent accepts the same optional fields.

A new name must pass the same rules as create. It must stay globally
unique. It must not match an operator in that guild.

A generating agent cannot be renamed (409). One whose guild is being
deleted cannot be renamed (409).

Host notes folders that still use the name move with it. Artifact
paths stay on the id.

The guild header stacks member avatars. A click opens that agent's
inspector.

Avatars are UI only. They are not hydrated into the system prompt.

## Create

Creating a guild or agent writes PostgreSQL.

A new agent gets a `task` column (from the focus string when one was
given, otherwise `apps/orchestrator/src/prompts/task.md`) and a
`memory` artifact row.

A new guild stores `about`, `description`, and `max_agents` (default
15) on the guild row.

Later edits go through `PUT /api/guilds/:id` and
`PUT /api/guilds/:id/group-chat`.

`PUT /api/guilds/:id` takes `name`, `about`, `description`,
`max_agents`, `git_author_email`, `visibility`, and
`routines_enabled`. `PUT /api/guilds/:id/group-chat` takes
`agent_message_limit`.

The Settings tab saves the name, about, description, max_agents,
commit author email, visibility, routines, and the message limit.

A new name must pass the same rules as create. It must stay unique in
the organisation (409 otherwise).

A guild being deleted cannot be renamed (409). One with a member
generating cannot be renamed (409).

Host notes folders that still use the name move with it. Artifact
paths stay on the id.

A new agent's group-chat cursor starts at the guild's current
sequence. Creation does not replay old chat.

## Deletion

Deletion is the lifecycle surface. `archived_at` columns exist and
stay unused.

Deleting an agent refuses if that agent is generating.

It then:

- destroys the sandbox
- deletes the agent's collection grants (`collection_access` rows
  with that agent as subject)
- deletes every secret granted only to that agent
- deletes the agent row

PostgreSQL cascades that agent's:

- runs
- messages
- secret grants
- connections
- scoped bindings
- agent-level artifacts

A secret the agent stored that reaches others stays, with no creator.

The agent's usage counter goes with it. Guild, organisation, and
global totals stay.

Authored group messages stay, with the agent-name snapshot. Agent and
source-run references become empty.

The name may be reused.

Deleting a guild is an admin action. It refuses if a member is
generating or the dispatcher is busy.

It then:

- destroys every member sandbox
- deletes the collection grants held by the guild and by its members
- deletes every secret whose grants all name the guild or its
  members
- deletes the guild row

PostgreSQL cascades:

- agents
- runs
- group history
- operators
- secret grants
- connections
- scoped bindings
- guild issues
- guild-level artifacts

The guild's own tables are soft-deleted with their records.
Organisation collections and their records stay.

The guild and member-agent usage counters go with it. Organisation
and global totals stay.

These stay:

- organisation-wide and unassigned secrets
- secrets with a grant elsewhere
- instance bindings
- the connector catalog

Names may be reused.
