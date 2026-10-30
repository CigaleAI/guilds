# Development

The repository is a pnpm workspace:

- `apps/orchestrator` (the Node control plane)
- `apps/web` (the operator app)
- `packages/ui` (the design system)
- `runtime/` (the agent runtime image)

The toolchain is Node 24 (`.nvmrc`), pnpm 10 (`packageManager` in
`package.json`), Docker with Compose, git, and bash.

`pnpm install` installs every package and enables the pre-push
hook through `core.hooksPath`.

## The development stack

`make up` starts `docker-compose.dev.yml`. That file is the
product stack (`docker-compose.yml`) with the development overlay
(`docker-compose.watch.yml`).

The overlay publishes PostgreSQL on `127.0.0.1:5432`. It
bind-mounts the orchestrator's `src/`, `scripts/`, and `drizzle/`
into its container. `tsx watch` restarts the orchestrator when a
source file or a migration changes. Boot applies new migrations,
so the database keeps its data and gains the new schema.

The operator app is served at `http://127.0.0.1:8080/` as built
into the image at the last `make up`.

`make dev` brings that stack up and runs the operator app's Vite
server in the foreground at `http://127.0.0.1:5173/`. The Vite
server reloads in place on every edit. It proxies `/api/*`,
`/avatars/*`, and `/health` to the orchestrator.

The Makefile gives a development stack its secrets:

- the all-zero master key, which the overlay accepts with
  `ALLOW_ZERO_MASTER_KEY=1`
- the PostgreSQL password `agent_platform`
- the OpenSandbox key `guilds-dev`

The box's first user has the id `user_operator`. It owns the
organisation with the slug `home`. `make verify` and `make soak` act
as that user.

## Make targets

`make` alone runs `make contract`, the default goal.

| Target | Does |
| --- | --- |
| `make contract` | `contract-opensandbox`, then `contract-model` |
| `make contract-opensandbox` | The OpenSandbox and coding contract tests with `RUN_OPENSANDBOX_CONTRACT=1` ([Tests](#tests)) |
| `make contract-model` | The model contract test with `RUN_MODEL_CONTRACT=1`. Reads `MODEL_CONTRACT_MODEL` and `MODEL_CONTRACT_API_KEY` from `.env`, and fails when either is empty |
| `make state` | Creates the `STATE_ROOT` trees (`.state/` in the checkout) |
| `make opensandbox-image` | `scripts/images.sh opensandbox`: builds `guilds-opensandbox-server:<commit>` from the pinned commit, once |
| `make runtime-image` | `scripts/images.sh runtime`: builds `agent-runtime:0.4` from `runtime/`, every time, from Docker's cache |
| `make core-image` | Builds `guilds-orchestrator:local` from `apps/orchestrator/Dockerfile` |
| `make build` | `state`, both images, then builds the development stack's images |
| `make up` | `state`, both images, then the development stack, built, detached, and healthy |
| `make dev` | `make up`, then the Vite server |
| `make down` | Stops every service of the product stack and an extension's Compose files |
| `make reset` | `make down`, removes the local state trees, `make up` ([Resetting](#resetting)) |
| `make migrate` | Gives each recorded migration its committed stamp, applies the migrations it was hiding, and restarts the orchestrator. The data stays ([Schema changes](#schema-changes)) |
| `make verify` | Against a running stack: health, the guild list as the seed user, the app page, typecheck, lint, the orchestrator tests, an extension's test packages, the fixture digests |
| `make soak` | Creates and deletes a guild, restarts the orchestrator, and reads the migration, seed, binding, and run tables |
| `make check` | `scripts/check.sh`: what CI runs ([Check](#check)) |
| `make compat-verify` | The fixture digests alone |

The extending repository sets the variables the Makefile reads
([Extension points](../architecture/extension-points.md)).

## Package scripts

At the repository root:

| Script | Does |
| --- | --- |
| `pnpm check` | `scripts/check.sh` |
| `pnpm typecheck`, `pnpm lint` | Every package's typecheck or lint |
| `pnpm test:orchestrator`, `pnpm test:web`, `pnpm test:ui` | One package's tests |
| `pnpm compat:verify` | The fixture digests |
| `pnpm storybook` | The design system's Storybook on port 6006 |
| `pnpm build:storybook` | Builds the Storybook into `packages/ui/storybook-static` |
| `pnpm design-system-doc` | Writes `packages/ui/design-system.md` ([Design system](../architecture/design-system.md)) |

In `apps/orchestrator`, run as `pnpm --filter @guildsrun/orchestrator <script>`:

| Script | Does |
| --- | --- |
| `start` | Serves the orchestrator outside Docker. It reads its settings from its environment, not from `.env` |
| `migrate` | Re-stamps the recorded migrations, then applies the committed ones (`make migrate` runs it) |
| `seed:system`, `seed:operator` | Seeds the platform's connector catalog and its bindings, or the first user and the organisation they own on a box with no user |
| `connector` | `install`, `update`, `remove`, or `list` registry connectors ([Connector registry](../tools-and-connectors/connector-registry.md)) |
| `build:connector` | Bundles a connector folder into a registry package |
| `models:snapshot` | Rewrites the bundled models.dev snapshot, `src/llm/models-dev.snapshot.json` |
| `sweep:workspaces` | Lists, or with `--apply` removes, orphan machine directories and agent homes ([Maintain](../operations/maintain.md#free-disk-space)) |
| `typesafe:replay` | Replays the group-chat recipient choice for one message ([Group chat](../concepts/group-chat.md)) |
| `compat:verify`, `compat:digest` | Checks, or rewrites, the fixture digests ([Tests](#tests)) |
| `format` | Prettier over the package |

`pnpm --filter @guildsrun/web dev` serves the operator app's Vite
server alone. A running instance serves the built Storybook at
`/storybook`.

## Local state

Everything the stack keeps lives under `STATE_ROOT`, `.state/` in
the checkout. Each tree is bind-mounted into the container that
uses it, and the stack creates no named Docker volume. So
`docker volume ls` shows nothing of it, and `docker compose down -v`
removes nothing. [Maintain](../operations/maintain.md#where-the-state-lives)
lists the trees.

### Resetting

`make reset` starts over from an empty box:

```sh
make reset
```

It runs `make down`, removes the six trees, and runs `make up`. On
the empty database the orchestrator applies its migrations and seeds
the operator user and the `home` organisation. The target refuses to
run when `STATE_ROOT` is `/srv`, the production path.

To drop the database and keep the rest:

```sh
make down
rm -rf .state/postgres
make up
```

The other trees then hold notes, workspaces, and attachments of
guilds and agents the database does not know. They are inert. The
next `make reset` removes them.

A reset leaves `.env`, the built images, and `node_modules` as they
are. Running `./setup.sh` afterwards keeps every value `.env` already
has.

The reset stack runs the code in the checkout: the orchestrator from
its bind-mounted source, and the operator app as built into the image
by `make up`, or served live by `make dev`.

## Check

`scripts/check.sh` is the whole check. It starts its own
throwaway PostgreSQL 17 container and runs three lanes side by
side. Each step logs to its own file. A failing step prints its
log.

| Lane | Steps |
| --- | --- |
| orchestrator | `typecheck`, `lint`, `import-cycles`, `compat-verify`, `test-orchestrator` |
| web | `test-ui`, `test-web`, `build-web`, `build-storybook` |
| core stack | `smoke-core-stack`: `./setup.sh` and `docker compose up` on a copy of the checkout, under its own Compose project, port, image tag, and state directory. It checks that the box is healthy, serves the app on loopback alone, holds one operator, and refuses a request from another web origin |

`scripts/check.sh <commit>` (or `make check COMMIT=<rev>`)
checks that commit the way CI does: a clean worktree of it and
`pnpm install --frozen-lockfile`. A commit that passed is
recorded in the git directory's `check-passed` and not checked
again.

The pre-push hook (`.githooks/pre-push`) runs that check on the
tip of every pushed ref and stops the push when it fails.
`git push --no-verify` skips it.

A repository that extends core runs the same script from its own
root with `CHECK_ROOT` set. It adds its steps through a
`check.steps` file
([Extension points](../architecture/extension-points.md)).

That repository's workspace includes core's packages. `pnpm install`
in either root links each core package's `node_modules` to that
root's store. Before a working-tree check, install from the root
the check runs in.

## CI

`.github/workflows/verify.yml` runs on every push and pull request.
One job installs with the frozen lockfile and runs
`scripts/check.sh`.

`.github/workflows/images.yml` runs when a `v*` tag is pushed, or
by hand. It publishes three images to `ghcr.io`, under the
repository owner, tagged with the ref name and `latest`:

| Image | Built from |
| --- | --- |
| `guilds-orchestrator` | `apps/orchestrator/Dockerfile` |
| `guilds-agent-runtime` | `runtime/`, with `BROWSER=chromium` and `HARNESSES=` empty: Chromium and Codex only |
| `guilds-opensandbox-server` | The pinned OpenSandbox commit, tagged by its first 8 characters |

The release tag is the version in the
[changelog](../../CHANGELOG.md).

## Tests

The orchestrator's tests run on Node's test runner through `tsx`
(`pnpm --filter @guildsrun/orchestrator test`), with
`MODELS_DEV_URL` set empty:

| Directory | Covers |
| --- | --- |
| `test/unit` | Domain logic without Docker; the generation tests drive `GenerationLoop` against the file-backed `NotesStore` and fakes |
| `test/integration` | HTTP and PostgreSQL: the recorded routes and SSE and WebSocket fixtures replayed against a database on `127.0.0.1:5432` (`R1_ADMIN_DATABASE_URL` names another) |
| `test/contract` | Live calls, each skipped until its variables are set (below) |
| `test/helpers` | The environment, fixtures, HTTP, OpenSandbox stub, and PostgreSQL helpers, which the package also exports for an extension's tests |

| Contract test | Runs when |
| --- | --- |
| `opensandbox.test.ts` | `RUN_OPENSANDBOX_CONTRACT=1`. It builds the pinned OpenSandbox server image when it is missing |
| `coding.test.ts` | `RUN_OPENSANDBOX_CONTRACT=1`, and the runtime image exists: `CONTRACT_RUNTIME_IMAGE`, `agent-runtime:0.4` by default (`make runtime-image`) |
| `model.test.ts` | `RUN_MODEL_CONTRACT=1`, `MODEL_CONTRACT_MODEL` (a `{provider}/{model}` id), and `MODEL_CONTRACT_API_KEY`. `MODEL_CONTRACT_BASE_URL` points it at a local endpoint |
| `typesafe.test.ts` | `RUN_TYPESAFE_CONTRACT=1` or `RUN_MODEL_CONTRACT=1`, and `TYPESAFE_API_KEY` |
| `harness.test.ts` | One live turn per harness whose credential is set: `CLAUDE_CODE_OAUTH_TOKEN`, `CURSOR_API_KEY`, or `CODEX_AUTH_JSON` (the path of a Codex `auth.json`). It needs the runtime image too |

The operator app's and the design system's tests sit beside their
modules as `src/**/*.test.ts` (`pnpm test:web`, `pnpm test:ui`).
They cover the pure models:

- run flow
- tool kinds and formatting
- Studio location and chat
- the activity ledger
- the recipe plan and apply steps

`fixtures/compat/` holds the frozen contracts, one directory per
surface: HTTP routes, SSE and WebSocket frames, crypto, adapters,
prompts, seed rows, and more. `manifest.json` holds a sha256 digest
of each file.

`compat:verify` fails when a fixture differs from its digest or is
missing from the manifest. After a change made on purpose,
`compat:digest` rewrites the digests of the changed fixtures. It
never adds or removes an entry.

`apps/orchestrator/scripts/patch-http-mcp-catalog.ts` rewrites the
HTTP fixture when the catalog's shapes change.

## Schema changes

New schema lands as the next numbered SQL file in
`apps/orchestrator/drizzle/`. It is mirrored in
`src/db/schema/`, one file per table family that `index.ts`
re-exports, and recorded in
`drizzle/meta/_journal.json` with a stamp later than the
migration before it.

The mirror is what `db/` derives its row types from. Each schema
key is its column's name in the database, since raw queries return
rows under those names. A JSON column declares its shape with
`.$type<T>()`, and a text column limited by a `CHECK ... IN` list
declares the list with `{ enum: [...] }`.
`test/integration/schema-mirror.test.ts` migrates a fresh database
and fails when a table, a column, its type, or its nullability
differs from the mirror, or when a key differs from its column's
name.

Boot applies committed migrations before the HTTP listener is
ready. Production never uses `drizzle-kit push`.

The migrator applies a migration only when its stamp is later than
the last one the database recorded. It never compares the SQL. A
database that applied a migration under a draft stamp, later than
the one committed, skips every committed migration stamped before
it. Boot then checks that every committed migration is recorded.
When one is not, the orchestrator does not start, and its log names
the migration. On the development stack, run:

```text
make migrate
```

It gives each recorded migration the stamp committed for the same
SQL. It then applies the migrations that were skipped and restarts
the orchestrator. The data stays. A migration whose SQL changed
after it was applied is a different migration to the database.
`make reset` starts that database over.

`0001_baseline.sql` is a schema-only snapshot.
`drizzle/0001.notes.md` says what it holds and how
`apps/orchestrator/scripts/dump-baseline-schema.ts` regenerates it.
The optional `test/integration/schema-diff.test.ts` compares a boot
migration against applying the SQL files directly.

## Lint and format

Every package runs ESLint (`pnpm -r lint`) on the recommended and
typescript-eslint rules. Unused names are allowed when they start
with `_`. The operator app and the design system also run the
recommended React Hooks rules.

Every package also runs the boundary rule
(`eslint.boundary.js`). It fails any file that imports a package
of an extension or a relative path that leaves this repository. It
also fails a module that holds a re-export (`export * from`,
`export { x } from`, or `export { x }` and `export default x` of a
name the module imports), except an index a tool requires, which
the package names: the orchestrator's `src/db/schema/index.ts`,
which drizzle-kit reads.

Every package also runs the limits of the
[code guidelines](code-guidelines.md#functions) on its source,
tests and stories excepted (`eslint.limits.js`): `complexity`,
`max-depth`, an error at five parameters, a
warning past 800 lines and an error past 1,000, a refusal of
every type assertion except `as const`, and a refusal of a silent
catch: a `catch` that neither throws nor returns, a `catch` whose
only exit is a bare `return;`, and a promise's `.catch()` whose
handler returns nothing, `undefined` or `null`. It also refuses a
throw of a plain `Error`, an object type written inline in a
function's parameter, and an erased return type: `unknown` or
`Record<string, unknown>`, alone or as the element of an array or
the value of a promise, returned by an exported function, an
exported const's function, or a public method. A
package names its command-line modules, which may throw a plain
`Error`: the orchestrator's `cli/`. The operator app refuses an
import from `src/features/` in its shared directories, `src/api/`
and `src/app/`, except in `src/app/router.tsx`, the composition
root that mounts the features. The orchestrator also requires
explicit parameter and return types on what a module exports
(`@typescript-eslint/explicit-module-boundary-types`). It refuses an
import of `fastify` outside `http/`, the roots, the
extension points and the observability hooks; a value import of
`db/` from `http/`;
an import from `db/` of anything outside `db/` and `lib/`; and an
import from `lib/` of anything outside `lib/`. Errors that predate
the rules are recorded in the package's `eslint-suppressions.json`
(ESLint bulk suppressions). Lint fails on an error that is not in
the file, and on an entry that no longer matches an error, so the
list only shrinks; after a fix,
`pnpm exec eslint <lint args> --prune-suppressions` removes the
cleared entries. Warnings do not fail lint.

Prettier formats with semicolons, double quotes, trailing
commas, and a width of 100 (`pnpm --filter <package> format`).

The orchestrator's import graph gains no cycle:
`pnpm --filter @guildsrun/orchestrator cycles`, the `import-cycles`
step of the check, fails when a file or a domain (a directory under
`src/`) sits in a cycle of value imports and `import-cycles.json`
does not list it. `cycles --write` rewrites that file from the tree
as it is, and like `eslint-suppressions.json` it only shrinks.

## Documentation

The documentation is Markdown under `docs/`, published at
[docs.guilds.run](https://docs.guilds.run). `docs/README.md` is the
index and the one place the structure is kept; GitHub shows it on
the repository page. `docs/philosophy.md` is the motivation and the
principles. Every page describes the current state only, in short,
simple sentences, and a change to behaviour updates the page that
describes it in the same commit.

A page under `docs/getting-started/` is a tutorial for someone who
has never seen the product: steps in the imperative, one action per
sentence, each step ending with what the reader sees, every new
word defined or linked before it is used, and no parentheses, file
paths, or HTTP verbs. Depth lives on a concept page, reached by a
link.

A page under **Concepts** explains one concept. It opens with one
or two plain paragraphs on what it is and how it relates to the
concepts next to it, then **Why it exists** or **When you use it**,
**How it works** (the mental model, with a diagram where a flow is
easier seen than read), **In the app**, **Rules and limits** (a
short table), and **Reference** (complete and exact: fields, keys,
routes, storage, edge cases), in that order. A heading with nothing
to say is left out, and everything above **Reference** reads on its
own.

Every other page is reference, `docs/operations/` included:
complete and exact, in the same sentence style where it does not
cost precision.
