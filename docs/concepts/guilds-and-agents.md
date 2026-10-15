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
`repos/<name>` in its home, `/home/<agent id>/repos/<name>`
([Runs](runs.md#repositories)).

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

## Machines

An organisation owns a pool of machines. A machine is one
OpenSandbox container and one host directory, sized by a tier.
Every agent sits on exactly one machine of its organisation, and
many agents share one machine. A machine never spans
organisations.

| Tier | CPU | Memory |
| --- | --- | --- |
| `standard` | 1 | 2 GiB |
| `code` | 2 | 4 GiB |
| `custom` | 0.5 to 4, in steps of 0.25 | 512 to 8192 MiB |

Which agents a machine takes depends on its size, not its tier
([Machine sizing](#machine-sizing)).

Every machine runs the one runtime image (`SANDBOX_IMAGE`), with
Chromium and the coding toolchains. A machine row in `machines`
holds:

- `name`, matching `^[a-z][a-z0-9-]{0,62}$` and unique in the
  organisation
- `box`, the tier
- `cpu` and `memory_mib`, on a custom machine only
- `max_workspace_mib`, the disk cap over every home on it, default
  10240
- `workspace_mib`, the size of its directory as last measured
- `harnesses`, the coding harness CLIs its image carries, as the
  image lists them in `/usr/local/share/guilds/harnesses`. The
  orchestrator reads the list when it creates the machine's
  container and stores it when it changes. It is null until the
  container first started

Every path that creates an organisation (user creation,
`POST /api/orgs`, the boot seed) creates one `standard` machine
named `default` with it. An organisation that needs more room
resizes a machine or adds another one.

| Route | Who | Body or result |
| --- | --- | --- |
| `GET /api/orgs/:id/machines` | members | each machine with `cpu`, `memory_mib`, `max_workspace_mib`, `workspace_mib`, `allocated_workspace_mib`, `harnesses`, `planned_cpu` and `planned_mib` (its [planned load](#machine-sizing)), `agents` (id, name, guild, `browser`, `coding`), and `hidden_agents`, the number of agents of guilds the caller cannot see, which `agents` leaves out |
| `POST /api/orgs/:id/machines` | owners, admins | `name`, `box`, `cpu`?, `memory_mib`?, `max_workspace_mib`?; 201 with the machine |
| `PATCH /api/orgs/:id/machines/:machine_id` | owners, admins | the same fields; the body fills in what it leaves out from the machine |
| `DELETE /api/orgs/:id/machines/:machine_id` | owners, admins | 204 |
| `PUT /api/agents/:id/machine` | anyone who sees the guild | `machine_id` |

- Another organisation's id is 404.
- A write by a member who is neither owner nor admin is 403.
- A name the organisation already has is 409.
- Deleting a machine that still has agents is 409.
- Deleting the organisation's last machine is 409.
- Deleting a machine removes its container and its directory.
- Changing a machine's tier or size to below the minimum of an agent
  on it is 409.
- The organisation policy's `maxMachines` caps the machines. Past
  it, a create is refused with a limit error (409).
- The policy's `maxAgentsPerMachine` caps the agents on one machine.
  Past it, a placement is refused with a limit error (409).
- Both caps are unset in core.

Changing a machine's tier or size replaces its container. An idle
container goes at once. A busy one goes when its last generation
ends. The next work on the machine starts a container of the new
size. The machine's directory and every home in it stay.

### Placement

Agent create takes `machine_id`. With one machine in the
organisation the agent goes on it, and the field may be left out.
With more, it is required (422 without it). `PUT
/api/agents/:id/config` takes `machine_id` too, and moves the agent
when it names another machine. Agent payloads carry `machine_id`
and `machine` (`id`, `name`, `box`).

An agent goes only on a machine at or above its
[minimum](#machine-sizing). Creating an agent on a smaller machine is
422. Turning `browser` or `coding` on is 422 when the agent's machine
is below the minimum that sets. Moving an agent to a smaller machine
is 422.

A caller cannot place an agent on a machine that hosts an agent of
a guild the caller cannot see. Agent create, a `machine_id` in `PUT
/api/agents/:id/config`, and a move are refused there with 403
([SEC-26](../architecture/security-register.md#sec-26--a-member-could-place-an-agent-beside-a-private-guilds-agents)).

Each agent holds a slot on its machine, the lowest free one from 0
to 31. A machine holds at most 32 agents, whatever the policy says.
A full machine is 409. The slot `s` sets everything the agent
listens on inside the container:

| What | Value |
| --- | --- |
| X display | `:10+s`, its VNC server on `5910+s`, on loopback |
| Chrome DevTools | `9300+s` |
| noVNC | `6100+s` |
| ttyd | `7700+s` |
| The agent's own servers | `20000+100·s` to `20000+100·s+99` |

Each agent has its own home, `/home/<agent id>`, which is
`WORKSPACE_ROOT/<machine id>/<agent id>` on the host. It holds the
agent's `scripts/`, `.browser/` profile, a coding agent's `repos/`,
`.runs/`, `.gitconfig`, caches, and toolchains. Its runtime files
(git tokens, the terminal's token, logs) are under
`/run/guilds/<agent id>/`. Two agents on one machine keep their own
secrets, Chrome profile, logins, and tab, so they can hold two
accounts on one site. They generate at the same time.

`PUT /api/agents/:id/machine` moves an agent. The move:

1. stops the agent's processes on the machine it leaves
2. renames its home on the host
3. gives it the lowest free slot on the other machine

The move is refused in these cases:

- The agent is generating (409).
- The two machines keep their directories under different
  workspace roots (409).
- The target machine already holds a home for the agent (409).
- The target machine hosts an agent of a guild the caller cannot
  see (403).
- The edition does not support moving agents (501, `agents cannot
  move here`).

Agents on one machine trust each other. Commands run as root in
the shared container, so an agent can read every other agent's
home, git tokens, Chrome profile and cookies, and the environment
of a command running at the same moment
([Security register](../architecture/security-register.md#sec-24--agents-on-one-machine-can-read-each-others-homes-tokens-and-sessions)).
An agent whose data must stay apart goes on a machine of its own.

### Machine sizing

Machine sizing has two rules. Both live in `machines/index.ts`
(`AGENT_MINIMUMS` and `OVERCOMMIT`). The app mirrors them in
`features/machines/machines.ts`, and states them on Settings,
Machines, under every planned-load meter, and on the recipe page.

**An agent's minimum.** Each capability has the smallest machine
it runs on:

| Capability | CPU | Memory |
| --- | --- | --- |
| Every agent | 0.5 | 256 MiB |
| `browser` on | 1 | 2 GiB |
| `coding` on | 2 | 4 GiB |

An agent's minimum is the largest of the minimums of what it has on,
CPU and memory each, not their sum. Chrome and the coding toolchains
run only while the agent works. A machine below an agent's minimum
refuses it ([Placement](#placement)). With these values a `standard`
machine takes browser agents, a `code` machine coding agents, and a
`custom` machine whatever its size meets.

**Overcommit.** A machine's planned load is the sum of its agents'
minimums: `planned_cpu` and `planned_mib` in
`GET /api/orgs/:id/machines`. Few agents work at once, so a machine
takes more than it could run together. Its capacity is its size
times the overcommit factors:

| Resource | Factor | Capacity of a `standard` machine |
| --- | --- | --- |
| CPU | 5× | 5 CPUs |
| Memory | 3× | 6 GiB |

Memory gets the lower factor. Too little CPU slows agents down. Too
little memory gets their processes killed.

A placement past either capacity still saves. The Machines tab, the
machine picker, and the apply preview warn that agents on the
machine may slow down or run out of memory when many work at once.
Agents of guilds the caller cannot see count toward the planned load
and toward the machine's 32 slots.

Disk is reserved the same way. Each machine also returns
`allocated_workspace_mib`: the sum of its agents' own
`max_workspace_mib`, counting agents of guilds the caller cannot see.
What that sum leaves of the machine's `max_workspace_mib` is
unreserved. An agent whose cap is no larger than that can fill its
own cap before the machine reaches the machine's cap. A placement
past it still saves, and the app warns.

## Configuration and appearance

Agent configuration is nineteen required keys:

- `model`
- `temperature`
- `max_tokens`
- `max_steps`
- `max_tool_calls`
- `max_input_tokens`
- `keep_tool_result_generations`
- `max_scripts`
- `max_workspace_mib`
- `browser`
- `browser_language`
- `coding`
- `harness`
- `harness_model`
- `secret_aliases`
- `scripting`
- `memory`
- `thinking_level`

Unknown keys are rejected. The tier, CPU, and memory belong to the
machine ([Machines](#machines)). Missing keys take defaults:

- temperature 1
- 8192 tokens
- 30 steps
- 50 tool calls
- 100000 input tokens
- 1 live generation of tool results
- 10 scripts
- 10240 MiB of workspace
- scripting and Memory on
- thinking `none`
- browser language `en-US`
- `browser` and `coding` off, no `harness`, no `harness_model`, no
  secret aliases

An agent created with `coding` on and no step or tool-call limit
starts with 200 steps and 200 tool calls instead.

Settings offers Browser, Coding, scripting, and Memory under Agent
capabilities as four buttons. The create dialog offers the other
three, and asks for coding as the kind of agent on its first screen
([Operator app](operator-app.md#sidebar)). Browser and Coding are
unavailable while off on a machine below the minimum they would set
([Machine sizing](#machine-sizing)), and a saved coding agent keeps
Coding on. Every
agent has the CLI tab and the CLI API, a terminal on its machine
that the runtime image's ttyd serves: it is not a capability, and no
config key turns it off. When the organisation
has more than one machine, both offer the **Machine** picker with its planned
memory bar ([Machines](#machines)).

With Coding on, both require a **Harness** select, with a **Harness
model** field under it. Settings shows what the harness still needs
from `GET /api/agents/:id/harness`: `harness`, `harness_model`,
`machine_harnesses`, the harness CLIs the agent's machine carries
(null until its container first started), `repositories`, the names
of the guild repositories a coding run clones, and per harness its
`label`, the `secret` variable it reads its token from (null for
Codex), `secret_source`, the secret that variable reads (the one
`secret_aliases` maps it to, else its own name; null without a
`secret`), `secret_granted`, whether `secret_source` reaches the
agent, `secret_shadowed`, whether an alias is set and a secret of
the variable's own name also reaches the agent, the `login` to run
in the CLI tab, `login_seen_at`, when a
harness check last found a login in the agent's home, and
`login_account`, whose login it is (null when the login does not
say). `agents.harness_logins` keeps both per harness as
`{ seen_at, account }`; a value that is not an object reads as no
login. A check that finds no credential at all removes the entry.

`POST /api/agents/:id/harness/check` takes `{ harness }` (422 for an
unknown one; 503 when generation is unavailable). It wakes the
agent's machine and runs `guilds-harness check` outside any run,
without the agent's secrets: a granted secret reaches only a run, so
it reports a login or nothing. It returns `{ installed, version,
credential, account }`, `credential` being `login` or null and
`account` whose login it is, records a login it finds as seen with
its account, and removes the entry when the CLI is installed and no
login is found.

Scripting and Memory start on. The operator can turn either off.

- `max_scripts` is how many reusable Python scripts the agent may
  keep. Creating a new name past that count is refused. Replacing an
  existing name is not. Lowering the cap below the current count is
  allowed and only blocks further creates. Applying a recipe that
  would pass the count is refused. The Settings tab edits it and can
  remove every script.
- `max_workspace_mib` is how large this agent's home may grow, in
  MiB. Stored default is 10240 (10 GiB). After each generation the
  orchestrator measures the home and stores it as `workspace_mib` on
  the agent, and measures the machine's directory and stores it on
  the machine. The Usage tab shows the home against this cap and the
  machine against the machine's cap. Above the effective cap (the
  agent's max, and never above the host's `WORKSPACE_MAX_MIB`,
  default 10240), or with the machine above its own
  `max_workspace_mib`, the next generation fails at start with
  `workspace.full` until the operator frees space from the CLI tab
  or raises the cap.
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
- `browser` is whether this agent has its own Chrome on its machine.
  It selects the Browser pane, a live 1280×720 Chromium/noVNC session
  on the agent's display, and the eight Playwright tools on that
  agent's runs. It is not a binding. The runtime image is
  instance-wide. A toolchain the flags leave off stays in the image
  and is not offered.
- `browser_language` is Chrome's UI and Accept-Language when
  `browser` is on: a tag from a fixed list, stored default `en-US`.
  Changing it stops this agent's Chrome so its next start uses that
  language. Timezone still comes from the sandbox egress IP.
- `coding` makes the agent a coding agent: the code tools
  ([Code tools](../tools-and-connectors/code.md)) and the `coding`
  section of the system prompt. Package caches, toolchains, and git
  configuration persist in its home across idle stops. It needs a
  `code` or `custom` machine. An update cannot turn `coding` off on
  a coding agent (422 `coding cannot be switched off on a coding
  agent`). It is independent of `browser`. An agent that debugs a web
  front end has both. It is not a binding.
  The organisation policy's `max_coding_agents` bounds how many
  agents have it. Core sets no bound. Where an edition's policy
  does, creating a coding agent, or turning the flag on, is refused
  above it.
- `harness` is the coding harness a coding agent delegates code work
  to: `claude-code`, `codex`, or `cursor`, or null. It is only for an
  agent with `coding` on (422 otherwise). A coding agent needs one:
  every create and update with `coding` on and no `harness` is
  refused with 422 `coding agents need a harness: claude-code, codex,
  cursor`. A coding agent's runs offer `code_task`, and the
  `coding` section of its system prompt tells it to delegate code
  changes and check them
  ([Code tools](../tools-and-connectors/code.md#code-task)). The
  harness runs on the operator's own subscription: a token granted to
  the agent as a secret, or a login in the agent's CLI tab, stored in
  its home.
- `harness_model` is the model the harness runs, or null for the
  default of the harness's subscription. It is a model name of up to
  120 characters: letters, digits, and `. _ : / = , [ ] -`, starting
  with a letter or digit, such as an alias (`opus`) or a full name
  with bracketed parameters. A blank value saves as null. It needs a
  `harness` (422 otherwise). Its driver passes it to the CLI as
  `--model` ([Code tools](../tools-and-connectors/code.md#model)).
- `secret_aliases` maps environment variable names to secret names,
  default `{}`. In the run's environment each alias holds the value
  of the secret it names, when that secret reaches the agent, and
  wins over a secret of its own name
  ([Secrets and access](secrets-and-access.md#aliases)). Keys and
  values are variable names, a value differs from its key, and the
  map holds at most 32 entries (422 otherwise). It is generic: any
  tool that reads a fixed variable can be pointed at a secret of
  another name. The **Subscription token** select in Settings writes
  the harness's variable ([Operator app](operator-app.md#agent)).

A coding agent stored without a harness is not ready. Its stored
config still validates, so it stays an agent and its runs are still
created, but:

- a coding run of it fails at start, before its machine is woken,
  with the run error `harness.missing` ("no harness is picked: choose
  Claude Code, Codex, or Cursor in the agent's Settings"). The check
  reads the run snapshot. A run with `coding` off is unaffected
- its settings save only with a harness picked
- its header and Settings name the missing harness as a readiness
  problem ([Operator app](operator-app.md#agent))
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

Turning `browser` off, or changing `browser_language` while it is
on, stops this agent's Chrome. Other agents on the machine keep
theirs. No configuration change replaces the machine's container.

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

- stops the agent's Chrome and terminal on its machine, and removes
  its home and its `/run/guilds/<agent id>/` files; the machine's
  container stays up for the other agents on it
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

- does the same on each member's machine
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
