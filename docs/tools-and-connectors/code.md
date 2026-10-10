# Code tools

A coding agent's run offers eleven native tools. Like the browser
tools they follow the `coding` flag and are not bindings.

| Tool | Arguments | Result |
| --- | --- | --- |
| `shell` | `command`, `timeout_seconds` (default 120, at most 600), `background` | Combined stdout and stderr, shaped; `exit_code: N` when not 0 |
| `shell_status` | `id`, `stop` | Without `id`, the background commands with their state; with it, that command's state, exit code, and the last 40 lines of its log; `stop` ends it |
| `file_read` | `path`, `offset` (first line, default 1), `limit` (default 200 lines, at most 500) | Numbered lines under a `path · lines a–b of n` header |
| `file_edit` | `path`, `old_string`, `new_string`, `replace_all` | `edited <path> (+a −b)` |
| `file_write` | `path`, `content` | `wrote <path> (n lines)`; missing folders are created |
| `code_search` | `pattern`, `path`, `glob`, `mode`, `fixed`, `ignore_case`, `context`, `limit` | Text search ([Code search](#code-search)) |
| `code_match` | `pattern`, `lang`, `path`, `limit` (default 30, at most 100) | Structural matches as `path:line: first matched line` |
| `code_map` | `repo` | Directory clusters with file and symbol counts and their most referenced symbols, then the most referenced symbols overall |
| `code_find` | `question`, `in`, `source`, `limit` (default 8, at most 20) | Ranked symbols and files with `path:line` and their signature; with `source`, up to 8 lines of each |
| `code_outline` | `path` | Every signature in the file with its line span, without bodies |
| `code_callers` | `symbol`, `direction` (`in` or `out`), `depth` (1 to 3), `in` | What references the symbol, or what it references, indented by depth, with `path:line` |

Every call runs `/usr/local/bin/guilds-code` in the sandbox, the way
the browser tools run `guilds-browser`. The request is base64 JSON on
the command line. A request whose encoding passes 64 KiB is written
through the sandbox file API to `/run/guilds/requests/` instead. The
helper reads and deletes it.

The helper answers with a base64 JSON envelope holding the shaped
text and the fields the call's metadata records. The orchestrator
never opens a workspace file for these tools, so a link in the
workspace resolves inside the container.

- A relative path resolves against the run's working directory, kept
  in `/home/agent/.runs/<run id>/cwd`. It starts at `/home/agent`.
  `shell` updates it when a command changes directory. Environment
  changes do not persist between calls. The file tools refuse a path
  that resolves, links followed, outside `/home/agent`.
- `shell` runs `bash -c` with stdin closed and `PAGER=cat`,
  `GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`, `NO_COLOR=1`, `TERM=dumb`,
  `DEBIAN_FRONTEND=noninteractive`, `GUILD_RUN_ID`, and `GUILD_AGENT_ID`
  in its environment. A command past its timeout gets SIGTERM, then
  SIGKILL two seconds later, for its whole process group. Its result
  says so with `exit_code: 124`.
- A background command's output goes to its log and it runs in its own
  session. `shell_status` names it `b1`, `b2`, … for the life of the
  container. Background commands do not hold the sandbox awake. They
  end with the idle stop.
- `file_edit` replaces an exact string. A string that is missing, or
  that occurs more than once without `replace_all`, is an error and
  changes nothing. Edits and writes replace the file atomically and
  keep its mode.
- The helper caps each result at `CODE_RESULT_MAX_BYTES` (default
  8192). The platform pipeline then runs unchanged: redaction, the
  64 KiB cap, and the `remaining_tool_calls` trailer.

Output shaping:

| Tool | Shaping |
| --- | --- |
| `shell` | Output that fits is returned whole. Otherwise its first 2 KiB and its last 6 KiB, less room for the trailers, around a line giving the elided byte count and the log path, `/home/agent/.runs/<run id>/<call id>.log`; the end is kept because build and test errors are there. ANSI escapes are removed and a line redrawn with carriage returns keeps its last state |
| `file_read` | A line longer than 400 characters is clipped with the count of what was cut; the range stops before the cap and says which offset continues it; a binary file is named with its size, not shown |

A full `shell` log is stored unredacted in the workspace, inside the
sandbox that already holds the values. Reading it back with
`file_read` passes through redaction like any result. `.runs/` keeps
the folders of the agent's 20 most recent runs.

**No repeated reads.** Each `file_read` records the file's path, the
lines it returned (`range`), and the SHA-256 of the whole file
(`content_hash`). A later read in the same run whose lines an earlier
read already returned, with the same hash, returns one line instead:
`<path> lines a–b: unchanged since step N; read that result.`, where N
is the earlier result's message `seq`, and records `repeat_of: N`. An
edit changes the hash, so the next read returns content.

A coding run's repositories and GitHub tokens are in
[Runs](../concepts/runs.md#repositories) and [GitHub](github.md).

## Code search

Three engines sit behind tool names that do not name them. An engine
can be replaced without changing a prompt or a run view.

| Engine | Tools | Answers |
| --- | --- | --- |
| ripgrep | `code_search` modes `files` and `content` | Text in every file, whatever its language, respecting `.gitignore` |
| ast-grep | `code_match` | Syntax patterns (a call shape, a declaration form) free of hits in comments and strings; the language comes from `lang` or each file's extension |
| Graft | `code_map`, `code_find`, `code_outline`, `code_callers`, `code_search` mode `symbols` | Where things are and how they connect |

`code_search` modes, each searching `path` (default the working
directory) with an optional `glob`, `fixed` for a literal pattern, and
`ignore_case`:

- `files` (default): matching paths with their match counts, highest
  first, at most 30, then the totals.
- `content`: `path:line: text` for matches and `path-line- text` for
  context lines (`context` 0 to 5), at most 40 lines and at most 10
  matches per file, then the totals.
- `symbols`: hits grouped under their enclosing function or class, with
  that symbol's span and how many places reference it, at most 20
  groups of 5 lines.

Paths in every result are relative to the working directory, so they
can be passed back to `file_read`. A matched line longer than 300
characters is clipped. A result that would pass the cap stops at a
line and says how many lines it left out.

The Graft-backed tools address a repository as a folder under
`/home/agent/repos/`. `code_map` takes its name. The others take the
repository holding their `path` or `in`, else the one holding the
working directory, else the only one there. `in` narrows to a folder
or file of it.

Graft runs in its structural tier only:

- The graph is built by tree-sitter with no model, no key, and no
  network. It lives at `/home/agent/.cache/graft/<name>` (`--dir`). It
  is built on the first Graft-backed call for a repository. Graft
  refreshes it against the working tree before every query,
  uncommitted edits included.
- With `GRAFT_NO_GITIGNORE=1` and `GRAFT_NO_IGNORE=1` a build writes
  nothing into the repository.
- `DO_NOT_TRACK=1` turns its usage telemetry off, the install event
  included. Its once-a-day npm version lookup has no switch. It is
  one background request from the sandbox.
- Every call reads Graft's `--json` output and builds its own compact
  lines. Graft's text output and its diagnostics on stderr never
  reach the model.
- A file in a language Graft does not parse is not in the graph.
  `code_outline` says so. `code_search` in `files` or `content` mode
  still finds it.
- No tool runs `graft build --deep`, `init`, `trail`, `viz`,
  `upgrade`, or `mcp`. No provider key is present, so the
  model-written tier cannot run.

A first graph build can take minutes on a large repository.
Graft-backed calls wait up to 11 minutes. A text or syntax search
waits up to 60 seconds.

**Exploration.** After each generation of a coding run, the run's
`metadata.exploration` records `calls_before_first_edit` (tool calls
before its first successful `file_edit` or `file_write`, null until
there is one) and `read_bytes_unedited` (bytes `file_read` returned
from files the run never edited). They measure whether the search
tools pay for themselves. The run payload carries them as
`exploration`.

**Metadata.** Beside the fields every tool call records:

- `exit_code`, `cwd`, `log_path` (when output was elided), and
  `timed_out` on `shell`
- `background_id`, `state`, and `exit_code` on `shell_status`
- `path`, `range`, `content_hash`, and `lines` on `file_read`
- `path`, `lines_added`, `lines_removed`, and `content_hash` on
  `file_edit` and `file_write`
- `matches` (and `files`) on `code_search` and `code_match`
- `repository` and `hits` on the Graft-backed tools
