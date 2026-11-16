# Runs

A run is one session of work by one [agent](agents.md). It is a
transcript: the system prompt the agent started from, the messages it
received, every model reply, and every tool call with its result. The
operator can open any run and read exactly what happened
([Run transcript](run-transcript.md)).

A run starts in one of three ways: an operator chats with the agent,
the [group chat](group-chat.md) wakes it, or a [routine](routines.md)
fires. Inside a run, the agent works in *generations*: each message it
receives starts one, and the generation ends when the agent replies
without calling a tool. What a run costs is counted on
[Usage](usage.md).

## Why it exists

Agents act on their own, so the operator needs to see what they did
and why. A run keeps everything in order and never rewrites it. The
operator can check the exact prompt an agent saw, follow each step,
and pick a conversation back up later.

## How it works

### Three kinds of run

| Kind | Started by | Shape |
| --- | --- | --- |
| **Direct** | an operator, from the Chat tab | a persistent chat: it stays open after each reply and takes later messages |
| **Group chat** | the group chat | one-shot: one generation that shows the agent the recent chat, then the run completes |
| **Routine** | a routine | one-shot: one generation that hands the agent the routine's instruction, then the run completes |

A one-shot run stays visible. The operator can read the exact prompt
it was given, the message that woke it, and its tool calls. It refuses
later messages until the operator **Resume**s it into a conversation.
A direct run created without a message waits idle with its system
prompt.

An agent runs one thing at a time, whatever the kind. While it
generates, a new direct message is refused, a group delivery waits,
and a due routine waits for a later tick of the scheduler, which
checks every 30 seconds ([Routines](routines.md#the-ticker)).
Different agents generate at the same time, on one machine or on
several.

An agent with an open blocking issue is disabled: it starts no
generation until the issue is resolved. A direct message is refused,
and group deliveries, due routines, and due wake-ups wait
([Inbox and issues](inbox.md#blocking-issues)).

### Generations

A generation is one turn of the agent loop:

1. call the model;
2. store its reply;
3. if it asked for tools, run them one by one and store each result;
4. repeat, until the model replies with text alone.

Every row a generation adds carries its generation number, starting at
1. The opening system prompt has none.

A [subscription agent](agents.md#model-source)'s generation is one
turn of its harness instead: the harness's CLI runs in the agent's
sandbox on the run's system prompt and the messages that opened the
generation, with its own tools and the run's Guilds tools, which it
calls on the orchestrator's MCP server, and the run keeps what it
writes as rows while it runs ([Harness turns](#harness-turns)).
Each of the four harnesses runs a subscription agent's turns; Cursor
and Antigravity only for an agent with a repository.

### What a run stores

Each row holds two things:

- the **payload**: exactly what the model sees, such as a message's
  role and text;
- the **metadata**: what the operator sees and the model never does,
  such as tokens, cost, timings, and the model's reasoning.

Rows are only ever appended, and a stored payload never changes. What
the model was sent can always be rebuilt from the stored rows and the
run's snapshot. The orchestrator never retries a provider call by
itself.

The **snapshot** freezes the agent at run creation: its model
settings, its switches, and the tools it may be offered. Changing the
agent later affects new runs, with two exceptions:

- Each generation offers only the snapshot's tools that the agent's
  bindings and switches still grant. A tool turned off leaves an open
  chat at its next generation. A tool turned on reaches new runs only.
- Secrets are looked up again at every generation, so a new grant
  reaches an open chat ([Secrets](secrets.md)).

### Limits that end a run

Three limits from the agent's settings stop a run that goes on too
long:

- **Max steps**: model calls in one generation. Past it the generation
  stops with an error. The run stays open.
- **Max tool calls**: tool calls in the whole run. Near the end, each
  tool result says how many calls are left and asks the agent to wrap
  up. At the limit the run completes.
- **Max input tokens**: the size of the prompt sent to the model.
  Above it the model is not called and the run completes.

A subscription agent's turn keeps Max steps and Max tool calls, and
adds **Max turn minutes**, how long the turn runs before its harness
is stopped. Max steps ends a Claude Code turn after that many model
calls; Codex has no such limit. Max input tokens does not apply: the
harness keeps its own context ([Harness turns](#harness-turns)).

A run that hit its tool-call or input-token limit cannot be resumed.
Start a new one.

A run also completes when its model cannot be called: the model's
provider is not connected for the organisation, or an extension refuses
the model credentials or blocks the organisation. That run can be
resumed once the cause is fixed.

A generation also ends when the agent files a blocking issue with
`report_issue`: no later tool call of that reply runs and the model
is not called again. A direct run stays open and a one-shot run
completes; either takes a message again once the issue is resolved
([Inbox and issues](inbox.md#blocking-issues)).

### Tool-result stubbing

Tool results can be large: a web page, a long file. Old ones rarely
matter. Before each model call, large tool results from earlier turns
are replaced by a short stub, in what is sent only. The stub says
which tool produced the result and how to fetch it again. The stored
run keeps the full results. The guild's settings say how many user
turns, including the current one, keep their full tool results; a new
guild keeps 2. An agent's own setting, when set, takes the place of
its guild's.

### Wake-ups

A wake-up brings a run back after a delay, in the same conversation.
The agent sets one with `wake_after`, a delay of 1 to 360 minutes, and
an optional note to itself, and cancels it with `wake_cancel`
([Native tools](../tools-and-connectors/native.md#wake-ups)). It
belongs to one run, is due at a set time, and fires once. A run holds
at most one pending wake-up; setting another replaces it. A run fires
at most `max_wake_ups` wake-ups, 10 by default. When it fires, the run takes one
more generation that opens with a wake-up message, and the agent
decides what to do next.

The scheduler fires due wake-ups every 30 seconds, before it wakes
due routines, so an agent goes back to work in progress before it
starts new work. A wake-up whose agent is busy stays due for a later
tick. Wake-ups are stored, so one that came due while the
orchestrator was down fires on its first tick.

| The run when the wake-up is due | What happens |
| --- | --- |
| open | the wake-up message starts the next generation |
| completed at the end of its generation (a group chat or routine run), or because its model could not be called | the run reopens for the wake generation and completes again when it ends; it does not start taking messages |
| completed on its tool-call or input-token cap | the wake-up is cancelled, and the run records the error `wake.cancelled`, naming the cap |

A run that ends on one of those caps cancels its pending wake-up as
it ends. A wake generation is an ordinary generation: it counts
toward the run's tool-call and input-token limits, starts the agent's
machine when it is down, and starts the machine's idle timer again
when it ends.

### Cancel, interrupt, resume

- **Cancel** stops the current model call, tool command, or harness
  turn. A direct run stays open.
- If the orchestrator restarts mid-run, unfinished tool calls get an
  "interrupted" result, so the transcript stays valid. A one-shot run
  is marked completed.
- **Resume** reopens a completed run so it takes new messages again.

## In the app

### Chat tab

The agent's **Chat** tab shows sessions with the agent. A session is a
run. The body of the tab is the
[run transcript](run-transcript.md).

- Without `?run=`, it shows the run that is generating, keeps showing
  that run when the generation finishes, or opens a new session when
  none is generating.
- After three minutes with no action on a finished generation, the
  next time the window is focused the inspector closes.
- The tab strip carries a clock, **Session history**, that opens the
  **History** drawer (`?history=true`), and a plus, **New session**. A
  new session opened with the plus stays open while another run is
  generating. While a run is open, sparkles, **Debug in Studio**, opens
  it in Studio ([Prompt Studio](prompt-studio.md#opening-studio)).
- On a coding agent, a coding strip sits under the tab strip
  ([Coding agents](coding/index.md)).

The **History** drawer lists every run of the agent, newest first,
grouped by day, 50 at a time. It filters by kind: **Direct**,
**Group chat**, or **Routine**. Each row shows its title, the time,
the message a group chat run read up to, and the status. The title is
**Direct session**, **Group chat**, or the routine's description, and
**Routine wake-up** for a routine without one. A row opens that
run in Chat. On a phone the drawer covers the transcript until it is
dismissed. `/guilds/<id>/agents/<id>/history` opens Chat with the
drawer expanded.

The **composer** always shows a paperclip. When the agent's model
accepts images, or the agent is a subscription agent, it adds JPEG,
PNG, GIF, or WebP images, at most four, 10 MiB each. A message may be images with no caption. When the model
does not accept images, or is not among the organisation's chosen
models, the paperclip is disabled and a tooltip says so. The
transcript shows the images on the operator's bubble.

A run with a pending wake-up shows a banner under the transcript:
**Wakes up at `<time>`**, with the agent's note, or **The agent left
no note.**, and **Cancel**, which cancels the wake-up at once. The
banner follows the run's stream, so it appears when the agent sets a
wake-up and goes when the wake-up fires or is cancelled. The wake
generation's message shows in the transcript as its own row
([Run transcript](run-transcript.md#messages)).

An ended run shows a banner under the transcript:

- **This session has ended**, with **Resume**, when it can be resumed.
  The same transcript reopens and the next message continues it.
- **This session reached its limit**, with **New session**, after a
  tool-call or input-token cap.

## Rules and limits

| Rule | Value or behaviour |
| --- | --- |
| Generations at a time | one per agent; a second direct message is 409 |
| Max steps | 30 by default (200 for a new coding agent) |
| Max tool calls | 50 by default (200 for a new coding agent); counts every tool result in the run |
| Wrap-up warning | when 8 tool calls or fewer are left |
| Max input tokens | 100000 by default; counted with `js-tiktoken` |
| Max wake-ups | 10 by default, for a coding agent too |
| Max turn minutes | 30 by default; a subscription agent's turn of its harness |
| Full tool results kept | the agent's setting, else its guild's; 2 user turns for a new guild |
| Results never stubbed | under 2048 bytes |
| Routine check | every 30 seconds |
| Wake-up check | every 30 seconds, before the routines; a wake-up fires up to 30 seconds late |
| Pending wake-ups | at most 1 per run; a new one replaces it |
| Wake-up delay | 1 to 360 minutes, whole |
| Wake-up note | optional, trimmed, at most 1000 characters |
| Wake-ups per run | `max_wake_ups`, counted over the run's fired wake-ups |
| Operator message before a wake-up is due | the wake-up stays pending and fires at its time |
| Wake-up on a capped run | cancelled, with `wake.cancelled` recorded |
| Images per message | at most 4, 10 MiB each, JPEG, PNG, GIF, or WebP |
| Image cost in token counting | 1600 tokens each |
| One-shot runs | refuse messages until resumed |
| Resume | refused after a tool-call or input-token cap |
| Provider retries | off |

## Reference

### Run row

`runs` holds `id`, `agent_id`, `org_id`, `kind` (`direct`, `group`, or
`schedule`), `status` (`active` or `completed`), `config_snapshot`,
`errors`, `metadata`, `group_chat_through_seq` (group runs),
`wake_group_message_id` (group runs: the public row that woke it),
`schedule_id` (schedule runs), `started_by_user_id` (direct runs: the
person who opened it), the system, task, and memory prompt hashes,
`created_at`, and `updated_at`. Clearing the group chat or deleting the
user clears the matching link. Deleting the agent deletes its runs. The app labels `group` **Group
chat** and `schedule` **Routine**.

A direct run, or any run the operator has resumed, stays `active`
after its generation. A group or schedule run becomes `completed`. Any
run becomes `completed` when it ends on a limit or a model it cannot
call ([Generation](#generation)). A completed run that
a wake-up reopens becomes `completed` again after the wake generation
([Wake-up rules](#wake-up-rules)).

### Opening rows

Row 0 is the composed system prompt. A direct run created with a
message adds it as row 1. A group run adds one Group Chat info user
message, and a schedule run one Schedule wake-up user message
([System prompt](system-prompt.md#the-runs-own-messages)). Later user
messages append operator text, or a fired wake-up's message
([Wake-up rules](#wake-up-rules)).

### Attachments

A user row may carry `metadata.attachments`: `{ id, filename, mime,
kind }` refs uploaded through `POST /api/attachments`. The stored
payload stays `{ role, content }`. An empty caption is allowed when
images are present.

At provider-request time the orchestrator hydrates image refs into
Chat Completions `image_url` parts:

- a 15-minute signed URL;
- a data URL when the store cannot sign;
- always a data URL for Kimi, which refuses public image URLs.

A Messages API provider receives the same parts as image blocks: a
data URL as a base64 source, a signed URL as a URL source.

A subscription agent's harness reads each image as a file. Before its
turn starts, the orchestrator writes every image of the messages that
open the generation into the agent's home, through its host
directory, at `.runs/<run id>/attachments/<attachment id>/<filename>`,
and the turn's prompt follows each message's text with one line per
image: `Attached image: /home/<agent id>/.runs/<run id>/attachments/<attachment id>/<filename>`.
The files go with the run's folder, which `.runs/` keeps for the
agent's 20 most recent runs ([Process](coding/harnesses.md#process)). An
image the store no longer holds fails the turn at start with
`harness.start`.

Token counting adds 1600 tokens per image. It does not encode those
URLs.

`POST /api/attachments` takes the file bytes as the body, with the
name in `X-Filename`. It returns 201 with `id`, `filename`, `mime`,
`bytes`, `kind`, `url`, and `created_at`. It refuses an empty file or
one over 10 MiB (422). Sending refs refuses a model on a key that does not take
attachments, more than four refs, or a repeated ref (422), and an
unknown ref (404); a subscription agent takes them whatever a model
would. `GET /api/attachments/:id` serves the bytes to the
same organisation.

### Metadata

Metadata sits beside the payload and is never sent to the model:

- usage;
- cost ([Usage](usage.md));
- latency;
- tool timings;
- generation number;
- source;
- the model's reasoning text and provider reasoning blocks, when it
  streamed any;
- on a row of a subscription agent's harness turn, `from_harness`: the
  harness whose CLI wrote the message, or ran the tool the call and
  its result are of ([Harness turns](#harness-turns)).

Tool-result metadata includes the provider tool-call id for
correlation. The message row already owns the run id. Agent, guild,
and organisation ids resolve through the run rather than being copied
into metadata. Durable file mutations record the same run and
tool-call identity in `file_changes` ([Artifacts](artifacts.md)).

### Exactness rules

1. Payloads become immutable when inserted.
2. Rows are append-only; sequence numbers never change.
3. Every model call receives a recorded projection of the current
   payloads in sequence order. Tool-result stubbing is the projection;
   user and assistant text are unchanged. Replay
   `projection_policy_version` and `keep_tool_result_generations` from
   the run snapshot on the stored rows to rebuild what was sent.
4. An assistant row is the response to that projection of the prefix
   preceding it.
5. Model parameters stay fixed for the run. Each generation offers
   the snapshot's tool schemas that the live bindings and switches
   still grant, and never one the snapshot lacks.
6. Automatic provider retries are off.
7. Tool results enter history only after the output pipeline.

### Snapshot

The run stores an immutable snapshot. It holds the agent's config at
run creation, less `max_scripts`, `max_workspace_mib` and
`repositories`, which a coding run reads from its agent when it
starts ([Repositories](coding/repositories.md#where-the-list-comes-from)), with the
guild's `keep_tool_result_generations` when the agent's is null, and
with the offered `tools`, `mcp`, `secrets`, and the `scripts`
([Scripts](scripts.md#snapshot)). Its `model` states the run's model
source: a model on a key, or null for a subscription agent's run. A
subscription agent's run offers the `tools` and `mcp` connections a
run on a key with the same access would, less the code tools
([Tools in a run](../tools-and-connectors/tools-in-a-run.md#a-subscription-agents-run)).
Its `secrets` reach the harness's environment.

Model settings include `max_tool_calls`, `max_input_tokens`,
`max_wake_ups`, `max_turn_minutes`, `keep_tool_result_generations`,
`projection_policy_version`, and `thinking_level`. `max_wake_ups` is
the most wake-ups the run may fire; `wake_after` is refused past it. `max_turn_minutes` is how
long a subscription agent's turn runs before its harness is stopped
([Harness turns](#harness-turns)).

Flags: `browser`, `coding`, `scripting`, and `memory`. Beside them,
`harness` is a coding agent's harness or null, `harness_model` the
model that harness runs or null for its subscription's default,
`harness_effort` the effort it runs that model at or null for the
model's default ([Harnesses](coding/harnesses.md)), and
`secret_aliases` the agent's secret aliases ([Secrets](secrets.md)).

The complete tool schemas offered to the model:

- enabled native bindings: note, record, memory when `memory` is true,
  and script tools when `scripting` is true;
- `secret_store`;
- `secret_request` on direct runs;
- `report_issue`, always;
- the seven schedule tools, when bound, on direct and group chat
  runs;
- `group_post` when that binding is on;
- `wake_after` and `wake_cancel` when bound, on every kind of run;
- the browser tools of its mode when `browser` is true: the eight
  step-by-step tools, or `browse` and `browser_eval` while
  `browser_optimized` and the System One platform key are on;
- the five code tools when `coding` is true;
- enabled MCP schemas, including curated lists from the CoinGecko,
  Alchemy, X, TwitterAPI.io, Qonto, and DexPaprika adapters, and a
  registry connector's manifest.

The snapshot also stores the agent's secrets as `[{id, name,
description}]` and a slim `mcp` list of `{connection_id, server_id,
slug, tools: [{name, remote_name}]}`.

Each generation narrows the snapshot's native tools to those the
agent's live bindings and switches still grant. Connection tools stay
as snapshotted. A snapshot that froze `browse` keeps it while the
agent's config keeps the agent-optimized browser on; its calls answer
that the System One key is missing while the key is off. Such a run
logs `browse.integration_off` once and records
`metadata.browse_integration_off_at`.

Each generation re-resolves the agent's secrets (organisation-wide,
granted to its guild, granted to it), writes them onto the snapshot,
and decrypts their values. A later grant, removal, or rotation reaches
an existing direct run. A deleted, missing, or undecryptable secret is
a generation-start error.

### Generation

A run whose snapshot has no `model` is a subscription agent's
([Agents](agents.md#model-source)). Its generation is a turn of its
harness ([Harness turns](#harness-turns)). Before the machine is
woken, it fails with `harness.missing` when the snapshot names no
harness. One whose agent picks repositories, or whose harness is
Cursor or Antigravity, fails as a coding run does when its agent
picks none (`coding.repositories_missing`) or one it can no longer use
(`coding.repositories_gone`).

At start, the loop cancels the machine's idle timer, ensures the
machine is up, and checks the disk caps. A home or machine over its
cap fails the generation with `workspace.full`
([Agent home](agent-home.md#the-disk-cap)). After the generation it
measures and stores both sizes. When the last generation on the
machine ends, the idle timer starts again
([Machines](machines.md#idle-timer)). A coding run is checked further
before the model is called: harness picked, guild repositories,
harness installed and credentialed, repositories prepared
([Coding agents](coding/index.md)). A subscription agent's run is
checked for its harness the same way: not turned off, installed, and
credentialed, with the same errors
([Harnesses](coding/harnesses.md#credentials-and-errors)). Its tools
are narrowed to the agent's live bindings as a model's are; no model
credential is resolved. One whose agent picks repositories is checked
for them as a coding run is, then has them prepared before its turn
([Repositories](coding/repositories.md#what-a-subscription-agents-turn-does-with-them)).

It loads every payload in order and repeats the loop up to
`max_steps` times. Each step filters every tool result through the
output pipeline before it appends one tool message. If the last
allowed step still has tool calls, those tools run, then the loop
records `generation.max_steps`. The run stays active.

`max_tool_calls` counts every tool result on the run. After the output
pipeline, each stored tool result ends with `remaining_tool_calls: N`,
the count left after that result. When N is 8 or fewer, a wrap-up line
sits above that trailer: write durable findings and finish with text;
a batch costs one call each. When the count reaches the cap, the
current batch still finishes. Then the run records
`generation.max_tool_calls` and completes.

Before each model call the orchestrator projects the stored history,
then counts that prompt (messages and offered tools) with
`js-tiktoken` against `max_input_tokens`. Above that cap it does not
call the model. It records `generation.max_input_tokens` with a
message to start a new run, and completes the run.

Before each model call the orchestrator also resolves the model's
credentials. Each of these records its operation and completes the
run:

| Operation | Cause |
| --- | --- |
| `generation.model_key` | the model's provider is not connected for the organisation |
| `generation.model_credentials` | the extension's model credentials refuse the call |
| `generation.subscription` | the extension's policy blocks the organisation; core never blocks |

Resume is refused after `generation.max_tool_calls` and
`generation.max_input_tokens`, and allowed after the three above.

A `report_issue` call that files a blocking issue ends the
generation after its result is stored. Each later call of the same
reply gets the interrupted result, the run records
`generation.blocked`, and the run does not complete because of it.

Admitting a generation refuses an agent with an open blocking issue
with `agent is disabled by a blocking issue: <summary>. Resolve the
issue first`: a 409 on a direct message, and a wait for a group
delivery, a routine, or a wake-up.

### Harness turns

A subscription agent's generation is one turn of its harness's CLI,
under the call id `turn_<generation>_<run id>`
([Process](coding/harnesses.md#process)):

1. **Start.** `guilds-harness start` runs the CLI in the agent's home,
   or in the working tree of the one repository it picks, under
   `repos/<name>` ([Repositories](coding/repositories.md#what-a-subscription-agents-turn-does-with-them)),
   on the agent's harness model and effort, with the run's first row,
   its composed system prompt: in place of the CLI's own on Claude Code
   and Codex, and as a rules file in the agent's home beside the CLI's
   own on Cursor and Antigravity, which keep their vendor's system
   prompt ([Drivers](coding/harnesses.md#drivers)). Its prompt is
   every user message since the run's last assistant or tool row, in
   order, joined by a blank line: the opening message, a message the
   operator sent, a Group Chat info or Schedule wake-up message, or a
   wake-up's message, each followed by a line naming the path of each
   image attached to it ([Attachments](#attachments)); the CLI reads it
   on stdin, Cursor from a file its command line names. On Claude Code the turn makes at most the
   snapshot's `max_steps` model calls (`--max-turns`); Codex, Cursor,
   and Antigravity have no such limit, so `max_turn_minutes` and
   `max_tool_calls` bound their turns. A run whose `metadata.harness_turn` holds a session resumes
   it; a new run starts a new session. The run records
   `metadata.harness_turn` at the start and again once the CLI reports
   its session. The generation's grant on the orchestrator's MCP server
   opens before the start: the CLI is given its URL and token for that
   one call
   ([The MCP server](../tools-and-connectors/tools-in-a-run.md#the-mcp-server)).
2. **Poll** every second, once each repository token within 10
   minutes of its expiry is replaced. Each poll's new events become
   rows as they come, published as `message.committed`
   ([Run transcript](run-transcript.md#harness-turns)): each message
   of the CLI an assistant row, its calls of its own tools the row's
   `tool_calls`, and each result a tool row. Text, tool inputs, and
   results are redacted with the run's secret values, and each result
   is capped as a tool's output is. Every row carries
   `from_harness`, the harness, and the generation number. A call of
   a tool of the orchestrator's MCP server and its result make no row
   from these events: the server keeps the call as the run's own, an
   assistant row holding it and its tool row, as a model's call is
   kept. Claude Code and Codex name such a tool `mcp__guilds__<tool>`,
   Antigravity `mcp_guilds_<tool>` or calls it through
   `call_mcp_tool` with the server `guilds`, and Cursor's event names
   the server `guilds`.

   | CLI | Message | Call of its own tool | Result |
   | --- | --- | --- | --- |
   | Claude Code | each `assistant` event's text | each `tool_use` block, under its id and tool name | each `tool_result` block of a `user` event |
   | Codex | each completed `agent_message` item | each `command_execution` (its `command`), `file_change` (its `changes`) or `web_search` (its `query`) item as it starts, or as it completes when it did not announce its start, under `<call id>.<item id>` and the item's type | the completed item: a command's output, a line per changed file, nothing for a search |
   | Cursor | each `assistant` event's text | each `tool_call` event as it starts, or as it completes when it did not announce its start, under `<call id>.<Cursor's call id>` and the tool's kind without `ToolCall` (`shell`, `read`, `write`), with its `args` | the completed event's `result`: a command's output, a file's content, an error's text, else the result as JSON |
   | Antigravity | each `agent_response` step's text, its pieces joined once the step is `DONE` | each `tool` step as it is `ACTIVE`, or as it ends when it did not announce its start, under `<call id>.step_<step index>` and the tool's name, with its parameters | the step that ended: its output, or its error's message |

   Codex's other items (its reasoning, its plan, an error notice) make
   no row.
3. **End.** A CLI that exits 0 without an error result ends the
   generation as a model's final reply does: the run completes or
   waits by the same rules. Any other ending records its error:

| Operation | Cause |
| --- | --- |
| `harness.start` | `start` failed: "`<Harness>` did not start: `<reason>`" |
| `harness.failed` | the CLI exited otherwise, or its turn ended in error: "`<Harness>`'s turn failed (`<detail>`)", the detail the most telling of the CLI's error, its stderr's last lines, or its exit code |
| `harness.lost` | a poll found the turn's state gone, or the CLI exited and its result could not be read |
| `harness.unresponsive` | three polls in a row failed; the harness got `stop` |
| `harness.timed_out` | the turn ran its snapshot's `max_turn_minutes`: "`<Harness>` was stopped after `<minutes>` minutes."; the harness got `stop` |
| `generation.max_steps` | Claude Code ended its turn at its `max_steps` model calls: "max_steps reached". The run stays open, as a model's run does at the limit |
| `generation.max_tool_calls` | a call of the MCP server came once the run had made `max_tool_calls` calls; the harness got `stop`, and the run completes |
| `generation.blocked` | a call of the MCP server filed a blocking issue; the harness got `stop` |

A harness that does not stop adds "It did not stop and may still be
running; its log is `<path>`." Once `start` has gone, every way out
but a clean exit or lost state sends `stop`: a cancel, the time limit,
three failed polls, a stop the MCP server's calls asked for, or an
error. However the turn ends, the generation's token is revoked once
the server has kept the call it is running, and a call of the
harness's own tools still without a result gets the interrupted
result, marked `from_harness`.

The turn's reply records the tokens the turn spent, over every model
call of the CLI, as a model reply records its call's
([Usage](usage.md#cost-of-a-harness-turn)): `metadata.usage`,
`cost_usd` 0, and `cost_source: "subscription"`. A message of the CLI
with no call of its own tools is held until the CLI's next event, so
the reply is the one the usage follows; when none is held, an empty
reply records it, and a turn that ends without its usage keeps the
held message as it is.

| CLI | Usage read from | The turn's tokens |
| --- | --- | --- |
| Claude Code | the `result` event's `usage`: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` | the invocation's; input counts the cache's reads and writes |
| Codex | `turn.completed`'s `usage`: `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens` | the thread's total less what the run's earlier Codex replies recorded; a total below that is a new thread's, all of it the turn's |
| Cursor | the `result` event's `usage`: `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens` | the invocation's; input counts the cache's reads and writes. A `result` without `usage` records none |
| Antigravity | the `result` event's `usage`: `input_tokens`, `output_tokens`, `cache_read_tokens` | the conversation's total less what the run's earlier Antigravity replies recorded, as Codex's; input counts the cache's reads |

`metadata.harness_turn` holds `call_id`, `harness`, `session_id`, and
`log_path`. The turn's raw log stays at `log_path` in the agent's home,
`.runs/<run id>/turn_<generation>_<run id>.harness.jsonl`, under the
same retention as a code task's. A turn in repositories that changed
one appends an entry to `metadata.turn_changes`
([Reviewing changes](coding/reviewing-changes.md#refs)).

### Harness turns by how a run starts

Every way a run starts, and every way a run takes its next
generation, gives a subscription agent one turn of its harness, on
the run's composed system prompt and the opening message a model on a
key reads in its place. The run completes, waits, and refuses
messages as a key agent's does.

| Start | The turn's prompt | Session | Where the reply goes |
| --- | --- | --- | --- |
| an operator's first message (direct run) | the message, and a line per attached image | a new one | the run; a direct run stays open |
| the operator's next message | the message, and a line per attached image | the run's, resumed | the run |
| a group delivery | the **Group Chat info** message | a new one | the run, which completes; the agent posts to the chat only with `group_post`, which its harness calls on the MCP server |
| a routine firing | the **Schedule wake-up** message | a new one | the run, which completes |
| a wake-up | the **Wake-up** message | the run's, resumed, also on a one-shot run the wake-up reopens | the run, which completes again when it reopened |
| a message to a resumed one-shot run | the message | the run's, resumed | the run |

A session belongs to a run, as a key agent's history does: a run's
turns resume the session its last turn reported, and a new run starts
a new one, carrying what earlier runs learned only through Memory,
notes, records, State, and the group chat's history, as a key agent's
new run does.

Between a model loop's steps the orchestrator acts on the run; inside
a harness turn the CLI takes its own steps, and the orchestrator acts
at the nearest point it has:

- **A cancel, or an interrupting group post**, sends the harness
  `stop` as soon as the poll under way, if any, returns, as a model
  loop stops its model call or command. The interrupted delivery
  completes and the chat delivers to the agent again.
- **A message posted while the agent generates** is refused, or waits
  for the next delivery, for a harness turn as for a model loop; no
  message enters a turn under way.
- **Max tool calls and a blocking issue** are checked on each call of
  the MCP server, where a model loop checks them between steps; the
  call past the limit or the blocking call ends the turn.
- **Tool-result stubbing and the input limit** do not apply: the
  harness sends its own session to its model, and compacts that
  session itself when it grows. A subscription agent's run never hands
  off for its size.
- **Each generation's set-up** runs as a model loop's does before its
  first step: the secrets are looked up again, the live bindings
  narrow the offer, and the machine is started.

### Stubbing rules

For the provider request only, large tool **results** outside the keep
window are replaced with a short stub:

- `tool_name`;
- `source_seq`;
- `path` and `range` when the metadata has them;
- a hint to call the same tool again.

Assistant `tool_calls` stay. User and assistant text stay.

Here a generation is one user turn and the tool loop that follows.
`keep_tool_result_generations` (the agent's, else
its guild's; snapshotted) is how many generations stay live,
including the current one:

- `1`: stub every previous generation.
- `2`: also keep the previous user turn's tool results; stub older.
  A new guild starts here.

A result under 2048 bytes is never stubbed. When the projected prompt
is still over `max_input_tokens`, the oldest live results above that
floor are stubbed until four remain or the count fits. Policy version
`1`.

### Wake-up rules

`run_wakes` holds a run's wake-ups: `id` (`wk_…`), `run_id`,
`root_run_id` (the run itself), `agent_id`, `due_at`,
`message` (the agent's note, or null), `state` (`pending`, `fired`,
or `cancelled`), `cancel_reason` (`replaced`, `agent`, `operator`, or
`limit`, set only on a cancelled one), `set_tool_call_id`,
`created_at`, and `fired_at` (set only on a fired one). A partial
unique index keeps one pending wake-up per run. Deleting the run or
the agent deletes its wake-ups.

Each tick of the scheduler, before the due routines:

1. It lists the pending wake-ups with `due_at` at or before now.
2. It skips a wake-up whose agent is busy. It stays due.
3. It loads the run.
4. A run that recorded `generation.max_tool_calls` or
   `generation.max_input_tokens` has its wake-up cancelled as `limit`. The run records `wake.cancelled`,
   whose message names the wake-up and the cap, and publishes it as
   `run.error`.
5. It takes the agent's generation lock. A conflict leaves the
   wake-up due.
6. In one transaction it marks the wake-up `fired`, sets a completed
   run `active` with `metadata.wake_reopened_generation` (the
   generation it reopens the run for) and without
   `metadata.resumed_at`, and appends the wake-up message as the run's
   next generation. A wake-up no longer pending by then appends
   nothing.
7. It publishes the wake-up message on the run's stream as
   `message.committed`, and generates in the background, as an
   operator message does.

The wake-up message is a user row, `metadata.source: "wake"`, with
`wake_id` and `reopened_run` (whether it reopened a completed run):

```text
Wake-up: {
  "id": "wk_…",
  "set_at": "2026-11-05T14:02:11.204+00:00",
  "due_at": "2026-11-05T14:12:11.204+00:00",
  "fired_at": "2026-11-05T14:12:30.517+00:00",
  "message": "Check deploy 4812 on the staging dashboard; if green, post the summary.",
  "wake_ups_left": 7
}
```

`wake_ups_left` is the run's snapshot `max_wake_ups` less the run's
fired wake-ups, this one included, and never below
0. Tool results of earlier generations are stubbed as usual
([Stubbing rules](#stubbing-rules)).

A run completes when the generation its
`metadata.wake_reopened_generation` names ends, whatever its kind. A wake-up never stamps
`metadata.resumed_at`, so a group or schedule run it reopens still
refuses messages, and a completed group run it reopens completes
without moving the agent's group cursor.

When a run ends on `generation.max_tool_calls` or
`generation.max_input_tokens`, the generation cancels its pending
wake-up as `limit` and records `wake.cancelled` as it ends.

### Streaming

Committed assistant and tool rows, and a fired wake-up's message, are
published over SSE after the database transaction. Reasoning and token deltas may stream first, and
a running `code_task` streams its progress lines, and a running
`browse` call each of its steps, as `tool.progress`.
History is the committed row. On reconnect the UI reloads ordered
history, then consumes new events.

### Cancellation and restart

Cancellation stops the current model call, tool command, or harness
turn, whose CLI gets `stop`. It records `generation.cancelled` and
leaves a direct run active. The machine stays.

If an assistant row with tool calls is already in history,
cancellation or restart appends `ERROR: execution interrupted` for
every unresolved call, so the next model request is valid.

On orchestrator startup, unresolved tool calls in active runs get
those interruption results. Startup does not replay a model call. An
unresolved `code_task` is stopped and checkpointed first
([Code tools](coding/code-tools.md)). A subscription agent's run with
a `metadata.harness_turn` has its harness turn ended first: the turn's
CLI gets `stop` on the agent's machine when the machine runs, the
session its result names replaces the one kept, so the run's next
generation resumes it, and each call of the harness's own tools
without a result gets the interrupted result, marked `from_harness`
([Harness turns](#harness-turns)).

An interrupted group or schedule run that the operator has not
resumed records `generation.interrupted` (`orchestrator restarted`)
and is marked completed. For a group run, startup also advances the
agent's group cursor through the stored snapshot, and group dispatch
resumes. A direct run, or a resumed one, stays active. Startup then
starts the idle timer of every running machine on which no agent
generates.

### Resume

`POST /api/runs/:id/resume` reopens a completed run that did not hit
`generation.max_tool_calls` or `generation.max_input_tokens`. It sets `status` back to `active` and stores
`metadata.resumed_at`. An active run is returned unchanged.

The same transcript then accepts later user messages. A group or
schedule run rejects messages until that field is set (409
`<kind>-triggered runs do not accept later messages`). After it is
set, a schedule generation leaves the run active.

### Errors and logs

Every failure the loop records appends one entry to `runs.errors`:

| Field | Content |
| --- | --- |
| `at` | when it failed, ISO 8601 |
| `generation` | the generation number |
| `operation` | what failed, such as `llm.complete`, `workspace.full`, or a `generation.*` operation above |
| `error_type` | the error's class name |
| `message` | the error message, with known secret values redacted |

The same entry is published on the run's stream as `run.error`
([Run transcript](run-transcript.md#errors-outside-a-flow)). A
provider failure before any assistant row creates no message row.

Logs carry the run, guild, agent, operation, error type, and
`traceback`.
They redact known secret values. They omit prompts, payloads, and tool
results.

### HTTP

| Route | Does | Success | Refusals |
| --- | --- | --- | --- |
| `GET /api/agents/:id/runs` | the agent's runs | 200 | |
| `POST /api/agents/:id/runs` | creates a direct run, with optional `message` and attachment ids | 201 idle, 202 generating | 422 empty message, a `message` that is neither a string nor null, or `attachment_ids` that are neither a list of strings nor null; 409 agent generating, guild being deleted |
| `GET /api/runs/:id` | the run, with `pending_wake` | 200 | 404 |
| `GET /api/runs/:id/messages` | its rows in order | 200 | 404 |
| `POST /api/runs/:id/messages` | appends `content`, with optional attachment ids, and starts a generation | 202 | 422 empty, a `content` that is neither a string nor null, or `attachment_ids` that are neither a list of strings nor null; 409 one-shot not resumed, ended, or generating |
| `POST /api/runs/:id/resume` | reopens a completed run | 200 | 409 capped |
| `POST /api/runs/:id/cancel` | cancels the current generation | 202, or 204 with nothing to cancel | 404; 409 `run is not active` |
| `DELETE /api/runs/:id/wake` | cancels the run's pending wake-up as the operator | 204 | 404 `run not found`, or `no pending wake-up` |
| `GET /api/runs/:id/stream` | the run's SSE stream | 200 | |

`GET /api/runs/:id`, and the run that `POST /api/runs/:id/messages`,
`POST /api/runs/:id/resume`, and a 202 from
`POST /api/runs/:id/cancel` answer with, carry `pending_wake`: null,
or the run's pending wake-up as `{ id, due_at, message, created_at }`.
A run list and a new run do not carry it. Every change of the pending
wake-up publishes `run.wake.changed` with `{ pending_wake }` in the
same shape on the run's stream: set, replaced, cancelled by the agent,
the operator, or a cap, and fired.
`DELETE /api/runs/:id/wake` is open to whoever may read the run, as
cancel and resume are, and records `cancel_reason: "operator"`.

### Code

- `apps/orchestrator/src/generation/`: the generation loop
  (`index.ts`), one module per part:
  - `active-generations.ts`: the busy lock, one generation per agent
  - `runs.ts`: creating runs, `deliverGroupRun`,
    `deliverScheduleRun`, and the scheduler
  - `prepare.ts` and `snapshot.ts`: the composed prompt and the
    snapshot
  - `generate.ts`: a generation's set-up, its model steps or its
    harness turn, and the offered tools (`offered-tools.ts`)
  - `completion.ts`: model calls, input counting, and credentials
  - `harness-loop.ts`: a subscription agent's turns on its harness;
    `harness-prompt.ts`: what a turn reads from the run's rows;
    `harness-ending.ts`: how a turn ended and the run error it fails
    with; `parse-claude-code.ts`, `parse-codex.ts`, `parse-cursor.ts`,
    and `parse-antigravity.ts`: each CLI's events; `harness-rows.ts`:
    the rows they make
  - `tool-calls.ts`: tool calls and interruption results
  - `events.ts`: committed rows, run errors, and stream events
  - `run-secrets.ts`: the secrets of each generation
  - `wakes.ts`: firing due wake-ups, and cancelling one on a capped run
  - `caps.ts`: the caps a resume cannot lift and a wake-up does not
    reopen
  - `workspace.ts`: the disk caps
  - `machines.ts` and `idle.ts`: machines, Chrome, the terminal, and
    idle timers
  - `operator.ts`: what the HTTP routes call
- `apps/orchestrator/src/wakes/`: the wake-up message, the count of
  wake-ups left, the delay and note rules, and setting and cancelling a
  wake-up
- `apps/orchestrator/src/toolbox/wake.ts`: `wake_after` and
  `wake_cancel`
- `apps/orchestrator/src/db/wakes.ts`: the wake-up store
- `apps/orchestrator/src/conversation/projection.ts`: tool-result
  stubbing
- `apps/orchestrator/src/attachments/`: uploads and image hydration
- `apps/web/src/features/agent/chat/`: the Chat tab
