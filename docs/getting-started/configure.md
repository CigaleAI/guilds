# Configure

`.env` in the checkout configures the stack. A first box needs
nothing here: `./setup.sh` wrote the four values it runs on. This
page is for the rest: the keys the box holds for everyone on it, how
the box is reached, its limits, and the model catalog.

`docker compose up` reads `.env`. A platform key is not in it: a
platform admin enters one in the operator app, under **Admin**,
**Platform keys**, and it takes effect at once. Every other setting
is read at start. After a change to `.env`, restart:

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

An integration is one of the box's optional capabilities: a
credential the box holds for everyone on it, as opposed to an
organisation's own model key, connection, or secret. Each declares
the fields it takes and where their values come from. A platform
key is entered in the operator app. An environment integration is
read from `.env`. An integration is on once every field it requires
has a value, incomplete when some do, and off when none does.

The registry is `apps/orchestrator/src/instance/integrations.ts`.
**Admin**, **Platform keys** lists each one with its state, what it
switches on, and which fields are set. It never shows a value. A
screen that depends on a missing integration names it and, for a
platform admin, links there.

### Platform keys

A platform admin enters these under **Admin**, **Platform keys**.
Each is stored encrypted under `SECRETS_MASTER_KEY`, one row per
integration, and takes effect at once: no restart. A value never
comes back out. The form shows which fields are set, and a platform
admin sees when and by whom. Removing an integration there switches
it off. `.env` carries none of these.

| Integration | Fields | Switches on | Without it |
|---|---|---|---|
| Web search | Tavily API key | The Tavily connector on the platform's key, `tavily_search` | Runs leave the tool out; an organisation may connect a Tavily key of its own |
| Group routing | TypeSafe API key, and a model to tune it | Recipient and history selection in group chat, beyond tag rules | Tag rules and the last 10 messages |
| GitHub App | App ID, App slug, private key (PEM), client ID, client secret; **Create the GitHub App** fills them from GitHub ([GitHub](../tools-and-connectors/github.md#registering-the-app)) | The GitHub connector and a guild's repositories | Tools marks the connector **Not set up**, names the missing fields, and disables Connect |
| Google connectors | Client ID, client secret ([Gmail and Drive](../tools-and-connectors/google.md)) | The Gmail and Drive connectors | As for the GitHub App |

### Environment

These are read from `.env` at start. **Platform keys** shows them
read-only. A key reaches the server through `.env` alone: the
Compose file passes the file with `env_file`, and a variable exported
in the shell does not reach the container.

| Integration | Variables | Switches on | Without it |
|---|---|---|---|
| Error reporting | `SENTRY_DSN` | Errors and traces sent to Sentry | Structured logs only ([Operate](operate.md#logs)) |
| Registry | `REGISTRY_URL`, the guilds.run registry while unset; `REGISTRY_PUBLIC_KEY` to require a signed index | Installing connectors and recipes from a registry ([Registry](../tools-and-connectors/registry.md)) | Set empty, the box is offline: nothing installs, and recipe apply names a missing connector unknown |
| Connector code | `CONNECTORS_CODE_TIER=1`, and `CONNECTORS_ROOT` (`STATE_ROOT/connectors` on the Compose stack) | Registry connectors that carry adapter code, from an index `REGISTRY_PUBLIC_KEY` verifies ([Code tier](../tools-and-connectors/registry.md#code-tier)) | A code install is refused, and code already on disk is not loaded |

No integration serves a model provider. An organisation connects its
own keys under **Settings**, **Model keys**
([Model keys](model-keys.md)).

Connectors that sign in with OAuth return to
`<PUBLIC_BASE_URL>/api/mcp/oauth/callback`, or, when `PUBLIC_BASE_URL`
is empty, to the loopback address the box is reached at
(`http://localhost:8080/api/mcp/oauth/callback` on the local stack).
**Create the GitHub App** registers that callback on the App itself.
Register it by hand on the Google Cloud client, and on a GitHub App
you register by hand
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
