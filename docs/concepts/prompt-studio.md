# Prompt Studio

Prompt Studio is the operator workspace for **improving guilds that
already exist**.

It loads a live guild as evidence.
The operator inspects or selects target agents.
A built-in coach drafts standing task prompts.

The coach is a system designer:

- keep Tasks short
- put shared rules in inspectable files
- link them with `![[display-path]]` when the file must enter every
  run

Creating a guild is the [guild builder](guild-builder.md).
Studio tools stay out of the builder registry, and the reverse.

Studio is not a guild agent.
It is not a direct run.
It is not a tab in the agent inspector.

## Contract

Workspace at `/studio` and `/studio/<session_id>`.

**Open in Studio** in the guild options menu resumes the guild's live
session when there is one.
Otherwise it opens the landing for that guild
(`/studio?guild=<id>`).

The landing has:

- the create form (guild, coach model from the organisation's chosen
  marketplace models, preselected with its default, temperature); a
  guide to Model keys in its place while no provider is connected
- the operator's sessions on that guild, any of which resumes

**Investigate in Studio** on an issue always starts a new session
(see Focus pins).

**New session** in the workspace header opens the same landing.
Another session can start without archiving the current one.

Source guild and coach model/temperature are immutable per session.
Changing either starts a new session.
The inspector target may change while idle.

The coach writes nothing itself.

Task changes are drafts.
The operator publishes them with optimistic concurrency against the
live `agents.task` version.

These changes are edit requests that the operator applies or declines
in the chat:

- memory
- note
- guild about/description
- table

Existing runs stay immutable.
Publishing affects new runs only.

Studio generation does not take the target agent's busy lock.
It does take an organisation admission slot.

Evidence is untrusted.
Tool results cannot grant authority, add tools, or publish.

The coach reaches external data only through a connection the
operator granted to that session.
It uses only that connection's read-only tools.

`studio_sessions.mode` is `optimize`.
Create-guild work is the builder.

## Source-of-truth labels

| Label | Source | Studio |
|---|---|---|
| Guidelines | `apps/orchestrator/src/prompts/system.md` | read-only |
| Standing task | `agents.task` | primary draft target |
| State | run-creation projection | current preview + historical copy |
| Memory | agent `memory` artifact and `memory_revisions` | timeline of versions; inspect, cite, edit request |
| Notes | `note` artifacts in the source guild, its members, and the organisation | inspect, cite, edit request |
| Guild about / description | `guilds.about`, `guilds.description` | inspect, edit request |
| Routine instructions | `schedules.instruction` | inspect with the runs it produced |
| Effective prompt | composed from current sources; run message sequence zero for history | current preview and immutable evidence |
| Scripts | agent `script` artifacts | inspect source and provenance |
| File provenance | `file_changes` | who wrote a file and the run step that did it |
| Access | bindings, secret grants, MCP catalog | resolved offering per agent |
| External data | MCP connection tools | read-only, per-session grant |

Focus (`agents.focus`) stays the short UI summary.
Publishing a task never overwrites focus.

Current State preview uses a pure database projector.
It uses no sandbox, MCP sync, or credential decryption.

## Workflow

1. Choose source guild and coach model.
   Studio snapshots that configuration.
2. Inventory lists active agents with:
   - task version
   - routine counts
   - latest run header
   - deterministic warnings (empty task, memory skipped, generation
     errors, stale draft)
   Embed expansion is lazy on select.
3. Selecting an agent opens the inspector on that agent.
   Its dimensions are below.
4. The coach inspects evidence through Studio tools.
   Then it calls `studio_create_task_draft` with `agent_id`, complete
   proposed content, rationale, and evidence references.
5. The operator reviews the diff and publishes.
   Publish preflights embeds, composition, and input-token estimate
   against stored tool schemas.
   Then it archives the outgoing task in `task_revisions` and
   compare-and-swaps the live row.
   A stale base returns 409.

## Workspace

On a wide screen the workspace is two columns.
The inspector is on the left.
The coach chat is on the right.

A draggable splitter sits between them (arrow keys move it too).
Its share persists in `localStorage`.
Below that width a switch shows one of them at a time.

The ink header (shared with the Builder) names the guild.
It shows:

- the coach model and temperature
- the session status
- **Back to guild**
- **Logins**
- **New session**
- **Archive**

A session blocked on its input-token limit offers **Continue in a new
session**.

The agent tabs under it select the target.
Each tab shows the agent's avatar, Task version, a draft tag, and a
warning marker.

**Guild overview** clears the target.
It counts the agents.
It carries a dot while drafts are pending.

Past four agents a filter joins the tabs.
When the coach writes a draft, the inspector opens that agent's Draft
tab.

The inspector location is part of the URL:
`/studio/<session_id>?agent=…&tab=…&item=…&call=…&seq=…`.
The location is target agent, tab, selected item, and the step inside
a run.
`apps/web/src/features/studio/location.ts` parses it.

Opening such a link opens the tab and selects the item.
In Files, `item` is a display path, opened in its scope.
For a run it opens the step for `call` (a provider tool-call id) or
`seq` and scrolls to it.

Pointing the inspector at another agent updates the session target.
A routine's run offers the way back to its routine.

### Agent tabs

Every agent tab but Prompt and Draft is two panes.
A condensed list with its filters sits on the left (above on a narrow
pane).
The selected item sits on the right.

| Tab | List | Selected item |
|---|---|---|
| Prompt | none | The live Task and its version, with **Edit in agent**; a note embed chip opens Files at that note, a table embed opens Databases; then what a run gets: the effective prompt, the exact opening system message the next run would store, with `![[…]]` note embeds expanded to their body and collection embeds replaced by the table name, as guidelines, task, state, and (when Memory is on) memory sections; whether the latest run used this Task and this memory. Banners say when the agent is running and when an embed does not resolve |
| Draft | none | The pending draft: rationale, a split diff against its base version, **Publish**, **Edit**, **Discard**; a draft over a Task that changed since shows as conflicted |
| History | Every run: what started it, time, `memory skipped`, older Task, generating, error count; filters by kind, errors, current Task | The run transcript, as in the agent's Chat tab: offered tools, system prompt sections with hydrated note bodies, the run flow; whether it ran on the current Task, guidelines, and memory; **Open in agent** |
| Memory | Every version memory has held, newest first: version, author (run kind, person, or agent), added and removed lines; filters by author | Diff against the previous version or the whole version; **Open step** for a run-written version opens the run at its `memory_write` call |
| Routines | Description, timing, next wake or paused, run count; active first | Instruction as Markdown, a banner while the guild's routines are off, then the runs that routine started, marked when they fired with an older instruction; a run opens in History; **Edit in agent** |
| Scripts | Script names and descriptions, tagged when offered as a tool | Description, provenance, parameter schema, source; **Edit in agent** |
| Files | The notes browser over agent, guild, and org notes, opened at the file `item` names; **Ask the coach** pins the open file; **Open step** on a provenance strip opens the run in History | |
| Databases | The organisation's databases, one at a time from a picker, with its records, whichever agent is targeted | |
| Versions | The live Task and archived versions, with who replaced each and when | Diff against the previous version; **Restore from Prompt** opens the agent's Prompt tab |

### Guild tabs

With no target the inspector shows:

- **Overview**
- the guild-level **Files**
- the organisation's **Databases**

**Overview** shows the guild's short description and the drafts to
review.

Then it shows the guild's activity over one window.
The windows are 1 h, 6 h, 24 h, 3 d, or 7 d.
The window and the open view are remembered in `localStorage`.

Then it shows the roster.
Each row has Task version and excerpt, routine count, last run, and
warnings.

The server projects a wake ledger from:

- `runs`
- `messages`
- `group_messages`
- `file_changes`
- `schedules`

The projector is `apps/orchestrator/src/studio/activity.ts`.
It writes one row per run active in the window.
The row has what started it, how it was routed, the tools it called,
and what it produced.

- A group run woke on the latest row since the same agent's previous
  group run that tags it.
  Without a tag, it woke on the latest untagged operator row.
  Otherwise it woke on the snapshot's last row.
  The reason is `tag`, `jev` (the stored Jev Choice picked this
  agent), `rules` (tag rules without a tag), or `fallback` (the Choice
  call failed).
  The stored Jev decision sits beside it.
- A routine run starts from its routine.
  The ledger lists every routine with its timing in words and its
  instruction.
  A direct run is the operator's chat, from its first to its last
  message in the window, with the operator's first message in the
  window.
- The outcome is `posted` (a `group_post` in the window, with its
  tool-call id), `wrote` (record, note, script, or code writes; memory
  does not count), or no output.
  A coding wake's code writes come from its run's `metadata.repos`.
  There is one write of kind `code` per repository it changed, with
  the branch, files changed, insertions, and deletions.
  `file_changes` stays the ledger of artifacts.
  Errors in the window mark the wake failed.
  Each wake lists its tool calls in the window in order (at most 200,
  with the total).
  Each call has the first 160 characters of its arguments and its
  result's error and duration.
  The wake also lists the last text the agent wrote.
  A generating run is drawn up to now.
  The view polls every 5 s while one runs.
  **Refresh** re-reads it.

Wakes form **chains**.

A chain starts at a wake that no wake in the window started:

- a routine firing
- an operator message (one chain even when it woke several agents)
- a direct chat
- an agent's post from before the window

It follows each post to the wakes it started until none are left.

**Flow** opens with a **map** of who woke whom.

On the left:

- every routine of the guild's agents (faded when it did not fire)
- the operator's messages
- direct chats

Each sits beside the agent it wakes most.

Agents sit in columns to the right.
An agent mostly woken by other agents sits one column past the agent
that wakes it most.

A line is "A woke B" with its count.
Grey is from a routine or the operator.
Blue is from an agent's post.

Width is 1.5 to 9 px by how often it happened.
A line back to an earlier or the same column loops under the boxes.

Hovering reads out its wakes by outcome and their cost.
Clicking a line or a box selects it.

The selection is part of the overview's location
(`item=link:<from>><to>` or `item=node:<id>`).
Escape clears it.

Below the map, the **chains** list has a row per chain, newest first,
under day headings.
Each row has its start time and what started it.
Then each agent it woke with the wake's outcome and duration.

Connectors join them and say why the message reached the agent
(tagged, routed, rules, fallback).

A post that woke two agents continues on a branch row.
Long chains scroll sideways.

Chains that produced nothing are hidden until the filter is cleared.

A map selection lists only the chains that pass through it.
Those that produced nothing are included.
The hop is highlighted in each row.

Clicking the trigger opens what it carried:

- the routine's timing and instruction with **Open routine**
- the operator's message with **Open group chat**
- the direct chat's opening message
- the earlier post

Clicking an agent opens its wake.
The wake shows:

- when and for how long
- what woke it
- a strip of counts (tool calls, record and note writes, scripts run
  or changed, issues reported, memory, errors, and the post or the
  reply it kept) that points at the matching section
- its tool calls in order with their arguments, durations, and errors
- its side effects
- its errors
- its output (each post and whom it woke, or its last reply)
- **Open in History** (a tool call, a write, or a post opens its
  exact step)
- **Ask the coach**

**Agents** lists each agent's inputs and outputs over the window.

An input is one of:

- its routines (idle ones included)
- the operator's messages
- another agent's posts
- direct chats

Each input shows its wakes, their reasons, and their outcomes.
Clicking one lists its chains in Flow.

The outputs are:

- its group messages and whom they woke
- record writes by collection
- note writes
- scripts run and changed
- issues reported
- wakes that updated memory
- wakes with no output
- errors by message

Studio does not stream a run.

A generating run shows the committed steps under a banner with
**Refresh**.
**Open in agent** opens it in the agent's Chat tab, which streams it.

The run list polls every 5 s while any run is generating.

### Focus pins

**Ask the coach** appears on:

- the run, memory version, routine, and script panes
- every tool call's detail in a History transcript (with its call id
  and `seq`)
- the file open in Files
- a wake opened in the activity chains

It pins that item to the next question as a chip above the composer.
A run opened at a step pins that step.

Kinds:

- a run (optionally one step, by `seq` or tool-call id)
- a memory version
- a routine
- a file or record (optionally one recorded change; a collection path
  is refused with `pick a record`)
- an issue an agent reported

**Investigate in Studio** on an issue card (inbox or guild Issues tab)
creates a session for the issue's guild.
It uses the organisation's default model and temperature 0.2; with
no default, a toast asks for one on Model keys.

It opens the inspector on the reporting agent's History tab at the
run that raised the issue (`tab=history&item=<run id>`).
It pins the issue and drafts a question.
Nothing is sent until the operator sends it.

The operator types the question and sends.

The chip's **Ask in a new session** checkbox instead creates a
session for the same guild and coach with `parent_session_id` set.
It posts the pinned question there and opens it.
The current session stays in the list.

`POST …/messages` takes the pin as `focus`.

The server resolves the ids against the source guild (422 otherwise).
It inserts two user rows in the same generation:

- first an evidence block with `source: studio_focus` and the
  resolved pin in `metadata.focus`
- then the question

The block is `<evidence source="studio.focus.<kind>">`.
It carries:

- the item's coordinates
- a capped excerpt (the focused message or tool call, the section
  diff of a memory version, the routine instruction, the file's first
  bytes and latest change, the issue's kind, severity, failing tool,
  summary, and detail)
- the tool that loads the rest (for an issue, `studio_get_run` on
  the reporting run filtered to `report_issue`)

It stays in the projected history of later turns.
The chat shows the pin as a card that reopens the item in the
inspector.

Evidence references bind to a committed Studio tool message
(`tool_message_seq`).
The model never supplies content hashes or ownership.

Unresolved individual refs become `evidence_warnings`.
A draft with none has `verified_evidence: false`.

## Tools

- `studio_list_agents`
- `studio_get_guidelines`
- `studio_get_agent_context`
- `studio_list_routines`
- `studio_list_runs`
- `studio_get_run`
- `studio_list_group_messages`
- `studio_list_task_revisions`
- `studio_list_memory_revisions`
- `studio_get_memory_version`
- `studio_find_artifacts`
- `studio_get_artifact`
- `studio_list_file_changes`
- `studio_get_script`
- `studio_get_agent_access`
- `studio_request_connection_access`
- `studio_call_connection_tool`
- `studio_create_task_draft`
- `studio_get_guild`
- `studio_list_collections`
- `studio_get_collection`
- `studio_edit_memory`
- `studio_edit_artifact`
- `studio_edit_guild`
- `studio_create_collection`
- `studio_edit_collection`
- `studio_delete_collection`

They do not appear in normal agent Access panes.

Reach is the immutable source guild plus organisation-level artifacts
readable by a member or embedded in a member task.

`studio_find_artifacts` searches notes only.

`studio_get_artifact` reads one note or record by display path.
Collection and record paths are organisation-level, so every table's
records are in reach.
A collection path is refused with a pointer to
`studio_get_collection`.

`studio_get_script` reads one member script by name.

`studio_list_collections` lists every live table in the organisation,
the source guild's own first, then the organisation's, then other
guilds'.
Each row has:

- owner
- purpose
- record count
- column names
- the source guild's mode
- `changeable` (the source guild's own tables and organisation
  tables; another guild's table is read-only here)

`studio_get_collection` reads one table by name.
It returns:

- its full columns
- record count
- `updated_at`
- the source guild's base mode and each live member's own and
  effective mode
- the grants outside the guild
- its five most recently updated records as evidence
  (`apps/orchestrator/src/studio/tables.ts`)

`studio_get_agent_context` sections are:

- `task`
- `memory`
- `state`
- `config`
- `effective_prompt` (the composed opening system message with
  embeds inlined)
- `effective_prompt_headers`

`studio_list_runs` filters by `kind`, `status`, `task_prompt_hash`,
`error_only`, and `schedule_id`.

`studio_list_routines` returns each routine's run count and latest
run.

`studio_get_run` takes `seq_start`, `seq_end`, and `tool_name`.
`tool_name` keeps only the turns that requested that tool and their
results.

`studio_list_memory_revisions` returns the memory timeline headers:

- version index
- revision id
- actor
- time
- sections changed
- line counts

`studio_get_memory_version` returns one version's text and its diff
from the previous one, by `revision_id` or `version_index` (the live
version when both are omitted).

`studio_list_file_changes` lists a file's recorded changes with the
run and tool call that made each one.

`studio_get_guild` returns the live about and description in full.
The system message holds a capped copy.

`studio_get_agent_access` projects what one member is offered at run
start from bindings, the secrets that reach it, and the stored MCP
catalog.
The projection has:

- native tools
- scripts
- secret names and descriptions
- artifact levels
- each MCP connection with its listed tools, whether the server is
  enabled for that agent, and whether this session may read through
  it

No remote list and no credential decryption.

## Connection grants

A session starts with no connection grants.

The coach asks with
`studio_request_connection_access(connection_id, reason)`.
The tool result is a `studio_connection_access` widget with
`await_operator`, so the generation pauses.

The chat shows a card naming the server (and its account) with
**Grant read access** / **Decline**.
Either answer posts a continuation message.

The operator can also grant or revoke from the **Logins** popover in
the workspace header.
It lists every login reachable from the source guild:

- platform
- organisation
- guild
- live-member scope

`studio_call_connection_tool(connection_id, tool, arguments)` proxies
one call through the orchestrator's MCP pool on a granted, connected
login.

The tool must be listed on that connection and pass
`isReadOnlyRemote` (`apps/orchestrator/src/mcp/policy.ts`):

- default-off tools are refused
- a tool the connector's manifest lists is readable unless it is
  `mutating`
- a listed tool marked `readOnlyHint` is readable on a verified
  connector; on any other the hint does not count
- any other tool is classified by the verbs in its name

The result is redacted against that connection's stored credentials,
byte-capped, and wrapped as untrusted evidence.

Grants live on `studio_sessions.granted_connection_ids` and end with
the session.

## Edit requests

`studio_edit_memory(agent_id, content, base_version, reason)`,
`studio_edit_artifact(display_path, content, base_version, reason)`,
and `studio_edit_guild(about?, description?, reason)` each take the
complete replacement text.

The handler checks reach, the byte cap (and the guild field length
limits), and that `base_version` matches the live version.
It writes nothing.

Its result is a `studio_edit_request` widget with `await_operator`,
the target, base and proposed hashes, and line counts.
The proposed text stays in the tool call arguments.

`studio_edit_artifact` takes notes only.
Memory has its own tool.
Tasks, scripts, objects, and records are refused.

The chat renders the widget as a card with:

- the target
- its added and removed line counts
- the base version
- while it is pending, the live text beside the proposal as a diff
  (one per changed field for the guild's about and description, read
  through `GET …/edits/:seq`)
- **Apply edit** / **Decline** buttons

Either answer posts a continuation message.

Apply re-reads the live content and refuses with 409 when its hash
no longer matches the base, which the card shows as stale.
Otherwise it writes as the operator under the session lock.

Memory and notes go through `writeMemory` / `writeNote` with the
expected version, so they produce a memory revision and a
`file_changes` row that carries the edit tool's call id and name.

The guild goes through `updateGuild` and refreshes the session's
`source_guild_snapshot`, so the next turn's system message holds the
new text.
Guild text keeps no history.

The resolution is stored on the tool message as
`metadata.edit_status` (`applied` | `declined`), `edit_resolved_at`,
and `edit_version`.
A request resolves only once.

### Table requests

`studio_create_collection(name, purpose, columns, scope?, access?,
reason)`,
`studio_edit_collection(collection, base_updated_at, name?, purpose?,
columns?, access?, reason)`, and
`studio_delete_collection(collection, reason)` return the same widget
with `kind: "collection"` and `action` (`create`, `edit`, or
`delete`).

`scope` is `guild` (the default: the source guild owns the table) or
`org`.

`columns` follows the column dialect of
[Notes and collections](notes-and-collections.md).
On an edit it is the complete list.
A renamed column carries `rename_from`.

`access` changes only the subjects it names:

- `guild` (`read`, `write`, or `none`, organisation tables only)
- `agents` (`{ agent_id, mode }` with `read`, `write`, `none`, or
  `inherit`, which removes the agent's own row)

Those subjects are the source guild and its live members.
Grants outside the source guild are shown and never changed.

An edit must carry the `updated_at` the coach read and change
something.
A name already taken is refused.
A table of another guild is refused with 422.

The widget targets the table by id (null until a create is applied)
and binds a hash of its name, purpose, scope, columns, and
source-guild access.

The card renders the table before and after as text (a header with
the owner, the purpose, one line per column, one per grant).
It lists what applying does:

- which columns leave or move in how many records
- which stored values stay as they are after a retype
- a column that becomes required or unique
- a renamed table whose name Tasks still carry
- who outside the guild reaches it

Apply re-reads the table by id and refuses with 409 when the hash no
longer matches.
Then it writes as the operator through the artifact store: create,
update, or delete the collection, then each grant it changes.

## Storage

`studio_sessions`, `studio_messages`, `studio_drafts`.

Drafts are immutable numbered rows (`resource_kind = agent_task`).
A revision inserts a new head.

Status:

- `draft`
- `superseded`
- `published`
- `unchanged`
- `discarded`
- `conflicted`

A focus pin is a `studio_messages` user row with
`metadata.source = studio_focus`.
An edit request is a `studio_messages` tool row whose resolution is
in its metadata.

`parent_session_id` records the session a pinned question was asked
from, or the session a token-limit continuation came from.

Session `status` is `active` | `blocked` | `archived`.
`blocked_reason` is `source_deleted` or `input_token_limit`.
`generation_state` is `idle` | `generating` | `cancelling`.

Source guild, creator, and target use `ON DELETE SET NULL` so the
conversation audit survives hard delete.
Live tools and publish disable.

The coach loop is the shared conversation runner
(`apps/orchestrator/src/conversation/`):

- token projection with tool-result stubbing (`projection.ts`, keep
  1 and no size floor)
- cancellation with tool-call repair
- crash reconcile
- organisation admission
- the credentials of the coach's model provider, resolved per
  completion
- subscribe-before-snapshot SSE

Usage is charged to the global and organisation counters and to
`org_monthly_usage`.
It does not increment the source guild or agent lifetime counters.
Settings → Usage shows it as a **Studio coach** row.

## HTTP

```text
GET    /api/studio/sessions
POST   /api/studio/sessions
GET    /api/studio/sessions/:id
POST   /api/studio/sessions/:id/archive
PUT    /api/studio/sessions/:id/target
GET    /api/studio/sessions/:id/connections
PUT    /api/studio/sessions/:id/connections/:connection_id
GET    /api/studio/sessions/:id/edits/:seq
POST   /api/studio/sessions/:id/edits/:seq
GET    /api/studio/guilds/:guild_id/inventory
GET    /api/studio/sessions/:id/inventory
GET    /api/studio/sessions/:id/agents/:agent_id
GET    /api/studio/sessions/:id/agents/:agent_id/routines
GET    /api/studio/sessions/:id/agents/:agent_id/runs
GET    /api/studio/sessions/:id/agents/:agent_id/memory-timeline
GET    /api/studio/sessions/:id/activity
GET    /api/studio/sessions/:id/runs/:run_id
GET    /api/studio/sessions/:id/messages
POST   /api/studio/sessions/:id/messages
POST   /api/studio/sessions/:id/cancel
POST   /api/studio/sessions/:id/continue
GET    /api/studio/sessions/:id/stream
GET    /api/studio/sessions/:id/drafts
GET    /api/studio/orphan-drafts
GET    /api/studio/drafts/:id
POST   /api/studio/drafts/:id/revise
POST   /api/studio/drafts/:id/publish
POST   /api/studio/drafts/:id/discard
```

Create body: `{ "mode": "optimize", "source_guild_id", "coach_config": { model, temperature }, "parent_session_id"? }`.
`model` is required: a marketplace model whose provider the
organisation has connected, else 422.

Activity takes `hours` (default 24, at most 168) and `until` (ISO,
default and at most now) and returns `{ guild_id, since, until, agents,
routines, messages, wakes }`.
A bad value is 422.

A routine carries `label` (its timing in words) and `instruction`.
A wake carries `tool_calls` (`call_id`, `name`, `arguments`, `error`,
`duration_ms`, `at`), `tool_call_count`, `reply`, and, for a direct
chat, `opening`.

Message body: `{ "content", "focus"? }` where `focus` is `{ kind: run |
memory_version | routine | file | issue, agent_id?, run_id?, seq?, call_id?,
revision_id?, version_index?, schedule_id?, display_path?, change_id?,
issue_id? }`.

The agent inspector response carries `effective_prompt` (content, hash,
inlined task, per-section hashes, and whether each section matches the
latest run).

The runs list takes `schedule_id`, `kind`, and `task_prompt_hash` and
returns run headers (status, generating, hashes, `schedule_id`,
`instruction_hash`, error count, `memory_skipped`).
The routines list adds `run_count` and `latest_run`.
The memory timeline returns every version with actor, time,
line-change stats, and for a run-written version the run and its
`memory_write` call id.

Connection grant body: `{ "granted": true | false }`.
The connection must be reachable from the source guild and
`connected`.

SSE: `generation.started`, `assistant.delta`,
`assistant.reasoning.delta`, `message.committed`, `draft.changed`,
`generation.finished`, `session.error`.
The coach log shows reasoning as it streams, then the reply.

Template: `apps/orchestrator/src/studio/system.md`.
Shared placement and trust blocks:
`apps/orchestrator/src/conversation/`.
Focus resolution: `apps/orchestrator/src/studio/focus.ts`.
