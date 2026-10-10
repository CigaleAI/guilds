# Runs

A **direct run** is a persistent chat with one agent. It stays open
after an assistant reply. It accepts later user messages for as long as
the agent exists.

Creating it without a user message leaves it idle (the composed system
prompt). Creating it with a message starts generation.

A **group-triggered run** is a one-shot delivery of public group
history to one agent. It completes after that generation. It rejects
later user messages until the operator resumes it.

It remains visible so the operator can inspect:

- the exact prompts (including Memory)
- the Group Chat info wake
- the private tool trace

A **schedule-triggered run** is a one-shot wake-up for one agent.

Direct chat, group chat, or the Routine tab creates the schedule with:

- a 5-field UTC `cron` expression or a random `window`
- a one-line `description`
- a short markdown `instruction` stored as `instruction` on the
  schedule row

An agent may have several.

An in-process ticker (every 30 seconds) fires due rows that are not
paused and whose guild has `routines_enabled`. If the agent is busy, a
group-chat delivery included, the next tick retries without advancing
`next_run_at`.

There is no backlog of schedule jobs. The due row stays due.

A failed create (bad prompts, archived agent) advances `next_run_at` to
the next planned wake-up. One broken agent does not tight-loop.

Resume recomputes `next_run_at` from now. Turning a guild's routines
back on does the same for that guild's unpaused schedules that are
already due.

The run completes after that generation. It rejects later user messages
until the operator resumes it. History lists it as Schedule wake-up.

A **random window** (`wake_window` on the row) has `timezone`,
`start`, `end`, and `max_wakes`. It wakes the agent at random times
every day between `start` and `end` (24-hour `HH:MM`) local time in
`timezone`. `timezone` is an IANA name that follows daylight saving.

`end` before `start` spans midnight. `start` and `end` must differ.
`max_wakes` must leave at least 5 minutes per wake-up.

Wake-ups are planned one at a time
(`apps/orchestrator/src/schedules/window.ts`):

- The first wake-up of a window lands uniformly in its first slot,
  `(end - start) / max_wakes`.
- After each fire inside a window, the mean gap is the time left in the
  window divided by the wake-ups left (`max_wakes - window_fires`). The
  next gap is drawn uniformly between 0.5× and 1.5× that mean, never
  under 5 minutes.
- A gap that reaches the window's end, or a spent window, moves to the
  first slot of the next window.

`window_fires` counts fires in the window that holds `next_run_at`. A
late fire outside any window does not count. Create, resume, and a
guild re-enable start the count at 0.

`max_wakes` is a ceiling. A day gets at most `max_wakes` wake-ups and
usually one or two fewer.

Code:

- `apps/orchestrator/src/generation/` (busy lock, `fireDueSchedules`,
  `deliverScheduleRun`, `deliverGroupRun`)
- `apps/orchestrator/src/schedules/` (cron, random window, instruction)
- `apps/orchestrator/src/groupchat/` (cursor queue)

While an agent is generating:

- a direct message is HTTP 409
- group delivery waits for the lock
- a due schedule skips the tick and stays due

A **generation** is one execution of the agent loop. The user (or
group) message that starts it and every row the loop appends share a
generation number, starting at 1. The opening system row does not.

At creation a direct run begins:

```text
0  system   composed prompt (<guidelines>, <task>, <state>, <memory>)
1  user     submitted message, if any
```

Creating it without a user message leaves that system row. Later user
messages append operator text only.

A user row may also carry `metadata.attachments`:
`{ id, filename, mime, kind }` refs uploaded through
`POST /api/attachments`. The stored payload stays `{ role, content }`.
An empty caption is allowed when images are present.

At provider-request time the orchestrator hydrates image refs into
Chat Completions `image_url` parts:

- a 15-minute signed URL
- a data URL when the store cannot sign
- always a data URL for Kimi. Kimi refuses public image URLs

Token counting adds 1600 tokens per image. It does not encode those
URLs.

Memory stays the opening `<memory>` section. The opening State
snapshot keeps:

- group chat
- notes
- scripts
- environment
- the UTC clock

The agent refreshes catalogs with tools.

A group-triggered run uses the same composed system row, then one
Group Chat info user message (`latestMessage`, `youWereTagged`) for
the snapshot sequence.

History through that snapshot is already in State as the last 10
public rows (`group_chat_history`). When `TYPESAFE_API_KEY` is set,
Jev picks 10 rows from the last 40 (fallback: last 10).

When Memory is on they must call `memory_write` once. If generation
returns without that row the orchestrator inserts a reminder and
grants one extra step. A wake that still does not write completes with
`memory_skipped: true`.

When Memory is off there is no reminder.

A schedule-triggered run uses the same composed system row, then one
Schedule wake-up user message:

```text
Schedule wake-up: {
  id, cron | window, instruction, previous_run_at
}
```

`instruction` is the markdown on that schedule row. `previous_run_at`
is the schedule's `last_run_at` at the moment it fires (null on the
first wake). It is the cursor a routine passes as `since` to
`record_list`.

The run row records the routine on `runs.schedule_id`. Its metadata
carries `instruction_hash`, the hash of the instruction it fired with.
Run views expose both on schedule runs.

A routine's runs can be listed. A run that fired with an older
instruction can be told apart. Schedule runs are one-shot.

When Memory is on they must call `memory_write` the same way as a
group-triggered run.

The ordered stored payloads are the complete history. The model client
receives a projection of those payloads (tool-result stubbing, below).

Metadata sits beside the payload and is never sent to the model:

- usage
- cost
- latency
- tool timings
- generation number
- source
- the model's reasoning text and provider reasoning blocks when it
  streamed any

Each assistant row with usage also stores `messages.cost_usd`. That
column is NULL on system, user, and tool rows.

It increments rollup counters for:

- that agent
- its guild
- its organisation
- the instance as a whole (`global`)
- `org_monthly_usage`

Those counters are the Usage pages. The per-row column is for later
accounting queries. What a run costs whom is the model credentials'
concern ([Extension points](../architecture/extension-points.md)):
core calls their `onUsage` once per completion and keeps no spend
gate.

Deleting an agent or guild drops that scope's counter row and its
messages. Parent totals stay.

Tool-result metadata includes the provider tool-call id for
correlation. The message row already owns the run id. Agent, guild,
and organisation ids resolve through the run rather than being copied
into metadata.

Durable file mutations record the same run and tool-call identity in
`file_changes`.

## Exactness

1. Payloads become immutable when inserted.
2. Rows are append-only; sequence numbers never change.
3. Every model call receives a recorded projection of the current
   payloads in sequence order. Tool-result stubbing (below) is the
   projection; user and assistant text are unchanged. Replay
   `projection_policy_version` and `keep_tool_result_generations` from
   the run snapshot on the stored rows to rebuild what was sent.
4. An assistant row is the response to that projection of the prefix
   preceding it.
5. Model parameters and tool schemas stay fixed for the run.
6. Automatic provider retries are off.
7. Tool results enter history only after the output pipeline.

The run stores an immutable snapshot.

Model settings include:

- `max_tool_calls`
- `max_input_tokens`
- `keep_tool_result_generations`
- `projection_policy_version`
- `thinking_level`

Flags: `browser`, `coding`, `cli`, `scripting`, and `memory`.

The complete tool schemas offered to the model:

- enabled native bindings: note, record, memory when `memory` is true,
  and script tools when `scripting` is true
- `secret_store`
- `secret_request` on direct runs
- the six schedule tools on direct and group-chat runs
- `group_post` when that binding is on
- the eight browser tools when `browser` is true
- the code tools when `coding` is true
- enabled MCP schemas, including curated lists from the CoinGecko,
  Alchemy, X, TwitterAPI.io, Qonto, and DexPaprika adapters, and a
  registry connector's manifest

The snapshot also stores:

- the agent's secrets as `[{id, name, description}]`
- a slim `mcp` list of
  `{connection_id, server_id, slug, tools: [{name, remote_name}]}`

Model settings and tool schemas stay fixed for the run.

Each generation re-resolves the agent's secrets (organisation-wide,
granted to its guild, granted to it). It writes them onto the snapshot
and decrypts those values. A later grant, removal, or rotation reaches
an existing direct run
([Secrets and access](secrets-and-access.md)).

A deleted, missing, or undecryptable secret is a generation-start
error. Changing agent configuration or tool bindings affects new runs
only.

## Generation

One generation at a time per agent. The agent has one machine.
Concurrent requests to the same agent return a conflict.

Different agents generate together. They keep separate:

- histories
- artifacts
- sandbox directories
- locks

The loop ensures the agent sandbox exists. When its stored
`workspace_mib` is above the agent's `max_workspace_mib`, or the host
`WORKSPACE_MAX_MIB` if that is lower, it measures the workspace again.
It fails the generation at start with `workspace.full` if it is still
over.

After the generation it measures and stores the size.

It loads every payload in order and repeats up to `max_steps`:

1. call the model
2. append the assistant row
3. if there are tool calls, execute them sequentially, filter each
   result, and append one tool message

A final assistant without tool calls ends the generation. If the last
allowed call still has tool calls, those tools still run, then the
loop stops and records an operational error.

The run stays active (direct, or any kind the operator has resumed) or
becomes completed (group or schedule).

The snapshotted `max_tool_calls` (default 50) counts every tool result
on that run. State carries that starting budget.

After the platform cap, each stored tool result ends with
`remaining_tool_calls: N`, the count left after that result. When N is
8 or fewer, a wrap-up line sits above that trailer: write durable
findings and finish with text; a batch costs one call each.

When the count reaches the cap, the current batch still finishes. Then
the run records `generation.max_tool_calls` and becomes completed.

Later user messages are refused. Resume is refused. Start a new run.

Before each model call the orchestrator projects the stored history
(tool-result stubbing, below). Then it counts that prompt (messages
and offered tools) with `js-tiktoken` against `max_input_tokens`
(default 100000).

Above that cap it does not call the model. It records
`generation.max_input_tokens` with a message to start a new run, and
completes the run. Resume is refused.

### Tool-result stubbing

The stored transcript is unchanged. For the provider request only,
large tool **results** outside the keep window are replaced with a
short stub:

- `tool_name`
- `source_seq`
- `path` and `range` when the metadata has them
- a hint to call the same tool again

Assistant `tool_calls` stay. User and assistant text stay.

A **generation** is one user turn and the tool loop that follows, not a
run in a chain. `keep_tool_result_generations` (default 1, snapshotted)
is how many generations stay live, including the current one:

- `1`: stub every previous generation (the last finished user turn and
  earlier). This is the default.
- `2`: also keep the previous user turn's tool results; stub older.

A result under 2048 bytes is never stubbed. When the projected prompt
is still over `max_input_tokens`, the oldest live results above that
floor are stubbed until four remain or the count fits. Policy version
`1`.

Studio and Builder use the same projector with a keep of 1 and no size
floor (`apps/orchestrator/src/conversation/projection.ts`).

### Run chains

A run whose snapshot has `coding` on continues in a new run when its
projected prompt grows. History stays append-only. Each run's rows
remain the store the projection was built from.

Runs without `coding` keep the cap above.

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
4. The run records `metadata.continued_by_run_id` and completes; the
   new run records `metadata.chain` (`root_run_id`, `index` from 2,
   `previous_run_id`). The agent's generation lock passes to the new
   run without being released, the first run's subscribers get
   `run.continued` with the new `run_id`, and the new run generates.

A schedule continuation keeps the routine's `schedule_id` and
`instruction_hash`. A group continuation keeps the delivery's
`group_chat_through_seq` and completes itself.

The group delivery waits for the whole chain. Then it completes the
chain's first run and advances the agent's cursor. The Memory step of
group and schedule runs happens in the last run only.

A chain holds at most 5 runs. The fifth run, at the hand-off point,
records `generation.max_chain` and completes.

If the hand-off request itself puts the prompt above
`max_input_tokens`, the run records `generation.max_input_tokens` and
completes without a continuation.

A user message or Resume on a run with `continued_by_run_id` is 409.
It names the latest run of the chain.

Cancelling the running continuation stops the chain. The run payload
carries `chain` and `continued_by_run_id` when they are set.

Committed assistant and tool rows are published over SSE after the
database transaction. Reasoning and token deltas may stream first.
History is the committed row.

On reconnect the UI reloads ordered history, then consumes new events.

Cancellation stops the current model call or tool command. It records
`generation.cancelled` and leaves a direct run active. The sandbox
stays.

If an assistant row with tool calls is already in history,
cancellation or restart appends `ERROR: execution interrupted` for
every unresolved call so the next model request is valid.

On orchestrator startup, unresolved tool calls in active runs get those
interruption results. Startup does not replay a model call.

For an interrupted group-triggered run that the operator has not
resumed, startup also:

- marks it completed
- advances the agent's group cursor through the stored snapshot
- resumes dispatch

An interrupted schedule-triggered run that the operator has not
resumed is marked completed. A resumed run stays active.

`POST /api/runs/:id/resume` reopens a completed run that is not
archived, has no continuation, and did not hit
`generation.max_tool_calls`, `generation.max_input_tokens`, or
`generation.max_chain`. It sets `status` back to `active` and stores
`metadata.resumed_at`.

The same transcript then accepts later user messages. A group or
schedule run still rejects messages until that field is set. After it
is set, a schedule generation leaves the run active.

A provider failure before any assistant row creates no message. It
appends to `runs.errors` and to structured logs.

Logs carry:

- run
- guild
- agent
- operation
- traceback

They redact known secret values. They omit prompts, payloads, and tool
results.

## Sandbox

The sandbox is created:

- on the agent's first generation
- when the operator opens the Browser tab on a `browser: true` agent
- when the operator starts the CLI tab

It is one of two boxes, after the agent's browser and coding flags:

- a lite sandbox (neither flag) runs the lite image
  (`SANDBOX_IMAGE_LITE`) with 0.5 CPU and 256Mi memory
- a standard sandbox (either flag) runs the standard image
  (`SANDBOX_IMAGE`) with 2 CPU and 4Gi

The sandbox directory is mounted at `/home/agent`. Every secret that
reaches the agent is injected as an environment variable named after
the secret
([Secrets and access](secrets-and-access.md#what-reaches-a-sandbox)).

A coding sandbox also gets `HOME=/home/agent`. On a standard box that
tree includes `/home/agent/.browser` for Chromium profile state. A lite
box's tree has no browser profile.

A new run is a new conversation on the same machine. The container may
already have been stopped. Commands run as root in the container, for
every agent.

At generation start the orchestrator compares:

- a keyed fingerprint of the resolved environment with sandbox
  metadata
- whether the running sandbox was created with the run snapshot's
  browser and coding flags (its `box` follows them)
- whether it was created from the image its box calls for
  (`SANDBOX_IMAGE` or `SANDBOX_IMAGE_LITE`)

The helpers its tools call are part of that image. A missing or
mismatched sandbox is recreated over the same sandbox directory with
current values. An agent whose box changed, or whose image changed
under it, gets the other box's guest at its next ensure.

Browser sandboxes start Google Chrome under TigerVNC at a locked
1280×720 with:

- `--no-sandbox`
- `--user-data-dir=/home/agent/.browser`
- CDP on `127.0.0.1:9222`
- a noVNC view on port 6080

Chrome language is the agent's `browser_language` (default `en-US`).
Timezone is inferred from the sandbox's public IP and cached for the
container lifetime.

The orchestrator proxies that view into the agent's Browser tab. The
tab embeds noVNC, scales the framebuffer to the pane, and keeps the
remote desktop size.

A clipboard strip pastes host clipboard into the sandbox page and
copies the remote selection back to the host. Playwright in the image
attaches to that Chrome over CDP.

The orchestrator records:

- the agent id
- a 63-character environment fingerprint
- a browser flag
- a coding flag
- the box those flags call for (`kind`)
- the browser language when browser is on
- a fingerprint of the image reference
- one label-safe key per snapshotted secret id

If several running sandboxes carry one agent id, it keeps the earliest
matching instance and destroys the others.

Toggling browser access or coding (and so the box), or changing the
browser language while browser is on, destroys an idle sandbox. The
next ensure recreates it with the new image, resources, environment,
and entrypoint.

The CLI tab brings the sandbox up as the agent's configuration says.

- A browser or coding agent wakes its larger sandbox.
- A generating agent's running sandbox is used as is.

It runs `agent-cli-start` in it. The helper starts ttyd on port 7681
with bash in `/home/agent`, or finds it already answering, and prints
the secret path segment it serves under, random per container.

ttyd answers only under `/t/<secret>` and returns 404 elsewhere, for
the WebSocket too.

The orchestrator proxies ttyd's page and WebSocket at
`/api/agents/:id/cli/tty/*` and prepends that segment to every
upstream path. The sandbox host's proxy drops `Authorization`, so a
header cannot carry it. The port refuses anything that did not come
through the proxy.

The shell runs as root and inherits the container environment, secret
values included.

Changing a secret's value, name, or description, creating or deleting
a secret, or changing who gets it:

- re-syncs the active run snapshots of the agents it reaches or
  reached
- destroys their idle sandboxes

A currently generating agent finishes with its existing environment.
Its sandbox is destroyed before the agent lock is released. Its next
generation recreates the sandbox with the current secrets and values.

A `secret_store` call takes the same path. The stored variable is in
the agent's environment from its next generation.

After a generation ends, or after the Browser or CLI tab brings the
sandbox up, an idle timer of 5 minutes starts.

A new generation cancels that timer. Operator input on a proxied
Browser or CLI view restarts it, at most once every 30 seconds.

When the timer fires, the orchestrator destroys the sandbox and leaves
the sandbox directory in place. On orchestrator startup, every running
agent sandbox that is not generating gets the same timer. The next
generation recreates the sandbox through the path above.

Consequences:

- two runs of the same agent share the sandbox directory and, while a
  sandbox is up, its processes
- agents in one guild do not
- only one generation runs at a time for an agent
- files under `/home/agent`, including `.browser`, survive recreation
- container-local packages and live process state end when the
  sandbox stops

A coding agent runs commands with the `shell` tool
([Tools and connectors](tools-and-connectors.md#code-tools)).

For every other agent, reusable Python is the one way to execute code:
an agent-level `script` artifact. A run snapshots source and
materialises `/home/agent/scripts/<name>.py`.

`script_create` / `script_run` are the tools. For an agent without
`coding`, `script_run` is the one path that executes in the sandbox.
Turning it off removes code execution.

A coding agent keeps its scripts for reusable code. Turning
`script_run` off does not remove its `shell`. Each script has a
required description.

The agent's secrets appear in the State snapshot as name plus
description. The value stays in the sandbox environment.

MCP token payloads never enter that environment. They only join run
redaction.

## Repositories

At each generation of a coding agent, after the sandbox is up and the
workspace check passes, the orchestrator prepares the guild's
repositories:

1. **Tokens.** For each GitHub connection the guild's repositories use,
   it mints an installation access token limited to those repositories
   with contents and pull requests write
   ([Tools and connectors](tools-and-connectors.md#github)). It writes
   every token through the sandbox file API to
   `/run/guilds/git-tokens.json`, outside the workspace, and adds each
   to the generation's redaction set. A disconnected connection, GitHub
   refusing the installation, or an installation that no longer reaches
   a repository (named in the error) is the generation-start error
   `repository.token`.
2. **Identity and clone.** `guilds-code` writes the agent's git identity
   into its global git configuration (the name is the agent's name, the
   email the guild's `git_author_email` when set, otherwise
   `<agent id>@agents.guilds.run`) and runs `git clone` for each guild
   repository missing from `/home/agent/repos/`, waiting up to 600
   seconds for each. A clone already there whose `origin` names another
   URL on the same host, as after a rename, is pointed at the
   repository's current URL. A failed clone is the generation-start
   error `repository.clone`; when git wanted credentials, the error
   says whether the repository had no GitHub login (cloned anonymously)
   or had a token git left unused. After that the agent fetches,
   branches, commits, and pushes itself. The orchestrator never runs
   git in its own process: a repository's hooks and configuration are
   agent-controlled.
3. **Start checkpoint** (below).

The run's working directory starts in the repository when the guild has
exactly one. Before each `shell` command, a token within 10 minutes of
expiry is replaced and rewritten.

State carries `repositories` (`[{ name, path, default_branch }]`) on a
coding agent's runs. Live git state is not in State.

**Checkpoints.** At a run's first generation, and again at the end of
every generation, `guilds-code` snapshots every working tree under
`/home/agent/repos/`. Uncommitted and untracked (not ignored) changes
are included. Each snapshot is a commit built through a temporary
index and recorded at `refs/guild/runs/<run id>/start` (once) or
`…/end` (each time), without touching the index or the current branch.

These refs are local and never pushed. The run stores `metadata.repos`:
`[{ name, branch, head_sha, start_sha, end_sha, files_changed, insertions, deletions }]`,
the diffstat from start to end. The run payload carries it as `repos`.

A generation cut short by an orchestrator restart has no end
checkpoint. The working tree is intact. The change is attributed to
the run that checkpoints next.

```text
GET /api/runs/:id/changes                     diffstat per repository
GET /api/runs/:id/changes/:repository/diff    start..end, at most 256 KiB
```

The diff runs `git diff` in the agent's sandbox, waking it as the CLI
tab does. It is redacted with the agent's secret values. A repository
the run did not record is 404.

**Commit trailers.** A `prepare-commit-msg` hook in the image's git
template adds `Guild-Run: <run id>` and `Guild-Agent: <agent id>` to a
commit made through `shell`. `shell` sets `GUILD_RUN_ID` and
`GUILD_AGENT_ID`.

Clones and `git init` take it from the template. A repository that
sets its own hooks path skips it.

The checkpoint is the authoritative link. The trailer is the convenient
one.

## Scripts

PostgreSQL is canonical for an agent's scripts. Rows live in
`artifacts` with `kind` `script` at agent level (`path` `scripts`,
`key` the script name).

`(owner, name)` is unique. `parameters` is either null or a validated
JSON Schema object.

The agent's `max_scripts` setting (default 10) caps how many names the
catalog may hold. `script_create` and pane writes of a new name past
that count are refused. A replace of an existing name is not.

`DELETE /api/agents/:id/scripts` and the Settings and Scripts panes
remove every row. The Scripts pane and `script_list` / `script_read`
read the live catalog. `script_create` writes a row and `script_delete`
deletes it.

Live catalog edits affect new runs. Listing during an existing run can
show a newer body than that run will execute.

At run creation the snapshot records every catalog row as
`{id, name, description, parameters, source, source_hash}`. First-class
tool schemas in that snapshot come from rows whose `parameters` are
set. Later generations of the same run keep that list.

`RunSandboxes.ensure` materialises `/home/agent/scripts` from the **run
snapshot**, not from the live catalog
(`apps/orchestrator/src/scripts/materialise.ts`):

1. write each snapshotted source to a sibling temp file through the
   sandbox file API, delete an existing `/home/agent/scripts/<name>.py`
   if present, then move the temp file onto that path (OpenSandbox
   `move_files` refuses to overwrite, and a direct upload truncates in
   place);
2. write live catalog rows whose names are absent from the snapshot the
   same way, so a script created during this run remains callable
   through `script_run`;
3. remove managed files whose names are in neither set.

A snapshotted name always executes the snapshotted source, even when
the live row has since changed. `script_delete` during this run drops
that name from the snapshot and removes `/home/agent/scripts/<name>.py`.
`script_run` and its first-class tool then stop.

A name created after run creation has no frozen schema. It is invoked
only through `script_run`, using the live source.

`script_create` and pane writes update PostgreSQL immediately. They
write through to a running sandbox only for names absent from the
current run's snapshot.

When `script_create` replaces a snapshotted name, its result tells the
model that this run keeps the snapshotted version and the new one runs
from the next run.

A script with `parameters = null` is reusable code invoked through
`script_run(name, arguments?)`. A script with a parameter schema is
also offered to the model as a first-class tool under its script name
on **new** runs. Creation rejects names that collide with native or
connected tool names.

Both paths run the file through `guilds-script-run`. The arguments
(the optional `arguments` object of `script_run`, or the first-class
tool's arguments) are serialised as JSON into `GUILDS_SCRIPT_ARGS`.

The launcher writes that value to the script's stdin, `{}` when
`script_run` has no `arguments`. Stdout and stderr pass through the
standard tool output pipeline.
