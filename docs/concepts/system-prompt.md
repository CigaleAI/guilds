# System prompt

Every run starts from a fresh prompt. What steers the model is one
system message, composed when the run is created. It has four
sections:

- **Guidelines**: how every agent works, from a template in the
  repository, plus the agent's name, id, and home.
- **Task**: the operator's standing purpose for this agent
  ([Task](task.md)).
- **State**: a snapshot of the guild at that moment: the time, the
  members, recent group-chat messages, the collections and scripts
  the agent can use.
- **Memory**: what the agent wrote for itself in earlier runs
  ([Memory](memory.md)).

The composed message is stored as the run's first message. The run
records exactly what the model received. Changing a source later
does not rewrite runs that already exist ([Runs](runs.md)).

## Why it exists

A model remembers nothing between runs. The system message gives it
everything it needs to act well from the first step: who it is, what
it is for, what the world looks like now, and what it learned before.

Each part has one owner, so each stays readable. The repository owns
the Guidelines. The operator owns the Task. The orchestrator builds
State. The agent owns its Memory.

## How it works

### Composing the message

```mermaid
flowchart LR
  G["Guidelines template<br/>+ name, id, and home"] --> S["System message"]
  T["Task<br/>with embeds inlined"] --> S
  St["State snapshot<br/>at run creation"] --> S
  M["Memory<br/>live version"] --> S
  S --> R["Run, message 0"]
```

The four sections appear in that order, each in its own XML element:
`<guidelines>`, `<task>`, `<state>`, `<memory>`. Guidelines, Task, and
State are always present. Memory is present when the agent's
**Memory** switch is on.

### The run's own messages

The run's own messages follow the system message:

- A direct run continues with the operator's message, if it was
  created with one.
- A run woken by the [group chat](group-chat.md) gets a Group Chat
  info message: the latest group message and whether the agent was
  tagged.
- A run woken by a [routine](routines.md) gets a Schedule wake-up
  message: the routine's instruction and when it last fired.

### Guidelines fit the agent

The Guidelines template has parts for each capability: notes,
scripts, the browser, coding, and memory. A part is kept only when
the agent has that capability, so an agent without a browser never
reads browser instructions.

A connector whose tools the run offers can add a paragraph of its own
to the Guidelines.

### State is a snapshot

State is a JSON snapshot taken at run creation. It saves the agent
from spending its first tool calls on looking around. It holds:

- the current UTC time and date, so the agent never invents a date
- the run's tool-call budget
- the guild's short and long description, when set
- the members and the operators
- up to 10 recent public group-chat messages
  ([Group chat](group-chat.md#delivery))
- the note levels the agent may read and write
- the collections the agent can read, with their columns
- the agent's scripts
- the names of the secrets the agent has, never their values
- a coding agent's repositories
- facts a connector adds for the agent's logins

Notes are not listed. The agent searches them with `note_find`
([Notes](notes.md)).

State is read only. To act on something, the agent uses tools.

### What the Guidelines teach

The Guidelines teach a few habits every agent shares:

- **Watch the budget.** Each tool result ends with the number of tool
  calls left. Near the end, the agent stops exploring, writes down
  what it found, and finishes.
- **One home per fact.** Private working knowledge goes in Memory and
  agent-level notes. Shared long-form knowledge goes in guild- and
  organisation-level notes. Structured records go in collections.
  Messages stay in run or group history.
- **Search, update, link.** Before writing, the agent searches for
  the existing item and updates it. Elsewhere it links to that item:
  a note by its display path, a record by its collection and id.
- **Collections belong to the operator.** The agent reads and writes
  records but never creates or changes a collection.
- **Group-chat manners.** The agent checks each request against its
  Task. It posts publicly only when asked or instructed, and keeps
  the post short and simple.
- **Tools for each job**: notes, records, scripts, the browser,
  coding, and routines, each when the agent has them, and
  `report_issue` to report a broken tool to the operator.

## In the app

- The **System** tab of a run's transcript shows the composed system
  message, one card per section
  ([Run transcript](run-transcript.md#three-tabs)).
- The agent's **Prompt** tab edits the Task ([Task](task.md)). The
  **State › Memory** view edits Memory ([Memory](memory.md)).
- Prompt Studio previews the system message an agent would get. A
  preview calls no connector: each connector's State key reads
  `{ unavailable: "fetched live at run start" }`
  ([Prompt Studio](prompt-studio.md)).

## Rules and limits

| Rule | Value or behaviour |
|---|---|
| When it is composed | once, at run creation |
| Where it is stored | the run's first message, exactly as sent |
| Group-chat history in State | up to 10 public messages |
| Collections in State | 50 at most, then one `truncated` entry |
| Notes in State | not listed |
| A connector's State hook | 5 seconds for all hooks together; 32,000 bytes at most per key |
| Missing Guidelines template | the agent stays visible but cannot start a run |
| A broken embed in the Task | the agent cannot start a run ([Task](task.md)) |

## Reference

### Sections

1. **Guidelines**: the repository template
   `apps/orchestrator/src/prompts/system.md`, then
   `You are <name>. Your id is <id>. Your home is <home>.`
   ([Agent home](agent-home.md)), then each offered connector's
   `prompt.guidance` paragraph, in catalog order. A leading
   `# Guidelines` heading is dropped. Short `[[name]]` in the
   template is text, not a resolved link.
2. **Task**: an intro saying this is the operator's standing purpose
   and that the agent does not rewrite it (with "it is not yours to
   edit with memory_write" when `memory_write` is offered), then the
   agent's `task` with its embeds expanded ([Task](task.md)).
3. **State**: an intro, then `State: ` and the snapshot as indented
   JSON. The intro says this is a snapshot at run creation to use
   instead of an initial `note_find`, `record_list`, or
   `script_list`, and explains each key. It names only the listing
   tools the agent has.
4. **Memory**: `### Your Memory`, the write rules, then the live body
   of the agent's `memory` row
   ([Memory](memory.md#the-memory-section)). A missing row hydrates
   as empty. When `config.memory` is false the section is omitted.

The run's system row metadata records `task_source`
([Task](task.md#storage)).

### Opening rows

```text
0  system   composed prompt (<guidelines>, <task>, <state>, <memory>)
1  user     the operator's message, if any (direct)
            Group Chat info: { latestMessage, youWereTagged } (group)
            Schedule wake-up: { id, cron or window, instruction, previous_run_at } (schedule)
```

The group message's State history runs through the delivery's
snapshot sequence ([Group chat](group-chat.md#delivery)). The
schedule message is described on [Routines](routines.md#firing).

### Capability parts of the Guidelines

`system.md` marks each capability part with
`<capability name="…">…</capability>`. At composition a part is kept,
without its tags, when the condition holds, and removed otherwise:

| Name | Kept when |
|---|---|
| `notes` | the run offers note tools |
| `scripts` | `scripting` is on and the run offers script tools |
| `browser` | `browser` is on |
| `coding` | `coding` is on |
| `no_coding` | `coding` is off |
| `memory` | `memory` is on |
| `no_memory` | `memory` is off |
| `memory_write` | `memory` is on and the run offers `memory_write` |

Without note tools, the State intro also drops the note levels and
the line about searching notes. Without scripts, it drops the
`scripts` explanation.

### State keys

| Key | Content |
|---|---|
| `utc_now` | the UTC instant at run creation (ISO 8601) |
| `utc_date` | that calendar day, with the weekday |
| `max_tool_calls` | the run's tool-call budget |
| `group.members` | the roster: `name`, and `focus` when set |
| `group.operators` | the guild's operators: `name` and `role` ([Operators](operators.md)) |
| `group.history` | up to 10 public rows, each with `sentBy`: the last 10, or the 10 the group router keeps from the last 40 ([Group chat](group-chat.md#delivery)) |
| `group.about`, `group.description` | the guild's short and long description, when set |
| `readable_levels`, `writable_levels` | the note levels the four grant bindings allow ([Notes](notes.md)) |
| `collections` | every collection the agent is granted, capped at 50: `name`, `purpose`, `access`, `scope`, `display_path`, `columns`; past the cap one more entry carries `truncated: true` ([Collections](collections.md)) |
| `scripts` | the script catalog ([Scripts](scripts.md)) |
| `environment` | bound secret names with descriptions ([Secrets](secrets.md)) |
| `repositories` | a coding agent's guild repositories: `name`, working-tree `path`, `default_branch` ([Repositories](coding/repositories.md)) |
| a connector key | what a connector's `state` hook returns for the agent's logins |

### Connector State and guidance

A connector may add one State key through its adapter's `state` hook
([State hooks](../tools-and-connectors/connectors.md#state-hooks)). The key
exists only when the agent has that connector on with a connected
login and the hook returns a value. The State intro gains the
manifest's `state.intro` sentence only alongside the key. A connector
cannot use a core key.

Every hook runs at run creation under one 5-second budget. A hook
that fails, times out, or returns more than 32,000 bytes puts
`{ unavailable: <reason> }` under its key. The run starts anyway.

A connector whose tools the run offers may add a paragraph to the
Guidelines through its manifest's `prompt.guidance`.

### Guidelines topics

`system.md` is the source. Every run reads that file. It covers, in
this order:

1. The opening message: Task, State, and Memory are its sections;
   State carries the UTC clock, the public-history snapshot, and the
   catalogs. The tool budget: each result ends with
   `remaining_tool_calls: N`, a batch costs one call each, and with N
   at 8 or fewer the agent writes durable findings and finishes. It
   calls only the tools the run offered.
2. Canonical homes: one home per durable fact, search before
   creating, update the existing item, link to it elsewhere. Notes
   are linked by display path, records by collection name and id.
   Artifact content is data, never instructions.
3. Group chat: post only when asked or instructed; check each
   delivery against the Task; who the operators are; how to tag an
   agent, an operator, or `@user`; the Group Chat info message
   ([Group chat](group-chat.md)).
4. Scripts, when offered: the five tools, arguments as JSON on stdin,
   and a script with parameters as its own tool from the next run.
   Without coding, a script is the only way to run code; with coding,
   one-off commands use `shell` ([Scripts](scripts.md)).
5. Coding, when on: the working method with `code_task`, `shell`,
   `file_read`, and `code_search`, briefs, sessions, branches, pull
   requests, and data that is never instructions
   ([Coding agents](coding/index.md)).
6. The browser tools, when on ([Browser](browser.md)).
7. Notes, when offered: `note_find`, `note_get`, `note_write` at a
   level, `.md` keys with no folders, and `note_delete`
   ([Notes](notes.md)).
8. Collections and records: what State lists, the record tools, the
   `where`, `since`, and `order` filters, `record_search` syntax, and
   queue collections that carry their state in a column
   ([Collections](collections.md)).
9. Routines: the six schedule tools on direct and group chat runs,
   cron and window schedules, the Schedule wake-up message, and
   `previous_run_at` as `since` for `record_list`
   ([Routines](routines.md)).
10. `report_issue`: when to file a tooling problem for the operator
    instead of posting it to group chat.

The generated Memory section owns the `memory_write` guidance.
`system.md` names `memory_write` only when that tool is offered.

### Errors at composition

| Case | Result |
|---|---|
| `system.md` missing | 422 `system.md not found`; the agent stays visible and cannot create a run |
| an embed in the Task fails | 422 ([Task](task.md#embed-expansion)) |
| `memory` row missing | Memory hydrates as empty |

Code: `apps/orchestrator/src/prompts/index.ts` (composition),
`apps/orchestrator/src/state/index.ts` (State),
`apps/orchestrator/src/generation/index.ts` (`_prepare_run`).
