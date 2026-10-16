# Code tools


A [coding agent](index.md)'s runs offer five tools. `code_task` hands
code work to the agent's [harness](harnesses.md). The other four check
that work and do what the harness never does: run the project's
checks, read files, search the code, push a branch, and open a pull
request.

| Tool | What it is for |
| --- | --- |
| `code_task` | Delegate a change to the harness, or resume its session |
| `shell` | Run a bash command: tests, builds, git, `gh` |
| `shell_status` | Follow or stop a command started in the background |
| `file_read` | Read numbered lines of a file |
| `code_search` | Find text in the code, paths first, then lines |

Like the [browser](../browser.md) tools, they follow the agent's
`coding` switch and are not [bindings](../access.md). Every call runs
inside the agent's sandbox, in its [home](../agent-home.md).

## When you use it

The agent uses these tools, not the operator. The operator sees each
call in the chat, with its arguments, its result, and for a code task
its live progress and its diff ([In the app](#in-the-app)).

## How it works

### Each call runs in the sandbox

Each call runs a small helper inside the sandbox: `guilds-harness` for
`code_task`, `guilds-code` for the others. The orchestrator never opens
a file in the agent's home for these tools, so a link in the home
resolves inside the container.

Every call gets the environment of every command the agent runs: its
home, its port block, and its secrets
([Agent home](../agent-home.md)). A server the agent starts listens on
a port of its block, from `PORT`.

### The working directory

A relative path resolves against the run's working directory. It
starts in the repository when the guild has exactly one, otherwise in
the home. A `cd` in `shell` carries over to the next call.
Environment changes do not. `file_read` and `code_search` refuse a path
that resolves, links followed, outside the home.

### Delegating with `code_task`

One `code_task` call is one turn of the harness. The agent passes a
self-contained `brief`, because the harness sees nothing of the
conversation, notes, or Memory. `notes` appends notes or records to the
brief. The harness works in one repository, may commit on the current
branch, and never pushes or opens pull requests.

The call blocks the agent until the harness exits, at most 60 minutes.
Meanwhile its progress streams to the chat. The result gives how the
turn ended, the files it changed, and the harness's final message.

A question from the harness is not an error. It is the final message.
The agent answers it by calling `code_task` again with the
`session_id` from the result, which resumes the same session. A session
lives in the agent's home, so a later run can resume it too when the
agent kept the id, in Memory or a note.

### Checking the work

`shell` runs a command and returns its output, shaped to fit: a long
output keeps its start and its end, where build and test errors are,
and names a log file holding all of it. A long-running process, such as
a dev server, starts in the background and is followed with
`shell_status`.

`file_read` returns numbered lines of one range. Reading the same
unchanged lines twice in a run returns a pointer to the earlier
result, not the text again. `code_search` finds which files match
first, then the matching lines.

## In the app

Each call other than `code_task` is a row in the run's flow on the
**Chat** tab, with a summary of what it did:

| Tool | Row reads |
| --- | --- |
| `shell` | "Run `<first line>`", or "Start `<first line>`" in the background; "timed out" or "exit N" when not 0 |
| `shell_status` | "List background commands", "Check b1", or "Stop b1" |
| `file_read` | "Read `<path>`", or "Read `<path>` from line N"; "unchanged since step N" for a repeated read |
| `code_search` | "Search files" or "Search lines", with "in `<path>`" |

A `code_task` is its own block in its step on the timeline, shown even
while the step is folded, like an answer. Its step carries the
harness's logo on the rail in place of the dot, the one its result
names, else the agent's harness. The block reads:

- the harness's name, "coding task", and its status: **Running…**,
  **Done**, **Failed**, or how it ended otherwise, such as **Timed
  out**; a **wrote** tag; and its run time;
- the brief it was given, clamped to two lines;
- its repository and its diffstat;
- the first line of its error, when it failed.

While the call runs, the logo and the status pulse and its latest six
progress lines show under the brief. Progress lines are live only:
they stream while the run view is open and are not kept, so a reload
shows the block without them until the result lands.

Opening a row or a code task's block shows **Arguments**, **Result**, and **Metadata**; for a
code task with an end checkpoint, **Diff**
([Reviewing changes](reviewing-changes.md#in-the-app)); and for a code
task whose result names its log, **Log**. A running code
task opens on **Result**, which shows its progress. **Result** renders
text as Markdown, with **Raw** for the text as returned, and JSON as a
tree; a code task's result leaves out its closing `log:` line, which
**Metadata** names as **Harness log**; clicking that path opens **Log**.
**Metadata** lists
the call, the tool, and for a code task its **Status**, **Harness**,
**Repository**, **Session**, **Changes**, **Checkpoints** (start → end,
as short commit ids), and **Harness log**; for other calls the exit
code, **Full output** log, working directory, file, lines, and
**Same as step** for a repeated read.

**Log** reads the call's kept harness log from the agent's machine,
waking it, once the view opens ([Harness log](#harness-log)). **Steps**
shows each event as a progress line; **JSON** shows the raw JSONL
events. "Loading the log from the agent's machine…" shows while it
loads, and "Couldn't load the harness log" with the reason when it
cannot be read, such as a log the agent's home no longer keeps.

## Rules and limits

| Rule | Value or behaviour |
| --- | --- |
| `code_task` timeout | 30 minutes by default, 1 to 60 |
| `code_task` notes | At most 64 KiB together; a note past the cap is named, not included |
| One harness at a time | Tool calls in a generation run in sequence |
| `code_task` budget | One tool call against `max_tool_calls` |
| `shell` timeout | 120 seconds by default, 1 to 600 |
| `file_read` | 200 lines by default, at most 500; lines over 400 characters clipped |
| `code_search` | 30 files or 40 lines at most; 10 matches per file |
| Result size | `CODE_RESULT_MAX_BYTES`, default 8192 bytes, then the platform's 64 KiB cap |
| Logs | Kept for the agent's 20 most recent runs |
| Background commands | End with the machine's idle stop |
| Paths | Inside the agent's home |

## Reference

### Tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `code_task` | `brief` (required), `repo`, `session_id`, `notes`, `timeout_minutes` | The harness's status, diffstat, final message, and log path ([`code_task`](#code_task)) |
| `shell` | `command` (required), `timeout_seconds` (default 120, 1 to 600), `background` | Combined stdout and stderr, shaped; `exit_code: N` when not 0 |
| `shell_status` | `id`, `stop` | Without `id`, the background commands with their state; with it, that command's state, exit code, and the last 40 lines of its log; `stop` ends it |
| `file_read` | `path` (required), `offset` (first line, default 1), `limit` (default 200, at most 500) | Numbered lines under a `path · lines a–b of n` header |
| `code_search` | `pattern` (required), `path`, `glob`, `mode`, `fixed`, `ignore_case`, `context`, `limit` | Text search ([`code_search`](#code_search)) |

### Transport

`shell`, `shell_status`, `file_read`, and `code_search` run
`python3 /usr/local/bin/guilds-code <request>` in the sandbox, the way
the browser tools run `guilds-browser`. `code_task` runs
`/usr/local/bin/guilds-harness` the same way. The request is base64
JSON on the command line, carrying the op, its arguments, the run id,
the agent id, the call id, the default working directory, and the
result's byte cap. A request whose encoding passes 64 KiB is written
through the sandbox file API to
`/run/guilds/requests/<run id>-<call id>.json` instead, and the helper
reads and deletes it.

The helper answers with one base64 JSON envelope, `{ ok, text, meta }`
or `{ ok: false, error }`. `text` is already shaped to the cap; `meta`
becomes the call's metadata. A helper that prints no envelope fails the
call with "code helper failed" and the last 5 lines of its stderr. A
`guilds-code` op waits up to 120 seconds; `shell` waits its own
timeout plus 30 seconds.

The helper caps each result at `CODE_RESULT_MAX_BYTES` (default 8192,
at least 1024). The platform pipeline then runs unchanged: redaction,
the 64 KiB cap, and the `remaining_tool_calls` trailer
([Runs](../runs.md)).

### Working directory

The run's working directory is kept in `.runs/<run id>/cwd` in the
home. It starts at the request's default, `repos/<name>` when the guild
has exactly one repository, else at the home. A `~` or `~/` path starts
at the home.

### `shell`

`shell` runs `bash -c` with stdin closed and `PAGER=cat`,
`GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`, `NO_COLOR=1`, `TERM=dumb`,
`DEBIAN_FRONTEND=noninteractive`, `GUILD_RUN_ID`, and `GUILD_AGENT_ID`
in its environment, and `GH_TOKEN` set to the token of the repository
that holds the working directory ([Repositories](repositories.md#tokens)).
On exit it records the shell's directory as the new working directory.

A command past its timeout gets SIGTERM, then SIGKILL two seconds
later, for its whole process group. Its result ends with
`[timed out after Ns; the command was stopped]` and `exit_code: 124`.
A command with no output returns `(no output)`.

Output that fits is returned whole. Otherwise its first part, at most
2 KiB, and its last part, about 6 KiB, less room for the trailers, go
around a line `[… N bytes elided; full output: <log> …]`. The log is
`.runs/<run id>/<call id>.log` in the agent's home, kept only when the
output was elided. ANSI escapes are removed, and a line redrawn with
carriage returns keeps its last state.

A full `shell` log is stored unredacted in the agent's home, on the
machine that already holds the values. Reading it back with
`file_read` passes through redaction like any result.

### Background commands

With `background`, `shell` starts the command in its own session, its
output going to its log, and returns at once:
`started b1 in the background (pid N)`, the log, and how to check it.
Ids run `b1`, `b2`, … for the life of the container. Their records are
under `/run/guilds/<agent id>/background/`.

`shell_status` without `id` lists each command as
`<id>  <state>  <elapsed>  <command>`. With `id`, it shows the state,
the elapsed time, the log path, and the last 40 lines of the log.
States are `running`, `exited N`, `stopping`, `stopped`, and `ended`
(gone without an exit code). `stop` on a running command sends
SIGTERM to its process group, then SIGKILL five seconds later.

Background commands do not keep the machine's container running. They
end with its idle stop ([Machines](../machines.md)).

### `file_read`

`file_read` reads a regular file inside the home. A missing file, a
directory, or another kind of file is an error. A file whose first 8000
bytes hold a NUL byte is binary: it is named with its size, not shown.
An empty file, or an `offset` past the end, says so.

A line longer than 400 characters is clipped with the count of what was
cut, as `… [+N chars]`. The range stops before the result's cap and
says which offset continues it:
`[stopped at line N to stay under M bytes; continue with offset N+1]`.
The header shows the path relative to the working directory.

**No repeated reads.** Each `file_read` records the file's path, the
lines it returned (`range`), and the SHA-256 of the whole file
(`content_hash`). A later read in the same run whose lines an earlier
read already returned, with the same hash, returns one line instead:
`<path> lines a–b: unchanged since step N; read that result.`, where N
is the earlier result's message `seq`, and records `repeat_of: N`. The
earlier read counts only when it did not fail, was not cut by the
output pipeline, and was not itself a pointer. A change to the file, by
the harness or a command, changes the hash, so the next read returns
content.

### `code_search`

`code_search` runs ripgrep over text in every file, whatever its
language, respecting `.gitignore`. It searches `path` (default the
working directory) with an optional `glob`, `fixed` for a literal
pattern, and `ignore_case`, in one of two modes:

- `files` (default): matching paths with their match counts, highest
  first, at most 30, then `… N more files` and the totals.
- `content`: `path:line: text` for matches and `path-line- text` for
  context lines (`context` 0 to 5, groups split by `--`), at most 40
  lines and at most 10 matches per file, then the totals.

`limit` lowers either maximum. Paths in every result are relative to
the working directory, so they can be passed back to `file_read`. A
matched line longer than 300 characters is clipped. A result that would
pass the cap stops at a line and says how many lines it left out. No
match reads `no matches for '<pattern>' in <path>`. A search waits up to
60 seconds.

### Metadata

Beside the fields every tool call records:

- `exit_code`, `cwd`, `log_path` (when output was elided), and
  `timed_out` on `shell`; `background_id` and `log_path` on a
  background start
- `background_id`, `state`, `log_path`, and `exit_code` on
  `shell_status`
- `path`, `range`, `content_hash`, and `lines` on `file_read`, and
  `repeat_of` on a repeated read
- `matches` and `files` on `code_search`
- the fields under [`code_task`](#code_task) on `code_task`

### `code_task`

`code_task` is offered when the run's snapshot has `coding: true`. A
call without a harness picked fails with `harness.missing`
([Coding agents](index.md#generation-start-checks)).

| Argument | Meaning |
| --- | --- |
| `brief` | Required. The whole task, self-contained |
| `repo` | Repository name under `repos/`. Optional when the guild has one |
| `session_id` | Resumes that harness session; `brief` is its next turn |
| `notes` | Display paths of notes or collection records whose content is appended to the brief |
| `timeout_minutes` | Default 30, 1 to 60 |

#### Steps

1. **Repository.** `repo`, else the guild's only repository. A guild
   without repositories, an unknown name, or a missing `repo` with
   several repositories is an error naming the guild's repositories.
   With `session_id`, the agent passes the repository the session
   started in; the orchestrator does not check the pair
   ([Sessions](#sessions)).
2. **Check.** `guilds-harness check` reports whether the CLI is in the
   image, its version, and the credential it would run on, as at the
   generation's start. A CLI missing from the image, or no credential,
   is an error ([Credentials and errors](harnesses.md#credentials-and-errors)).
3. **Brief.** A fixed preamble, then the brief under `# Task`, then
   each note under `# <display path>`. The preamble says the harness
   cannot reach the operator, stops and asks in its final message when
   it is blocked or needs a decision, may commit on the current branch,
   never pushes or opens pull requests, and ends with what it changed
   and ran. Notes are read with the agent's access, as `note_get` reads
   them. A record is its JSON view. A collection or a script is
   refused, and a note that does not load fails the call. The notes take
   at most 64 KiB together. A note past the cap is named on a closing
   line, not included.
4. **Start checkpoint** of the repository at
   `refs/guild/runs/<run id>/tasks/<call id>/start`
   ([Reviewing changes](reviewing-changes.md)).
5. **Start.** A generation cancelled before this step never starts the
   harness. A GitHub token close to expiry is replaced first.
   `guilds-harness start` removes the harness's local configuration
   ([Managed configuration](harnesses.md#managed-configuration)),
   writes the brief to `.runs/<run id>/<call id>.prompt.md` in the home
   (mode 0600), starts the harness detached ([Process](#process)) on
   the run's harness model and effort, and returns at once. The brief reaches the
   CLI on stdin, or for Cursor through the prompt file, never on its
   command line.
6. **Poll** every 3 seconds until the CLI exits, publishing its
   progress ([Progress](#progress)).
7. **Stop.** Once `start` has been sent, every way out of the call
   sends `stop`: a cancel, a timeout, three failed polls in a row, or
   an error. The two exceptions are a poll that saw the CLI exit and a
   poll that found the call's state gone.
8. **Result.** Once the CLI has exited, by itself or after `stop`,
   `guilds-harness result` reads the final message, the session id,
   and how the turn ended from the log, then removes the prompt file
   and the call's state files.
9. **End checkpoint** at `…/tasks/<call id>/end`, with the diffstat
   since the start and the changed files, at most 30.

#### Result

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
`CODE_RESULT_MAX_BYTES`. The cut keeps its end, where questions and
summaries are, and says how many bytes it removed from the start. The
platform pipeline then runs unchanged.

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

#### Process

`guilds-harness` runs one short exec per op, with the same transport as
`guilds-code`. Each op waits up to 60 seconds; each task checkpoint up
to 300.

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

#### Harness log

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
  tokens are minted per run and are not in that set (SEC-32).
- A call that is not a `code_task`, or whose result names no harness
  and log, is 404 ("that call has no harness log"), and the machine is
  not woken. A log the agent's home no longer keeps is 404 too.

#### Harness environment

The harness gets the environment of every command the orchestrator
runs for the agent: `HOME`, `GUILDS_AGENT_HOME`, `PORT`,
`GUILDS_PORTS`, the agent's secrets, and its secret aliases
([Agent home](../agent-home.md)). It also gets `PAGER=cat`,
`GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`, `NO_COLOR=1`, `TERM=dumb`,
`DEBIAN_FRONTEND=noninteractive`, `GUILD_RUN_ID`, and
`GUILD_AGENT_ID`, so commit trailers work
([Reviewing changes](reviewing-changes.md#commit-trailers)).

`GH_TOKEN` and `GITHUB_TOKEN` are never in a harness's environment:
the harness does not open pull requests. git still reads its token
through the credential helper. Each driver also sets its own variables
and removes those that would move the harness to metered API billing
([Drivers](harnesses.md#drivers)).

#### Progress

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

#### Sessions

Session ids are the harness's own ([Drivers](harnesses.md#drivers)).
Each harness keeps its session state in the agent's home (`~/.claude`,
`~/.codex`, `~/.cursor`), so a session survives container recreation
and counts against `max_workspace_mib`. A session from an earlier run
can be resumed when the agent kept its id. A resumed session whose
state is gone fails with the harness's error, and the agent starts a
new session with a full brief. A `session_id` holds letters, digits,
and `_ . : -`, at most 200 characters.

The agent is trusted to pass a `session_id` together with the
repository the session started in. The orchestrator keeps no session
registry and does not check that the session belongs to `repo`: the
harness owns its session state.

#### Lifecycle

- `code_task` blocks the generation for the length of the harness
  turn. The generation stays open, so the machine's idle timer does
  not run.
- A `code_task` is one tool call against `max_tool_calls`. Tool calls
  in a generation run in sequence: an agent runs one harness at a time.
- Before the start and each poll, a GitHub token within 10 minutes of
  expiry is replaced, as before a `shell` command.
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
- Harness calls record no usage or cost.

### Code

`apps/orchestrator/src/toolbox/code.ts` (the four check tools and the
transport), `apps/orchestrator/src/toolbox/harness.ts` (`code_task`),
`runtime/guilds-code`, `runtime/guilds-harness`, and in the app
`apps/web/src/features/agent/chat/ToolCallDetail.tsx` and
`apps/web/src/features/agent/runs/toolFormat.ts`.
