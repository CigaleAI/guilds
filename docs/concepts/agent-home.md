# Agent home

Every agent has a home: its own folder on its [machine](machines.md).
The home keeps what the agent builds up between runs: its
[scripts](scripts.md), its [browser](browser.md) profile and logins,
a coding agent's repositories, caches, and toolchains. The machine's
container comes and goes, but the home stays.

Every command an agent runs starts in its home. The operator reaches
the same folder from the agent's **CLI** tab, a terminal on the
machine. Each agent has a disk cap that bounds how large its home may
grow.

## Why it exists

An agent needs a place that survives between runs. The machine's
container stops when it is idle ([Machines](machines.md#the-containers-lifecycle)),
so each agent's files live in a folder on the host that the container
mounts. When the next
run starts a new container, the agent finds its files where it left
them.

The disk cap keeps one agent from filling the machine's disk for the
others.

## How it works

### What the home holds

A machine has one folder on the host. Inside it, each agent on the
machine has its own home, named after the agent's id. The container
mounts the machine's folder at `/home`, so an agent sees its home at
`/home/<agent id>`.

The home holds:

- `scripts/`, the agent's [scripts](scripts.md) as files
- `shared/`, where `file_fetch` lands a shared file unless the agent
  names another place ([Files](files.md))
- `.browser/`, its Chrome profile, with its logins
  ([Browser](browser.md))
- `repos/`, a coding agent's clones ([Coding agents](coding/index.md))
- `.runs/`, the logs of its code and harness calls
- `.gitconfig`, caches, and toolchains

Runtime files that must stay out of every home, such as git tokens,
the terminal's token, and logs, live in a separate folder per agent
that goes away with the container.

Two agents on one machine each keep their own home, secrets, Chrome
profile, logins, and tab. So they can hold two accounts on one site.
They can still read each other's files: agents on one machine trust
each other ([Machines](machines.md#trust-between-agents)).

### The environment of every command

Every command the orchestrator runs for an agent runs in the agent's
home. Each command gets its own environment: the agent's home, its
ports, and every secret that reaches the agent
([Environment](#environment)). The container's own environment
carries no secret. Commands run as root in the container, for every
agent.

The secrets are resolved at the start of each generation, from the
run's snapshot. A secret change reaches the agent's next generation.
A generation in progress keeps the values it started with. The agent
sees each secret's name and description in its
[State snapshot](system-prompt.md); the value stays in its commands'
environment.

### The disk cap

After each generation, the orchestrator measures the agent's home and
the machine's folder, and stores both sizes. The next generation
starts only while both are under their caps:

- the agent's home under the agent's own disk cap, which the host can
  lower further
- the machine's folder under the machine's disk cap

When either is over, the next generation fails at start with
`workspace.full`. The operator frees space from the CLI tab, or raises
the cap. A size that was over is measured again before the check, so
space freed from the CLI tab counts at once.

On a machine, the agents' own caps reserve disk out of the machine's
cap ([Machine sizing](machines.md#machine-sizing)).

### The CLI tab

Every agent has a CLI tab: a root bash session in its home, on its
machine. It is not a capability, and no setting turns it off. This is
where the operator frees disk space, or logs a coding harness in
([Harnesses](coding/harnesses.md)).

### Files the orchestrator reads and writes

Some tools take a path in the home: Drive `create_file` and
`download_file_content`, Qonto `upload_invoice`, `secret_store`,
`file_put`, and `file_fetch`.
For those, the orchestrator opens the folder on the host directly.
It guards that access: a path must stay inside the home, and a link
cannot lead out of it ([Agent home files](#agent-home-files)).

## In the app

**CLI** tab, on every agent's inspector: nothing starts until
**Start the terminal** is clicked. That wakes the agent's machine and
embeds a bash session in the agent's home, `/home/<agent id>`, as
root, with `HOME` and the agent's port block set and no secret values.
The shell reaches the files of every agent on the machine. The
machine stays up for 5 minutes after the last input on it.

**Usage** tab: the disk the agent's home uses against its cap, as
measured after the last generation, and the disk its machine uses
against the machine's cap ([Usage](usage.md)).

**Disk**, under the machine picker in the create dialog and in the
agent's Settings, Machine section ([Machines](machines.md#the-machine-picker)):

- **Max disk** sets the agent's disk cap. It sits over the machine's
  reserved-disk bar: what the other agents' caps reserve of the
  machine's disk cap, and what this agent's cap adds.
- A line under the bar gives the total and its share. It names the
  room the other agents' caps leave unreserved as the safe amount, and
  the disk free now as last measured, or says that disk is measured
  after a generation.
- In the create dialog, Max disk starts at 10240 MiB, or at the
  unreserved room when that is smaller but still at least 1 GiB. It
  follows the chosen machine until the operator types a value.
- Past the unreserved room the app still saves. It warns that the
  machine's disk may fill before this agent reaches its own cap, and
  says to lower Max disk to the unreserved room or pick another
  machine. With nothing unreserved, it says to pick another machine
  or raise this machine's disk cap.
- In Settings, the agent's own saved cap is left out of what the
  other agents reserve on its current machine, and Max disk keeps the
  saved value.

## Rules and limits

| Rule | Value or behaviour |
| --- | --- |
| Home | `/home/<agent id>` in the container; kept on the host across containers |
| Agent disk cap | 10240 MiB by default; never above the host's cap (10240 MiB by default) |
| Over the cap | the next generation fails at start with `workspace.full` |
| Measured | after each generation, and again before a generation when the stored size was over |
| CLI tab | on every agent; root shell in the home; no secret values |
| Machine wake-up from the CLI tab | stays up 5 minutes after the last input |
| Secrets in commands | resolved at generation start; a change reaches the next generation |
| Paths for host-side tools | must stay inside the home; links refused on write |

## Reference

### Paths

| What | Path |
| --- | --- |
| The machine's folder on the host | `WORKSPACE_ROOT/<machine id>`, mounted at `/home` |
| The agent's home on the host | `WORKSPACE_ROOT/<machine id>/<agent id>` |
| The agent's home in the container | `/home/<agent id>` |
| Runtime files (git tokens, the terminal's token, logs) | `/run/guilds/<agent id>/`, which goes with the container |

### Environment

Every command the orchestrator runs for an agent (`shell`, the code
helper, the harness helper, `script_run`, the browser tools,
maintenance) runs in the agent's home and carries in its own
environment:

- `HOME` and `GUILDS_AGENT_HOME`, the agent's home
- `PORT`, the first port of the agent's block, and `GUILDS_PORTS`,
  the whole block (`20000+100·slot` to `20000+100·slot+99`)
- every secret that reaches the agent, as a variable named after the
  secret, and each of the agent's secret aliases, holding the value
  of the secret it names ([Secrets](secrets.md))

MCP token payloads never enter that environment. They only join run
redaction. Commands run as root in the container, for every agent
([Security register](../architecture/security-register.md#sec-24--agents-on-one-machine-can-read-each-others-homes-tokens-and-sessions)).

### `max_workspace_mib`

`max_workspace_mib` is an agent config key: how large this agent's
home may grow, in MiB. It is a positive integer. The stored default is
10240 (10 GiB).

- After each generation the orchestrator measures the home and stores
  it as `workspace_mib` on the agent, and measures the machine's
  directory and stores it as `workspace_mib` on the machine.
- The effective cap is the agent's `max_workspace_mib`, and never
  above the host's `WORKSPACE_MAX_MIB` (default 10240).
- At generation start, a stored size above its cap is measured again
  and stored. Above the effective cap, or with the machine above its
  own `max_workspace_mib`, the generation fails with `workspace.full`
  ("… holds N MiB, above the N MiB limit; free space from the CLI
  tab") until the operator frees space or raises the cap. A failed
  measurement fails the generation with `workspace.measure`.
- `GET /api/agents/:id/usage` returns `workspace_mib` and
  `max_workspace_mib` for the agent, and `machine` with its `id`,
  `name`, `workspace_mib`, and `max_workspace_mib`. A size is null
  before the first measurement.

### CLI

| Route | What it does |
| --- | --- |
| `POST /api/agents/:id/cli` | wakes the agent's machine and starts its terminal; `{ "status": "ready" }` |
| `/api/agents/:id/cli/tty` and `/api/agents/:id/cli/tty/*` | proxies ttyd's page and WebSocket, every HTTP method |

A machine on which an agent generates is used as is. The orchestrator
runs
`agent-cli-start <agent id> <terminal port> <first port> <last port>`
in it. The helper starts ttyd on port `7700+slot` with bash in the
agent's home, or finds it already answering, and prints the secret
path segment it serves under. The segment is random per agent and kept
under `/run/guilds/<agent id>/`.

ttyd answers only under `/t/<secret>` and returns 404 elsewhere, for
the WebSocket too.

The orchestrator proxies ttyd's page and WebSocket at
`/api/agents/:id/cli/tty/*` and prepends that segment to every
upstream path. The agent id finds the agent's machine, and its slot
the port. The sandbox host's proxy drops `Authorization`, so a header
cannot carry the segment. The port refuses anything that did not come
through the proxy. Operator input on the proxied view restarts the
machine's idle timer, at most once every 30 seconds
([Machines](machines.md#the-container)).

The shell runs as root with `HOME`, `GUILDS_AGENT_HOME`, `PORT`, and
`GUILDS_PORTS` set for the agent, and no secret values. Every agent
has the CLI tab and the CLI API; no config key turns them off.

### Agent home files

Tools that take a path in the home (Drive `create_file` and
`download_file_content`, Qonto `upload_invoice`, `secret_store`,
`file_put`, and `file_fetch`)
open the folder on the orchestrator's host directly. A link there
resolves against the orchestrator's own filesystem. `readAgentFile`
and `writeAgentFile` in `apps/orchestrator/src/lib/agent-file.ts` are
the only way in:

- A path is `/home/<agent id>/...` or relative to it, and must stay
  inside the folder.
- A read follows every link, requires the result to stay in the
  folder and be a regular file (not a folder, FIFO, or device), then
  opens it without following a link and without blocking, and
  requires the opened file to be the one checked. A file over the
  tool's size limit is refused.
- A write accepts no link anywhere on the path: each existing folder
  must be a real folder in the home, missing folders are created
  one at a time, and the file is created or replaced without
  following a link at its name.

The code tools never take this path. They run inside the container,
so a link resolves there ([Code tools](coding/code-tools.md)).
