# Tools in a run

A run offers the model a set of tools. Each tool call goes through one
path: its arguments are parsed, its handler runs, and its result is
filtered, redacted, capped, and stamped before the model sees it.

A run draws its tools from three sources:

- [Native tools](native.md) ship in the box. Bindings turn most of
  them on or off ([Access](../concepts/access.md)).
- [Code tools](../concepts/coding/code-tools.md) and the browser tools
  follow the agent's `coding` and `browser` flags.
- [Connectors](connectors.md) bring the tools of a login an
  organisation, a guild, or an agent signed in with. The
  [connector list](connector-list.md) describes each one.

## What a run offers

The note, record, memory, script, schedule, secret, and `group_post`
tools are bindings. A run offers the ones that resolve enabled for its
agent.

Agent flags and the run kind narrow that set:

| Tools | Offered when |
| --- | --- |
| The eight browser tools | `config.browser` is true |
| The five code tools | `config.coding` is true |
| The five script tools | `config.scripting` is not false |
| `memory_write` | `config.memory` is not false |
| The six schedule tools | The run is a direct or group-chat run, not a schedule run |
| `secret_request` | The run is a direct run |
| `report_issue` | Always |

Each turn re-reads the agent's bindings and flags. A native tool that
is now off leaves the run at the next turn. A script with
`parameters` is also offered as a tool of its own while `script_run`
is offered ([Scripts](../concepts/scripts.md)).

The model may name a tool the run does not offer. The call then
returns `ERROR: tool <name> is not offered this run`. A name no tool
has returns `ERROR: unknown tool <name>`.

### Connector logins at run start

Each connector the agent has on resolves to one login. Its status
decides what the run gets:

| Login status | Run start |
| --- | --- |
| `pending` | The run starts without that connector's tools |
| `disconnected` | The run fails at generation start, naming the connector |
| `disconnected`, a platform login served by a [platform key](platform-keys.md) | The run starts without that connector's tools |
| `connected` | The run offers the login's listed tools that are on |

A connected login lists its tools again when its stored list is 10
minutes old. A listing that fails keeps the stored list
([Tools of a login](connectors.md#tools-of-a-login)).

A GitHub login with no repositories picked lists no tools, so the run
starts without them. A coding run also reaches GitHub through its
guild's repositories ([GitHub](github.md)).

### Browser calls

Each browser call starts the agent's Chrome on its machine when it is
not running. It then runs `/usr/local/bin/guilds-browser` there. The
helper attaches Playwright to the agent's own Chrome at its DevTools
port, `http://127.0.0.1:<9300 + slot>`, and leaves Chrome running
([Browser](../concepts/browser.md)).

## How a tool call runs

### Schemas

Every native tool declares a JSON Schema. Before any schema reaches
the model, the orchestrator changes it:

- `format` is removed from optional and nullable properties, nested
  objects and array items included.
- `additionalProperties: false` and `$schema` are removed.
- An optional string whose description does not already say to omit
  it gets the line "Optional. Omit this key when unused; do not pass
  an empty value."

Before a connector tool is called, an empty string is dropped when its
key is optional on the tool's schema. An empty string for a required
key is sent as is.

### Handlers

A handler takes the tool context first and returns a string. A
handler that throws becomes the result `ERROR: <message>`. The full
error goes to the operational log.

### Results

Every result goes through the same steps, in order:

1. The tool's output filter.
2. Exact-value secret redaction
   ([Secrets](../concepts/secrets.md#redaction)).
3. The byte cap. A result over the cap is cut and ends with
   `\n[truncated]`.
4. The trailer `remaining_tool_calls: N`.

When N is 8 or fewer, the line "Write durable findings and finish
with text. A batch costs one call each." sits above the trailer.

The stamped string is what PostgreSQL stores and the model reads. The
raw result is never stored.

## Reference

| Setting | Default | Meaning |
| --- | --- | --- |
| `TOOL_RESULT_MAX_BYTES` | `65536` | The byte cap on one tool result, after redaction |
| Low-budget line | N ≤ 8 | Remaining calls at which the wrap-up line appears |
| Connector list age | 10 minutes | A stored tool list older than this is listed again at run start |

Each call records `tool_name`, `duration_ms`, `output_filter`,
`truncated`, `original_bytes`, `stored_bytes`, and `error` in the
tool message's metadata. A `script_run` call also records
`exit_code`.
