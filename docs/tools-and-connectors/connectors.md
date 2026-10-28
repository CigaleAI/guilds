# Connectors

A connector is a catalog server: a remote MCP endpoint, adapter code in
the orchestrator, or both. An organisation, a guild, or an agent signs
in to it with a login, and the login's tools reach the agent's runs.
Bindings decide which scope offers which connector
([Access](../concepts/access.md)).

This page describes how connectors work. The
[connector list](connector-list.md) describes each connector the box
ships. [Gmail and Drive](google.md) and [GitHub](github.md) need a
client the box holds, which a platform admin sets up under **Admin**,
**Platform keys** ([Platform keys](platform-keys.md)).

## Where connectors come from

Every connector the box ships is a folder under
`apps/orchestrator/src/connectors/<slug>/`:

- `connector.json`, the manifest: everything that is not code
- `adapter.ts` when the connector has code, and the client code it
  needs
- `responses.ts` beside a client that calls a provider's API: a
  TypeBox schema for each response the client reads. The client
  decodes each response against its schema once, with
  `lib/decode.ts`, and formats the decoded value; a response that
  does not match fails the call with the field at fault
- an optional `logo.svg` (24×24, `currentColor`)

`src/connectors/index.ts` lists core's folders. An extension adds its
own through `ServerExtension.connectors`
([Extension points](../architecture/extension-points.md)). A connector
also comes from the [connector registry](connector-registry.md), or
from a server the instance admin or an organisation adds by hand.

Installed connectors are rows of one table, `connectors`: the manifest
as a JSON document beside the box's state for it.

| Column | Holds |
| --- | --- |
| `id`, `slug`, `tool_prefix` | The server id, its slug, and the prefix of its tool names, unique on the box |
| `owner_org_id` | Null for a platform connector |
| `manifest` | The manifest, as its folder or the Admin form wrote it |
| `source`, `verified`, `publisher`, `version` | Where it came from: `core` (a folder in the image), `registry`, or `local` (made on this box) |
| `enabled` | The connector's switch; on at install |
| `oauth_client` | The client a `dynamic` OAuth connector registered |
| `overrides` | The instance admin's edits, applied on read |

At boot, every installed folder replaces its row's manifest and
source, with or without a version bump. The switch, the OAuth client,
and the overrides are kept. One loader (`connectors/load.ts`) applies
`overrides` to the manifest for every reader. A server added by hand
is a `local` row with no folder, and its row is its source of truth.

A connector has an endpoint, an adapter, or both:

- **Endpoint only**: the pool's MCP client lists and calls the remote
  server.
- **Adapter only**: adapter code calls the provider's API.
- **Both**: the adapter wraps the endpoint's session.

### The manifest

| Key | Meaning |
| --- | --- |
| `slug` | Equals the folder name. The server id is `mcp_<slug>` |
| `display_name`, `description`, `limitations`, `setup_hint` | Operator copy |
| `endpoint.url` | The remote MCP server, public HTTPS |
| `endpoint.headers` | Custom `X-` headers every request to the endpoint sends. Names are case-insensitive: each appears once, and none is `auth.header`'s |
| `auth.kind` | `token`, `oauth`, or `none` |
| `auth.fields` | A token login's inputs `{ name, label, secret, optional, multiline, placeholder }`. `multiline` is a text area. Omitted, one secret field named `token` |
| `auth.header` | `{ name, prefix }`, the header an endpoint's token travels in. Default: `Authorization: Bearer` |
| `auth.oauth` | `{ strategy, provider, scopes }`. `strategy` is `dynamic`, `configured`, or `github_app` ([OAuth](#oauth)) |
| `auth.instance` | `{ integration, field }` or `{ own: true }` ([Platform logins](#platform-logins)) |
| `requires.integration` | The integration the connector needs ([Platform keys](platform-keys.md)) |
| `tools[]` | `{ name, description, input_schema, mutating }`, the curated list |
| `policy.default_off` | Name patterns that start Off; `*` matches any run of characters |
| `policy.exclude` | Name patterns of listed tools no login's catalog keeps |
| `settings_schema` | The login's settings document ([Login settings](#login-settings)) |
| `state` | `{ key, intro }`: the State key the adapter's `state` hook fills |
| `builder` | `{ searchable, role, guidance }` for the guild builder |
| `prompt.guidance` | A paragraph the agent prompt adds when one of the connector's tools is offered |

TypeBox validates each manifest at load, and its slug against its
folder. A connector that lists tools and has no endpoint needs an
adapter `call`. A `state` key needs a `state` hook, and a `state` hook
needs a `state` key.

An organisation login to a connector with `builder.searchable` is
searchable from the guild builder, so the coach can suggest what it
already holds. A connector with `builder.role` `system_of_record` is
the home for long-lived operator records. Queues and working files
belong in notes or collections.

## Logins

A login (a connection, `mcp_connections`) is one sign-in to one
connector, owned at a scope: platform, organisation, guild, or agent.
It has an `account_hint` for display and a `status` of `pending`,
`connected`, or `disconnected`. There is one login per connector per
owner.

Credentials stay in the orchestrator, encrypted, and never enter a
sandbox. Their values join run redaction. Agents that inherit the same
login share one MCP session. Two logins are two sessions.

Connect creates a pending login at a scope, or retries a pending or
disconnected one. It is a 409 while a connected login exists. Connect
refuses a platform owner. The app connects at the organisation, a
guild, or an agent.

### Token logins

Every token connector connects through one operation, `connect`
(`src/connectors/connect.ts`):

1. It reads the inputs `auth.fields` names. A missing required one is
   a 422 naming it.
2. It checks `settings` against the connector's `settings_schema`
   when the request sends any.
3. It applies `onExisting` to a connected login of the same owner.
4. It runs the connector's `validate`, which returns the account hint.
5. It stores the credentials encrypted under the field names.
6. It lists the login's tools, and the login is `connected` with its
   enabled binding, in the same request.

A rejected key (401 or 403 from the provider) is a 422 and stores
nothing. Any other provider failure is a 502. A listing the server
rejects with 401 or 403 removes the new login.

`onExisting` says what happens to a connected login:

| Value | Effect |
| --- | --- |
| `refuse` | A 409. The connect route uses this |
| `keep` | The stored login stays |
| `replace` | The new credentials replace it |
| `{ replace_when_hint }` | They replace only a login with that account hint |

Credentials equal to the stored ones answer `current`.

A login whose `settings_schema` has required properties it lacks
stays `pending` until its settings are saved
([Login settings](#login-settings)).

### Browser logins

OAuth logins leave the login pending and write its enabled binding on
a successful callback ([OAuth](#oauth)). The GitHub App follows its
own install flow ([GitHub](github.md#connect-flow)).

### Login settings

What a login stores beside its credentials is one JSON document,
`mcp_connections.settings`. The connector's `settings_schema`
describes it: Drive's `folder_id` ([Gmail and Drive](google.md)) and
the GitHub login's `repositories` ([GitHub](github.md)). A login's
settings live on that login, not in the agent's configuration.

The check covers `type`, `properties`, `required`,
`additionalProperties`, `items`, `minItems`, `maxItems`, `minLength`,
`maxLength`, `pattern`, and `enum`. A property marked `x-lookup` gets
a search box that the adapter's `lookup` fills.

A login that lacks a required setting is signed in but `pending`. Its
metadata carries `needs_settings`, and its card shows the settings
form. After an OAuth callback, the page says to finish setup in
guilds.run. The first save that completes the document connects the
login and lists its tools. Every login carries its `settings`. The
access card adds the connector's `settings_schema`.

## Platform logins

A connector whose manifest names `auth.instance` runs on a platform
key, for every organisation without a login of its own. It takes one
of two forms:

- `{ integration, field }`: that field of one of the box's own
  integrations. Only a connector the box ships, core or an extension,
  may use it. The Web search connector names `web-search`'s `api_key`.
- `{ own: true }`: the token connector's own login fields, as the
  platform key `connector:<slug>`
  ([A connector's own key or client](platform-keys.md#a-connectors-own-key-or-client)).

`syncInstanceLogins` (`src/connectors/instance.ts`) gives the
connector a platform login while its integration is on. The login
holds an empty encrypted payload, is `connected`, and has an enabled
platform binding. Every scope inherits that binding, and any scope may
turn it Off. While the integration is off, the login is
`disconnected`, and a run leaves its tools out instead of failing.

The sync runs:

- at boot, once the key store is loaded
- after every platform key write
- after every connector registry change from Admin

Entering or removing a key takes effect without a restart.

The pool reads the key at call time. It is never stored on the login
and never enters a sandbox. Run output redacts it as
`[REDACTED:platform_<slug>_<field>]`, for example
`platform_tavily_api_key`. An organisation may still connect a key of
its own. That login resolves like any other and calls with its own
key.

Calls on a platform login are counted per organisation, connector, and
UTC month in `connector_calls`. `OrgLimits.monthlyConnectorCalls`
caps them by connector slug. A slug it does not name is uncapped, and
core's open policy names none. A call past the cap does not reach the
provider. Its result is `ERROR: <source> limit reached: <slug> calls
this month`. Calls on an organisation's own login are neither counted
nor capped.

## Tools of a login

A connector's tools are its manifest's `tools[]`, or the tools its
endpoint lists from a session, or what its adapter's `list` returns.
GitHub has none. Each login's tools are stored in `mcp_tools`, with
the listing's `readOnlyHint` and `destructiveHint`, null when the
listing gave none.

Connect and a successful callback list at once. After that, run starts
and access views read the stored list. A run start lists again once
the stored list is 10 minutes old. A listing failure at run start
keeps the stored list and logs. A listing of more than 200 tools, or a
reply over 1 MB, is an error.

The model sees a tool as `<tool_prefix>_<name>`. The prefix is the
connector's `tool_prefix`, generated from its slug: lowercase letters
and digits, at most 32 characters, with a number added when it is
taken or reserved. Every character of the name outside
`[A-Za-z0-9_-]` becomes `_`, and leading and trailing `_` are trimmed.
A call maps the prefixed name through the run snapshot to the tool's
remote name.

### What starts Off

When a tool first appears on a login, it is written Off or On at the
login owner's scope, before the run or the view that listed it
resolves it. The first rule that applies wins:

1. The instance admin's default for that tool.
2. Off when the manifest marks it `mutating`.
3. Off when a `policy.default_off` pattern matches it.
4. For a listed tool the manifest does not name: Off when its listing
   marks it `destructiveHint`, or its name carries a writing verb
   (`src/mcp/verbs.ts`: create, update, delete, send, merge, push,
   and the like).
5. On.

An absent hint decides nothing, and `readOnlyHint` never turns a tool
On
([SEC-16](../architecture/security-register.md#sec-16--a-listed-tool-whose-name-reads-as-harmless-now-starts-on)).
A later listing leaves an existing overlay in place. How a tool's
switch is inherited across scopes is
[Bindings for tools](../concepts/access.md#bindings-for-tools).

### Testing a tool

**Test** on a connected login opens one tool, fills its arguments
from the listed schema, and calls
`POST /api/mcp/connections/{id}/call`. The result is redacted against
that login's credentials and byte-capped.

## The pool and adapters

The orchestrator holds every MCP session. It never starts an MCP
server inside a sandbox. The pool is keyed by login id.

A server that no longer knows a session answers its next request
with a 404, or a 400 with no JSON-RPC body. The session then starts
over and sends that request once more. A reply that is not JSON is an
error with its status and the start of what the server said.

The pool knows no connector by name. It asks the connector lookup
(`src/connectors/registry.ts`) for the server's entry and dispatches
to its adapter (`src/connectors/types.ts`). Where the adapter has no
method, it falls back to the MCP client. A server added by hand uses
the MCP client alone.

| Adapter method | Runs | Default |
| --- | --- | --- |
| `validate(creds, ctx)` | At Connect and at every settings change. Returns the account hint | `initialize` against the endpoint; nothing without one |
| `lookup(property, query, creds, ctx)` | A settings search box | None: a 404 |
| `list(creds, ctx)` | A tool listing | The endpoint's `tools/list`, else the manifest's tools |
| `call(name, args, creds, ctx)` | A tool call | The endpoint's `tools/call` |
| `state(creds, ctx)` | Once per run start | None |

The adapter gets:

- `creds`: the decrypted payload's strings, keyed by the manifest's
  field names
- `ctx.settings`: the login's stored settings
- `ctx.http`: the proxy-aware HTTP client with the adapter timeout
- `ctx.remote`: the pool's session on the endpoint. Its calls run
  inside the pool's auth retry and drop the session on error. On a
  connector with no endpoint, it refuses.
- `ctx.workspace_dir`: the agent's home on the host, when the call
  comes from a run

An adapter reads what the agent names in its home through
`lib/agent-file.ts`: `readAgentFile` for one file, `readAgentFolder`
for every file under a folder. Each refuses a path that leaves the
home once links are followed. An adapter throws one `ConnectorError`
with a status, which the pool answers as an `McpError`.

For an OAuth connector, the pool refreshes an expired access token
before any adapter code runs. A 401 gets one refresh and one retry,
from an adapter or a remote. A refresh that needs a new authorization
marks the login disconnected.

### State hooks

A `state` hook runs at every run start for each connector the agent
has on with a connected login. The hooks run in parallel under one
5-second budget. A value over 32,000 serialised bytes, a failure, or a
timeout puts `{ unavailable: <reason> }` under the key and logs. The
value is redacted against the login's secrets before it enters
State: its token fields, each credential field the manifest does not
mark `secret: false`, and the instance key serving a platform login.
A key core uses is dropped. The prompt renders the
manifest's `state.intro` for each key present.

### Limits

| Limit | Value |
| --- | --- |
| Remote `tools/call` | 90 seconds |
| Remote `tools/list` | 15 seconds |
| Adapter HTTP request | 30 seconds |
| Tools in one listing | 200 |
| One listing reply | 1 MB |
| State hooks, all together | 5 seconds |
| One State value | 32,000 serialised bytes |

Every request a session sends to an endpoint first resolves its host.
It refuses a private, loopback, link-local, or metadata address. This
check runs beside the save-time URL check, so a public name later
pointed inward is caught
([SEC-17](../architecture/security-register.md#sec-17--an-organisations-own-mcp-server-makes-the-orchestrator-call-a-url-it-chose)).

## OAuth

`auth.oauth.strategy` picks where the OAuth client comes from:

| Strategy | Client | Example |
| --- | --- | --- |
| `dynamic` | Registered by the box at the provider (RFC 7591) | Notion, Sentry |
| `configured` with a `provider` | One of the box's integrations | Gmail and Drive ([Gmail and Drive](google.md)) |
| `configured` with no `provider` | The connector's own `connector:<slug>` platform key ([Platform keys](platform-keys.md#a-connectors-own-key-or-client)) | A registry connector |
| `github_app` | The box's GitHub App | GitHub ([GitHub](github.md)) |

Connect starts an OAuth 2.1 Authorization Code flow with PKCE and
`prompt=consent`. For a `dynamic` connector, the orchestrator
discovers the server's protected-resource and authorization-server
metadata. It registers a public client when the connector has none
for this redirect URI, and stores it on `connectors.oauth_client`. A
server that offers no registration and has no configured client is a
422 with `setup_state: unsupported`. Connect answers
`authorization_url` and `authorization_host`, which the sign-in dialog
names before the operator goes.

The callback is `PUBLIC_BASE_URL` plus `/api/mcp/oauth/callback` when
that variable is set. Without it, the address the request came in on
is used, which is enough for loopback. Notion rejects a non-loopback
`http://` redirect URI.

1. The pending login holds the PKCE verifier. Its `oauth_state` finds
   it at the callback.
2. A successful callback stores the access and refresh tokens, sets
   `connected`, writes the enabled binding, and lists the tools. Notion
   fills `account_hint` from its `email_domain` when present.
3. A denied or failed callback deletes a new pending login. A retry
   over a disconnected login leaves it `disconnected`, with its
   bindings intact.

A refresh uses the stored client. `invalid_grant` marks the login
disconnected.

## The catalog in Admin

`GET /api/mcp/servers` lists the servers the caller's organisation
sees: the platform's and its own. Each has `enabled`, the connector's
`auth_fields`, `source`, `verified`, `publisher`, and `logo_url`. The
logo (`GET /api/mcp/servers/{id}/logo`) is the folder's `logo.svg`,
served with a `default-src 'none'` policy.

The instance admin edits the catalog under **Admin**, **Connector
catalog**. A connector whose integration is not on is marked **Not set
up**, with a **Set up** link to Platform keys.

- `PATCH /api/admin/mcp/servers/{id}` switches a connector on or off.
  On a `local` row it edits the fields. On any other row it writes
  `display_name`, `description`, `limitations`, and `setup_hint` into
  `overrides`, where `null` clears one. The endpoint, auth, and slug
  of a connector the box did not write come from its manifest.
- `PATCH /api/admin/mcp/servers/{id}/tools/{name}` writes one tool's
  `description`, `input_schema`, and `default` (On or Off for a new
  login) into `overrides.tools[name]`. A listed tool takes the copy and
  schema edits at its next listing.
- `GET /api/admin/mcp/servers/{id}/export` returns the connector in
  the `connector.json` format, overrides applied.
- `POST /api/admin/mcp/servers` adds a remote MCP server by hand: a
  `local` row on public HTTPS, `auth` `none`, `token`, or `oauth`
  (`dynamic` or `configured`), its tool prefix generated from the
  slug.

A disabled connector is out of the builder and refuses Connect (422).
Its existing logins keep showing.

## An organisation's own servers

An organisation's owners and admins add remote MCP servers under
**Settings**, **Tools**:

- `POST /api/orgs/{org}/mcp/servers` takes a slug, a URL on public
  HTTPS, an optional display name and description, and `auth` `none`,
  `token`, or `oauth`. An OAuth server registers its client
  dynamically. The row is `local` with `owner_org_id` set, on at
  creation. Its tool prefix is generated against every prefix on the
  box, because tool bindings and recipe overlays name a tool by its
  prefixed name alone. `OrgLimits.maxMcpServers` caps how many an
  organisation adds. Core's open policy sets none.
- `PATCH` and `DELETE /api/orgs/{org}/mcp/servers/{id}` edit the
  server, or remove it with its logins and the bindings that name it.

A slug is unique per owner. Two organisations may each use one slug.
An organisation's slug may not be a platform connector's, and a
platform server's slug may not be an organisation's. The refusal names
the other side.

An organisation's server is visible to it alone.
`GET /api/mcp/servers`, the access views, the builder, and recipe
apply read the platform's servers and the caller's own. Another
organisation's id is a 404 at Connect, at a binding, and at its
routes. Its card reads **This organisation's**. Connect fills a blank
display name and description from the server's `initialize` reply
(`serverInfo` and `instructions`).

## Reference

### HTTP

| Route | Does |
| --- | --- |
| `GET /api/mcp/servers` | The servers the caller's organisation sees |
| `GET /api/mcp/servers/{id}/logo` | The connector's logo |
| `GET /api/mcp/connections?guild_id=&agent_id=` | The logins visible at the organisation, and at that guild or agent when named. `{ connections }`, metadata only |
| `POST /api/mcp/connections` | Connect: `{ mcp_server_id, owner_scope, owner_id, settings?, <auth fields> }`. 201 with the login's metadata, plus `authorization_url` and `authorization_host` for OAuth |
| `GET /api/mcp/connections/{id}` | One login's metadata and the bindings that use it |
| `DELETE /api/mcp/connections/{id}` | Deletes a login and the bindings that point at it. 204. A platform login is a 400 |
| `POST /api/mcp/connections/{id}/call` | **Test**: `{ tool, arguments }` |
| `POST /api/mcp/servers/{id}/lookup` | `{ property, q, credentials }`: searches with the Connect form's credentials, before the login exists |
| `GET /api/mcp/connections/{id}/lookup?property=&q=` | Searches with a saved login |
| `PUT /api/mcp/connections/{id}/settings` | Saves `{ settings }` |
| `GET /api/mcp/oauth/callback` | The OAuth callback, for every browser login |

A lookup answers `{ options: [{ value, label, detail, image }] }`,
where `value` is what the setting stores.

`PUT .../settings` checks the document against the schema (422 naming
the first problem), runs the adapter's `validate` with it, stores it,
and takes the hint `validate` returns as the login's `account_hint`.
A platform login is a 400. A login still waiting on its OAuth sign-in
is a 409.

Login metadata is `id`, `mcp_server_id`, `owner_scope`, `owner_id`,
`account_hint`, `status`, `created_at`, `updated_at`, `rotated_at`,
`settings`, and `needs_settings`. It never holds a credential.
