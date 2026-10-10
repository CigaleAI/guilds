# Operate

The box in day-to-day use: updating it, backing it up and restoring
it, reading its logs, and what its messages mean when it refuses to
start.

## Update

```text
git pull
./setup.sh
docker compose up --detach --wait --build
```

`./setup.sh` keeps every value `.env` has. It rebuilds the runtime
image so a change under `runtime/` reaches the next sandbox.

`--build` rebuilds the orchestrator image from the checkout.

Boot applies new migrations before it listens
([Orchestrator](../architecture/orchestrator.md)).

## Back up

Everything the box knows is `STATE_ROOT` and `.env`.

PostgreSQL holds notes, records, memory, scripts, runs, and every
credential, encrypted. `workspaces/` holds what agents wrote to disk.
`attachments/` holds the uploaded files.

Copy `STATE_ROOT` with the stack stopped (`docker compose stop`). Or
dump the database while it runs:

```text
docker compose exec -T postgres pg_dump -U agent_platform -Fc agent_platform > guilds.dump
```

A backup without `.env` cannot decrypt its credentials.

## Restore

A copy of `STATE_ROOT` goes back in place with the stack stopped, with
the `.env` it was made under. Then:

```text
docker compose up --detach --wait
```

A dump loads into the running database with the orchestrator stopped:

```text
docker compose stop orchestrator
docker compose exec -T postgres pg_restore -U agent_platform -d agent_platform --clean --if-exists < guilds.dump
docker compose start orchestrator
```

## Logs

The orchestrator writes one JSON line per event to stdout. Docker
keeps them as `json-file` logs (five files of 10 MB):

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

When they apply it also carries `source`, `request_id`, `session_id`,
`path`, `method`, and `status`.

Warnings and errors are also written to stderr as one readable line.

Every value of an environment variable whose name ends in `API_KEY`,
`SECRET`, `TOKEN`, `PASSWORD`, or `PASSWD` is replaced by
`[REDACTED:<name>]` before a line is written.

Every API call from the operator app carries that tab's
`X-Request-Id`, which appears as `request_id`. The app reports its
own uncaught errors and failed calls to the server
(`source: frontend`). One id lines up what the operator saw with what
the server did.

Boot logs `listening` once the server accepts requests, and
`sentry enabled` or `sentry disabled`.

With `SENTRY_DSN` set, errors and traces go to Sentry under
`SENTRY_ENVIRONMENT`, sampled at `SENTRY_TRACES_SAMPLE_RATE`. These
are not sent:

- user information
- cookies
- request bodies
- model inputs and outputs
- query data

`GET /health` answers `{"status":"ok"}` after a database ping, for a
monitor outside the box.

## When it fails

| Message | Cause |
|---|---|
| `run ./setup.sh first, which writes it into .env` | `docker compose` found no `.env`, or one without `STATE_ROOT`, `SECRETS_MASTER_KEY`, `POSTGRES_PASSWORD`, or `OPENSANDBOX_API_KEY` |
| `STATE_ROOT must be an absolute path` | `.env` names a relative path; OpenSandbox mounts workspaces by the absolute one |
| `… already holds a database, and .env has no …` | `./setup.sh` would generate a secret over a database created with another one. Put that database's values into `.env`, or point `STATE_ROOT` at an empty directory |
| `SECRETS_MASTER_KEY is the all-zero development key: set 32 random bytes` | The orchestrator refuses the development key outside the development stack ([Security register](../architecture/security-register.md), SEC-14) |
| `SECRETS_MASTER_KEY must be 32 bytes (base64 or hex)` | The key is not 32 bytes |
| `AUTH_MODE must be compat-cookie, trusted-header` | `.env` names a mode core does not have |
| `TRUSTED_PROXY_SECRET is required when AUTH_MODE=trusted-header`, and the same for `PUBLIC_BASE_URL` and `OPERATOR_EMAIL` | The proxy mode is missing one of its three settings ([Remote access](remote-access.md)) |
| `OPERATOR_EMAIL is another user's email` | A user other than the box's first already holds that address |
| Create agent, Studio, the Builder, or recipe apply shows `Connect a model provider first` | The organisation has no provider connected. Connect one under **Settings**, **Model keys** ([Model keys](model-keys.md#without-a-key)) |
| A run ends with `connect a … key on Model keys` | The organisation has no key for that agent's model provider, or removed it; connect one under **Settings**, **Model keys** ([Model keys](model-keys.md#replace-or-remove-a-key)) |
| Model keys answers `<Provider> rejected the key` or `did not accept the key` | The provider refused `GET /models` with that key; nothing was saved ([Model keys](model-keys.md#the-key-check)) |
| The picker lists a model under `Not offered` | The agent's stored model is no longer among the organisation's chosen models; it still runs while the provider's key is connected ([Model keys](model-keys.md#choose-models)) |
| Model keys cannot browse a provider's catalog, or lists stale models | The box could not fetch models.dev and serves its last catalog or the snapshot it ships with ([Configure](configure.md#model-catalog)) |
| Stored credentials fail to decrypt after a restore | The restore runs under a different `SECRETS_MASTER_KEY` than the one the data was written with |

The orchestrator container restarts on its own
(`restart: unless-stopped`). A setting it refuses shows in its log on
every attempt.
