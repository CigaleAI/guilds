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
| `make opensandbox-image` | `scripts/images.sh opensandbox`: builds `guilds-opensandbox-server` from the pinned commit, once, tagged with the commit's first 8 characters |
| `make runtime-image` | `scripts/images.sh runtime`: builds `agent-runtime:0.4` from `runtime/`, every time, from Docker's cache |
| `make core-image` | Builds `guilds-orchestrator:local` from `apps/orchestrator/Dockerfile` |
| `make build` | `state`, both images, then builds the development stack's images |
| `make up`, `make up-dev` | `state`, both images, then the development stack, built, detached, and healthy |
| `make dev` | `make up-dev`, then the Vite server |
| `make down` | Stops every service of the product stack and an extension's Compose files |
| `make reset` | `make down`, removes the local state trees, `make up` ([Resetting](#resetting)) |
| `make migrate` | Gives each recorded migration its committed stamp, applies the migrations it was hiding, and restarts the orchestrator. The data stays ([Schema changes](#schema-changes)) |
| `make verify` | Against a running stack: health, the guild list as the seed user, the app page, typecheck, lint, the orchestrator tests, an extension's test packages, the fixture digests |
| `make soak` | Against a running stack: health, the guild list, and the OAuth callback page. It then creates and deletes a guild, restarts the orchestrator, and reads the migration, seed, binding, and run tables |
| `make check` | `scripts/check.sh`: what CI runs ([Check](#check)) |
| `make compat-verify` | The fixture digests alone |
| `make preview` | `scripts/preview-stack.sh up`: this checkout as a preview behind a password, at a `trycloudflare.com` URL ([CI](#ci)) |
| `make preview-down` | `scripts/preview-stack.sh down`: removes that preview |

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
| `browse:spike` | Runs one browse task on an agent's Chrome through the CDP bridge and prints each step, the result, and its cost ([Browser](../concepts/browser.md)) |
| `cycles` | The import-cycle check; `cycles --write` rewrites its list ([Lint and format](#lint-and-format)) |
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
| orchestrator | `typecheck`, `suppressions`, `lint`, `lint-rules`, `import-cycles`, `compat-verify`, `test-orchestrator` |
| web | `test-ui`, `test-web`, `import-cycles-web`, `build-web`, `build-storybook` |
| core stack | `smoke-core-stack`: `./setup.sh` and `docker compose up` on a copy of the checkout, under its own Compose project, port, image tag, and state directory. It checks that the stack asks for `./setup.sh` first, that `.env` is private and unchanged by a second `./setup.sh`, and that the box is healthy, serves the app on loopback alone, holds one operator and no hosted table, creates a guild, and refuses a request from another web origin |

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
repository owner, for `linux/amd64` and `linux/arm64`. The
orchestrator and the runtime are tagged with the ref name and
`latest`:

| Image | Built from |
| --- | --- |
| `guilds-orchestrator` | `apps/orchestrator/Dockerfile` |
| `guilds-agent-runtime` | `runtime/`, with `BROWSER=chromium` and `HARNESSES=` empty: Chromium and Codex only |
| `guilds-opensandbox-server` | The pinned OpenSandbox commit, tagged with its first 8 characters only |

The release tag is the version in the
[changelog](../../CHANGELOG.md).

`.github/workflows/preview.yml` serves a pull request as a
preview. It runs for a pull request from this repository that
carries the `preview` label: when the label is added, and on every
push after. A push cancels the running preview and starts a new
one. A pull request from a fork never runs it. The job runs in the
`preview` environment, which holds the secrets `PREVIEW_PASSWORD`
and `PREVIEW_MODEL_KEY` and the variable `PREVIEW_MODEL`.

| | Preview |
| --- | --- |
| What it serves | The pull request's head commit, with the orchestrator built from it, at a random `trycloudflare.com` hostname, behind basic auth: the user `preview` and the password `PREVIEW_PASSWORD` |
| What it holds | The operator; the provider `PREVIEW_MODEL` names, connected with `PREVIEW_MODEL_KEY`, with that model chosen and made the organisation's default; a guild `preview` with an agent `preview` on that model, without a browser |
| Where the URL is | The pull request's deployment in the `preview` environment, shown as its View deployment button. The deployment carries the URL and no credential |
| Who holds the password | The `preview` environment, and whoever the maintainers give it to |
| When it ends | A review submitted after the deployment, the `preview` label removed, or forty-five minutes after the deployment. The job then tears the preview down and marks the deployment inactive, as it does when a step fails or the job is cancelled |
| Bounds | The model key's credit limit, the job's timeout of 75 minutes, and the same-repository rule |

`scripts/preview-stack.sh up` starts the preview, in CI and
locally (`make preview`), and prints one line: its URL. It runs a
copy of the checkout under its own Compose project, port, image tag
and state directory, all named by `PREVIEW_PORT` (18090 by
default). The state directory is `guilds-preview-<port>` under
`$TMPDIR`, or `/tmp` when it is unset. It adds
`docker-compose.preview.yml` to the product stack: Caddy, which asks
for the password and proxies to the orchestrator with the request's
`Host` header, and `cloudflared`, a quick tunnel to Caddy. Neither
publishes a port. The tunnel starts first, because the orchestrator
serves only loopback hosts and the host of `PUBLIC_BASE_URL`, which
is the tunnel's hostname. The script then starts the stack, seeds it
over loopback, and checks that the URL refuses a request without
the password and serves the operator app with it. The password is
written only as a bcrypt hash, and the key to no file. The agent
runtime image is pulled, `PREVIEW_RUNTIME_IMAGE`
(`ghcr.io/cigaleai/guilds-agent-runtime:latest` by default), not
built. A preview whose pull fails still starts, and no agent machine
starts in it. A provider that refuses the key leaves the preview
without the model and the agent. `scripts/preview-stack.sh down`
(`make preview-down`) removes the containers, the built image, and
the state directory.

## Tests

The orchestrator's tests run on Node's test runner through `tsx`
(`pnpm --filter @guildsrun/orchestrator test`), with
`MODELS_DEV_URL` set empty:

| Directory | Covers |
| --- | --- |
| `test/unit` | Domain logic without Docker; the generation tests drive `GenerationLoop` against the file-backed `NotesStore` and fakes |
| `test/integration` | HTTP and PostgreSQL: the recorded routes and SSE and WebSocket fixtures replayed against a database on `127.0.0.1:5432` (`R1_ADMIN_DATABASE_URL` names another) |
| `test/contract` | Live calls, each skipped until its variables are set (below) |
| `test/helpers` | The fixtures, fakes, and stubs the tests share. The package exports the environment, fixtures, HTTP, installed-connector, MCP database, OpenSandbox stub, and PostgreSQL helpers for an extension's tests |

| Contract test | Runs when |
| --- | --- |
| `opensandbox.test.ts` | `RUN_OPENSANDBOX_CONTRACT=1`. It builds the pinned OpenSandbox server image when it is missing |
| `coding.test.ts` | `RUN_OPENSANDBOX_CONTRACT=1`, and the runtime image exists: `CONTRACT_RUNTIME_IMAGE`, `agent-runtime:0.4` by default (`make runtime-image`) |
| `model.test.ts` | `RUN_MODEL_CONTRACT=1`, `MODEL_CONTRACT_MODEL` (a `{provider}/{model}` id), and `MODEL_CONTRACT_API_KEY`. `MODEL_CONTRACT_BASE_URL` points it at a local endpoint |
| `typesafe.test.ts` | `RUN_TYPESAFE_CONTRACT=1` or `RUN_MODEL_CONTRACT=1`, and `TYPESAFE_API_KEY` |
| `harness.test.ts` | `RUN_OPENSANDBOX_CONTRACT=1` and the runtime image, as for `coding.test.ts`. One live turn per harness whose credential is set: `CLAUDE_CODE_OAUTH_TOKEN`, `CURSOR_API_KEY`, or `CODEX_AUTH_JSON` (the path of a Codex `auth.json`) |

The operator app's and the design system's tests run on Node's
test runner too. They sit beside their modules as
`src/**/*.test.ts` (`pnpm test:web`, `pnpm test:ui`). They run
without a browser and test the functions a module exports:

- in `src/api/`, the client, the session, the live streams, and
  the guards that narrow what the server sends
- in `src/app/`, the shared helpers, such as formatting, names,
  display paths, the router, and the extension slots
- in each feature, its models, such as the run flow, tool kinds and
  formatting, Studio's location and chat, the activity ledger, and
  the recipe plan and apply steps
- in the design system, the content parsers: embeds, mentions,
  highlighting, and prompt blocks

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
`apps/orchestrator/drizzle/`. It is mirrored in `src/db/schema/`,
one file per table family, and recorded in
`drizzle/meta/_journal.json` with a stamp later than the migration
before it. Beside the table families, `recipe-document.ts` and
`apply-preview.ts` hold the shapes of two JSON columns, and
`columns.ts` the column types the tables share. `index.ts`
re-exports every file but `columns.ts`.

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

Every package runs Oxlint (`pnpm -r lint`, about a second for the
three packages) on its correctness rules. Unused names are allowed
when they start with `_`. The operator app and the design system
also run the React Hooks rules. A package's configuration is its
`.oxlintrc.json`; the rules of this repository are Oxlint plugins
under `lint/`, which every package's configuration loads.

Every package runs the boundary plugin (`lint/boundary.js`). It
fails any file that imports a package of an extension or a
relative path that leaves this repository. It also fails a module
that holds a re-export (`export * from`, `export { x } from`, or
`export { x }` and `export default x` of a name the module
imports), except an index a tool requires, which the package
names: the orchestrator's `src/db/schema/index.ts`, which
drizzle-kit reads.

Every package also runs the limits of the
[code guidelines](code-guidelines.md#functions) on its source,
tests and stories excepted: Oxlint's `complexity`, `max-depth`, an
error at five parameters, a warning past 800 lines and, from the
limits plugin (`lint/limits.js`), an error past 1,000, a refusal of
every type assertion except `as const`, and a refusal of a silent
catch: a `catch` that neither throws nor returns, a `catch` whose
only exit is a bare `return;`, and a promise's `.catch()` whose
handler returns nothing, `undefined` or `null`. It also refuses a
throw of a plain `Error`, an object type written inline in a
function's parameter, and an erased return type: `unknown` or
`Record<string, unknown>`, alone or as the element of an array or
the value of a promise, returned by an exported function, an
exported const's function, or a public method, or named by a type
alias. A package names its command-line modules, which may throw a
plain `Error`: the orchestrator's `cli/`. The operator app refuses
an import from `src/features/` in its shared directories,
`src/api/` and `src/app/`, except in `src/app/router.tsx`, the
composition root that mounts the features. The orchestrator also
requires explicit parameter and return types on what a module
exports (`typescript/explicit-module-boundary-types`). It refuses
an import of `fastify` outside `http/`, the roots, the extension
points and the observability hooks; a value import of `db/` from
`http/`; an import from `db/` of anything outside `db/` and `lib/`;
and an import from `lib/` of anything outside `lib/`. In the
orchestrator's tests, reading through an optional chain is the
assertion that the value is there, so `no-unsafe-optional-chaining`
is off for them.

Every package also runs, on the same source, the rules vendored from
anti-slop (`lint/anti-slop/`, [Third-party
notices](../../THIRD_PARTY_NOTICES.md)), which refuse a type or a
construct that carries no evidence
([Types and errors](code-guidelines.md#types-and-errors)):
`no-unknown-parameters` (a parameter typed `unknown`, or a union
holding it, except the subject of a type predicate and an error's
`cause`), `no-object-parameters` (a parameter typed `object`),
`no-unsafe-dictionary-type` (a dictionary whose value type is
`unknown`, `any`, `object` or `{}`, in any position but a generic
constraint), `no-runtime-typeof` (a `typeof` check that narrows a
value outside a type guard; a probe for `"undefined"` is allowed),
`no-known-value-widening` (a `Record<string, T>` annotation on a
value whose keys are known, where `satisfies` keeps them),
`no-reduce-accumulator-copy` with Oxlint's
`oxc/no-accumulating-spread` (a reducer that copies its
accumulator), and `no-module-mocking`, on tests too (a `vi.mock`
or `jest.mock`). The modules that parse what arrives from outside
take `unknown` and check it, so `no-unknown-parameters` and
`no-runtime-typeof` are off in a domain's `validation`, `validate`
and `parse` modules in the orchestrator and in `src/api/wire.ts`
in the operator app. The operator app and the design system also
run the React correctness rules, `jsx-key` among them.

`pnpm lint` runs Oxlint through `scripts/lint.mjs`, which subtracts
the errors that predate the rules, recorded in the package's
`lint-suppressions.json` as a count per file and rule. Lint fails
on an error that is not in the file, and on an entry that no
longer matches an error, so the list only shrinks; after a fix,
`pnpm --filter <package> lint --write` rewrites the file from the
errors that remain. Warnings do not fail lint.

Prettier formats with semicolons, double quotes, trailing
commas, and a width of 100 (`pnpm --filter <package> format`).

The import graphs of the orchestrator and the operator app gain no
cycle: `pnpm --filter <package> cycles`, the `import-cycles` and
`import-cycles-web` steps of the check, fails when a file or a
domain sits in a cycle of value imports and the package's
`import-cycles.json` does not list it. A domain is a directory under
`src/`, and in the operator app each directory under `src/features/`
is a domain of its own. Tests and stories are not scanned. The
file's `compositionRoots` names the package's
[composition roots](code-guidelines.md#locality): their own imports
are left out of the graph, and an import of one is still an edge.
`cycles --write` rewrites the cycles from the tree as it is and
keeps `compositionRoots`; like `lint-suppressions.json`, the
cycles only shrink.

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
