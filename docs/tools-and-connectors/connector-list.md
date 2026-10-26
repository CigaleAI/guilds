# Connector list

The connectors the box ships, one section each. How a connector runs,
signs in, and lists its tools is [Connectors](connectors.md).

| Connector | Slug | Sign-in | Runs through | Platform setup |
| --- | --- | --- | --- | --- |
| [Notion](#notion) | `notion` | Browser, dynamic client | Endpoint | None |
| [Sentry](#sentry) | `sentry` | Browser, dynamic client | Endpoint | None |
| [Gmail](#gmail) | `gmail` | Browser, box client | Adapter | `google-connectors` |
| [Google Drive](#google-drive) | `drive` | Browser, box client | Both | `google-connectors` |
| [GitHub](#github) | `github` | GitHub App | Endpoint | `github-app` |
| [Cigale](#cigale) | `cigale` | Token | Endpoint | None |
| [OpenSea](#opensea) | `opensea` | Token | Both | None |
| [Etherscan](#etherscan) | `etherscan` | Token | Endpoint | None |
| [CoinGecko](#coingecko) | `coingecko` | Token | Adapter | None |
| [Alchemy](#alchemy) | `alchemy` | Token | Adapter | None |
| [X](#x) | `x` | Token | Adapter | None |
| [TwitterAPI.io](#twitterapiio) | `twitterapiio` | Token | Adapter | None |
| [Qonto](#qonto) | `qonto` | Token | Adapter | None |
| [DexPaprika](#dexpaprika) | `dexpaprika` | Token | Adapter | None |
| [Web search](#web-search) | `tavily` | Token, or the platform key | Adapter | `web-search` for the platform login |

"Platform setup" is the [platform key](platform-keys.md) a platform
admin enters first. Until it is on, **Tools** marks the connector
**Not set up** and disables **Connect**.

## What token connectors share

- The operator pastes the key into the token form on the connector's
  card. The login stores it encrypted, and its value joins run
  redaction.
- Connect checks the key against the provider. A rejected key is a
  Connect error, and nothing is stored.
- An endpoint connector sends the key as `Authorization: Bearer`
  unless its section names another header.
- An adapter connector writes its curated tool list into `mcp_tools`
  after its check succeeds. Its calls return compact TSV. Lists default
  to 15 rows, at most 30. Images are left out.

## Notion

Browser OAuth against `https://mcp.notion.com/mcp`. The box registers
its own client ([OAuth](connectors.md#oauth)). Notion rejects a
non-loopback `http://` redirect URI, so a box reached over the network
needs an `https` `PUBLIC_BASE_URL`. The login's `account_hint` is
Notion's `email_domain` when present. Tools are listed from the
session.

An organisation login is searchable from the guild builder
(`builder.searchable`), and Notion is a system of record
(`builder.role` `system_of_record`).

## Sentry

Browser OAuth against `https://mcp.sentry.dev/mcp`, with a client the
box registers, like Notion. Tools are listed from the session.

## Gmail

Adapter calls to `https://gmail.googleapis.com/gmail/v1` with the
Google access token, scopes `gmail.readonly` and `gmail.compose`.
Eight tools: `search_threads`, `get_thread`, `get_message`,
`download_attachment`, `list_labels`, `list_drafts`, `create_draft`,
and `send_message`.
`send_message` starts Off. Setup and detail:
[Gmail and Drive](google.md#gmail).

## Google Drive

The Drive MCP endpoint `https://drivemcp.googleapis.com/mcp/v1`,
wrapped by an adapter that limits every call to one picked folder.
Scope `drive`. `create_file` and `copy_file` start Off. Setup and
detail: [Gmail and Drive](google.md#drive).

## GitHub

Endpoint `https://api.githubcopilot.com/mcp/`, with the `repos`,
`issues`, `pull_requests`, and `actions` toolsets in
`X-MCP-Toolsets`. The session sends an installation token limited to
the repositories the login picks; a login with none picked lists no
tools. `create_repository` and `fork_repository` are left out, as
`policy.exclude`. Its State hook lists the picked repositories under
`github_repositories`. Coding agents also get `git` and `gh` access to
the same repositories ([GitHub](github.md)).

## Cigale

Endpoint `https://api.cigale.ai/api/v1/public/mcp`. The manifest names
ten tools, and a login lists them from the session:

| Tool | Does |
| --- | --- |
| `search_knowledge_base` | Best posts on up to 5 topics over the last five months |
| `get_recent_documents` | Semantic search over posts in a window of at most 24 hours |
| `generate_reply_options` | Reply drafts in a Cigale agent's voice, optionally for one campaign. Spends one reply generation; nothing is posted |
| `get_top_reply_opportunities` | Posts worth replying to across tracked feeds |
| `get_campaign_top_reply_opportunities` | Posts worth replying to for one campaign |
| `get_reports_list` | Recent trend reports |
| `get_reports_by_string` | Trend reports by free-text query |
| `get_full_report_by_label` | One full trend report |
| `get_report_categories_list` | The report categories |
| `get_predicted_views` | Stored view forecasts for posts |

## OpenSea

Endpoint `https://mcp.opensea.io/mcp`, with the key in `X-API-KEY`.
An empty tool list, or a list of only `get_instant_api_key`, is a
rejected key. These start Off, as `policy.default_off`:
`get_instant_api_key`, `manage_collections`, `get_favorites`,
`manage_watchlist`, `manage_profile`, `manage_wallets`,
`manage_drops`, `check_drop_eligibility`, and `cancel_orders`.

## Etherscan

Endpoint `https://mcp.etherscan.io/mcp`. Every tool reads public
onchain data. Some need a paid Etherscan plan, and each call counts
against the key's API quota.

## CoinGecko

A Pro API key. Connect checks
`GET https://pro-api.coingecko.com/api/v3/ping` with
`x-cg-pro-api-key`. Eight tools:

| Tool | Does |
| --- | --- |
| `search` | Coin, NFT, and category ids by name |
| `coin` | Contract addresses and market data for a coin id, or a platform and address |
| `prices` | Current USD price and 24-hour change for coin ids |
| `new` | Recently listed coins. Analyst plan and above |
| `movers` | Top gainers and losers. Analyst plan and above |
| `supply` | Circulating, total, and non-circulating supply. Analyst plan and above |
| `chart` | Price history or OHLC, downsampled to 48 points |
| `trending` | Trending coins, NFTs, and categories in the last 24 hours |

Results carry no tickers, HTML, or localization.

## Alchemy

An NFT API key. Connect checks
`GET https://eth-mainnet.g.alchemy.com/nft/v3/{key}/getNFTsForOwner`
with the zero address. Three tools: `holdings`, `nft`, and
`collection`. Results carry no descriptions or token URIs.

`holdings` takes an owner address (ENS on ethereum) and an optional
chain, contract filter, and `page_key`. Chains: `ethereum`,
`polygon`, `base`, `arbitrum`, `bsc`, `optimism`, `ink`, `robinhood`,
and `solana`. Solana uses DAS `getAssetsByOwner` on `solana-mainnet`.
The other chains use NFT REST.

## X

A bearer token. Connect checks
`GET https://api.x.com/2/users/by/username/X`. Four tools:

| Tool | Takes |
| --- | --- |
| `search` | A query; recent search over the last 7 days |
| `user` | A username or user id |
| `posts` | A username or user id |
| `post` | A post id or status URL |

Post text is clipped at 280 characters.

## TwitterAPI.io

An API key, sent as `x-api-key`. Connect checks
`GET https://api.twitterapi.io/oapi/my/info`. Ten tools:

| Tool | Takes |
| --- | --- |
| `search` | A query; advanced search over the last 24 hours, ranked Top |
| `user`, `posts` | A username or user id |
| `followers`, `following`, `mentions` | A username |
| `post`, `replies`, `quotes` | A post id or status URL |
| `trends` | An optional WOEID; default 1, worldwide |

Post text is clipped at 280 characters.

## Qonto

The organisation's login and secret key, from Qonto's **Integrations**,
**API key**. Calls send `Authorization: {login}:{secret_key}` to
`https://thirdparty.qonto.com`. Connect checks `GET /v2/organization`.
Production API only. Four tools:

| Tool | Does |
| --- | --- |
| `list_bank_accounts` | The organisation's accounts |
| `list_missing_invoices` | Completed transactions that still need an invoice |
| `get_transaction` | One transaction |
| `upload_invoice` | Attaches a file to a transaction. Starts Off |

`list_missing_invoices` keeps transactions with empty
`attachment_ids`, `attachment_required` true, and `attachment_lost`
not true. It defaults to the last 90 days, debit side.

`upload_invoice` takes a `file_path` in the agent's home, under the
[home file rules](../concepts/agent-home.md#agent-home-files). The
file is a PDF, JPEG, or PNG, at most 15 MiB. Qonto processes it in the
background, and the call waits up to 60 seconds.

## DexPaprika

An API key, sent as the whole `Authorization` header to
`https://api.dexpaprika.com`. A 403 retries on
`https://api-pro.dexpaprika.com`. Connect checks `GET /usage`. A
`keyless` plan, or a 401 or 403, is a rejected key. Seven tools:
`search`, `token`, `prices`, `pool`, `pools`, `ohlcv`, and `swaps`.

- `search` is cross-network. The others take a network id, such as
  `ethereum`, `solana`, or `base`.
- `prices` takes at most 10 addresses.
- `ohlcv` defaults to the last 24 hours at `1h`, downsampled to 48
  candles. A free key allows `10m` and up over 7 days. `1m` and `5m`
  need a paid plan.

Results carry no websites or descriptions.

## Web search

Display name **Web search**, slug `tavily`. One tool, `search`, which
the model sees as `tavily_search`. It takes a natural-language
`query`, searches Tavily at depth `advanced`, and returns the title,
URL, and snippet of each source.

It runs on the `web-search` platform key for every organisation
([Platform logins](connectors.md#platform-logins)). An organisation
may also connect a Tavily key of its own. Connect does not check that
key.
