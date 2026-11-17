# Tools in a run

A run offers the model a set of tools. Each tool call goes through one
path: its arguments are parsed, its handler runs, and its result is
filtered, redacted, capped, and stamped before the model sees it.

A run draws its tools from three sources:

- [Native tools](native.md) ship in the box. Bindings turn most of
  them on or off ([Access](../concepts/access.md)).
- The browser tools follow the agent's `browser` flag
  ([Browser](../concepts/browser.md)).
- [Connectors](connectors.md) bring the tools of a login an
  organisation, a guild, or an agent signed in with. The
  [connector list](connector-list.md) describes each one.

## What a run offers

The note, record, file, memory, script, schedule, secret, wake-up, and
`group_post` tools are bindings. A run offers the ones that resolve
enabled for its agent.

Agent flags and the run kind narrow that set:

| Tools | Offered when |
| --- | --- |
| The eight step-by-step browser tools | `config.browser` is true and the agent-optimized browser is not on |
| `browse` and `browser_eval` | `config.browser` and `config.browser_optimized` are true and the System One platform key is on |
| The five script tools | `config.scripting` is not false |
| `memory_write` | `config.memory` is not false |
| The seven schedule tools | The run is a direct or group-chat run, not a schedule run |
| `secret_request` | The run is a direct run |
| `report_issue` | Always |

Each turn re-reads the agent's bindings and flags. A native tool
turned off during a run leaves it at the next turn. A run that
started with `browse` keeps it while `config.browser_optimized` is on,
even without the System One key; its calls then answer `ERROR:`
naming the missing key. The
step-by-step browser tools stay while `config.browser` is on, whatever
the browser's mode ([Browser modes](native.md#browser)). A script with
`parameters` is also offered as a tool of its own while `script_run`
is offered ([Scripts](../concepts/scripts.md)).

The model may name a tool the run does not offer. The call then
returns `ERROR: tool <name> is not offered this run`. A name no tool
has returns `ERROR: unknown tool <name>`.

### A subscription agent's run

A [subscription agent](../concepts/agents.md#model-source)'s run is
offered what a run on a key with the same access, flags, and kind is
offered, connectors included, beside the shell and file tools its
harness has of its own. The run's snapshot records that offer. The harness calls
those tools on the orchestrator's MCP server
([MCP server](#the-mcp-server)), which Claude Code and Codex name
`mcp__guilds__<tool>`, Antigravity `mcp_guilds_<tool>`, and Cursor by
the tool's own name, and the run's prompt names each tool that way.
Each list and each call re-reads the agent's bindings and flags, and
offers no tool its generation did not offer. A connector tool reaches
the harness this way too, under the connector's own login: a GitHub
login's `create_pull_request`, while bound and On, is how a
subscription agent opens the pull request of a branch it pushed
([Repositories](../concepts/coding/repositories.md#pull-requests)).

### The MCP server

Each generation of a subscription agent's run is given the
orchestrator's MCP server: the URL of its agent's path,
`<HARNESS_MCP_URL>/mcp/<agent id>`, and a bearer token
([Deployment](../architecture/deployment.md#the-mcp-listener)), for
that one call of its CLI and no other MCP server
([Drivers](../concepts/coding/harnesses.md#drivers)). The
token is 32 random bytes, kept only in the orchestrator's memory,
compared by its SHA-256 digest in constant time, redacted from the
run's rows, and valid only for that agent's path while that generation
runs. It is issued when the turn
opens and revoked when the generation ends, however it ends; a
restart revokes every token. A request without it, with another
token, at another agent's path, or after the generation ended answers
401 and nothing more.

| MCP method | Answer |
| --- | --- |
| `initialize` | The server, `guilds`, with the tools capability, on the protocol version the client asks for when the server speaks it (2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05), else 2025-11-25 |
| `tools/list` | The run's tools, each with its own name, description, and input schema |
| `tools/call` | The call's result as text, `isError` when the call failed |
| `ping` | An empty result |
| any other request | JSON-RPC error -32601 |

A `tools/call` runs as a model's call does
([How a tool call runs](#how-a-tool-call-runs)), connection tools
through their login: the offer gate, the decode, redaction, the byte
cap, and the `remaining_tool_calls` trailer. The run keeps it as a
model's call: an assistant row holding the call, its arguments
redacted, then its tool row, neither marked `from_harness`. A call id
is `mcp_<id>`. A generation's calls run one at a time, in the order
they arrive. A call of a tool the run does not offer when it comes, or with no
tool name, answers JSON-RPC error -32602 and runs nothing.

`max_tool_calls` counts every tool result of the run, the harness's
own tools' included. A call once the run has made that many is
refused with the result "Tool call limit reached. Start a new run to
continue.", runs nothing, and ends the generation: the harness is
stopped, and the run records `generation.max_tool_calls` and
completes. A `report_issue` call that files a blocking issue ends the
generation the same way, with `generation.blocked`. A call after
either is refused with that message.

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
starts without them. A generation of an agent that picks repositories
also reaches GitHub with `git` through them: a subscription agent's
harness with its shell, an agent on a key with its scripts
([GitHub](github.md)).

### Browser calls

Each step-by-step browser call starts the agent's Chrome on its
machine when it is not running. It then runs
`/usr/local/bin/guilds-browser` there. The
helper attaches Playwright to the agent's own Chrome at its DevTools
port, `http://127.0.0.1:<9300 + slot>`, and leaves Chrome running
([Browser](../concepts/browser.md)).

## How a tool call runs

### Schemas

Every tool, native or connector, declares a JSON Schema. A tool whose
code declares its parameters in TypeBox, native or connector, is
offered the JSON Schema they serialise to, with a choice among
constants of one type (a union of literals) offered as `{ type, enum }`
beside the choice's own `description`. Before a schema reaches the
model, the orchestrator changes it:

- `format` is removed from optional and nullable properties, nested
  objects and array items included.
- `additionalProperties: false` and `$schema` are removed.
- An optional string whose description does not already say to omit
  it gets the line "Optional. Omit this key when unused; do not pass
  an empty value."

Before a connector tool is called, an empty or blank string is
dropped when its key is optional on the tool's schema, nested objects
included. An empty string for a required key is sent as is.

A tool schema whose `type`, `description`, `format`, `required`,
`properties`, `items`, `prefixItems`, `anyOf`, `oneOf` or `allOf`
holds, at any depth, what JSON Schema does not allow there is refused
where it enters: a connector manifest, an admin's tool edit and a
script's parameters are rejected, and a remote server's tool is listed
with an empty object schema.

### Arguments

A call's arguments are the JSON object the model wrote, empty when it
wrote none; any other value is refused. A native tool declares its
parameters once, and that declaration is both the schema the model is
offered and the decode its arguments pass before the handler runs:

- An optional argument sent as `null` is left out.
- A required argument left out is refused as `<name> is required`.
- An argument of another type, outside the range its schema states,
  or not one of the values its schema lists, is refused naming it by
  its JSON pointer, such as `/max_steps: must be <= 100`.

A refused call does nothing. An argument the tool hands on to the part
of the orchestrator that reads it, such as a record's `where`, `id`
and `body`, a routine's timing, or a script's `parameters` and
`arguments`, is taken as any JSON value and refused there in that
part's words. A timeout a tool keeps within its range is read as a whole number, cut to the range, and its default when it is not a
number.

### Handlers

A handler takes four parameters and returns a string:

- the toolbox's services, built once by the generation loop: notes,
  artifacts, files, group chat, issues, schedules, scripts, the
  run-state database functions, the run streams, and the
  agent-optimized browser;
- the run record: the run, its agent, guild, and organisation, its
  sandbox, secrets, offered tools, pinned scripts, and harness;
- the run's hooks, which the loop composes for each run: command
  tracking for cancels, the browser start and its activity, the
  agent's DevTools relay, the repository token refresh before a
  command, and the secret store;
- the call: its id, name, and arguments, decoded as its parameters
  declare them, and the exit code and metadata the handler reports
  for it.

A handler that throws becomes the result `ERROR: <message>`. The full
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

Each call records `tool_name`, `tool_call_id`, `duration_ms`,
`output_filter`, `truncated`, `original_bytes`, `stored_bytes`,
`error`, and `remaining_tool_calls` in the tool message's metadata. A
`script_run` call also records `exit_code`. A tool may add its own
fields, such as `browse`'s `status` and `browser_usage`.
