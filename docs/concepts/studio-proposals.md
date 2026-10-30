# Studio proposals

A proposal is a change the [Prompt Studio](prompt-studio.md) coach
asks the operator to make to a live guild, outside a Task. The coach
can propose a change to an agent's [Memory](memory.md), a
[note](notes.md), the guild's short description and description, a
[collection](collections.md), a [routine](routines.md), or what one
agent is offered ([access](access.md)). It can also ask for read
access to one login. Task changes are drafts: the operator publishes
them from the agent's **Draft** tab, and a turn waits on them like on
a proposal.

Each proposal shows in the coach chat as a card, and wherever the
change lands in the workspace. The coach writes nothing. The operator
applies or declines each one, and Studio then writes as the operator.

## Why it exists

The coach diagnoses from evidence, but the operator owns the guild. A
proposal lets the coach name the exact change, with its effect, while
every write stays an operator decision. A proposal also refuses to
apply over a change someone made after the coach read the target, so
nothing is overwritten by accident.

## How it works

```mermaid
flowchart LR
  C[Coach reads the target] --> P[Proposal card, turn pauses]
  P -->|Apply| W[Studio writes as the operator, if the target is unchanged]
  P -->|Decline| N[Nothing changes]
  W --> R[Coach continues with one reply]
  N --> R
```

1. The coach reads the live target and proposes the complete new
   content, with a reason. It issues a turn's drafts and proposals in
   one step.
2. The turn pauses at the end of that step. The card shows the live
   text beside the proposal.
3. The operator applies or declines. Apply refuses when the target
   changed since the coach read it; the card then shows as stale. A
   draft is published, edited and published, or discarded.
4. The coach waits until every request of the turn is decided, wherever
   it was decided. Then it continues with one reply that lists each
   decision.

### Login requests

A session starts with no access to outside data. The coach may ask for
read access to one login (a connection to an external service). The
operator grants or declines it from a card, or from **Logins** in the
workspace header. The answer is kept on the request. With a grant, the
coach may call only that login's read-only tools, and the grant ends
with the session. A login card counts toward the turn's answers like
any other card.

## In the app

### Where a request shows

Every request of the coach's latest turn is one pending item. It shows
in five places, and deciding it in any of them clears it from all:

| Place | What it shows |
|---|---|
| Header | **N to approve** opens a tray grouped by section. Each item has **Show**, its apply button (**Publish** for a draft, **Grant** for a login), and **Decline** (**Discard** for a draft), with **Apply all** and **Decline all** under them |
| Section bar and agent tabs | A count on each section and each agent; a dot on the agent tab that holds the item |
| The item | Its card above the view it changes: an agent's **Memory** or **Routines** tab, the guild's overview, **State**, or **Tools** |
| Coach chat | The cards of the turn, each with **Show**; the chat's header reads **Waiting on N decisions** |

| Request | Section | Lands on |
|---|---|---|
| Task draft | Agents | The agent's **Draft** tab |
| Memory edit | Agents | The agent's **Memory** tab |
| Routine create, edit, delete | Agents | The agent's **Routines** tab, at the routine |
| Note or table create, edit, delete | State | The item in the list |
| Access change | Tools | **Tools** |
| Guild text | Guild | The overview |
| Login request | Logins | The **Logins** popover |

**Apply all** never grants a login and never applies an access change
that widens what an agent can do: each of those needs its own apply,
and **Apply all** says how many it left. **Decline all** declines
every open request. When the last request is decided in the open
page, the coach's reply goes out by itself. If it fails to send, or
the turn was settled before the page opened, **Continue** sends it.

### Cards

A card shows the target, its added and removed line counts, and the
base version. While it is pending, it shows the live text beside the
proposal as a diff (one per changed field for the guild's short
description and description). Its apply button and **Decline** each
resolve that one request. A card whose target changed since shows as
stale.

While more than one card of a turn is open, a line under the cards
counts what is left, with **Apply all** and **Decline all**. They
resolve the open requests in turn; a refused apply, such as a stale
one, stops the rest. A draft card shows the draft's number, base
version, and outcome; its diff and **Publish**, **Edit**, and
**Discard** are in the agent's **Draft** tab.

| Proposal | What the card shows | Apply button |
|---|---|---|
| Memory, note edit, guild text | A diff of the live text and the proposal | **Apply edit** |
| New note | Its full text as added lines, and who reads it: the one agent, the guild's agents, or the organisation's | **Create note** |
| Deleted note | Its text as removed lines, and the agents whose Task embeds it (applying fails until none does) | **Delete note** |
| Collection | The collection before and after as text: a header with the owner, the purpose, one line per column, then its access: the organisation's row when it has one, the source guild's row, one line per member row, and the rows outside the guild | **Create table**, **Delete table**, or **Apply edit** |
| Routine | The routine before and after as text: the agent, the description, the timing in words, whether it is paused, and the instruction | **Create routine**, **Delete routine**, or **Apply edit** |
| Access | The agent's access before and after as text: one line per native tool, and one per connection with a line per connection tool. A change that widens access says it is decided on its own | **Apply edit** |
| Login | The server and its account | **Grant read access** |

Collection, routine, and access cards also list what applying does:

- **Collection**: which columns leave or move, in how many records;
  which stored values stay as they are after a retype; a column that
  becomes required or unique; a renamed collection whose old name
  Tasks still carry; who outside the guild reaches it.
- **Routine**: when the agent wakes; a new instruction reaching later
  wake-ups only; a pause or resume; the next wake-up planned again
  from the apply; the guild's routines being off.
- **Access**: each line says on or off, whether the agent sets it
  itself, and whether a connection tool changes data. The card says
  from which run the change takes effect, and names each connection
  tool it gives back that can change data.

### Logins popover

**Logins** in the workspace header lists every login reachable from
the guild (platform, organisation, guild, and agent logins) and grants
or revokes each one for the session.

## Rules and limits

| Rule | Behaviour |
|---|---|
| Writes by the coach | None; the operator applies each proposal |
| Targets | Memory, notes (create, change, delete), the guild's short description and description, collections (create, change, delete), routines (create, change, delete), one agent's access |
| Never a proposal | Tasks (those are drafts), scripts, records, agent configuration |
| A changed target | Apply is refused (409); the card shows as stale |
| A request | Resolves once, and records who resolved it |
| A turn | Pauses at the end of the step that made a request; continues once every request of the turn is decided |
| **Apply all** | Skips login grants and access changes that widen |
| Access | Agent-level only; the guild's and the organisation's settings stay as they are |
| Collections | The source guild's own: create, change, delete. The organisation's: add columns and change the rows of the source guild and its live members. Another guild's own: out of reach |
| Outside data | Only through a login granted to the session, only its read-only tools; a result is capped at 64 KiB |

## Reference

### Edit requests

`studio_edit_memory(agent_id, content, base_version, reason)`,
`studio_edit_note(action: "edit", display_path, content, base_version,
reason)`, and `studio_edit_guild(about?, description?, reason)` each
take the complete replacement text.

The handler checks reach, the byte cap (and the guild field length
limits), and that `base_version` matches the live version. It writes
nothing. Its result is a `studio_edit_request` widget with
`await_operator`, the target, base and proposed hashes, and line
counts. The proposed text stays in the tool call arguments. The card
reads the live text and the proposal through `GET …/edits/:seq`.

`studio_edit_note` takes notes only. Memory has its own tool.
Tasks, scripts, objects, and records are refused.

Apply re-reads the live content and refuses with 409 when its hash no
longer matches the base. Otherwise it writes as the operator under the
session lock:

- Memory and notes go through `writeMemory` / `writeNoteAt` with the
  expected version, so they produce a memory revision and a
  `file_changes` row that carries the edit tool's call id and name.
- The guild goes through `updateGuild` and refreshes the session's
  `source_guild_snapshot`, so the next turn's system message holds the
  new text. Guild text keeps no content history; its change log
  records who changed which field.

Every change an apply writes, to a file, a table, a routine, access,
or the guild's text, records the session and the sequence of the coach
message that proposed it (`studio_session_id`, `studio_seq`), so its
history links back to the card
([Artifacts](artifacts.md#configuration-change-log)).

The resolution is stored on the tool message as `metadata.edit_status`
(`applied` | `declined`), `edit_resolved_at`, `resolved_by_user_id`,
and `edit_version`. A request resolves only once.

### Note requests

`studio_edit_note(action: "create", level, agent_id?, key, title?,
content, reason)` and `studio_edit_note(action: "delete", display_path,
base_version, reason)` return the same widget with `kind: "note"` and
`action` (`create` or `delete`).

- `level` is `agent` (with `agent_id`, a live member), `guild` (the
  source guild), or `org`. `key` is a `.md` file name with no folders;
  an agent note cannot take `task.md` or `memory.md`.
- A create targets the display path the note will have and binds the
  fact that no note is live there. A note already there is refused with
  a pointer to the `edit` action. Apply writes it as the operator
  through `writeNote`, with an expected version no live note has, so a
  note written meanwhile is a 409 rather than overwritten.
- A delete takes notes of the source guild, its live members, and the
  organisation, and binds the note's content hash. Apply deletes
  through `deleteByDisplayPath`, which refuses with 409 while any Task
  in the organisation embeds the note.

Publishing a Task draft that embeds a note not yet created is refused,
so a note proposed in the same turn is applied first.

### Access requests

`studio_edit_access(agent_id, native_tools?, connections?,
connection_tools?, reason)` returns the same widget with
`kind: "access"`. Each map sets one entry to `on`, `off`, or `inherit`:

- `native_tools`: a native tool name. `report_issue` and the browser
  tools are not bindings.
- `connections`: a connection id the agent resolves; the setting
  applies to that connection's server.
- `connection_tools`: a tool listed on one of the agent's connections.

`on` and `off` write the agent-level binding, keeping the connection a
server binding already names; `inherit` deletes it. A setting the agent
already holds is not a change, and a request that changes nothing is
refused. The widget carries `edit.changes`, one `{ kind, id, label,
setting }` per binding it writes, and `edit.widens`, true when the
access after the change turns on a native tool, connection, or
connection tool the agent cannot use today. The widget
binds a hash of the agent's resolved access
rendered as text, so a binding moved at any scope since makes the
request stale and apply a 409 (`apps/orchestrator/src/studio/access.ts`).
The browser, coding, scripting, and memory switches are agent
configuration, outside these requests. Access to notes and
collections is set on each item's access list, outside these
requests too; a collection request changes the rows of the source
guild and its members ([Collection requests](#collection-requests)).

### Collection requests

`studio_edit_collection` takes an `action` and returns the same widget
with `kind: "collection"` and that `action`:

- `create(name, purpose, columns, scope?, access?, reason)`
- `edit(collection, base_updated_at, name?, purpose?, columns?,
  access?, reason)`
- `delete(collection, reason)`, for one of the source guild's own
  collections


- `scope` is `guild` (the default: the source guild owns the
  collection and starts at `write`) or `org` (the organisation starts
  at `read`).
- `columns` follows the column dialect of
  [Collections](collections.md). On an edit it is the complete list. A
  renamed column carries `rename_from`.
- `access` changes only the rows it names on the collection's access
  list: `guild`, the source guild's row (`read`, `write`, or `none`,
  which removes the row), and `agents` (`{ agent_id, mode }` with
  `read`, `write`, `none`, or `inherit`, which removes the agent's own
  row). Those subjects are the source guild and its live members. The
  organisation's row and the rows of other guilds and their agents
  are shown and never changed.
- `scope` and `access` are read before anything else the request
  names is checked.
- An edit must carry the `updated_at` the coach read and change
  something. A name already taken is refused.
- On an organisation collection, an edit keeps the name, the purpose,
  and every current column unchanged and in its order; it may add
  columns and change `access`. Anything else, and a delete, is refused
  with 422.
- A collection of another guild is out of Studio's reach: naming one is
  refused with 422 as an unknown table.

The widget targets the collection by id (null until a create is
applied) and binds a hash of its name, purpose, scope, columns, and
source-guild access. Apply re-reads the collection by id and refuses
with 409 when the hash no longer matches. Then it writes as the
operator through the artifact store: create, update, or delete the
collection, then each access row it changes, each logged against the
collection ([Access](access.md#access-lists)).

### Routine requests

`studio_edit_routine` takes an `action` and returns the same widget
with `kind: "routine"` and that `action`:

- `create(agent_id, cron? | window?, description, instruction,
  paused?, reason)`
- `edit(schedule_id, cron? | window?, description?, instruction?,
  paused?, reason)`
- `delete(schedule_id, reason)`


- `agent_id` names a live member of the source guild. `schedule_id`
  names a routine of one, from `studio_list_routines`.
- `cron` and `window` follow the timing rules of
  [Routines](routines.md); a request passes at most one. A create
  needs one, and an edit that passes one replaces the timing.
- A field an edit leaves out keeps its live value. An edit that
  changes nothing is refused.
- A create with `paused: true` starts paused.

The widget targets the routine by `schedule_id` (null until a create
is applied) and binds a hash of its agent, timing, description,
instruction, and pause. A fire moves the planned wake-up, not that
hash. Apply reviews the routine again and refuses with 409 when the
hash no longer matches. Then it writes as the operator through the
schedule service: create, `Schedules.update`, or delete
(`apps/orchestrator/src/studio/routines.ts`). The apply publishes
`agent.routines.changed` on the guild's stream.

### Connection grants

The coach asks with
`studio_request_connection_access(connection_id, reason)`. The tool
result is a `studio_connection_access` widget with `await_operator`,
so the generation pauses. `POST …/logins/:seq` answers it: a grant adds
the login to the session, and either answer is stored on the tool
message as `metadata.access_status` (`granted` | `declined`),
`access_resolved_at`, and `resolved_by_user_id`. A login granted from
the **Logins** popover also counts as granted. The answer goes into
the turn's one continuation message.

### Draft requests

`studio_create_task_draft` returns a `studio_task_draft` widget with
`await_operator`, the agent (`id`, `name`), the `draft_id`, and the
`rationale`, beside the draft itself. The operator's edits to the
draft keep its `created_message_seq`, so the request follows the
newest version. A draft the coach replaces in the same turn needs no
answer. Discarding stores `discarded_by_user_id`; publishing stores
`published_by_user_id` ([Prompt Studio](prompt-studio.md)).

`studio_call_connection_tool(connection_id, tool, arguments)` proxies
one call through the orchestrator's MCP pool on a granted, connected
login. The tool must be listed on that connection and pass
`isReadOnlyRemote` (`apps/orchestrator/src/connectors/servers.ts`):

- default-off tools are refused
- a tool the connector's manifest lists is readable unless it is
  `mutating`
- a listed tool marked `readOnlyHint` is readable on a verified
  connector; on any other the hint does not count
- any other tool is classified by the verbs in its name

The result is redacted against that connection's stored credentials,
capped at 64 KiB, and wrapped as untrusted evidence.

Grants live on `studio_sessions.granted_connection_ids` and end with
the session.

### HTTP

```text
GET    /api/studio/sessions/:id/edits/:seq
POST   /api/studio/sessions/:id/edits/:seq          { decision: "apply" | "decline" }
POST   /api/studio/sessions/:id/logins/:seq         { decision: "grant" | "decline" }
GET    /api/studio/sessions/:id/connections
PUT    /api/studio/sessions/:id/connections/:connection_id   { granted: true | false }
```

- `GET …/edits/:seq` returns the live text and the proposal of the
  request at that message.
- `POST …/edits/:seq` resolves it. Another `decision` is 422; a stale
  target is 409.
- `POST …/logins/:seq` answers the login request at that message and
  returns the session. Another `decision` is 422; a message that is
  not a login request is 404; an answered request is 409.
- `GET …/connections` lists every login reachable from the source
  guild: platform, organisation, guild, and live-member scope.
- `PUT …/connections/:connection_id` grants or revokes one: `granted`
  is a boolean, and left out grants. The connection must be reachable
  from the source guild and `connected`.
- A body that is not a JSON object, or a field of another type, is 422
  naming the field, before the request's user is identified.

### Storage

An edit or login request is a `studio_messages` tool row whose
resolution is in its metadata.

### Code paths

| Path | What it holds |
|---|---|
| `apps/orchestrator/src/studio/edits.ts` | Memory, note body, and guild requests, and reading and applying every edit request |
| `apps/orchestrator/src/studio/edit-request.ts` | The request an edit tool returns instead of writing: its reason, content limit, line counts, and widget |
| `apps/orchestrator/src/studio/note-edits.ts` | Note requests: the note a body edit replaces, and notes created or deleted |
| `apps/orchestrator/src/studio/access.ts` | Access requests |
| `apps/orchestrator/src/studio/tables.ts` | Collection requests read from the coach's arguments, their review and its wording, and collection evidence |
| `apps/orchestrator/src/artifacts/guild-tables.ts` | `planGuildTableChange`: the rules a collection request follows and what it writes; `guildTableEditEffects`: what a collection edit does to its records and readers |
| `apps/orchestrator/src/artifacts/access-lists.ts` | `planGuildAccess`: the access rows a collection request changes |
| `apps/orchestrator/src/studio/routines.ts` | Routine requests |
| `apps/orchestrator/src/studio/connections.ts` | Connection grants and the read-only proxy |
| `apps/orchestrator/src/connectors/servers.ts` | `isReadOnlyRemote` |
| `apps/web/src/features/studio/pendingModel.ts` | The turn's requests: where each lands and what was answered |
| `apps/web/src/features/studio/approvals.ts` | Deciding requests from anywhere and the reply that continues the coach |
| `apps/web/src/features/studio/ProposalCards.tsx`, `ApprovalTray.tsx`, `chatModel.ts` | The cards and the header tray |
