# Connectors

A connector is a catalog server: a remote MCP endpoint, a local
adapter, or both ([Catalog](catalog.md)). Most take a token the
organisation pastes. Notion and Sentry open a browser sign-in and
register their own client. [Gmail and Drive](google.md) and
[GitHub](github.md) use a client the box holds: a platform admin
registers an app and enters its credentials under **Admin**,
**Platform keys** ([Integrations](catalog.md#integrations)).

## Instance keys

A connector whose manifest names `auth.instance` runs on a key a
platform admin enters under **Admin**, **Platform keys**, for every
organisation. `auth.instance` is `{ integration, field }`: the
connector's platform login takes that field of that integration. Web
search is one: the Tavily connector (slug `tavily`, tool
`tavily_search`) names the `web-search` integration's `api_key`.
`search` takes natural-language `query`, searches at depth
`advanced`, and returns title, URL, and snippet for each source.

- `syncInstanceLogins` (`src/connectors/instance.ts`) gives the
  connector a platform login while its integration is on: an empty
  encrypted payload, `connected`, with an enabled platform binding
  that every scope inherits and any scope may turn Off. While the
  integration is off that login is `disconnected`, and a run leaves
  its tools out instead of failing. It runs at boot, once the key
  store is loaded, and again after every platform key write, so
  entering or removing the key takes effect without a restart.
- The pool reads the key at call time. It is never stored on the
  login, never enters the sandbox, and run output redacts it as
  `[REDACTED:platform_<slug>_<field>]` (`platform_tavily_api_key`).
- An organisation may still connect a key of its own. That login
  resolves like any other and calls with its own key.

A connector may hold a key or an OAuth client of its own instead of
one of the box's. `auth.instance: { "own": true }` on a token
connector makes its login fields a platform key, `connector:<slug>`
under **Platform keys**: the pool reads every field at call time as
the platform login's credentials, sent the way the connector's token
travels; the login follows the integration's state through the same
sync as Tavily's; and run output redacts each field as
`platform_<slug>_<field>`. `auth.oauth.strategy: "configured"` with
no `provider` makes Client ID and Client secret a platform key of
the same id; the authorization server is discovered from the
connector's endpoint, and while the client is unset the connector's
`oauth_setup_state` is `unsupported` (**Not set up**). The
`{ integration, field }` form reads one of the box's shipped
integrations and is for connectors the box ships, core or an
edition; a connector installed at runtime declares its own
([Registry](registry.md)).

Calls on a platform login are counted per organisation, connector,
and UTC month in `connector_calls`. `OrgLimits.monthlyConnectorCalls`
caps them by connector slug; a slug it does not name is uncapped, and
core's open policy names none. A call past the cap does not reach the
API: its tool result is `ERROR: <source> limit reached: <slug> calls
this month`. Calls on an organisation's own login are neither
counted nor capped.

## MCP client and OAuth

The orchestrator holds MCP sessions. It does not start MCP servers
inside agent sandboxes. The pool key is `connection_id`.

Agents that inherit the same login share a session. Two connections
are two sessions.

### Adapters

The pool knows no connector by name: it asks the registry
(`src/connectors/registry.ts`) for the server's entry and dispatches
to its adapter (`src/connectors/types.ts`), falling back to the MCP
client where the adapter has no method. A server created by hand is
the MCP client alone.

| Adapter method | When | Default |
| --- | --- | --- |
| `validate(creds, ctx)` | Connect, a forced sync, a settings change; returns the account hint | `initialize` against the endpoint |
| `lookup(property, query, creds, ctx)` | A settings search box | None: a 404 |
| `list(creds, ctx)` | A tool sync | The endpoint's `tools/list`, else the manifest's tools |
| `call(name, args, creds, ctx)` | A tool call | The endpoint's `tools/call` |
| `state(creds, ctx)` | Once per run start | None |

Credentials arrive as the decrypted payload's strings, keyed by the
manifest's field names; settings as the login's stored settings.
`ctx.http` is the proxy-aware HTTP client with the adapter timeout,
`ctx.remote` the pool's facade over the endpoint's session (its
calls run inside the pool's auth retry and drop the session on
error; on a connector with no endpoint it refuses), and
`ctx.workspace_dir` the agent's home on the host when the call comes from a
run. An adapter reads what the agent names there through
`lib/agent-file.ts`: `readAgentFile` one file, `readAgentFolder`
every file under a folder, each refusing a path that leaves the
home once links are followed. An adapter throws one `ConnectorError` with a status, which the
pool answers as an `McpError`.

For an OAuth connector the pool refreshes an expired access token
before any adapter code runs, and a 401 from the adapter gets one
refresh and one retry, as a remote 401 does. A refresh that needs a
new authorization marks the login disconnected, for adapter and
remote connectors alike.

A `state` hook runs at every run start for each connector the agent
has on with a connected login. The hooks run in parallel under one
5-second budget; a value over 32,000 serialised bytes, a failure, or
a timeout puts `{ unavailable: <reason> }` under the key and logs.
The value is redacted against the login's credentials before it
enters State, and a key core uses is dropped. The prompt renders the
manifest's `state.intro` for each key present.

Connect validates credentials. It writes the listed tools into
`mcp_tools` when the connector has tools. A call to an adapter-only
connector opens no session.

- CoinGecko hits Pro REST with the stored key. Its `prices` tool
  quotes coin ids on demand.
- Alchemy hits NFT REST with the stored key.
- X hits `https://api.x.com/2` with the stored bearer token.
- TwitterAPI.io hits `https://api.twitterapi.io` with the stored
  `x-api-key`.
- Qonto hits `https://thirdparty.qonto.com` with
  `Authorization: {login}:{secret_key}`.
- DexPaprika hits `https://api.dexpaprika.com` with the stored key
  as the raw `Authorization` header, retrying
  `https://api-pro.dexpaprika.com` on 403.
- Gmail hits `https://gmail.googleapis.com/gmail/v1` with the stored
  Google access token (`gmail.readonly` and `gmail.compose`)
  ([Gmail and Drive](google.md)).

Those keys never enter the sandbox. The Tools view shows each as one
server with a switch per tool. Test on a connected login opens a
function, fills its arguments from the listed schema, and calls
`POST /api/mcp/connections/{id}/call`. The result is redacted against
that login's credentials and byte-capped.

A guild connection plus a guild MCP binding gives every member that
server's listed tools. An agent overlay with `enabled=false` revokes
that server for that agent. An agent overlay with a different
`connection_id` is a local relogin.

Per-tool Inherit / On / Off walk the same platform → organisation →
guild → agent chain. A new listed tool inherits the server grant
until overlaid. Tool On does not punch through server Off.

Listed tools persist per connection in `mcp_tools`. Connect and a
successful callback list immediately. Afterwards the stored catalog
serves run starts and access views. A remote `tools/list` runs again
only once the stored catalog is 10 minutes old.

A listing failure at run start keeps the stored catalog and logs.
Individual calls report their own errors. The model sees
`{slug}_{name}` (dots become `_`). A call maps that namespaced name
through the run snapshot to `remote_name` and
`McpPool.call(connection_id, remote_name, args)`.

Timeouts:

- a remote `tools/call` waits up to 90 seconds
- `tools/list` stays at 15 seconds
- adapter HTTP stays at 30 seconds

Results use the same output pipeline.

### Login settings

What a login stores beside its credentials is one JSON document,
`mcp_connections.settings`, which the connector's manifest describes
with `settings_schema`: Drive's `folder_id`
([Gmail and Drive](google.md)) and the GitHub login's
`repositories` ([GitHub](github.md)). The check
covers `type`, `properties`, `required`, `additionalProperties`,
`items`, `minItems`, `maxItems`, `minLength`, `maxLength`, `pattern`,
and `enum`. A property marked `x-lookup` gets a search box the
adapter's `lookup` fills.

- `POST /api/mcp/servers/{id}/lookup` with `{ property, q, credentials }`
  searches with the Connect form's credentials, before the login
  exists.
- `GET /api/mcp/connections/{id}/lookup?property=&q=` searches with a
  saved login.
- `PUT /api/mcp/connections/{id}/settings` with `{ settings }` checks
  the document against the schema (422 naming the first problem),
  runs the adapter's `validate` with it, stores it, and takes the hint
  `validate` returns as the login's `account_hint`. Platform logins
  are not changed here.

Each lookup answers `{ options: [{ value, label, detail, image }] }`,
where `value` is what the setting stores.

A login whose schema has required properties it lacks stays
`pending` after a token Connect (which accepts `settings` beside the
credentials) or after the OAuth callback, which then shows a page
saying to finish setup in guilds.run. Such a login is signed in:
its connection metadata and access card carry `needs_settings`, its
card shows the settings form, and the first save that completes the
document connects it and lists its tools. Every connection carries
its `settings`; the access card adds the connector's
`settings_schema`.

A tool that starts Off is listed and written Off at the connection
owner scope on first appearance: Gmail `send_message`, Qonto
`upload_invoice`, Drive `create_file` and
`copy_file`, OpenSea's management tools, and a listed tool with a
writing verb or `destructiveHint`. A later sync leaves an existing
overlay in place.

Notion, Drive, Sentry, Cigale, OpenSea, and Etherscan tool rows
appear after a successful remote list.

- CoinGecko writes its curated tool list after a successful `/ping`.
- Alchemy writes `holdings`, `nft`, and `collection` after a
  successful NFT API ping.
- X writes `search`, `user`, `posts`, and `post` after a successful
  user lookup of `X`.
- TwitterAPI.io writes `search`, `user`, `posts`, `post`,
  `followers`, `following`, `mentions`, `replies`, `quotes`, and
  `trends` after a successful `/oapi/my/info` balance check.
- Qonto writes `list_bank_accounts`, `list_missing_invoices`,
  `get_transaction`, and `upload_invoice` after a successful
  `/v2/organization` ping.
- DexPaprika writes `search`, `token`, `prices`, `pool`, `pools`,
  `ohlcv`, and `swaps` after a successful `/usage` check.
- Gmail writes `search_threads`, `get_thread`, `get_message`,
  `list_labels`, `list_drafts`, `create_draft`, and `send_message`
  after a successful `/users/me/profile` ping
  ([Gmail and Drive](google.md)).
OpenSea's `policy.default_off` names these, written Off after a
successful remote list:

- `get_instant_api_key`
- `manage_collections`
- `get_favorites`
- `manage_watchlist`
- `manage_profile`
- `manage_wallets`
- `manage_drops`
- `check_drop_eligibility`
- `cancel_orders`

Per-connection listed tools live in `mcp_tools`.

## Token logins

Cigale Connect is a Bearer API key. The UI collects the key. The
connection stores it encrypted. `status` is `connected`.

The orchestrator lists tools over POST
`https://api.cigale.ai/api/v1/public/mcp`.

The catalog publishes ten tools:

- knowledge-base tweet search (about five months)
- 24-hour semantic search
- reply drafts from a Cigale agent or campaign
- trend reports
- reply opportunities
- view forecasts

A rejected key is a Connect error. Token values join run redaction.

OpenSea Connect is an API key on the same token form. The
orchestrator lists tools over POST `https://mcp.opensea.io/mcp` with
`X-API-KEY`.

An empty catalog, or a catalog of only `get_instant_api_key`, is a
rejected key. Calls use that session. The default-off overlay
covers:

- `get_instant_api_key`
- `manage_collections`
- `get_favorites`
- `manage_watchlist`
- `manage_profile`
- `manage_wallets`
- `manage_drops`
- `check_drop_eligibility`
- `cancel_orders`

Etherscan Connect is a Bearer API key on the same token form. The
orchestrator lists tools over POST `https://mcp.etherscan.io/mcp`
with `Authorization: Bearer`. A rejected key is a Connect error.

Calls use that session. Every tool is read-only public onchain data.
Some need a paid Etherscan plan. Each call counts against the
operator's API quota.

CoinGecko Connect is a Pro API key on the same token form. The
orchestrator checks `GET https://pro-api.coingecko.com/api/v3/ping`
with `x-cg-pro-api-key`, then writes eight tools into `mcp_tools`:

- `search`
- `coin`
- `prices`
- `new`
- `movers`
- `supply`
- `chart`
- `trending`

Calls hit Pro REST and return compact TSV:

- no images, HTML, tickers, or localization
- lists default to 15 rows (cap 30)
- charts downsample to 48 points

`new`, `movers`, and `supply` need Analyst plan and above. A
rejected key is a Connect error.

Alchemy Connect is an NFT API key on the same token form. The
orchestrator checks
`GET https://eth-mainnet.g.alchemy.com/nft/v3/{key}/getNFTsForOwner`
with a zero owner, then writes three tools into `mcp_tools`:

- `holdings`
- `nft`
- `collection`

Calls hit NFT REST and return compact TSV:

- no images, descriptions, or token URIs
- lists default to 15 rows (cap 30)

`holdings` takes an owner address (ENS on ethereum) and optional
chain, contract filter, and page_key. Chains:

- `ethereum`
- `polygon`
- `base`
- `arbitrum`
- `bsc`
- `optimism`
- `ink`
- `robinhood`
- `solana`

Solana holdings use DAS `getAssetsByOwner` on `solana-mainnet`. EVM
chains use NFT REST. A rejected key is a Connect error.

X Connect is a bearer token on the same token form. The
orchestrator checks `GET https://api.x.com/2/users/by/username/X`
with `Authorization: Bearer`, then writes four tools into
`mcp_tools`:

- `search`
- `user`
- `posts`
- `post`

Calls hit X API v2 and return compact TSV:

- no profile images
- lists default to 15 rows (cap 30)
- post text clips at 280 characters

`search` is recent search (last 7 days). `user` and `posts` take a
username or user id. `post` takes a post id or status URL. A
rejected token is a Connect error.

TwitterAPI.io Connect is an API key on the same token form. The
orchestrator checks `GET https://api.twitterapi.io/oapi/my/info`
with `x-api-key`, then writes ten tools into `mcp_tools`:

- `search`
- `user`
- `posts`
- `post`
- `followers`
- `following`
- `mentions`
- `replies`
- `quotes`
- `trends`

Calls hit TwitterAPI.io REST and return compact TSV:

- no profile images
- lists default to 15 rows (cap 30)
- post text clips at 280 characters

`search` is advanced search for the last 24 hours, ranked by Top.

- `user`, `posts`, `followers`, `following`, and `mentions` take a
  username
- `user` and `posts` also accept a user id
- `post`, `replies`, and `quotes` take a post id or status URL
- `trends` takes an optional WOEID (default 1, worldwide)

A rejected key is a Connect error.

Qonto Connect collects the organization's login and secret key from
Integrations → API key. The orchestrator checks
`GET https://thirdparty.qonto.com/v2/organization` with
`Authorization: {login}:{secret_key}`, then writes four tools into
`mcp_tools`:

- `list_bank_accounts`
- `list_missing_invoices`
- `get_transaction`
- `upload_invoice`

Calls hit Qonto Business API v2 and return compact TSV.
`list_missing_invoices` finds completed transactions that still
need an invoice:

- empty `attachment_ids`
- `attachment_required` true
- `attachment_lost` not true
- default last 90 days, debit side

`upload_invoice` attaches a PDF, JPEG, or PNG from the agent
home (`/home/<agent id>`, under the
[home file rules](../concepts/agent-home.md#agent-home-files)).
Qonto processes the file in the background and the call waits up
to 60 seconds.

Production API only. A rejected key is a Connect error. Login and
secret key join run redaction.

DexPaprika Connect is an API key on the same token form. The
orchestrator checks `GET https://api.dexpaprika.com/usage` with the
key as the entire `Authorization` header, then writes seven tools
into `mcp_tools`:

- `search`
- `token`
- `prices`
- `pool`
- `pools`
- `ohlcv`
- `swaps`

A `keyless` plan, or HTTP 401/403, is a rejected key. Calls hit
REST and return compact TSV:

- no images, websites, or descriptions
- lists default to 15 rows (cap 30)
- OHLCV downsamples to 48 candles

`search` is cross-network. `token`, `prices`, `pool`, `pools`,
`ohlcv`, and `swaps` take a network id (`ethereum`, `solana`,
`base`, …).

`prices` batches at most 10 addresses. `ohlcv` defaults to the last
24 hours at `1h`. A free key allows `10m` and up over 7 days. A
rejected key is a Connect error.

Platform-scope Connect and platform credential mutation stay
reserved. The UI and API create organisation, guild, and agent
logins.

## Browser OAuth

Notion Connect starts a browser OAuth 2.1 Authorization Code flow
with PKCE. The orchestrator discovers the remote server's
protected-resource and authorization-server metadata. It registers a
public client (RFC 7591) when the catalog row has no client for this
redirect URI, and stores that client on `connectors.oauth_client`.

The callback is `PUBLIC_BASE_URL` plus `/api/mcp/oauth/callback`
when that variable is set (Notion rejects non-loopback `http://`
redirect URIs). Without it the inbound host is used, which is
enough for loopback.

The pending connection holds the PKCE verifier. `oauth_state` looks
up the callback. A successful callback writes access and refresh
tokens, sets `status=connected`, writes the enabled binding, and
fills `account_hint` from Notion's `email_domain` when present.

A denied or failed callback deletes a new pending connection. A
retry over a disconnected login is left `disconnected` with its
bindings intact. Refresh uses the stored client. `invalid_grant`
marks the connection disconnected.

Sentry Connect follows the same dynamic-registration path as Notion
against `https://mcp.sentry.dev/mcp`. A successful callback lists
tools from that session.

Gmail, Drive, and GitHub follow the same callback and refresh path,
but the client is an app the operator registers and puts in `.env`
([Gmail and Drive](google.md), [GitHub](github.md)).
