# Install

This page takes a machine with Docker to a running guilds.run box,
open in your browser. The two pages after it connect a model key and
build a first guild.

Core runs on one machine from one Compose file. The stack is three
containers: PostgreSQL, OpenSandbox, and the orchestrator, which
serves the operator app. Every guild and every agent sandbox runs on
that machine.

Nothing else is needed:

- no cloud account
- no email or payment provider
- no reverse proxy

## Requirements

- Docker with the Compose plugin. `docker compose version` prints one
  when it is there. Agent sandboxes are containers the stack starts
  beside itself, so the stack mounts the Docker socket.
- git and bash.
- Disk for the images and for agent workspaces. The runtime image
  downloads a browser and toolchains.

Node and pnpm are not needed to run the stack. They are for
[development](../contributing/development.md).

## Start

Three commands:

```text
git clone https://github.com/CigaleAI/guilds.git && cd guilds
./setup.sh
docker compose up --detach --wait
```

**`./setup.sh`** prepares the checkout. It copies `.env.example` to
`.env` (mode 600) when there is none and writes the four values the
stack cannot start without: `STATE_ROOT` (the absolute path the
stack keeps its state under, `.state` in the checkout),
`SECRETS_MASTER_KEY`, `POSTGRES_PASSWORD`, and `OPENSANDBOX_API_KEY`.
It creates the state directories under `STATE_ROOT`. Then it builds
the three images no registry publishes (`scripts/images.sh`): the
OpenSandbox server, from its pinned commit, and the two images agents
run in, from `runtime/`. The builds are the slow part: several
minutes the first time, from Docker's cache after that. The script
ends with `Ready.` and the two lines to run next.

Keep `.env`. `SECRETS_MASTER_KEY` is the only copy of the key every
stored credential is encrypted with.

**`docker compose up --detach --wait`** starts the three services.
The first start also builds the orchestrator image
(`apps/orchestrator/Dockerfile`) from the checkout. `--wait` returns
once every service is healthy.

## Check it worked

Open `http://127.0.0.1:8080/`.

The page opens on a dialog titled **Welcome to guilds.run**. It asks
for a model provider, which is the next page. Behind it the app is
already signed in: boot applied the migrations and, on a database
with no user, created one user, `operator`, who owns the organisation
`Home`.

The stack does not authenticate. Whoever reaches the port is that
operator. Giving other people accounts, and reaching the box from
another machine, is [Remote access](remote-access.md).

If the page does not load, `docker compose ps` shows which service is
not healthy and `docker compose logs orchestrator` says why. The
messages are listed in [Operate](operate.md#when-it-fails).

## What runs

| Service | Role | Published |
|---|---|---|
| `orchestrator` | The control plane and the operator app | `127.0.0.1:8080` (`ORCHESTRATOR_PORT`) |
| `postgres` | The database | No |
| `opensandbox` | Starts and stops agent sandboxes through the Docker socket | No |

Only the orchestrator is published, on loopback. Sandboxes have
Docker bridge egress, so agents reach the public internet.

The two images agents run in:

- `agent-runtime:0.3` — the standard, code, and custom boxes (a
  browser and the coding toolchains)
- `agent-runtime-lite:0.1` — the lite box (scripts and a terminal)

The standard image installs Google Chrome on amd64 and Debian's
Chromium on arm64. To use Chromium everywhere:

```text
docker build --build-arg BROWSER=chromium --tag agent-runtime:0.3 runtime/
```

## Where the state lives

`STATE_ROOT` is an absolute path on the Docker host. OpenSandbox
mounts each agent's workspace into its sandbox by that same path,
which is why a relative path is refused. Each tree under it is
bind-mounted into the container that uses it; the stack creates no
named Docker volume.

- `postgres/` — the database
- `workspaces/` — one directory per agent, mounted at `/home/agent`
- `attachments/` — uploaded chat images
- `notes/` — the notes vault
- `opensandbox/` — the sandbox server's store
- `connectors/` — connector packages installed from a registry

Everything the box knows is this tree and `.env`
([Operate](operate.md#back-up)).

## Running setup.sh again

Running `./setup.sh` again keeps every value `.env` already has and
rebuilds the runtime images.

It refuses to generate a secret when `STATE_ROOT/postgres` already
holds a database. That database was created with values only its
owner has. Put those values into `.env`, or point `STATE_ROOT` at an
empty directory.

`./setup.sh --env-only` writes `.env` and the directories. It builds
no image.

Without `.env` the stack does not resolve. Each missing value says
`run ./setup.sh first, which writes it into .env`.

## Starting over

To start from an empty box, stop the stack, remove the state
directories, and start it again:

```sh
docker compose down
rm -rf .state/{postgres,opensandbox,workspaces,notes,attachments,connectors}
docker compose up --detach --wait
```

`.state` is the `STATE_ROOT` that `.env` names; use that path where
it differs.

On the empty database the orchestrator applies its migrations and
seeds the first operator and the `home` organisation. `.env` and the
images stay. On a development checkout `make reset` does the same
([Development](../contributing/development.md#local-state)).

Next: [Model keys](model-keys.md).
