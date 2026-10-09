# Orchestrator

The control plane is a strict TypeScript service in
`apps/orchestrator`. Python remains in `runtime/` for user scripts,
browser automation, and the code tools.

The process model and the trust boundary are [System](system.md).
Where each module lives is the [Code map](code-map.md).

## Stack

- Node.js 24 LTS, image `node:24-bookworm-slim` (pinned by digest in
  the Dockerfile), `engines.node` `^24`
- pnpm 10 (`packageManager` pin), workspace `apps/*` and `packages/*`
- Fastify 5, TypeBox, `@fastify/type-provider-typebox`,
  `@fastify/static`, `@fastify/websocket`
- Drizzle ORM with `node-postgres` on `postgres:17`
- `openai` (official client) for OpenRouter and DeepInfra, `js-tiktoken`
  for input counting, `croner` for cron, `undici` for outbound HTTP,
  `esbuild` (development) to bundle a registry connector,
  [`@dicebear/*`](https://www.dicebear.com/) for avatars, `@sentry/node`
- Tests: `node:test` through `tsx`
- OpenSandbox server commit `473ff611d93670a149ce6600f27ed194b18cce89`,
  `opensandbox/execd:v1.1.0`, runtimes `agent-runtime:0.3` (the standard
  box) and `agent-runtime-lite:0.1` (the lite box), TypeScript SDK
  from that same commit (`sdks/sandbox/javascript`)
- Token counting: `js-tiktoken` through an explicit encoding map, with a
  serialized-message length fallback for unknown models
- Cost: provider-reported `cost_usd` first, then a catalog rate for that
  model. Catalog fallback prices uncached input, cache reads, and output;
  `cache_read_tokens` is a subset of `input_tokens`. Every catalog model
  has a rate; a model without one fails at load. `PRICING_VERSION` names
  the LiteLLM table the GPT-5.6, Claude, and DeepInfra Qwen rows were
  copied from. OpenRouter GPT-6 Luna, GPT-6.1 Sol, GPT-6 Luna Pro,
  Gemini 3.8 Flash, Qwen3.8 Flash, and DeepInfra GLM-5.3, GLM-5.3-Flash,
  and DeepSeek-V4.1-Flash use that provider's published list price.

`src/config/index.ts` validates the environment once into a typed
`AppConfig`:

- `DATABASE_URL`
- `NOTES_ROOT`
- `WORKSPACE_ROOT`
- `ATTACHMENTS_ROOT`
- `TEMPLATES_ROOT` (the prompt templates, `src/prompts` by default)
- `OPENSANDBOX_URL`
- `OPENSANDBOX_API_KEY`
- `SANDBOX_IMAGE`
- `SANDBOX_IMAGE_LITE` (the standard image when unset, so a lite box
  boots before the lite image is configured, without the memory
  saving)
- `SECRETS_MASTER_KEY`
- `AUTH_MODE` with the `trusted-header` settings (`PUBLIC_BASE_URL`,
  `TRUSTED_HEADER_EMAIL`, `TRUSTED_PROXY_SECRET`, `OPERATOR_EMAIL`)
- `MAX_CONCURRENT_GENERATIONS`
- `TOOL_RESULT_MAX_BYTES`
- `HOST`
- `PORT`

`loadConfig` accepts the modes an edition identifies requests in
beside core's two. The instance keys are read through the registry
in `src/instance/integrations.ts`
([Extension points](extension-points.md#instance-keys)).

A few modules read their own optional variables:

- `CODE_RESULT_MAX_BYTES` (the code tools' result cap, default 8192)
- `WORKSPACE_MAX_MIB` (host-wide workspace cap, default 10240; each
  agent also has `max_workspace_mib`, default the same)
- `SENTRY_ENVIRONMENT` / `SENTRY_TRACES_SAMPLE_RATE`
- `ADAPTER_PROXY_URL` (forward proxy for adapter and MCP HTTP)
- `OPENSANDBOX_SDK_MODULE` (test substitution)

## Operational constants

Configurable only in tests:

- `SANDBOX_IDLE_TIMEOUT` = 5 minutes
- `SCHEDULER_TICK` = 30 seconds
- `CANCEL_GRACE` = 2 seconds
- `SHUTDOWN_TIMEOUT` = 15 seconds
- PostgreSQL pool = min 1, max 5
- OpenSandbox SDK `request_timeout` = 3 minutes
- OpenSandbox list `page_size` = 100
- model request timeout = 120 seconds
- script command timeout = 120 seconds
- browser tool timeout = 60 seconds
- browser ready wait = 60 seconds
- code tool timeout = 120 seconds; `shell` gets its own timeout plus 30;
  Graft-backed calls 660 seconds (a first graph build); ripgrep and
  ast-grep stop after 60 seconds inside the sandbox
- inline code-tool request = 64 KiB of base64; larger goes through the
  sandbox file API
- MCP catalog refresh interval = 10 minutes
- MCP tools/list timeout = 15 seconds
- MCP tools/call timeout = 90 seconds
- adapter HTTP timeout = 30 seconds
- TypeSafe call timeout = 8 seconds, 2 retries with backoff
- `TOOL_RESULT_MAX_BYTES` default = 65536
- sandbox resources = 0.5 CPU and 256Mi on a lite box, 2 CPU and 4Gi
  on a standard box (`config.browser` or `config.coding` true)
- browser desktop = 1280×720
- event queue per subscriber = 4096

Compose `stop_grace_period` on the orchestrator is 20 seconds so
Docker does not SIGKILL during `SHUTDOWN_TIMEOUT`.

## Generation

- A registry maps each active agent to at most one generation.
- One mutex protects ownership check, controller insertion,
  cancellation handoff, and removal. It is never held during model
  or tool I/O.
- Generation start reserves the agent **before** the run row is
  inserted.
- Creating a direct run **without** a user message is allowed while
  that agent is generating. Creating or continuing a run **with** a
  message returns 409 while the agent is busy.
- Each controller owns one `AbortController`.
- Cancel first requests a cooperative stop, interrupts the in-flight
  sandbox command, waits `CANCEL_GRACE`, then aborts. Settlement of
  interruption records runs once.
- Group dispatch waits on a generation lock-release counter when
  every actionable agent is busy. Schedule retry does **not** wait:
  a busy agent is skipped and the 30-second ticker retries.
- Artifact writes use PostgreSQL transactions.
- Guild deletion sets a deleting-guild guard, refuses new runs and
  group actions with 409, and releases the guard in `finally`.
- Secret changes re-resolve the active-run secret snapshots of the
  agents they reach, mark those sandboxes stale, destroy immediately
  when idle, and defer destroy until the current generation ends
  when busy. `secretChanged(secretId)` covers a new value, name, or
  description (the agents with an active run snapshot or a running
  sandbox using it). `secretAccessChanged(agentIds)` covers a
  create, a delete, an access change, and a new `secret_store`
  secret (the agents that gain or lose it).
- Browser ensure during an active generation returns 409 when the
  running sandbox lacks browser metadata.

Admission is per organisation. Ordinary runs, Studio, and Builder
share one slot count under the organisation policy's
`maxConcurrentRuns` and the instance ceiling
`MAX_CONCURRENT_GENERATIONS` (0 is no ceiling).

## Events

**Durable events** may be treated as commit notifications.
Subscribers that miss them recover by re-reading PostgreSQL.

This class includes:

- `message.committed`
- `run.error`
- `generation.started`
- `generation.finished`
- `run.continued`
- all `group.*` events
- invalidation events (`guild.files.changed`,
  `agent.scripts.changed`, `agent.routines.changed`)

**Ephemeral events** cannot be reconstructed.
`assistant.delta` and `assistant.reasoning.delta` are live-only.
The UI recovers by re-fetching committed messages, whose metadata
carries the full reasoning text.

Delivery rules:

- SSE streams send `: connected\n\n` then live events only. There
  is no historical replay. After reconnect the client polls REST.
- Run SSE carries run events. Group SSE carries group and
  invalidation events. Studio and Builder have their own streams.
- Headers remain `Content-Type: text/event-stream`,
  `Cache-Control: no-cache`, `Connection: keep-alive`, and
  `X-Accel-Buffering: no`.
- Slow subscribers must not stall generation. A disconnected or
  stalled subscriber is dropped. Durable events are recovered by
  REST.
- Committed rows and invalidation events are published only after
  their transaction commits.

## Startup and shutdown

From `apps/orchestrator`, `pnpm start` runs
`node --import tsx --import ./src/observability/instrument.ts src/server.ts`.

`server.ts` is core's process entry. It loads `AppConfig` and calls
`runServer` (`src/run.ts`). `runServer` builds the server, listens,
and shuts it down.

`createServer` in `src/compose.ts` wires the services and takes the
edition's extensions ([Extension points](extension-points.md)).
Core passes none. An edition's own entry passes its extension with
its configuration loaded beside core's.

1. load Sentry instrumentation, then `AppConfig`; configure logging
2. connect to PostgreSQL: core's migrations, then each extension's;
   then seed the system catalog, then each extension's seed, then
   the operator and its organisation on a box that still has no user
3. construct `NotesStore` (verifies `system.md` exists),
   `ArtifactStore`, `Scripts`, `Schedules`, `McpPool`
4. start the sandbox provider: one `RunSandboxes` manager on
   `OPENSANDBOX_URL`, or the one an extension supplies
5. construct `GenerationLoop`; reconcile active runs; start the
   scheduler
6. construct Studio, recipes, capabilities, apply, and Builder;
   reconcile Studio and Builder sessions
7. build the Fastify app, each extension's routes first, and listen

On startup reconciliation:

1. list every active run
2. append interruption tool results for unresolved committed tool
   calls
3. leave direct runs active and reusable
4. append a `generation.interrupted` run error to group and
   schedule runs
5. complete group delivery through the run's snapshotted sequence
   or complete the schedule run
6. resume pending group dispatch
7. schedule idle teardown for running sandboxes not owned by a
   generation

Graceful shutdown (SIGTERM / SIGINT): close HTTP, stop the
scheduler and dispatchers, cooperative-cancel in-flight generations
with `CANCEL_GRACE`, wait up to `SHUTDOWN_TIMEOUT`, close sandboxes
and the pool, flush Sentry.

An unhandled rejection or uncaught exception logs, flushes, stops,
and exits 1.

## PostgreSQL

Core's schema starts at `0001_baseline` in
`apps/orchestrator/drizzle/`. That file is a snapshot of every core
table, including `pg_trgm`. Numbered migrations follow it.

Production never uses `drizzle-kit push`. Boot runs committed
migrations before the HTTP listener becomes ready: core's, recorded
in `public.__drizzle_migrations`, then each extension's chain.
An extension keeps its tables and its record in a schema of its own
([Extension points](extension-points.md#data)).

New core schema lands as the next numbered SQL file in
`apps/orchestrator/drizzle/`. It is mirrored in
`src/db/schema/index.ts` and stamped after the migration before it.

Core has thirty-seven tables:

- users
- orgs
- org_members
- guilds
- guild_operators
- guild_repositories
- agents
- runs
- messages
- group_messages
- group_chat_reads
- schedules
- guild_issues
- secrets
- secret_grants
- connectors
- connector_calls
- mcp_connections
- mcp_tools
- bindings
- usage_counters
- org_monthly_usage
- org_model_providers
- artifacts
- attachments
- artifact_collections
- collection_access
- file_changes
- memory_revisions
- task_revisions
- studio_sessions
- studio_messages
- studio_drafts
- builder_sessions
- builder_messages
- recipes
- recipe_applies

Scripts are `artifacts` with `kind` `script` at agent level.

Collections live in `artifact_collections` (name, purpose, typed
`columns`, `next_id`). Their records live in `artifacts` (`kind`
`object`, `key` the id, `identity` the normalised unique value).
Their grants live in `collection_access` (one row per guild or
agent: a guild row is the base `read` or `write` mode for its
members, an agent row overrides it and may be `none`; a guild's own
table, `artifact_collections.guild_id`, takes no guild row and is
written by every member; rows deleted with the collection, the
guild, or the agent).

The standing task lives on `agents.task`. Agent names remain
globally unique.

Seeds stay separate from schema (`src/db/seed/`):

```text
catalog.ts        seed identifiers, native-tool and grant lists
mcp-manifests.ts  the installed connectors projected into catalog rows and tool copy
system.ts         upsert catalog, platform bindings
operator.ts       the operator and the Home organisation, on a box with no user
test.ts           deterministic fixtures
```

Boot runs the system seed, each extension's seed, and the operator
seed. Each is idempotent.

With `OPERATOR_EMAIL` set, boot then gives `user_operator` that
address. `POST /api/users` creates a personal organisation for the
user it creates. The baseline contains no application data insert.

### Codecs

`node-postgres` parsers and repository mappers are explicit.

| PostgreSQL type | API JSON |
|---|---|
| `INTEGER` (`messages.seq`) | number |
| `BIGINT` / `BIGSERIAL` | number (safe-integer check) |
| `NUMERIC` (`usage_counters.cost_usd`) | number rounded to 8 decimal places |
| `TIMESTAMPTZ` | string, microsecond precision |
| `BYTEA` | never returned as UTF-8 text on list/get |
| `JSONB` | object; defaults applied before validation |

Column timestamps in REST (`created_at`, `updated_at`,
`archived_at`, `next_run_at`, `last_run_at`, `rotated_at`) use
`YYYY-MM-DDTHH:MM:SS[.ffffff]+00:00`.

Operational `at` fields in run and group errors use `Z`.
Prompt-embedded JSON (State, group-chat info, schedule wake-up)
uses `JSON.stringify(value, null, 2)`. SSE `data:` framing is
exact. HTTP bodies compare as parsed JSON.

AES-256-GCM uses a 12-byte nonce and no additional authenticated
data. `secrets.ciphertext` stores ciphertext plus the GCM tag.
`secrets.nonce` stores the 12-byte nonce separately. The master key
stays outside PostgreSQL.

`SECRETS_MASTER_KEY` accepts a 32-byte strict base64 value,
URL-safe base64, hex (whitespace allowed; invalid hex rejected), or
raw ASCII, in that order. The all-zero key is refused unless
`ALLOW_ZERO_MASTER_KEY=1`, which only the development overlay sets.

AES-GCM plaintext is compact sorted UTF-8 JSON with non-ASCII
`\uXXXX`-escaped. Environment fingerprints serialize sorted
`[name, value]` pairs as compact UTF-8 JSON.

## Model client

```ts
interface ModelClient {
  streamCompletion(
    request: CompletionRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent>;

  countInputTokens(request: TokenCountRequest): Promise<number>;
}
```

The wrapper uses the official OpenAI client with a
provider-specific base URL and API key. Marketplace providers are
OpenRouter and DeepInfra. Coding-API providers start with Kimi Code
(`https://api.kimi.ai/coding/v1`). Stored model ids remain
`{provider}/{model}`.

An organisation's own key changes key resolution, not this
interface. `resolveOrgApiKey` picks the organisation's key for the
provider, else the instance key for marketplace models. A Kimi Code
model requires the organisation key. There is no instance fallback.

Requests send `User-Agent: guilds.run`. Kimi thinking levels map
`low` → `low`, `medium` → `high`, `high` → `max`. Coding-API cost
is `unavailable` and does not count against the organisation
policy's monthly spend limit.

- Inputs are the complete ordered OpenAI-style message history.
- OpenRouter requests send top-level `cache_control` and mark the
  last text message so Anthropic and Qwen prompt caching is on.
  DeepInfra caches prefixes automatically.
- Tool schemas pass through without framework transformation.
- A `thinking_level` other than `none` is sent as
  `reasoning: { effort }` and `reasoning_effort`.
- Streaming emits text deltas and one final assembled assistant
  payload.
- Automatic retries are disabled. Request timeout is 120 seconds.
- Final metadata: `usage.input_tokens`, `usage.output_tokens`,
  `usage.cache_read_tokens`, `latency_ms`, `finish_reason`, served
  `model`, `response_id`, `provider_request_id`, and `cost_usd`.
  Accounting reads `cost_usd` only.

## Sandbox and tools

A `RunSandboxes` manager drives one OpenSandbox, from the
configuration. An edition may supply a sandbox provider of its own
([Extension points](extension-points.md)).

A manager's work:

- ensure one matching sandbox per agent
- execute and interrupt commands
- start the terminal daemon
- resolve the noVNC and terminal endpoints
- destroy idle or stale sandboxes
- clear a workspace on agent deletion

OpenSandbox SDK objects do not escape the sandbox module.

Control-plane tools run in Node (notes, records, memory, schedules,
scripts, secrets, remote MCP servers, adapters). Sandbox tools
invoke reviewed helpers inside the agent container
(`script_run` through `guilds-script-run`, Playwright through
`guilds-browser`, the code tools through `guilds-code`).

Browser tools are offered when the run snapshot has
`browser: true`. The code tools are offered when it has
`coding: true`.
`group_post` is offered when that binding is on. `secret_request`
is offered only on direct runs. `report_issue` is always offered.

Tool output: custom filter, exact-value secret redaction, byte cap,
then `remaining_tool_calls: N`. Official tool HTTP clients go
through `ADAPTER_PROXY_URL` when it is set and direct otherwise.

## HTTP, SSE, and WebSocket

The React app (`apps/web`) is the black-box client. Route paths,
JSON names, status codes, and stable `detail` strings are the
contract.

Wire fixtures live in `fixtures/compat/` and `make compat-verify`
checks their digests. `pnpm compat:digest <path>` in
`apps/orchestrator` (or
`pnpm --filter @guildsrun/orchestrator compat:digest <path>` from
the root) refreshes a digest after a deliberate change.

Run events:

- `message.committed`
- `assistant.delta`
- `assistant.reasoning.delta`
- `generation.started`
- `generation.finished`
- `run.error`
- `run.continued` (a coding run continued in the run named by
  `run_id`)

Cancellation is a `run.error` whose payload has
`operation: "generation.cancelled"`.

Group events:

- `group.message.committed`
- `group.limit_reached`
- `group.idle`
- `group.delivery.started`
- `group.delivery.finished`
- `group.delivery.failed`

Invalidation:

- `guild.files.changed`
- `agent.scripts.changed`
- `agent.routines.changed`

Every request passes the host and origin check in
`src/http/origin.ts`. A request is served only for a loopback host
or the host of `PUBLIC_BASE_URL`. A state-changing request or a
WebSocket handshake that carries an `Origin` is served only when
that origin is that host, the origin of `PUBLIC_BASE_URL`, or a
loopback origin to a loopback host
([SEC-15](security-register.md)).

The sandbox proxies (`/api/agents/:id/browser/vnc/*` to noVNC,
`/api/agents/:id/cli/tty/*` to ttyd) preserve HTTP streaming,
WebSocket binary/text forwarding, and the `binary` and `tty`
subprotocols. The terminal proxy prepends the daemon's secret path
segment upstream. They decode and strip `content-encoding` before
streaming to the browser.

Client frames on either socket count as sandbox activity and
restart the idle timer, at most once every 30 seconds.

## Observability

Structured JSON logs on stdout:

- timestamp
- level
- run/guild/agent ids
- operation
- error type
- redacted message
- redacted stack

Prompts, model payloads, raw tool output, and secret values are not
logged.

A request id comes from the `X-Request-Id` header when the caller
sends one and is echoed on the response. The web app sends its
tab's id on every API call. It reports uncaught errors, unhandled
rejections, React render errors, and API calls that fail with a 5xx
or on the network to `POST /api/client-errors` (the app
deduplicates for 30 s and sends at most 10 a minute; the endpoint
accepts 30 a minute per address). Each report is logged with that
request id.

Compose json-file rotation is `max-size: 10m`, `max-file: 5`.
`error`-level events go to Sentry when `SENTRY_DSN` is set
(`instrument.ts` loads before the rest of the process; boot logs
`sentry enabled` or `sentry disabled`).

## Tests

| Layer | Role |
|---|---|
| `test/unit` | Domain without Docker |
| `test/integration` | HTTP + Postgres: a database per test on the server named by `R1_ADMIN_DATABASE_URL` (default the Compose Postgres on `127.0.0.1:5432`) |
| `test/contract` | Live OpenSandbox / model / Jev routing, gated by `RUN_*_CONTRACT=1` plus a key |
| `fixtures/compat` | Frozen HTTP, SSE, schema, crypto, and adapter contracts |

`make contract` runs the OpenSandbox and model contracts
(`RUN_OPENSANDBOX_CONTRACT`, `RUN_MODEL_CONTRACT` with
`MODEL_CONTRACT_MODEL`).

The OpenSandbox contract starts its own server at the pinned
commit. Its coding case runs the code tools through execd in
`agent-runtime:0.3` (or `CONTRACT_RUNTIME_IMAGE`). Its lite case
runs a script and the terminal in `agent-runtime-lite:0.1` (or
`CONTRACT_RUNTIME_IMAGE_LITE`) and checks the toolchains are
absent. Each is skipped until its image is built.

The web app's tests (`pnpm test:web`, `node:test` over
`apps/web/src/**/*.test.ts`) and the design-system tests
(`pnpm test:ui` over `packages/ui/src/**/*.test.ts`) cover the
operator app's pure models and the `@guildsrun/ui` library.

How to run all of it, with `make verify`, `make check`, the
pre-push hook, and CI, is
[Development](../contributing/development.md).
