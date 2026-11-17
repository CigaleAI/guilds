# Harnesses

A harness is the coding CLI a
[subscription agent](../agents.md#model-source) runs every turn on, as
its model source instead of a model: Claude Code, Codex, Cursor, or
Antigravity. It runs headless in the agent's sandbox, in the agent's
home or in the guild's [repositories](repositories.md) the agent picks
([Code work](index.md)), on the operator's own subscription.
The agent picks one harness, and optionally the model it runs and the
effort it runs it at.

The harness runs on a credential the agent has: a subscription token
granted to it as a [secret](../secrets.md), or a login made in its
**CLI** tab and stored in its [home](../agent-home.md). The
organisation's [model keys](../model-keys.md) never reach the sandbox.

## Why it exists

Harnesses are tuned for code work: they read a codebase, edit many
files, and run commands far faster than a general agent loop. Many
operators already pay for one. Running it on that subscription keeps
the agent's turns off the organisation's model bill: a turn records
its tokens at no price.

## How it works

### The four harnesses

| Harness | CLI | Token secret | Login in the CLI tab |
| --- | --- | --- | --- |
| Claude Code | `claude` | `CLAUDE_CODE_OAUTH_TOKEN`, a long-lived token from `claude setup-token` | `claude`, then `/login` |
| Codex | `codex` | none: Codex runs on a ChatGPT login | `codex login --device-auth` |
| Cursor | `agent` | `CURSOR_API_KEY` | `NO_OPEN_BROWSER=1 agent login` |
| Antigravity | `agy` | none: Antigravity runs on a Google sign-in | `agy`, then sign in with Google |

### Credentials

A harness runs on the first credential it finds: the token in its
variable, then a login in the agent's home.

- **A token** reaches the harness the way every granted secret
  reaches a command: in its environment. The variable reads the secret
  of its own name, or the secret the agent's `secret_aliases` point it
  at. So `{ "CLAUDE_CODE_OAUTH_TOKEN": "TEAM_TOKEN" }` runs Claude Code
  on the secret `TEAM_TOKEN`. Each agent can run on its own operator's
  token while secret names stay unique in the organisation
  ([Secrets](../secrets.md)).
- **A login** is made once in the agent's **CLI** tab. It stays in the
  agent's home, across idle stops and container replacement.

Each driver also removes the variables that would move its harness off
the subscription, such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or
`GEMINI_API_KEY` ([Drivers](#drivers)). A secret of such a name granted
to the agent for other work stays out of the harness and of the
commands it runs.

A subscription is often personal. In an organisation, everyone who
can start the agent's runs uses it. Whether that complies with the
vendor's terms is the operator's call
([SEC-30](../../architecture/security-register.md#sec-30--personal-harness-subscriptions-used-inside-a-shared-organisation-may-fall-outside-the-vendors-terms)).
Whether Google's terms for an Antigravity sign-in allow it to run
every turn of a subscription agent is an open question the operator
answers before picking it.
A token or login on the agent's machine is readable by what runs there
([SEC-27](../../architecture/security-register.md#sec-27--harness-subscription-tokens-and-logins-are-readable-on-the-agents-machine)).

### The harness check

A check asks the machine whether the harness's CLI is installed, its
version, and the credential it would run on. It runs:

- at every generation start of a subscription agent's run, with the
  run's secrets;
- from Settings, with **Check login**. That check runs outside any
  run, without the agent's secrets, so it finds a login or nothing.

A check that finds a login records when it saw it and whose it is,
when the login says. Settings shows both. A check
that finds no credential at all forgets the login.

### Model and effort

`harness_model` is the model the harness runs. Empty means the default
of the subscription. It is one of the harness's listed models, or a
custom name: an alias or a full model name, with the bracketed
parameters some harnesses take. A model the subscription does not offer
fails the turn with the harness's own error.

`harness_effort` is how hard the model reasons: `none`, `minimal`,
`low`, `medium`, `high`, `xhigh`, `max`, or `ultra`. Empty leaves it to
the model's default. It must be an effort the model runs at:

- a listed model runs at the efforts the catalogue names for it;
- the subscription's default model or a custom name runs at any effort
  the harness takes: `low` to `max` on Claude Code and Antigravity,
  every effort on Codex, and none on Cursor, whose model names carry
  their effort.

Both are copied into each run's snapshot and stay fixed for that run.
Settings lists each harness's models from a catalogue
([Model catalogue](#model-catalogue)).

### Harnesses in the image

The runtime image always installs Codex. Claude Code, the Cursor CLI,
and the Antigravity CLI are proprietary, so they are installed only
when the image is built with them. `./setup.sh` builds an image with
all four. The published image carries Codex only.

When a machine's container is created, the platform reads which
harness CLIs its image carries. A harness the image lacks is shown as
unavailable in the app, and a run on it fails at start.

### Turning a harness off

The box can turn harnesses off with `HARNESSES_OFF`
([Configure](../../operations/configure.md)). A harness turned off
stays in the runtime image, but it is not offered and not run:

- Settings and the create dialog do not offer it. An agent already on
  it still sees it, marked **Turned off**.
- A create or update that picks it anew is refused with 422
  "`<Harness>` is turned off on this box: pick another harness in the
  agent's Settings". An agent already on it keeps it until it picks
  another.
- A run of an agent still on it fails at start with `harness.off` and
  the same message.
- "no harness is picked" names only the harnesses that are on.
- Recipe validation warns with `harness.off` for a role on it: apply
  asks for another harness ([Applying recipes](../applying-recipes.md)).

A name in `HARNESSES_OFF` that is not a harness stops the box from
starting. The Settings readiness banner does not show a harness turned
off.

### Subscription agents

A subscription agent has no model: its harness is its model source
([Agents](../agents.md#model-source)). It names the harness, its
model, and its effort in `harness`, `harness_model`, and
`harness_effort`. It may pick repositories, which its turns work in
([Repositories](repositories.md#what-a-generation-does-with-them)).

- Each harness runs a subscription agent's turns: each generation of
  its run is one turn of the CLI in the agent's home, or in its one
  repository, on the run's system prompt, resuming the run's session
  ([Runs](../runs.md#harness-turns)). The CLI is given the
  orchestrator's MCP server for that one call ([Drivers](#drivers))
  and calls the run's Guilds tools there, beside its own.
- Claude Code and Codex take the run's system prompt in place of
  their own. Cursor and Antigravity keep their vendor's system prompt,
  which the operator does not control, and read the run's as rules
  beside it, so they run a subscription agent only with a repository:
  an agent that does code work
  ([SEC-67](../../architecture/security-register.md#sec-67--cursor-and-antigravity-run-a-subscription-agents-turn-under-their-vendors-own-system-prompt)).
  A create or update of such an agent without one is refused, and a
  run of one whose repositories are all gone fails at start
  ([Agents](../agents.md#configuration-keys)).
- A harness turned off with `HARNESSES_OFF` is refused as a new pick.

### Managed configuration

The agent's run is the only source of a harness's state: the run's
system prompt, its messages, and the session it resumes. Before every call, the
harness's own configuration and memory are removed from the agent's
home, whoever wrote them: the agent's commands, the CLI tab, or an
earlier turn. Each call then passes the harness its configuration
through flags, environment variables, or a settings file the driver
writes. Memory is off as well as removed.

What stays is what a call needs: the logins and account state, and the
session transcripts a resumed session reads. A repository's files are
never changed.

A repository's own harness files are repository content. Instruction
files such as `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, and
`.cursor/rules` are read. Executable configuration such as hooks,
plugins, and MCP servers is turned off where the harness allows it.
Cursor has no switch to turn off a repository's hooks, so they run
([SEC-31](../../architecture/security-register.md#sec-31--cursor-runs-a-repositorys-hooks)).
Antigravity has no switch to ignore a repository's `.agents/`,
`GEMINI.md`, and `AGENTS.md`, so they load
([SEC-29](../../architecture/security-register.md#sec-29--a-repository-can-carry-configuration-its-coding-harness-loads)).

The harness's permission prompts are off. Nobody is there to approve,
and the container is the boundary
([SEC-28](../../architecture/security-register.md#sec-28--a-coding-harness-runs-with-its-permission-prompts-off)).

## In the app

### Picking a harness

The create dialog's **Model** step, with **Model source** on
**Subscription**, and the **Harness** section of a subscription agent's
Settings show the same choice:

- **Harness**: a button with its logo for each harness the box offers,
  **Claude Code** (Anthropic), **Codex** (OpenAI), **Cursor** (Cursor),
  and **Antigravity** (Google). A harness the machine's image lacks is
  greyed and marked "Not on machine". For a subscription agent that
  picks no repository, Cursor and Antigravity are greyed and marked
  "Needs a repository", with a line under the buttons: "Cursor and
  Antigravity keep their own system prompt, so they run a subscription
  agent only with a repository." A subscription agent already on one
  of them that picks none shows that line, for its harness, as the
  harness's error, and cannot save.
- **Harness model**, once a harness is picked: a select of
  "Subscription default", the harness's listed models by name with
  their id beneath, and "Custom…". Its hint reads "Custom takes any
  model name the subscription offers." **Custom…** shows a **Model
  name** field. A stored model the catalogue does not list opens on
  Custom.
- **Effort**, under the model, while the model runs at any effort: a
  select of "Default (`<effort>`)" for a listed model with a default
  effort, else "Harness default", then the model's efforts (None,
  Minimal, Low, Medium, High, Extra high, Max, Ultra). Its hint reads
  "How hard the model reasons before it answers." Picking a model that
  does not run at the effort set puts it back to the default. A stored
  effort the model does not run at shows "This model doesn't run at
  that effort. Pick another." Cursor shows no effort for a custom name
  or a model that takes none.
- Picking another harness clears the model and the effort.
- A note, "A published image carries Codex only; Claude Code, Cursor,
  and Antigravity need an image built with them.", while the machine's
  image lacks a harness, or before its container first started. Until
  then every harness is available.
- A note, "Tasks run on your own subscription. Ensure shared use
  complies with your vendor plan."

### Harness section of Settings

A subscription agent's Settings have **Identity**, **Harness**,
**Machine**, and **Repositories**. Its **Harness** section starts with **Model source**, to
move it to a model on a key, then the harness buttons, with the
harness's model and effort, then **Agent
capabilities** and **Run limits** without the model loop's: max steps, max tool calls, max wake-ups, and **Max scripts**.
A subscription agent that is not ready opens on the banner "The
subscription isn't ready", listing what its harness lacks.

Under the harness buttons, Settings shows what the harness still
needs:

- **Subscription token**, for Claude Code and Cursor: which secret the
  variable reads. Its first option is the default: "`<variable>`
  (default)" when a secret of that name reaches the agent, else "None:
  log in from the CLI tab". Then every other secret reaching the agent,
  by name, each with "Added by `<name>`". Picking one writes the alias;
  the default removes it. The choice is saved with **Save**.
- **Add token** beside it opens **Add a secret** granted to this agent,
  the name prefilled with the variable, or `<VARIABLE>_<AGENT_NAME>`
  when the agent already has that name, and the description with what
  the token is for. The new secret is picked on success.
- "Replaces the `<variable>` that also reaches this agent." when an
  alias is set and a secret of the variable's own name also reaches the
  agent.
- A credential card with a badge: **Active token** or **Logged in**
  with "Ready for code tasks", else **Setup needed** with
  "Authentication required", or **Check failed** when the credentials
  could not be checked. A granted token shows the badge alone. Without
  one, the card says how to set one up: choose a subscription token
  above, or log in from the **CLI** tab with the harness's login
  command. When a login was seen, it starts with "Runs on its login,
  last seen `<when>`."
- **Check login**, shown when the harness has no granted secret,
  wakes the machine and looks for the login in the agent's home. It
  toasts "Logged in as `<account>`", "Login found" when the login does
  not say whose it is, "No login found", or "The harness isn't in this
  machine's image".

When the stored harness is one the machine's image lacks, a warning
replaces all of this: "This machine's image doesn't carry `<Harness>`,
so its turns fail. Pick another harness, or move the agent to a
machine that has it."

## Rules and limits

| Rule | Value or behaviour |
| --- | --- |
| Harnesses | `claude-code`, `codex`, `cursor`, `antigravity` |
| Harness | Only for subscription agents, and required on them |
| Subscription harness | Any of the four; Cursor and Antigravity only with a repository |
| Subscription agents | Each generation one turn of its harness of at most the agent's `max_turn_minutes`, 30 by default, polled every second |
| Harness turned off | Not offered, refused as a new pick, and a run on it fails at start |
| Harness model | Up to 120 characters: letters, digits, and `. _ : / = , [ ] -`, starting with a letter or digit; blank saves as null; needs a harness |
| Harness effort | One the model runs at; blank saves as null; needs a harness |
| Credential order | The token variable first, then a login in the home |
| Codex credential | A ChatGPT login only; an `auth.json` holding only an API key is no credential |
| Antigravity credential | A Google sign-in only |
| Organisation model keys | Never in the sandbox |
| Usage and cost | A subscription agent's turn records its tokens on its reply, at no price ([Usage](../usage.md#cost-of-a-harness-turn)) |
| Image | Codex always; Claude Code, Cursor, and Antigravity when built with them |
| Harness configuration in the home | Removed before every call; logins and sessions kept |

## Reference

### Configuration

- `harness`: `claude-code`, `codex`, `cursor`, `antigravity`, or null.
  Rules and errors are in [Code work](index.md#configuration-keys) and
  [Agents](../agents.md#configuration-keys).
- `harness_model`: matches
  `^[A-Za-z0-9][A-Za-z0-9._:/=,[\]-]{0,119}$`, or null. A blank value
  saves as null. Otherwise 422 `harness_model must be a model name: up
  to 120 letters, digits, and . _ : / = , [ ] -`. Without a harness:
  422 `harness_model needs a harness`.
- `harness_effort`: one of `none`, `minimal`, `low`, `medium`,
  `high`, `xhigh`, `max`, `ultra`, or null. A blank value saves as
  null. Otherwise 422 `harness_effort must be one of: none, minimal,
  …`. Without a harness: 422 `harness_effort needs a harness`. An
  effort the model does not run at: 422
  `harness_effort must be one of <efforts> for <model>`, or
  `harness_effort: <model> takes no effort on <harness>` for a model
  that takes none. The default model reads as "the default model".

### Model catalogue

`apps/orchestrator/src/coding/harness-models.ts` lists the models
Settings offers for each harness, with the efforts each runs at and the
effort it gets when none is set.

| Harness | Listed models | Efforts |
| --- | --- | --- |
| Claude Code | `fable`, `opus`, `sonnet`, `haiku` | `low` to `max`; the harness's default without one |
| Codex | `gpt-6-luna`, `gpt-5.6-terra`, `gpt-5.6-luna` | `low` to `max`, and `ultra` for `gpt-5.6-terra`; `medium` without one |
| Cursor | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | `none`, then `low` to `max`; `medium` without one |
| | `claude-fable-5-1`, `claude-fable-5-1-thinking` | `low` to `max`; `high` without one |
| | `claude-opus-5-5` | `low` to `max`; `medium` without one |
| | `grok-4.7` | `low` to `xhigh`; `medium` without one |
| | `composer-2.5` | none |
| Antigravity | none | `low` to `max` for the default model or a custom name |

Claude Code, Codex, and Antigravity take the effort apart from the
model name. Cursor names a model and its effort together, so a listed
Cursor model maps each effort to the CLI name it starts under
(`claude-opus-5-5` at `high` starts as `claude-opus-5-5-high`), and
without an effort it starts under the name for its default effort.
Cursor's fast variants are not listed; they run as custom names.

### HTTP

```text
GET  /api/harnesses
GET  /api/agents/:id/harness
POST /api/agents/:id/harness/check
```

`GET /api/harnesses` returns `{ harnesses }` for any signed-in user:
the catalogue. Each entry holds `harness`, `label`, `enabled`
(false when the box turns it off), `needs_repository` (whether a
subscription agent on it needs a repository), `models`, and
`unlisted_efforts`: the
efforts the default model or a custom name runs at. Each model holds
`id`, `label`, `efforts`, and `default_effort` (null leaves it to the
harness). The CLI names a Cursor model starts under stay on the server.

`GET /api/agents/:id/harness` returns what the harness still needs:

| Field | Meaning |
| --- | --- |
| `harness` | The agent's harness, or null |
| `harness_model` | Its model, or null |
| `harness_effort` | Its effort, or null |
| `machine_harnesses` | The harness CLIs the agent's machine carries; null until its container first started |
| `repositories` | The names of the repositories the agent's generations clone, on a key or a subscription: those it picks and can use, in its order |
| `usable_repositories` | The names of the repositories the agent can use ([Repositories](repositories.md#an-agents-picks)) |
| `harnesses` | One entry per harness, below |

Each entry of `harnesses`:

| Field | Meaning |
| --- | --- |
| `harness`, `label` | Its id and name |
| `secret` | The variable it reads its token from; null for Codex and Antigravity |
| `secret_source` | The secret that variable reads: the one `secret_aliases` maps it to, else its own name; null without a `secret` |
| `secret_granted` | Whether `secret_source` reaches the agent |
| `secret_shadowed` | Whether an alias is set and a secret of the variable's own name also reaches the agent |
| `login` | What to run in the CLI tab to log in |
| `login_seen_at` | When a check last found a login in the agent's home |
| `login_account` | Whose login it is; null when the login does not say |

`POST` takes `{ harness }`; an unknown one is 422, and 503 when
generation is unavailable or the check fails. It wakes the agent's
machine and runs `guilds-harness check` outside any run, without the
agent's secrets. It returns `{ installed, version, credential,
account }`, where `credential` is `login` or null. It records a login
it finds, and removes the entry when the CLI is installed and no login
is found.

### Login records

`agents.harness_logins` keeps, per harness, `{ seen_at, account }`. A
value that is not an object reads as no login. A check that finds a
login sets both. A check that finds no credential at all removes the
entry. A check that finds a granted secret leaves it.

The account is read from the agent's home:

| Harness | Credential files | Account |
| --- | --- | --- |
| Claude Code | `~/.claude/.credentials.json` | `oauthAccount.emailAddress` in `~/.claude.json` |
| Codex | `~/.codex/auth.json` holding `tokens`, or `$CODEX_HOME/auth.json` | The `email` claim of `tokens.id_token`, decoded without checking its signature |
| Cursor | `~/.config/cursor/auth.json`, or under `$XDG_CONFIG_HOME` | `email` in that file |
| Antigravity | `~/.gemini/antigravity-cli/antigravity-oauth-token` | Not read: always null |

The account is null when the file does not say.

### Credentials and errors

No credential is an error naming the fix: the secret to grant, with
the variable it is read as when an alias names another secret, and the
login to run:

```text
<Harness> has no credential: grant the secret <secret> (read as <variable>) to the agent, or log in from the agent's CLI tab with `<login>`
```

The "(read as …)" part shows only when an alias names another secret.
Codex and Antigravity have no secret, so their fix names the login
alone. At a generation's start it is the run error
`harness.credential`.

A CLI missing from the image is "`<Harness>` is not installed in this
machine's image", with the fix: "rebuild the runtime image, which
always installs it" for Codex, "build the runtime image with HARNESSES
naming `<harness>`" for the others. At a generation's start it is
`harness.not_installed`. A check that fails to run is `harness.check`.

A harness the box turns off is `harness.off`
([Turning a harness off](#turning-a-harness-off)).

A driver that parses none of its CLI's output fails the call, naming
the CLI's version.

### Image build

| Build argument | Default | Role |
| --- | --- | --- |
| `HARNESSES` | `claude-code cursor antigravity` | The proprietary harnesses to install; any other name fails the build |
| `CODEX_VERSION` | `0.169.0` | Codex, installed with npm, always |
| `CLAUDE_CODE_VERSION` | `2.1.326` | Claude Code, installed with npm |
| `CURSOR_VERSION` | `2026.11.13-eacade1` | The Cursor CLI release tarball, checksum-verified per architecture |
| `ANTIGRAVITY_VERSION` | `1.5.10-5253791805734912` | The Antigravity CLI release tarball, checksum-verified per architecture |

`node scripts/update-harnesses.mjs` moves the four versions to each
vendor's latest release: it rewrites them, and the tarball checksums of
the Cursor and Antigravity CLIs, in `runtime/Dockerfile` and in the
table above. The image's build then installs each CLI and runs it, and
the check runs the turns recorded from them. A machine runs the new
CLIs once its sandbox starts from the new image.

The published image is built with `HARNESSES` empty, and with
`BROWSER=chromium`. To build an image with Codex alone:

```text
docker build --build-arg HARNESSES= --tag agent-runtime:0.4 runtime/
```

The image lists the CLIs it carries in
`/usr/local/share/guilds/harnesses`, one per line. The orchestrator
reads it when it creates a machine's container and keeps it on the
machine's row as `harnesses`.

The Antigravity binary sits under `/opt/antigravity/<version>` and
starts through the `agy` wrapper (`runtime/agy`). Before every start,
the wrapper marks the CLI's update check as just done, in
`~/.gemini/antigravity-cli/last_check.timestamp`, so the pinned binary
stays in place for the agent's turns and the CLI tab alike.

Claude Code also reads `/etc/claude-code/managed-settings.json`, baked
into the image. It sets `disableAllHooks`,
`enableAllProjectMcpServers: false`, and `DISABLE_AUTOUPDATER=1`, so
the pinned CLI stays in place for the agent's turns and the CLI tab
alike. No user or project file overrides it.

### Drivers

A driver in `runtime/guilds-harness` turns a call into a command line,
and the CLI's event log into progress lines and a result. Each one is
pinned to the CLI version the image installs.

| Harness | Command | Model and effort | Resume | Prompt |
| --- | --- | --- | --- | --- |
| Claude Code | `claude -p --output-format stream-json --verbose --dangerously-skip-permissions --setting-sources "" --strict-mcp-config --disable-slash-commands --settings '{"disableAllHooks": true, "enableAllProjectMcpServers": false, "autoMemoryEnabled": false, "enabledPlugins": {}}'` | `--model <model>`, then `--effort <effort>`, then `--max-turns <n>`, before `--resume` | `--resume <session id>` | stdin |
| Codex | `codex exec --json --dangerously-bypass-approvals-and-sandbox --ignore-user-config --ignore-rules --disable memories --disable hooks --disable plugins --disable apps --disable in_app_updates -c mcp_servers={} -c notify=[] -c check_for_update_on_startup=false -c analytics.enabled=false -c otel.exporter="none" -` | `--model <model>`, then `-c model_reasoning_effort="<effort>"`, after the managed flags and before the thread id | `codex exec resume … <thread id> -` | stdin (`-`) |
| Cursor | `agent -p --force --trust --output-format stream-json "Read your task in <prompt file> and follow it."` | `--model <CLI name>`, the name for the effort; no effort apart | `--resume=<chat id>` | the prompt file, named on its command line |
| Antigravity | `agy --output-format stream-json --input-format stream-json --dangerously-skip-permissions --disable-slash-commands` | `--model <model>`, then `--effort <effort>`, before `--conversation` | `--conversation <conversation id>` | stdin, one stream-json message: `{"event": "user", "message": {"content": "<prompt>"}}` |

A request with a `system_prompt` writes it with mode 0600, and
`result` removes it with the call's state, the prompt file too:

| Harness | The file | How the CLI reads it |
| --- | --- | --- |
| Claude Code | `<run folder>/<call id>.system.md` | `--system-prompt-file <file>`, after `--settings` and before the model; it replaces the CLI's own system prompt |
| Codex | `<run folder>/<call id>.system.md` | `-c model_instructions_file="<file>"`, after the managed flags and before the model; it replaces Codex's base instructions |
| Cursor | `~/.cursor/rules/guilds.mdc`, the text after a front matter of `description` and `alwaysApply: true` | a user rule that applies wherever the CLI runs, on top of Cursor's own system prompt |
| Antigravity | `~/.gemini/GEMINI.md` | a global rule, on top of Antigravity's own system prompt |

Cursor's and Antigravity's files sit where each CLI reads its own
rules in the home, outside every repository's working tree, so no
repository's `git status` shows them. The removal before each call,
listed below, clears that place first, and clears it again when a call
ended without `result`. Antigravity caps one rules file at
24,000 bytes and cuts a longer one at a line.

A request with an `mcp_url` and its `mcp_token` gives the CLI one
HTTP MCP server, `guilds`, at that URL, with the token as its
`Authorization: Bearer` header, and no other. `start` writes a file
with mode 0600, and `result` removes it with the call's state:

| Harness | The file, and what it holds | Command line, after the system prompt |
| --- | --- | --- |
| Claude Code | `<run folder>/<call id>.mcp.json`: `mcpServers.guilds`, the URL and the header | `--mcp-config <file>`; with `--strict-mcp-config` it is the only MCP server the call uses |
| Codex | `<run folder>/<call id>.mcp.json`: the URL and the token | `-c mcp_servers.guilds.url="<url>" -c mcp_servers.guilds.bearer_token_env_var="GUILDS_MCP_TOKEN" -c shell_environment_policy.exclude=["GUILDS_MCP_TOKEN"]`, after `-c mcp_servers={}`, which drops every other server |
| Cursor | `~/.cursor/mcp.json`: `mcpServers.guilds`, its `url` and the header | none: the CLI reads its user configuration, which needs no approval |
| Antigravity | `~/.gemini/config/mcp_config.json`: `mcpServers.guilds`, its `serverUrl` and the header | none: the CLI reads its MCP configuration |

Cursor and Antigravity read an MCP configuration only in the home,
never from a path a call names, so theirs sits there for the call; the
removal before each call clears what any earlier call or the agent left
there. Claude Code, Cursor, and Antigravity read the token from the
file. Codex reads it from
`GUILDS_MCP_TOKEN`, which the supervisor sets from the file in the
CLI's own environment alone, never its own or `guilds-harness`'s, and
which Codex leaves out of the commands its model runs. Codex's
configuration in the home holds no server: the overrides last one
call. The URL must be an `http` or `https` URL with no query, the
token 43 to 128 URL-safe base64 characters, and each comes with the
other (`mcp_url is invalid`, `mcp_token is invalid`, `mcp_url and
mcp_token go together` otherwise). The orchestrator sends such a
request through a request file, never on the command line, and the
token is on no command line and in no environment the CLI's commands
inherit.

A request with a `max_turns`, a count of 1 or more, starts Claude Code
with `--max-turns <n>`, which ends its turn after that many model
calls with the result subtype `error_max_turns`; `result` then says
`max_turns: true`. Codex, Cursor, and Antigravity have no such limit
and refuse one (`<harness> takes no turn limit`), and a value that is
not a whole number of 0 or more is refused (`max_turns is invalid`),
before the call starts.

The orchestrator resolves the agent's model and effort through the
catalogue before the call: a listed Cursor model becomes its CLI name
for the effort. The model is passed as one argument. Without a model
or an effort, no flag is passed for it. `guilds-harness` checks the
model against the same rule as the configuration (`model is invalid`
otherwise), the effort against the efforts (`effort is invalid`), and
refuses an effort for Cursor (`cursor takes its effort in the model
name`), before the call starts. The Cursor CLI reads no prompt on
stdin, so its command line names the prompt file in the agent's home;
the prompt itself never appears on a command line.

Driver environment:

| Harness | Sets | Removes |
| --- | --- | --- |
| Claude Code | `IS_SANDBOX=1` (commands run as root, and Claude Code bypasses permissions as root only with it), `DISABLE_AUTOUPDATER=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` |
| Codex | none | `CODEX_API_KEY`, `OPENAI_API_KEY` |
| Cursor | none | none |
| Antigravity | none | `GEMINI_API_KEY`, `GOOGLE_GEMINI_BASE_URL`, `AGY_ADC_AUTH`, `AGY_LLM_GATEWAY_URL`, `AGY_ACCOUNT`, `GOOGLE_CLOUD_QUOTA_PROJECT`, `GOOGLE_CLOUD_LOCATION` |

The variables every harness loses, and the rest of its environment, are
in [Harness environment](#harness-environment).

A turn ends:

- for Claude Code, at its `result` event: an error when `is_error` is
  true or its subtype is other than `success`;
- for Codex, at `turn.completed`, or `turn.failed` with its error. An
  `error` event alone, such as a reconnect, does not end it;
- for Cursor, at its `result` event. Its `result` joins every
  assistant message, so the final message is the last one;
- for Antigravity, at its `result` event: an error when its status is
  other than `SUCCESS`.

A log that ends without such an event is an error, "the harness ended
without a result".

Session ids are the harness's own: Claude Code's session id
(`session_id`), Codex's thread id (`thread_id` of `thread.started`),
Cursor's chat id (`session_id`), Antigravity's conversation id
(`conversation_id`), each read from the first event that carries it.

Claude Code loads no settings source (`--setting-sources ""`), and
Codex no `config.toml` or rules (`--ignore-user-config`,
`--ignore-rules`). Cursor and Antigravity have no switch to ignore the
configuration in the home, so they rely on what `start` removes.

Before every call, `start` removes from the agent's home, whoever wrote
it:

| Harness | Removed before each call |
| --- | --- |
| Claude Code | `~/.claude/` `settings.json`, `settings.local.json`, `CLAUDE.md`, `CLAUDE.local.md`, `rules/`, `hooks/`, `plugins/`, `skills/`, `commands/`, `agents/`, `output-styles/`, and each project's `memory/` under `projects/` |
| Codex | `~/.codex/` `AGENTS.md`, `AGENTS.override.md`, `skills/`, `prompts/`, `rules/`, `memories/` and its `memories_*.sqlite` databases, `hooks.json` |
| Cursor | `~/.cursor/` `hooks.json`, `hooks/`, `mcp.json`, `rules/`, `skills/`, `commands/`, `agents/`, `plugins/`; and the rules Cursor reads in every folder above the one it runs in: `AGENTS.md`, `CLAUDE.md`, and `CLAUDE.local.md` in the home and in `~/repos/`, and `~/repos/.cursor/rules/` |
| Antigravity | `~/.gemini/` `GEMINI.md`, `AGENTS.md`, and under `config/`: `GEMINI.md`, `AGENTS.md`, `rules/`, `hooks.json`, `mcp_config.json`, `skills/`, `skills.json`, `plugins/`, `plugins.json`, `workflows/`, `workflows.json`, `global_workflows/`, `sidecars/` |

A path whose link resolves outside the home is left alone. The logins
and account state (`~/.claude.json`, `~/.claude/.credentials.json`,
`~/.codex/auth.json`, `~/.config/cursor/auth.json`, the Antigravity
sign-in) are never touched, nor the session transcripts and thread
records that `session_id` resumes. Memory is off as well as removed:
Claude Code's auto-memory (`CLAUDE_CODE_DISABLE_AUTO_MEMORY`,
`autoMemoryEnabled: false`) and Codex's memories feature.

After the removal, `start` writes Antigravity's
`~/.gemini/antigravity-cli/settings.json` over whatever the home holds:
`toolPermission` and `artifactReviewPolicy` are `always-proceed`,
`useG1Credits` is false, so no paid credit is spent past the plan, and
`enableTelemetry` and `showFeedbackSurvey` are false.

A repository's own harness configuration (`.claude/`, `.mcp.json`,
`.codex/`, `.cursor/`, `.agents/`) is versioned with it:

| Harness | Project hooks, plugins, MCP |
| --- | --- |
| Claude Code | Off: no settings source is loaded, `--strict-mcp-config` loads no MCP server the call does not pass, skills are off, and the managed settings turn hooks off |
| Codex | Off: hooks, plugins, apps, and execution-policy rules are off, and `mcp_servers` is empty |
| Cursor | An MCP server needs `--approve-mcps`, which the driver never passes. Project hooks in `.cursor/hooks.json` run: the CLI has no switch to turn them off ([SEC-31](../../architecture/security-register.md#sec-31--cursor-runs-a-repositorys-hooks)) |
| Antigravity | A repository's `.agents/`, `GEMINI.md`, and `AGENTS.md` load: the CLI has no switch to ignore them |

What a repository can still steer is recorded in
[SEC-29](../../architecture/security-register.md#sec-29--a-repository-can-carry-configuration-its-coding-harness-loads).

### Process

`guilds-harness` runs one short exec per op. The request is base64
JSON on the command line, carrying the op, its arguments, the run id,
the agent id, the call id, and the result's byte cap. A request whose
encoding passes 64 KiB, and a request that holds a credential, such as
a start that gives the turn its MCP server, is written through the
sandbox file API to `/run/guilds/requests/<run id>-<call id>.json`
instead, and the helper reads and deletes it. Only root reads
`/run/guilds`. The helper answers with one base64 JSON envelope,
`{ ok, text, meta }` or `{ ok: false, error }`. Each op waits up to 60
seconds.

| Op | Does |
| --- | --- |
| `check` | Whether the harness's CLI is installed, its version, its credential (`secret`, `login`, or none), and with a login its `account` |
| `start` | Refuses a call id still running, removes the harness's local configuration, writes the prompt file and, when the request gives one, the system prompt file, forks a supervisor in its own session, and returns |
| `poll` | The raw events after a byte offset into the log as whole lines, their progress lines, the new offset, the session id once the harness has reported one, and whether the CLI has exited and its log is read through |
| `result` | The final message, the session id, the exit code, whether the turn ended in error, the error, the tail of the CLI's stderr, and the duration |
| `stop` | SIGTERM to every process of the turn, SIGKILL ten seconds later to each one left until none is, then waits for the supervisor to record the exit. It answers that the call stopped only once no process of the turn is left |

The supervisor starts the CLI in its own process group in
`repos/<repo>`, or in the agent's home when the request names no
repository, appends the CLI's raw events to the log, and waits for it.
Once the CLI exits, by itself or stopped, the supervisor ends every
process of the turn still running, as `stop` does, and then records
the CLI's exit code. So `poll` and `result` see the CLI exit only once
nothing the turn started runs.

A turn's processes are every process its CLI started, and every one
those started in turn, whatever session or process group each moved
to. The supervisor is the turn's child subreaper (Linux's
`PR_SET_CHILD_SUBREAPER`): a process whose parent exits is handed to
the supervisor rather than to the container's init, so it stays below
the supervisor. `stop` and the supervisor find the turn's processes by
walking `/proc` down from the supervisor, and add the CLI's process
group. `stop` walks from a pid only while `/proc/<pid>/cmdline` shows
it supervising that call, so a pid the system gave to another process
is never taken for the supervisor. The CLI tab, the browser, and other
agents' turns, which the orchestrator starts apart from the turn, are
not below the supervisor and are never signalled.

Two kinds of process are not below the supervisor, and keep running
until the container stops: one that a command of the turn has another
running service start, and every process of a turn whose supervisor
was killed. Outside Linux, as in the orchestrator's tests on macOS, a
turn's processes are its CLI's process group.

A call's state is under `/run/guilds/<agent id>/harness/` (mode 0700),
which goes with the container: `<call id>.json` (what was started),
`.pid` (the CLI's process group), `.exit`, `.session`, and `.stderr`.
`result` removes them and the prompt files once the CLI has exited.

The raw event log, `.runs/<run id>/<call id>.harness.jsonl` in the
agent's home, is stored unredacted. `.runs/` keeps the folders of the
agent's 20 most recent runs, so the log of an older run is gone.

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
harness's environment: the harness opens a pull request with its
provider's connector tool. git still reads its token through the
credential helper ([Tokens](repositories.md#tokens)). Each driver also
sets its own variables and removes those that would move the harness
off the subscription ([Drivers](#drivers)).

### Sessions

Session ids are the harness's own ([Drivers](#drivers)). Each harness
keeps its session state in the agent's home (`~/.claude`, `~/.codex`,
`~/.cursor`, `~/.gemini`), so a session survives container recreation
and counts against `max_workspace_mib`. A run keeps the session its
latest turn reported, and its next turn resumes it
([Runs](../runs.md#harness-turns)).

### Code

`apps/orchestrator/src/coding/harnesses.ts` (the harnesses, the ones
the box turns off, how each takes a subscription agent's system
prompt and whether it therefore needs a repository, its MCP tool
prefix and turn limit, credential fixes),
`apps/orchestrator/src/coding/harness-models.ts` (the catalogue),
`apps/orchestrator/src/config/index.ts` (reading `HARNESSES_OFF`),
`apps/orchestrator/src/toolbox/harness-setup.ts` (the harness checks
and their errors), `apps/orchestrator/src/generation/coding.ts` (the
check at a generation's start and from Settings, and the login
records), `apps/orchestrator/src/generation/run-review.ts` (the harness
view), `apps/orchestrator/src/http/coding-routes.ts` (routes),
`runtime/guilds-harness` (drivers), `runtime/agy`,
`runtime/claude-code-managed-settings.json`, `runtime/Dockerfile`, and
in the app `apps/web/src/features/agent/harness.ts`,
`apps/web/src/features/agent/settings/HarnessFields.tsx`,
`apps/web/src/features/agent/settings/HarnessReadiness.tsx`,
`apps/web/src/features/agent/settings/credentialNote.ts`, and
`apps/web/src/features/agent/settings/ModelSourceField.tsx`.
