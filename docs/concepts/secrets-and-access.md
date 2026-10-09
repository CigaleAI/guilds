# Secrets and access

A secret is one encrypted value an organisation owns and hands to the
agents it names, as an environment variable in their sandboxes. Access
is who gets each secret, what else reaches a sandbox, and the
per-scope view where an operator sets both secrets and tools. Which
tools exist and how they are bound is
[Tools and connectors](tools-and-connectors.md).

## Secrets

A secret is AES-GCM under `SECRETS_MASTER_KEY` in the orchestrator
environment. `secrets` holds:

- `org_id`
- `name`
- `description`
- `org_wide`
- the creator (`created_by_user_id`, or `created_by_agent_id` for a
  value an agent stored)
- `ciphertext`
- `nonce`
- `created_at`
- `updated_at`
- `rotated_at`

`name` is the sandbox environment variable
(`^[A-Za-z_][A-Za-z0-9_]*$`) and is unique in the organisation
(`secrets_org_name_unique`). `description` is required, at most 400
characters, and tells agents how to use the value.

Access says which agents get it:

- **Organisation**: `org_wide`: every agent in the organisation. An
  organisation-wide secret has no grant rows. Setting `org_wide`
  clears them.
- **Guilds**: a `secret_grants` row per guild: every agent in it.
- **Agents**: a `secret_grants` row per agent.
- **Unassigned**: neither: no agent gets it.

A `secret_grants` row names exactly one guild or one agent, at most
once per secret, and cascades with the secret, the guild, or the
agent. Grants add up.

An agent's environment is:

- the organisation-wide secrets
- the secrets granted to its guild
- the secrets granted to it

Those resolve in one query. There are no secret bindings, switches,
or shadowing.

One name is one value in the organisation. An agent that needs its
own value uses another name.

Deleting a guild removes its grants and its agents' grants and
deletes every secret whose grants all went with it. Deleting an
agent deletes every secret granted only to it.

A secret created unassigned, or whose access an admin emptied, stays
unassigned until it is granted or deleted. Deleting the organisation
deletes its secrets.

## Who manages a secret

Every member of the organisation lists and reads each secret's
metadata (name, description, access, origin, and times; never a
value). Organisation owners and admins create, edit, rotate, and
delete any secret. Only they change access.

A member creates a secret only with grants to guilds they can see
(org-visible, or a private guild they operate) and agents in them,
never organisation-wide or unassigned. A member edits, rotates, and
deletes a secret local to them: not organisation-wide, at least one
grant, and every grant on a guild they can see or an agent in one.

A refused write is 403 inside the secret's organisation and 404
across organisations. A grant in a guild the caller cannot see (a
private guild, or an agent in one) comes back as
`{ kind, id: null, name: null }` and reads **Private guild**. So does
a creating agent in such a guild.

```text
GET    /api/secrets[?guild_id= | ?agent_id=]
POST   /api/secrets
GET    /api/secrets/:id
PATCH  /api/secrets/:id
PUT    /api/secrets/:id/access
DELETE /api/secrets/:id
```

- `GET /api/secrets` (any member, current organisation) returns
  `{ secrets }`. `?guild_id=` keeps what reaches that guild's agents:
  organisation-wide, granted to the guild, or granted to one of its
  agents. `?agent_id=` keeps exactly that agent's environment.
- `POST` takes
  `{ name, description, value, org_wide?, guild_ids?, agent_ids? }`
  and returns 201 with the metadata. A taken name is 409
  `NAME already exists in this organisation`. An unknown guild or
  agent id, or an invalid field, is 422.
- `PATCH` takes any of `name`, `description`, and `value`. A new
  value sets `rotated_at`; a taken name is 409.
- `PUT …/access` (owners and admins) takes
  `{ org_wide, guild_ids, agent_ids }` and replaces access. Unless
  `org_wide` is set, grants the caller cannot see stay, since the
  caller cannot name them.
- `DELETE` is 204.

Metadata is
`{ id, name, description, org_wide, grants: [{ kind, id, name }], created_by: { kind: user | agent, id, name } | null, created_at, updated_at, rotated_at, can_manage }`.
The agent payload (`GET /api/agents/:id`) carries `access.secrets`,
the agent's environment as `[{ id, name, description }]`.

## What reaches a sandbox

Each generation resolves the agent's environment, writes it onto the
run snapshot as `[{ id, name, description }]`, decrypts the values,
and injects them as sandbox environment variables, each named after
its secret. A keyed fingerprint of the environment decides whether
the sandbox is recreated. A missing or undecryptable secret is a
generation-start error.

State `environment` lists each name and description. The value is
never in the prompt.

A change of value, name, or description reaches the agents with an
active run snapshot or a running sandbox that uses the secret. A
create, delete, or access change reaches the agents that gain or
lose it.

Either re-syncs their active run snapshots and destroys their idle
sandboxes. A generating agent's sandbox is marked stale and recycled
after its generation.

The change reaches the next generation of an existing direct run.
The sandbox lifecycle itself is in [Runs](runs.md#sandbox).

Any process in the sandbox reads that environment:

- user scripts
- a coding agent's `shell` commands
- the browser
- the operator's CLI tab, a root shell on that machine

Only secrets enter it. Connection credentials (OAuth tokens, API
keys, signing keys), the GitHub App's private key, and the instance
keys stay in the orchestrator. A coding agent's GitHub installation
tokens sit in `/run/guilds/`, outside the workspace, for their hour.

## Redaction

Redaction uses every secret value resolved for the run. OAuth tokens,
API keys, and signing keys on connected catalog logins join that set,
as do a coding run's installation tokens.

It is exact-value. Every tool result, log line, and repository diff
has those strings replaced.

Transformed, encoded, or split forms remain inside the agent trust
boundary. A value the model already saw stays in earlier history.

## `secret_store` and `secret_request`

`secret_store { name, description, file }` saves a value the agent
produced as a secret granted to that agent, without the value
passing through the model. The orchestrator reads `file` from the
agent's workspace (`/home/agent`) under the
[workspace file rules](#agent-workspace-files).

It refuses:

- more than 16 KiB
- invalid UTF-8
- a NUL byte
- an empty value

One trailing newline is stripped. A name the organisation already
holds is rotated when this agent created that secret and is its only
grant, and refused otherwise
(`NAME is taken in this organisation; choose another name`).

An agent that already created 20 secrets is refused a new one.
Rotating is not a new secret.

The tool writes the row with the agent as creator and its one grant.
It deletes the file. It adds the value to the running generation's
redaction set.

Later tool results in that generation are redacted. A value the
model already saw stays in earlier history.

It returns `{"stored": NAME, "rotated": bool}` plus a line that the
variable is in the environment from the next generation. The sandbox
environment is fixed at container start. The sandbox is recycled
after the generation.

It is offered on every run kind. An agent cannot read a value back,
delete a secret, or change its access.

`secret_request { name, description, reason }` (reason at most 400
characters) is offered on direct runs only. A group or schedule run
asks with `group_post`. The operator adds the secret from a Secrets
view.

It writes nothing. The result is `{"status":"available"}` when the
name is already in this generation's environment, otherwise
`{"widget":"secret_request","name":NAME,"status":"asked"}` plus a
line telling the agent it asked the operator in this chat and to
end its turn.

The operator answers from a card in the transcript
([Operator app](operator-app.md)). The value goes to the secrets
API, never into the transcript.

## Agent workspace files

An agent's `/home/agent` is its folder on the orchestrator's machine
(`WORKSPACE_ROOT/<agent id>`), mounted into its sandbox. Tools that
take a path there (Drive `create_file` and `download_file_content`,
Qonto `upload_invoice`, `secret_store`) have the orchestrator open
that folder directly, where a link resolves against the
orchestrator's own filesystem. `readAgentFile` and `writeAgentFile`
in `apps/orchestrator/src/lib/agent-file.ts` are the only way in:

- A path is `/home/agent/...` or relative to it, and must stay inside
  the folder.
- A read follows every link, requires the result to stay in the
  folder and be a regular file (not a folder, FIFO, or device), then
  opens it without following a link and without blocking, and
  requires the opened file to be the one checked. A file over the
  tool's size limit is refused.
- A write accepts no link anywhere on the path: each existing folder
  must be a real folder in the workspace, missing folders are created
  one at a time, and the file is created or replaced without
  following a link at its name.

The code tools never take this path. They run inside the container,
so a link resolves there
([Code tools](tools-and-connectors.md#code-tools)).

## Access views

Every scope has one access view, the same component over a different
subject:

- the organisation's under **Settings** (**Secrets** and **Tools**)
- a guild's on its **Tools** and **Secrets** pages
- an agent's on its **Tools** and **Secrets** tabs

Each shows what the scope inherits from the scopes above it. The
operator can switch a tool, a connector, or a connector's tool to
Inherit, On, or Off, connect a login of its own, and reset a value
back to the inherited one.

The Secrets side lists the secrets that reach the scope with who
gets each, and adds, edits, deletes, and changes access to them as
the caller's role allows. The Tools view groups `secret_store` and
`secret_request` as **Secrets**.

```text
GET /api/access                     the current organisation
GET /api/guilds/:guild_id/access    one guild
GET /api/agents/:agent_id/access    one agent
```

Each returns the scope's tools, the four note grants, and `mcp` (each
connector with its connection, its listed tools, and their resolved
state), every entry with its effective value and where it comes from.
`GET /api/secrets?guild_id=` and `?agent_id=` are the Secrets side.
`PUT` and `DELETE /api/bindings` write a switch at one scope
([Tools and connectors](tools-and-connectors.md#catalog-connections-bindings)).

## What an operator relies on

- A secret reaches every agent its access names, and any process in
  those sandboxes can read it and send it out. Grant narrowly.
- Members read a secret's name, description, and access, never its
  value. A value leaves the orchestrator only into the sandboxes of
  the agents it reaches.
- Connection credentials never enter a sandbox: an agent calls a
  connected account through the orchestrator, and only for tools that
  are On. A guild-shared connection is shared agency: every inheriting
  agent acts as that account.
- Redaction catches exact values only. What the model has already seen
  stays in its history.
- The CLI tab is a root shell on the agent's machine for any operator of
  the agent: files, processes, and environment, secret values included.
- An agent writes a secret only through `secret_store`, granted to
  itself, and cannot read one back.

The assumptions these rest on are in [System](../architecture/system.md).
