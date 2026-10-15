# Native tools

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
  stores of records the operator defines and grants.

  Every tool names the collection by `collection`. No tool creates, alters,
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
  - otherwise its guild's `read` or `write` on an organisation collection
  - or `write` on the agent's guild's own collection

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
  writes `screenshots/latest.jpg` in the agent's home.

  `browser_eval` runs JavaScript in the current page as an async
  function body and returns a JSON-serializable value. Reuse a
  snippet by writing it to an agent note and reading it back with
  `note_get`. Each call has a 60-second timeout.

- `code_task` / `shell` / `shell_status` / `file_read` /
  `code_search`: the code tools, offered when the run snapshot has
  `coding: true` ([Code tools](../concepts/coding/code-tools.md)). `code_task` runs in the
  sandbox through `guilds-harness` and delegates code work to the
  agent's coding harness; the other four run through `guilds-code`.

- `group_post`: orchestrator, offered when the binding is on
  ([Group chat](../concepts/group-chat.md)).

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
  in [Routines](../concepts/routines.md).

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
  `/home/<agent id>/scripts/<name>.py`. `script_run` executes that
  file on the agent's machine (in its home, 120-second timeout) through
  `guilds-script-run`. The launcher writes the optional `arguments`
  object to the script's stdin as JSON (`{}` without one). For an
  agent without `coding` it is the only tool that runs a command
  there.

  `script_delete` removes the catalog row, the sandbox file, and the
  name from this run's snapshot. A row with `parameters` is also a
  first-class tool on **new** runs. Its arguments reach stdin the
  same way. The five tools are omitted when `config.scripting` is
  false ([Scripts](../concepts/scripts.md)).

- `secret_store` / `secret_request`: orchestrator. `secret_store`
  saves a value the agent produced as a secret granted to that
  agent. `secret_request` asks the operator in a direct chat for
  one. Both are described in
  [Secrets](../concepts/secrets.md#agents-storing-and-asking-for-secrets).

Web search is not a native tool: it is the Tavily connector's
`tavily_search`, served on the Web search platform key a platform
admin enters under **Admin**, **Platform keys**
([Instance keys](connectors.md#instance-keys)). A native tool that
waits on a platform key has no switch in Tools and says it is offered
once a platform admin sets up its integration there.

Whether a run offers a native tool is
[What a run offers](catalog.md#what-a-run-offers).
