# System

One Node process is the control plane. It serves the operator app.
It owns every run. It is the only process that talks to the model
client, OpenSandbox, and PostgreSQL.

Agent code runs in OpenSandbox containers built from `runtime/`.
Each container has a persistent workspace on the host. Durable
application state is PostgreSQL.

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

The service does not use Node cluster mode or multiple Compose
replicas.

There are no queued runs with `FOR UPDATE SKIP LOCKED`. There are no
database leases for agent ownership. There is no `LISTEN/NOTIFY`
fan-out.

Locks, generation tasks, dispatch, and cancellation are
process-local. Artifact writes use PostgreSQL transactions.

Identity resolution is one module behind `AUTH_MODE`:

- `compat-cookie` (whoever reaches the port)
- `trusted-header` (the email an authenticating proxy sends)

An edition built on core may add a mode of its own with an identity
provider for it ([Extension points](extension-points.md)).
Cross-organisation and non-member access returns 404.

## State on disk

`STATE_ROOT` is one absolute host path (`.state` in the checkout
unless `.env` says otherwise). It holds the host-side trees:

- `workspaces/`: the **sandbox** tree: one directory per agent id,
  bind-mounted at `/home/agent`. Packages and scratch, materialised
  `scripts/` (canonical source is the agent-level `script` artifact
  rows), and `.browser/` for the Chromium profile. OpenSandbox may
  mount only this prefix (`allowed_host_paths`).
- `postgres/`: the Compose Postgres data directory.
- `opensandbox/`: the OpenSandbox server's SQLite lifecycle store.
- `notes/`: `NOTES_ROOT`. The file-backed `NotesStore`
  (`src/notes/store.ts`) resolves `system.md` here and shadow-writes
  per-agent `routines/<schedule-id>.md` on schedule writes. Nothing
  reads those files: the artifact store and `schedules.instruction`
  are canonical. The tree is required to exist at boot.
- `attachments/`: `ATTACHMENTS_ROOT`. Chat images, one file per
  attachment under its organisation's directory.
- `lightrag/`: the development stack's docs index.

The path is absolute because OpenSandbox bind-mounts each workspace
by that same path. `make state` creates the trees. `./setup.sh`
writes the path into `.env`.

Notes, collection records, `memory`, and scripts are artifact rows.
`task` is a column on the agent. Display paths are the unique
reference
([Notes and collections](../concepts/notes-and-collections.md)):

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
current Markdown.

Scripts stay in the same store. They appear on the agent's State
Scripts view, not in Files. Collection records appear on the
Databases page.

Agents never mount artifact rows. Orchestrator tools read and write
them.

Shared standing identity is
`apps/orchestrator/src/prompts/system.md` in the repository. The
sandbox is the agent's machine. Deleting an agent destroys that
machine, so durable findings have to be in the artifact store first.

Sandbox paths are id-keyed so a reused name gets a fresh machine.
Display paths use organisation, guild, and agent ids for the same
reason.

## Compose stacks and images

| Target | Files | Services |
| --- | --- | --- |
| `docker compose up` | `docker-compose.yml` | postgres, opensandbox, orchestrator on the core image: the stack as shipped ([Install](../getting-started/install.md)). Only the orchestrator is published, on `127.0.0.1:8080` |
| `make up` (dev) | `docker-compose.dev.yml` = `docker-compose.yml` + `docker-compose.watch.yml` + `docker-compose.docs.yml` | The same three, with the development overlay, and lightrag and preview for docs search |

The stack mounts the Docker socket. Sandboxes are containers it
starts beside itself.

`./setup.sh` builds the three images no registry publishes
(`scripts/images.sh`):

- the OpenSandbox server from its pinned commit
- `agent-runtime:0.3` for a standard box, from `runtime/`
- `agent-runtime-lite:0.1` for a lite box, from `runtime/`

The orchestrator service runs the core image
(`apps/orchestrator/Dockerfile`, `guilds-orchestrator:local`).
`docker-compose.yml` builds it from the checkout. A `web` stage
builds `apps/web`. The final stage copies `src`, `scripts`,
`drizzle`, and that build.

An edition's image is this Dockerfile built in the edition's
workspace, plus its own package
([Extension points](extension-points.md)).

Core reaches sandboxes through one
[`RunSandboxes`](../../apps/orchestrator/src/sandbox/index.ts)
manager on `OPENSANDBOX_URL`. An edition can supply a provider of
its own.

The sandbox profile is the `opensandbox-config` in
`docker-compose.yml`:

- the Docker provider on `runc`
- one sandbox and one persistent workspace per agent
- dropped capabilities (`AUDIT_WRITE`, `MKNOD`, `NET_ADMIN`,
  `NET_RAW`, `SYS_ADMIN`, `SYS_MODULE`, `SYS_PTRACE`, `SYS_TIME`,
  `SYS_TTY_CONFIG`)
- `no_new_privileges`
- `pids_limit` 4096
- CPU and memory limits per sandbox

Sandboxes have Docker bridge egress to the public internet. Secrets
reach them as environment variables.

### Development overlay

`docker-compose.watch.yml` adds what the shipped file leaves out.

It publishes Postgres at `127.0.0.1:5432`. It bind-mounts `src/`,
`scripts/`, and `drizzle/` into the orchestrator container. `tsx
watch` restarts the orchestrator when its source changes.

It also accepts the all-zero master key the Makefile gives a
development stack (`ALLOW_ZERO_MASTER_KEY=1`). The shipped stack
refuses that key ([SEC-14](security-register.md)).

The development stack publishes docs search at `127.0.0.1:9622`
(indexer `127.0.0.1:9621`). The image carries the web app's build as
of the last `make up` and serves it at the site root.

`make dev` brings the stack up and runs the app's Vite server on
`127.0.0.1:5173`. The Vite server reloads the UI in place on every
edit. It proxies `/api`, `/avatars`, and `/health` to the
orchestrator on 8080.

## Trust boundary

1. The UI configures:

   - users
   - guilds
   - agents
   - secrets
   - connections
   - bindings

   The PostgreSQL artifact store is the prompt, memory, note,
   collection, and script store. The Host Finder reads it and
   writes Markdown. Agents write notes, records, memory, and
   scripts, not `task`.

2. The orchestrator hydrates Markdown from:

   - the repository's `system.md` template
   - `agents.task`
   - the `memory` artifact

   Agent workspaces contain no executable prompt code.

3. The stack listens on loopback and does not authenticate. Whoever
   reaches the port is the operator. A box reached from elsewhere
   sits behind the operator's own gate. `trusted-header` takes each
   person's identity from that proxy ([Remote
   access](../getting-started/remote-access.md)). The orchestrator
   serves a request only for a loopback host or the host of
   `PUBLIC_BASE_URL`. It takes a state change or a WebSocket only
   from a page on it ([SEC-15](security-register.md)).

4. Docker containers share the host kernel. Sandboxes have public
   bridge egress.

5. A run sends its complete history on every model call. Context is
   append-only during a run.

6. Tool calls execute sequentially inside a generation. Schedule
   wake-ups are one-shot runs started by the in-process ticker.

7. An agent has artifact rows in PostgreSQL and one persistent
   sandbox directory.

   The sandbox may stop after 5 idle minutes. It is recreated on the
   next generation, or when an operator opens the Browser or CLI
   tab.

   The CLI tab is a root shell on that machine for any operator of
   the agent. It sees the files, the processes, and the environment,
   secret values included. Its port answers only under a path
   segment that is random per container and that only the
   orchestrator's proxy knows.

   That directory is also a folder on the orchestrator's machine.
   Tools that take a path in it have the orchestrator open it
   directly, only through the workspace file rules
   ([Tools and connectors](../concepts/tools-and-connectors.md)). A
   link the agent planted cannot point the orchestrator at its own
   files. The check-then-open race that remains is SEC-3 in the
   [security register](security-register.md).

   A coding agent's `shell` runs any command there as root with open
   egress. Its code tools run inside the container and never open a
   workspace path in the orchestrator.

   A coding agent's GitHub installation tokens sit in
   `/run/guilds/`, outside the workspace. They are readable by any
   process in its sandbox for their hour. The App's private key and
   the installation ids stay in the orchestrator.

8. Artifact writes use PostgreSQL transactions. Authorization is:

   - the application store
   - the four note grant bindings
   - the collection grants (`collection_access`: a guild's `read`
     or `write` row as the base for its members, overridden by
     that agent's own row, which may be `none`; nothing visible
     until granted)

   There is no row-level security on those tables.

9. Exact-value redaction protects known secret strings. It covers
   every value in the run's environment, connection credentials, and
   a value `secret_store` saved, from that call on in its
   generation.

   A value the model already saw stays in earlier history.
   Transformed, encoded, or split forms remain inside the agent
   trust boundary.

10. A secret reaches every agent its access names.
    Organisation-wide is every agent in the organisation. A guild
    grant is every agent in that guild. Any process in those
    sandboxes can read and send it.

    Every organisation member reads each secret's name, description,
    and access, never its value. Grants inside guilds a member
    cannot see read as a private guild.

    An agent writes secrets only through `secret_store`. The value
    comes from a regular file inside `/home/agent` reached without a
    link out of it. The secret is granted to itself. At most 20 per
    agent. The agent cannot read a value back, delete a secret, or
    change who gets it.

    `secret_request` text is the agent's own and its card says so.
    The operator's value goes to the secrets API, never into the
    transcript.

11. Note tools see the notes the four grant bindings allow.

    Record tools see the agent's guild's own collections, which
    every member writes. They also see the organisation collections
    granted to the agent or its guild, written only under a `write`
    grant.

    No agent tool reads the memory archive (`memory_revisions`).
    Only the operator sees previous versions. `memory_write`
    replaces that agent's `memory` row.

    Script tools read and write that agent's `script` artifacts.
    They materialise `/home/agent/scripts/` for execution.

    An instance key that serves a connector's platform login
    (Tavily web search) stays out of the sandbox, as do these login
    keys:

    - CoinGecko
    - Alchemy
    - X
    - TwitterAPI.io
    - Qonto
    - DexPaprika
    - a registry connector's login

12. One Node process. Locks and dispatch are process-local.

13. Identity is the `AUTH_MODE` seam:

    - the cookie on a loopback box
    - the proxy's header behind a gate
    - an edition's own provider

    Each `user` group message snapshots the current identity's name.
    Guild-shared connections are shared agency. Every inheriting
    member acts as that account.

14. Remote MCP servers and adapters run in the orchestrator.
    Connect tokens never enter the sandbox. Encryption uses one
    master key.

    Official tool HTTP leaves the orchestrator. It goes through
    `ADAPTER_PROXY_URL` when it is set and direct otherwise.
    Sandbox egress and the orchestrator share the host's NAT.

    Prompt Studio calls a connection's tools only after the
    operator grants that login to the session, and only read-only
    tools.
