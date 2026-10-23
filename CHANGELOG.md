# Changelog

Each entry is a version, its effect on a running box (`no impact`,
`rebuild`, or `breaking`), and what an operator can see. What each
digit means is in [Contributing](docs/CONTRIBUTING.md#versions). The
commands for each effect are in
[Maintain](docs/operations/maintain.md#update).

## Unreleased

**Breaking.** Agents run on machines: containers an organisation
sizes and shares between its agents. A box whose agents each run in
a sandbox of their own moves them onto machines.
[Back up](docs/operations/maintain.md#back-up) first, then:

1. Pull and run `./setup.sh`. It builds `agent-runtime:0.4`. A
   `.env` that sets `SANDBOX_IMAGE` must name `agent-runtime:0.4`
   or an image built from this `runtime/`. Nothing reads
   `SANDBOX_IMAGE_LITE`. Remove it from `.env`.
2. Start the stack with `docker compose up --detach --wait --build`.
   Migration 0004 places every agent on a machine:
   - Each organisation gets a `standard` machine named `default`.
     It holds every agent with neither browser nor coding, 32 at
     most per machine (`default-2`, `default-3`… for the rest).
   - Every other agent gets a machine of its own, named after it,
     with the tier and size its configuration held.
   - A machine's disk cap is 10240 MiB, or its agents' measured
     use plus 1024 MiB when that is larger.
   - The tier and size leave agent configurations and active run
     snapshots.
3. Before generation starts, the server destroys every sandbox
   labelled with an `agent_id`. It moves each
   `WORKSPACE_ROOT/<agent id>` into
   `WORKSPACE_ROOT/<machine id>/<agent id>`. Repositories, scripts,
   and the `.browser` profile with its logins move with it.
4. Reinstall the tools an agent installed in its home with
   `/home/agent` written into them: Python virtualenvs, mise
   installs, and npm installs. The home is `/home/<agent id>`. Run
   the install again from the agent's **CLI** tab, or let the agent
   run it.
5. Update API clients and editions to the machine API. Agent create
   takes `machine_id`, required when the organisation has more than
   one machine. Agent payloads carry `machine_id` and `machine`. A
   machine holds the tier and size
   ([Machines](docs/concepts/machines.md)). An edition's
   `SandboxProvider`, `GenerationSandboxes`, and `machineHost` are
   keyed by machine
   ([Extension points](docs/architecture/extension-points.md)).

To share machines, move agents onto one under each agent's
**Settings**, **Machine**. Then delete the machines left empty under
**Settings**, **Machines**.

**Breaking.** Notes and tables share one access list per item. Each
row gives the organisation, a guild, or an agent `read` or `write`; an
agent row can also be `none`, which shuts that agent out. An agent's
own row wins, otherwise it gets the better of its guild's row and the
organisation's. Access is edited on the item: a table's **Access** tab,
and **Access** on an open note. A guild's and an agent's **State**,
**Access** lists what it reaches. Migration 0012:

- Copies every live table's rows, gives a guild's own table a
  `write` row for its guild, and gives every organisation table
  without an organisation row the organisation at `read`. An
  organisation table no guild was given is now readable by every
  agent.
- Gives each guild note its guild at `write` and each organisation
  note the organisation at `read`.
- Drops the `read_guild`, `read_org`, `write_guild`, and `write_org`
  grants. Overrides set on one agent are not carried over: that agent
  follows its guild's and the organisation's rows.

Update API clients and recipes:

- `/api/notes/:id/access` and `/api/collections/:id/access` read and
  replace an item's list. The guild and agent `collection-access`
  routes are gone, and `GET /api/collections/:id` no longer carries
  `access_list`.
- The bindings API refuses `artifact_grant`.
- A recipe whose role sets `grants` is refused.
- A Task embed resolves as its agent: a note the agent cannot read
  is not inlined, and the prompt says the file is not reachable.

**Model keys** lists Anthropic. An organisation connects its Claude
API key and offers Claude models to agents, Studio, and the Builder,
called through Anthropic's Messages API.

Studio reads the about and description of the organisation's other
guilds the operator can see. Its tables are the source guild's own and
the organisation's. It adds columns to an organisation table and
changes the guild's rows in its access list, but no longer renames, rewrites, or
deletes one; those changes are made on the **Tables** page. Another
guild's own tables and their records are out of Studio's reach.

A Task or a note references a note as `[[display-path]]`: the run
keeps the link, and the agent reads the note with `note_get` when it
needs it. **Insert › Note** chooses **Embed** or **Reference**, with an
info tooltip on the difference. **Insert › Column** picks a table's
column and inserts it as `` `table.column` ``. A column's description
holds up to 1,000 characters, in a multi-line box. A guild's and an
agent's **State** has a **Tables** sub-tab listing the tables they
reach with their columns, and **Access** always shows its **Tables**
and **Notes** sections.

A routine's timing, description, and instruction can be changed in
place. The agent's **Routine** tab has **Edit routine**,
`PATCH /api/agents/:id/schedules/:schedule_id` takes `cron` or
`window`, `description`, and `instruction` beside `paused`, and agents
in chat get the `schedule_update` tool. A new timing on a running
routine plans its next wake-up from now.
