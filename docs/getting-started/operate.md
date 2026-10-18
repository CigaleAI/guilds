# Operate

This page is for the box in day-to-day use. It covers what runs,
where the state lives, updates, backups, logs, and what each error
message means.

## What runs

The stack is three containers.

| Service | Role | Published |
|---|---|---|
| `orchestrator` | The server and the operator app | `127.0.0.1:8080` (`ORCHESTRATOR_PORT`) |
| `postgres` | The database | No |
| `opensandbox` | Starts and stops machines' containers through the Docker socket | No |

Only the orchestrator is reachable from outside Docker, and only on
this host. Agents run on their organisation's machines: one
sandbox container per machine, shared by every agent placed on it
([Machines](../concepts/machines.md)). Sandboxes
can reach the public internet.

Every machine runs `agent-runtime:0.4`. It has a browser and the
coding toolchains. The image installs Google Chrome on amd64 and
Debian's Chromium on arm64. To use Chromium on every platform, build
the image with:

```text
docker build --build-arg BROWSER=chromium --tag agent-runtime:0.4 runtime/
```

A coding harness is the coding tool an agent hands its code work
to. The image you build carries three: Codex, Claude Code, and the
Cursor CLI. To build it with Codex as its one harness, run:

```text
docker build --build-arg HARNESSES= --tag agent-runtime:0.4 runtime/
```

A coding run of an agent on Claude Code or Cursor then fails at
start with an error that names its missing harness.
[Harnesses](../concepts/coding/harnesses.md#harnesses-in-the-image)
explains which harnesses an image carries.

## Where the state lives

`STATE_ROOT` in `.env` is an absolute path on this host. The
stack keeps everything under it. Each directory is mounted into the
container that uses it. The stack creates no named Docker volume.

- `postgres/` is the database
- `workspaces/` holds each machine's directory, mounted at `/home`
  in the machine's container, with one home per agent on it
  (`workspaces/<machine id>/<agent id>`, `/home/<agent id>` inside)
- `attachments/` holds images uploaded in chat
- `notes/` is the notes vault
- `opensandbox/` is the sandbox server's store
- `connectors/` holds connector packages installed from a registry

The path must be absolute because the sandbox server mounts each
machine's directory by that same path.

Everything the box knows is this tree plus `.env`.

## Update

Read the [changelog](../../CHANGELOG.md). The digit that changed
says what this box does.

| Change | Do |
| --- | --- |
| Patch (`1.2.3` to `1.2.4`) | Nothing. The images this box runs did not change |
| Minor (`1.2.3` to `1.3.0`) | Rebuild, below. State, `.env`, recipes, and the API stay valid |
| Major (`1.2.3` to `2.0.0`) | [Back up](#back-up), then follow the steps in that version. The commands below are not enough |

A minor version:

```text
git pull
./setup.sh
docker compose up --detach --wait --build
```

`./setup.sh` keeps every value already in `.env`. It rebuilds the
agent image, so a change under `runtime/` reaches the next machine
container.

`--build` rebuilds the orchestrator image from the checkout.

The server applies new database migrations at boot, before it
listens ([Orchestrator](../architecture/orchestrator.md)).

### Upgrade a box whose agents run in sandboxes of their own

Upgrading such a box places its agents on machines. The upgrade is
not backward compatible. [Back up](#back-up) first, then:

1. Pull and run `./setup.sh`. It builds `agent-runtime:0.4`. A
   `.env` that sets `SANDBOX_IMAGE` must name `agent-runtime:0.4`
   or an image built from this `runtime/`. Nothing reads
   `SANDBOX_IMAGE_LITE`; remove it from `.env`.
2. Start the stack with `--build`. Migration 0004 places every
   agent on a machine:
   - Each organisation gets a `standard` machine named `default`.
     It holds every agent with neither browser nor coding, 32 at
     most per machine (`default-2`, `default-3`… for the rest).
   - Every other agent gets a machine of its own, named after it,
     with the tier and size its configuration held.
   - A machine's disk cap is 10240 MiB, or its agents' measured
     use plus 1024 MiB when that is larger.
   - It removes the tier and size from agent configurations and
     active run snapshots.
3. Before generation starts, the server destroys every sandbox
   labelled with an `agent_id`. It moves each
   `WORKSPACE_ROOT/<agent id>` into
   `WORKSPACE_ROOT/<machine id>/<agent id>`. Repositories, scripts,
   and the `.browser` profile with its logins move with it.
4. Reinstall the tools an agent installed in its home with
   `/home/agent` written into them: Python virtualenvs, mise
   installs, and npm installs. The home is `/home/<agent id>`. Run
   the install again from the agent's CLI tab, or let the agent run
   it.
5. Update API clients and editions to the machine API. Agent create
   takes `machine_id`, required when the organisation has more than
   one machine. Agent payloads carry `machine_id` and `machine`. A
   machine holds the tier and size
   ([Machines](../concepts/machines.md)). An
   edition's `SandboxProvider`, `GenerationSandboxes`, and
   `machineHost` are keyed by machine
   ([Extension points](../architecture/extension-points.md)).

To share machines, move agents onto one under each agent's
**Settings**, **Machine**, and delete the machines left empty under
**Settings**, **Machines**.

## Back up

Everything the box knows is `STATE_ROOT` and `.env`.

PostgreSQL holds notes, records, memory, scripts, runs, and every
credential. Credentials are encrypted with the key in `.env`.
`workspaces/` holds what agents wrote to disk. `attachments/` holds
uploaded images.

Stop the stack, then copy `STATE_ROOT`:

```text
docker compose stop
```

Or dump the database while the stack runs:

```text
docker compose exec -T postgres pg_dump -U agent_platform -Fc agent_platform > guilds.dump
```

Keep `.env` with the backup. Without it, the credentials in the
backup cannot be decrypted.

## Restore

Stop the stack. Put the copy of `STATE_ROOT` back in place, with the
`.env` it was made under. Then start the stack:

```text
docker compose up --detach --wait
```

To load a dump instead, stop the orchestrator, restore into the
running database, then start the orchestrator again:

```text
docker compose stop orchestrator
docker compose exec -T postgres pg_restore -U agent_platform -d agent_platform --clean --if-exists < guilds.dump
docker compose start orchestrator
```

## Run setup.sh again

`./setup.sh` is safe to run again. It keeps every value `.env`
already has, and it rebuilds the agent image.

It refuses to generate a new secret when `STATE_ROOT/postgres`
already holds a database. That database was created with values only
its owner has. Put those values into `.env`, or point `STATE_ROOT` at
an empty directory.

`./setup.sh --env-only` writes `.env` and the state directories. It
builds no image.

The stack does not start without `.env`. Each missing value says
`run ./setup.sh first, which writes it into .env`.

## Start over

To go back to an empty box, stop the stack, remove the state
directories, and start the stack again:

```sh
docker compose down
rm -rf .state/{postgres,opensandbox,workspaces,notes,attachments,connectors}
docker compose up --detach --wait
```

`.state` is the default `STATE_ROOT`. Use the path `.env` names when
it differs.

The server applies its migrations to the empty database and creates
the first operator and the `Home` organisation again. `.env` and the
images stay. On a development checkout, `make reset` does the same
([Development](../contributing/development.md#local-state)).

## Logs and metrics

The orchestrator writes one JSON line per event to stdout. Docker
keeps them as `json-file` logs, five files of 10 MB each. Follow them
with:

```text
docker compose logs --follow orchestrator
```

Each line carries:

- `timestamp`
- `level`
- `run_id`
- `guild_id`
- `agent_id`
- `operation`
- `error_type`
- `message`
- `traceback`

A line also carries `source`, `request_id`, `session_id`, `path`,
`method`, and `status` when they apply.

Warnings and errors are also written to stderr as one readable line.

Secrets never reach the log. Every value of an environment variable
whose name ends in `API_KEY`, `SECRET`, `TOKEN`, `PASSWORD`, or
`PASSWD` is replaced by `[REDACTED:<name>]` before a line is written.

Every API call from the operator app carries that tab's
`X-Request-Id`. It appears in the log as `request_id`. The app also
reports its own uncaught errors and failed calls to the server, as
`source: frontend`. One id lines up what the operator saw with what
the server did.

At boot the server logs `listening` once it accepts requests, and
`sentry enabled` or `sentry disabled`.

With `SENTRY_DSN` set, Sentry receives under `SENTRY_ENVIRONMENT`:

- errors, as issues
- traces, sampled at `SENTRY_TRACES_SAMPLE_RATE`
- CPU profiles while a sampled trace is open, for a process sampled
  at `SENTRY_PROFILE_SESSION_SAMPLE_RATE`
- every `info`, `warn`, and `error` log line, as a Sentry log whose
  attributes are the line's fields, already redacted
- runtime metrics, every 10 seconds:
  - the server process: `node.event_loop.delay_max` and
    `node.event_loop.delay_p99` (ms), `node.cpu` (percent of one core,
    so two busy cores read 200), `node.memory.heap_used` and
    `node.memory.rss` (bytes)
  - the host it runs on: `host.load_1m`, `host.memory.used` (percent),
    and for the filesystem under `/` (`mount: root`) and under
    `WORKSPACE_ROOT` (`mount: workspace`), `host.disk.free` (bytes) and
    `host.disk.used` (percent)
  - the database: the pool's `db.pool.total`, `db.pool.idle`, and
    `db.pool.waiting`, and the server's client connections
    `db.server.connections` against `db.server.max_connections`
- a count of `node.event_loop.stall` for each 10 seconds in which the
  event loop was held 1 second or more, and of `db.pool.error` for
  each pooled connection lost while idle
- an `EventLoopBlocked` event with the main thread's stack when the
  event loop is held 1 second or more, at most 10 an hour

The metrics chart under Explore → Metrics in Sentry; `host.disk.free`
and `host.disk.used` split by their `mount` attribute.

A stall also logs `event loop stalled for <ms> ms` at `warn` with
`operation: runtime.stall`. A pooled connection lost while idle logs
`idle database connection lost: <reason>` at `warn` with
`operation: db.pool`; the pool drops it and opens another on the next
query.

Sentry never receives:

- user information
- cookies
- request bodies
- model inputs and outputs
- query data

`GET /health` answers `{"status":"ok"}` after a database ping. A
monitor outside the box can poll it.

## When it fails

| Message | Cause |
|---|---|
| `run ./setup.sh first, which writes it into .env` | `docker compose` found no `.env`, or one without `STATE_ROOT`, `SECRETS_MASTER_KEY`, `POSTGRES_PASSWORD`, or `OPENSANDBOX_API_KEY` |
| `STATE_ROOT must be an absolute path` | `.env` names a relative path. The sandbox server mounts machine directories by the absolute one |
| `… already holds a database, and .env has no …` | `./setup.sh` would generate a secret over a database created with another one. Put that database's values into `.env`, or point `STATE_ROOT` at an empty directory |
| `SECRETS_MASTER_KEY is the all-zero development key: set 32 random bytes` | The server refuses the development key outside the development stack ([Security register](../architecture/security-register.md), SEC-14) |
| `SECRETS_MASTER_KEY must be 32 bytes (base64 or hex)` | The key is not 32 bytes |
| `AUTH_MODE must be compat-cookie, trusted-header` | `.env` names a mode core does not have |
| `TRUSTED_PROXY_SECRET is required when AUTH_MODE=trusted-header`, and the same for `PUBLIC_BASE_URL` and `OPERATOR_EMAIL` | The proxy mode is missing one of its three settings ([Remote access](remote-access.md)) |
| `OPERATOR_EMAIL is another user's email` | A user other than the box's first already holds that address |
| Create agent, Studio, the Builder, or recipe apply shows `Connect a model provider first` | The organisation has no provider connected. Connect one under **Settings**, **Model keys** ([Model keys](../concepts/model-keys.md#without-a-key)) |
| A run ends with `connect a … key on Model keys` | The organisation has no key for that agent's model provider, or removed it. Connect one under **Settings**, **Model keys** ([Model keys](../concepts/model-keys.md#replace-or-remove-a-key)) |
| Model keys answers `<Provider> rejected the key` or `did not accept the key` | The provider refused `GET /models` with that key. Nothing was saved ([Model keys](../concepts/model-keys.md#the-key-check)) |
| The picker lists a model under `Not offered` | The agent's stored model is no longer among the organisation's chosen models. It still runs while the provider's key is connected ([Model keys](../concepts/model-keys.md#choose-models)) |
| Model keys cannot browse a provider's catalog, or lists stale models | The box could not fetch models.dev. It serves its last catalog or the snapshot it ships with ([Configure](configure.md#model-catalog)) |
| A run fails at start with `workspace.full` | The agent's home is over its `max_workspace_mib` (or `WORKSPACE_MAX_MIB`), or its machine's directory is over the machine's cap. The message names which. Free space from the CLI tab, or raise the cap in the agent's Settings or under **Settings**, **Machines** |
| `coding needs a code or custom machine` | Coding is on for an agent placed on a `standard` machine. Resize the machine under **Settings**, **Machines**, or move the agent |
| `machine_id is required: the organisation has more than one machine` | An agent create named no machine while the organisation has several |
| `machine … is full` | The machine already holds 32 agents, or the policy's agents-per-machine cap |
| Stored credentials fail to decrypt after a restore | The restore runs under a different `SECRETS_MASTER_KEY` than the one the data was written with |

The orchestrator container restarts on its own
(`restart: unless-stopped`). A setting it refuses shows in its log on
every attempt.
