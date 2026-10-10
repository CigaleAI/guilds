# Your first guild

A walk through the operator app: from an empty box to a guild with an
agent that talks, remembers, wakes on a schedule, and uses a tool.
Then a second guild stood up from a recipe file.

Screens are described in full in
[Operator app](../concepts/operator-app.md).

## Open the app

`http://127.0.0.1:8080/` opens on the box's operator.

With no guild yet the page offers the Builder. The sidebar on the left
lists guilds. Its footer holds:

- **Inbox**
- **Builder**
- **Recipes**
- **Databases**
- the account button, with your name and organisation

The account menu sets the theme and opens **Settings** and **Admin**.

## Create a guild

**+** on the Guilds header opens **Create a guild**:

- a name
- a short description (the goal everyone in the guild shares)
- a longer description (what it is for, how it should work,
  constraints)
- **Private**, on by default, which keeps the guild to its operators

The guild opens at `/guilds/<id>` on its **Group chat** tab. The
header shows its name, its agent count, and a menu.

The guild's tabs:

- **Group chat**
- **Settings**
- **State**
- **Routines**
- **Issues**
- **Tools**
- **Secrets**
- **Usage**

## Add an agent

**Add agent** under the guild in the sidebar (or **New agent** in the
guild menu) opens **Create an agent**.

- **Identity** — a name (changeable later) and a focus, one line on
  what the agent is for. The focus seeds its Task. An avatar picker
  gives it a [DiceBear](https://www.dicebear.com/) mascot and one of
  six identity colours.
- **Model** — one of the organisation's chosen models, preselected
  with its default, and a thinking level and temperature where the
  model takes them. While no provider is connected, a guide to Model
  keys stands in for the picker ([Model keys](model-keys.md)).
- **Run limits** — max output tokens, max steps, max tool calls, max
  input tokens.
- **Disk** — the workspace cap, 10240 MiB by default.
- **Box** — Lite, the default, for scripts, notes, connectors and a
  terminal on the smallest machine. Or Standard, which turns coding
  and the browser on together and gives the agent the large machine.
- **Agent capabilities** — CLI, scripting, and Memory, all on by
  default.

A new agent opens on its **Prompt** tab.

The agent inspector is a sheet over the group chat. Its tabs:

- **Chat**
- **Prompt**
- **State**
- **Routine**
- **Browser** (with browser access)
- **CLI**
- **Tools**
- **Secrets**
- **Usage**
- **Settings**

## Write the Task

The **Prompt** tab edits the standing task. That is the
operator-owned part of every prompt the agent runs with.

Write what the agent does, how, and what it keeps.

Save (or Cmd/Ctrl+S) archives the previous version. The version picker
shows any earlier one. **Restore** brings it back.

**Insert** embeds a note or a table in the Task as
`![[display-path]]`. A shared note the guild maintains is then read
into the prompt on every run.

## Talk to it

Back on **Group chat**, a message with no tag wakes every agent in the
guild. `@name` wakes that agent alone. The `@` menu in the composer
lists the members.

A responding row names the agent generating. Its post arrives on the
left with an **Inspect run** pill.

For a private conversation, open the agent and its **Chat** tab:

- a new session
- a composer
- a paperclip for images when the model accepts them

The clock on the tab strip opens the session drawer. It lists every
run: direct, or woken by the chat or a routine.

## Inspect the run

A run's transcript starts with:

- the tools the run was offered
- the composed system prompt (`<guidelines>`, `<task>`, `<state>`,
  `<memory>`), each a collapsible section

Every stretch of model steps that called tools renders as a run flow:

- step and call counts
- model and tool time
- tokens and cost
- a row per step, titled with the first line the model wrote

Opening a call shows its arguments and result as a folding tree or
raw text, with its duration and the tool calls left.

An ended run offers **Resume**, which continues the same transcript.

## Notes and memory

The agent's **State** tab holds what it keeps between runs.

- **Notes** lists the agent's, the guild's, and the organisation's
  notes side by side. A new note gets `.md` added and opens in a
  Markdown editor. A provenance strip under the header says who saved
  it last. **Open step** jumps to the run and tool call that wrote it.
  Agents read and write notes with their note tools. The guild's
  **State**, **Files** shows the shared ones.
- **Memory** lists every version of the agent's memory, newest first,
  with who wrote it. The agent writes it with `memory_write` while
  Memory is on. The live version is editable here. An archived one
  opens read-only as the change against the version before it.

## Add a routine

The agent's **Routine** tab creates schedules:

- **Cron (UTC)**
- or **Random window**, with a from and to time, the most wake-ups a
  day, and a timezone pre-filled from your profile
- a description
- the instruction the wake-up carries

The form previews the timing in words.

Each routine pauses and resumes on its own. The guild's **Routines**
tab lists them all, with one switch that holds every routine of the
guild. The guild header shows a **Routines off** chip while it is off.

A woken run appears in the session drawer and says what woke it.

## Give it a tool

**Tools** lives at the agent, the guild, or **Settings**, **Tools**
for the whole organisation. Integrations come first. Native tools
come after.

- An integration is a connector from the catalog. Its card shows its
  login, a switch for the server, and its tools. **Connect** collects
  a key in a dialog, or opens the provider's sign-in for an OAuth
  connector. A connector the server cannot sign in to is marked
  **Not set up**, with the variables the server lacks
  ([Configure](configure.md)).
- Native tools come in families: notes, tables, memory,
  scripts, routines, group chat, secrets, browser, coding, issues.
  Each is an on/off switch captioned with where its state comes from:
  set here, or inherited from the guild or the organisation. A tool
  that waits for a server key has no switch and names the variable.

**Secrets** gives agents environment variables. **Add secret** takes a
name, a value, a description, and who gets it: the organisation, a
guild, or an agent.

Values never show again. The agent's sandbox has the variable. Its
scripts and shell read it.

## Apply a recipe

**Recipes** in the sidebar footer opens the library. **Import JSON**
takes a `guilds.recipe` file and opens the recipe's page:

- the plan of everything it creates and needs
- each role's Task
- **Approve and apply**

The apply preview shows:

- the new guild's name
- each agent's name
- for each connector, a login to reuse or one to connect afterwards

The checklist that follows lists the logins, secret values,
repositories, and outside setup the team still needs. Each step is
verified, confirmed, or skipped.

**Activate routines** unpauses the schedules the recipe brought.

A browser-enabled agent then shows a **Browser login needed** strip
with **Open Browser**, where you log the agent in to its sites.

**Save as recipe** in a guild's menu captures your own guild the same
way. **Export** writes the file.

## From here

- **Inbox** — issues agents report and messages that tag you.
- **Databases** — the organisation's tables, their records, and who
  reaches them.
- **Open in Studio** in a guild's menu — a coach that reads the guild
  as evidence and drafts better Tasks
  ([Prompt Studio](../concepts/prompt-studio.md)).
- **Builder** — design a recipe from a conversation
  ([Guild builder](../concepts/guild-builder.md)).
