# Extension points

Core is the whole product. One person runs it on their own machine
from one Compose file.

An **edition** is a layer built on top of core. It adds what core
does not have: a way to sign people in, a way to charge them, more
than one machine to run sandboxes on. Core does not know an edition
exists.

One edition exists today: the hosted service Cigale AI runs with
core underneath it. That service is proprietary and documented in
its own repository.

## Rules

1. **An edition depends on core, never the reverse.** No core
   module imports an edition's, reads its settings, queries its
   tables, or branches on the edition that is running.
2. **Core is the whole product.** Guilds, agents, runs, tools,
   connectors, coding agents, Studio, Builder, recipes, databases,
   and usage are core. An edition adds no agent feature.
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
   access](../getting-started/remote-access.md)).
5. **Core runs every guild on one machine.** The control plane and
   every agent sandbox run on the Docker host of the Compose stack.
6. **An edition attaches through extension points.** When an
   edition needs something core lacks, core gains an extension
   point with a default of its own. It does not gain a branch for
   that edition.
7. **The core repository is the source of truth.** Core changes
   land here. An edition's repository adds its layer over a pinned
   core revision and carries no patch to core.

## What an edition may replace

Each extension point is a core interface with a core default. An
edition supplies another implementation when it composes the
server or the operator app.

The server's composition root is `createServer` (`src/compose.ts`).
It takes a list of `ServerExtension` (`src/extension.ts`). Each
edition has an entry point that loads its configuration and hands
its extensions to `runServer` (`src/run.ts`). Core's
`src/server.ts` passes none.

`loadConfig` (`src/config/index.ts`) takes the `AUTH_MODE` values
an edition identifies requests in, beside core's `compat-cookie`
and `trusted-header`. Paths below are under
`apps/orchestrator/src/` unless they say `apps/web`.

| Extension point | Interface | Core's default |
|---|---|---|
| Identity | `IdentityProvider` (`http/identity.ts`): `currentUser(request)`, an optional `onSend` for a provider that renews a credential, and `describe()` for what its sign-in page needs; supplied by `ServerExtension.identity` | The request's user from the `X-Guilds-User` header or `guilds_user` cookie (`compat-cookie`), or from the proxy's email header (`trusted-header`). A mode core does not implement, with no provider for it, signs no one in. `GET /api/auth/config` and `GET /api/auth/me` are core's (`http/me-routes.ts`); a provider's `describe()` adds to the first |
| Organisation policy | `OrgPolicy` (`policy/index.ts`): `standing(orgId)` returns the organisation's `OrgLimits` (agent, browser-agent, coding-agent, guild, and concurrent-run caps, the monthly Studio and Builder quota, and their generation budgets, the organisation's own MCP servers, and monthly calls on a connector's platform login by slug) and whether it is blocked; supplied by `ServerExtension.policy` | `OPEN_POLICY`: no cap, and every organisation may run, under the instance's own ceiling (`MAX_CONCURRENT_GENERATIONS`). Core checks every cap against the policy it is given, and a refusal names the limits' `source` (`<source> limit reached: agents`) |
| Model credentials | `ModelCredentialsProvider` (`llm/credentials.ts`): `modelCredentials(orgId, provider)` returns the `apiKey`, an optional `baseURL`, and an optional `onUsage` callback core calls once per completion with the run id, model, token usage, and cost; null while the provider is not connected; may throw a `PolicyError`, which core shows and does not start the run on; supplied by `ServerExtension.modelCredentials` | The organisation's own row under Settings → Model keys, decrypted, with no callback. Who pays, whether a budget exists, and what the callback does are the implementation's; core keeps no spend gate ([Orchestrator](orchestrator.md#credentials)) |
| Organisation created | `OrgCreatedHook` (`db/repositories.ts`), run inside the transaction that creates an organisation; supplied by `ServerExtension.orgCreated` | Nothing. Hooks from several extensions run in order, and a hook passed for one creation replaces them |
| Sandbox provider | `SandboxProvider` (`extension.ts`): the sandboxes generation drives, with `start` and `close`; supplied by `ServerExtension.sandboxes` | One `RunSandboxes` (`sandbox/`) on `OPENSANDBOX_URL` and `WORKSPACE_ROOT` |
| Blob store | `BlobStore` (`attachments/`); supplied by `ServerExtension.blobStore` | `FileBlobStore` under `ATTACHMENTS_ROOT`, which is `STATE_ROOT/attachments` on the Compose stack; `MemoryBlobStore` without one, which the tests use |
| Instance admin | `InstanceAdmin` (`http/instance-admin.ts`): who administers the instance; supplied by `ServerExtension.instanceAdmin` | An owner of the seed organisation `org_home` |
| Instance integrations | `Integration[]` (`instance/integrations.ts`); `ServerExtension.integrations` | The registry below; an edition's are listed with core's in `GET /api/instance` |
| Connectors | `ConnectorEntry[]` (`connectors/registry.ts`), each built from a connector folder with `folderEntry(manifest, adapter, folder, { publisher })`; `ServerExtension.connectors` | Core's folders under `src/connectors/`. An edition's are installed after core's before the seed runs, listed and seeded like core's, and a slug core already has fails boot |
| Database | `ServerExtension.migrate(pool)` and `seed(pool)` | Core's chain and seeds; an extension's run after them, on every boot |
| Routes | `ServerExtension.routes(app, deps)` | Registered on the Fastify app before core's routes |
| Operator app slots | `AppSlots` (`apps/web/src/app/slots.ts`): `publicPage` (a page for a path the edition owns, shown before anyone is identified), `signInPath`, `signOut`, `settingsTabs`, `adminTabs` (each tab with the core tab it follows), `shellBanners` (notices above every page), `membersPanel` (under the member list); passed to `mount(slots)` (`apps/web/src/mount.tsx`) | None filled: the app is whole without a slot. Core's entry passes none. The app reads `GET /api/instance` for the integrations |
| Operator app build | `ServerExtension.webApp`, the directory of the build the server serves | `apps/web/dist` |

## How an edition's repository holds core

An edition is a repository of its own. It holds core's repository
as a git submodule pinned to a commit. Beside it sit its own
server package, its own operator app, its Compose overlays, and
its deployment files.

- **Workspace.** The edition's pnpm workspace spans core's
  packages (`core/apps/*`, `core/packages/*`) and its own, under a
  lockfile of its own. Its packages list core's as dependencies
  and import only what those packages export.
  `apps/orchestrator/package.json` lists under `exports` the
  modules another package may import: the composition root and
  process runner, the extension interfaces, and the domain modules
  and test helpers an edition builds on. A module left off the
  list does not resolve from outside. `apps/web/package.json`
  exports `mount`, the slots, the build recipe (`appConfig()` in
  `vite.app.ts`), and the API client, identity, formatting, and
  role helpers an edition's screens use.
- **Boundary lint.** `eslint.boundary.js` is a lint rule a core
  package loads from its `eslint.config.js` with the packages it
  may not import and the repository its relative imports must stay
  inside. It fails any orchestrator or web file, tests and scripts
  included, that imports one of those packages or a relative path
  that leaves core's repository. No file is excepted. Core's
  repository holds nothing of an edition and passes its own check
  alone.
- **Images.** Core's image (`apps/orchestrator/Dockerfile`) holds
  no edition code, starts core's entry point, and serves core's
  build of the operator app. Its `CORE` build argument is where
  core sits in the build context and under `/app`. An edition
  builds that Dockerfile from its own root with
  `CORE=<its core directory>`, so the install comes from the
  edition's lockfile. Its own Dockerfile adds its server package
  and its app's build to the result, started from its entry point.
- **Compose.** An edition's Compose files are overlays on core's
  `docker-compose.yml`. Relative paths in the merged files resolve
  from core's directory.
- **Makefile.** Core's `Makefile` runs in whichever root includes
  it. `CORE` is core's path under that root (`.` in core's
  repository). An edition's Makefile sets `CORE`, `EDITION`, its
  development stack (`COMPOSE_DEV`, `DEV_BASE_IMAGE`,
  `WEB_PACKAGE`, `SEED_USER`, `SEED_ORG_SLUG`,
  `EDITION_TEST_PACKAGES`, `EDITION_COMPOSE_FILES`), and
  `SECRET_GOALS`, the goals that start a box with real secrets and
  therefore get no development default. It then includes core's
  and adds its own targets. In the edition's repository `make up`
  and `make dev` start the edition's stack. `make -C <core
  directory> up` starts core alone.
- **Check.** `scripts/check.sh` checks an edition when
  `EDITION_ROOT` names its root. The checkout, the install, and
  every step happen there, with core at the commit the edition
  pins. The edition's `check.steps` adds steps, one per line: the
  lane it joins (`orchestrator` or `web`), a name, and the command
  ([Development](../contributing/development.md)).

## Instance keys

An instance key is a credential the box holds for everyone on it,
as opposed to an organisation's model key, secret, or connection.
No instance key serves a model provider: the organisation's own key
does ([Orchestrator](orchestrator.md#credentials)).
Each belongs to an integration. An integration is on when all of
its variables are set.

- Core requires none and starts with none.
- A key reaches the server through its environment, and by no
  other way. The operator app shows an integration's state and
  takes no key. The operator writes it in `.env`
  ([Configure](../getting-started/configure.md)). The Compose files
  name no instance key. A key reaches the container from `.env`
  through `env_file`, so one set in the shell alone does not.
- One registry (`src/instance/integrations.ts`) names every
  integration, its variables, and what it switches on. Modules ask
  the registry, not the environment. An edition registers its own
  integrations through its extension.
- The instance descriptor (`GET /api/instance`, any signed-in
  user) reports each integration's state (`on`, `off`, or
  `incomplete` when some of its required variables are set), which
  variables are set, never a value, and what it switches on: model
  native tools and connector slugs. The operator app
  turns off what depends on a missing integration and names the
  variables that would switch it on. Admin's Platform keys tab
  lists every integration with its state.
- An instance key is the instance's own. A connector's platform
  login on one counts each organisation's calls a month, and
  `OrgLimits.monthlyConnectorCalls` caps them; core's open policy
  caps none.

| Integration | Variables | Switches on | Without it |
|---|---|---|---|
| Web search | `TAVILY_API_KEY` | The Tavily connector's platform login, `tavily_search` | The platform login is disconnected and runs leave `tavily_search` out; an organisation may connect a Tavily key of its own |
| Group routing | `TYPESAFE_API_KEY`, and `TYPESAFE_MODEL` to tune it | Recipient and history selection in group chat | Tag rules and the last 10 messages |
| GitHub App | `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | The GitHub connector and a guild's repositories | Tools marks the connector **Not set up**, names the missing variables, and disables Connect; a Connect sent anyway answers 422 |
| Google connectors | `GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET` | The Gmail and Drive connectors | As for the GitHub App |
| Error reporting | `SENTRY_DSN` | Sentry | Structured logs only |
| Registry | `REGISTRY_URL`, the guilds.run registry while unset; `REGISTRY_PUBLIC_KEY` | Installing connectors and recipes from a registry; with the key, only from a signed index | Set empty, the box is offline |
| Connector code | `CONNECTORS_CODE_TIER=1`, `CONNECTORS_ROOT` | Registry connectors with adapter code, loaded at boot | A code install is refused and code on disk is not loaded |

`SECRETS_MASTER_KEY`, the PostgreSQL password, and the OpenSandbox
key are not integrations. The box cannot run without them.
`./setup.sh` generates them. The variables are listed by hand in
`.env.example`. Code and the other pages call instance keys
platform keys.

## Data

Core's tables are in schema `public`. Its migration chain starts at
`0001_baseline` in `apps/orchestrator/drizzle/`, a snapshot of its
tables, recorded in `public.__drizzle_migrations`
([Orchestrator](orchestrator.md#postgresql)).

An edition keeps its tables in a schema of its own. The two never
share a name. A core box has no such schema. Its migration chain
starts at a baseline of its own, recorded in that schema, and is
applied by its extension's `migrate` after core's.

An edition's table may reference a core table. No core table
references an edition's. An edition's SQL that reads core's
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

A layer plugs into core by importing it. Under the licence anyone
who offers an edition on top of core publishes it. The copyright
holder does not have to. That holds only while Cigale AI owns or
can relicense everything in core, and no contributor agreement is
in place.

`THIRD_PARTY_NOTICES.md` lists what a build ships that others
wrote.
