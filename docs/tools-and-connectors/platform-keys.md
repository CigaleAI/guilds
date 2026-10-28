# Platform keys

A platform key is a value the box as a whole holds, such as an API key
or an OAuth client. It switches on something every organisation can
use. An organisation's own logins are [connectors](connectors.md)
instead.

The code calls each switchable feature an **integration**. One list
(`apps/orchestrator/src/instance/integrations.ts`) names each
integration, the fields it takes, where their values come from, and
what it switches on. Modules ask that list for a value. They never
read the environment or the table directly.

Entering a key is a step of
[Configure](../operations/configure.md#platform-keys).

## Sources and state

An integration reads its values from one of two sources:

- **`store`**: a platform admin enters the values under **Admin**,
  **Platform keys**. They are kept encrypted in `instance_keys`.
- **`env`**: the values come from the environment at start.

An integration is `on` when every required field is set. It is `off`
when no required field is set, and `incomplete` otherwise. A default
value does not count as set.

## Integrations the box ships

| Integration | Source | Fields | Switches on |
|---|---|---|---|
| `web-search` | store | `api_key` | The Web search connector's platform login, `tavily_search` ([Web search](connector-list.md#web-search)) |
| `group-routing` | store | `api_key`, optional `model` | Recipient and history selection in group chat |
| `github-app` | store | `app_id`, `slug`, `private_key`, `client_id`, `client_secret` | The GitHub connector and a guild's repositories ([GitHub](github.md)) |
| `google-connectors` | store | `client_id`, `client_secret` | The Gmail and Drive connectors ([Gmail and Drive](google.md)) |
| `error-reporting` | env | `SENTRY_DSN` | Errors and traces sent to Sentry |
| `registry` | env | `REGISTRY_URL` (default `https://registry.guilds.run`), optional `REGISTRY_PUBLIC_KEY` | Installing connectors and recipes from a registry ([Connector registry](connector-registry.md)) |
| `connector-code` | env | `CONNECTORS_CODE_TIER`, optional `CONNECTORS_ROOT` | Registry connectors that carry adapter code ([Code tier](connector-registry.md#code-tier)) |

An extension may add integrations of its own
([Extension points](../architecture/extension-points.md)). An
integration may provide native tools. A native tool that waits on an
integration has no switch in **Tools**. It says it is offered once a
platform admin sets up that integration.

No integration serves a model provider. Each organisation connects its
own under **Settings**, **Model keys**
([Model keys](../concepts/model-keys.md)).

## A connector's own key or client

A connector may declare a platform key or an OAuth client of its own.
The box then lists it as one more integration, with the id
`connector:<slug>`:

| The manifest says | The integration holds | Label |
|---|---|---|
| `auth.instance: { "own": true }` on a token connector | The connector's login fields, secret unless a field says `secret: false` | The connector's display name |
| `auth.oauth.strategy: "configured"` with no `provider` | `client_id` and `client_secret` | `<name> OAuth client` |

Its source is `store`, and it provides that one connector. It is
listed and filled like any other integration.

- **Own key**: the pool reads every field at call time as the
  platform login's credentials. They travel the way the connector's
  token does. The platform login follows the integration's state
  ([Platform logins](connectors.md#platform-logins)).
- **Own client**: the authorization server is discovered from the
  connector's endpoint, so the connector needs one. While the client
  is unset, the connector's `oauth_setup_state` is `unsupported`, and
  **Tools** shows it **Not set up**.

Only a platform connector can declare one. An organisation's own
server cannot use a configured client.

The list of these integrations is rebuilt from the platform connector
rows (`refreshConnectorIntegrations`,
`apps/orchestrator/src/connectors/instance.ts`):

- at boot
- after a registry install, update, removal, or reload
- after the instance admin creates or edits a server by hand

Removing a registry connector deletes its stored values too.

A shipped connector may instead name a field of one of the box's own
integrations, as `auth.instance: { integration, field }`. The Web
search connector names `web-search`'s `api_key`. A connector installed
at runtime cannot do that
([Connector registry](connector-registry.md)).

## In the app

- **Admin**, **Platform keys** lists every integration with its state.
  A platform admin enters or clears a `store` integration's values
  there. An `env` integration shows which variables are set.
- **Tools** marks a connector whose integration is not on **Not set
  up**. It names the missing fields and disables **Connect**. A
  platform admin also gets **Set up**, which opens Platform keys on
  that integration ([Access](../concepts/access.md#tools)).

## Reference

### HTTP

| Route | Who | Does |
|---|---|---|
| `GET /api/instance` | Any user | The box's `auth_mode` and every integration's status |
| `PUT /api/admin/instance/keys/:integration` | Instance admin | Stores `{ values }` for a `store` integration |
| `DELETE /api/admin/instance/keys/:integration` | Instance admin | Clears a `store` integration; an `env` one is a 400 |
| `POST /api/admin/instance/keys/github-app/manifest` | Instance admin | Starts creating the GitHub App ([Manifest flow](github.md#manifest-flow)) |

`PUT` and `DELETE` answer `{ integration, disconnected }`.
`disconnected` counts the GitHub logins a replaced or removed App
disconnected ([Replacing the App](github.md#replacing-the-app)).
After every write, platform logins follow their integration's new
state without a restart.

### Status fields

Each integration in `GET /api/instance` carries:

| Field | Meaning |
|---|---|
| `id`, `label`, `enables`, `source`, `state` | What it is and whether it is on |
| `fields` | `name`, `label`, `optional`, `secret`, `multiline`, `set`; never a value. For an `env` field, `set` means the variable is set non-empty |
| `setup` | `github-app-manifest` for the GitHub App, else null |
| `updated_at`, `set_by` | For an instance admin on a `store` integration; null for anyone else |
| `provides` | `native_tools` and `connectors` it switches on |

`installedIntegrations()` lists core's integrations, then an
extension's, then the connector-declared ones.
