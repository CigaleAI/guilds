# Security register

Security issues found in guilds.run, fixed or still open. Unlike
the other chapters, this one keeps history. Each entry says what
was exposed, how it was fixed or what fixing it takes, and what
risk remains. Entries are not removed once fixed. Newest first.
Ids are never reused.

| Id | Issue | Status |
|---|---|---|
| SEC-30 | Personal harness subscriptions used inside a shared organisation may fall outside the vendor's terms | Open |
| SEC-29 | A repository can carry configuration its coding harness loads | Open |
| SEC-28 | A coding harness runs with its permission prompts off | Open |
| SEC-27 | Harness subscription tokens and logins are readable on the agent's machine | Open |
| SEC-26 | A member could place an agent beside a private guild's agents | Fixed 2026-10-13 |
| SEC-25 | The machine list named the agents and guilds of private guilds | Fixed 2026-10-13 |
| SEC-24 | Agents on one machine can read each other's homes, tokens, and sessions | Open, accepted |
| SEC-23 | A runtime connector may declare an instance key of its own | Fixed 2026-10-10 |
| SEC-22 | The GitHub App manifest callback takes a creation code from the browser | Fixed 2026-10-10 |
| SEC-21 | Platform keys are written through the API | Fixed 2026-10-10 |
| SEC-20 | Connector code installed at runtime runs inside the orchestrator | Open |
| SEC-19 | A registry's index is unsigned, so `verified` is only that registry's word | Fixed 2026-10-09 where `REGISTRY_PUBLIC_KEY` is set |
| SEC-18 | A connector installed at runtime could claim the box's credentials | Fixed 2026-10-09 |
| SEC-17 | An organisation's own MCP server makes the orchestrator call a URL it chose | Open |
| SEC-16 | A listed tool whose name reads as harmless now starts On | Open |
| SEC-15 | Outside `session` mode the API answers requests from any web origin | Fixed 2026-10-06 |
| SEC-14 | A box outside the GCP cut encrypts under the all-zero development key | Fixed 2026-10-06 |
| SEC-13 | Chat image uploads could persist unsanitized bytes or leak across organisations | Fixed 2026-10-03 |
| SEC-12 | The GitHub App's private key mints tokens for every installation | Open |
| SEC-11 | A GitHub install callback could name another account's installation | Fixed 2026-09-30 |
| SEC-10 | A coding agent's repository token is readable by any process in its sandbox | Open |
| SEC-9 | Graft's hosted features can send repository history to its vendor | Open |
| SEC-8 | Content a coding agent reads can steer its commands | Open |
| SEC-7 | A coding agent's workspace can fill the shared disk | Open |
| SEC-6 | Coding agents run commands as root in the container | Open |
| SEC-5 | Background commands make the SEC-3 race practical | Open |
| SEC-4 | Package installs run third-party code beside the agent's secrets | Open |
| SEC-3 | Check-then-open race on agent workspace paths | Open |
| SEC-2 | Any organisation member could write organisation-wide secrets | Fixed 2026-09-30 |
| SEC-1 | Links planted in an agent workspace redirect orchestrator file access | Fixed 2026-09-30 |

## SEC-30 — Personal harness subscriptions used inside a shared organisation may fall outside the vendor's terms

**Status:** open.

**Found:** 2026-10-13, building coding harnesses.

**Where:** a coding agent's harness credential: the secret
`CLAUDE_CODE_OAUTH_TOKEN` or `CURSOR_API_KEY` granted to it, or a
login stored in its home (`runtime/guilds-harness`), and the **Harness** select on
Create agent and agent Settings
(`apps/web/src/features/agent/settings/configForm.tsx`).

**Exposure:** a harness runs on a subscription, often an operator's
personal one. In an organisation, everyone who can start the agent's
runs uses it: direct runs, group and schedule wakes, and other
agents on its machine that read the credential (SEC-27). A vendor's
terms may restrict a personal subscription to its holder or to
interactive use. The vendor may then suspend the account.

**Control in place:** the note under the **Harness** select says
that the harness does the code work on the operator's own
subscription, and that a personal subscription in a shared
organisation may fall outside the vendor's terms. A harness runs only
on a credential someone granted to the agent or logged in with.
Organisation model keys never reach the sandbox.

**Residual risk:** whether a use complies with the vendor's terms is
the operator's call. The platform does not check it.

## SEC-29 — A repository can carry configuration its coding harness loads

**Status:** open.

**Found:** 2026-10-13, building coding harnesses.

**Where:** the drivers' command lines in `runtime/guilds-harness`,
and `runtime/claude-code-managed-settings.json`, copied to
`/etc/claude-code/managed-settings.json` by `runtime/Dockerfile`.

**Exposure:** a coding CLI reads configuration from the repository it
works in: for Claude Code `.claude/` (settings, hooks, commands,
agents) and `.mcp.json`, for Codex `.codex/`, for Cursor `.cursor/`
(rules, `mcp.json`, `hooks.json`). A hook or an MCP server is code
that runs on load, without the model deciding to run it. Whoever can
push to a guild repository could then run commands in the agent's
sandbox, with its secrets.

**Control in place:** every call runs Claude Code with
`--setting-sources user`, so project and local settings are not
loaded; `--strict-mcp-config`, so no MCP server loads that the call
does not pass, and it passes none; and `--settings` with
`disableAllHooks`. The managed settings, which no user or project
file overrides, turn hooks off and project MCP servers off. Every
Codex call disables hooks, plugins, and apps and sets `mcp_servers`
empty; Codex runs no hook it has not been told to trust. Cursor calls
never pass `--approve-mcps`.

**Residual risk:** Cursor runs a repository's `.cursor/hooks.json`:
the Cursor CLI has no switch to turn project hooks off. An agent
whose repositories take pushes from people it should not trust runs
Claude Code or Codex. User-level settings in the agent's home
(`~/.claude/`, `~/.codex/config.toml`, `~/.cursor/`) still load,
including plugins enabled there. The
agent, the harness, and every agent on the machine (SEC-24) can write
them, so a steered agent or harness can change what a later call
loads. Instruction files in the repository (`CLAUDE.md`, and
`AGENTS.md` where the harness reads it) are read and can steer the
harness (SEC-28).

## SEC-28 — A coding harness runs with its permission prompts off

**Status:** open.

**Found:** 2026-10-13, building coding harnesses.

**Where:** `code_task` (`apps/orchestrator/src/toolbox/harness.ts`)
and the drivers in `runtime/guilds-harness`: Claude Code with
`--dangerously-skip-permissions` (and `IS_SANDBOX=1`, because
commands run as root, SEC-6), Codex with
`--dangerously-bypass-approvals-and-sandbox`, Cursor with `--force`.

**Exposure:** the harness runs every command and edit it decides on,
with nobody to approve. It reads repository files, issue text,
command output, and the notes the agent appends to its brief.
Instructions planted in that content can steer it, as they can steer
the agent (SEC-8). Its environment carries the agent's granted
secrets, and git reaches the installation token through the
credential helper (SEC-10). Its final message returns to the agent,
which can be steered by it in turn.

**Control in place:** the container is the boundary. The harness has
no guild tools, no MCP servers, and no hooks (SEC-29). `GH_TOKEN` and
`GITHUB_TOKEN` are never in its environment, nor the variables that
would move it to metered API billing. The brief's preamble tells it
never to push or open pull requests. The `coding` prompt block tells
the agent that the harness's final message is data, and to check its
work before pushing it.

**Residual risk:** a steered harness can do anything the sandbox and
the agent's secrets allow: read and send them out, change the
working tree, and push to the guild repositories' unprotected
branches through git (SEC-10). It reaches the other agents on its
machine (SEC-24). Nothing enforces the preamble.

## SEC-27 — Harness subscription tokens and logins are readable on the agent's machine

**Status:** open.

**Found:** 2026-10-13, building coding harnesses.

**Where:** the harness credentials in `apps/orchestrator/src/coding/harnesses.ts`
and `runtime/guilds-harness`: the secrets `CLAUDE_CODE_OAUTH_TOKEN`
and `CURSOR_API_KEY` in the environment of the agent's commands, and
the logins stored in the agent's home (`~/.claude/.credentials.json`,
`~/.codex/auth.json`, `~/.config/cursor/auth.json`).

**Exposure:** a subscription token granted as a secret is in the
environment of every command the agent runs, its harness included.
A login is a file in its home. Every agent on the machine runs as
root in the same container (SEC-24): any of their processes can read
the login file at any time, and the token while a command of this
agent runs. So can whatever a package install or a steered harness
starts (SEC-4, SEC-28). With the token or the login, the
operator's subscription can be used from anywhere.

**Control in place:** the token reaches a command only by grant,
through that command's environment, never the container's, and its
value joins run redaction like every secret. The driver never writes
the login or account files. The operator picks the machine an agent
goes on, and the operator app says that agents on one machine can
read each other's files and sessions.

**Residual risk:** a token or login read on the machine works until
the operator revokes it with the vendor. A login file's values are
not in the redaction set, so reading the file back shows them in the
run's transcript.

## SEC-26 — A member could place an agent beside a private guild's agents

**Status:** fixed 2026-10-13, before machines shipped.

**Found:** 2026-10-13, reviewing machines.

**Where:** `PUT /api/agents/:id/machine`, agent create,
`PUT /api/agents/:id/config` with `machine_id`, and a recipe apply
(`apps/orchestrator/src/http/`, `apps/orchestrator/src/recipes/apply.ts`;
the rule is in `apps/orchestrator/src/machines/access.ts`).

**Exposure:** any member who sees a guild can place its agents. The
target machine could host agents of a private guild that member
cannot see. Agents on one machine reach each other (SEC-24). The
member's agent then had same-user access to those agents':

- homes
- git tokens
- Chrome cookies and logins
- Chrome DevTools ports

**Fix:** a placement is refused with 403 when the target machine
hosts an agent of a guild the caller cannot see. The refusal covers
agent create, a `machine_id` in the agent configuration, a move,
and a recipe apply (the blocking finding `machine.private`).

**Residual risk:** owners and admins see every guild, so they can
still place agents of different guilds on one machine (SEC-24).

## SEC-25 — The machine list named the agents and guilds of private guilds

**Status:** fixed 2026-10-13, before machines shipped.

**Found:** 2026-10-13, reviewing machines.

**Where:** `GET /api/orgs/:id/machines`
(`apps/orchestrator/src/http/machine-routes.ts`).

**Exposure:** every member of the organisation could list its
machines. Each machine listed its agents with their names and their
guilds' names, private guilds included.

**Fix:** the list leaves out every agent of a guild the caller
cannot see and gives their number as `hidden_agents`. They still
count toward the machine's slots and planned memory.

**Residual risk:** a member learns that a machine holds agents they
cannot see, and how many.

## SEC-24 — Agents on one machine can read each other's homes, tokens, and sessions

**Status:** open, by design since 2026-10-13; accepted. A machine
is one trust boundary inside an organisation.

**Found:** 2026-10-13, building machines.

**Where:** one container per machine (`RunSandboxes.ensure`,
`apps/orchestrator/src/sandbox/index.ts`), with every agent's home
at `/home/<agent id>` and its runtime files, git tokens among them,
at `/run/guilds/<agent id>/`
([Machines](../concepts/guilds-and-agents.md#machines)).

**Exposure:** every agent placed on a machine runs its commands as
root (SEC-6) in that machine's one container. That covers `shell`,
scripts, the code helper, the CLI tab, and whatever a package
install starts (SEC-4). Any of these processes can:

- read and change every other agent's home on the machine
  (repositories, scripts, files, `.gitconfig`)
- read every other agent's git tokens (SEC-10)
- read every other agent's harness logins and subscription tokens
  (SEC-27)
- read every other agent's Chrome profile, with its cookies and
  logins
- attach to every other agent's Chrome DevTools port
- end every other agent's processes
- read the environment of a command another agent runs at the same
  moment, which carries that agent's granted secrets
- set `GUILDS_AGENT_HOME` to another agent's home.
  `runtime/guilds-git-credential` and `runtime/guilds-code` then
  pick that agent's git token. Reading the token file directly
  allows the same.

Agents of different guilds share a machine when the operator places
them there. A guild is not a boundary on a machine. A steered agent
(SEC-8) has the same reach.

**Control in place:** a machine never spans organisations: its
container and its host directory are its organisation's alone.
Secrets are never in the container's environment. They reach a
command only through that command's environment, so another agent
sees them only while such a command runs. The CLI tab's shell
carries no secret values. Owners and admins create the machines,
and whoever places an agent picks its machine: an agent whose data
must stay apart goes on a machine of its own. A placement onto a
machine that hosts an agent of a guild the caller cannot see is
refused (SEC-26). Where an agent is placed, the operator app says
that agents on one machine can read each other's files and
sessions.

**Residual risk:** agents on one machine trust each other.
Isolating them takes a container, or a separate user and process
namespace, per agent.

## SEC-23 — A runtime connector may declare an instance key of its own

**Status:** fixed by design 2026-10-10, as connector-declared
integrations shipped.

**Where:** `boxWiringProblem` (`src/connectors/manifest.ts`), applied
to every registry install with or without code
(`endpointOnlyProblem` there, `codeManifestProblem` in
`src/registry/client.ts`), and `refreshConnectorIntegrations`
(`src/instance/connectors.ts`).

**Exposure:** a registry connector's manifest now asks the instance
admin for a credential: a platform key for its platform login, or
the client id and secret of an OAuth client. A manifest that could
name one of the box's own credentials would run its endpoint on the
Tavily key, the Google client, or the GitHub App; one that could
name another connector's key would read that connector's.

**Fix:** a connector installed at runtime may only ask for a key or
client scoped to its own id, `connector:<slug>`: `auth.instance`
`{ "own": true }` on a token connector, or `configured` OAuth with
no provider. Naming a shipped integration's key
(`auth.instance.integration`), the box's OAuth client
(`oauth.provider`), or the GitHub App is refused at install. The
admin fills the key by name under Platform keys, for that connector
alone; values never return through any route; the row is deleted
with the connector. An organisation's own server holds nothing at
instance level (`recipeManifestProblem`).

**Residual risk:** an admin who fills a key for a malicious
connector hands that connector that key alone, and the endpoint it
names receives what the login sends (SEC-17).

## SEC-22 — The GitHub App manifest callback takes a creation code from the browser

**Status:** fixed by design 2026-10-10, as the manifest flow
shipped.

**Where:** `GET /api/admin/instance/keys/github-app/manifest/callback`
(`src/http/admin-instance-routes.ts`, `src/github/manifest.ts`).

**Exposure:** after the admin confirms the App on GitHub, GitHub
sends their browser back to the box with a `code`, and the box
trades it for a new App's credentials and stores them as the box's
GitHub App. A forged redirect, or one replayed from another flow,
could try to store an attacker's App, whose owner then holds the
private key the box signs with (SEC-12), or send the admin on to
another site.

**Fix:** the callback accepts a `state` only when it matches the
`guilds_github_manifest` cookie (HttpOnly, SameSite=Lax, scoped to
the callback path, 20 minutes) and names a flow this process
started for an instance admin; a flow is consumed once. The code is
exchanged once, over HTTPS with `api.github.com`, with no token. The
App is stored for the admin who started the flow. `return_to` is
restricted to a same-origin path. A failed state check, conversion,
or write stores nothing and sends the admin to Platform keys with
`setup_error`.

**Residual risk:** a pending flow lives in process memory, so a
restart between the confirmation on GitHub and the redirect fails
the state check and the admin starts again. The admin's own browser
is trusted to post the manifest it was given.

## SEC-21 — Platform keys are written through the API

**Status:** fixed by design 2026-10-10, when the platform keys
moved from the environment into the store.

**Where:** `PUT` and `DELETE /api/admin/instance/keys/:integration`
(`src/http/admin-instance-routes.ts`), the store
(`src/instance/keys.ts`), and the `instance_keys` table.

**Exposure:** the box's own credentials (the GitHub App, the Google
OAuth client, the Tavily and TypeSafe keys) are written over HTTP by
a signed-in user instead of by whoever edits `.env` on the host. A
write path any member could reach, or one that echoed values back,
would hand the box's identity to that member or to anyone reading
a response.

**Fix:** the routes answer only an instance admin; anyone else gets
404. Values are validated against the integration's fields (an
unknown field or a missing required one is 400; an env integration
cannot be written), encrypted with AES-GCM under
`SECRETS_MASTER_KEY` as one row per integration, and never read
back: every response and `GET /api/instance` carry which fields are
set, never a value. Each row records who wrote it and when, shown
to an instance admin. Replacing the GitHub App with another App ID,
or removing it, needs an explicit confirmation and disconnects the
logins installed with the old App, so no login keeps an
installation of an App the box no longer holds. The Tavily and
TypeSafe keys moved into the same store, so `.env` and
`.env.example` carry no platform key.

**Residual risk:** an instance admin's session writes the box's
credentials, and so does a compromised admin account. A database
dump holds every platform key's ciphertext, as it does every
login's; the master key stays in `.env`.

## SEC-20 — Connector code installed at runtime runs inside the orchestrator

**Status:** open, by design since 2026-10-09; opt-in.

**Where:** the code tier (`src/registry/code.ts`), which imports each
installed code connector's `adapter.js` into the running server.

**Exposure:** a code connector's adapter runs in the orchestrator
process with everything that process holds: the master key, the
database connection, every instance key in its environment, and the
decrypted credentials of every login. Its context is what the pool
passes it, but nothing in the language confines the module to that
context. Whoever can publish to the registry the box trusts, or sign
for it, runs code with the control plane's authority.

**Mitigation:** the tier is off unless `CONNECTORS_CODE_TIER=1`. A code
package installs only from an index `REGISTRY_PUBLIC_KEY` verifies and
only when that index marks it verified; `--unverified` does not apply
to code. Its manifest may not reach for the box's own wiring: a
shipped integration's key, the box's OAuth client, or the GitHub App
(SEC-23); a key or client it declares of its own is the admin's to
fill for that connector alone. The size and SHA-256 of every package
are checked against
the signed index. Only the instance admin installs one, and code loads
only from the operator's `CONNECTORS_ROOT`; a box with the tier off
logs code it finds there instead of loading it. Hosted turns the tier
on and verifies with its own registry key, so only code its CI signed
and marked verified runs there.

**Residual risk:** a signed, malicious or compromised adapter has the
orchestrator's full authority. Confining it takes running adapters in
a separate process or isolate with only the context crossing over.

## SEC-19 — A registry's index is unsigned, so `verified` is only that registry's word

**Status:** open since 2026-10-09; fixed the same day on a box that
sets `REGISTRY_PUBLIC_KEY`.

**Where:** the registry client (`src/registry/client.ts`) and its
installs (`src/registry/install.ts`, `pnpm connector install`,
`POST /api/admin/registry/connectors`, `POST /api/recipes/registry/import`).

**Exposure:** the box trusts the index at `REGISTRY_URL` as served.
Its `verified` flag and the package hashes it lists come from the
same response, so whoever controls that URL, its host, or the path to
it decides what an install reads as verified. A forged connector can
point its tools at an endpoint that receives what agents send it and
the login's own token; a forged recipe can carry instructions an
operator applies.

**Mitigation:** the index is fetched over HTTPS from the operator's
`REGISTRY_URL`. A package that differs from the index's size or
SHA-256 is refused. A connector install is endpoint-only (SEC-18),
stays visible as `registry` with its publisher, and an unverified
entry needs an explicit `--unverified`. A recipe imports as a draft
that is reviewed before apply.

**Fix:** an index may carry an Ed25519 signature over its canonical
bytes. With `REGISTRY_PUBLIC_KEY` set, the client refuses an index
that is unsigned or that the key does not verify, and code packages
install only from a verified index (SEC-20).

**Residual risk:** a box that leaves `REGISTRY_PUBLIC_KEY` unset still
takes the index as served for connectors without code and recipes.

## SEC-18 — A connector installed at runtime could claim the box's credentials

**Status:** fixed 2026-10-09, when registry installs and recipe-carried
servers were introduced. Since 2026-10-10 the rule is the box-wiring
check of SEC-23: a runtime connector may declare a key or client of
its own, never one of the box's; a recipe's server still holds none.

**Where:** `endpointOnlyProblem` (`src/connectors/manifest.ts`),
applied by the registry client (`src/registry/client.ts`), the
recipe parser (`connections[].manifest`, `src/recipes/schema.ts`),
and hosted's registry build.

**Exposure:** a manifest names how its login authenticates. One that
arrived at runtime (from a registry or inside a recipe) and named
`auth.instance`, OAuth with the `configured` strategy, or the GitHub
App would have had the pool call its own endpoint with an instance
key or a token minted on the platform's OAuth client.

**Fix:** a manifest without code in the image must have an endpoint
and sign in with a token or a dynamically registered OAuth client of
the login's own; one naming an instance key, another OAuth strategy,
or a `state` hook is refused, as is a package carrying adapter code.

**Residual risk:** none known for credentials. The endpoint itself is
SEC-17's exposure: the orchestrator calls the URL the manifest names.

## SEC-17 — An organisation's own MCP server makes the orchestrator call a URL it chose

**Status:** open, by design since 2026-10-09; mitigated.

**Where:** `POST /api/orgs/{id}/mcp/servers` (`src/http/org-connector-routes.ts`)
and the MCP sessions the pool opens (`src/mcp/index.ts`).

**Exposure:** an owner or admin of any organisation adds a remote
MCP server by URL. The orchestrator then sends requests to that
URL from its own network position, with the organisation's
credentials for it: at Connect, at each tool listing, and at each
call. A URL that reaches an address inside the operator's network
turns the orchestrator into a request forwarder (server-side
request forgery). Before, only the instance admin could add a
server.

**Mitigation:** the URL must be `https://` on a public host when
it is saved (`assertPublicHttpsUrl`, `src/net/endpoints.ts`). Each
request a session sends resolves the host first and refuses a
private, loopback, link-local, or metadata address
(`publicOnly`), so a public name later pointed inward is caught.
The server, its logins, and its listed tools are visible to its
organisation alone; another organisation's id is a 404 everywhere.
OAuth to it uses a dynamically registered client only, and the
consent step names the host the operator is sent to.
`OrgLimits.maxMcpServers` caps how many an organisation adds.

**Residual risk:** a name this process cannot resolve is left to
the proxy or firewall in front of it, and the check and the request
resolve separately, so a name that changes between them passes
once. A deployment denies private ranges for the orchestrator's
own traffic at its egress proxy or firewall as well. OAuth
discovery and token requests to the server's authorization server
are not resolved this way.

## SEC-16 — A listed tool whose name reads as harmless now starts On

**Status:** open, by design since 2026-10-09; mitigated.

**Where:** `toolStartsOff` (`src/connectors/load.ts`), applied when
a login's tools are listed (`McpPool.syncTools`).

**Exposure:** a tool a remote server lists, and its connector's
manifest does not name, starts On at the login's owner when its
name carries no writing verb and its listing does not mark it
`destructiveHint`. Before, every such tool started Off until an
operator turned it on. A server can name a writing tool so it
reads as a read (`lookup_orders` that also cancels one) and an
agent with that server on can call it on its first run.

**Mitigation:** the writing-verb list (`src/mcp/verbs.ts`) and
`destructiveHint` keep a tool Off; `readOnlyHint` never turns one
On. A connector's manifest names default-off tools with
`policy.default_off` and marks its own tools `mutating`, and the
instance admin can set any tool's default. A listed tool reaches
only the organisation that connected the server, and every scope
can turn it Off. Studio trusts `readOnlyHint` only on a verified
connector.

**Residual risk:** a misleadingly named, unannotated writing tool
on a server an organisation connected starts On for that
organisation's agents.

## SEC-15 — Outside `session` mode the API answers requests from any web origin

**Status:** fixed 2026-10-06, the day it was found.

**Where:** `AUTH_MODE=compat-cookie` and `trusted-header`.

The origin check on state-changing requests (`preHandler` in
`src/http/auth-routes.ts`) and on sandbox WebSocket handshakes
(`proxySandboxWs` in `src/http/routes.ts`) ran only when
`AUTH_MODE=session`. No mode checked a request's `Host`.

**Exposure:** in `compat-cookie` with one user, a request that
names no user is that user.

A page open in the operator's browser could reach
`http://127.0.0.1:8080`. A hostname rebound to the loopback
address made the page same-origin with the API. The API then read
and wrote whatever the operator could, sandbox panes included.

Without rebinding, a page could still send the requests a browser
does not preflight and open the sandbox WebSockets. This is the
mode of the local stack and of a core box
([Extension points](extension-points.md)), where no sign-in stands
in front of the API.

**Fix:** one hook in front of every route, in every mode
(`src/http/origin.ts`).

A request is served only when its `Host` is a loopback name or the
host of `PUBLIC_BASE_URL`. `/health` alone answers any host.

A state-changing request or a WebSocket handshake that carries an
`Origin` is served only when that origin is the host the request
names, the origin of `PUBLIC_BASE_URL`, or a loopback origin to a
loopback host (a development server proxying to this one).

A request with no `Origin` is not a browser's and passes.
`session` mode keeps its own stricter check on top, which requires
the `Origin`. `AUTH_MODE=trusted-header` requires
`PUBLIC_BASE_URL`, so a box behind a proxy names the host it is
reached by.

**Residual risk:** anything that reaches the port still acts as
the operator, so the port stays on loopback or behind a proxy that
authenticates. A request without an `Origin` is not checked, which
covers every client that is not a browser. Another server on the
operator's machine is a loopback origin and passes; it could reach
the port directly anyway.

## SEC-14 — A box outside the GCP cut encrypts under the all-zero development key

**Status:** fixed 2026-10-06, the day it was found. A box that
already ran on the zero key still holds credentials encrypted
under it.

**Where:** `docker-compose.yml` (`SECRETS_MASTER_KEY:
${SECRETS_MASTER_KEY:-0000…}`), `Makefile` (`SECRETS_MASTER_KEY ?=
0000…`, exported for every goal), `make up` and `make up-hosted`.

**Exposure:** the master key resolved to 32 zero bytes written in
this repository. The orchestrator booted on it without a word.

On `make up-hosted`, the self-hosted box of
[Install](../getting-started/install.md), this happened even with
a real key in `.env`. Make exported its default. Compose takes an
exported value over the one `.env` sets.

The same held for the PostgreSQL password (`agent_platform`) and
the OpenSandbox key (`cigale-dev`). Every connection credential,
organisation model key, secret, and sandbox host API key was then
encrypted under a key anyone with the repository has. A database
dump or backup read as plaintext.

The GCP cut was not affected. `deploy/release.sh` exports `.env`
before it calls make. `deploy/validate-hosted-env.sh` refuses the
defaults.

**Fix:** the orchestrator refuses to start on an all-zero master
key unless `ALLOW_ZERO_MASTER_KEY=1`, which only the development
overlay (`docker-compose.watch.yml`) sets.

`docker-compose.yml` gives the key no default. The Makefile sets
and exports its development secrets for development goals only.
`make up-hosted` and `make up-gcp` read theirs from `.env` or the
caller's environment.

**Residual risk:** a box that ran `make up-hosted` before the fix
has its credentials encrypted under the zero key, and its
PostgreSQL volume initialised with the development password,
whatever its `.env` says. Started again, it reads `.env`: a real
key there cannot decrypt what the zero key encrypted, and a
different password does not open the volume. No tool re-encrypts
stored credentials under a new key; until one does, such a box
keeps running only by setting the zero key and
`ALLOW_ZERO_MASTER_KEY=1` on purpose. A fresh box has no setup
step yet and depends on its operator writing a random key.

## SEC-13 — Chat image uploads could persist unsanitized bytes or leak across organisations

**Status:** fixed 2026-10-03, as direct-chat images shipped.

**Where:** `POST /api/attachments`, `GET /api/attachments/:id`,
user-message `metadata.attachments`, `src/attachments/`.

**Exposure:** accepting the declared MIME type would take SVG
(and other active content). Storing base64 in `messages.payload`
would keep image bytes in the run forever and inflate backups.
Serving files without an org check would let any member read
another organisation's upload.

**Fix:** the body is sniffed by magic bytes (JPEG, PNG, GIF, WebP
only; no SVG). Size is capped at 10 MiB and four images per
message.

Bytes go to the attachments bucket (or process memory when the
bucket is unset) under `{orgId}/{id}`. The message stores only
`{ id, filename, mime, kind }`.

GET is org-scoped, `nosniff`, and inline only for images. The
catalog `attachments` flag gates attach. Hydration uses a
15-minute signed URL, or a data URL when signing is unavailable
or the provider refuses public image URLs (Kimi), and never
writes those URLs back to the row.

**Residual risk:** an upload that is never sent stays in the
bucket until an operator deletes it. A signed URL is readable by
anyone who has the link for 15 minutes. When signing fails, the
provider request carries a data URL.

## SEC-12 — The GitHub App's private key mints tokens for every installation

**Status:** open.

**Found:** 2026-09-30, building the GitHub connection.

**Where:** the `private_key` field of the GitHub App integration,
an `instance_keys` row (`src/instance/keys.ts`). `src/github/index.ts`
signs App tokens with it. Until 2026-10-10 it was
`GITHUB_APP_PRIVATE_KEY` in the orchestrator environment.

**Exposure:** the key authenticates as the App. The App can
request a token for any installation of it: every connected
account's selected repositories, across organisations.

**Control in place:** the key is an encrypted `instance_keys` row
under the master key, written only by a platform admin through the
admin route or the manifest callback (SEC-21, SEC-22), never
returned by any route, and never enters a sandbox. Installation ids
stay in encrypted connection payloads.

**Residual risk:** a database dump holds the key's ciphertext, and
the master key in `.env` opens it. A control-plane compromise
reaches every connected account's selected repositories.

## SEC-11 — A GitHub install callback could name another account's installation

**Status:** fixed 2026-09-30, before the GitHub connection
shipped.

**Where:** the GitHub branch of `GET /api/mcp/oauth/callback`
(`finishGithubConnection` in
`apps/orchestrator/src/http/routes.ts`).

**Exposure:** the callback's `installation_id` is a query
parameter. Accepting it as is would let anyone bind their
connection to another account's installation of the App, and so
mint tokens for its repositories.

**Fix:** the callback exchanges its `code` for the installing
user's token and keeps an installation only when that user can
reach it (listed on the token, or
`GET /user/installations/{id}/repositories` succeeds). The user
token is discarded. An integration test forges an id and checks
the attempt is dropped.

**Residual risk:** none known.

## SEC-10 — A coding agent's repository token is readable by any process in its sandbox

**Status:** open.

**Found:** 2026-09-30, building the GitHub connection.

**Where:** `/run/guilds/<agent id>/git-tokens.json`,
`guilds-git-credential`, and `GH_TOKEN` in `shell` commands.

**Exposure:** git and `gh` need the installation token inside the
sandbox. Any process there can read it, including third-party
code a package install runs (SEC-4) and a steered agent (SEC-8).
Since 2026-10-13 agents share machines (SEC-24): the tokens of
every coding agent on a machine are readable by any process on it,
whichever agent started it, so one agent can push to the
repositories of another agent's guild.

**Control in place:** each token lives one hour. It reaches only
the guild's repositories that use its connection, with contents
and pull requests write. It is kept off the workspace disk,
replaced before it expires, and redacted from tool results.

**Fix to make:** a control-plane git proxy that holds the
credential and checks the branch and the agent. It has priority
since machines are shared. Until then a process can push to any
unprotected branch of the repositories of every coding agent on
its machine for that token's hour. Protecting the default branch
is the operator's control on GitHub. Placing coding agents of
different guilds on separate machines keeps their tokens apart.

## SEC-9 — Graft's hosted features can send repository history to its vendor

**Status:** open.

**Found:** 2026-09-30, building code search.

**Where:** the Graft CLI in `agent-runtime` and the Graft-backed
tools in `runtime/guilds-code`.

**Exposure:** Graft has model-written and hosted features
(`build --deep`, `trail`, `viz`, `init`, `mcp`) that send code or
repository history to a model provider or to its vendor. It
reports usage.

**Control in place:** the tools run only its structural tier
(tree-sitter, no model, no network). No tool runs those commands.
No provider key is in the sandbox. `DO_NOT_TRACK=1` turns
telemetry off. The helper keeps Graft's text output and stderr
out of results.

**Residual risk:** an agent can still type such a command in
`shell`. Graft's daily npm version lookup has no switch.

## SEC-8 — Content a coding agent reads can steer its commands

**Status:** open.

**Found:** 2026-09-30, building coding agents.

**Where:** the `shell` tool
(`apps/orchestrator/src/toolbox/code.ts`, `runtime/guilds-code`),
`code_task` and the coding harness it runs
(`apps/orchestrator/src/toolbox/harness.ts`, `runtime/guilds-harness`),
and the `coding` block of `system.md`.

**Exposure:** a coding agent reads repository files, issue text,
and command output, and runs any command it decides on.
Instructions planted in that content can steer it to run commands
the operator did not intend: read its environment, change files
in its workspace, or send data out.

**Control in place:** the `coding` prompt block states that
repository content, issue text, and command output are data,
never instructions, and that a repository's contributor guide
sets code conventions only. Secrets reach an agent only by grant.

**Residual risk:** a steered agent can do anything its sandbox
and its granted secrets allow, including pushing to its guild's
repositories' unprotected branches and opening pull requests with
its installation token (SEC-10). Its own token cannot reach other
guilds' repositories; the tokens of other agents on its machine
can (SEC-24).

## SEC-7 — A coding agent's workspace can fill the shared disk

**Status:** open.

**Found:** 2026-09-30, building coding agents.

**Where:** the workspace check in `GenerationLoop` and
`workspace_size` in `runtime/guilds-code`.

**Exposure:** a coding agent installs packages, builds, and
clones into its home, `/home/<agent id>`. That folder is in its
machine's directory on the sandbox host's disk. Every agent on
that host shares the disk. Since 2026-10-13 agents share machines
(SEC-24): one agent can fill its machine's directory up to the
machine's cap, and then every agent on the machine fails to start
a generation until space is freed.

**Control in place:** after each generation the orchestrator
measures the agent's home and its machine's directory with `du`
inside the sandbox and stores both. Above the agent's
`max_workspace_mib` (default 10240), and never above the host
`WORKSPACE_MAX_MIB` (default 10240), or with the machine above its
own `max_workspace_mib` (default 10240), the next generation fails
at start with `workspace.full`. The Usage tab shows the agent's
home against its cap and the machine against the machine's cap.

**Residual risk:** one generation can write past the cap before
the check, and a background command can keep writing until its
machine's idle stop.

## SEC-6 — Coding agents run commands as root in the container

**Status:** open.

**Found:** 2026-09-30, building coding agents.

**Where:** the `shell` tool. Scripts and the CLI tab run as root
too.

**Exposure:** commands run as root inside the agent's machine's
container, which other agents of the organisation share (SEC-24).
A container escape would start from root.

**Control in place:** OpenSandbox drops capabilities
(`SYS_ADMIN`, `NET_ADMIN`, `SYS_PTRACE`, and others), sets
`no_new_privileges`, and limits processes.

**Residual risk:** root inside the container.

## SEC-5 — Background commands make the SEC-3 race practical

**Status:** open.

**Found:** 2026-09-30, building coding agents.

**Where:** `shell` with `background`, and any process a command
leaves running.

**Exposure:** a background command keeps running between tool
calls until its machine's idle stop. That is the process SEC-3
needs. It can swap a checked folder for a link while a tool that
opens workspace paths in the orchestrator (Drive, Qonto,
`secret_store`) runs.

**Control in place:** the code tools never open a workspace path
in the orchestrator. They run inside the container through
`guilds-code`, where a link resolves inside the container.
Background commands end with the idle stop.

**Fix to make:** SEC-3's fix closes this.

## SEC-4 — Package installs run third-party code beside the agent's secrets

**Status:** open.

**Found:** 2026-09-30, building coding agents.

**Where:** a coding agent's `shell`. `npm install`, `pip
install`, `mise install`, build scripts, and test suites run
third-party code.

**Exposure:** that code runs in the agent's machine's container
with the agent's secrets in its environment. Egress is open.
Since 2026-10-13 agents share machines (SEC-24): the code runs
beside every other agent's data on the machine. It can read their
homes, Chrome sessions, and git tokens, and push to another
guild's repositories for that token's hour (SEC-10). The
control-plane git proxy SEC-10 calls for gains priority.

**Control in place:** secrets reach an agent only by grant. A
coding agent gets the ones its operator granted it.

**Residual risk:** anything granted, to this agent or to another
agent on its machine, can be read and sent. Default-deny egress is
not built.

## SEC-3 — Check-then-open race on agent workspace paths

**Status:** open.

**Found:** 2026-09-30, while fixing SEC-1.

**Where:** `readAgentFile` and `writeAgentFile` in
`apps/orchestrator/src/lib/agent-file.ts`. So Drive `create_file`
and `download_file_content`, Qonto `upload_invoice`, and
`secret_store`.

**Exposure:** the helpers check the path, then open it. A process
left running in the sandbox (a script started in the background)
can swap a checked folder for a link between those two steps.

On a read, the window is between `realpath` and the `lstat` that
pins the file's identity. A later swap is caught by comparing the
opened file with the checked one.

On a write, the window is between walking the folders and opening
the file.

Winning the race gives the same reach as SEC-1, one call at a
time. A coding agent's background commands (SEC-5) are such a
process.

**Fix to make:** resolve the path relative to an open handle on
the workspace, with no link allowed at any step. Linux `openat2`
with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS` through a small
native helper, or move file transfer into the sandbox (read and
write through the sandbox's own file API, where a link can only
resolve inside the container).

## SEC-2 — Any organisation member could write organisation-wide secrets

**Status:** fixed 2026-09-30, in the organisation-owned secrets
change.

**Where:** the secret routes in
`apps/orchestrator/src/http/routes.ts`.

**Exposure:** creating an organisation secret checked only that
the caller belonged to the organisation. Updating or deleting one
checked only that the caller could see it. Any member could
therefore add a variable to every agent of the organisation,
overwrite the value every agent used, or delete it.

**Fix:** org owners and admins write any secret and are the only
ones who change who gets one. A member creates a secret only with
grants inside guilds they can see, and edits, rotates, or deletes
only a secret whose every grant lies in such guilds. A refused
write is 403 inside the organisation and 404 outside it. See
[Secrets and access](../concepts/secrets-and-access.md).

**Residual risk:** none known.

## SEC-1 — Links planted in an agent workspace redirect orchestrator file access

**Status:** fixed 2026-09-30. SEC-3 is the race that remains.

**Where:** Drive `create_file`
(`apps/orchestrator/src/connectors/drive/upload.ts`), Drive
`download_file_content` (`src/connectors/drive/content.ts`), and
Qonto `upload_invoice` (`src/connectors/qonto/client.ts`).

**Exposure:** an agent's `/home/agent` is its folder on the
orchestrator's machine, mounted into its sandbox. These tools
took a `file_path`, checked only that the path text stayed inside
that folder, then opened it on the orchestrator's own filesystem,
following links.

A link is resolved by the process that opens it. A link the agent
created in its sandbox (for example `report.pdf ->
/proc/self/environ`) pointed the orchestrator at its own files.

- Drive `create_file` and Qonto `upload_invoice` read any file
  the orchestrator could read and sent it to Drive or Qonto,
  where the agent could read it back. The orchestrator's
  environment holds `SECRETS_MASTER_KEY`, `DATABASE_URL`, and
  platform API keys.
- Drive `download_file_content` wrote downloaded bytes through a
  link at the destination, or through a linked folder on the way
  to it, onto any file the orchestrator could write.
- A FIFO the agent created made a read wait forever. A device
  node would have been opened as if it were a file.

An agent needed Drive or Qonto enabled and one script that runs
`ln -s`, which it can run as root in its sandbox. A prompt
injection, such as a web page the agent browses, is enough to
drive it.

**Fix:** every orchestrator read and write of an agent-named path
goes through `readAgentFile` or `writeAgentFile`
(`apps/orchestrator/src/lib/agent-file.ts`). `secret_store` uses
the same reader.

A read follows every link, requires the result to stay in the
workspace and be a regular file, then opens it without following
a link and without blocking, and requires the opened file to be
the one checked.

A write refuses any link on the way. Each existing folder must be
a real folder in the workspace. Missing folders are created one
at a time. The file is created or replaced without following a
link at its name.

Unit tests plant links, a linked folder, a FIFO, and a folder at
the file name for each helper and each tool.

**Unaffected code, checked:** deleting an agent or guild workspace
and the workspace sweep remove links without following them.
`prepareWorkspace` creates only two folders. Scripts reach
`/home/agent/scripts/` through the sandbox's own file API.
`deploy/backup.sh` archives links as links.
