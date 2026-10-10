# Configure

`.env` in the checkout is the only place the stack is configured.

`docker compose up` reads it. The operator app shows each setting's
state and takes none.

After a change, restart:

```text
docker compose up --detach --wait
```

## Required

`./setup.sh` writes these four and keeps them on later runs
([Install](install.md)).

| Variable | Value |
|---|---|
| `STATE_ROOT` | An absolute path on the Docker host where the stack keeps its state. OpenSandbox mounts each workspace by that path, so a relative one is refused |
| `SECRETS_MASTER_KEY` | 32 random bytes, as hex or base64. It encrypts every stored credential: connector logins, organisation model keys, secrets. `.env` holds its only copy; a lost key loses them. The orchestrator refuses to start without it and refuses the all-zero key |
| `POSTGRES_PASSWORD` | The database password, generated |
| `OPENSANDBOX_API_KEY` | The key the orchestrator and the sandbox server share, generated |

The Compose file derives the rest of the server's environment from
these. You do not set them:

- `DATABASE_URL`
- `OPENSANDBOX_URL`
- `NOTES_ROOT`
- `WORKSPACE_ROOT`
- `ATTACHMENTS_ROOT`
- `SANDBOX_IMAGE`
- `SANDBOX_IMAGE_LITE`

## Integrations

An integration is a credential the box holds for everyone on it.

That is different from an organisation's own model key, connection, or
secret. Each integration is optional. It is on once every variable it
requires has a value.

The registry is `apps/orchestrator/src/instance/integrations.ts`.
**Admin**, **Platform keys** lists each one with:

- its state (on, off, or incomplete when some of its variables are
  set)
- what it switches on
- which variables are set

It never shows a value. A screen that depends on a missing integration
says which variables would switch it on.

| Integration | Variables | Switches on | Without it |
|---|---|---|---|
| Web search | `TAVILY_API_KEY` | The Tavily connector on the platform's key, `tavily_search` | Runs leave the tool out; an organisation may connect a Tavily key of its own |
| Group routing | `TYPESAFE_API_KEY`, and `TYPESAFE_MODEL` to tune it | Recipient and history selection in group chat, beyond tag rules | Tag rules and the last 10 messages |
| GitHub App | `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | The GitHub connector and a guild's repositories ([GitHub](../tools-and-connectors/github.md)) | Tools marks the connector **Not set up**, names the missing variables, and disables Connect |
| Google connectors | `GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET` | The Gmail and Drive connectors ([Gmail and Drive](../tools-and-connectors/google.md)) | As for the GitHub App |
| Error reporting | `SENTRY_DSN` | Errors and traces sent to Sentry | Structured logs only ([Operate](operate.md#logs)) |
| Registry | `REGISTRY_URL`, the guilds.run registry while unset; `REGISTRY_PUBLIC_KEY` to require a signed index | Installing connectors and recipes from a registry ([Registry](../tools-and-connectors/registry.md)) | Set empty, the box is offline: nothing installs, and recipe apply names a missing connector unknown |
| Connector code | `CONNECTORS_CODE_TIER=1`, and `CONNECTORS_ROOT` (`STATE_ROOT/connectors` on the Compose stack) | Registry connectors that carry adapter code, from an index `REGISTRY_PUBLIC_KEY` verifies ([Code tier](../tools-and-connectors/registry.md#code-tier)) | A code install is refused, and code already on disk is not loaded |

A key reaches the server through `.env` alone. The Compose file passes
the file with `env_file`. A variable exported in the shell does not
reach the container.

No integration serves a model provider. An organisation connects its
own keys under **Settings**, **Model keys**
([Model keys](model-keys.md)).

Connectors that sign in with OAuth return to
`<PUBLIC_BASE_URL>/api/mcp/oauth/callback`, or to the loopback address
when `PUBLIC_BASE_URL` is empty. Register that URI on the OAuth client
or GitHub App you configure
([Gmail and Drive](../tools-and-connectors/google.md),
[GitHub](../tools-and-connectors/github.md),
[Remote access](remote-access.md)).

## Reaching the box

| Variable | Default | Role |
|---|---|---|
| `ORCHESTRATOR_PORT` | `8080` | The loopback port the operator app is published on |
| `AUTH_MODE` | `compat-cookie` | How a request becomes a user. `compat-cookie`: whoever reaches the port is the operator. `trusted-header`: an authenticating proxy in front sends each person's email |
| `PUBLIC_BASE_URL` | empty | The address the box is reached at from elsewhere. The server answers requests for a loopback host or this one |
| `TRUSTED_PROXY_SECRET` | | The secret the proxy sends in `X-Guilds-Proxy-Secret`; required by `trusted-header` |
| `TRUSTED_HEADER_EMAIL` | `X-Forwarded-Email` | The header the proxy sends the email in |
| `OPERATOR_EMAIL` | | Your own email, which boot gives the box's first user; required by `trusted-header` |

[Remote access](remote-access.md) covers the two ways to reach the box
from another machine.

## Limits

| Variable | Default | Role |
|---|---|---|
| `MAX_CONCURRENT_GENERATIONS` | `0` | Generations running at once across the whole box; `0` is no ceiling. Each organisation's own cap applies under it |

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

## Development

Read by the development stack and the contracts, not by the shipped
one ([Development](../contributing/development.md)):

- `MODEL_CONTRACT_MODEL`, `MODEL_CONTRACT_API_KEY`, and
  `MODEL_CONTRACT_BASE_URL` for a local endpoint
