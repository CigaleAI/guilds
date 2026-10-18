# Code tasks

A code task is one call of the `code_task` tool: one turn of the
[harness](harnesses.md) of a [coding agent](index.md). The agent writes
a brief. The harness reads it, works in one of the guild's
[repositories](repositories.md), and ends with a final message. The
agent then checks the work with the other [code tools](code-tools.md).

A code task may commit on the current branch. It never pushes and
never opens pull requests: the agent does both itself.

## When you use it

The agent calls `code_task`, not the operator. The operator watches
each task in the chat, with its live progress, its result, and the
diff it made ([In the app](#in-the-app)).

## How it works

### One turn of the harness

The agent passes a self-contained `brief`, because the harness sees
nothing of the conversation, notes, or Memory. `notes` appends notes or
records to the brief.

The call blocks the agent until the harness exits, 30 minutes at most
by default. Meanwhile its progress streams to the chat. The result
gives how the turn ended, the files it changed, and the harness's final
message.

Around the turn, the platform takes a start and an end checkpoint of
the repository, so the task has its own diff
([Reviewing changes](reviewing-changes.md)).

### Questions and sessions

A question from the harness is not an error. It is the final message.
The agent answers it by calling `code_task` again with the
`session_id` from the result, which resumes the same session. A session
lives in the agent's home, so a later run can resume it too when the
agent kept the id, in Memory or a note.

### When a task is cut short

A timeout, a cancel, or a harness that stops answering stops the
harness. The working tree keeps whatever it wrote, and the result says
to resume the session to continue. A machine restart or an orchestrator
restart ends the task `interrupted` ([Lifecycle](#lifecycle)).

## In the app

A code task is its own block in its step on the **Chat** tab, shown
even while the step is folded. Its step carries the harness's logo on
the rail in place of the dot: the harness its result names, else the
agent's harness. The block reads:

- the harness's name, "coding task", and its status: **Running…**,
  **Done**, **Failed**, or how it ended otherwise, such as **Timed
  out**; a **wrote** tag; and its run time;
- the brief it was given, clamped to two lines;
- its repository and its diffstat;
- the first line of its error, when it failed.

While the task runs, the logo and the status pulse, and its latest six
progress lines show under the brief. Progress lines are live only. They
stream while the run view is open and are not kept, so a reload shows
the block without them until the result lands.

Opening the block shows the views every tool call has
([Code tools](code-tools.md#in-the-app)), plus:

| View | Shows |
| --- | --- |
| **Result** | Its progress while it runs. Once it ends, the result without its closing `log:` line |
| **Diff** | The change of this one turn, once it has an end checkpoint ([Reviewing changes](reviewing-changes.md#in-the-app)) |
| **Log** | The kept harness log, once the result names it: **Steps**, each event as a progress line, or **JSON**, the raw events |
| **Metadata** | **Status**, **Harness**, **Repository**, **Session**, **Changes**, **Checkpoints** (start → end, as short commit ids), and **Harness log**, whose path opens **Log** |

A running task opens on **Result**. **Log** reads the log from the
agent's machine, waking it. "Loading the log from the agent's machine…"
shows while it loads. "Couldn't load the harness log" shows with the
reason when it cannot be read, such as a log already pruned from the
agent's home.

## Rules and limits

| Rule | Value or behaviour |
| --- | --- |
| Timeout | 30 minutes by default, 1 to 60 |
| Notes | At most 64 KiB together; a note past the cap is named, not included |
| Changed files listed | At most 30 |
| One harness at a time | Tool calls in a generation run in sequence |
| Budget | One tool call against `max_tool_calls` |
| Poll | Every 3 seconds; three failed polls in a row stop the harness |
| Progress | At most 60 lines per poll, each cut at 240 characters; the app keeps a call's latest 200 |
| `session_id` | Letters, digits, and `_ . : -`, at most 200 characters |
| Logs | Kept for the agent's 20 most recent runs |

## Reference

### Arguments

| Argument | Meaning |
| --- | --- |
| `brief` | Required. The whole task, self-contained |
| `repo` | Repository name under `repos/`. Optional when the guild has one |
| `session_id` | Resumes that harness session; `brief` is its next turn |
| `notes` | Display paths of notes or collection records whose content is appended to the brief |
| `timeout_minutes` | Default 30, 1 to 60 |

`code_task` is offered while the agent's `coding` flag is on, like the
other [code tools](code-tools.md).

### Steps

1. **Harness.** No harness picked fails the call with
   `harness.missing`. A harness the box turns off fails it with
   `harness.off` ([Turning a harness off](harnesses.md#turning-a-harness-off)).
2. **Repository.** `repo`, else the guild's only repository. A guild
   without repositories, an unknown name, or a missing `repo` with
   several repositories is an error naming the guild's repositories.
   With `session_id`, the agent passes the repository the session
   started in; the orchestrator does not check the pair
   ([Sessions](#sessions)).
3. **Check.** `guilds-harness check` reports whether the CLI is in the
   image, its version, and the credential it would run on. A CLI
   missing from the image, or no credential, is an error
   ([Credentials and errors](harnesses.md#credentials-and-errors)).
4. **Brief.** A fixed preamble, then the brief under `# Task`, then
   each note under `# <display path>`. The preamble says the harness
   cannot reach the operator, stops and asks in its final message when
   it is blocked or needs a decision, may commit on the current branch,
   never pushes or opens pull requests, and ends with what it changed
   and ran. Notes are read with the agent's access, as `note_get` reads
   them. A record is its JSON view. A collection or a script is
   refused, and a note that does not load fails the call. A note past
   the 64 KiB cap is named on a closing line, not included.
5. **Start checkpoint** of the repository at
   `refs/guild/runs/<run id>/tasks/<call id>/start`.
6. **Start.** A generation cancelled before this step never starts the
   harness. The repository tokens are refreshed first
   ([Tokens](repositories.md#tokens)). `guilds-harness start` removes
   the harness's local configuration
   ([Managed configuration](harnesses.md#managed-configuration)),
   writes the brief to `.runs/<run id>/<call id>.prompt.md` in the home
   (mode 0600), starts the harness detached ([Process](#process)) on
   the run's harness model and effort, and returns at once. The brief
   reaches the CLI on stdin, or for Cursor and Antigravity through the
   prompt file, never on its command line.
7. **Poll** every 3 seconds until the CLI exits, publishing its
   progress ([Progress](#progress)).
8. **Stop.** Once `start` has been sent, every way out of the call
   sends `stop`: a cancel, a timeout, three failed polls in a row, or
   an error. The two exceptions are a poll that saw the CLI exit and a
   poll that found the call's state gone.
9. **Result.** Once the CLI has exited, by itself or after `stop`,
   `guilds-harness result` reads the final message, the session id,
   and how the turn ended from the log, then removes the prompt file
   and the call's state files.
10. **End checkpoint** at `…/tasks/<call id>/end`, with the diffstat
    since the start and the changed files, at most 30.

### Result

```text
<status> · <harness> · <repository> · session <session id> · <duration>
<n> files changed, +<a> −<d>
<path> (+a −d), at most 30, a binary file as (binary)
<detail, when there is one>

<final message>

log: .runs/<run id>/<call id>.harness.jsonl
```

With nothing changed, the second line reads `no files changed`. Past 30
files, a line `… N more files` follows. The session reads `none` when
the harness reported none, and an empty final message reads
`(no final message)`.

The final message gives way so the whole result fits
`CODE_RESULT_MAX_BYTES` ([Code tools](code-tools.md#transport)). The
cut keeps its end, where questions and summaries are, and says how many
bytes it removed from the start.

| Status | When | Detail |
| --- | --- | --- |
| `completed` | The CLI exited 0 and its turn did not end in error | none |
| `failed` | The CLI exited otherwise, or its turn ended in error | A driver that parses none of the CLI's output says so with the CLI's version. A CLI that printed no event, such as one refusing to start without a login, gives the last 5 lines of its stderr, else the harness's error. Otherwise the first line of the harness's error, else its stderr. Else its exit code |
| `timed_out` | `timeout_minutes` passed; the harness got `stop` | `Stopped after N minutes. Resume the session to continue.` |
| `cancelled` | The generation was cancelled; a started harness got `stop` | `Stopped: the generation was cancelled.`, or `The generation was cancelled before the harness started.` |
| `interrupted` | Three polls in a row failed; the harness got `stop` | `The harness stopped answering, so it was stopped. Resume the session to continue.` |
| `interrupted` | A poll found the call's state gone | `The harness's state is gone: the machine restarted or its container was recreated.` |
| `interrupted` | The CLI exited and `result` could not be read | `The harness exited, and its result could not be read.` |

When `stop` reports that the harness did not exit, the detail reads
`The harness did not stop and may still be running; its log is <path>.`
The call's state then stays under `/run/guilds/<agent id>/harness/`
until the container goes.

**Metadata.** Beside the fields every tool call records: `harness`,
`status`, `session_id`, `repository`, `exit_code`, `duration_ms`,
`files_changed`, `insertions`, `deletions`, `start_sha`, `end_sha`,
and `log_path`.

### Process

`guilds-harness` runs one short exec per op, with the same transport as
`guilds-code` ([Transport](code-tools.md#transport)). Each op waits up
to 60 seconds; each task checkpoint up to 300.

| Op | Does |
| --- | --- |
| `check` | Whether the harness's CLI is installed, its version, its credential (`secret`, `login`, or none), and with a login its `account` |
| `start` | Refuses a call id still running, removes the harness's local configuration, writes the prompt file, forks a supervisor in its own session, and returns |
| `poll` | The progress lines after a byte offset into the log, the new offset, the session id once the harness has reported one, and whether the CLI has exited and its log is read through |
| `result` | The final message, the session id, the exit code, whether the turn ended in error, the error, the tail of the CLI's stderr, and the duration |
| `stop` | SIGTERM to the CLI's process group, SIGKILL ten seconds later, then waits for the supervisor to record the exit |
| `log` | A kept log of the run: every event as a progress line, the number of events and of lines that were not JSON, the log's size, and its raw JSONL as whole lines from the start within `max_bytes`; `missing` once the log is gone |

The supervisor starts the CLI in its own process group in
`repos/<repo>`, appends the CLI's raw events to the log, waits for it,
and records its exit code.

A call's state is under `/run/guilds/<agent id>/harness/` (mode 0700),
which goes with the container: `<call id>.json` (what was started),
`.pid` (the CLI's process group), `.exit`, `.session`, and `.stderr`.
`result` removes them and the prompt file once the CLI has exited.

The raw event log, `.runs/<run id>/<call id>.harness.jsonl` in the
agent's home, is stored unredacted like a `shell` log, under the same
retention: `.runs/` keeps the folders of the agent's 20 most recent
runs, so the log of an older run is gone. Reading it back with
`file_read` passes through redaction.

### Harness log

```text
GET /api/runs/:id/tasks/:call_id/log
```

Returns `{ lines, lines_truncated, raw, raw_truncated, bytes, events,
unparsed }` from `guilds-harness log`, run on the agent's machine,
waking it, as the task diff is read:

- `lines` are the log's events as progress lines, at most the first
  2000, each redacted then cut at 240 characters like live progress.
- `raw` is the JSONL, whole lines from the start within 256 KiB;
  `bytes` is the whole log's size.
- Both are redacted with the agent's secret values. The run's GitHub
  tokens are minted per run and are not in that set
  ([SEC-32](../../architecture/security-register.md#sec-32--the-harness-log-the-app-reads-is-redacted-only-with-the-agents-secret-values)).
- A call that is not a `code_task`, or whose result names no harness
  and log, is 404 ("that call has no harness log"), and the machine is
  not woken. A log already pruned from the agent's home is 404 too.

### Harness environment

The harness gets the environment of every command the orchestrator
runs for the agent: `HOME`, `GUILDS_AGENT_HOME`, `PORT`,
`GUILDS_PORTS`, the agent's secrets, and its secret aliases
([Agent home](../agent-home.md)). It also gets `PAGER=cat`,
`GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`, `NO_COLOR=1`, `TERM=dumb`,
`DEBIAN_FRONTEND=noninteractive`, `GUILD_RUN_ID`, and
`GUILD_AGENT_ID`, so commit trailers work
([Reviewing changes](reviewing-changes.md#commit-trailers)).

`GH_TOKEN`, `GITHUB_TOKEN`, and `GUILDS_RUN_DIR` are never in a
harness's environment: the harness does not open pull requests. git
still reads its token through the credential helper
([Tokens](repositories.md#tokens)). Each driver also sets its own
variables and removes those that would move the harness off the
subscription ([Drivers](harnesses.md#drivers)).

### Progress

Each poll reads at most 256 KiB of the log. A progress line is one
normalised event: the harness starting, with its model when it says,
the first line of each assistant message, and each tool use or file
change as `<tool>: <first line of its command, path, pattern, URL,
description, or query>`. A poll returns at most 60 lines, the earlier
ones counted as `… N more steps`.

Each line passes redaction with the run's secret values, GitHub tokens
included, and is then cut at 240 characters. The orchestrator
publishes them on the run's SSE stream as `tool.progress`
(`{ run_id, tool_call_id, lines, session_id }`). Progress is not
stored: the call's result and its log are. The app keeps a call's
latest 200 lines until its result lands.

The orchestrator keeps the running call in the run's
`metadata.harness_task` (`call_id`, `harness`, `repository`,
`session_id`, `log_path`), updated once `poll` reports the session id,
so a call that ends without a result still names its session.

### Sessions

Session ids are the harness's own ([Drivers](harnesses.md#drivers)).
Each harness keeps its session state in the agent's home (`~/.claude`,
`~/.codex`, `~/.cursor`, `~/.gemini`), so a session survives container
recreation and counts against `max_workspace_mib`. A session from an
earlier run can be resumed when the agent kept its id. A resumed
session whose state is gone fails with the harness's error, and the
agent starts a new session with a full brief.

The agent is trusted to pass a `session_id` together with the
repository the session started in. The orchestrator keeps no session
registry and does not check that the session belongs to `repo`: the
harness owns its session state.

### Lifecycle

- `code_task` blocks the generation for the length of the harness
  turn. The generation stays open, so the machine's idle timer does
  not run.
- A `code_task` is one tool call against `max_tool_calls`. Tool calls
  in a generation run in sequence: an agent runs one harness at a time.
- Before the start and each poll, the repository tokens are refreshed
  ([Tokens](repositories.md#tokens)).
- An orchestrator restart cuts the generation short. On startup, each
  `code_task` left unresolved in an active run gets `stop` on its
  machine when the machine is running. Once the harness has exited, its
  state is cleared, and the task's end checkpoint is taken in its
  repository, so the task diff is available. Its result is
  `interrupted`, naming its session id and log when known, and the
  start checkpoint to come back to. When the harness did not stop, the
  result says it may still be running. When the machine is not running,
  there is nothing left to stop and no end checkpoint is taken.
- A machine restart or container recreation ends the harness with
  everything else in the container. The next poll finds no state and
  the call ends `interrupted`, with the session id when known.
- After an interruption, the working tree holds whatever the harness
  wrote, and the task's start checkpoint stays in the repository. The
  agent can resume the session to finish the work.

### Code

`apps/orchestrator/src/toolbox/harness.ts` (`code_task`, the harness
checks, the harness log), `runtime/guilds-harness` (the ops and the
drivers), and in the app `apps/web/src/features/agent/chat/FlowView.tsx`
and `apps/web/src/features/agent/chat/ToolCallDetail.tsx`.
