# Harnesses

A harness is the coding CLI that writes the code for a
[coding agent](index.md): Claude Code, Codex, Cursor, or Antigravity.
It runs headless in the agent's sandbox, in one of the guild's
[repositories](repositories.md), on the operator's own subscription.
The agent picks one harness, and optionally the model it runs and the
effort it runs it at. Each [code task](code-tasks.md) is one turn of
that harness.

The harness runs on a credential the agent has: a subscription token
granted to it as a [secret](../secrets.md), or a login made in its
**CLI** tab and stored in its [home](../agent-home.md). The
organisation's [model keys](../model-keys.md) never reach the sandbox.

## Why it exists

Harnesses are tuned for code work: they read a codebase, edit many
files, and run commands far faster than a general agent loop. Many
operators already pay for one. Running it on that subscription keeps
code work off the organisation's model bill: a harness call records no
usage or cost.

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
A token or login on the agent's machine is readable by what runs there
([SEC-27](../../architecture/security-register.md#sec-27--harness-subscription-tokens-and-logins-are-readable-on-the-agents-machine)).

### The harness check

A check asks the machine whether the harness's CLI is installed, its
version, and the credential it would run on. It runs:

- at every generation start of a coding run, with the run's secrets;
- before every code task;
- from Settings, with **Check login**. That check runs outside any
  run, without the agent's secrets, so it finds a login or nothing.

A check that finds a login records when it saw it and whose it is,
when the login says. The coding strip and Settings show both. A check
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
unavailable in the app, and a coding run on it fails at start.

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
- A coding run of an agent still on it fails at start with
  `harness.off` and the same message. A code task fails the same way.
- "no harness is picked" names only the harnesses that are on.
- Recipe validation warns with `harness.off` for a role on it: apply
  asks for another harness ([Applying recipes](../applying-recipes.md)).

A name in `HARNESSES_OFF` that is not a harness stops the box from
starting. The coding readiness warning and the coding strip do not
show a harness turned off.

### Managed configuration

The agent is the only source of a harness's state: the brief, the
notes it appends, and the session it resumes. Before every call, the
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

The create dialog's **Harness** step and the **Harness** section of a
coding agent's Settings show the same choice:

- **Harness**: a button with its logo for each harness the box offers,
  **Claude Code** (Anthropic), **Codex** (OpenAI), **Cursor** (Cursor),
  and **Antigravity** (Google). A harness the machine's image lacks is
  greyed and marked "Not on machine".
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

### Subscription, when creating

Under the harness, the create dialog's **Subscription** group sets the
credential:

- For Claude Code, a segmented choice: **Paste token**, **Use saved
  secret**, or **Log in via CLI**. A pasted token is labelled
  **Subscription token**, with the placeholder "Run claude setup-token
  and paste the result".
- For Cursor: **Paste API key** or **Use saved secret**. A pasted key is
  labelled **Cursor API key**.
- **Use saved secret** offers a **Subscription token** select over the
  secrets reaching the guild, "read as" the harness's variable.
- **Log in via CLI** shows "No secret needed now. After creation,
  open `<Harness>`'s CLI tab and authenticate."
- For Codex and Antigravity, a card, **CLI Login Required**:
  "`<Harness>` runs on `<account>`. Once the agent is created, log in
  from its CLI tab." The account reads "your ChatGPT subscription" for
  Codex and "your Google account" for Antigravity.

A pasted token is saved, once the agent exists, as a secret granted to
the new agent alone, with a description of what it is for. It is named
after the variable, or `<VARIABLE>_<AGENT_NAME>` when a secret of the
variable's name already reaches the guild. `<AGENT_NAME>` is the
agent's name upper-cased, with each run of other characters turned
into `_`. The agent's `secret_aliases` then point the variable at that
name. A saved secret picked in the select is written as the alias in
the same way.

### Harness section of Settings

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
  could not be checked. Without a granted token, it says how to set one
  up: choose a subscription token above, or log in from the **CLI** tab
  with the harness's login command. When a login was seen, it starts
  with "Runs on its login, last seen `<when>`." A granted token reads
  "Runs on the secret `<name>`", with "as `<variable>`" when it is
  another name.
- **Check login**, shown when the harness has no granted secret,
  wakes the machine and looks for the login in the agent's home. It
  toasts "Logged in as `<account>`", "Login found" when the login does
  not say whose it is, "No login found", or "The harness isn't in this
  machine's image".

When the stored harness is one the machine's image lacks, a warning
replaces all of this: "This machine's image doesn't carry `<Harness>`,
so its code tasks fail. Pick another harness, or move the agent to a
machine that has it."

## Rules and limits

| Rule | Value or behaviour |
| --- | --- |
| Harnesses | `claude-code`, `codex`, `cursor`, `antigravity` |
| Harness | Only for coding agents, and required on them |
| Harness turned off | Not offered, refused as a new pick, and a run on it fails at start |
| Harness model | Up to 120 characters: letters, digits, and `. _ : / = , [ ] -`, starting with a letter or digit; blank saves as null; needs a harness |
| Harness effort | One the model runs at; blank saves as null; needs a harness |
| Credential order | The token variable first, then a login in the home |
| Codex credential | A ChatGPT login only; an `auth.json` holding only an API key is no credential |
| Antigravity credential | A Google sign-in only |
| Organisation model keys | Never in the sandbox |
| Usage and cost | None recorded for harness calls |
| Image | Codex always; Claude Code, Cursor, and Antigravity when built with them |
| Harness configuration in the home | Removed before every call; logins and sessions kept |

## Reference

### Configuration

- `harness`: `claude-code`, `codex`, `cursor`, `antigravity`, or null.
  Rules and errors are in [Coding agents](index.md#configuration-keys).
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

`GET /api/harnesses` returns `{ harnesses }`, the catalogue for any
signed-in user. Each entry holds `harness`, `label`, `enabled` (false
when the box turns it off), `models`, and `unlisted_efforts`: the
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
| `repositories` | The names of the guild repositories a coding run clones |
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
| Antigravity | A sign-in token file under `~/.gemini/antigravity-cli/` | Not read: always null |

The account is null when the file does not say.

### Credentials and errors

No credential is an error naming the fix: the secret to grant, with
the variable it is read as when an alias names another secret, and the
login to run. For example, "Claude Code has no credential: grant the
secret TEAM_TOKEN (read as CLAUDE_CODE_OAUTH_TOKEN) to the agent, or
log in from the agent's CLI tab with `claude, then /login`". At a
generation's start it is the run error `harness.credential`.

A CLI missing from the image is "`<Harness>` is not installed in this
machine's image", with the fix: "rebuild the runtime image, which
always installs it" for Codex, "build the runtime image with HARNESSES
naming `<harness>`" for the others. At a generation's start it is
`harness.not_installed`. A check that fails to run is `harness.check`.

A harness the box turns off is `harness.off`
([Turning a harness off](#turning-a-harness-off)).

A driver that parses none of its CLI's output fails the call, naming
the CLI's version ([Result](code-tasks.md#result)).

### Image build

| Build argument | Default | Role |
| --- | --- | --- |
| `HARNESSES` | `claude-code cursor antigravity` | The proprietary harnesses to install; any other name fails the build |
| `CODEX_VERSION` | `0.162.1` | Codex, installed with npm, always |
| `CLAUDE_CODE_VERSION` | `2.1.296` | Claude Code, installed with npm |
| `CURSOR_VERSION` | `2026.10.01-e373342` | The Cursor CLI release tarball, checksum-verified per architecture |
| `ANTIGRAVITY_VERSION` | `1.4.0-5281842794987520` | The Antigravity CLI release tarball, checksum-verified per architecture |

The published image is built with `HARNESSES` empty, as it is built
with Chromium. To build an image with Codex alone:

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
stays in place for code tasks and the CLI tab alike.

Claude Code also reads `/etc/claude-code/managed-settings.json`, baked
into the image. It sets `disableAllHooks` and
`enableAllProjectMcpServers: false`. No user or project file overrides
it.

### Drivers

A driver in `runtime/guilds-harness` turns a call into a command line,
and the CLI's event log into progress lines and a result. Each one is
pinned to the CLI version the image installs.

| Harness | Command | Model and effort | Resume | Prompt |
| --- | --- | --- | --- | --- |
| Claude Code | `claude -p --output-format stream-json --verbose --dangerously-skip-permissions --setting-sources "" --strict-mcp-config --disable-slash-commands --settings '{"disableAllHooks": true, "enableAllProjectMcpServers": false, "autoMemoryEnabled": false, "enabledPlugins": {}}'` | `--model <model>`, then `--effort <effort>`, before `--resume` | `--resume <session id>` | stdin |
| Codex | `codex exec --json --dangerously-bypass-approvals-and-sandbox --ignore-user-config --ignore-rules --disable memories --disable hooks --disable plugins --disable apps --disable in_app_updates -c mcp_servers={} -c notify=[] -c check_for_update_on_startup=false -c analytics.enabled=false -c otel.exporter="none" -` | `--model <model>`, then `-c model_reasoning_effort="<effort>"`, after the managed flags and before the thread id | `codex exec resume … <thread id> -` | stdin (`-`) |
| Cursor | `agent -p --force --trust --output-format stream-json "Read your task in <prompt file> and follow it."` | `--model <CLI name>`, the name for the effort; no effort apart | `--resume=<chat id>` | the prompt file, named on its command line |
| Antigravity | `agy --output-format stream-json --dangerously-skip-permissions --disable-slash-commands --add-dir <run folder> -p "Read your task in <prompt file> and follow it."` | `--model <model>`, then `--effort <effort>`, before `--conversation` | `--conversation <conversation id>` | the prompt file, named in `-p`; `--add-dir` lets the CLI's tools reach it outside the repository |

The orchestrator resolves the agent's model and effort through the
catalogue before the call: a listed Cursor model becomes its CLI name
for the effort. The model is passed as one argument. Without a model
or an effort, no flag is passed for it. `guilds-harness` checks the
model against the same rule as the configuration (`model is invalid`
otherwise), the effort against the efforts (`effort is invalid`), and
refuses an effort for Cursor (`cursor takes its effort in the model
name`), before the call starts. The Cursor and Antigravity CLIs read no
prompt on stdin, so their command line names the prompt file in the
agent's home; the prompt itself never appears on a command line.

Driver environment:

| Harness | Sets | Removes |
| --- | --- | --- |
| Claude Code | `IS_SANDBOX=1` (commands run as root, and Claude Code bypasses permissions as root only with it), `DISABLE_AUTOUPDATER=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` |
| Codex | none | `CODEX_API_KEY`, `OPENAI_API_KEY` |
| Cursor | none | none |
| Antigravity | none | `GEMINI_API_KEY`, `GOOGLE_GEMINI_BASE_URL`, `AGY_ADC_AUTH`, `AGY_LLM_GATEWAY_URL`, `AGY_ACCOUNT`, `GOOGLE_CLOUD_QUOTA_PROJECT`, `GOOGLE_CLOUD_LOCATION` |

The variables every harness loses, and the rest of its environment, are
in [Harness environment](code-tasks.md#harness-environment).

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
| Cursor | `~/.cursor/` `hooks.json`, `hooks/`, `mcp.json`, `rules/`, `skills/`, `commands/`, `agents/`, `plugins/` |
| Antigravity | `~/.gemini/` `GEMINI.md`, `AGENTS.md`, and under `config/`: `hooks.json`, `mcp_config.json`, `skills/`, `skills.json`, `plugins/`, `plugins.json`, `workflows/`, `workflows.json`, `global_workflows/`, `sidecars/` |

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

### Code

`apps/orchestrator/src/coding/harnesses.ts` (the harnesses, `HARNESSES_OFF`,
credential fixes), `apps/orchestrator/src/coding/harness-models.ts` (the
catalogue), `apps/orchestrator/src/http/coding-routes.ts` (routes),
`runtime/guilds-harness` (drivers), `runtime/agy`, `runtime/Dockerfile`,
and in the app `apps/web/src/features/agent/settings/configForm.tsx`,
`apps/web/src/features/agent/settings/HarnessReadiness.tsx`, and
`apps/web/src/features/agent/CreateCodingAgent.tsx`.
