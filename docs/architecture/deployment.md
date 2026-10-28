# Deployment and trust boundary

One Node process is the control plane. It serves the operator app.
It owns every run. It is the only process that talks to the model
providers, OpenSandbox, and PostgreSQL.

Agent code runs in OpenSandbox containers built from `runtime/`, one
per machine of an organisation, each shared by the agents placed on
it. Each machine has a persistent directory on the host, with one
home per agent. Durable application state is PostgreSQL.

How the process works inside is [Orchestrator](orchestrator.md).
Where each module lives is the [Code map](code-map.md).

## Process model

One Node process (`apps/orchestrator`) owns HTTP, generation,
tools, MCP, OAuth, Studio, Builder, and recipes:

- one HTTP server
- one in-memory generation registry (at most one generation per agent)
- one schedule ticker
- one group dispatcher per active guild
- one in-process event bus
- process-local notes, script-catalog, and lifecycle mutexes
- organisation admission for ordinary runs, Studio, and Builder together

The service runs as one process: no Node cluster mode and no
Compose replicas. Locks, generation tasks, dispatch, and
cancellation are process-local. Artifact writes use PostgreSQL
transactions.

Identity resolution is one module behind `AUTH_MODE`:

- `compat-cookie` (whoever reaches the port)
- `trusted-header` (the email an authenticating proxy sends)

An extension built on core may add a mode of its own with an identity
provider for it ([Extension points](extension-points.md)).
Cross-organisation and non-member access returns 404.

## State on disk

`STATE_ROOT` is one absolute host path (`.state` in the checkout
unless `.env` says otherwise). It holds the host-side trees:

- `workspaces/`: the **sandbox** tree: one directory per machine id,
  bind-mounted at `/home` in that machine's container, with one home
  per agent on it (`workspaces/<machine id>/<agent id>`, which the
  agent sees as `/home/<agent id>`). A home holds packages and
  scratch, materialised `scripts/` (canonical source is the
  agent-level `script` artifact rows), and `.browser/` for the
  Chromium profile. OpenSandbox may mount only this prefix
  (`allowed_host_paths`).
- `postgres/`: the Compose Postgres data directory.
- `opensandbox/`: the OpenSandbox server's SQLite lifecycle store.
- `notes/`: `NOTES_ROOT`. The file-backed `NotesStore`
  (`src/notes/store.ts`) resolves `system.md` here. The artifact
  store and `schedules.instruction` are canonical. The tree is
  required to exist at boot.
- `attachments/`: `ATTACHMENTS_ROOT`. Chat images, one file per
  attachment under its organisation's directory.
- `connectors/`: `CONNECTORS_ROOT`. The code of registry connectors
  installed with adapter code
  ([Connector registry](../tools-and-connectors/connector-registry.md)).

The path is absolute because OpenSandbox bind-mounts each machine
directory by that same path. `make state` creates the trees. `./setup.sh`
writes the path into `.env`.

Notes, collection records, `memory`, and scripts are artifact rows.
`task` is a column on the agent. Display paths are the unique
reference
([Artifacts](../concepts/artifacts.md#display-paths)):

```text
org/<org_id>/agents/<agent_id>/task.md
org/<org_id>/agents/<agent_id>/memory.md
org/<org_id>/agents/<agent_id>/history-archive/<stamp>-<source>.md
org/<org_id>/agents/<agent_id>/scripts/<name>
org/<org_id>/agents/<agent_id>/<note>.md
org/<org_id>/guilds/<guild_id>/<note>.md
org/<org_id>/collections/<name>
org/<org_id>/collections/<name>/<id>
org/<org_id>/<note>.md
```

The Host Finder lists notes over HTTP. A laptop or phone sees
current Markdown. Scripts appear on the agent's State Scripts view,
not in Files. Collection records appear on the Tables page.
Agents never mount artifact rows. Orchestrator tools read and write
them.

Shared standing identity is `system.md` in `TEMPLATES_ROOT`
(`apps/orchestrator/src/prompts/` by default). The agent's home on
its machine is its own. Deleting an agent removes that home, so
durable findings have to be in the artifact store first.

Homes are id-keyed so a reused name gets a fresh home. Display paths
use organisation, guild, and agent ids for the same reason.

## Compose stacks and images

| Target | Files | Services |
| --- | --- | --- |
| `docker compose up` | `docker-compose.yml` | postgres, opensandbox, orchestrator on the core image: the stack as shipped ([Install](../getting-started/install.md)). Only the orchestrator is published, on `127.0.0.1:8080` |
| `make up` (dev) | `docker-compose.dev.yml` = `docker-compose.yml` + `docker-compose.watch.yml` | The same three, with the development overlay |

The stack mounts the Docker socket. Sandboxes are containers it
starts beside itself.

`./setup.sh` builds two images on the host (`scripts/images.sh`):

- the OpenSandbox server from its pinned commit
  (`guilds-opensandbox-server:<commit>`)
- `agent-runtime:0.4`, which every machine runs, from `runtime/`

The orchestrator service runs the core image
(`apps/orchestrator/Dockerfile`, `guilds-orchestrator:local`).
`docker-compose.yml` builds it from the checkout. A `web` stage
builds `apps/web` and Storybook. The final stage copies `src`,
`scripts`, `drizzle`, and that build.

A version tag publishes the orchestrator, runtime, and OpenSandbox
server images on ghcr.io (`.github/workflows/images.yml`). That
runtime carries Chromium and none of the proprietary coding
harnesses.

The extending repository's image is this Dockerfile built in its
workspace, plus its own package
([Extension points](extension-points.md)).

Core reaches sandboxes through one
[`RunSandboxes`](../../apps/orchestrator/src/sandbox/index.ts)
manager on `OPENSANDBOX_URL`. An extension can supply a provider of
its own.

The sandbox profile is the `opensandbox-config` in
`docker-compose.yml`:

- the Docker provider on `runc`
- one sandbox and one persistent directory per machine, one home per
  agent in it
- dropped capabilities (`AUDIT_WRITE`, `MKNOD`, `NET_ADMIN`,
  `NET_RAW`, `SYS_ADMIN`, `SYS_MODULE`, `SYS_PTRACE`, `SYS_TIME`,
  `SYS_TTY_CONFIG`)
- `no_new_privileges`
- `pids_limit` 4096
- CPU and memory limits per sandbox, set by the machine's tier

### Development overlay

`docker-compose.watch.yml` adds what the shipped file leaves out.

It publishes Postgres at `127.0.0.1:5432`. It bind-mounts `src/`,
`scripts/`, and `drizzle/` into the orchestrator container. `tsx
watch` restarts the orchestrator when its source or a migration
changes, and boot applies a new migration.

It also accepts the all-zero master key the Makefile gives a
development stack (`ALLOW_ZERO_MASTER_KEY=1`). The shipped stack
refuses that key ([SEC-14](security-register.md)).

The image carries the web app's build as of the last `make up` and
serves it at the site root.

`make dev` brings the stack up and runs the app's Vite server on
`127.0.0.1:5173`. The Vite server reloads the UI in place on every
edit. It proxies `/api`, `/avatars`, and `/health` to the
orchestrator on 8080.

## Trust boundary

### Network and identity

The stack listens on loopback and does not authenticate. Whoever
reaches the port is the operator. A box reached from elsewhere sits
behind the operator's own gate. `trusted-header` takes each person's
identity from that proxy
([Remote access](../operations/remote-access.md)). An extension may
supply its own identity provider.

The orchestrator serves a request only for a loopback host or the
host of `PUBLIC_BASE_URL`. It takes a state change or a WebSocket
only from a page on it ([SEC-15](security-register.md)).

Each `user` group message snapshots the current identity's name.

### Configuration and prompts

The UI configures users, guilds, agents, secrets, connections, and
bindings.

The PostgreSQL artifact store is the prompt, memory, note,
collection, and script store. The Host Finder reads it and writes
Markdown. Agents write notes, records, memory, and scripts, not
`task`.

The orchestrator hydrates Markdown from the `system.md` template,
`agents.task`, and the `memory` artifact. Agent homes contain no
executable prompt code.

A run sends its complete history on every model call. Context is
append-only during a run. Tool calls execute sequentially inside a
generation. Schedule wake-ups are one-shot runs started by the
in-process ticker.

### Machines and homes

Docker containers share the host kernel. Sandboxes have Docker
bridge egress to the public internet. Sandbox egress and the
orchestrator share the host's NAT.

An agent has artifact rows in PostgreSQL and one persistent home on
its machine. Every agent on a machine shares its container and runs
commands there as root. Agents on one machine can read each other's
homes, git tokens, Chrome sessions, and the environment of a command
running at the same moment. A machine never spans organisations
([SEC-24](security-register.md#sec-24--agents-on-one-machine-can-read-each-others-homes-tokens-and-sessions)).

The machine's container may stop after 5 idle minutes with no agent
on it generating. It is recreated on the next generation of one of
its agents, or when an operator opens the Browser or CLI tab.

The CLI tab is a root shell on that machine for any operator of the
agent. It sees the files and processes of every agent on the
machine. It carries no secret values, but can read those of a
command running there. Its port answers only under a path segment
that is random per agent and that only the orchestrator's proxy
knows.

The home is also a folder on the orchestrator's host. Tools that
take a path in it have the orchestrator open it directly, only
through the home file rules
([Agent home files](../concepts/agent-home.md#agent-home-files)). A
link the agent planted cannot point the orchestrator at its own
files. The check-then-open race that remains is SEC-3 in the
[security register](security-register.md).

### Coding agents

A coding agent's `shell` runs any command on its machine as root
with open egress. Its code changes are the work of a coding harness:
`code_task` runs `guilds-harness` in the container, which starts the
harness CLI there. The harness runs on the operator's subscription
token or on a login stored in the agent's home. An organisation
model key never reaches it. The code tools, `code_task` included,
run inside the container and never open a path in its home from the
orchestrator ([Code tools](../concepts/coding/code-tools.md)).

A coding agent's GitHub installation tokens sit in
`/run/guilds/<agent id>/`, outside every home. They are readable by
any process on its machine for their hour, whichever agent started
it. The App's private key and the installation ids stay in the
orchestrator.

### Artifacts

Authorization over the artifact store is:

- the application store
- the access lists of notes and collections (`artifact_access`: rows
  for the organisation, a guild, or an agent; the agent's own row
  wins and may be `none`, otherwise the better of its guild's and the
  organisation's row; no row is no access)

There is no row-level security on those tables.

Note tools see the agent's own notes and the notes whose access list
reaches it. Record tools see the collections whose access list
reaches the agent, and write only under `write`. A guild row or the
organisation row covers agents created after it was written.

No agent tool reads the memory archive (`memory_revisions`). Only
the operator sees previous versions. `memory_write` replaces that
agent's `memory` row.

Script tools read and write that agent's `script` artifacts. They
materialise `scripts/` in the agent's home for execution.

### Secrets

Exact-value redaction protects known secret strings. It covers every
value in the run's environment, connection credentials, and a value
`secret_store` saved, from that call on in its generation. A value
the model already saw stays in earlier history. Transformed,
encoded, or split forms are inside the agent trust boundary.

Secrets reach an agent's commands as environment variables on each
command, never in the container's environment. A secret reaches
every agent its access names. Organisation-wide is every agent in
the organisation. A guild grant is every agent in that guild. Any
process on those agents' machines can read it while their commands
run, and send it.

Every organisation member reads each secret's name, description, and
access, never its value. Grants inside guilds a member cannot see
read as a private guild.

An agent writes secrets only through `secret_store`. The value comes
from a regular file inside its home reached without a link out of
it. The secret is granted to itself. At most 20 per agent. The agent
cannot read a value back, delete a secret, or change who gets it.

`secret_request` text is the agent's own and its card says so. The
operator's value goes to the secrets API, never into the transcript.

### Connectors

Remote MCP servers and adapters run in the orchestrator. Connect
tokens never enter the sandbox. Encryption uses one master key.

Official tool HTTP leaves the orchestrator. It goes through
`ADAPTER_PROXY_URL` when it is set and direct otherwise.

An instance key that serves a connector's platform login (Tavily web
search) stays out of the sandbox, as do these login keys:

- CoinGecko
- Alchemy
- X
- TwitterAPI.io
- Qonto
- DexPaprika
- a registry connector's login

Guild-shared connections are shared agency. Every inheriting member
acts as that account.

Prompt Studio calls a connection's tools only after the operator
grants that login to the session, and only read-only tools.
