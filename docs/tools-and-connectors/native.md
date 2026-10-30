# Native tools

Native tools ship in the box. The orchestrator runs each one, some
through a helper in the agent's sandbox. Notes, collections, files,
memory, and scripts share one artifact store, but each keeps its own
tool family.

Which of these a run offers is
[What a run offers](tools-in-a-run.md#what-a-run-offers). Every result
goes through the [result pipeline](tools-in-a-run.md#results).

Web search is a connector, not a native tool: the Web search
connector's `tavily_search`
([Web search](connector-list.md#web-search)).

## Notes

Markdown notes in the artifact store, at agent, guild, or organisation
level ([Notes](../concepts/notes.md)). Notes have no folders. These
tools do not reach the memory archive.

| Tool | Parameters | Does |
|---|---|---|
| `note_find` | `query`, `level`, `limit` (default 20) | Searches the notes the agent may read. An empty `query` lists them. `level` is `agent`, `guild`, or `org`; omitted, every level. Returns `{ notes }`, each with its `access`: `read` or `write` |
| `note_get` | `path` (required) | Reads one note by its display path. A soft-deleted note returns a tombstone |
| `note_write` | `content` (required), and `level` with `key`, or `path` | With `level` and `key`, writes the agent's note at that level: a new note only at `agent` or `guild` level, an existing one with `write` on it. With `path`, rewrites any existing note the agent may write. `key` is the `.md` file name. Returns the display path |
| `note_delete` | `path` (required) | Soft-deletes a note the agent may write. `task.md` and `memory.md` cannot be deleted |

A collection or record path is refused with a pointer to the record
tools. A script is refused with a pointer to the script tools, and a
file with a pointer to the file tools.

An agent always reaches its own agent-level notes. Every other note
is reached through its access list
([Access](../concepts/access.md#access-lists-for-notes-collections-and-files)).

## Files

Bytes in the artifact store, at agent, guild, or organisation level
([Files](../concepts/files.md)). The bytes move between the agent's
home and the store; they never pass through the model.

| Tool | Parameters | Does |
|---|---|---|
| `file_find` | `query`, `level`, `limit` (default 20) | Searches the files the agent may read by name and description. An empty `query` lists them. `level` is `agent`, `guild`, or `org`; omitted, every level. Returns `{ files }`, each with its `access`: `read` or `write` |
| `file_fetch` | `path` (required), `home_path` | Copies the file into the agent's home, at `home_path` or `shared/<name>`. Returns that path with the file's name, description, media type, and size |
| `file_put` | `home_path`, `level`, `description` (required), `name`, `mime` | Copies a file from the home into the store at `level` under `name`, its own name by default. A new file only at `agent` or `guild` level; a file of that name is replaced with `write` on it. Returns the display path |
| `file_delete` | `path` (required) | Deletes a file the agent may write |

A file is at most 10 MiB. An agent always reaches its own agent-level
files; every other file is reached through its access list.

## Records

Records of the organisation's collections: typed tables the operator
defines and opens through their access lists
([Collections](../concepts/collections.md)). Every
tool names the collection by `collection`. No tool creates, alters, or
deletes a collection.

| Tool | Parameters | Does |
|---|---|---|
| `record_search` | `query` (required), `collection`, `where`, `limit` | Text search across every readable collection, or one. Returns `{ records }`, each with its `collection` and `id` |
| `record_list` | `collection` (required), `where`, `since`, `order`, `limit`, `offset` | Lists one collection. Returns `{ total, records }` |
| `record_add` | `collection`, `body` (required) | Adds a record. Returns `{ record }` |
| `record_update` | `collection`, `id`, `body` (required) | Merges `body` into one record. Returns `{ record, warnings? }` |
| `record_remove` | `collection`, `id` (required) | Soft-deletes one record. Returns `{ removed }` |

- **`query`** matches whole words in any column, in `websearch`
  grammar: terms are ANDed, `OR` widens, quotes keep a phrase, `-`
  excludes. A single token also matches partially. Search is never
  fuzzy.
- **`where`** is `{ column: term }`, at most 8 columns, each term at
  most 200 characters. Text and an open array item match by substring
  or similar spelling. A column with `values` matches exactly. Number
  and datetime match exactly or by `{ gte, lte }`. Boolean and `id`
  match exactly. `null` matches a missing value. On `record_search`,
  `where` needs `collection`.
- **`since`** is an ISO timestamp. It keeps records created or updated
  at or after it, oldest change first.
- **`order`** is `{ column, direction }` over a declared column that
  is not an array, `id`, `created_at`, or `updated_at`. The default is
  `id`.
- **`limit`** defaults to 20, at most 100.
- **`body`** holds declared columns only. `record_add` validates every
  value and rejects with every problem at once (422 `record rejected`).
  When the unique column matches a live record, the body merges into
  it and the result adds `note: merged into existing record <id>`. On
  `record_update`, `null` clears an optional column.

An empty `record_list` result that was narrowed carries a `hint`: the
collection's size, its newest change, and its columns.

Reach is the collection's access list:

- the agent's own row when it has one (`none` keeps it out)
- otherwise the better of its guild's row and the organisation's row

A collection the agent does not reach is a 404. A write on `read` is a
403.

## Memory

`memory_write` takes one required `content` string. It replaces the
agent's whole Memory ([Memory](../concepts/memory.md)).

- `content` is at most 12,000 characters.
- The previous version goes to `memory_revisions`. The newest 50 are
  kept.
- When the binding is off, the prompt does not name the tool.

## Browser

The browser tools drive the agent's own Chrome
([Browser](../concepts/browser.md)). The browser runs in one of two
modes, and each offers its own tools:

| Mode | Runs when | Tools |
|---|---|---|
| Step-by-step | `browser` is on and the agent-optimized browser is not | The eight tools below |
| Agent-optimized | `browser_optimized` is on and the System One [platform key](platform-keys.md) is on | `browse` and `browser_eval` |

`browse` delegates a whole web task on the agent's Chrome and is
offered in place of the seven step tools; `browser_eval` is offered in
both modes. A run's mode is set when it is created: an agent with
`browser_optimized` on starts its runs in the step-by-step mode while
the System One key is not on. A run that started with `browse` keeps
it while `browser_optimized` stays on, and its calls answer `ERROR:`
naming the missing key until the key is set again. While
`browser_optimized` is on without the key, each run logs one warning
with the operation `browse.integration_off` and records the time in its
`metadata.browse_integration_off_at`.

### browse

`browse` runs the task with fastbrowse, which picks each action from
the page's own controls, plans and reads with the agent's
`browser_model`, and cites a verbatim page quote for each fact of its
answer. Every step shows in the **Browser** tab, and the operator can
take over there at any time.

| Parameter | Required | Meaning |
|---|---|---|
| `task` | Yes | The goal, the output wanted, constraints, and any values to fill |
| `start` | No | An `http` or `https` URL to start on; without it the run continues from the current page or infers one from the task |
| `authorize` | No | Allows irreversible actions (submit, pay, delete, send); default `false`, which stops at `needs_confirmation` before them |
| `fields` | No | A flat object of field name to `{ type, description? }`, `type` one of `string`, `number`, `integer`, `boolean`; at most 20 fields, names `^[a-z][a-z0-9_]{0,39}$`; every field is extracted and backed by a page quote |
| `max_steps` | No | 1 to 100 browser actions; default 40 |
| `max_seconds` | No | 10 to 600 seconds; default 300 |

The result is text, one part per line, each present only when it has
something:

- `Status:` one of `complete`, `unverified`, `needs_confirmation`,
  `needs_login`, `blocked`, `needs_input`, `stuck`, `budget_exceeded`,
  `observation_limit`, `unavailable`, `error`. Only `complete` is
  verified.
- `Final URL:` the page the run ended on.
- `Answer:` the answer, its facts marked `[n]`.
- `Citations:` one line per marker, `[n] "quote" — url`.
- `Data:` the extracted `fields` as JSON.
- `Wall:` the sign-in or bot wall a `needs_login` or `blocked` run
  stopped at: its kind, origin, and the fields it asked for.
- `Budget:` the limit a `budget_exceeded` run reached.
- `Error:` what went wrong.

While it runs, each step (`click "Sign in" at https://…`) is the
call's progress in the run view, and keeps the agent's Chrome and
machine from their idle stops. A cancel of the run stops the call
with `ERROR: browse cancelled`; a run still going 30 seconds past
`max_seconds` stops with `ERROR: browse stopped at its time limit`.
The call's metadata keeps `status`, `final_url`, `steps`, and
`browser_usage`: the Jev and browser-model tokens and cost, which count
as browser usage and in the organisation's monthly spend
([Usage](../concepts/usage.md)). Without the System One key, a browser
model, or a connected key for that model, the call answers `ERROR:`
with the reason.

### Step-by-step tools

The step-by-step tools run through Playwright in the agent's sandbox.
Each call has a 60-second timeout.

| Tool | Parameters | Does |
|---|---|---|
| `browser_navigate` | `url` | Opens a URL |
| `browser_snapshot` | none | Returns the URL, title, and accessibility tree |
| `browser_click` | `target` | Clicks a locator |
| `browser_type` | `target`, `text` | Types into a locator |
| `browser_fill` | `target`, `value` | Replaces a field's value |
| `browser_scroll` | `direction` (`up`, `down`, `left`, `right`), optional `target` | Scrolls one viewport |
| `browser_screenshot` | none | Writes `screenshots/latest.jpg` in the agent's home and returns that path |
| `browser_eval` | `expression` | Runs JavaScript in the page |

A locator comes from the latest snapshot: CSS, `role=...`, or
`text=...`.

`browser_scroll` scrolls a visible overflow panel when the page has
one, otherwise the window. `target` picks the panel. The result names
the container and how much remains.

`browser_eval` runs `expression` as the body of an async function and
returns a JSON-serializable value. `console.log` is not captured. To
reuse a snippet, the agent writes it to a note and reads it back with
`note_get`.

## Code

`code_task`, `shell`, `shell_status`, `file_read`, and `code_search`
are the code tools ([Code tools](../concepts/coding/code-tools.md),
[Code tasks](../concepts/coding/code-tasks.md)). `code_task` runs
through `guilds-harness` and hands code work to the agent's coding
harness. The other four run through `guilds-code`.

## Group chat

`group_post` takes one required `content` string with non-whitespace
text. It posts to the guild's chat. `@name` asks that agent to reply.
`@user` asks the operator. An untagged post asks nobody
([Group chat](../concepts/group-chat.md)).

## Issues

`report_issue` files a tooling problem on the guild. The guild's
operators see it in their inbox and on the guild's **Issues** tab
([Inbox and issues](../concepts/inbox.md)).

| Parameter | Required | Meaning |
|---|---|---|
| `summary` | Yes | One line, at most 200 characters |
| `detail` | Yes | What failed, with the tool name and error text |
| `kind` | Yes | `tool_failure`, `truncated`, `api`, or `other` |
| `severity` | No | `low`, `medium`, or `high`; default `medium` |
| `tool_name` | No | The tool that failed |

## Routines

Seven tools manage the agent's own schedules
([Routines](../concepts/routines.md)). They refuse a schedule run.

| Tool | Parameters | Does |
|---|---|---|
| `schedule_create_cron` | `cron`, `description`, `instruction` | A repeating wake-up on a UTC clock |
| `schedule_create_window` | `timezone`, `start`, `end`, `max_wakes`, `description`, `instruction` | Random wake-ups inside a daily local-time window |
| `schedule_list` | none | Lists the agent's schedules and when each fires next, in UTC |
| `schedule_update` | `schedule_id`; any of `cron` or `window` (`timezone`, `start`, `end`, `max_wakes`), `description`, `instruction` | Changes what it names; the rest stays. A new timing on a running schedule plans the next fire from now |
| `schedule_pause` | `schedule_id` | Stops a schedule firing |
| `schedule_resume` | `schedule_id` | Resumes it. The next fire is recomputed from now |
| `schedule_delete` | `schedule_id` | Deletes it |

- `cron` is a 5-field UTC expression: minute, hour, day, month,
  weekday.
- `timezone` is an IANA name. `start` and `end` are `HH:MM` local
  times. An `end` before `start` spans midnight. `max_wakes` is the
  most wake-ups per window.
- Consecutive wake-ups are at least 5 minutes apart.
- `description` is a one-line label, at most 400 characters.
- `instruction` is markdown, at most 2,000 characters. It is stored on
  the schedule and passed on the wake-up message.
- An argument of the wrong type is refused, and nothing is written.

## Scripts

Five tools manage the agent's Python scripts
([Scripts](../concepts/scripts.md)).

| Tool | Parameters | Does |
|---|---|---|
| `script_create` | `name`, `description`, `source` (required), `parameters` | Creates or replaces a script |
| `script_list` | none | Lists the scripts and why each exists |
| `script_read` | `name` | Returns a script's name, description, and source |
| `script_run` | `name`, optional `arguments` | Runs a script |
| `script_delete` | `name` | Deletes a script |

- `name` matches `^[a-z][a-z0-9_-]{0,62}$`. `manifest` is reserved. A
  name equal to a native tool name or to one of the agent's connector
  tool names is refused.
- `description` is required, at most 400 characters.
- `parameters` is a JSON Schema object. A script with `parameters` is
  also offered as a tool under its own name, from the next run.
- A new name is refused once the agent holds `max_scripts` scripts
  (default 10). Replacing a name does not count.

A run snapshots each script's source and hash and writes it to
`/home/<agent id>/scripts/<name>.py`. A script replaced during a run
takes effect from the next run.

`script_run` runs that file on the agent's machine, in its home,
through `guilds-script-run`, with a 120-second timeout. The launcher
writes `arguments` to the script's stdin as JSON, `{}` without one.
For an agent without `coding`, it is the only tool that runs a command
there.

`script_delete` removes the stored script, the sandbox file, and the
name from this run's snapshot.

## Secrets

`secret_store` saves a value the agent produced, from a file in its
home, as a secret granted to that agent. `secret_request` asks the
operator for one in a direct chat. Both are described in
[Secrets](../concepts/secrets.md#agents-storing-and-asking-for-secrets).
