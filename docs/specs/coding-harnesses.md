# Coding harnesses

Status: draft · Branch: `feat/coding-harness`

## Problem

The native coding agent is too slow to be usable. Its loop runs one
tool call at a time, each a full sandbox exec round trip, with no
sub-agents. Dedicated coding harnesses (Claude Code, Codex, Cursor)
are tuned for code work, and many users already pay for one of them.

## Goals

- A coding agent delegates code work to a harness that runs in its
  sandbox, against the guild's repositories. Every coding agent has a
  harness: the native editing and code-graph tools are removed.
- Users run the harness on their own subscription: Claude Code,
  Codex, Cursor.
- Every harness call leaves from the agent's machine, never from the
  orchestrator.
- The agent stays the lead. It reads notes, records, and Memory, and
  passes the harness what it needs. It answers the harness's
  questions or takes them to the operator.

## Non-goals

- Harness-level traceability: recording each model request, exact
  replay, per-call budgets inside the harness. The agent's run records
  the brief, the result, and the diff. That is the trace.
- Giving the harness notes, records, MCP connections, or other guild
  tools.
- Driving a harness's interactive TUI.
- A model gateway in the orchestrator.
- Organisation model keys in the sandbox. A harness runs only on the
  user's subscription, through a token granted to the agent or a login
  stored in its home.
- Harnesses on API model keys (OpenCode, Pi). One would be a new
  driver, billed per call against a key instead of a subscription.

## Shape

```text
operator ⇄ agent (native loop, org model)
              │  code_task(brief, notes, session_id?)
              ▼
        guilds-harness start | poll | result | stop   (sandbox)
              │  detached supervisor, CLI in its own process group
              ▼
        claude | codex | agent   →  repos/<name>
```

The harness is a tool. One `code_task` call is one headless harness
turn. The orchestrator starts the harness detached, polls it until it
exits, and returns the harness's final message, its session id, and
the diff it made.

## Agent configuration

Three keys join the agent's `config` (jsonb):

| Key | Values | Default |
|---|---|---|
| `harness` | `claude-code`, `codex`, `cursor` | none |
| `harness_model` | a model name, or null | null: the subscription's default |
| `secret_aliases` | a map of environment variable names to secret names | `{}` |

Validation:

- `coding: true` requires `harness` on create and on every update that
  touches `coding` or `harness`.
- `harness` requires `coding: true`.
- An update cannot turn `coding` off on a coding agent.
- `harness_model` is up to 120 characters of letters, digits, and
  `. _ : / = , [ ] -`, starting with a letter or digit: an alias
  (`opus`) or a full model name, with the bracketed parameters some
  harnesses take. A blank value is null. It requires `harness`.
- `secret_aliases` keys and values are variable names, a value differs
  from its key, and the map holds at most 32 entries. A stored map
  that does not validate reads as empty.

`secret_aliases` is generic: it is meant for every integration that
reads a fixed variable name, and the harness is its first user. In
the run's environment each alias holds the value of the secret it
names, when that secret reaches the agent, and wins over a secret of
its own name; an alias whose secret does not reach the agent is
absent. It lets each agent run its harness on its operator's own
token while secret names stay unique in the organisation.

A stored coding agent without `harness` is deprecated (see
[Deprecated coding agents](#deprecated-coding-agents)). No migration
writes one.

The harness runs `harness_model`, or its subscription's default
model when it is null. The driver passes it as `--model`, one
argument, and `guilds-harness` validates it again. `harness`,
`harness_model`, and `secret_aliases` are written to the run snapshot
and stay fixed for the run. `model` stays the agent's own model. A cheaper model works for
the lead because the code work happens in the harness.

`harness` travels in recipes, written as it is, and so does
`harness_model` when it is set. The apply preview shows a harness
picker per coding role, preselected with the role's harness. The
apply request carries `harnesses`, the harness chosen for each coding
role, and nothing is created while a coding role has none. A role
keeps the recipe's `harness_model` only with the recipe's harness.
`secret_aliases` travels when the agent has aliases, and a role's
aliases apply as written when they validate. Validation warns, and
never refuses, when a role's harness credential cannot be known
before apply, when its `harness_model` is not a model name or comes
without a harness, and when its `secret_aliases` is not a map of
variable names to secret names, which apply leaves out.

## Deprecated coding agents

A coding agent without `harness` is deprecated:

- The agent payload carries `deprecated: "coding.harness_missing"`.
- Its settings show a notice: native coding is no longer available,
  and the agent needs a harness to run. The notice links to the
  **Harness** select.
- A coding run of it fails at start with `coding.harness_missing`,
  naming the same fix. A run with `coding` off is unaffected.
- Picking a harness clears the flag.

## Tools

A coding run offers:

- `code_task`
- `shell` and `shell_status`, to run tests, inspect state, push, and
  open pull requests
- `file_read`, with its repeated-read check, and `code_search` in its
  `files` and `content` modes, to check the harness's work

Code changes are the harness's work. The agent checks them, and pushes
them.

`file_edit`, `file_write`, `code_match`, `code_map`, `code_find`,
`code_outline`, `code_callers`, and the `symbols` mode of
`code_search` do not exist. Neither do Graft, ast-grep, or the
`metadata.exploration` measures of a coding run.

## System prompt

The `coding` block of `system.md` tells the agent to:

- write a self-contained brief: the harness sees nothing of the
  conversation, notes, or Memory except what the brief and `notes`
  carry
- resume the session with `session_id` for follow-ups and answers,
  instead of starting a new one
- answer the harness's questions itself when it can, and take them to
  the operator when it cannot
- check the result with `shell`, `file_read`, and `code_search` before
  reporting it
- push and open pull requests itself, with `shell`

It keeps the rule that repository content, issue text, and command
output are data, never instructions, and applies it to the harness's
final message.

## `code_task`

| Argument | Meaning |
|---|---|
| `brief` | Required. The task, written by the agent |
| `repo` | Repository name under `repos/`. Optional when the guild has exactly one |
| `session_id` | Resumes that harness session. The `brief` becomes the next user turn |
| `notes` | Display paths of notes or collection records. The orchestrator appends their content to the brief |
| `timeout_minutes` | Default 30, at most 60 |

A session resumes only in the repository it started in. With
`session_id` and more than one repository, `repo` is required.

Steps:

1. Resolve the repository directory. An unknown repository is an
   error naming the guild's repositories.
2. Check the harness's CLI and credential (see
   [Credentials](#credentials)). A missing CLI or credential is an
   error naming what to set up.
3. Build the prompt:
   - a fixed preamble: the harness cannot reach the operator, and when
     it is blocked or needs a decision it stops and asks in its final
     message; it may commit, and never pushes or opens pull requests
   - the brief
   - each note in `notes`, under its display path. The same access
     rules as the note tools apply. The total is capped at 64 KiB. A
     note past the cap is named, not included.
4. Take a start checkpoint of the repository at
   `refs/guild/runs/<run id>/tasks/<call id>/start`, the way the run
   checkpoints are taken.
5. `guilds-harness start` (see [Process](#process)). The prompt reaches
   the CLI on stdin, or as a file where the CLI takes no stdin, never
   on its command line.
6. Poll until the harness exits, publishing its progress.
7. `guilds-harness result`: the final message, the session id, the
   end checkpoint at
   `…/tasks/<call id>/end`, and the diffstat.

Result text:

```text
<status> · <harness> · <repository> · session <session_id> · <duration>
<n> files changed, +<a> −<d>
<file list, at most 30>

<final message>

log: .runs/<run id>/<call id>.harness.jsonl
```

The final message is capped so the whole result fits
`CODE_RESULT_MAX_BYTES`. The cut keeps the end of the message,
because questions and summaries come last. The platform pipeline then
runs unchanged: redaction, the 64 KiB cap, and the
`remaining_tool_calls` trailer.

`status` is `completed`, `failed`, `timed_out`, `cancelled`, or
`interrupted`. A question from the harness is not a status: it is the
final message, and the agent decides what to do with it.

Tool-call metadata: `harness`, `session_id`, `repository`, `exit_code`,
`duration_ms`, `files_changed`, `insertions`, `deletions`, `start_sha`,
`end_sha`, `log_path`. Harness calls record no usage or cost: the
subscription bills nothing per call.

### Process

`guilds-harness` has four ops. Each is a short exec.

| Op | Does |
|---|---|
| `start` | Forks a supervisor in its own session and returns at once. The supervisor starts the CLI in its own process group in the repository directory, writes the CLI's raw events to the log, waits for it, and records its exit code. State: `/run/guilds/<agent id>/harness/<call id>.json` (pids, process group, log path, start time, exit code once known) |
| `poll` | Takes a byte offset into the log. Returns the normalised progress lines after it, the new offset, the session id once the harness has reported one, and whether the CLI has exited |
| `result` | Reads the log for the final message and the session id. Takes the end checkpoint and the diffstat |
| `stop` | SIGTERM to the CLI's process group, SIGKILL ten seconds later, and waits for the supervisor to record the exit |

The CLI's environment:

- the agent's secrets, `HOME`, `GUILDS_AGENT_HOME`, `PORT`, and
  `GUILDS_PORTS`, as every command gets today
- `GUILD_RUN_ID` and `GUILD_AGENT_ID`, so commit trailers work
- the driver's own variables, less the variables it removes (see
  [Drivers](#drivers))

`GH_TOKEN` is not set: the harness does not open pull requests. git
still reads the token through the credential helper.

The raw event log is `.runs/<run id>/<call id>.harness.jsonl` in the
home, unredacted, like a `shell` log. It follows the same retention:
`.runs/` keeps the folders of the agent's 20 most recent runs.

### Progress

The orchestrator polls every 3 seconds. A progress line is one
normalised event: a tool use, a file change, an assistant message.
Each line passes redaction with the run's secret values, GitHub tokens
included, and is published on the run's SSE stream as a
`tool.progress` event with the tool call's id.

The orchestrator keeps the session id with the running call as soon
as `poll` reports it, so a call that ends without a result still
names its session.

### Questions

A question ends the harness's turn. The answer resumes it.

1. The harness stops and asks in its final message.
2. The agent reads it in the `code_task` result. It answers from what
   it knows (notes, records, Memory, earlier conversation) with
   `code_task(session_id, brief: <answer>)`.
3. When it cannot answer:
   - in a direct run, it asks the operator in its reply and resumes
     the session once the operator answers
   - in a group- or schedule-triggered run, it posts the question with
     `group_post` when that binding is on, otherwise it states the
     question in its final message

### Sessions

Session ids are harness-specific. Each harness keeps its session state
in the agent's home (`~/.claude`, `~/.codex`, `~/.cursor`), so
sessions survive container
recreation. A session from an earlier run can be resumed when the
agent kept its id, in Memory or a note.

A resumed session whose state is gone (home cleared, harness upgraded
past a format change) fails with the harness's error. The agent then
starts a new session with a full brief.

Session state grows in the home and counts against
`max_workspace_mib`.

### Lifecycle

- `code_task` blocks the generation for the length of the harness
  turn. The generation stays open, so the machine's idle timer does
  not run.
- Past `timeout_minutes`, the orchestrator runs `stop`. The status is
  `timed_out`. The session usually stays resumable.
- Cancelling the generation runs `stop`. The status is `cancelled`.
- Each poll replaces the GitHub tokens when one is within 10 minutes
  of expiry, as `shell` does before a command. The credential helper
  reads the token file on each use.
- An orchestrator restart cuts the generation short. On startup, each
  `code_task` left unresolved in an active run gets `stop` on its
  machine, then an `interrupted` result naming its session id and log
  when known. A harness never keeps running with nobody polling it.
- A machine restart or container recreation kills the harness with
  everything else in the container. The next poll finds no state and
  the call ends `interrupted`, with the session id when known.
- After an interruption, the working tree holds whatever the harness
  wrote. The task's start checkpoint stays in the repository. The
  agent can resume the session to finish the work.
- A `code_task` is one tool call against `max_tool_calls`.
- Tool calls in a generation run in sequence, so an agent runs one
  `code_task` at a time.

### Errors

A missing or rejected credential names what to set up:

- the secret to grant, with the variable it is read as when an alias
  names another secret (see [Credentials](#credentials)), or
- the login to run in the agent's CLI tab (`claude`, then `/login`;
  `codex login --device-auth`; `NO_OPEN_BROWSER=1 agent login`).
  Every agent has the CLI tab.

A CLI missing from the image is an error naming the image to build.
A version the driver does not parse is `failed` with that reason.

### Run start

A coding run checks at every generation start, before the model is
called, that its code tasks can run:

1. Before the machine is woken: a snapshot without `harness` fails
   with `coding.harness_missing`, and a guild without repositories
   (the list the clone uses) with `coding.repositories_missing`.
2. Once the machine is up and the workspace check passes:
   `guilds-harness check` with the run's secrets. A missing CLI fails
   with `harness.not_installed`, no credential with
   `harness.credential`, both naming the fix, and a check that cannot
   run with `harness.check`.
3. Then the repositories are prepared.

`code_task` checks again before each turn, since a credential can
lapse during a run.

## Drivers

A driver turns a `code_task` into a command line and an event log into
progress lines and a result. Each one lives in `guilds-harness` and is
pinned to a CLI version in `runtime/Dockerfile`. The flags and
configuration keys below must be confirmed against the pinned version
when the driver is written.

| Harness | Command | Resume | Driver environment |
|---|---|---|---|
| Claude Code | `claude -p --output-format stream-json --verbose --dangerously-skip-permissions --setting-sources user --strict-mcp-config --settings <managed> [--model <model>]` | `--resume <session id>` | Sets `IS_SANDBOX=1`: commands run as root (SEC-6), and Claude Code refuses to bypass permissions as root without it. Removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_BASE_URL` |
| Codex | `codex exec --json --dangerously-bypass-approvals-and-sandbox -c <managed>… [--model <model>]` | `codex exec resume <session id>` | Removes `CODEX_API_KEY` and `OPENAI_API_KEY` |
| Cursor | `agent -p --force --trust --output-format stream-json [--model <model>]` | `--resume=<chat id>` | none |

A removed variable is one that would switch the harness from the
subscription to metered API billing. A secret of that name granted to
the agent for other work stays out of the harness's environment, and
out of the commands the harness runs.

Each harness's own sandbox and approval prompts are off. The container
is the boundary, and nobody is there to approve.

The session id is read from the first event that carries it, so `poll`
can report it while the harness runs.

### Credentials

| Harness | Credential, first found wins |
|---|---|
| Claude Code | The variable `CLAUDE_CODE_OAUTH_TOKEN` (a token from `claude setup-token`), or a login in the home |
| Codex | `~/.codex/auth.json` from a ChatGPT login in the home |
| Cursor | The variable `CURSOR_API_KEY`, or a login in the home |

The token variable reads the secret of its own name, or the secret
`secret_aliases` maps it to, so an agent runs on a token stored under
any name that reaches it.

A user brings a subscription in one of two ways:

- a long-lived token stored as a secret and granted to the agent, for
  Claude Code and Cursor
- an interactive login in the agent's CLI tab, for all three. Every
  harness can print a login URL that the user opens in their own
  browser. The login is stored in the agent's home and persists.

A token reaches the harness the way every granted secret reaches a
command: in its environment. Organisation model keys never enter the
sandbox.

Settings shows, per coding agent, whether its harness has credentials.
A granted secret of the name the token variable reads is known from
the orchestrator.
A credential file in the home is checked at each run start and each
`code_task`, and from Settings on demand, outside any run and without
the agent's secrets. A login found is recorded with its account, as
the harness stored it in the home. Settings shows when a login was
last seen; a check that finds no credential forgets it.

## Managed configuration

Each driver passes the harness its configuration through flags and
environment variables, from `guilds-harness`, on every call. It does
not rewrite files in the home. Files that hold logins and account
state (`~/.claude.json`, `~/.claude/.credentials.json`,
`~/.codex/auth.json`, Cursor's login) are never written.

The configuration sets:

- permissions open, telemetry and auto-update off where the harness
  has a switch
- no hooks, no MCP servers, no plugins

Claude Code also reads `/etc/claude-code/managed-settings.json`, baked
into the image. No user or project file can override it. It turns
hooks off.

Project-level configuration inside a repository (`.claude/`,
`.mcp.json`, `.codex/`, `.cursor/`, `AGENTS.md`) is repository
content. Instruction files (`CLAUDE.md`, `AGENTS.md`) are
read. Executable configuration is turned off where the harness allows:

| Harness | Project hooks, plugins, MCP |
|---|---|
| Claude Code | Off: `--setting-sources user`, `--strict-mcp-config`, managed settings |
| Codex | Off where `-c` overrides reach them |
| Cursor | Confirmed against the pinned version |

What stays on is recorded in the security register.

## Runtime image

- `@openai/codex`, pinned by npm version in `runtime/Dockerfile`.
- Graft and ast-grep are not installed.
- Claude Code (`@anthropic-ai/claude-code`) and the Cursor CLI are
  proprietary. They are installed under a build argument, as Chrome
  is: an image that is published is built without them, and their
  drivers then fail with the CLI missing. Codex is the one harness of
  a published image.
- The image lists the harness CLIs it carries in
  `/usr/local/share/guilds/harnesses`. A machine reports that list when
  its container starts, and the machine record keeps it. The Cursor CLI has no npm
  package: it is pinned by a versioned download URL and a checksum per
  architecture, as `ttyd` and `gh` are.
- `/etc/claude-code/managed-settings.json`.
- A new helper, `runtime/guilds-harness`, in the style of
  `guilds-code`: base64 JSON request (through the request directory
  past 64 KiB), one base64 JSON envelope on stdout.

## Web app

- Agent settings: a **Harness** select, required when Coding is on.
  A harness whose CLI the agent's machine does not carry is shown
  unavailable, with a note: a published image carries Codex only, and
  Claude Code and Cursor need an image built with them. Before the
  machine has first started, every harness is shown with that note.
  A **Harness model** field under it, empty for the subscription's
  default, with suggestions where the harness has aliases. A
  credential status line, with a link to the CLI tab when a login is
  possible. For a harness with a token variable: a **Subscription
  token** select among the secrets reaching the agent, the variable's
  own secret or a login by default, which writes `secret_aliases`,
  and an **Add a token** button that adds a secret granted to this
  agent alone and picks it. A **Check login** button, which says
  whose login it found. The guild's repositories, or a warning that
  it has none.
- The create dialog: a first screen choosing an agent or a coding
  agent. A coding agent is created in four steps: its identity; its
  machine, harness, and harness model, with the subscription token
  the harness runs on, one of the guild's secrets or a token pasted
  and saved as a secret granted to the new agent alone; the lead
  model, its capabilities, and its limits; and the guild's
  repositories, a GitHub login connected and picked from the dialog
  or a URL added, with a way to create without one.
- The agent header: a warning icon, leading to Settings, while a
  coding agent's runs would fail at start: the image lacks its
  harness, the harness has no credential, or the guild has no
  repositories.
- The chat's coding strip, under the tab strip of a coding agent
  with a harness: which model leads, which harness and model code,
  what the harness runs on (the secret and who added it, or the
  login's account and when it was last seen), and the repositories,
  each a link to where it is set. A missing piece names itself and
  turns the strip ochre.
- The deprecation notice on a coding agent without a harness.
- Run view: a `code_task` card with live progress from
  `tool.progress`, the final message, the diffstat linking to the
  task's diff, and the log path.
- `GET /api/runs/:id/tasks/:call/diff` serves the task's start..end
  diff, redacted, with the same limits as the run diff.
- `GET /api/agents/:id/harness` serves the agent's harness, its
  model, the harnesses its machine carries, the guild repositories a
  coding run clones, and each harness's credentials: its token
  variable, the secret that variable reads, whether that secret
  reaches the agent, whether an alias shadows a secret of the
  variable's own name, and when a login was last found in the home
  and whose it is.
  `POST /api/agents/:id/harness/check` wakes the machine and runs
  `guilds-harness check` for one harness, returning the login's
  account with its result.

## Security

Each of these gets an entry in
`docs/architecture/security-register.md` when it ships:

- Subscription tokens and harness logins sit in the agent's home and
  environment. Every agent on the machine can read them (SEC-24).
- Harnesses run with permissions bypassed. Content the harness reads
  can steer its commands (SEC-8), with the agent's secrets in its
  environment.
- A repository can carry project-level harness configuration. Where a
  harness cannot turn it off, its hooks or plugins run.
- Use of personal subscriptions inside a shared organisation may fall
  outside the vendor's terms. The settings copy says so.

SEC-9 (Graft's hosted features) is marked fixed: Graft is no longer in
the image. SEC-8's `Where` names `code_task` and the harness.

## Compatibility

- Existing coding agents have no `harness`. They become deprecated
  and stop running coding work until a harness is picked.
- Task prompts or Memory that name a removed tool keep naming it. The
  model sees only the tools a run offers.
- A recipe with `harness` or `harness_model` is refused, as carrying
  an unknown key, by a version without it. A recipe without it applies, and its coding
  roles take the harness chosen in the apply preview.

## Delivery

1. Config keys, `guilds-harness` with its four ops, `code_task` with
   the Claude Code driver, progress streaming, restart handling, the
   `harness` prompt block, the run view card, managed configuration,
   docs and security register.
2. Codex and Cursor drivers.
3. Removal of the native code tools, Graft, and ast-grep; deprecated
   coding agents; the image's harness list and the unavailable state
   in Settings; `docs/tools-and-connectors/code.md` rewritten.

The branch merges after step 3, so a published image always carries a
harness for its coding agents.

Each driver gets a contract test against a stub CLI that replays a
recorded event stream, and a live test that runs when its credential
is in the environment. `guilds-harness` gets tests for stop, timeout,
and a supervisor that outlives its orchestrator.
