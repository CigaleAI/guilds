# Configure

`.env` in the checkout configures the stack. A first box needs
nothing here. `./setup.sh` wrote the four values the stack runs on.

This page covers the rest: the keys the box holds for everyone on
it, how the box is reached, its limits, and the model catalog.

`docker compose up` reads `.env` at start. After a change to `.env`,
restart the stack:

```text
docker compose up --detach --wait
```

Platform keys are the exception. A platform admin enters them in the
operator app, under **Admin**, **Platform keys**, and they take
effect at once.

## Required

`./setup.sh` writes these four values. It keeps them on later runs
([Operate](operate.md#run-setupsh-again)).

| Variable | Value |
|---|---|
| `STATE_ROOT` | An absolute path on this host. The stack keeps its state under it. A relative path is refused, because the sandbox server mounts each machine's directory by this path |
| `SECRETS_MASTER_KEY` | 32 random bytes, as hex or base64. It encrypts every stored credential: connector logins, model keys, and secrets. `.env` holds its only copy. A lost key loses them all. The server refuses to start without it, and refuses the all-zero key |
| `POSTGRES_PASSWORD` | The database password. Generated |
| `OPENSANDBOX_API_KEY` | The key the server and the sandbox server share. Generated |

The Compose file derives the rest of the server's environment from
these. You do not set them:

- `DATABASE_URL`
- `OPENSANDBOX_URL`
- `NOTES_ROOT`
- `WORKSPACE_ROOT`
- `ATTACHMENTS_ROOT`
- `SANDBOX_IMAGE`, the image every machine runs (`agent-runtime:0.4`)

## Integrations

An integration is an optional capability of the box as a whole. The
box holds its credential for everyone on it. A model key, a
connector login, or a secret is different: each belongs to one
organisation.

Each integration declares the fields it takes and where their values
come from. A **platform key** is entered in the operator app. An
**environment integration** is read from `.env`. An integration is on
once every required field has a value. It is incomplete when some
do. It is off when none does.

**Admin**, **Platform keys** lists each integration with its state,
what it switches on, and which fields are set. It never shows a
value. A screen that depends on a missing integration names it, and
shows a platform admin a link to it.

The registry of integrations is
`apps/orchestrator/src/instance/integrations.ts`.

### Platform keys

A platform admin enters these under **Admin**, **Platform keys**.
Each one is stored encrypted under `SECRETS_MASTER_KEY`, one row per
integration. It takes effect at once. No restart is needed. A value
never comes back out. The form shows which fields are set, and when
and by whom. Removing an integration there switches it off. `.env`
carries none of these.

| Integration | Fields | Switches on | Without it |
|---|---|---|---|
| Web search | Tavily API key | The Tavily connector on the platform's key, `tavily_search` | Runs leave the tool out. An organisation may connect a Tavily key of its own |
| Group routing | TypeSafe API key, and a model to tune it | Recipient and history selection in group chat, beyond tag rules | Tag rules and the last 10 messages |
| GitHub App | App ID, App slug, private key (PEM), client ID, client secret. **Create the GitHub App** fills them from GitHub ([GitHub](../tools-and-connectors/github.md#step-1-create-the-app)) | The GitHub connector and a guild's repositories | Tools marks the connector **Not set up**, names the missing fields, and disables Connect |
| Google connectors | Client ID, client secret ([Gmail and Drive](../tools-and-connectors/google.md)) | The Gmail and Drive connectors | As for the GitHub App |

### Environment

These are read from `.env` at start. **Platform keys** shows them
read-only. A key reaches the server through `.env` alone. The
Compose file passes the file with `env_file`. A variable exported in
the shell does not reach the container.

| Integration | Variables | Switches on | Without it |
|---|---|---|---|
| Error reporting | `SENTRY_DSN` | Errors, traces, logs, and runtime metrics sent to Sentry ([Operate](operate.md#logs-and-metrics)) | Structured logs only ([Operate](operate.md#logs-and-metrics)) |
| Registry | `REGISTRY_URL`, the guilds.run registry while unset. `REGISTRY_PUBLIC_KEY` to require a signed index | Installing connectors and recipes from a registry ([Registry](../tools-and-connectors/registry.md)) | Set empty, the box is offline. Nothing installs, and recipe apply names a missing connector unknown |
| Connector code | `CONNECTORS_CODE_TIER=1`, and `CONNECTORS_ROOT` (`STATE_ROOT/connectors` on the Compose stack) | Registry connectors that carry adapter code, from an index `REGISTRY_PUBLIC_KEY` verifies ([Code tier](../tools-and-connectors/registry.md#code-tier)) | A code install is refused, and code already on disk is not loaded |

No integration serves a model provider. Each organisation connects
its own keys under **Settings**, **Model keys**
([Model keys](../concepts/model-keys.md)).

Connectors that sign in with OAuth return to
`<PUBLIC_BASE_URL>/api/mcp/oauth/callback`. When `PUBLIC_BASE_URL`
is empty, they return to the loopback address the box is reached at.
On the local stack that is
`http://localhost:8080/api/mcp/oauth/callback`. **Create the GitHub
App** registers that callback on the App itself. On the Google Cloud
client, and on a GitHub App you register by hand, you register it
yourself ([Gmail and Drive](../tools-and-connectors/google.md),
[GitHub](../tools-and-connectors/github.md),
[Remote access](remote-access.md)).

## Reaching the box

| Variable | Default | Role |
|---|---|---|
| `ORCHESTRATOR_PORT` | `8080` | The loopback port the operator app is published on |
| `AUTH_MODE` | `compat-cookie` | How a request becomes a user. With `compat-cookie`, whoever reaches the port is the operator. With `trusted-header`, an authenticating proxy in front sends each person's email |
| `PUBLIC_BASE_URL` | empty | The address the box is reached at from elsewhere. The server answers requests for a loopback host or this one |
| `TRUSTED_PROXY_SECRET` | | The secret the proxy sends in `X-Guilds-Proxy-Secret`. Required by `trusted-header` |
| `TRUSTED_HEADER_EMAIL` | `X-Forwarded-Email` | The header the proxy sends the email in |
| `OPERATOR_EMAIL` | | Your own email. Boot gives it to the box's first user. Required by `trusted-header` |

[Remote access](remote-access.md) covers the two ways to reach the box
from another computer.

## Limits

| Variable | Default | Role |
|---|---|---|
| `MAX_CONCURRENT_GENERATIONS` | `0` | Generations running at once across the whole box. `0` is no ceiling. Each organisation's own cap applies under it |
| `HARNESSES_OFF` | empty | Coding harnesses the box turns off, separated by commas or spaces: `claude-code`, `codex`, `cursor`, `antigravity`. They stay in the runtime image, but Settings does not offer them, the API refuses them as a new pick, and a run of an agent still on one fails at start. An unknown name stops the box from starting ([Harnesses](../concepts/coding/harnesses.md#turning-a-harness-off)) |

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

## Development

The development stack and the contract tests read these. The shipped
stack does not ([Development](../contributing/development.md)):

- `MODEL_CONTRACT_MODEL`, `MODEL_CONTRACT_API_KEY`, and
  `MODEL_CONTRACT_BASE_URL` for a local endpoint
