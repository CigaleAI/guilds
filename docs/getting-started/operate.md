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
| `opensandbox` | Starts and stops agent sandboxes through the Docker socket | No |

Only the orchestrator is reachable from outside Docker, and only on
this machine. Each agent runs in a sandbox container of its own.
Sandboxes can reach the public internet.

Agents run in one of two images:

- `agent-runtime:0.3` is the standard, code, and custom box. It has a
  browser and the coding toolchains.
- `agent-runtime-lite:0.1` is the lite box. It has scripts and a
  terminal.

The standard image installs Google Chrome on amd64 and Debian's
Chromium on arm64. To use Chromium on every platform, build the image
with:

```text
docker build --build-arg BROWSER=chromium --tag agent-runtime:0.3 runtime/
```

## Where the state lives

`STATE_ROOT` in `.env` is an absolute path on this machine. The
stack keeps everything under it. Each directory is mounted into the
container that uses it. The stack creates no named Docker volume.

- `postgres/` is the database
- `workspaces/` holds one directory per agent, mounted at
  `/home/agent` in its sandbox
- `attachments/` holds images uploaded in chat
- `notes/` is the notes vault
- `opensandbox/` is the sandbox server's store
- `connectors/` holds connector packages installed from a registry

The path must be absolute because the sandbox server mounts each
agent's workspace by that same path.

Everything the box knows is this tree plus `.env`.

## Update

```text
git pull
./setup.sh
docker compose up --detach --wait --build
```

`./setup.sh` keeps every value already in `.env`. It rebuilds the
agent images, so a change under `runtime/` reaches the next sandbox.

`--build` rebuilds the orchestrator image from the checkout.

The server applies new database migrations at boot, before it
listens ([Orchestrator](../architecture/orchestrator.md)).

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
already has, and it rebuilds the agent images.

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

## Logs

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

With `SENTRY_DSN` set, errors and traces go to Sentry under
`SENTRY_ENVIRONMENT`, sampled at `SENTRY_TRACES_SAMPLE_RATE`. Sentry
never receives:

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
| `STATE_ROOT must be an absolute path` | `.env` names a relative path. The sandbox server mounts workspaces by the absolute one |
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
| Stored credentials fail to decrypt after a restore | The restore runs under a different `SECRETS_MASTER_KEY` than the one the data was written with |

The orchestrator container restarts on its own
(`restart: unless-stopped`). A setting it refuses shows in its log on
every attempt.
