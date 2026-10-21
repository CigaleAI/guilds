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

**Model keys** lists Anthropic. An organisation connects its Claude
API key and offers Claude models to agents, Studio, and the Builder,
called through Anthropic's Messages API.
