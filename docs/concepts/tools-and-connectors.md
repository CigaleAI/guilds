# Tools and connectors

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
   ([Secrets and access](secrets-and-access.md#redaction))
3. platform byte cap (default 64 KiB)
4. a `remaining_tool_calls: N` trailer

When N is 8 or fewer, a wrap-up line sits above that trailer. The
stamped string is what PostgreSQL and the model receive. The raw
result is never persisted.

## Native tools

Notes, collections, memory, and scripts share one artifact store.
They keep separate tool families.

- `note_find` / `note_get` / `note_write` / `note_delete`: Markdown
  notes in the artifact store.

  Find searches or lists notes the agent may read, optionally at one
  level. Get reads one display path. `note_write` takes `level`
  (`agent`, `guild`, or `org`) and `key` (the `.md` file name).

  Notes have no folders. The memory archive is not reachable from
  these tools.

- `record_search` / `record_list` / `record_add` / `record_update` /
  `record_remove`: records of the organisation's collections, the typed
  tables the operator defines and grants.

  Every tool names the table by `collection`. No tool creates, alters,
  or deletes one.

  `record_search` takes:

  - `query` (words in any column, `websearch` grammar, substring for
    a single token, never fuzzy)
  - an optional `collection`
  - `where` (with `collection` only)

  Results are `{ records }`, each with its `collection` and `id`.

  `record_list` takes:

  - `collection`
  - `where` (`{ column: term }`, at most 8: text and an open array
    item by substring or similar spelling, a column with `values`
    exactly, number and datetime exactly or by `{ gte, lte }`,
    boolean and `id` exactly, `null` for a missing value)
  - `since` (an ISO timestamp, oldest change first)
  - `order` (`{ column, direction }` over a declared column (not an
    array), `id`, `created_at`, or `updated_at`)
  - `limit` (default 20, at most 100)
  - `offset`

  Results are `{ total, records }`. An empty narrowed result carries
  a `hint` with the collection's size, newest change, and columns.

  `record_add` takes `body` (declared columns only). It validates
  every value and rejects with every problem at once
  (422 `record rejected`). It assigns the id and returns `{ record }`
  plus `note: merged into existing record <id>` when the unique column
  matched a live record.

  `record_update` takes `id` and a `body` of the columns that change
  (`null` clears an optional column). It returns `{ record, warnings? }`.

  `record_remove` soft-deletes by `id` and returns `{ removed }`.

  Reach is the collection grant:

  - the agent's own row when it has one (`none` keeps it out)
  - otherwise its guild's `read` or `write` on an organisation table
  - or `write` on the agent's guild's own table

  An ungranted collection is 404. A write on `read` is 403.

  The four grant bindings decide note reach only:

  - `read_guild`
  - `read_org`
  - `write_guild`
  - `write_org`

  Defaults: guild read/write and org read on; org write off.

- `memory_write`: orchestrator, full replacement of the agent's
  `memory` row with one `content` string.

  It archives the previous version in `memory_revisions` (cap 50).
  The whole file is at most 12 000 characters. It is offered on
  direct, group-triggered, and schedule-triggered runs when the
  binding is on and `config.memory` is not false. When the binding
  is off the prompt does not name the tool.

- `browser_navigate` / `browser_snapshot` / `browser_click` /
  `browser_type` / `browser_fill` / `browser_scroll` /
  `browser_screenshot` / `browser_eval`: sandbox Playwright against
  the live Chromium CDP endpoint, offered when the run snapshot has
  `browser: true`.

  Snapshot returns the accessibility tree. Click, type, and fill
  take locators from that tree.

  `browser_scroll` moves one viewport up, down, left, or right in a
  visible overflow panel when the page has one, otherwise the
  window. An optional `target` locator picks the panel. Screenshot
  writes `/home/agent/screenshots/latest.jpg`.

  `browser_eval` runs JavaScript in the current page as an async
  function body and returns a JSON-serializable value. Reuse a
  snippet by writing it to an agent note and reading it back with
  `note_get`. Each call has a 60-second timeout.

- `shell` / `shell_status` / `file_read` / `file_edit` / `file_write` /
  `code_search` / `code_match` / `code_map` / `code_find` /
  `code_outline` / `code_callers`: the code tools, sandbox through
  `guilds-code`, offered when the run snapshot has `coding: true`
  ([Code tools](#code-tools)).

- `group_post`: orchestrator, offered when the binding is on
  ([Group chat](group-chat.md)).

- `report_issue`: orchestrator, always offered. Agents file a tooling
  problem onto the guild:

  - `tool_failure`
  - `truncated`
  - `api`
  - `other`

  The guild's operators see those rows in their inbox and on the
  guild Issues tab. They resolve them (one, or every open row at
  once) or investigate them in Studio.

- `schedule_create_cron` / `schedule_create_window` / `schedule_list` /
  `schedule_pause` / `schedule_resume` / `schedule_delete`:
  orchestrator, offered on direct and group-chat runs.

  `schedule_create_cron` takes `cron`, a 5-field UTC expression
  (minute hour day month weekday). Consecutive wake-ups must be at
  least 5 minutes apart. `schedule_create_window` takes `timezone`,
  `start`, `end`, and `max_wakes`, a daily random window described
  in [Runs](runs.md).

  `description` is a required one-line label at most 400 characters.
  `instruction` is markdown at most 2000 characters, stored as
  `instruction` on the schedule row. Pause stops firing. Resume
  recomputes `next_run_at` from now.

- `script_create` / `script_list` / `script_read` / `script_run` /
  `script_delete`: orchestrator plus sandbox.

  `name` matches `^[a-z][a-z0-9_-]{0,62}$`. `manifest` is reserved.
  `description` is required and at most 400 characters.

  Scripts are agent-level artifacts (`kind` `script`). `script_create`
  of a new name is refused when the agent already has its
  `max_scripts` (default 10).

  A run snapshots source and hash, then materialises
  `/home/agent/scripts/<name>.py`. `script_run` executes that file
  in the sandbox (`/home/agent`, 120-second timeout) through
  `guilds-script-run`. The launcher writes the optional `arguments`
  object to the script's stdin as JSON (`{}` without one). For an
  agent without `coding` it is the only tool that runs a command
  there.

  `script_delete` removes the catalog row, the sandbox file, and the
  name from this run's snapshot. A row with `parameters` is also a
  first-class tool on **new** runs. Its arguments reach stdin the
  same way. The five tools are omitted when `config.scripting` is
  false ([Runs](runs.md#scripts)).

- `secret_store` / `secret_request`: orchestrator. `secret_store`
  saves a value the agent produced as a secret granted to that
  agent. `secret_request` asks the operator in a direct chat for
  one. Both are described in
  [Secrets and access](secrets-and-access.md#secret_store-and-secret_request).

Web search is not a native tool: it is the Tavily connector's
`tavily_search`, served on the instance key
([Instance keys](#instance-keys)).

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

## Code tools

A coding agent's run offers eleven native tools. Like the browser
tools they follow the `coding` flag and are not bindings.

| Tool | Arguments | Result |
| --- | --- | --- |
| `shell` | `command`, `timeout_seconds` (default 120, at most 600), `background` | Combined stdout and stderr, shaped; `exit_code: N` when not 0 |
| `shell_status` | `id`, `stop` | Without `id`, the background commands with their state; with it, that command's state, exit code, and the last 40 lines of its log; `stop` ends it |
| `file_read` | `path`, `offset` (first line, default 1), `limit` (default 200 lines, at most 500) | Numbered lines under a `path · lines a–b of n` header |
| `file_edit` | `path`, `old_string`, `new_string`, `replace_all` | `edited <path> (+a −b)` |
| `file_write` | `path`, `content` | `wrote <path> (n lines)`; missing folders are created |
| `code_search` | `pattern`, `path`, `glob`, `mode`, `fixed`, `ignore_case`, `context`, `limit` | Text search ([Code search](#code-search)) |
| `code_match` | `pattern`, `lang`, `path`, `limit` (default 30, at most 100) | Structural matches as `path:line: first matched line` |
| `code_map` | `repo` | Directory clusters with file and symbol counts and their most referenced symbols, then the most referenced symbols overall |
| `code_find` | `question`, `in`, `source`, `limit` (default 8, at most 20) | Ranked symbols and files with `path:line` and their signature; with `source`, up to 8 lines of each |
| `code_outline` | `path` | Every signature in the file with its line span, without bodies |
| `code_callers` | `symbol`, `direction` (`in` or `out`), `depth` (1 to 3), `in` | What references the symbol, or what it references, indented by depth, with `path:line` |

Every call runs `/usr/local/bin/guilds-code` in the sandbox, the way
the browser tools run `guilds-browser`. The request is base64 JSON on
the command line. A request whose encoding passes 64 KiB is written
through the sandbox file API to `/run/guilds/requests/` instead. The
helper reads and deletes it.

The helper answers with a base64 JSON envelope holding the shaped
text and the fields the call's metadata records. The orchestrator
never opens a workspace file for these tools, so a link in the
workspace resolves inside the container.

- A relative path resolves against the run's working directory, kept
  in `/home/agent/.runs/<run id>/cwd`. It starts at `/home/agent`.
  `shell` updates it when a command changes directory. Environment
  changes do not persist between calls. The file tools refuse a path
  that resolves, links followed, outside `/home/agent`.
- `shell` runs `bash -c` with stdin closed and `PAGER=cat`,
  `GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`, `NO_COLOR=1`, `TERM=dumb`,
  `DEBIAN_FRONTEND=noninteractive`, `GUILD_RUN_ID`, and `GUILD_AGENT_ID`
  in its environment. A command past its timeout gets SIGTERM, then
  SIGKILL two seconds later, for its whole process group. Its result
  says so with `exit_code: 124`.
- A background command's output goes to its log and it runs in its own
  session. `shell_status` names it `b1`, `b2`, … for the life of the
  container. Background commands do not hold the sandbox awake. They
  end with the idle stop.
- `file_edit` replaces an exact string. A string that is missing, or
  that occurs more than once without `replace_all`, is an error and
  changes nothing. Edits and writes replace the file atomically and
  keep its mode.
- The helper caps each result at `CODE_RESULT_MAX_BYTES` (default
  8192). The platform pipeline then runs unchanged: redaction, the
  64 KiB cap, and the `remaining_tool_calls` trailer.

Output shaping:

| Tool | Shaping |
| --- | --- |
| `shell` | Output that fits is returned whole. Otherwise its first 2 KiB and its last 6 KiB, less room for the trailers, around a line giving the elided byte count and the log path, `/home/agent/.runs/<run id>/<call id>.log`; the end is kept because build and test errors are there. ANSI escapes are removed and a line redrawn with carriage returns keeps its last state |
| `file_read` | A line longer than 400 characters is clipped with the count of what was cut; the range stops before the cap and says which offset continues it; a binary file is named with its size, not shown |

A full `shell` log is stored unredacted in the workspace, inside the
sandbox that already holds the values. Reading it back with
`file_read` passes through redaction like any result. `.runs/` keeps
the folders of the agent's 20 most recent runs.

**No repeated reads.** Each `file_read` records the file's path, the
lines it returned (`range`), and the SHA-256 of the whole file
(`content_hash`). A later read in the same run whose lines an earlier
read already returned, with the same hash, returns one line instead:
`<path> lines a–b: unchanged since step N; read that result.`, where N
is the earlier result's message `seq`, and records `repeat_of: N`. An
edit changes the hash, so the next read returns content.

### Code search

Three engines sit behind tool names that do not name them. An engine
can be replaced without changing a prompt or a run view.

| Engine | Tools | Answers |
| --- | --- | --- |
| ripgrep | `code_search` modes `files` and `content` | Text in every file, whatever its language, respecting `.gitignore` |
| ast-grep | `code_match` | Syntax patterns (a call shape, a declaration form) free of hits in comments and strings; the language comes from `lang` or each file's extension |
| Graft | `code_map`, `code_find`, `code_outline`, `code_callers`, `code_search` mode `symbols` | Where things are and how they connect |

`code_search` modes, each searching `path` (default the working
directory) with an optional `glob`, `fixed` for a literal pattern, and
`ignore_case`:

- `files` (default): matching paths with their match counts, highest
  first, at most 30, then the totals.
- `content`: `path:line: text` for matches and `path-line- text` for
  context lines (`context` 0 to 5), at most 40 lines and at most 10
  matches per file, then the totals.
- `symbols`: hits grouped under their enclosing function or class, with
  that symbol's span and how many places reference it, at most 20
  groups of 5 lines.

Paths in every result are relative to the working directory, so they
can be passed back to `file_read`. A matched line longer than 300
characters is clipped. A result that would pass the cap stops at a
line and says how many lines it left out.

The Graft-backed tools address a repository as a folder under
`/home/agent/repos/`. `code_map` takes its name. The others take the
repository holding their `path` or `in`, else the one holding the
working directory, else the only one there. `in` narrows to a folder
or file of it.

Graft runs in its structural tier only:

- The graph is built by tree-sitter with no model, no key, and no
  network. It lives at `/home/agent/.cache/graft/<name>` (`--dir`). It
  is built on the first Graft-backed call for a repository. Graft
  refreshes it against the working tree before every query,
  uncommitted edits included.
- With `GRAFT_NO_GITIGNORE=1` and `GRAFT_NO_IGNORE=1` a build writes
  nothing into the repository.
- `DO_NOT_TRACK=1` turns its usage telemetry off, the install event
  included. Its once-a-day npm version lookup has no switch. It is
  one background request from the sandbox.
- Every call reads Graft's `--json` output and builds its own compact
  lines. Graft's text output and its diagnostics on stderr never
  reach the model.
- A file in a language Graft does not parse is not in the graph.
  `code_outline` says so. `code_search` in `files` or `content` mode
  still finds it.
- No tool runs `graft build --deep`, `init`, `trail`, `viz`,
  `upgrade`, or `mcp`. No provider key is present, so the
  model-written tier cannot run.

A first graph build can take minutes on a large repository.
Graft-backed calls wait up to 11 minutes. A text or syntax search
waits up to 60 seconds.

**Exploration.** After each generation of a coding run, the run's
`metadata.exploration` records `calls_before_first_edit` (tool calls
before its first successful `file_edit` or `file_write`, null until
there is one) and `read_bytes_unedited` (bytes `file_read` returned
from files the run never edited). They measure whether the search
tools pay for themselves. The run payload carries them as
`exploration`.

**Metadata.** Beside the fields every tool call records:

- `exit_code`, `cwd`, `log_path` (when output was elided), and
  `timed_out` on `shell`
- `background_id`, `state`, and `exit_code` on `shell_status`
- `path`, `range`, `content_hash`, and `lines` on `file_read`
- `path`, `lines_added`, `lines_removed`, and `content_hash` on
  `file_edit` and `file_write`
- `matches` (and `files`) on `code_search` and `code_match`
- `repository` and `hits` on the Graft-backed tools

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
    ([GitHub](#github)).
  - **Both**: Drive and OpenSea. The adapter wraps the endpoint's
    session ([Adapters](#adapters)).

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
  | `auth.instance` | `{ integration, variable }`: the instance key that serves the connector's platform login while that integration is on ([Instance keys](#instance-keys)) |
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
  on a successful callback.

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
in [Secrets and access](secrets-and-access.md#access-views).

### Instance keys

A connector whose manifest names `auth.instance` runs on a key the
operator sets in `.env`, for every organisation. Web search is one:
the Tavily connector (slug `tavily`, tool `tavily_search`) names the
`web-search` integration and `TAVILY_API_KEY`. `search` takes
natural-language `query`, searches at depth `advanced`, and returns
title, URL, and snippet for each source.

- Boot gives the connector a platform login while its integration is
  on: an empty encrypted payload, `connected`, with an enabled
  platform binding that every scope inherits and any scope may turn
  Off. While the integration is off that login is `disconnected`,
  and a run leaves its tools out instead of failing.
- The pool reads the key at call time. It is never stored, never
  enters the sandbox, and run output redacts it as
  `[REDACTED:platform_<variable>]`.
- An organisation may still connect a key of its own. That login
  resolves like any other and calls with its own key.

Calls on a platform login are counted per organisation, connector,
and UTC month in `connector_calls`. `OrgLimits.monthlyConnectorCalls`
caps them by connector slug; a slug it does not name is uncapped, and
core's open policy names none. A call past the cap does not reach the
API: its tool result is `ERROR: <source> limit reached: <slug> calls
this month`. Calls on an organisation's own login are neither
counted nor capped.

### Registry

A registry publishes connectors and recipes beyond the ones the image
ships. The box reads the one `REGISTRY_URL` names, the guilds.run
registry while it is unset, and none while it is set empty (the
`registry` integration). It reads `<REGISTRY_URL>/index.json`:

```json
{
  "generated_at": "2026-10-01T00:00:00Z",
  "connectors": [
    { "slug": "acme", "version": "1.2.0", "path": "connectors/acme/1.2.0.tgz",
      "sha256": "…", "size": 812, "publisher": "acme", "verified": true,
      "display_name": "Acme", "description": "…" }
  ],
  "recipes": [
    { "name": "crm-desk", "version": "1.0.0", "path": "recipes/crm-desk/1.0.0.json",
      "sha256": "…", "size": 9120, "publisher": "guilds", "verified": true,
      "display_name": "CRM desk", "description": "…" }
  ]
}
```

One entry per published version; `path` is relative to the index. An
entry may carry `experimental: true`: its publisher is still trying it
out, an install accepts it explicitly (`--experimental`), and the
row keeps the mark, shown beside `verified`. A
connector package is a gzipped tar of its folder: `connector.json`, an
optional `logo.svg`, and, for a connector with code, `adapter.js`, at
the root or under one directory. An index may carry `signature`: a
base64 Ed25519 signature over its canonical bytes (the index without
`signature`, as JSON with every object's keys sorted and no
whitespace). With `REGISTRY_PUBLIC_KEY` set (base64 SPKI DER), the box
refuses an index that is unsigned or that the key does not verify.

Installing a connector (`apps/orchestrator/src/registry/`):

1. picks the named version, or the newest
2. refuses an entry with `verified: false` unless the install accepts
   it (`--unverified`), and an experimental one unless it accepts that
   (`--experimental`)
3. refuses a slug any server on the box holds, platform or
   organisation
4. downloads the package and refuses it when its size or SHA-256
   differs from the index's
5. validates `connector.json` with the loader, its slug against the
   entry's
6. refuses what the package may not claim. Without code it is
   endpoint-only: no endpoint, `auth.instance`, an OAuth strategy other
   than `dynamic`, or a `state` hook is refused. With code, `auth.instance`
   and an OAuth strategy other than `dynamic` are refused, and the
   install needs the code tier and a verified index (below)
7. writes a platform row: `source` `registry`, the entry's `version`,
   `verified`, and `publisher`, on at install, its tool prefix
   generated against every prefix on the box

The row has no folder. Updating replaces its manifest, version,
verification, experimental mark, and publisher with the newest
entry's; its switch, OAuth client, overrides, logins, and bindings
stay, and every login lists its tools again on its next use. Removing it deletes it
with its logins and the bindings that name it. A `core` or `local` row
is neither updated nor removed this way.

From the orchestrator's directory (`docker compose exec orchestrator`
on the Compose stack):

```bash
pnpm connector install <slug>[@version] [--unverified] [--experimental]
pnpm connector update [slug] [--unverified] [--experimental]
pnpm connector remove <slug>
pnpm connector list
```

`list` prints each platform connector's slug, source, version, switch,
verification, experimental mark, and the newer version the index
offers. The CLI runs in a process of its own, so the running server
serves a code connector it installed after **Reload connectors**
(below) or a restart; the CLI says so. The instance admin does the
same under **Admin → Connector catalog**, **Install
from the registry**:

```text
GET    /api/admin/registry
POST   /api/admin/registry/connectors          { slug, version?, unverified?, experimental? }
POST   /api/admin/registry/connectors/:slug/update { unverified?, experimental? }
DELETE /api/admin/registry/connectors/:slug
POST   /api/admin/registry/reload
```

A registry install is box-wide: the connector joins every
organisation's catalog, and each organisation connects it and turns
it on or not. An install, update, or removal from Admin takes effect
in the running server at once; **Reload connectors**
(`POST /api/admin/registry/reload`) does the same for what the CLI
changed.

#### Code tier

A registry connector may carry adapter code: `adapter.js`, one
self-contained ESM file whose default export is the adapter. Its
only runtime input is the context the pool passes it.
`pnpm build:connector <folder> <package.tgz>` bundles a connector
folder (`connector.json`, `adapter.ts`, `logo.svg`) into that package
and prints its SHA-256 and size for the index.

The code runs inside the orchestrator process, so installing it is
an opt-in (the `connector-code` integration):

- `CONNECTORS_CODE_TIER=1` turns the tier on, and `CONNECTORS_ROOT`
  names where code connectors live (`STATE_ROOT/connectors` on the
  Compose stack)
- a code package installs only from an index `REGISTRY_PUBLIC_KEY`
  verifies, and only when that index marks it verified; without the
  key every code install is refused, and `--unverified` never applies
  to code
- the install writes `connector.json`, `adapter.js`, and `logo.svg` to
  `CONNECTORS_ROOT/<slug>/<version>/`, imports the adapter once, and
  refuses a package that does not load before any row changes

The running server serves the version its row names. At boot, after
the seed, and after each change from Admin or **Reload connectors**,
it imports the adapter of each registry row whose version folder
holds one and swaps it in for the version it served, with no restart:
a call already running finishes on the adapter it started with, and
the next one uses the new version. A version that does not load is
logged and the previous one stays. A removed connector leaves the
running server. An update keeps only the new version's folder. While
the tier is off, code on disk is a warning and is not loaded. The pool
recognises an adapter's `ConnectorError` by its name and status, since
a bundle carries its own copy of the class.

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
`ctx.workspace_dir` the agent's workspace when the call comes from a
run. An adapter throws one `ConnectorError` with a status, which the
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
  Google access token (`gmail.readonly` and `gmail.compose`).

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
with `settings_schema`: Drive's `folder_id` and the GitHub login's
`repositories` ([GitHub](#github)). The check
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

Status at run start:

- **pending**: start the run; omit that server's tools.
- **disconnected** and the server is enabled: generation-start error.
- **connected**: list, persist, then offer the enabled subset.

GitHub is left out of this resolution. It offers no tools. A coding
run reaches it through its guild's repositories, which fail that run
alone when their connection is disconnected.

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
  after a successful `/users/me/profile` ping.
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

Gmail Connect follows the same callback and refresh path. The client
is the Google Cloud Web application in the orchestrator environment
(`GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET`). Missing
credentials are a Connect error.

The Cloud project enables `gmail.googleapis.com`. Authorize requests
`gmail.readonly` and `gmail.compose` with `access_type=offline`
against Google's user OAuth endpoints.

The redirect URI is `PUBLIC_BASE_URL` + `/api/mcp/oauth/callback`.
The operator's browser follows that redirect, so the provider needs
no path to the box
([Remote access](../getting-started/remote-access.md)). Register
that URI on the Cloud client.

Drive Connect follows the same callback and refresh path. The client
is the same Google Cloud Web application. The Cloud project enables
`drive.googleapis.com` and `drivemcp.googleapis.com`. Authorize
requests `drive` with `access_type=offline`.

After Google login, the login waits for its `folder_id` setting
([Login settings](#login-settings)). Its `lookup` takes a pasted
folder link or id, or searches folders by name across My Drive,
folders shared with the account, and shared drives. Its `validate`
requires one folder that is not My Drive, and the connection's
`account_hint` is that folder's name. Each Drive tool call is limited
to that folder and its descendants.

Search and recent-file lists use the Drive API with Shared drive
flags, then keep only files in that folder. These also use that
API:

- read
- download
- metadata
- permissions
- copy
- create

`create_file` takes `file_path` under `/home/agent`. The
orchestrator reads the file.

`download_file_content` writes that path and returns it. It does not
return file bytes. Both follow the
[workspace file rules](secrets-and-access.md#agent-workspace-files).

Small UTF-8 text may use `textContent`. Create and copy stay off
until the operator enables them. Official Drive MCP has no delete.

The Google token can see the rest of the Drive. `drive` is a
restricted OAuth scope.

Sentry Connect follows the same dynamic-registration path as Notion
against `https://mcp.sentry.dev/mcp`. A successful callback lists
tools from that session.

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
workspace (`/home/agent`, under the
[workspace file rules](secrets-and-access.md#agent-workspace-files)).
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

## GitHub

`github` is backed by one GitHub App per box. The orchestrator
reads:

- `GITHUB_APP_ID`
- `GITHUB_APP_SLUG`
- `GITHUB_APP_PRIVATE_KEY` (PEM, with `\n` escapes or real
  newlines)
- `GITHUB_APP_CLIENT_ID`
- `GITHUB_APP_CLIENT_SECRET`

A missing value is a Connect error (422 with
`setup_state: unsupported`). Every connector's access view carries
`oauth_setup_state`:

- `not_applicable`
- `dynamic`
- `configured`
- `unsupported` when the box holds no OAuth client or App for it

The Tools view marks an unsupported connector **Not set up**. It
names the variables the box lacks and disables Connect
([Integrations](#integrations)).

The operator registers the box's own App. The App:

- asks for the repository permissions Contents and Pull requests
  (read and write) and Metadata (read)
- requests user authorization (OAuth) during installation and
  redirects on update, with `PUBLIC_BASE_URL` +
  `/api/mcp/oauth/callback` as its callback URL
- subscribes to no webhook

Connect is offered at organisation, guild, and agent scope. It
follows the pending-connection path of the browser logins. The App
is installed once per GitHub account. Later Connects reuse that
install.

Each login then chooses its own repositories on the GitHub card
(Tools), stored in the login's settings. A narrower scope
inherits the wider login's repositories until it connects its own
login and picks a different set.

1. Connect creates a pending connection with its `oauth_state`. When
   the organisation has no connected GitHub login the operator can
   see, it answers with `authorization_url`
   `https://github.com/apps/<slug>/installations/new?state=…`, where
   the operator chooses the account and the repositories the App may
   reach. When a login already exists, Connect sends the operator to
   user authorization at `/login/oauth/authorize` instead, so a
   second guild can attach the existing installation without
   installing the App again. A short-lived cookie stores that state
   so the callback can find the login if GitHub omits it after the
   authorize hop.
2. After install, GitHub either sends `code` (and sometimes
   `installation_id` and `state`) or a setup redirect with
   `installation_id` and `state` and no `code`. A setup redirect
   starts user authorization at `/login/oauth/authorize` with the
   same `state` and the callback URL. The orchestrator exchanges
   `code` for a user token and keeps an installation only when that
   user can reach it: the callback's id when present, otherwise this
   App's only installation on the token. Several installations open
   a picker (`/api/mcp/oauth/github-installation`) so the operator
   chooses the account, or installs the App on another. An id in
   the URL alone proves nothing. The user token is discarded. A
   refused callback deletes a new pending connection.
3. The connection stores the installation id, takes the account's
   login as `account_hint`, becomes `connected`, and writes its
   enabled binding.

An installation that needs an organisation admin's approval returns
`setup_action=request`. Connect again after they approve, and
GitHub's update redirect completes it.

The connection lists no model tools. Agents use `git` and `gh` in
the sandbox. The Tools view shows it without an On/Off switch.

`GET /api/mcp/connections/:id/github/repositories` lists the
repositories the installation reaches:

- `name`
- `full_name`
- `owner`
- `private`
- `default_branch`
- `url`

`PUT /api/mcp/connections/:id/github/selected` stores
`{ repositories: [{ name, url, default_branch }] }` in that login's
settings, as `repositories`.
Each must be one the installation reaches. Each is stored with
GitHub's id for it (`github_id`). A rename of the repository or its
owner keeps that id.

The access payload carries the selection in the login's `settings`. A guild-owned login also mirrors the selection
into `guild_repositories`. `GET /api/guilds/:id/repositories` still
lists that guild's extra git URLs and the GitHub logins the
operator can see.

**Tokens.** The App's private key and the installation id never
leave the orchestrator. At each generation start of a coding agent
the orchestrator signs an App token (RS256, 9 minutes) and
requests, for each connection the guild's repositories use, an
installation access token limited to those repositories by their
GitHub ids, with contents and pull requests write. GitHub makes it
valid for one hour.

A repository stored without an id gets the one GitHub lists under
its name in the installation. GitHub's answer names every
repository as it is now: a repository whose name or owner GitHub
changed gets its current URL, on the guild repository and in the
login's selection. When GitHub refuses the token because the
installation no longer reaches a repository, the error names it.

The tokens go to `/run/guilds/git-tokens.json` through the sandbox
file API. `guilds-git-credential` is the credential helper for
`https://github.com` with `useHttpPath`, set in the image's system
git configuration and again through the environment
(`GIT_CONFIG_COUNT`), which git reads after every configuration
file. A helper the agent configures in its home, such as the one
`gh auth setup-git` writes, cannot replace it.

git gets the token of the repository it is talking to. `shell`
exports the token of the repository that holds the working
directory as `GH_TOKEN` for `gh`. Before a `shell` call, a token
within 10 minutes of expiry is replaced.

Every token joins the run's redaction set. What a coding run does
with the repositories is in [Runs](runs.md#repositories).

**Removal.** When GitHub refuses a token because the installation
was removed or suspended (404 or 403), the connection becomes
`disconnected`, and the coding generation that needed it fails at
start. Deleting the connection deletes the guild repositories
added through it.

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
| `github-app` | `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | The GitHub connector and a guild's repositories |
| `google-connectors` | `GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET` | The Gmail and Drive connectors |
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
([Users and organisations](users-and-organisations.md#model-providers)).

Setting the variables is
[Configure](../getting-started/configure.md).
