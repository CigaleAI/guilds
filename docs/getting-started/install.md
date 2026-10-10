# Install

Core runs on one machine from one Compose file.

The stack is PostgreSQL, OpenSandbox, and the orchestrator. The
orchestrator serves the operator app.

Nothing else is needed:

- no cloud account
- no email or payment provider
- no reverse proxy

Every guild and every agent sandbox runs on that machine.

## Requirements

- Docker with the Compose plugin. Sandboxes are containers the stack
  starts beside itself, so the stack mounts the Docker socket.
- git and bash.
- Disk for the images and for agent workspaces. The runtime image
  downloads a browser and toolchains. The first build takes several
  minutes.

Node and pnpm are not needed to run the stack. They are for
[development](../contributing/development.md).

## Start

```text
git clone <this repository> && cd <it>
./setup.sh
docker compose up --detach --wait
```

Then open `http://127.0.0.1:8080/`.

`./setup.sh` does four things:

- copies `.env.example` to `.env` (mode 600) when there is none
- writes the four values the stack cannot start without:
  `STATE_ROOT` (the absolute path the stack keeps its state under,
  `.state` in the checkout), `SECRETS_MASTER_KEY`,
  `POSTGRES_PASSWORD`, and `OPENSANDBOX_API_KEY`
- creates the state directories under `STATE_ROOT`: `notes/`,
  `workspaces/`, `attachments/`, `postgres/`, and `opensandbox/`
- builds the three images no registry publishes
  (`scripts/images.sh`): the OpenSandbox server, from its pinned
  commit, and the two images agents run in, from `runtime/`

The two runtime images:

- `agent-runtime:0.3` — standard box (coding and a browser)
- `agent-runtime-lite:0.1` — lite box (scripts and a terminal)

Running `./setup.sh` again keeps every value `.env` already has.

It refuses to generate a secret when `STATE_ROOT/postgres` already
holds a database. That database was created with values only its owner
has. Put those values into `.env`, or point `STATE_ROOT` at an empty
directory.

`./setup.sh --env-only` writes `.env` and the directories. It builds
no image.

The standard runtime image installs Google Chrome on amd64 and
Debian's Chromium on arm64. To use Chromium everywhere:

```text
docker build --build-arg BROWSER=chromium --tag agent-runtime:0.3 runtime/
```

Without `.env` the stack does not resolve. Each missing value says
`run ./setup.sh first, which writes it into .env`.

The first `docker compose up` builds the orchestrator image
(`apps/orchestrator/Dockerfile`) from the checkout. `--wait` returns
once every service is healthy.

## What runs

| Service | Role | Published |
|---|---|---|
| `orchestrator` | The control plane and the operator app | `127.0.0.1:8080` (`ORCHESTRATOR_PORT`) |
| `postgres` | The database | No |
| `opensandbox` | Starts and stops agent sandboxes through the Docker socket | No |

Only the orchestrator is published, on loopback. Sandboxes have Docker
bridge egress, so agents reach the public internet.

`STATE_ROOT` is an absolute path on the Docker host. OpenSandbox
mounts each agent's workspace into its sandbox by that same path.

It holds:

- `postgres/` — the database
- `workspaces/` — one directory per agent, mounted at `/home/agent`
- `attachments/` — uploaded chat images
- `notes/`
- `opensandbox/` — the sandbox server's store

## The first operator

Boot applies the migrations. On a database with no user it creates one
user, `operator`, who owns the organisation `Home`.

The stack does not authenticate. Whoever reaches the port is that
operator. The app opens on them with no sign-in.

Giving other people accounts, and reaching the box from another
machine, is [Remote access](remote-access.md).

## The first model key

A run needs the organisation's own key for a model provider. The
server holds none. Under **Settings**, **Model keys**:

1. Choose a provider: OpenAI, OpenRouter, xAI, DeepInfra, a local
   OpenAI-compatible endpoint, or Kimi Code for coding agents.
2. Paste the key. The local endpoint takes a base URL and an
   optional key. The key is probed; a rejected one is not saved.
3. Choose the models to offer from the provider's catalog.
4. Mark one as the organisation's default.

Until a provider is connected, creating an agent, starting Studio or
the Builder, and applying a recipe show a guide to Model keys in
place of the model picker
([Operator app](../concepts/operator-app.md#settings-settings)).

Every key in `.env` is optional ([Configure](configure.md)).

Next: [Your first guild](first-guild.md).
