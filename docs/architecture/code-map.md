# Code map

Where code lives and what each directory is for. Each row links to
the page that explains it.

```mermaid
flowchart LR
  Browser["Browser"] -->|HTTP / SSE / WS| Ingress["loopback, or the operator's proxy"]
  Ingress --> Orch["orchestrator<br/>Fastify + GenerationLoop"]
  Orch --> PG[(PostgreSQL)]
  Orch --> Place["sandbox provider"]
  Place --> OS[OpenSandbox]
  Orch --> LLM[model providers<br/>on the organisation's keys]
  OS --> Docker["one agent-runtime container per machine<br/>Chromium + coding, sized by tier, shared by its agents"]
```

## Repository

| Path | What it is |
| --- | --- |
| `apps/orchestrator/` | The Node control plane ([Orchestrator](orchestrator.md)) |
| `apps/web/` | The React operator app, served at the site root ([Web app](web-app.md)) |
| `packages/ui/` | `@guildsrun/ui`, the design system ([Design system](design-system.md)) |
| `runtime/` | The `agent-runtime:0.4` image every machine runs, and the helpers baked into it |
| `fixtures/compat/` | Frozen HTTP, SSE, schema, crypto, and adapter contracts |
| `docs/` | This documentation |
| `docker-compose.yml`, `docker-compose.watch.yml`, `docker-compose.dev.yml` | The shipped stack, the development overlay, and the two merged ([Deployment](deployment.md#compose-stacks-and-images)) |
| `setup.sh` | Writes `.env` (state path and generated secrets) and builds the OpenSandbox and runtime images |
| `.env.example` | Core's settings, by integration ([Configure](../operations/configure.md)) |
| `scripts/` | `check.sh` (the whole check; with `CHECK_ROOT` it checks an extending repository), `images.sh` (the OpenSandbox and runtime images), `smoke-core-stack.sh` (the shipped stack, end to end) ([Development](../contributing/development.md)) |
| `Makefile` | `state`, `opensandbox-image`, `runtime-image`, `core-image`, `build`, `up`, `dev`, `down`, `reset`, `migrate`, `verify`, `check`, `contract`, `compat-verify`, `soak`; an extending repository's Makefile includes it, with `CORE` naming core's path |
| `eslint.boundary.js` | The lint rules holding core code inside core ([Extension points](extension-points.md#how-an-extending-repository-holds-core)) and refusing a module that re-exports another module's exports ([Lint](../contributing/development.md#lint-and-format)) |
| `.github/workflows/` | `verify` (every push: `scripts/check.sh`), `images` (a version tag publishes the orchestrator, runtime, and OpenSandbox server images on ghcr.io) |
| `.state/` | The local `STATE_ROOT`, not in git ([Deployment](deployment.md#state-on-disk)) |

A repository that extends core holds this one as a submodule
([Extension points](extension-points.md)).

## `apps/orchestrator/`

| Path | What it is |
| --- | --- |
| `src/server.ts` | Core's process entry: loads config and runs the server with no extension |
| `src/instrument.ts` | Loaded with `--import` before the server: starts Sentry and its event-loop, profiling, and Fastify integrations |
| `src/error-reporting.ts` | `startErrorReporting`: starts Sentry from the `error-reporting` integration; the server and each command-line tool call it first |
| `src/run.ts` | `runServer`: builds the server, listens, shuts down on a signal or a fatal error |
| `src/compose.ts` | `createServer`, the composition root ([Startup](orchestrator.md#startup-and-shutdown)) |
| `src/extension.ts` | `ServerExtension`, what an extension adds ([Extension points](extension-points.md)) |
| `src/app.ts` | The Fastify app: the web build, `/storybook`, `/health`, `/avatars/:style.svg`, client-error intake, domain routes |
| `drizzle/` | `0001_baseline` (with `0001.notes.md`), then numbered migrations ([PostgreSQL](orchestrator.md#postgresql)) |
| `test/` | `unit/`, `integration/`, `contract/`, `helpers/` ([Tests](orchestrator.md#tests)) |
| `scripts/` | `compat-verify`, `compat-digest`, `dump-baseline-schema`, `patch-http-mcp-catalog`, `build-connector`, `models-dev-snapshot`, `sweep-workspaces`, `typesafe-replay` |
| `Dockerfile` | The core image: a `web` stage builds `apps/web` and Storybook; the final stage copies `src`, `scripts`, `drizzle`, and the web build |
| `package.json` | `exports`: the modules another package may import |

### `src/` directories

| Directory | What it holds |
| --- | --- |
| `http/` | One `*-routes.ts` file per domain, registered in `routes.ts`; the `AUTH_MODE` seam (`identity.ts`), the host and origin check (`origin.ts`), the mapping of domain errors to HTTP (`errors.ts`), SSE, the sandbox proxies (`sandbox-proxy.ts`), and the web build (`web-app.ts`) |
| `generation/` | `GenerationLoop`, a run's config snapshot and the prepared run it is created from (`snapshot.ts`), the tools a generation offers (`offered-tools.ts`), the tool calls of a run, run in order and resolved when a generation stops without their results (`tool-calls.ts`), its named errors (`errors.ts`), a run's event stream (`events.ts`), the machines' containers with their idle stops and each agent's Chrome and terminal (`machines.ts`), the preparation of a run's prompts and State (`prepare.ts`), the model calls with their history projection and cancel (`completion.ts`), the steps of a coding run and the diffs, logs, and harness checks read outside one (`coding.ts`), a coding agent's harness view and a run's changes as an operator reviews them (`run-review.ts`), the disk limits of an agent's home and its machine (`workspace.ts`), the secrets of the runs under way and the values their output is redacted with (`run-secrets.ts`), the creation of direct, group, schedule, and continuation runs and the scheduler (`runs.ts`), a generation from its setup through its model steps to its end (`generate.ts`), run chains and their hand-off (`chain.ts`), the generations in progress (`active-generations.ts`), idle stops (`idle.ts`), and the runs an operator opens and talks to (`operator.ts`) ([Generation](orchestrator.md#generation)) |
| `toolbox/` | Native tools, the sandbox command runner (`shell.ts`), and the result pipeline (`output.ts`) ([Native tools](../tools-and-connectors/native.md)) |
| `connectors/` | One folder per connector, the manifest schema, the adapter contract, the connector registry, the servers configured from them and the tools each offers (`servers.ts`), the naming of their tools (`naming.ts`), the platform logins and integrations they bring (`instance.ts`), and the instance admin's writes and removals of a store integration's values (`instance-keys.ts`) ([Connectors](../tools-and-connectors/connectors.md)) |
| `registry/` | Installing connectors from a registry, the code tier, and the instance admin's registry view and changes, each served in this process without a restart (`admin.ts`) ([Connector registry](../tools-and-connectors/connector-registry.md)) |
| `mcp/` | `McpPool`, the catalog and its policy, the catalog's servers as the instance admin and an organisation's managers change them (`servers.ts`), an operator's direct tool call (`operator-call.ts`), the logins an operator reads, uses and sets up, with the GitHub login an operator sees (`connections.ts`), a server, a login and a binding as the API shows them (`view.ts`), who sees a connector and a login (`visibility.ts`), and the connect flows: a token login connected (`connect-token.ts`), a login started (`connect-start.ts`), the provider's callback (`connect-callback.ts`), a GitHub App installation traded, picked or installed (`github-install.ts`), and the box's GitHub App registered from a manifest (`github-app-manifest.ts`) |
| `oauth/` | The OAuth mechanics of each manifest's `auth.oauth`: discovery, client registration, PKCE and state, the code exchange, token refresh and expiry, and the redaction values of a connection's stored tokens (`index.ts`), and the callback and installation-picker pages (`html.ts`) |
| `github/` | The GitHub App, its manifest flow, and the installation tokens minted for a login's repositories ([GitHub](../tools-and-connectors/github.md)) |
| `coding/` | Guild repositories and the GitHub logins they use (`guild-repositories.ts`), a coding run's git side, the harnesses (`harnesses.ts`), and each harness's models and efforts (`harness-models.ts`) ([Coding agents](../concepts/coding/index.md)) |
| `machines/` | Tiers, sizes, slots, placement and its access, an organisation's machines as its members manage them (`service.ts`), and the boot layout of agent homes ([Machines](../concepts/machines.md)) |
| `access/` | Binding resolution, a run's tools, MCP, and secrets, the access view a scope's page shows (`view.ts`), and the bindings an operator sets (`operator.ts`) ([Access](../concepts/access.md)) |
| `credentials/` | AES-GCM, environment fingerprints, and validation |
| `secrets/` | Who reaches and manages a secret, `secret_store`, redaction, and an organisation's secrets as its members manage them (`service.ts`) ([Secrets](../concepts/secrets.md)) |
| `db/` | Pool, codecs, Drizzle schema, one query module per table family (`users.ts`, `agents.ts`, `runs.ts`, …), seeds, and the migration check |
| `attachments/` | Chat images: sniffing, upload, and hydration |
| `artifacts/` | One module per sub-domain over the artifact store (`store.ts`): notes (`notes.ts`), Memory (`memory.ts`), collections (`collections.ts`), records (`records.ts`), and access lists (`access-lists.ts`), with `ArtifactFiles` (`files.ts`) for shared files and the uploads and deletes an operator makes of them, each announced to the file's guild (`operator-files.ts`); their queries are `db/artifacts.ts`, `db/collections.ts`, and `db/artifact-access.ts`; the files an operator's pages read and write at each level (`host-files.ts`) and the collection views (`collection-views.ts`) ([Artifacts](../concepts/artifacts.md), [Access](../concepts/access.md)) |
| `notes/` | `NotesStore` (`store.ts`): `system.md` and the routine shadow files; the store the generation unit tests use; the layout of an agent's folder and the checks a relative path passes against it (`paths.ts`), an agent folder of the earlier layout lifted into it at boot (`migrate.ts`), and the store's error (`errors.ts`); and an operator's notes on a guild, agent or organisation page (`operator.ts`) |
| `directories/` | State listing over `NotesStore` for those tests |
| `memory/` | Hydration, the cap, the archive, and the version history ([Memory](../concepts/memory.md)) |
| `prompts/` | Prompt composition and the `system.md` and `task.md` templates ([System prompt](../concepts/system-prompt.md)) |
| `state/` | The State JSON a run sees |
| `groupchat/` | `GroupChat`: posts, clears, the event stream, and the dispatcher (`index.ts`); group history (`history.ts`); tags (`tags.ts`); the recipient rules (`recipients.ts`) and the recipient router (`router.ts`); the deliveries the dispatcher starts and the runs an interruption stops (`delivery.ts`); the message a woken group run reads (`wake.ts`); and what an operator reads and posts (`operator.ts`) ([Group chat](../concepts/group-chat.md)) |
| `typesafe/` | The group routing client |
| `schedules/` | Routine timing, the `Schedules` service, and the routine writes an operator makes, each announced to the agent's guild (`operator.ts`) ([Routines](../concepts/routines.md)) |
| `scripts/` | The agent `script` catalog, its materialisation, and the script writes an operator makes, each announced to the agent's guild (`operator.ts`) ([Scripts](../concepts/scripts.md)) |
| `sandbox/` | `RunSandboxes`, core's sandbox provider (`index.ts`), the OpenSandbox SDK adapter: its shapes, its loading, and the wrappers over its JS signatures (`sdk.ts`), and the orphan sweep (`sweep.ts`) |
| `llm/` | Providers, the models.dev catalog, credentials, the model client, tokens, and cost ([Model client](orchestrator.md#model-client)) |
| `policy/` | `OrgPolicy` and the checks core runs against it |
| `avatars/` | [DiceBear](https://www.dicebear.com/) SVGs in seven styles (critters, cameo, pixelbot, bottts-neutral, clay, cutouts, voxel-bot); `looks.ts` assigns a guild family and a variant per builder role |
| `issues/` | Guild issues from `report_issue`, and the statuses an operator sets, each announced to the guild (`operator.ts`) |
| `notifications/` | The inbox view and its per-user stream |
| `usage/` | Usage counter keys, deltas, and tree (`index.ts`), and the organisation, guild, and agent listings (`view.ts`) |
| `studio/` | Prompt Studio: sessions, tools, drafts, edit, table, and routine requests, focus pins, the activity ledger, and the runs and routines the inspector reads (`inspector.ts`) ([Prompt Studio](../concepts/prompt-studio.md)) |
| `builder/` | The guild builder: sessions, tools, widgets, and workspace search ([Guild builder](../concepts/guild-builder.md)) |
| `recipes/` | The `guilds.recipe` schema, capture, rewrite, validation, and apply ([Recipes](../concepts/recipes.md)) |
| `conversation/` | The shared coach runner and tool-result projection |
| `admission/` | `AdmissionCoordinator`: the generation slots that agent runs, Studio and Builder take under the box's cap and each organisation's plan (`coordinator.ts`) |
| `capabilities/` | The catalog facts the builder may name |
| `guilds/`, `agents/`, `organisations/`, `users/` | Validation, persistence, who sees what (`access.ts`), the API views (`view.ts`), and what an operator creates, changes and deletes (`service.ts`, `operators.ts`, `directory.ts`) |
| `config/` | Environment → `AppConfig` ([Configuration](orchestrator.md#configuration)) |
| `instance/` | Instance keys: the integration registry, the encrypted store, and the confirmation a GitHub App change needs ([Instance keys](extension-points.md#instance-keys)) |
| `cli/` | `seed:system`, `seed:operator`, `migrate`, and `pnpm connector` |
| `observability/` | Logs, request ids, client-error intake, Sentry, and runtime metrics ([Observability](orchestrator.md#observability)) |
| `net/` | Outbound HTTP and endpoint validation |
| `lib/` | Shared helpers: ids, paths, locks, the event queue, the clock, JSON, names, numbers, change actors (`change-actor.ts`), an agent's home files (`agent-file.ts`), and the blob store under attachments and shared files (`blob-store.ts`) |

## `apps/web/`

| Path | What it is |
| --- | --- |
| `src/main.tsx`, `index.html` | Entry: mounts the app with no slot filled |
| `src/mount.tsx` | `mount(slots)` ([Boot](web-app.md#boot)) |
| `src/app/` | The app frame: providers, identity, routes, slots, theme, storage helpers, formatting, and the back button (`returnTrail.ts`) |
| `src/api/` | The typed API client, identity, queries, streams, and the client error log ([State and events](web-app.md#state-and-events)) |
| `public/` | Files served as-is |
| `vite.app.ts` | `appConfig()`: build and dev-server configuration, shared with an extension |
| `package.json` | `exports`: what an extension's package may import ([Extension slots](web-app.md#extension-slots)) |
| `claude-design-export/` | The first Claude Design export; not the live library |

### `src/features/`

One directory per area. The screens are in the
[Screen map](screen-map.md).

| Directory | What it holds |
| --- | --- |
| `shell/` | Sidebar and rail, unread counts, account menu, new-message chime and desktop notifications |
| `home/` | `/`, the empty state, and the not-found page |
| `guild/` | Guild workspace, group chat with its message queue, guild menu, and guild pages |
| `agent/` | Create-agent dialogs and the agent inspector's tabs |
| `agent/runs/` | A run's rows grouped into generations, steps, and tool calls |
| `notes/` | The notes browser and the provenance strip |
| `files/` | The files browser: upload, download, access, and delete of shared files |
| `access/` | One scope's tools and secrets |
| `tables/` | The Tables page |
| `studio/` | Prompt Studio |
| `builder/` | The guild builder |
| `coach/` | What Studio and Builder share: the coach log and the split |
| `recipes/` | Recipe library, recipe page, apply preview, and checklist |
| `admin/` | Connector catalog, platform keys, and users |
| `settings/` | Organisation settings |
| `machines/` | Machines tab, dialog, meters, and picker |
| `models/` | Model setup and the model pickers |
| `instance/` | What a missing platform key means for a screen |
| `inbox/` | The Inbox |

## `packages/ui/`

| Path | What it is |
| --- | --- |
| `src/index.ts` | Public barrel, a client module |
| `src/theme.css`, `src/tokens.css`, `src/motion.css` | Tailwind entry, tokens, and motion |
| `src/primitives/`, `src/components/` | Library modules, stories beside each |
| `src/foundations/` | Token and icon Storybook boards |
| `src/writeDesignSystemDoc.ts` | `pnpm design-system-doc` |
| `.storybook/` | Storybook config |

[Design system](design-system.md) explains each one.

## `runtime/`

Runs **inside** a machine's Docker sandbox, not in Node. Every
helper that acts for one agent takes its id, or reads its home from
`GUILDS_AGENT_HOME`.

| Path | What it is |
| --- | --- |
| `Dockerfile` | `python:3.12-slim` plus Chromium or Chrome, TigerVNC, noVNC, ttyd, Playwright 1.52.0, Node.js 24, build tools, GitHub CLI, mise, the coding harnesses, and the helpers below. Codex (`CODEX_VERSION`) is always installed. Claude Code, the Cursor CLI, and the Antigravity CLI (`CLAUDE_CODE_VERSION`, `CURSOR_VERSION`, `ANTIGRAVITY_VERSION`) are installed when the `HARNESSES` build argument names them, which its default does. The harness CLIs it carries are listed at `/usr/local/share/guilds/harnesses` |
| `guilds-code` | `shell` and background commands, `file_read`, ripgrep search, output shaping, home and machine sizes, and git setup, clones, checkpoints, and diffs; reads the agent's tokens from `/run/guilds/<agent id>/git-tokens.json` |
| `guilds-harness` | The coding harnesses behind `code_task`: `check`, `start`, `poll`, `result`, `stop`, and `log`; one driver per harness (Claude Code, Codex, Cursor, Antigravity); call state under `/run/guilds/<agent id>/harness/` ([Harnesses](../concepts/coding/harnesses.md)) |
| `agy` | The Antigravity CLI at the pinned version, installed as `/usr/local/bin/agy` |
| `claude-code-managed-settings.json` | Claude Code's managed settings at `/etc/claude-code/managed-settings.json`: hooks off, no project MCP servers |
| `guilds-git-credential` | The git credential helper: the installation token of the guild repository git talks to |
| `git-template/` | The git template whose `prepare-commit-msg` hook adds the `Guild-Run` and `Guild-Agent` trailers |
| `guilds-script-run` | Runs a named Python script with `GUILDS_SCRIPT_ARGS` on stdin |
| `agent-browser-start <agent id> <slot> <language>` | One agent's Xtigervnc display, Chrome, and noVNC on its slot's ports |
| `agent-cli-start <agent id> <slot>` | One agent's ttyd with bash in its home; prints the secret path segment it serves under |
| `agent-stop <agent id> browser\|all\|purge` | Stops one agent's browser, or its browser and terminal; `purge` also removes its `/run/guilds/<agent id>/` files |
| `agent-lib.sh` | Shell helpers the `agent-*` scripts share |
| `guilds-browser` | Playwright over the agent's CDP port for the browser tools ([Browser](../concepts/browser.md)) |
| `guilds-locale` | Timezone from the egress IP; Chrome language from `GUILDS_BROWSER_LANGUAGE` (default en-US) |
| `install-chrome.py` | Google Chrome Stable on amd64, Debian Chromium on arm64 |
