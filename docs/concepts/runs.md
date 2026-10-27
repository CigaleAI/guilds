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
and a due routine waits for a later tick. Different agents generate at
the same time, on one machine or on several.

### Generations

A generation is one turn of the agent loop:

1. call the model;
2. store its reply;
3. if it asked for tools, run them one by one and store each result;
4. repeat, until the model replies with text alone.

Every row a generation adds carries its generation number, starting at
1. The opening system prompt has none.

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
settings, its switches, and the exact tools it was offered. Changing
the agent later affects new runs only. Secrets are the exception: they
are looked up again at every generation, so a new grant reaches an
open chat ([Secrets](secrets.md)).

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

A run that hit its tool-call or input-token limit cannot be resumed.
Start a new one.

A run also completes when its model cannot be called: the model's
provider is not connected for the organisation, or an extension refuses
the model credentials or blocks the organisation. That run can be
resumed once the cause is fixed.

### Tool-result stubbing

Tool results can be large: a web page, a long file. Old ones rarely
matter. Before each model call, large tool results from earlier turns
are replaced by a short stub, in what is sent only. The stub says
which tool produced the result and how to fetch it again. The stored
run keeps the full results. By default only the current turn keeps
its full tool results. The agent's settings can keep more.

### Run chains

A coding agent's runs can grow long. Instead of stopping at the input
limit, a coding run hands off: it asks the agent for a summary, then
continues in a fresh run that starts from that summary.

```mermaid
flowchart LR
    r1["Run 1<br/>prompt reaches 70%<br/>of max input tokens"] -- "hand-off summary" --> r2["Run 2<br/>fresh prompt +<br/>Continuation"]
    r2 -- "hand-off summary" --> r3["Run 3"]
    r3 -.-> r5["… at most 5 runs"]
```

The chain keeps the kind, the routine, or the group delivery of its
first run. It holds at most five runs.

### Cancel, interrupt, resume

- **Cancel** stops the current model call or tool command. A direct
  run stays open.
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
  generating.
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
accepts images, it adds JPEG, PNG, GIF, or WebP images, at most four,
10 MiB each. A message may be images with no caption. When the model
does not accept images, or is not among the organisation's chosen
models, the paperclip is disabled and a tooltip says so. The
transcript shows the images on the operator's bubble.

An ended run shows a banner under the transcript:

- **This session has ended**, with **Resume**, when it can be resumed.
  The same transcript reopens and the next message continues it.
- **This session reached its limit**, with **New session**, after a
  tool-call, input-token, or chain cap.
- **This session continued in a new run**, with **Open it**, after a
  hand-off. A run that is open while it continues switches to the new
  run.

## Rules and limits

| Rule | Value or behaviour |
| --- | --- |
| Generations at a time | one per agent; a second direct message is 409 |
| Max steps | 30 by default (200 for a new coding agent) |
| Max tool calls | 50 by default (200 for a new coding agent); counts every tool result in the run |
| Wrap-up warning | when 8 tool calls or fewer are left |
| Max input tokens | 100000 by default; counted with `js-tiktoken` |
| Full tool results kept | the current turn only, by default |
| Results never stubbed | under 2048 bytes |
| Coding run hand-off | at 70% of max input tokens |
| Runs in a chain | at most 5 |
| Images per message | at most 4, 10 MiB each, JPEG, PNG, GIF, or WebP |
| Image cost in token counting | 1600 tokens each |
| One-shot runs | refuse messages until resumed |
| Resume | refused after a tool-call, input-token, or chain cap, and on a continued run |
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
user clears the matching link. A run continued from a chain keeps its
cause in `metadata.chain` instead ([Chain rules](#chain-rules)).
Deleting the agent deletes its runs. The app labels `group` **Group
chat** and `schedule` **Routine**.

A direct run, or any run the operator has resumed, stays `active`
after its generation. A group or schedule run becomes `completed`. Any
run becomes `completed` when it ends on a limit, a hand-off, or a
model it cannot call ([Generation](#generation)).

### Opening rows

Row 0 is the composed system prompt. A direct run created with a
message adds it as row 1. A group run adds one Group Chat info user
message, and a schedule run one Schedule wake-up user message
([System prompt](system-prompt.md#the-runs-own-messages)). Later user
messages append operator text only.

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

Token counting adds 1600 tokens per image. It does not encode those
URLs.

`POST /api/attachments` takes the file bytes as the body, with the
name in `X-Filename`. It returns 201 with `id`, `filename`, `mime`,
`bytes`, `kind`, `url`, and `created_at`. It refuses an empty file or
one over 10 MiB (422). Sending refs refuses a model that does not take
attachments, more than four refs, or a repeated ref (422), and an
unknown ref (404). `GET /api/attachments/:id` serves the bytes to the
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
  streamed any.

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
5. Model parameters and tool schemas stay fixed for the run.
6. Automatic provider retries are off.
7. Tool results enter history only after the output pipeline.

### Snapshot

The run stores an immutable snapshot.

Model settings include `max_tool_calls`, `max_input_tokens`,
`keep_tool_result_generations`, `projection_policy_version`, and
`thinking_level`.

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
- the six schedule tools, when bound, on direct and group chat runs;
- `group_post` when that binding is on;
- the eight browser tools when `browser` is true;
- the five code tools when `coding` is true;
- enabled MCP schemas, including curated lists from the CoinGecko,
  Alchemy, X, TwitterAPI.io, Qonto, and DexPaprika adapters, and a
  registry connector's manifest.

The snapshot also stores the agent's secrets as `[{id, name,
description}]` and a slim `mcp` list of `{connection_id, server_id,
slug, tools: [{name, remote_name}]}`.

Each generation re-resolves the agent's secrets (organisation-wide,
granted to its guild, granted to it), writes them onto the snapshot,
and decrypts their values. A later grant, removal, or rotation reaches
an existing direct run. A deleted, missing, or undecryptable secret is
a generation-start error.

### Generation

At start, the loop ensures the agent's machine is up and checks the
disk caps. A home or machine over its cap fails the generation with
`workspace.full` ([Agent home](agent-home.md#the-disk-cap)). After the
generation it measures and stores both sizes. A coding run is checked
further before the model is called: harness picked, guild
repositories, harness installed and credentialed, repositories
prepared ([Coding agents](coding/index.md)).

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

Resume is refused after `generation.max_tool_calls`,
`generation.max_input_tokens`, and `generation.max_chain`, and allowed
after the three above.

### Stubbing rules

For the provider request only, large tool **results** outside the keep
window are replaced with a short stub:

- `tool_name`;
- `source_seq`;
- `path` and `range` when the metadata has them;
- a hint to call the same tool again.

Assistant `tool_calls` stay. User and assistant text stay.

Here a generation is one user turn and the tool loop that follows, not
a run in a chain. `keep_tool_result_generations` (default 1,
snapshotted) is how many generations stay live, including the current
one:

- `1`: stub every previous generation. This is the default.
- `2`: also keep the previous user turn's tool results; stub older.

A result under 2048 bytes is never stubbed. When the projected prompt
is still over `max_input_tokens`, the oldest live results above that
floor are stubbed until four remain or the count fits. Policy version
`1`.

### Chain rules

A run whose snapshot has `coding` on continues in a new run when its
projected prompt grows. History stays append-only; each run's rows
are the store the projection was built from. Runs without `coding`
keep the input cap above.

1. When the count before a model call reaches 70% of
   `max_input_tokens`, the orchestrator appends a hand-off request: a
   user row with `metadata.source: "handoff"` asking for text only, no
   tool calls, giving the goal, what is done, what is decided, what
   remains, and the files that matter as `path:line`.
2. It makes one model call. The offered tools stay as snapshotted, so
   the reply may still call one: each call gets the result
   `ERROR: a hand-off was requested; reply with text only` and is not
   run.
3. It creates the next run for the same agent, of the same kind, from
   a freshly prepared snapshot and system prompt, with one user message
   (`metadata.source: "continuation"`):
   `Continuation: { "previous_run_id": ..., "handoff": ... }`. A reply
   with no text gives `"handoff": null` and a note to work from Memory,
   notes, and the working tree.
4. The run records `metadata.continued_by_run_id` and completes. The
   new run records `metadata.chain` (`root_run_id`, `index` from 2,
   `previous_run_id`). The agent's generation lock passes to the new
   run without being released, the first run's subscribers get
   `run.continued` with the new `run_id`, and the new run generates.

A schedule continuation keeps the routine's `schedule_id` and
`instruction_hash`. A group continuation keeps the delivery's
`group_chat_through_seq` and completes itself. The group delivery
waits for the whole chain, then completes the chain's first run and
advances the agent's cursor.

A chain holds at most 5 runs. The fifth run, at the hand-off point,
records `generation.max_chain` and completes. If the hand-off request
itself puts the prompt above `max_input_tokens`, the run records
`generation.max_input_tokens` and completes without a continuation.

A user message or Resume on a run with `continued_by_run_id` is 409; it
names the latest run of the chain. Cancelling the running continuation
stops the chain. The run payload carries `chain` and
`continued_by_run_id` when they are set.

### Streaming

Committed assistant and tool rows are published over SSE after the
database transaction. Reasoning and token deltas may stream first, and
a running `code_task` streams its progress lines as `tool.progress`.
History is the committed row. On reconnect the UI reloads ordered
history, then consumes new events.

### Cancellation and restart

Cancellation stops the current model call or tool command. It records
`generation.cancelled` and leaves a direct run active. The machine
stays.

If an assistant row with tool calls is already in history,
cancellation or restart appends `ERROR: execution interrupted` for
every unresolved call, so the next model request is valid.

On orchestrator startup, unresolved tool calls in active runs get
those interruption results. Startup does not replay a model call. An
unresolved `code_task` is stopped and checkpointed first
([Code tools](coding/code-tools.md)).

For an interrupted group-triggered run that the operator has not
resumed, startup also marks it completed, advances the agent's group
cursor through the stored snapshot, and resumes dispatch. An
interrupted schedule-triggered run that the operator has not resumed
is marked completed. A resumed run stays active.

### Resume

`POST /api/runs/:id/resume` reopens a completed run that has no
continuation and did not hit
`generation.max_tool_calls`, `generation.max_input_tokens`, or
`generation.max_chain`. It sets `status` back to `active` and stores
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
| `POST /api/agents/:id/runs` | creates a direct run, with optional `message` and attachment ids | 201 idle, 202 generating | 422 empty message; 409 agent generating, guild being deleted |
| `GET /api/runs/:id` | the run | 200 | 404 |
| `GET /api/runs/:id/messages` | its rows in order | 200 | 404 |
| `POST /api/runs/:id/messages` | appends `content`, with optional attachment ids, and starts a generation | 202 | 422 empty; 409 one-shot not resumed, continued, ended, or generating |
| `POST /api/runs/:id/resume` | reopens a completed run | 200 | 409 continued or capped |
| `POST /api/runs/:id/cancel` | cancels the current generation | 202, or 204 with nothing to cancel | |
| `GET /api/runs/:id/stream` | the run's SSE stream | 200 | |

### Code

- `apps/orchestrator/src/generation/`: the busy lock, the loop,
  `deliverGroupRun`, `deliverScheduleRun`, `chain.ts`
- `apps/orchestrator/src/conversation/projection.ts`: tool-result
  stubbing
- `apps/orchestrator/src/attachments/`: uploads and image hydration
- `apps/web/src/features/agent/chat/`: the Chat tab
