# Development

The repository is a pnpm workspace:

- `apps/orchestrator` (the Node control plane)
- `apps/web` (the operator app)
- `packages/ui` (the design system)
- `apps/docs-mcp` (the docs search MCP)
- `runtime/` (the agent runtime image)

The toolchain is Node 24 (`.nvmrc`), pnpm 10 (`packageManager` in
`package.json`), Docker with Compose, git, and bash.

`pnpm install` installs every package and enables the pre-push
hook through `core.hooksPath`.

## The development stack

`make up` starts `docker-compose.dev.yml`. That file is the
product stack (`docker-compose.yml`) with the development overlay
(`docker-compose.watch.yml`) and docs search
(`docker-compose.docs.yml`).

The overlay publishes PostgreSQL on `127.0.0.1:5432`. It
bind-mounts `src/`, `scripts/`, and `drizzle/` into the
orchestrator container. `tsx watch` restarts the orchestrator
when a source file changes.

The operator app is served at `http://127.0.0.1:8080/` as built
into the image at the last `make up`.

`make dev` brings that stack up and runs the operator app's Vite
server in the foreground at `http://127.0.0.1:5173/`. The Vite
server reloads in place on every edit. It proxies `/api`,
`/avatars`, and `/health` to the orchestrator.

The Makefile gives a development stack its secrets:

- the all-zero master key (which the overlay accepts with
  `ALLOW_ZERO_MASTER_KEY=1`)
- the PostgreSQL password `agent_platform`
- the OpenSandbox key `guilds-dev`

The box's first user is `user_operator`, owner of the
organisation `home`. `make verify` and `make soak` act as that
user.

| Target | Does |
| --- | --- |
| `make state` | Creates the `STATE_ROOT` trees (`.state/` in the checkout) |
| `make build` | Builds the OpenSandbox server, `agent-runtime:0.3`, `agent-runtime-lite:0.1`, and the development stack's images |
| `make up` | The development stack, detached, after the images |
| `make dev` | `make up`, then the Vite server |
| `make down` | Stops every service of the stack and of docs search |
| `make reset` | `make down`, removes the local state trees, `make up` |
| `make verify` | Health, the guild list as the seed user, the app page, typecheck, lint, the orchestrator tests, the fixture digests, against a running stack |
| `make soak` | Creates and deletes a guild, restarts the orchestrator, and reads the migration, seed, binding, and run tables |
| `make contract` | The OpenSandbox and model contract tests (`RUN_OPENSANDBOX_CONTRACT`, `RUN_MODEL_CONTRACT` with `MODEL_CONTRACT_MODEL`; the model one needs `OPENROUTER_API_KEY` in `.env`) |
| `make check` | `scripts/check.sh`: what CI runs |

One package runs alone with pnpm:

- `pnpm --filter @guildsrun/web dev` serves the operator app
- `pnpm --filter @guildsrun/ui storybook` serves the design
  system's Storybook on port 6006. A running instance and the
  documentation site serve the built catalogue at `/storybook`
- `pnpm --filter @guildsrun/orchestrator start` serves the
  orchestrator outside Docker, against the `.env` it reads

## Check

`scripts/check.sh` is the whole check. It starts its own
throwaway PostgreSQL 17 container and runs three lanes side by
side. Each step logs to its own file. A failing step prints its
log.

| Lane | Steps |
| --- | --- |
| orchestrator | `typecheck`, `lint`, `compat-verify`, `test-orchestrator`, `test-docs-mcp` |
| web | `test-ui`, `test-web`, `build-web`, `build-storybook` |
| core stack | `smoke-core-stack`: `./setup.sh` and `docker compose up` on a copy of the checkout, under its own Compose project, port, image tag, and state directory, checking that the box is healthy, serves the app on loopback alone, holds one operator, and refuses a request from another web origin |

`scripts/check.sh <commit>` (or `make check COMMIT=<rev>`)
checks that commit the way CI does: a clean worktree of it and
`pnpm install --frozen-lockfile`. A commit that passed is
recorded in the git directory's `check-passed` and not checked
again.

The pre-push hook (`.githooks/pre-push`) runs that check on the
tip of every pushed ref and stops the push when it fails.
`git push --no-verify` skips it.

CI is `.github/workflows/verify.yml`. On every push and pull
request, one job installs with the frozen lockfile and runs
`scripts/check.sh`.

`.github/workflows/images.yml` publishes the orchestrator,
`agent-runtime`, `agent-runtime-lite`, and OpenSandbox server
images to `ghcr.io` when a version tag is pushed.

An edition built on core runs the same script from its own root
with `EDITION_ROOT` set. It adds its steps through a
`check.steps` file
([Extension points](../architecture/extension-points.md)).

The edition's workspace includes core's packages. `pnpm install`
in either root links each core package's `node_modules` to that
root's store. Before a working-tree check, install from the root
the check runs in.

## Tests

The orchestrator's tests run on Node's test runner through `tsx`
(`pnpm --filter @guildsrun/orchestrator test`):

| Directory | Covers |
| --- | --- |
| `test/unit` | Domain logic without Docker; the generation tests drive `GenerationLoop` against the file-backed `NotesStore` and fakes |
| `test/integration` | HTTP and PostgreSQL: the recorded routes and SSE and WebSocket fixtures replayed against a database on `127.0.0.1:5432` (`R1_ADMIN_DATABASE_URL` names another) |
| `test/contract` | Live OpenSandbox, model, and routing calls, each gated by its `RUN_*_CONTRACT=1` variable and key |
| `test/helpers` | The environment, fixtures, HTTP, OpenSandbox stub, and PostgreSQL helpers, which the package also exports for an edition's tests |

The operator app's and the design system's tests sit beside their
modules as `src/**/*.test.ts` (`pnpm test:web`, `pnpm test:ui`).
They cover the pure models:

- run flow
- tool kinds and formatting
- Studio location and chat
- the activity ledger
- the recipe plan and apply steps

`fixtures/compat/` holds the frozen HTTP, SSE, schema, crypto,
and adapter contracts, with a sha256 digest of each in
`manifest.json`.

`pnpm --filter @guildsrun/orchestrator compat:verify` fails when
a fixture differs from its digest or is missing from the
manifest. After a change made on purpose, `compat:digest` in the
same package rewrites the digests of the changed fixtures. It
never adds or removes an entry.

`scripts/patch-http-mcp-catalog` rewrites the HTTP fixture when
the catalog's shapes change.

## Schema changes

New schema lands as the next numbered SQL file in
`apps/orchestrator/drizzle/`. It is mirrored in
`src/db/schema/index.ts` and recorded in
`drizzle/meta/_journal.json` with a stamp later than the
migration before it.

Boot applies committed migrations before the HTTP listener is
ready. Production never uses `drizzle-kit push`.

`0001_baseline.sql` is a schema-only snapshot.
`drizzle/0001.notes.md` says how it is regenerated
(`scripts/dump-baseline-schema`). The optional
`test/integration/schema-diff.test.ts` compares a boot migration
against applying the SQL files directly.

## Lint and format

Every package runs ESLint (`pnpm -r lint`) on the recommended
and typescript-eslint rules. Unused names are allowed when they
start with `_`.

The orchestrator and the operator app also run the boundary rule
(`eslint.boundary.js`). It fails any file that imports a package
of an edition or a relative path that leaves this repository.

Prettier formats with semicolons, double quotes, trailing
commas, and a width of 100 (`pnpm --filter <package> format`).

## Docs search

`make up` also starts LightRAG and the chapter preview.
`make docs-index` indexes the docs directory (`DOCS_HOST_ROOT`,
`docs/` by default). Search matching segments at
`http://127.0.0.1:9622/`.

Coding agents use the `guilds-docs` MCP server (`apps/docs-mcp`)
over the same index. Indexing needs `OPENROUTER_API_KEY`.
`DOCS_LLM_MODEL`, `DOCS_EMBEDDING_MODEL`, and
`DOCS_EMBEDDING_DIM` change the models it uses.

`make docs-up` and `make docs-down` start and stop those two
services alone.

## Documentation

The documentation is Markdown under `docs/`.
`docs/README.md` is the index and the one place the structure is
kept. GitHub shows it on the repository page.
`docs/philosophy.md` is the motivation and the principles.
