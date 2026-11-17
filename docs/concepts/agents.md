# Agents

An agent is one worker in a [guild](guilds.md). It has a name, a
short focus that says what it is for, a model source it thinks with,
and a few switches that decide what it can do. It works in
[runs](runs.md): a chat with an operator, a wake-up from the
[group chat](group-chat.md), or a [routine](routines.md).

Every agent belongs to exactly one guild for its whole life, and sits
on one of the organisation's [machines](machines.md). What it is told
to do lives in its [Task](task.md). What it remembers between runs
lives in its [Memory](memory.md). The tools and secrets it may use
come from [access](access.md), not from the agent itself.

## When you use it

You add an agent when the guild needs a new role: a researcher, a
writer, a reviewer, a coder. You change an agent when it should think
with another model, take longer runs, or gain a capability such as
its own browser.

There are two kinds of agent, by their model source:

- an **agent on a key** talks, researches, and works with tools and
  connectors on one of the organisation's models;
- a **subscription agent** has no model: its harness, on the
  operator's own subscription, is its model source; Cursor and
  Antigravity only for an agent with a repository. Each
  generation of its run is one turn of the harness, with the
  harness's own tools and the platform's tools it is offered
  ([Model source](#model-source)). Its harness's shell makes it the
  agent that writes code.

Either kind may pick among the guild's repositories, some of them
read-only; its generations clone them into its home
([Code work](coding/index.md)). An agent on a key has no shell, and
works in them with its scripts.

## How it works

### Identity

- **Name**: lowercase letters, digits, and hyphens, starting with a
  letter. A name is unique across the whole instance. `user` is
  reserved: it is the tag that reaches every operator. The name can
  change later.
- **Focus**: one short line on what the agent is for, up to 150
  characters. Every member of the guild sees the others' focus in its
  system prompt, so the agents know each other's role. A new agent's
  Task starts from its focus.
- **Wake triggers**: an optional text, up to 500 characters, that
  completes "Wake me when…". It describes the untagged group-chat
  messages the agent should answer. The field shows the focus while
  it is empty. The operator writes it, and recipes carry it. Nothing
  reads it at run time: it is not in the system prompt, and the
  group-chat router does not weigh it
  ([Group chat](group-chat.md#who-wakes-up)).
- **Avatar**: a mascot and an identity colour. They only change how
  the agent looks in the app. The agent never sees them.

### Model source

An agent has one model source: a **model on a key** or a
**subscription**. Nothing stores the choice apart: an agent with a
`model` is on a key, and an agent with no `model` and a `harness` is
on a subscription.

On a key, the agent thinks with one model, written as
`provider/model`. The provider must be connected for the organisation
under **Settings**, **Model keys** ([Model keys](model-keys.md)). No
model is assumed: a new agent starts on the organisation's default
model when it has one, otherwise the operator picks one.

On a subscription, the agent names a harness, its model, and its
effort ([Harnesses](coding/harnesses.md#subscription-agents)), and
the harness runs on the operator's own subscription. Cursor and
Antigravity keep their own system prompt, so they run a subscription
agent only with a repository: an agent that does code work.
The settings of the orchestrator's model loop do not apply to it:
temperature, thinking level, max output tokens, max input tokens, and
keep tool results stay at their defaults.

Each generation of a subscription agent's run is one turn of its
harness's CLI in the agent's sandbox: the run's composed system prompt
replaces the CLI's own on Claude Code and Codex, and reaches Cursor
and Antigravity as rules beside theirs; the messages that opened the
generation are its prompt, and the run shows what it writes and the
tools it uses ([Runs](runs.md#harness-turns)). The
run's next generation resumes the same session. A subscription agent:

- is offered the tools a model on a key would be, connectors
  included: its harness calls them on the
  orchestrator's MCP server, under a token of the generation's
  ([Tools in a run](../tools-and-connectors/tools-in-a-run.md#a-subscription-agents-run)),
  beside the harness's own tools. Each call counts toward
  `max_tool_calls`, with every call of the harness's own;
- takes images attached to a message as files in its home, whose
  paths its prompt names ([Runs](runs.md#attachments));
- works in the repositories it picks, if any: its turn clones them,
  starts in its one repository, and pushes branches through git's
  credential helper with a token that pushes alone
  ([Repositories](coding/repositories.md#what-a-generation-does-with-them));
- records each turn's tokens on its reply, at no price
  ([Usage](usage.md#cost-of-a-harness-turn)), and stops a turn after
  its **Max turn minutes**.

Next to a model on a key sit three options:

- **Thinking level**: none, low, medium, or high. It is greyed out for
  a model that does not think.
- **Temperature**: sent with every request, unless the model does not
  take one.
- **Attachments**: whether the operator can send images in the Chat
  tab. This follows the model; it is not a setting.

Each run freezes the model it starts with. Changing the model affects
new runs only.

### Run limits

Run limits stop a run that goes on too long:

| Limit | What it bounds | Default |
| --- | --- | --- |
| Max output tokens | the length of one model reply | 8192 |
| Max steps | model calls in one generation | 30 |
| Max tool calls | tool calls in one run | 50 |
| Max input tokens | the size of the prompt sent to the model | 100000 |
| Max wake-ups | the wake-ups one run may fire | 10 |
| Max turn minutes | how long one turn of a subscription agent's harness runs before it is stopped | 30 |
| Keep tool results | how many user turns keep full tool output in the prompt; older large results are stubbed | empty: the guild's ([Guilds](guilds.md#other-guild-settings)) |

Only a guild admin sets, changes, or clears an agent's **Keep tool
results**. Anyone else's save that changes it is refused; one that
leaves it as it is passes.

A subscription agent's **Run limits** show Max steps, Max tool calls, Max wake-ups,
and Max turn minutes; its Max steps bounds the model calls of one turn
on Claude Code, and Codex has no such limit; an agent on a key shows every limit but Max
turn minutes, which its runs do not read. What happens at each limit
is on [Runs](runs.md).

### Capabilities

Three switches turn whole areas of the product on or off for one
agent. They are not tool bindings: when a switch is off, its tools are
not offered, whatever the bindings say.

| Switch | Gives the agent | Default | Page |
| --- | --- | --- | --- |
| Browser | its own Chrome on its machine, and the browser tools | off | [Browser](browser.md) |
| Scripting | reusable Python scripts and the script tools | on | [Scripts](scripts.md) |
| Memory | a Memory that it reads and rewrites after each run | on | [Memory](memory.md) |

Browser needs a large enough machine, as a subscription agent's
harness does ([Machines](machines.md#machine-sizing)).

Every agent also has a terminal on its machine, the **CLI** tab. It is
not a capability and no switch turns it off
([Agent home](agent-home.md)).

### Life of an agent

```mermaid
flowchart LR
    create["Create<br/>(name, focus, model, machine)"] --> work["Runs<br/>(chat, group chat, routines)"]
    work --> edit["Settings<br/>(rename, model, limits, switches)"]
    edit --> work
    work --> delete["Delete<br/>(type its name)"]
```

- **Create.** The agent gets its Task (from its focus, or a default
  text) and an empty Memory. It joins the group chat at the current
  message: it does not replay older chat.
- **Rename.** The name can change while the agent is idle. Its stored
  records keep the same id, so nothing breaks.
- **Delete.** The agent, its runs, its routines, its Memory, and its
  home go, with the access rows naming it. Every note and file stays
  under its home, greyed on the pages where no row reaches it any
  more. An agent of a private guild leaves the notes and files with
  no home that only its rows reached homed in that guild, so they
  stay hidden from the operators outside it. Its posts in the group chat stay, under the name it had.

## In the app

### Sidebar

Each guild folds open to its agents and an **Add agent** row. The row
is disabled once the guild is full. Each agent row shows:

- its avatar;
- a live state dot: signal green while it runs, a quiet dot when
  idle, red while a blocking issue disables it
  ([Inbox and issues](inbox.md#disabled-agents));
- a code marker, "Runs on a subscription", on a subscription agent;
- a marker for browser access;
- a marker naming the notes or collections its Task embeds that the
  agent cannot reach ([Task](task.md#an-embed-the-agent-cannot-reach)).

### Create an agent

**Add agent** opens **Create an agent**: four steps on a stepper. The header reads
"Step n of 4 · `<step>`". **Back** and **Next** move between steps, and
**Cancel** is always there. Each step must be complete before
**Next**.

1. **Identity**: the name (it can change later in Settings), an
   optional focus, and an avatar picker: a mascot set, a random
   variant, and one of six identity colours.
2. **Model**: it starts with **Model source**: **Model on a key** or **Subscription**. Under
   **Subscription** a line reads "The harness runs every turn on your
   own subscription, with its own tools and the guild's tools this
   agent is given." On a key, the
   model, from the organisation's chosen models grouped by provider,
   preselected with its default when it has one. With no provider
   connected, the step shows a guide to **Model keys** in its place.
   On a subscription, the step is titled **Harness** and holds the
   harness, its model and effort, the
   capabilities, and the run limits a harness keeps; no provider is
   needed. Then the thinking level and the temperature, each switched
   off only for a model that does not take it. Then **Agent
   capabilities**, three buttons: Browser, scripting, and Memory.
   Scripting and Memory start on; Browser starts off. The browser
   language and **Agent-optimized browser** show while Browser is on,
   and **Browser model** while that is on
   ([Browser](browser.md#in-the-app)). **Run limits** sit folded under
   a disclosure: the five run limits and **Max scripts**.
3. **Machine**: which machine the agent goes on, and **Disk** under
   it. With one machine the step names it in place of the picker. See
   [Machines](machines.md) and [Agent home](agent-home.md).
4. **Repositories**, optional: the guild's repositories the agent
   works on, each with a **Read-only** switch, over the guild's GitHub
   login and its repositories added by URL
   ([The agent's Repositories](coding/repositories.md#the-agents-repositories)).

**Create agent** creates the agent. It opens on its **Prompt** tab.

### Agent inspector

Selecting an agent opens its inspector, a sheet over the guild's
group chat. On a wide screen, the expand control fills the window
instead; the choice is remembered.

The header shows the avatar, the name, whether the agent is running,
idle, or disabled, and its focus. Under the header of a disabled
agent, a red band names the blocking issue and offers **Mark as
resolved** and **Open issue**
([Inbox and issues](inbox.md#disabled-agents)). When the Task embeds notes or collections the agent cannot reach, an
unlink button in the header names them and opens the Prompt tab
([Task](task.md#an-embed-the-agent-cannot-reach)).

A **Browser login needed** strip can show after a recipe apply
([Browser](browser.md)).

The menu deletes the agent after the operator types its name. The
confirm reads: "Its sessions, routines, Memory, home, usage row and
the access rows naming it are removed; every note and file stays, and
its posts stay in the group chat. This can't be undone."

The tabs, one route each, with an icon each. The tab strip scrolls
sideways when they do not fit.

| Tab | What it holds | Explained in |
| --- | --- | --- |
| **Chat** | sessions with the agent, their transcripts, and **History** | [Runs](runs.md), [Run transcript](run-transcript.md) |
| **Prompt** | the standing Task | [Task](task.md) |
| **State** | Memory, Notes, Files, Tables, Access, Scripts (with scripting on) | [Memory](memory.md), [Notes](notes.md), [Files](files.md), [Collections](collections.md#what-a-guild-or-an-agent-reaches), [Access](access.md#what-a-guild-or-an-agent-reaches), [Scripts](scripts.md) |
| **Routine** | the agent's routines | [Routines](routines.md) |
| **Browser** | the agent's live Chrome, only with Browser on | [Browser](browser.md) |
| **CLI** | a terminal on the agent's machine | [Agent home](agent-home.md) |
| **Tools**, **Secrets** | the agent-scope access view | [Access](access.md) |
| **Usage** | tokens, cost, calls, and disk | [Usage](usage.md) |
| **Settings** | everything on this page | below |

The agent's **State › Notes** and **State › Files** list what its
guild's page lists, shown the same way: the items homed in the
agent's guild, and those shared with the guild. Each item carries the
agent's own mode on it, **Read & write** or **Read**, and an item no
row reaches the agent is greyed, **No access**
([Notes](notes.md#in-the-app), [Files](files.md#in-the-app)). A note
or a file the agent creates is homed in its guild.

### Settings tab

Settings shows the create dialog's steps as sections on a stepper.
They open in any order. Clicking a step opens its section, and the URL
keeps it as `?section=` (`identity`, `model`, `machine`, `harness`,
or `repositories`), so a link can open Settings on one section.
Without one, Settings opens on Identity. A section the agent's kind
lacks opens where its content lives: `harness` opens Model on an
agent on a key, and `model` opens Harness on a subscription agent.

An agent on a key has **Identity**, **Model**, **Machine**, and
**Repositories**. A subscription agent has **Identity**, **Harness**,
**Machine**, and **Repositories** ([Harnesses](coding/harnesses.md#harness-section-of-settings)).
The sections follow the form's **Model source**, so picking another
source changes them before the save. **Model source** shows at the top of an agent's Model, and
of a subscription agent's Harness. A step whose fields
have an error carries a warning in place of its number. A
subscription agent whose harness is not ready opens on a banner that
lists what is missing. One **Save** and
one **Discard** at the bottom cover every section. Enter in a field
saves.

- **Identity**: the name, the focus, the avatar picker, and **Wake me
  when** under **Group chat**, which shows the focus while it is
  empty.
- **Model**: the model, thinking, and temperature. **Agent
  capabilities** has three buttons: Browser, scripting, and Memory.
  **Run limits** sits under a disclosure, with the six run limits and
  **Max scripts**. Browser is greyed out while off on a machine below
  the minimum it needs, with a line naming both sizes. The browser
  language and
  **Agent-optimized browser** show while Browser is on, and **Browser
  model** while that is on ([Browser](browser.md#in-the-app)).
- **Machine**: the machine picker and **Disk**
  ([Machines](machines.md), [Agent home](agent-home.md)).
- **Harness**, on a subscription agent:
  [Harnesses](coding/harnesses.md).
- **Repositories**, on every agent:
  [Repositories](coding/repositories.md#the-agents-repositories). It
  ticks the repositories the agent works on, each writable or
  read-only, saved with the rest of Settings.

## Rules and limits

| Rule | Value or behaviour |
| --- | --- |
| Name | `a`–`z`, `0`–`9`, `-`; starts with a letter; at most 63 characters |
| Name uniqueness | unique across the instance; never `user`; never the name of an operator of the guild |
| Focus | at most 150 characters |
| Wake triggers | at most 500 characters |
| Secret aliases | at most 32 |
| Subscription agent | no model; a harness, and on Cursor or Antigravity a repository; loop settings at their defaults; each generation one turn of its harness, offered the platform's tools through the orchestrator's MCP server |
| Repositories | on any agent, optional; each one the agent can use, some of them read-only ([Repositories](coding/repositories.md)) |
| Agents per guild | the guild's `max_agents` ([Guilds](guilds.md)) |
| Model | its provider must be connected for the organisation; null only for a subscription agent |
| Rename | refused while the agent generates, or while its guild is being deleted |
| Delete | refused while the agent generates |
| Configuration change | affects new runs only |

## Reference

### Configuration keys

Agent configuration is a JSON object of twenty-four keys. A missing key
takes its default, then the check runs. `model` has no default, so a
configuration without it is 422 `missing keys: model`; a subscription
agent sends `model: null`. Unknown keys
are rejected. The tier, CPU, and memory belong to the machine, not to
the agent.

| Key | Type | Default | Explained in |
| --- | --- | --- | --- |
| `model` | `provider/model`, or null for a subscription agent | none, must be given | [Model](#model-id-and-options) |
| `temperature` | number | `1` | [Model](#model-id-and-options) |
| `thinking_level` | `none`, `low`, `medium`, `high` | `none` | [Model](#model-id-and-options) |
| `max_tokens` | positive integer | `8192` | [Runs](runs.md) |
| `max_steps` | positive integer | `30` | [Runs](runs.md#generation) |
| `max_tool_calls` | positive integer | `50` | [Runs](runs.md#generation) |
| `max_input_tokens` | positive integer | `100000` | [Runs](runs.md#generation) |
| `max_wake_ups` | positive integer | `10` | [Runs](runs.md#snapshot) |
| `max_turn_minutes` | positive integer | `30` | [Runs](runs.md#harness-turns) |
| `keep_tool_result_generations` | positive integer, or null for the guild's `keep_tool_result_generations` | `null` | [Runs](runs.md#tool-result-stubbing) |
| `max_scripts` | positive integer | `10` | [Scripts](scripts.md) |
| `max_workspace_mib` | positive integer | `10240` | [Agent home](agent-home.md) |
| `browser` | boolean | `false` | [Browser](browser.md) |
| `browser_language` | Chrome language tag | `en-US` | [Browser](browser.md) |
| `browser_optimized` | boolean; needs `browser` | `false` | [Browser](browser.md#config-keys) |
| `browser_model` | `provider/model`, while `browser_optimized` is on; else null | `null` | [Browser](browser.md#config-keys) |
| `harness` | `claude-code`, `codex`, `cursor`, `antigravity`, or null; only without a model | `null` | [Harnesses](coding/harnesses.md) |
| `harness_model` | model name of at most 120 characters, or null; needs a harness | `null` | [Harnesses](coding/harnesses.md) |
| `harness_effort` | effort or null; needs a harness | `null` | [Harnesses](coding/harnesses.md#model-and-effort) |
| `repositories` | list of repository names, each once, that the agent can use | `[]` | [Repositories](coding/repositories.md#an-agents-picks) |
| `read_only_repositories` | list of names of `repositories`, each once, that the agent only reads | `[]` | [Read-only repositories](coding/repositories.md#read-only-repositories) |
| `secret_aliases` | map of variable name to secret name, at most 32 entries | `{}` | [Secrets](secrets.md#aliases) |
| `scripting` | boolean | `true` | [Scripts](scripts.md) |
| `memory` | boolean | `true` | [Memory](memory.md) |

Any other key, `coding` among them, is 422 `unknown keys: <keys>`.

The model source is checked on every create and update, each a 422:

| Configuration | Refusal |
| --- | --- |
| `model` blank or not a string | `model must be a non-empty string, or null for a subscription agent` |
| a `model` and a `harness` | `harness is for a subscription agent, which has no model` |
| no `model`, no `harness` | `an agent without a model is a subscription agent: it needs a harness` |
| no `model`, and `temperature`, `thinking_level`, `max_tokens`, `max_input_tokens`, or `keep_tool_result_generations` off its default | `a subscription agent takes no <keys>: they set the model loop, which its harness replaces` |

A switch from a subscription to a model on a key, and back, is one
update of `model` and `harness`.

A subscription agent on Cursor or Antigravity needs a repository: a
create, and an update that removes its last repository or switches it
to one of them, without one is 422 "`<Harness>` runs a subscription
agent only with a repository, since it keeps its own system prompt:
pick a repository, or another harness". A stored agent whose
repositories are all gone still loads; its runs fail at start with
`coding.repositories_missing` ([Runs](runs.md#harness-turns)).

Validation errors are 422 with the message, for example
`name must match ^[a-z][a-z0-9-]{0,62}$`, `max_steps must be a
positive integer`, `missing keys: …`, or `unknown keys: …`.

Native tools come from bindings (instance → organisation → guild →
agent) and sandbox environment values from secret grants, not from
this JSON ([Access](access.md), [Secrets](secrets.md)). A login's
settings, such as the folder a Drive login reads or the repositories a
GitHub login picks, live on that login in Tools; an agent picks among
them, and among its guild's repositories, in `repositories`. The browser,
script (when `scripting` is off), and memory (when `memory` is off)
tools follow their flags, not only the bindings.

Turning `browser` off, or changing `browser_language` while it is on,
stops this agent's Chrome. Other agents on the machine keep theirs. No
configuration change replaces the machine's container
([Machines](machines.md)).

### Model id and options

`model` is `{provider}/{model}`: a provider core speaks to (`openai`,
`anthropic`, `openrouter`, `xai`, `deepinfra`, or `local`) and
the id that provider knows the model by. On save and on run the
provider must be connected for the organisation (422
`connect a <provider> key on Model keys` otherwise). Whether the catalog lists
the id, or the organisation chose it, is not checked: a catalog change
or an unticked model never breaks an existing agent.

The picker lists the organisation's chosen models, grouped by
provider, from `GET /api/orgs/:id/models`
([Model keys](model-keys.md)). Each model carries what it takes
(`thinking`, `temperature`, `attachments`), its `context` window, and
its `price` per million tokens, as the catalog says. A stored model
the organisation no longer offers still shows as the current value.

- `thinking_level`: when it is not `none`, the model request carries
  the effort in the field the provider takes
  ([Orchestrator](../architecture/orchestrator.md#model-client)).
  `off`, `disabled`, and an empty value save as `none`. The picker
  greys it out for a model the catalog flags `thinking: false`, and
  saves `none` for it.
- `temperature` is sent unless the catalog flags the model
  `temperature: false`. The picker greys it out for such a model.
- `attachments` on a model of `GET /api/orgs/:id/models` is true when
  the catalog says it takes image parts. The Chat composer always
  shows a paperclip. It is disabled with a tooltip when the flag is
  false, and when the agent's model is not among the organisation's
  chosen models ([Runs](runs.md#attachments)). Group chat does not
  take attachments.

Studio and Builder stay on marketplace models. Each run freezes the
chosen model string.

### Appearance

Appearance lives beside the configuration, not inside it.

`avatar_shape` is a seed matching `^[a-z0-9][a-z0-9:-]{0,62}$`,
optionally prefixed with a [DiceBear](https://www.dicebear.com/) style
(`critters`, `cameo`, `clay`, `cutouts`, `voxel-bot`,
`bottts-neutral`, or `pixelbot`) as `style:seed`. With no prefix the
renderer uses `clay`. The stored default is `teardrop` (clay).

`avatar_color` is a six-digit hex colour, default `#7c5cff`.

The create dialog starts on a random `critters:<seed>` in the signal
identity colour (`#1fafd1`). The create dialog and agent Settings pick
critters, cameo, clay, cutouts, voxel-bot, or bottts-neutral, a random
seed, and one of six identity colours. Stored `pixelbot:` shapes still
render. A builder write picks one mascot family for the guild and a
unique variant and identity colour for each role.

The orchestrator renders `GET /avatars/:style.svg?seed=…&color=…`
with `apps/orchestrator/src/avatars/`.

### Focus and wake triggers

`focus` (at most 150 characters) is hydrated into each member's entry
of the State snapshot's `group.members`
([System prompt](system-prompt.md)). It also seeds the agent's `task`
at create, and it is part of each option the group-chat router weighs
([Group chat](group-chat.md#recipient-routing)).

`wake_triggers` (at most 500 characters) is stored on the agent,
written by the operator, and carried in recipes. The Guild builder's
write schema leaves it out. It is not hydrated into the system
prompt, and it is not part of the recipient Choice.

### HTTP

| Route | Does | Success | Refusals |
| --- | --- | --- | --- |
| `GET /api/guilds/:id/agents` | lists the guild's agents with their busy state and `model_source` (`key` or `subscription`) | 200 | |
| `POST /api/guilds/:id/agents` | creates an agent from `name`, `config`, and optional `focus`, `wake_triggers`, `avatar_shape`, `avatar_color`, `machine_id` | 201 | 422 validation or model not connected; 403 a `keep_tool_result_generations` of its own from someone not a guild admin; 409 guild being deleted, `this guild is limited to N agents`, name taken, or an operator of that name; a placement refusal; an extension's policy limit |
| `GET /api/agents/:id` | the agent, with `model_source` | 200 | 404 |
| `PUT /api/agents/:id/config` | saves `config` plus optional `name`, `avatar_shape`, `avatar_color`, `focus`, `wake_triggers`, `machine_id` | 200 | 422 validation; 403 a `keep_tool_result_generations` change from someone not a guild admin; 409 rename while generating or while the guild is being deleted, name taken; a placement refusal; an extension's policy limit |
| `PUT /api/agents/:id/machine` | moves the agent to `machine_id` ([Machines](machines.md#move-rules)) | 200 | a placement refusal |
| `DELETE /api/agents/:id` | deletes the agent | 204 | 409 generating; 404 |
| `GET /api/guilds/:id/embed-status` | each agent's `broken_embeds` | 200 | |

`name`, `focus`, `wake_triggers`, `avatar_shape` and `avatar_color`
are strings, and `machine_id` a string or null; a field of another
type is 422 naming it. `config` is checked by the agent's config
rules.

`machine_id` on create or update places or moves the agent
([Machines](machines.md)). Placement refuses a full machine (409
`machine <name> is full`) and a machine below what the agent needs
(`<what> needs a machine with at least <size>; <machine> has <size>`).
The organisation policy of an extension may cap agents, browser
agents, and subscription agents per organisation; core sets no cap. A
policy refusal is 409 `<source> limit reached: <cap>`.

### Create

Creating an agent writes PostgreSQL. A new agent gets:

- a `task` column, from the focus when one was given, otherwise from
  `task.md` in `TEMPLATES_ROOT` (`apps/orchestrator/src/prompts/task.md`
  by default), or a one-line default Task when that file does not
  exist; a `task.md` that exists but cannot be read fails the create;
- a `memory` artifact row;
- a group-chat cursor at the guild's current sequence, so it does not
  replay old chat.

### Rename

A new name passes the same rules as on create. It stays unique across
the instance (409 `agent name already exists`) and must not match an
operator of the guild (409 `<name> is already an operator in this
guild`). A generating agent cannot be renamed (409). An agent whose
guild is being deleted cannot be renamed (409).

Database ids stay stable across a rename, and when a name is reused
after a delete. Display paths use those ids, so artifact paths stay
on the id. Host notes folders that still use the name move with it.

### Delete

Deletion is the only way to retire an agent.

Deleting an agent refuses while it is generating (409 `agent is
already generating`). It then:

- stops the agent's Chrome and terminal on its machine, and removes
  its home and its `/run/guilds/<agent id>/` files; the machine's
  container stays up for the other agents on it;
- for an agent of a private guild, first homes in that guild every
  note and file, live or deleted, with no home whose access list is
  not empty and names only the agent, so it stays hidden from the
  operators outside the guild and is listed greyed in the guild's own
  section;
- deletes the access-list rows that name the agent
  (`artifact_access`) and nothing else of a note or a file: every one
  stays, live or deleted, under its home, the one the agent created
  in its guild included;
- deletes every secret granted only to that agent;
- deletes the agent row.

PostgreSQL cascades the agent's runs, messages, schedules, secret
grants, connections, scoped bindings, Memory, and scripts. A
secret the agent stored that reaches others stays, with no creator.

The agent's usage counter goes with it. Guild, organisation, and
global totals stay ([Usage](usage.md)).

Authored group messages stay, with the agent-name snapshot. Their
agent and source-run references become empty.

The name may be reused.

### Code

- `apps/orchestrator/src/agents/config.ts`: configuration keys and
  defaults
- `apps/orchestrator/src/agents/validation.ts`: the parse of a
  configuration payload into an agent's config, and the name, focus,
  wake triggers, and avatar rules
- `apps/orchestrator/src/agents/view.ts`: an agent as its guild's list
  and its page show it
- `apps/orchestrator/src/avatars/`: the default look, the stored shape
  and colour formats, and the renderer
- `apps/orchestrator/src/agents/service.ts`: create, configure, move,
  and delete
- `apps/orchestrator/src/http/agent-routes.ts`: agent routes
- `apps/web/src/features/agent/`: the create dialog, inspector, and
  Settings
