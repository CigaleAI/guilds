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
   ([Secrets and access](../concepts/secrets-and-access.md#redaction))
3. platform byte cap (default 64 KiB)
4. a `remaining_tool_calls: N` trailer

When N is 8 or fewer, a wrap-up line sits above that trailer. The
stamped string is what PostgreSQL and the model receive. The raw
result is never persisted.

[Native tools](native.md) ship in the box. [Code tools](code.md)
follow the agent's `coding` flag. [Connectors](connectors.md) are
catalog servers an organisation signs in to. Most take a pasted key
or a browser sign-in that registers its own client. [Gmail and
Drive](google.md) and [GitHub](github.md) also need an app and
credentials on the box.

## What a run offers

The note, record, memory, script, schedule, secret, and
`group_post` tools are bindings. A run offers the ones resolved
enabled for that agent.

A later turn also drops a native tool that is now off, including:

- the eight browser tools when `config.browser` is false
- the code tools when `config.coding` is false
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

Each browser call runs `/usr/local/bin/guilds-browser` in the
sandbox. It attaches Playwright to the existing Chrome at
`http://127.0.0.1:9222` and leaves that process running.

Status of a connector login at run start:

- **pending**: start the run; omit that server's tools.
- **disconnected** and the server is enabled: generation-start error.
- **connected**: list, persist, then offer the enabled subset.

GitHub is left out of this resolution. It offers no tools. A coding
run reaches it through its guild's repositories, which fail that run
alone when their connection is disconnected
([GitHub](github.md)).

## Catalog, connections, bindings

Three objects:

- **Catalog**: what exists. Native tools are the TypeScript registry.
  MCP servers are platform catalog rows: transport, connect config,
  `auth` of `none`, `token`, or `oauth`, plus operator-facing copy
  (`description`, `limitations`, `setup_hint`).

  Every connector is a folder under
  `apps/orchestrator/src/connectors/<slug>/`: `connector.json` (the
  manifest: everything that is not code), `adapter.ts` when the
  connector has code, the client code it needs, and an optional
  `logo.svg` (24×24, `currentColor`). `src/connectors/index.ts` lists
  core's folders; an edition adds its own through
  `ServerExtension.connectors`
  ([Extension points](../architecture/extension-points.md)).

  Installed connectors are rows of one table, `connectors`: the
  manifest as a JSON document beside the box's state for it.

  | Column | Holds |
  | --- | --- |
  | `id`, `slug`, `tool_prefix` | The server id, its slug, and the prefix of its tool names, unique on the box |
  | `owner_org_id` | Null for a platform connector |
  | `manifest` | The manifest, as its folder or the Admin form wrote it |
  | `source`, `verified`, `publisher`, `version` | Where it came from: `core` (a folder in the image), `registry`, or `local` (made on this box) |
  | `enabled` | The connector's switch; on at install |
  | `oauth_client` | The client a `dynamic` OAuth connector registered |
  | `overrides` | The instance admin's edits, applied on read |

  Boot projects every installed folder into its row, replacing the
  manifest and where it came from whole, so a manifest fix reaches
  the row with or without a version bump; the switch, the OAuth
  client, and the overrides stay. One loader (`connectors/load.ts`)
  applies `overrides` to the manifest for every reader. A server the
  instance admin adds by hand is a `local` row with no folder: its
  row is its source of truth.

  A connector has an endpoint, an adapter, or both:

  - **Endpoint only**: Notion, Sentry, Cigale, and Etherscan. The
    pool's MCP client lists and calls the remote server.
  - **Adapter only**: CoinGecko, Alchemy, X, TwitterAPI.io, Qonto,
    DexPaprika, Tavily, and Gmail call their APIs from
    adapter code. GitHub has neither tools nor endpoint
    ([GitHub](github.md)).
  - **Both**: Drive and OpenSea. The adapter wraps the endpoint's
    session ([Adapters](connectors.md#adapters)).

  The manifest's keys:

  | Key | Meaning |
  | --- | --- |
  | `slug` | Equals the folder name; the server id is `mcp_<slug>` |
  | `display_name`, `description`, `limitations`, `setup_hint` | Operator copy |
  | `endpoint.url` | The remote MCP server, public HTTPS |
  | `auth.kind` | `token`, `oauth`, or `none` |
  | `auth.fields` | A token login's inputs `{ name, label, secret, optional, placeholder }`; omitted means one field named `token` |
  | `auth.header` | The header an endpoint's token travels in; default a bearer `Authorization` header |
  | `auth.oauth` | `{ strategy, provider, scopes }`: `dynamic`, `configured` (the client the `provider` integration holds), or `github_app` |
  | `auth.instance` | `{ integration, variable }`: the instance key that serves the connector's platform login while that integration is on ([Instance keys](connectors.md#instance-keys)) |
  | `requires.integration` | The instance integration the connector needs |
  | `tools[]` | `{ name, description, input_schema, mutating }`, the curated list |
  | `policy.default_off` | Name patterns (`*` matches any run) that start Off |
  | `state` | `{ key, intro }`: the State key the adapter's `state` hook fills |
  | `builder` | `{ searchable, role, guidance }` for the builder |
  | `prompt.guidance` | A paragraph the agent prompt adds when one of the connector's tools is offered |

  TypeBox validates each manifest at load, and the slug against its
  folder. A connector that lists tools with no endpoint must have an
  adapter `call`, and a `state` key comes with a `state` hook.

  A server's tools are its manifest's (Cigale, CoinGecko, Alchemy, X,
  TwitterAPI.io, Qonto, DexPaprika, Tavily, Gmail) and, for an
  organisation, the tools its connected logins have listed (Notion,
  Drive, Sentry, OpenSea, and Etherscan list theirs from a session).
  GitHub has none. The builder names an enabled
  server's manifest tools always, and its listed tools once the
  organisation has a connected login on it; another organisation's
  listings never reach it. Capability search runs in memory over
  those.

  A new login's tool starts Off at its owner when the admin set it
  Off, or, with no admin default, when the manifest marks it
  `mutating` or a `policy.default_off` pattern matches it. A tool the
  manifest does not name, listed from a session, also starts Off when
  its listing marks it `destructiveHint` or its name carries a writing
  verb (`src/mcp/verbs.ts`: create, update, delete, send, and the
  like); it starts On otherwise. An absent hint decides nothing and
  `readOnlyHint` never turns a tool On. Each listed tool keeps its
  `readOnlyHint` and `destructiveHint` in `mcp_tools`, null when the
  listing gave none ([SEC-16](../architecture/security-register.md)).

  `GET /api/mcp/servers` lists the installed servers, each with
  `enabled` and the
  connector's `auth_fields`, `source` (`core` for a folder in the
  image), `verified`, `publisher`, and `logo_url`
  (`GET /api/mcp/servers/{id}/logo`, the folder's `logo.svg` served
  with a `default-src 'none'` policy). The instance admin
  edits the catalog under **Admin → Connector catalog**
  (`/api/admin/mcp/servers`):

  - `PATCH /api/admin/mcp/servers/{id}` switches a connector on or
    off; on a `local` row it edits the fields, on any other it writes
    `display_name`, `description`, `limitations`, and `setup_hint`
    into `overrides`, where `null` clears one. The endpoint, auth, and
    slug of a connector the box did not write come from its manifest.
  - `PATCH /api/admin/mcp/servers/{id}/tools/{name}` writes one tool's
    `description`, `input_schema`, and `default` (On or Off for a new
    login) into `overrides.tools[name]`; a listed tool takes the
    description and schema edits at its next listing.
  - `GET /api/admin/mcp/servers/{id}/export` returns the connector in
    the folder's `connector.json` format, overrides applied.
  - `POST /api/admin/mcp/servers` adds a remote MCP server by hand:
    a `local` row on public HTTPS, `auth` `none`, `token`, or `oauth`
    (`dynamic` or `configured`), its tool prefix generated from the
    slug.

  A disabled connector is out of the builder and refuses Connect;
  its existing logins keep showing.

  An organisation adds remote MCP servers of its own. Its owners and
  admins do it under **Settings → Tools**:

  - `POST /api/orgs/{org}/mcp/servers` with a slug, a URL on public
    HTTPS, an optional display name and description, and `auth`
    `none`, `token`, or `oauth` (a dynamically registered client;
    `configured` needs an instance client and stays the platform's).
    The row is `local` with `owner_org_id` set, on at creation, its
    tool prefix generated from the slug against every prefix on the
    box, since tool bindings and recipe overlays name a tool by its
    prefixed name alone. `OrgLimits.maxMcpServers` caps how many an
    organisation adds; core's open policy sets none.
  - `PATCH` and `DELETE /api/orgs/{org}/mcp/servers/{id}` edit it or
    remove it with its logins and the bindings that name it.

  A slug is unique per owner: two organisations may each add a server
  under one slug, but an organisation's slug may not be a platform
  connector's, nor a platform server's an organisation's; the refusal
  names the other side. An organisation's server is visible to it
  alone: `GET /api/mcp/servers`, the access views, the builder, and
  recipe apply read the platform's servers and the caller's own, and
  another organisation's id is a 404 at Connect, at a binding, and at
  its routes. Its card reads **This organisation's**. Connect fills a
  blank display name (the slug) and description from the server's
  `initialize` reply (`serverInfo` and `instructions`), and an OAuth
  start answers `authorization_host`, which the sign-in dialog names
  before the operator goes.

  Every request a session sends to an endpoint first resolves its
  host and refuses a private, loopback, link-local, or metadata
  address, beside the save-time URL check, so a public name later
  pointed inward is caught ([SEC-17](../architecture/security-register.md)).

  `PUT /api/bindings` accepts `catalog_kind=mcp` when the catalog id
  is a server row, and `catalog_kind=mcp_tool` when the catalog id is
  a namespaced tool `{slug}_{name}` listed on a connection.

- **Connections**: one login for one catalog server (a remote MCP
  server or a local adapter), owned at a scope, with `account_hint`
  for display and `status` of `pending`, `connected`, or
  `disconnected`.

  Token and OAuth payloads stay in the orchestrator. One connection
  per server per owner. Connect creates a pending connection at that
  scope, or retries a pending or disconnected one. It is a 409 while
  a connected login exists.

  A token Connect goes through one operation,
  `connect` (`src/connectors/connect.ts`): it reads the inputs the
  manifest's `auth.fields` names (a missing required one is a 422
  naming it), runs the connector's `validate`, stores the
  credentials encrypted under those names with the hint `validate`
  returns, and lists the login's tools. A rejected key is a 422 and
  stores nothing. Its `on_existing` says what happens to a connected
  login: `refuse` (the 409), `keep`, `replace`, or
  `{ replace_when_hint }`, which replaces only a login with that
  account hint; credentials equal to the stored ones answer
  `current`. The connect route uses `refuse`.

  Token connect marks it `connected` and writes the enabled binding
  in the same request:

  - Cigale
  - CoinGecko
  - Alchemy
  - OpenSea
  - Etherscan
  - X
  - TwitterAPI.io
  - Qonto
  - DexPaprika

  Browser OAuth (Notion, Gmail, Drive, Sentry) and the GitHub App
  install leave the connection pending and write the enabled binding
  on a successful callback
  ([Connectors](connectors.md), [Gmail and Drive](google.md),
  [GitHub](github.md)).

    List and get return metadata only. Delete cascades bindings that
  point at it.

  An organisation login to a connector whose manifest sets
  `builder.searchable` (Notion) is searchable from the guild builder
  so the coach can suggest existing databases. A connector with
  `builder.role` `system_of_record` stays the home for long-lived
  operator records. Queues and working files stay in local notes or
  collections.

- **Bindings**: which scope offers which catalog item. Bindings are
  the grant. `catalog_kind` is `native_tool`, `mcp`, `mcp_tool`, or
  `artifact_grant`. `PUT` or `DELETE /api/bindings` with any other
  kind is 422.

  An `mcp` binding may carry a `connection_id`. Native-tool and
  `mcp_tool` bindings never do. A listed MCP tool inherits the
  server grant until a tool overlay replaces `enabled`. Server Off
  keeps every tool from that server Off.

Visibility follows ownership:

- a platform connection may be bound anywhere
- an organisation one at that organisation or its guilds and agents
- a guild one at that guild or its members
- an agent one only at that agent

Resolution walks platform, then the organisation, then the agent's
guild, then the agent. Each present row replaces `enabled` and, when
it carries a connection, the current connection. An absent row leaves
the current state.

The empty chain is disabled. That walk covers enable-downward,
opt-out, enable-extra, override-login, and re-enable.

Platform seed bindings enable:

- the note tools (`note_find`, `note_get`, `note_write`,
  `note_delete`)
- the record tools (`record_search`, `record_list`, `record_add`,
  `record_update`, `record_remove`)
- `memory_write`
- the five script tools
- the six schedule tools
- `secret_store`
- `secret_request`
- `group_post`

New agents inherit that set. An organisation, guild, or agent can
turn any of them Off. The Tools view groups the two secret tools as
**Secrets**.

`report_issue` and the eight browser tools are never bindings.
Deleting a connection, agent, or guild cascades the bindings that
point at it.

The per-scope views that show and edit these bindings are described
in [Secrets and access](../concepts/secrets-and-access.md#access-views).

Every connector's access view carries `oauth_setup_state`:

- `not_applicable`
- `dynamic`
- `configured`
- `unsupported` when the box holds no OAuth client or App for it

The Tools view marks an unsupported connector **Not set up**. It
names the variables the box lacks and disables Connect
([Integrations](#integrations)).

## Integrations

An integration is something the box as a whole can do once the
operator sets its key in `.env`, as opposed to a login an
organisation connects. One registry
(`apps/orchestrator/src/instance/integrations.ts`) names each one,
the environment variables it reads, and what it switches on.
Modules ask the registry, not the environment. An integration is
`on` when every variable it requires is set, `off` when none is,
and `incomplete` when some are.

| Integration | Variables | Switches on |
|---|---|---|
| `web-search` | `TAVILY_API_KEY` | The Tavily connector's platform login, `tavily_search` |
| `group-routing` | `TYPESAFE_API_KEY`, and `TYPESAFE_MODEL` to tune it | Recipient and history selection in group chat |
| `github-app` | `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | The GitHub connector and a guild's repositories ([GitHub](github.md)) |
| `google-connectors` | `GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET` | The Gmail and Drive connectors ([Gmail and Drive](google.md)) |
| `error-reporting` | `SENTRY_DSN` | Sentry |

`GET /api/instance` (any user of the box) reports:

- the box's `auth_mode`
- each integration's state
- which of its variables are set, never a value
- what it switches on: native tools and connector slugs

The operator app reads it and turns off what depends on a missing
integration, naming the variables that would switch it on:

- **Admin**, **Platform keys** lists every integration with its
  state
- the Tools view marks a connector without its App or OAuth client
  **Not set up**

No integration serves a model provider; an organisation connects its
own under **Settings**, **Model keys**
([Users and organisations](../concepts/users-and-organisations.md#model-providers)).

Setting the variables is
[Configure](../getting-started/configure.md).
