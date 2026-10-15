# Catalog

One in-process registry holds native tools. Each tool is declared with
an explicit JSON Schema.

Before a schema is offered to the model:

- `format` is stripped from optional and nullable properties
  (including nested objects and array items)
- `additionalProperties: false` is dropped
- optional strings that do not already say to omit the key get a
  short “omit when unused” line, so the model can leave those keys
  out

Before an MCP tool is called, an empty string is dropped only when
that key is optional on the tool schema. A required empty string is
forwarded. Handlers take `ctx` first and return strings. Exceptions
become `ERROR: <message>` tool results; full detail goes to
operational logs.

Every tool result follows one path:

1. custom filter
2. exact-value secret redaction
   ([Secrets](../concepts/secrets.md#redaction))
3. platform byte cap (default 64 KiB)
4. a `remaining_tool_calls: N` trailer

When N is 8 or fewer, a wrap-up line sits above that trailer. The
stamped string is what PostgreSQL and the model receive. The raw
result is never persisted.

[Native tools](native.md) ship in the box. [Code tools](../concepts/coding/code-tools.md)
follow the agent's `coding` flag. [Connectors](connectors.md) are
catalog servers an organisation signs in to. Most take a pasted key
or a browser sign-in that registers its own client. [Gmail and
Drive](google.md) and [GitHub](github.md) also need an app and
credentials on the box.

## What a run offers

The note, record, memory, script, schedule, secret, and
`group_post` tools are bindings ([Access](../concepts/access.md)). A
run offers the ones resolved enabled for that agent.

A later turn also drops a native tool that is now off, including:

- the eight browser tools when `config.browser` is false
- the five code tools when `config.coding` is false
- the five script tools when `config.scripting` is false
- `memory_write` when `config.memory` is false

A native tool the run does not offer is refused if the model names
it. `report_issue` is always offered.

The eight browser tools are omitted from `offered_tools` when the
snapshot's `browser` flag is false. The code tools are omitted when
its `coding` flag is false. The script tools are omitted when its
`scripting` flag is false. `memory_write` is omitted when its
`memory` flag is false.

The six schedule tools are further limited to direct and group-chat
runs. `secret_request` is limited to direct runs.

Each browser call starts the agent's Chrome on its machine when it
is not running, then runs `/usr/local/bin/guilds-browser` there. It
attaches Playwright to the agent's own Chrome at its DevTools port,
`http://127.0.0.1:<9300 + slot>`, and leaves that process running
([Browser](../concepts/browser.md)).

Status of a connector login at run start:

- **pending**: start the run; omit that server's tools.
- **disconnected** and the server is enabled: generation-start error.
- **connected**: list, persist, then offer the enabled subset.

GitHub is left out of this resolution. It offers no tools. A coding
run reaches it through its guild's repositories, which fail that run
alone when their connection is disconnected
([GitHub](github.md)).

## Catalog, connections, bindings

Access rests on three objects: the catalog (what exists), connections
(the logins an organisation, a guild, or an agent signs in with), and
bindings (which scope offers which catalog item). The connector
manifest and the `connectors` table, connections, binding resolution
across the instance, organisation, guild, and agent scopes, the
platform seed bindings, and the access views are described in
[Access](../concepts/access.md).

## Integrations

An integration is something the box as a whole can do once it has
its key, as opposed to a login an organisation connects. One
registry (`apps/orchestrator/src/instance/integrations.ts`) names
each one, the fields it takes, where their values come from, and
what it switches on. A `store` integration's values are entered by
a platform admin under **Admin**, **Platform keys** and kept
encrypted in `instance_keys`; an `env` integration's are read from
the environment at start. Modules ask the registry, not the
environment or the table. An integration is `on` when every field it
requires is set, `off` when none is, and `incomplete` when some are.

A connector may declare an integration of its own: a platform key
(`auth.instance: { "own": true }` on a token connector, whose fields
are its login fields, `secret` unless a field says `secret: false`)
or an OAuth client (`configured` with no `provider`: Client ID
`client_id` and Client secret `client_secret`). Its id is
`connector:<slug>`, its label the connector's display name (or
`<name> OAuth client`), its source `store`, and it
`provides.connectors: [slug]`. It is listed with the others, filled
through the same routes, and its row is deleted with the registry
connector. The list is rebuilt from the platform connector rows
(`apps/orchestrator/src/instance/connectors.ts`,
`refreshConnectorIntegrations`) at boot and after a registry
install, update, removal, or reload, and after a hand-made server is
created or patched, so a hand-made platform server with a configured
client of its own gets one too; an organisation's own server cannot
use a configured client. `installedIntegrations()` lists core's, an
edition's, then the connector-declared ones.

| Integration | Source | Fields | Switches on |
|---|---|---|---|
| `web-search` | store | `api_key` | The Tavily connector's platform login, `tavily_search` |
| `group-routing` | store | `api_key`, and `model` to tune it | Recipient and history selection in group chat |
| `github-app` | store | `app_id`, `slug`, `private_key`, `client_id`, `client_secret` | The GitHub connector and a guild's repositories ([GitHub](github.md)) |
| `google-connectors` | store | `client_id`, `client_secret` | The Gmail and Drive connectors ([Gmail and Drive](google.md)) |
| `error-reporting` | env | `SENTRY_DSN` | Sentry |
| `registry` | env | `REGISTRY_URL`, `REGISTRY_PUBLIC_KEY` | Installing connectors and recipes from a registry ([Registry](registry.md)) |
| `connector-code` | env | `CONNECTORS_CODE_TIER`, `CONNECTORS_ROOT` | Registry connectors that carry adapter code ([Code tier](registry.md#code-tier)) |

`GET /api/instance` (any user of the box) reports:

- the box's `auth_mode`
- each integration's `id`, `label`, `enables`, `source`, and `state`
- its `fields` (`name`, `label`, `optional`, `secret`, `multiline`,
  `set`), never a value; for an env field, `set` means the variable
  itself is set, and a default does not count
- its `setup` flow: `github-app-manifest` for the GitHub App, else
  null
- `updated_at` and `set_by` for an instance admin, null for anyone
  else
- what it `provides`: `native_tools` and `connectors`

The operator app reads it and turns off what depends on a missing
integration, naming it and the fields it lacks:

- **Admin**, **Platform keys** lists every integration with its
  state and takes a store integration's values (`PUT` and
  `DELETE /api/admin/instance/keys/:integration`, instance admin
  only)
- the Tools view marks a connector without its App or OAuth client
  **Not set up** and offers a platform admin **Set up**
  ([Access](../concepts/access.md#tools))

No integration serves a model provider; an organisation connects its
own under **Settings**, **Model keys**
([Model keys](../concepts/model-keys.md)).

Entering a platform key is
[Configure](../getting-started/configure.md#platform-keys).
