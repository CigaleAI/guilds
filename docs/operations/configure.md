# Configure

`.env` in the checkout configures the stack. A first box needs
nothing more than what `./setup.sh` writes there.

`docker compose up` reads `.env` at start. After a change to `.env`,
restart the stack:

```text
docker compose up --detach --wait
```

Platform keys are the exception. A platform admin enters them in the
operator app, and they take effect at once.

## How a value reaches the server

The Compose file passes `.env` to the orchestrator with `env_file`.
Every variable on this page reaches it that way, except those the
Compose file names itself:

- The Compose file sets these, and `.env` cannot change them:
  `DATABASE_URL`, `OPENSANDBOX_URL`, `NOTES_ROOT`, `WORKSPACE_ROOT`,
  `ATTACHMENTS_ROOT`, `CONNECTORS_ROOT` (each under `STATE_ROOT`),
  `TOOL_RESULT_MAX_BYTES` (`65536`), `HOST`, and `PORT`.
- The Compose file reads these from the shell first, then from
  `.env`: `STATE_ROOT`, `SECRETS_MASTER_KEY`, `POSTGRES_PASSWORD`,
  `OPENSANDBOX_API_KEY`, `ORCHESTRATOR_PORT`, `ORCHESTRATOR_IMAGE`,
  `SANDBOX_IMAGE`, `AUTH_MODE`, and `SENTRY_ENVIRONMENT`. A value
  exported in the shell wins over `.env`.

A variable exported in the shell and not named in the Compose file
does not reach the container.

## Required

`./setup.sh` writes these four values. It keeps them on later runs
([Maintain](maintain.md#run-setupsh-again)).

| Variable | Value |
|---|---|
| `STATE_ROOT` | An absolute path on this host. The stack keeps its state under it. A relative path is refused, because the sandbox server mounts each machine's directory by this path |
| `SECRETS_MASTER_KEY` | 32 random bytes, as hex or base64 (`./setup.sh` writes hex). It encrypts every stored credential: connector logins, model keys, platform keys, and secrets. `.env` holds its only copy. A lost key loses them all. The server refuses to start without it, and refuses the all-zero key |
| `POSTGRES_PASSWORD` | The database password. Generated |
| `OPENSANDBOX_API_KEY` | The key the server and the sandbox server share. Generated |

## Images

| Variable | Default | Role |
|---|---|---|
| `ORCHESTRATOR_IMAGE` | `guilds-orchestrator:local` | The orchestrator image the stack runs. `docker compose up --build` builds it from the checkout under this tag |
| `SANDBOX_IMAGE` | `agent-runtime:0.4` | The image every machine runs. `./setup.sh` builds `agent-runtime:0.4` from `runtime/` |

The OpenSandbox server runs `guilds-opensandbox-server:473ff611`,
which `./setup.sh` builds from the pinned commit.

## Integrations

An integration is an optional capability of the box as a whole. The
box holds its credential for everyone on it. A model key, a
connector login, or a secret is different: each belongs to one
organisation.

**Admin**, **Platform keys** lists each integration with its state
and which fields are set. It never shows a value.
[Platform keys](../tools-and-connectors/platform-keys.md) explains
how an integration is on, off, or incomplete.

### Platform keys

A platform admin enters these under **Admin**, **Platform keys**.
They are stored encrypted under `SECRETS_MASTER_KEY`. They take
effect at once. `.env` carries none of them.

| Integration | Fields | Switches on | Without it |
|---|---|---|---|
| Web search | Tavily API key | The Tavily connector on the platform's key, `tavily_search` | Runs leave the tool out. An organisation may connect a Tavily key of its own |
| System One | An optional provider (`typesafe`, the only one accepted and the one read while blank; Platform keys refuses another on save), API key, and an optional model | Recipient and history selection in group chat, and the agent-optimized browser | Tag rules and the last 10 messages, and no agent-optimized browser |
| GitHub App | App ID, App slug, private key (PEM), client ID, client secret. **Create the GitHub App** fills them from GitHub ([GitHub](../tools-and-connectors/github.md#step-1-create-the-app)) | The GitHub connector and a guild's repositories | Tools marks the connector **Not set up**, names the missing fields, and disables Connect |
| Google connectors | Client ID, client secret ([Gmail and Drive](../tools-and-connectors/google.md)) | The Gmail and Drive connectors | As for the GitHub App |

### Environment

These are read from `.env` at start. **Platform keys** shows them
read-only.

| Integration | Variables | Switches on | Without it |
|---|---|---|---|
| Error reporting | `SENTRY_DSN` ([Error reporting](#error-reporting)) | Errors, traces, logs, and runtime metrics sent to Sentry ([Maintain](maintain.md#logs-and-metrics)) | Structured logs only |
| Registry | `REGISTRY_URL`, the guilds.run registry while unset. `REGISTRY_PUBLIC_KEY` to require a signed index | Installing connectors and recipes from a registry ([Connector registry](../tools-and-connectors/connector-registry.md)) | Set empty, the box is offline. Nothing installs, and recipe apply names a missing connector unknown |
| Connector code | `CONNECTORS_CODE_TIER=1` | Registry connectors that carry adapter code, from an index `REGISTRY_PUBLIC_KEY` verifies ([Code tier](../tools-and-connectors/connector-registry.md#code-tier)) | A code install is refused, and code already on disk is not loaded |

No integration serves a model provider. Each organisation connects
its own keys under **Settings**, **Model keys**
([Model keys](../concepts/model-keys.md)).

## Reaching the box

| Variable | Default | Role |
|---|---|---|
| `ORCHESTRATOR_PORT` | `8080` | The loopback port the operator app is published on |
| `AUTH_MODE` | `compat-cookie` | How a request becomes a user. With `compat-cookie`, whoever reaches the port is the operator. With `trusted-header`, an authenticating proxy in front sends each person's email |
| `PUBLIC_BASE_URL` | empty | The address the box is reached at from elsewhere. The server answers requests for a loopback host or this one |
| `TRUSTED_PROXY_SECRET` | | The secret the proxy sends in `X-Guilds-Proxy-Secret`. Required by `trusted-header` |
| `TRUSTED_HEADER_EMAIL` | `X-Forwarded-Email` | The header the proxy sends the email in |
| `OPERATOR_EMAIL` | | Your own email. Boot gives it to the box's first user. Required by `trusted-header` |
| `ADAPTER_PROXY_URL` | empty | A forward proxy for the HTTP calls of connector adapters and remote MCP servers. Empty, they go direct |

Connectors that sign in with OAuth return to
`<PUBLIC_BASE_URL>/api/mcp/oauth/callback`. While `PUBLIC_BASE_URL`
is empty, they return to the loopback address the box is reached at,
`http://localhost:8080/api/mcp/oauth/callback` on the local stack.
[Remote access](remote-access.md) covers the two ways to reach the
box from another computer, and where that callback is registered.

## Limits

| Variable | Default | Role |
|---|---|---|
| `MAX_CONCURRENT_GENERATIONS` | `0` | Generations running at once across the whole box. `0` is no ceiling. Each organisation's own cap applies under it |
| `HARNESSES_OFF` | empty | Coding harnesses the box turns off, separated by commas or spaces: `claude-code`, `codex`, `cursor`, `antigravity`. They stay in the runtime image, but Settings does not offer them, the API refuses them as a new pick, and a run of an agent still on one fails at start. An unknown name stops the box from starting ([Harnesses](../concepts/coding/harnesses.md#turning-a-harness-off)) |
| `WORKSPACE_MAX_MIB` | `10240` | The host-wide cap on one agent's home, in MiB. An agent's own `max_workspace_mib` takes effect only below it ([Agent home](../concepts/agent-home.md)) |
| `CODE_RESULT_MAX_BYTES` | `8192` | The cap on what a code tool or `code_task` returns to the model, in bytes. A value under `1024` falls back to the default |

Agents' CPU, memory, and disk are bounded by their organisation's
machines, not by `.env`. Owners and admins create and size them under
**Settings**, **Machines**
([Machines](../concepts/machines.md)).

## Model catalog

| Variable | Default | Role |
|---|---|---|
| `MODELS_DEV_URL` | `https://models.dev/api.json` | Where the model catalog is fetched from, on the first read and again once an hour. Set empty, the box stays on the catalog snapshot it ships with ([Orchestrator](../architecture/orchestrator.md#catalog)) |

## Error reporting

| Variable | Default | Role |
|---|---|---|
| `SENTRY_DSN` | | Switches Sentry on |
| `SENTRY_ENVIRONMENT` | `development` | The environment tag on each event |
| `SENTRY_TRACES_SAMPLE_RATE` | `1.0` | The share of requests traced, 0 to 1 |
| `SENTRY_PROFILE_SESSION_SAMPLE_RATE` | `1.0` | The chance, 0 to 1, that a process profiles its CPU while a sampled trace is open; drawn once at start |
| `SENTRY_DEBUG` | | `1` prints the Sentry SDK's own debug output |

## Development

The `make contract-model` target reads these from `.env`. The
shipped stack does not use them
([Development](../contributing/development.md#tests)):

- `MODEL_CONTRACT_MODEL`, a `{provider}/{model}` id
- `MODEL_CONTRACT_API_KEY`
- `MODEL_CONTRACT_BASE_URL`, for a local endpoint
