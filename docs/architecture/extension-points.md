# Extension points

Core is the whole product. One person runs it on their own machine
from one Compose file.

Custom code extends parts of the server and the operator app through
extension points. An extension supplies another implementation of a
core interface. Core ships a default for every point and runs with
no extension loaded.

The hosted service is one repository that does this. It supplies the
extensions it needs, including sign-in, billing, and sandboxes on
more than one host. Any repository can supply extensions the same
way. That service is proprietary and documented in its own
repository.

## Rules

1. **An extension depends on core, never the reverse.** No core
   module imports an extension's, reads its settings, queries its
   tables, or branches on the extension that is running.
2. **Core is the whole product.** Guilds, agents, runs, tools,
   connectors, coding agents, Studio, Builder, recipes, collections,
   and usage are core. An extension adds no agent feature.
3. **Core starts on Docker alone.** No cloud account, email
   provider, payment provider, or object store. Every instance key
   is optional: the operator sets the ones they want, each switches
   its feature on, and a feature without its key is off and says
   so. A run needs the organisation's own model key: core reads no
   instance key for a model provider.
4. **Core does not authenticate.** Whoever reaches the port is the
   operator. The stack listens on loopback. A box reached from
   elsewhere sits behind the operator's own proxy, and that proxy
   decides who gets through ([Remote
   access](../operations/remote-access.md)).
5. **Core runs every guild on one host.** The control plane and
   every organisation's machines run on the Docker host of the
   Compose stack. Core never assumes every machine shares one host:
   where a machine runs and where its directory lives come from the
   sandbox provider.
6. **Custom code attaches at an extension point.** When an extension
   needs something core lacks, core gains an extension point with a
   default of its own. Core gains no branch for that extension.
7. **The core repository is the source of truth.** Core changes
   land here. A repository that extends core adds its code over a
   pinned core revision and carries no patch to core.

## What an extension may replace

Each extension point is a core interface with a core default. An
extension supplies another implementation when it composes the
server or the operator app.

The server's composition root is `createServer` (`src/compose.ts`).
It takes a list of `ServerExtension` (`src/extension.ts`). The
extending repository has an entry point that loads its configuration
and hands its extensions to `runServer` (`src/run.ts`). Core's
`src/server.ts` passes none.

A factory on `ServerExtension` (`policy`, `modelCredentials`,
`instanceAdmin`, `sandboxes`, `identity`) runs once at boot and
receives the database connection as `db`, a `Queryable`
(`db/pg.js`). The extension reads and writes core's tables through
the `db/` modules the package exports (`db/orgs.js`, `db/users.js`,
`db/connectors.js`, `db/mcp.js`, `db/usage.js`). Each function
takes that connection, or the client of a transaction the extension
has open, as its first argument; a function whose writes commit
together runs them in a savepoint of that transaction.

`loadConfig` (`src/config/index.ts`) takes the `AUTH_MODE` values
an extension identifies requests in, beside core's `compat-cookie`
and `trusted-header`. Paths below are under
`apps/orchestrator/src/` unless they say `apps/web`.

| Extension point | Interface | Supplied by | Core's default |
|---|---|---|---|
| Identity | `IdentityProvider` (`http/identity.ts`) | `ServerExtension.identity` | `compat-cookie` or `trusted-header` |
| Organisation policy | `OrgPolicy` (`policy/index.ts`) | `ServerExtension.policy` | `OPEN_POLICY`: no cap |
| Model credentials | `ModelCredentialsProvider` (`llm/credentials.ts`) | `ServerExtension.modelCredentials` | The organisation's own row under Settings → Model keys |
| Organisation created | `OrgCreatedHook` (`db/orgs.ts`) | `ServerExtension.orgCreated` | Nothing |
| Sandbox provider | `SandboxProvider` (`extension.ts`) | `ServerExtension.sandboxes` | One `RunSandboxes` (`sandbox/`) |
| Blob store | `BlobStore` (`lib/blob-store.ts`) | `ServerExtension.blobStore` | `FileBlobStore` under `ATTACHMENTS_ROOT` |
| Instance admin | `InstanceAdmin` (`http/instance-admin.ts`) | `ServerExtension.instanceAdmin` | An owner of the seed organisation `org_home` |
| Instance integrations | `Integration[]` (`instance/integrations.ts`) | `ServerExtension.integrations` | Core's registry ([Instance keys](#instance-keys)) |
| Connectors | `ConnectorEntry[]` (`connectors/registry.ts`) | `ServerExtension.connectors` | Core's folders under `src/connectors/` |
| Database | `migrate(pool)`, `seed(pool)` | `ServerExtension.migrate`, `.seed` | Core's chain and seeds ([Data](#data)) |
| Routes | `routes(app, deps)` | `ServerExtension.routes` | Core's routes |
| Operator app slots | `AppSlots` (`apps/web/src/app/slots.ts`) | `mount(slots)` (`apps/web/src/mount.tsx`) | None filled ([Web app](web-app.md#extension-slots)) |
| Operator app build | the build directory | `ServerExtension.webApp` | `apps/web/dist` |

### What each point takes

- **Identity.** `currentUser(request)` returns the request's user or
  a 401. An optional `onSend` renews a credential as each response
  is sent. An optional `describe()` adds what its sign-in page needs
  to `GET /api/auth/config`. Core's modes read the `X-Guilds-User`
  header or `guilds_user` cookie (`compat-cookie`), or the proxy's
  email header (`trusted-header`). A mode core does not implement,
  with no provider for it, signs no one in. `GET /api/auth/config`
  and `GET /api/auth/me` are core's (`http/me-routes.ts`).
- **Organisation policy.** `standing(orgId)` returns the
  organisation's `OrgLimits` and whether it is blocked. The limits
  are the agent, browser-agent, coding-agent, guild, machine
  (`maxMachines`), agents-per-machine (`maxAgentsPerMachine`, never
  above core's 32), and concurrent-run caps; the monthly Studio and
  Builder quota and their generation budgets; the organisation's own
  MCP servers; and monthly calls on a connector's platform login by
  slug. `OPEN_POLICY` caps nothing, and every organisation runs
  under the instance's own ceiling (`MAX_CONCURRENT_GENERATIONS`).
  Core checks every cap against the policy it is given. A refusal
  names the limits' `source` (`<source> limit reached: agents`).
- **Model credentials.** `modelCredentials(orgId, provider)` returns
  the `apiKey`, an optional `baseURL`, and an optional `onUsage`
  callback core calls once per completion with the run id, model,
  token usage, and cost. It returns null while the provider is not
  connected. It may throw a `PolicyError`, which core shows and does
  not start the run on. A provider whose credentials resolve while
  the organisation's row holds no key is shown as provided by the
  platform (`source: "platform"`). Core's default decrypts the
  organisation's row and has no callback. Who pays, whether a budget exists, and
  what the callback does are the implementation's
  ([Orchestrator](orchestrator.md#credentials)).
- **Organisation created.** The hook runs inside the transaction that
  creates an organisation. Hooks from several extensions run in
  order. `insertOrg` and `insertUser` (`db/orgs.ts`, `db/users.ts`)
  run the hook they are passed. The routes pass `AppDeps.orgCreated`,
  which is the extensions' hooks unless the caller of `buildApp`
  gives its own.
- **Sandbox provider.** `GenerationSandboxes`
  (`generation/index.ts`), keyed by machine: `ensure(machine)`,
  `connectRunning`, `destroy`, `listRunningMachineIds`, and an
  optional `harnessesOf(machineId)` (the harness CLIs the machine's
  container carries). On an agent's seat (agent id, machine id, slot,
  browser language): `startBrowser`, `stopBrowser`, `stopAgent`,
  `novncTarget`, `startCli`, and `cliTarget`. An optional
  `machineHost(machineId)` gives the host, workspace root, and proxy
  URL a machine runs with. `SandboxProvider` adds `start`, `close`,
  and an optional `destroyAgentSandboxes` the boot layout step calls.
  Core's `RunSandboxes` runs on `OPENSANDBOX_URL` and
  `WORKSPACE_ROOT`, every machine on this host. Moving an agent
  between machines whose workspace roots differ is refused.
- **Blob store.** `ATTACHMENTS_ROOT` is `STATE_ROOT/attachments` on
  the Compose stack. Without it, core uses `MemoryBlobStore`, which
  the tests use.
- **Instance integrations.** Each declares its `source` (`store` or
  `env`) and its `fields`. An extension's are listed with core's in
  `GET /api/instance`, and its store integrations are written through
  the same admin routes.
- **Connectors.** Each is built from a connector folder with
  `folderEntry(manifest, adapter, folder, { publisher })`. An
  extension's are installed after core's, before the seed runs, and are
  listed and seeded like core's. A slug core already has fails boot.
- **Database.** An extension's migrations and seeds run after core's,
  on every boot.
- **Routes.** An extension's routes are registered on the Fastify app
  before core's.
- **Operator app slots.** Core's entry passes none: the app is whole
  without a slot. The app reads `GET /api/instance` for the
  integrations.

## How an extending repository holds core

A repository that extends core holds this repository as a git
submodule pinned to a commit. Beside it sit its own server package,
its own operator app, its Compose overlays, and its deployment
files. It passes its extensions when it composes the server and the
operator app.

- **Workspace.** Its pnpm workspace spans core's packages
  (`core/apps/*`, `core/packages/*`) and its own, under a lockfile
  of its own. Its packages list core's as dependencies and import
  only what those packages export.
  `apps/orchestrator/package.json` lists under `exports` the
  modules another package may import: the composition root and
  process runner, the extension interfaces, and the domain modules
  and test helpers an extension builds on. A module left off the
  list does not resolve from outside. `apps/web/package.json`
  exports `mount`, the slots, the build recipe (`appConfig()` in
  `vite.app.ts`), and the API client, identity, formatting, and
  role helpers an extension's screens use.
- **Boundary lint.** `eslint.boundary.js` is a lint rule a core
  package loads from its `eslint.config.js` with the packages it
  may not import and the repository its relative imports must stay
  inside. It fails any orchestrator or web file, tests and scripts
  included, that imports one of those packages or a relative path
  that leaves core's repository. No file is excepted. Core's
  repository holds nothing of an extension and passes its own check
  alone.
- **Images.** Core's image (`apps/orchestrator/Dockerfile`) holds
  no extension code, starts core's entry point, and serves core's
  build of the operator app. Its `CORE` build argument is where
  core sits in the build context and under `/app`. The extending
  repository builds that Dockerfile from its own root with
  `CORE=<its core directory>`, so the install comes from its
  lockfile. Its own Dockerfile adds its server package and its
  app's build to the result, started from its entry point.
- **Compose.** Its Compose files are overlays on core's
  `docker-compose.yml`. Relative paths in the merged files resolve
  from core's directory.
- **Makefile.** Core's `Makefile` runs in whichever root includes
  it. `CORE` is core's path under that root (`.` in core's
  repository). The extending repository's Makefile sets `CORE`,
  its development stack (`DEV_STACK`, `COMPOSE_DEV`, `DEV_BASE_IMAGE`,
  `WEB_PACKAGE`, `SEED_USER`, `SEED_ORG_SLUG`,
  `EXTENSION_TEST_PACKAGES`, `EXTENSION_COMPOSE_FILES`), and
  `SECRET_GOALS`, the goals that start a box with real secrets and
  therefore get no development default. It then includes core's
  and adds its own targets. In that repository `make up` and
  `make dev` start its stack. `make -C <core directory> up` starts
  core alone.
- **Check.** `scripts/check.sh` checks that repository when
  `CHECK_ROOT` names its root. The checkout, the install, and
  every step happen there, with core and any other submodule at
  the commit it pins. Its `check.steps` adds steps, one per line: the
  lane it joins (`orchestrator` or `web`), a name, and the command
  ([Development](../contributing/development.md)).

## Instance keys

An instance key is a credential the box holds for everyone on it,
as opposed to an organisation's model key, secret, or connection.
No instance key serves a model provider: the organisation's own key
does ([Orchestrator](orchestrator.md#credentials)).
Each belongs to an integration. An integration declares its fields
(`name`, `label`, `secret`, `optional`, `multiline`, `placeholder`)
and its `source`, `store` or `env`. It is `on` when every required
field has a value, `incomplete` when some do, and `off` when none
does; an optional field tunes it and never switches it off.

- Core requires none and starts with none.
- A `store` integration's values are entered by a platform admin on
  Admin's Platform keys tab, through
  `PUT /api/admin/instance/keys/:integration`, and removed with
  `DELETE` on the same path (`http/admin-instance-routes.ts`; anyone
  but an instance admin gets 404). The store (`instance/keys.ts`)
  keeps one row per integration in `instance_keys`, encrypted with
  AES-GCM under `SECRETS_MASTER_KEY`, with who wrote it and when.
  It is decrypted into a process snapshot at boot and again after
  every write, and a reader resolves a field from that snapshot at
  call time, so a change takes effect without a restart. A write's
  effects (`instance/changes.ts`) sync the platform logins, and a
  GitHub App replaced by one with another App ID, or removed,
  disconnects every GitHub login installed with it, after the admin
  confirms with the count. No route returns a value.
- An `env` integration's values are read from the orchestrator's
  environment at start. The operator writes them in `.env`
  ([Configure](../operations/configure.md)). The Compose files
  name no instance key; `.env` reaches the container through
  `env_file`, so a variable set in the shell alone does not.
  Platform keys shows them read-only.
- One registry (`src/instance/integrations.ts`) names every
  integration, its source, its fields, and what it switches on.
  Modules ask the registry (`integrationValue`, `integrationValues`,
  `missingFields`, `integrationState`), not the environment or the
  table. An extension registers its own integrations through its
  extension, in the same shape: each declares its `source` and its
  `fields`, and a `store` one is written through the same routes.
- A connector may declare an integration of its own,
  `connector:<slug>`: a platform key (`auth.instance: { "own": true }`
  on a token connector; its fields are the login fields) or an OAuth
  client (`configured` with no provider; `client_id` and
  `client_secret`). `instance/connectors.ts` derives these from the
  platform connector rows at boot and after a connector is
  installed, updated, removed, reloaded, created, or patched, and
  `installedIntegrations()` lists core's, an extension's, then these.
  They are store integrations like the others, written through the
  same routes; a registry connector's row is deleted with it. The
  `{ integration, field }` form of `auth.instance`, the box's OAuth
  client (`oauth.provider`), and the GitHub App are for connectors
  the box ships, core or an extension: a connector installed at
  runtime may not name them
  ([Registry](../tools-and-connectors/connector-registry.md)).
- The instance descriptor (`GET /api/instance`, any signed-in
  user) reports each integration's `source`, its state, which
  fields are set (for an env field, whether the variable itself is
  set; a default does not count), never a value, its setup flow
  when it has one, and what it switches on: native tools and
  connector slugs. An instance admin also sees when and by whom a
  store integration was written. The operator app turns off what
  depends on a missing integration, names it, and offers a platform
  admin the way to Platform keys. Admin's Platform keys tab lists
  every integration with its state and takes a store integration's
  values.
- An instance key is the instance's own. A connector's platform
  login on one counts each organisation's calls a month, and
  `OrgLimits.monthlyConnectorCalls` caps them; core's open policy
  caps none.

| Integration | Source | Fields | Switches on | Without it |
|---|---|---|---|---|
| Web search | store | `api_key` | The Tavily connector's platform login, `tavily_search` | The platform login is disconnected and runs leave `tavily_search` out; an organisation may connect a Tavily key of its own |
| Group routing | store | `api_key`, and `model` to tune it | Recipient and history selection in group chat | Tag rules and the last 10 messages |
| GitHub App | store | `app_id`, `slug`, `private_key`, `client_id`, `client_secret`, entered by hand or filled by the manifest flow ([GitHub](../tools-and-connectors/github.md#step-1-create-the-app)) | The GitHub connector and a guild's repositories | Tools marks the connector **Not set up**, names the missing fields, and disables Connect; a Connect sent anyway answers 422 |
| Google connectors | store | `client_id`, `client_secret` | The Gmail and Drive connectors ([Gmail and Drive](../tools-and-connectors/google.md)) | As for the GitHub App |
| Error reporting | env | `SENTRY_DSN` | Sentry | Structured logs only |
| Registry | env | `REGISTRY_URL`, the guilds.run registry while unset; `REGISTRY_PUBLIC_KEY` | Installing connectors and recipes from a registry; with the key, only from a signed index | Set empty, the box is offline |
| Connector code | env | `CONNECTORS_CODE_TIER=1`, `CONNECTORS_ROOT` | Registry connectors with adapter code, loaded at boot | A code install is refused and code on disk is not loaded |

`SECRETS_MASTER_KEY`, the PostgreSQL password, and the OpenSandbox
key are not integrations. The box cannot run without them.
`./setup.sh` generates them. `.env.example` lists the environment
integrations' variables by hand and no store integration's. Code
and the other pages call instance keys platform keys.

## Data

Core's tables are in schema `public`. Its migration chain starts at
`0001_baseline` in `apps/orchestrator/drizzle/`, a snapshot of its
tables, recorded in `public.__drizzle_migrations`
([Orchestrator](orchestrator.md#postgresql)).

An extension keeps its tables in a schema of its own. The two never
share a name. A core box has no such schema. Its migration chain
starts at a baseline of its own, recorded in that schema, and is
applied by its extension's `migrate` after core's.

An extension's table may reference a core table. No core table
references an extension's. An extension's SQL that reads core's
tables, and a seed that writes rows in them, follows a change to
those tables' columns.

A database applies a migration only when its stamp is later than
the last one it recorded. Every migration is stamped after the one
before it and before the build that ships it.

## Names

The product is guilds.run. Cigale AI is the company that makes and
operates it.

Identifiers carry the product's name:

- the `@guildsrun/*` packages
- the Compose project `guilds`
- the `guilds-*` runtime helpers and `GUILDS_*` sandbox variables
- the `guilds_*` cookies and `X-Guilds-*` headers
- the `guilds.recipe` format

"Cigale" names the company or its data product and nothing else.
The Cigale connector in the catalog is the one place it appears in
core.

## Licence

Core is free software under the GNU Affero General Public License,
version 3 only, copyright Cigale AI (`LICENSE`). Every core
package declares `AGPL-3.0-only`.

Custom code plugs into core by importing it. Under the licence
anyone who offers that extended software publishes it. The copyright
holder does not have to. That holds only while Cigale AI owns or
can relicense everything in core, and no contributor agreement is
in place.

`THIRD_PARTY_NOTICES.md` lists what a build ships that others
wrote.
