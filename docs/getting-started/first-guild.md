# Your first guild

A walk through the operator app, from an empty box to a guild with
one agent that talks, keeps a memory, wakes on a schedule, and uses
a tool. Then that guild saved as a recipe, and a second one stood up
from a recipe file.

It needs a provider connected ([Model keys](model-keys.md)). It uses
one small example you can type as is or replace with your own.

Screens are described in full in
[Operator app](../concepts/operator-app.md).

## Six words

- A **guild** is a department: named agents, a shared room (the
  group chat), shared notes and tables.
- An **agent** is one role in it, on the model, the tools, and the
  machine you pick for that role.
- The **Task** is the standing instruction you write for an agent.
  It is your part of every prompt the agent runs with.
- A **run** is one conversation between an agent and its model:
  every prompt, every tool call, every result, kept.
- A **routine** wakes an agent on a schedule with an instruction.
- A **recipe** is a guild's configuration as one file, to apply on
  another box.

## Open the app

`http://127.0.0.1:8080/` opens on the box's operator.

With no guild yet the page says **No guilds yet** and offers two
ways in: **Create a guild** for full control, or **Use Builder** for
a quick start. The sidebar on the left lists guilds under a
**Guilds** header. Its footer holds:

- **Inbox** — issues agents report and messages that tag you
- **Builder** — drafts a recipe from a conversation
- **Recipes** — the recipe library
- **Databases** — the organisation's tables
- the account button, with your name and organisation; its menu sets
  the theme and opens **Settings** and **Admin**

This walk builds the first guild by hand, so each screen is met once.
The Builder comes at the end.

## 1. Create a guild

**Create a guild** on that page, or **+** on the **Guilds** header,
opens **Create a guild**:

- **Name** — `research`
- **Short description** — one line, the goal everyone in the guild
  shares. It shows in the guild header and agents read it:
  `Keep a shared understanding of one topic`
- **Description** — what the guild is for, how it should work,
  constraints. Agents read it on every run; it is edited later in
  **Settings**. Leave it empty for now.
- **Private**, on by default, keeps the guild to its operators.

You become the guild's admin. The guild opens at `/guilds/<id>` on
its **Group chat** tab. The header shows its name, its agent count,
and a menu. The tabs under the header are the guild's pages:
**Group chat**, **Settings**, **State**, **Routines**, **Issues**,
**Tools**, **Secrets**, **Usage**. The walk visits them in turn.

## 2. Add an agent

**Add agent** under the guild in the sidebar (or **New agent** in the
guild menu) opens **Create an agent**. It has six groups. The first
is the one to fill; the others hold defaults that suit a first agent.

- **Identity** — **Name** `researcher`. Other agents tag it with
  `@name`; it can change later in **Settings**. **Focus**, optional,
  is one line on what the agent is for:
  `Answers the guild's questions and remembers what it was asked`.
  Other agents see it next to the name, and it starts the Task you
  write next. The avatar picker gives the agent a
  [DiceBear](https://www.dicebear.com/) mascot and one of six
  identity colours.
- **Model** — one of the organisation's chosen models, preselected
  with the default, and a thinking level and temperature where the
  model takes them. While no provider is connected, a guide to Model
  keys stands in for the picker.
- **Run limits** — the most output tokens per reply, model steps per
  generation, tool calls per run, and input tokens before a run
  stops.
- **Disk** — **Max disk** (the workspace cap, 10240 MiB by default)
  beside **Max scripts** (how many reusable Python files it may
  keep, 10 by default).
- **Box** — four buttons for the machine the agent gets. **Lite**,
  the default, is the smallest: scripts, notes, connectors, and a
  terminal, no browser. **Standard** adds a browser on a medium
  machine. **Code** adds the coding toolchains on the large one.
  **Custom** is the browser machine at a size you type, with coding
  on or off. Lite is enough here.
- **Agent capabilities** — four buttons: **Browser**, **CLI**,
  **Scripting**, and **Memory**. CLI, scripting, and Memory start
  on. Browser is off on Lite (and unavailable there). Memory is
  what lets the agent carry something from one run to the next.

**Create agent**. The agent appears under the guild in the sidebar,
and its inspector opens on the **Prompt** tab.

The inspector is a sheet over the group chat. Its tabs are the
agent's pages: **Chat**, **Prompt**, **State**, **Routine**,
**Browser** (on a box with one), **CLI**, **Tools**, **Secrets**,
**Usage**, **Settings**.

## 3. Write the Task

Every run starts from one system prompt the orchestrator composes
from four parts: the **Guidelines** every agent shares, your
**Task**, a **State** snapshot (the guild, its members, the last
public messages, what the agent can reach), and the agent's
**Memory**. The Task is the only part you write.

The **Prompt** tab edits it. It opens with the focus as its first
line. Write what the agent does, how, and what it keeps:

```text
You answer the guild's questions briefly, and say when you are not sure.
Keep in memory what each person asked and what you answered, so a later question can build on it.
```

Save (or Cmd/Ctrl+S). Each save archives the previous version. The
**Version** picker shows any earlier one, **Compare with live** shows
the change, and **Restore** brings one back.

**Insert** embeds a note or a table in the Task as
`![[display-path]]`. A shared note the guild maintains is then read
into the prompt on every run. There is nothing to insert yet.

## 4. Talk to it

Back on **Group chat**, the composer reads **Message the guild — type
@ to mention an agent**. A message with no tag wakes every agent in
the guild; `@researcher` wakes that agent alone. Post one:

```text
What is a guild, in one sentence?
```

A row appears: **researcher is responding…**. The first run of an
agent also creates its sandbox, so it starts slower than the runs
after. The reply arrives on the left with an **Inspect run** pill.

The guild now has one working agent. Everything the agent did to
answer is kept, which is the next step.

For a private conversation, open the agent and its **Chat** tab: a
new session, a composer, and a paperclip for images when the model
accepts them. The clock on the tab strip opens the session history.
It lists every run: direct, or woken by the chat or a routine.

## 5. Inspect the run

**Inspect run** on the reply opens the run that produced it. What
the model saw is what you see.

The transcript starts with:

- the tools the run was offered
- the composed system prompt (`<guidelines>`, `<task>`, `<state>`,
  `<memory>`), each a collapsible section. Your Task is there, as
  the model read it.

Every stretch of model steps that called tools renders as a run
flow:

- step and call counts
- model and tool time
- tokens and cost
- a row per step, titled with the first line the model wrote

Opening a call shows its arguments and result as a folding tree or
raw text, with its duration and the tool calls left.

An ended run offers **Resume**, which continues the same transcript.

When a reply is not what you wanted, this is the place to look
first: the prompt the model saw, then the calls it made.

## 6. Memory and notes

The agent's **State** tab holds what it keeps between runs.

- **Memory** lists every version of the agent's memory, newest
  first, with who wrote it. The agent writes it with `memory_write`
  while Memory is on. The live version is editable here. An archived
  one opens read-only as the change against the version before it.
- **Notes** lists the agent's, the guild's, and the organisation's
  notes side by side. A new note gets `.md` added and opens in a
  Markdown editor. A provenance strip under the header says who
  saved it last; **Open step** jumps to the run and tool call that
  wrote it. Agents read and write notes with their note tools. The
  guild's **State**, **Files** shows the shared ones.

When the agent wrote memory in its first run, that version is on
**Memory**. Post a second question in the group chat that refers to
the first: the new run's `<memory>` section carries what the agent
kept, and its reply can build on it.

## 7. Add a routine

A routine wakes the agent without anyone posting. The agent's
**Routine** tab, **New routine**, takes:

- **Timing** — **Cron**, a five-field expression in UTC such as
  `0 9 * * 1` (minute, hour, day, month, weekday; at least five
  minutes apart), or **Random window**, with **From** and **To**
  times, the **Most wake-ups a day**, and a **Timezone** pre-filled
  from your profile
- **Description** — a one-line label
- **Instruction** — what to do on this wake-up, sent to the agent as
  the wake-up message

The form previews the timing in words.

Each routine pauses and resumes on its own. The guild's **Routines**
tab lists them all, with one switch that holds every routine of the
guild. The guild header shows a **Routines off** chip while it is
off.

A woken run appears in the session history and says what woke it.

## 8. Give it a tool

An agent reaches the world through tools. **Tools** lives at three
levels: the agent, the guild, and **Settings**, **Tools** for the
whole organisation. A switch set at a wider level reaches the
narrower ones. Integrations come first on the page. Native tools
come after.

- An integration is a connector from the catalog. Its card shows its
  login, a switch for the server, and its tools. **Connect** collects
  a key in a dialog, or opens the provider's sign-in for an OAuth
  connector. A connector the server cannot sign in to is marked
  **Not set up**, with the fields a platform admin still enters under
  **Admin**, **Platform keys**; a platform admin sees a **Set up**
  link to them ([Configure](configure.md#platform-keys)).
- Native tools come in families: notes, tables, memory, scripts,
  routines, group chat, secrets, browser, coding, issues. Each is an
  on/off switch captioned with where its state comes from: set here,
  or inherited from the guild or the organisation. A tool that waits
  for a platform key has no switch and says it is offered once a
  platform admin sets up its integration.

**Secrets** gives agents environment variables, for a script or a
shell command that needs a key of its own. **Add secret** takes a
name, a value, a description, and who gets it: the organisation, a
guild, or an agent. Values never show again. The agent's sandbox has
the variable; its scripts and shell read it.

## 9. Save and apply a recipe

A recipe carries a guild's configuration as one file: its agents,
their Tasks, their routines, and the tools and logins they need.

**Save as recipe** in the guild's menu captures the guild you just
built and opens it as a draft. **Export** on a ready recipe downloads
it as a JSON file in the `guilds.recipe` format.

**Recipes** in the sidebar footer opens the library. **From a guild**
captures one there; **Import JSON** takes a recipe file and opens the
recipe's page:

- the plan of everything it creates and needs
- each role's Task
- **Approve and apply**

The apply preview shows the new guild's name, each agent's name, and,
for each connector, a login to reuse or one to connect afterwards.
**Connectors to set up** lists the connectors the recipe needs that a
platform admin has not set up on the box yet, GitHub included when
the recipe lists repositories, with a **Set up** link for a platform
admin.

The checklist that follows lists the logins, secret values,
repositories, and outside setup the team still needs. Each step is
verified, confirmed, or skipped. A connection step whose connector
is not set up says so and keeps Connect disabled until a platform
admin sets it up; it still closes once connected or skipped.

**Activate routines** unpauses the schedules the recipe brought.

An agent the recipe required a browser login for then shows a
**Browser login needed** strip with **Open Browser**, where you log
the agent in to its sites.

## From here

- **Builder** — describe the guild you want in a conversation and
  get a recipe drafted
  ([Guild builder](../concepts/guild-builder.md)).
- **Open in Studio** in a guild's menu — a coach that reads the guild
  as evidence and drafts better Tasks
  ([Prompt Studio](../concepts/prompt-studio.md)).
- **Tools** — native tools, token connectors, and the Gmail and
  GitHub apps
  ([Catalog](../tools-and-connectors/catalog.md)).
- **Inbox** — issues agents report and messages that tag you.
- **Databases** — the organisation's tables, their records, and who
  reaches them.
- [Configure](configure.md) when the box needs a platform key or an
  `.env` setting, [Remote access](remote-access.md) when someone else
  needs to reach it, [Operate](operate.md) for updates, backups, and
  logs.
