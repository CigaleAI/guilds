# Code tools

A coding agent's run offers five native tools. Like the browser
tools they follow the `coding` flag and are not bindings. Code changes
are the harness's work: [`code_task`](#code-task) delegates them to a
coding CLI in the agent's sandbox. The other four check that work,
run the project's checks, and push it.

| Tool | Arguments | Result |
| --- | --- | --- |
| `code_task` | `brief`, `repo`, `session_id`, `notes`, `timeout_minutes` | The harness's status, diffstat, final message, and log path ([`code_task`](#code-task)) |
| `shell` | `command`, `timeout_seconds` (default 120, at most 600), `background` | Combined stdout and stderr, shaped; `exit_code: N` when not 0 |
| `shell_status` | `id`, `stop` | Without `id`, the background commands with their state; with it, that command's state, exit code, and the last 40 lines of its log; `stop` ends it |
| `file_read` | `path`, `offset` (first line, default 1), `limit` (default 200 lines, at most 500) | Numbered lines under a `path · lines a–b of n` header |
| `code_search` | `pattern`, `path`, `glob`, `mode`, `fixed`, `ignore_case`, `context`, `limit` | Text search ([Code search](#code-search)) |

`shell`, `shell_status`, `file_read`, and `code_search` run
`/usr/local/bin/guilds-code` in the sandbox, the way the browser tools
run `guilds-browser`. `code_task` runs `guilds-harness` the same way.
The request is base64 JSON on the command line. A request whose
encoding passes 64 KiB is written through the sandbox file API to
`/run/guilds/requests/` instead. The helper reads and deletes it.

The helper answers with a base64 JSON envelope holding the shaped
text and the fields the call's metadata records. The orchestrator
never opens a file in the agent's home for these tools. A link in
the home resolves inside the container.

- Every call runs in the agent's home, `/home/<agent id>`, with
  `HOME`, `GUILDS_AGENT_HOME`, `PORT`, `GUILDS_PORTS`, and the
  agent's secrets in its environment
  ([Runs](../concepts/runs.md#sandbox)). A server the agent starts
  listens on a port of its block, from `PORT`.
- A relative path resolves against the run's working directory, kept
  in `.runs/<run id>/cwd` in the home. It starts at the home, or in
  the repository when the guild has exactly one. `shell` updates it
  when a command changes directory. Environment changes do not
  persist between calls. `file_read` refuses a path that resolves,
  links followed, outside the home.
- `shell` runs `bash -c` with stdin closed and `PAGER=cat`,
  `GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`, `NO_COLOR=1`, `TERM=dumb`,
  `DEBIAN_FRONTEND=noninteractive`, `GUILD_RUN_ID`, and `GUILD_AGENT_ID`
  in its environment. A command past its timeout gets SIGTERM, then
  SIGKILL two seconds later, for its whole process group. Its result
  says so with `exit_code: 124`.
- A background command's output goes to its log and it runs in its own
  session. `shell_status` names it `b1`, `b2`, … for the life of the
  container. Background commands do not keep the machine's container
  running. They end with its idle stop.
- The helper caps each result at `CODE_RESULT_MAX_BYTES` (default
  8192). The platform pipeline then runs unchanged: redaction, the
  64 KiB cap, and the `remaining_tool_calls` trailer.

Output shaping:

| Tool | Shaping |
| --- | --- |
| `shell` | Output that fits is returned whole. Otherwise its first 2 KiB and its last 6 KiB, less room for the trailers, around a line giving the elided byte count and the log path, `.runs/<run id>/<call id>.log` in the agent's home; the end is kept because build and test errors are there. ANSI escapes are removed and a line redrawn with carriage returns keeps its last state |
| `file_read` | A line longer than 400 characters is clipped with the count of what was cut; the range stops before the cap and says which offset continues it; a binary file is named with its size, not shown |

A full `shell` log is stored unredacted in the agent's home, on the
machine that already holds the values. Reading it back with
`file_read` passes through redaction like any result. `.runs/` keeps
the folders of the agent's 20 most recent runs.

**No repeated reads.** Each `file_read` records the file's path, the
lines it returned (`range`), and the SHA-256 of the whole file
(`content_hash`). A later read in the same run whose lines an earlier
read already returned, with the same hash, returns one line instead:
`<path> lines a–b: unchanged since step N; read that result.`, where N
is the earlier result's message `seq`, and records `repeat_of: N`. A
change to the file, by the harness or a command, changes the hash, so
the next read returns content.

A coding run's repositories and GitHub tokens are in
[Runs](../concepts/runs.md#repositories) and [GitHub](github.md).

## Code search

`code_search` runs ripgrep over text in every file, whatever its
language, respecting `.gitignore`. It searches `path` (default the
working directory) with an optional `glob`, `fixed` for a literal
pattern, and `ignore_case`, in one of two modes:

- `files` (default): matching paths with their match counts, highest
  first, at most 30, then the totals.
- `content`: `path:line: text` for matches and `path-line- text` for
  context lines (`context` 0 to 5), at most 40 lines and at most 10
  matches per file, then the totals.

Paths in every result are relative to the working directory, so they
can be passed back to `file_read`. A matched line longer than 300
characters is clipped. A result that would pass the cap stops at a
line and says how many lines it left out. A search waits up to 60
seconds.

**Metadata.** Beside the fields every tool call records:

- `exit_code`, `cwd`, `log_path` (when output was elided), and
  `timed_out` on `shell`
- `background_id`, `state`, and `exit_code` on `shell_status`
- `path`, `range`, `content_hash`, and `lines` on `file_read`
- `matches` (and `files`) on `code_search`
- the fields under [`code_task`](#code-task) on `code_task`

## `code_task`

`code_task` delegates code work to the agent's coding harness: a
coding CLI that runs headless in the agent's sandbox, against one of
the guild's repositories, on the operator's own subscription. One
call is one harness turn. It is offered when the run snapshot has
`coding: true`. A coding run whose snapshot has no `harness` fails at
start with `coding.harness_missing`
([Guilds and agents](../concepts/guilds-and-agents.md#configuration-and-appearance)).

`harness` takes `claude-code`, `codex`, or `cursor`. Each has a
driver in `guilds-harness` ([Drivers](#drivers)).

| Argument | Meaning |
| --- | --- |
| `brief` | Required. The whole task, self-contained |
| `repo` | Repository name under `repos/`. Optional when the guild has one |
| `session_id` | Resumes that harness session; `brief` is its next turn |
| `notes` | Display paths of notes or collection records whose content is appended to the brief |
| `timeout_minutes` | Default 30, at most 60 |

A call runs these steps:

1. **Repository.** `repo`, else the guild's only repository. A guild
   without repositories, an unknown name, or a missing `repo` with
   several repositories is an error naming the guild's repositories.
   A session resumes in the repository it started in.
2. **Check.** `guilds-harness check` reports whether the CLI is in
   the image, its version, and the credential it would run on. A CLI
   missing from the image, or no credential, is an error
   ([Credentials and errors](#credentials-and-errors)).
3. **Brief.** A fixed preamble, then the brief under `# Task`, then
   each note under `# <display path>`. The preamble says the harness
   cannot reach the operator, stops and asks in its final message
   when it is blocked or needs a decision, may commit on the current
   branch, never pushes or opens pull requests, and ends with what it
   changed and ran. Notes are read with the agent's access, as
   `note_get` reads them; a record is its JSON view, and a collection
   or a script is refused. The notes take at most 64 KiB together. A
   note past the cap is named on a closing line, not included.
4. **Start checkpoint** of the repository at
   `refs/guild/runs/<run id>/tasks/<call id>/start`, through
   `guilds-code checkpoint` with `task`
   ([Runs](../concepts/runs.md#repositories)).
5. **Start.** `guilds-harness start` writes the brief to
   `.runs/<run id>/<call id>.prompt.md` in the home (mode 0600),
   starts the harness detached ([Process](#process)), and returns at
   once. The brief reaches the CLI on stdin, never on its command
   line.
6. **Poll** every 3 seconds until the CLI exits, publishing its
   progress ([Progress](#progress)).
7. **Result.** `guilds-harness result` reads the final message, the
   session id, and how the turn ended from the log, then removes the
   prompt file and the call's state.
8. **End checkpoint** at `…/tasks/<call id>/end`, with the diffstat
   since the start and the changed files, at most 30.

Result text:

```text
<status> · <harness> · <repository> · session <session id> · <duration>
<n> files changed, +<a> −<d>
<path> (+a −d), at most 30, a binary file as (binary)
<detail, when there is one>

<final message>

log: .runs/<run id>/<call id>.harness.jsonl
```

The final message gives way so the whole result fits
`CODE_RESULT_MAX_BYTES`. The cut keeps its end, where questions and
summaries are, and says how many bytes it removed from the start.
The platform pipeline then runs unchanged: redaction, the 64 KiB cap,
and the `remaining_tool_calls` trailer.

| Status | When | Detail |
| --- | --- | --- |
| `completed` | The CLI exited 0 and its turn did not end in error | none |
| `failed` | The CLI exited otherwise, or its turn ended in error | A driver that parses none of the CLI's output says so with the CLI's version. A CLI that printed no event (one refusing to start without a login) gives the last 5 lines of its stderr. Otherwise the harness's error, else its stderr, else its exit code |
| `timed_out` | `timeout_minutes` passed; the harness got `stop` | `Stopped after N minutes. Resume the session to continue.` |
| `cancelled` | The generation was cancelled; the harness got `stop` | `Stopped: the generation was cancelled.` |
| `interrupted` | The call's state is gone, or three polls in a row failed | The machine restarted or its container was recreated |

A question from the harness is not a status. It is the final
message, and the agent answers it by resuming the session.

### Process

`guilds-harness` is a sandbox helper in the style of `guilds-code`:
one short exec per op, the request as base64 JSON on the command
line or through `/run/guilds/requests/` past 64 KiB, one base64 JSON
envelope on stdout. Each op waits up to 60 seconds; each checkpoint
up to 300.

| Op | Does |
| --- | --- |
| `check` | Whether the harness's CLI is installed, its version, and its credential (`secret`, `login`, or none) |
| `start` | Forks a supervisor in its own session and returns. The supervisor starts the CLI in its own process group in `repos/<repo>`, appends the CLI's raw events to the log, waits for it, and records its exit code |
| `poll` | The progress lines after a byte offset into the log, the new offset, the session id once the harness has reported one, and whether the CLI has exited |
| `result` | The final message, the session id, the exit code, whether the turn ended in error, and the tail of the CLI's stderr |
| `stop` | SIGTERM to the CLI's process group, SIGKILL ten seconds later, then waits for the supervisor to record the exit |

A call's state is under `/run/guilds/<agent id>/harness/` (mode 0700),
which goes with the container: `<call id>.json` (what was started),
`.pid` (the CLI's process group), `.exit`, `.session`, `.stderr`, and
`.stopped`. `result` removes them once the CLI has exited.

The raw event log, `.runs/<run id>/<call id>.harness.jsonl` in the
agent's home, is stored unredacted like a `shell` log, under the same
retention: `.runs/` keeps the folders of the agent's 20 most recent
runs. Reading it back with `file_read` passes through redaction.

### Environment

The harness gets the environment of every command the orchestrator
runs for the agent: `HOME`, `GUILDS_AGENT_HOME`, `PORT`,
`GUILDS_PORTS`, and the agent's secrets
([Runs](../concepts/runs.md#sandbox)). It also gets `PAGER=cat`,
`GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`, `NO_COLOR=1`, `TERM=dumb`,
`DEBIAN_FRONTEND=noninteractive`, `GUILD_RUN_ID`, and
`GUILD_AGENT_ID`, so commit trailers work.

`GH_TOKEN` and `GITHUB_TOKEN` are never in a harness's environment:
the harness does not open pull requests. git still reads its token
through the credential helper ([GitHub](github.md)).

Each driver also sets its own variables and removes those that would
move the harness from the subscription to metered API billing
([Drivers](#drivers)). A secret of a removed name granted to the
agent for other work stays out of the harness and of the commands it
runs.

The harness's own permission prompts are off. The container is the
boundary, and nobody is there to approve
([Security register](../architecture/security-register.md)).

### Progress

Each poll reads at most 256 KiB of the log. A progress line is one
normalised event: the harness starting, the first line of each
assistant message, and each tool use or file change as `<tool>:
<first line of its command, path, pattern, URL, description, or
query>`. A poll returns at most 60 lines, the earlier ones counted as
`… N more steps`.

Each line passes redaction with the run's secret values, GitHub
tokens included, and is cut at 240 characters. The orchestrator
publishes them on the run's SSE stream as `tool.progress`
(`{run_id, tool_call_id, lines, session_id}`). Progress is not
stored: the call's result and its log are.

The orchestrator keeps the running call in the run's
`metadata.harness_task` (`call_id`, `harness`, `repository`,
`session_id`, `log_path`), updated once `poll` reports the session
id, so a call that ends without a result still names its session.

### Sessions

Session ids are the harness's own: Claude Code's session id, Codex's
thread id, Cursor's chat id, each read from the first event that
carries it. Each harness keeps its session state in the agent's home
(`~/.claude`, `~/.codex`, `~/.cursor`), so a session survives
container recreation and counts against `max_workspace_mib`. A
session from an earlier run can be resumed when the agent kept its
id, in Memory or a note. A resumed session whose state is gone fails
with the harness's error, and the agent starts a new session with a
full brief.

### Lifecycle

- `code_task` blocks the generation for the length of the harness
  turn. The generation stays open, so the machine's idle timer does
  not run.
- A `code_task` is one tool call against `max_tool_calls`. Tool calls
  in a generation run in sequence: an agent runs one harness at a
  time.
- Before the start and each poll, a GitHub token within 10 minutes
  of expiry is replaced, as before a `shell` command.
- An orchestrator restart cuts the generation short. On startup, each
  `code_task` left unresolved in an active run gets `stop` on its
  machine when the machine is running, then an `interrupted` result
  naming its session id and log when known. A harness never keeps
  running with nobody polling it.
- A machine restart or container recreation ends the harness with
  everything else in the container. The next poll finds no state and
  the call ends `interrupted`, with the session id when known.
- After an interruption, the working tree holds whatever the harness
  wrote, and the task's start checkpoint stays in the repository.
  The agent can resume the session to finish the work.

### Credentials and errors

The harness runs on the operator's subscription, first found wins:

| Harness | Secret granted to the agent | Login in the agent's CLI tab |
| --- | --- | --- |
| Claude Code | `CLAUDE_CODE_OAUTH_TOKEN`, a long-lived token from `claude setup-token` | `claude`, then `/login`, stored in `~/.claude/.credentials.json` in the home |
| Codex | none | `codex login --device-auth`, a ChatGPT login stored in `~/.codex/auth.json`. An `auth.json` holding only an API key is no credential |
| Cursor | `CURSOR_API_KEY` | `NO_OPEN_BROWSER=1 agent login`, stored in `~/.config/cursor/auth.json` |

A token reaches the harness as every granted secret reaches a
command: in its environment. A login persists in the agent's home.
When a call runs on a login, the agent's `harness_logins` records
when it was last seen, which Settings shows
([Guilds and agents](../concepts/guilds-and-agents.md#configuration-and-appearance)).
Organisation model keys never enter the sandbox.

A call with no credential is an error naming the fix: the secret to
grant, or the login to run in the CLI tab. An agent with `cli` off has
no CLI tab, and only the secret is offered: Codex, which has no
secret, cannot run for it.

A CLI missing from the image is an error naming it. The runtime
image always installs Codex, pinned by `CODEX_VERSION`. Claude Code
(`CLAUDE_CODE_VERSION`) and the Cursor CLI (`CURSOR_VERSION`, a
release tarball checksum-verified per architecture) are proprietary:
they are installed when the build argument `HARNESSES` names them
(default `claude-code cursor`). The published image is built with
`HARNESSES` empty, as it is built with Chromium, so Codex is its one
harness ([Operate](../getting-started/operate.md)). The image lists
the harness CLIs it carries in `/usr/local/share/guilds/harnesses`.

A driver that parses none of its CLI's output fails the call with
the CLI's version.

Harness calls record no usage or cost: the subscription bills
nothing per call.

### Drivers

A driver turns a call into a command line, and the CLI's event log
into progress lines and a result. Each one is pinned to the CLI
version the image installs.

| Harness | Command | Resume | Prompt | Driver environment |
| --- | --- | --- | --- | --- |
| Claude Code | `claude -p --output-format stream-json --verbose --dangerously-skip-permissions --setting-sources "" --strict-mcp-config --disable-slash-commands --settings '{"disableAllHooks": true, "enableAllProjectMcpServers": false, "autoMemoryEnabled": false, "enabledPlugins": {}}'` | `--resume <session id>` | stdin | Sets `IS_SANDBOX=1` (commands run as root, and Claude Code bypasses permissions as root only with it), `DISABLE_AUTOUPDATER=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. Removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` |
| Codex | `codex exec --json --dangerously-bypass-approvals-and-sandbox --ignore-user-config --ignore-rules --disable memories --disable hooks --disable plugins --disable apps --disable in_app_updates -c mcp_servers={} -c notify=[] -c check_for_update_on_startup=false -c analytics.enabled=false -c otel.exporter="none" -` | `codex exec resume … <thread id> -` | stdin (`-`) | Removes `CODEX_API_KEY`, `OPENAI_API_KEY` |
| Cursor | `agent -p --force --trust --output-format stream-json "Read your task in <prompt file> and follow it."` | `--resume=<chat id>` | the prompt file, named on its command line | none |

The Cursor CLI reads no prompt on stdin, so its command line names the
prompt file in the agent's home; the prompt itself never appears on a
command line.

A turn ends:

- for Claude Code, at its `result` event: an error when `is_error` or
  a subtype other than `success`
- for Codex, at `turn.completed`, or `turn.failed` with its error.
  An `error` event alone, such as a reconnect, does not end it
- for Cursor, at its `result` event. Its `result` joins every
  assistant message; the final message is the last one

### Managed configuration

The agent is the only source of a harness's state: the brief, the
notes it appends, and the session it resumes. Each driver passes its
harness the configuration above through flags and environment
variables on every call, and loads no configuration of its own from
the agent's home: Claude Code loads no settings source
(`--setting-sources ""`), Codex no `config.toml` or rules
(`--ignore-user-config`, `--ignore-rules`).

Before every call, `start` removes the harness's local configuration
and memory from the agent's home, whoever wrote it (the agent's own
commands, the CLI tab, or an earlier harness turn):

| Harness | Removed before each call |
| --- | --- |
| Claude Code | `~/.claude/` `settings.json`, `settings.local.json`, `CLAUDE.md`, `CLAUDE.local.md`, `rules/`, `hooks/`, `plugins/`, `skills/`, `commands/`, `agents/`, `output-styles/`, and each project's `memory/` under `projects/` |
| Codex | `~/.codex/` `AGENTS.md`, `AGENTS.override.md`, `skills/`, `prompts/`, `rules/`, `memories/` and its `memories_*.sqlite` databases, `hooks.json` |
| Cursor | `~/.cursor/` `hooks.json`, `hooks/`, `mcp.json`, `rules/`, `skills/`, `commands/`, `agents/`, `plugins/` |

What stays is what a call needs and nothing it is configured by: the
logins and account state (`~/.claude.json`,
`~/.claude/.credentials.json`, `~/.codex/auth.json`,
`~/.config/cursor/auth.json`), which are never touched, and the
harness's session transcripts and thread records, which `session_id`
resumes. Memory is off as well as removed: Claude Code's auto-memory
(`CLAUDE_CODE_DISABLE_AUTO_MEMORY`, `autoMemoryEnabled: false`) and
Codex's memories feature. A repository's files are never changed.

Claude Code also reads `/etc/claude-code/managed-settings.json`, baked
into the image, which sets `disableAllHooks` and
`enableAllProjectMcpServers: false`. No user or project file
overrides it.

A repository's own harness configuration (`.claude/`, `.mcp.json`,
`.codex/`, `.cursor/`) is repository content, versioned with it.
Instruction files (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules`) are
read. Executable configuration is turned off where the harness
allows:

| Harness | Project hooks, plugins, MCP |
| --- | --- |
| Claude Code | Off: no settings source is loaded, `--strict-mcp-config` loads no MCP server the call does not pass, skills are off, and the managed settings turn hooks off |
| Codex | Off: hooks, plugins, apps, and execution-policy rules are off, and `mcp_servers` is empty |
| Cursor | An MCP server needs `--approve-mcps`, which the driver never passes. Project hooks in `.cursor/hooks.json` run: the CLI has no switch to turn them off ([SEC-31](../architecture/security-register.md#sec-31--cursor-runs-a-repositorys-hooks)) |

What stays on is recorded in the
[Security register](../architecture/security-register.md).

**Metadata.** Beside the fields every tool call records: `harness`,
`status`, `session_id`, `repository`, `exit_code`, `duration_ms`,
`files_changed`, `insertions`, `deletions`, `start_sha`, `end_sha`,
and `log_path`.

```text
GET /api/runs/:id/tasks/:call_id/diff    the call's start..end, at most 256 KiB
```

The diff runs `guilds-code diff` with `task` on the agent's machine,
waking it as the CLI tab does, and is redacted with the agent's
secret values. A call without an end checkpoint is 404.
