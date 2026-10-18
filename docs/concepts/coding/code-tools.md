# Code tools

A [coding agent](index.md)'s runs offer five tools. `code_task` hands
code work to the agent's [harness](harnesses.md), and has its own page:
[Code tasks](code-tasks.md). The other four check that work and do what
the harness never does: run the project's checks, read files, search
the code, push a branch, and open a pull request.

| Tool | What it is for |
| --- | --- |
| `code_task` | Delegate a change to the harness, or resume its session ([Code tasks](code-tasks.md)) |
| `shell` | Run a bash command: tests, builds, git, `gh` |
| `shell_status` | Follow or stop a command started in the background |
| `file_read` | Read numbered lines of a file |
| `code_search` | Find text in the code, paths first, then lines |

Like the [browser](../browser.md) tools, they are offered while the
agent's Coding capability is on, and are not [bindings](../access.md).
Every call runs inside the agent's sandbox, in its
[home](../agent-home.md).

## When you use it

The agent uses these tools, not the operator. The operator sees each
call in the chat, with its arguments and its result
([In the app](#in-the-app)).

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
**Chat** tab, with a summary of what it did. A `code_task` is a block
of its own ([Code tasks](code-tasks.md#in-the-app)).

| Tool | Row reads |
| --- | --- |
| `shell` | "Run `<first line>`", or "Start `<first line>`" in the background; "timed out" or "exit N" when not 0 |
| `shell_status` | "List background commands", "Check b1", or "Stop b1" |
| `file_read` | "Read `<path>`", or "Read `<path>` from line N"; "unchanged since step N" for a repeated read |
| `code_search` | "Search files" or "Search lines", with "in `<path>`" |

Opening a row shows these views:

| View | Shows |
| --- | --- |
| **Arguments** | The call's arguments |
| **Result** | Text as Markdown, with **Raw** for the text as returned; JSON as a tree |
| **Metadata** | The call and the tool, then the exit code, the **Full output** log, the working directory, the file and its lines, and **Same as step** for a repeated read |

## Rules and limits

| Rule | Value or behaviour |
| --- | --- |
| `shell` timeout | 120 seconds by default, 1 to 600 |
| `file_read` | 200 lines by default, at most 500; lines over 400 characters clipped |
| `code_search` | 30 files or 40 lines at most; 10 matches per file; 60 seconds |
| Result size | `CODE_RESULT_MAX_BYTES`, default 8192 bytes, then the platform's 64 KiB cap |
| Logs | Kept for the agent's 20 most recent runs |
| Background commands | End with the machine's idle stop |
| Paths | Inside the agent's home |

## Reference

### Tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `code_task` | `brief` (required), `repo`, `session_id`, `notes`, `timeout_minutes` | The harness's status, diffstat, final message, and log path ([Code tasks](code-tasks.md#result)) |
| `shell` | `command` (required), `timeout_seconds` (default 120, 1 to 600), `background` | Combined stdout and stderr, shaped; `exit_code: N` when not 0 |
| `shell_status` | `id`, `stop` | Without `id`, the background commands with their state; with it, that command's state, exit code, and the last 40 lines of its log; `stop` ends it |
| `file_read` | `path` (required), `offset` (first line, default 1), `limit` (default 200, at most 500) | Numbered lines under a `path · lines a–b of n` header |
| `code_search` | `pattern` (required), `path`, `glob`, `mode`, `fixed`, `ignore_case`, `context`, `limit` | Text search ([`code_search`](#code_search)) |

The tools follow the agent's live `coding` flag at each generation, as
the browser tools follow `browser`, not the flag in the run's snapshot.

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
- the fields under [Code tasks](code-tasks.md#result) on `code_task`

### Code

`apps/orchestrator/src/toolbox/code.ts` (the four check tools and the
transport), `runtime/guilds-code`, and in the app
`apps/web/src/features/agent/chat/ToolCallDetail.tsx` and
`apps/web/src/features/agent/runs/toolFormat.ts`.
