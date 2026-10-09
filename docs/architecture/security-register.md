# Security register

Security issues found in guilds.run, fixed or still open. Unlike
the other chapters, this one keeps history. Each entry says what
was exposed, how it was fixed or what fixing it takes, and what
risk remains. Entries are not removed once fixed. Newest first.
Ids are never reused.

| Id | Issue | Status |
|---|---|---|
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
to code. Its manifest may not name an instance key or the box's OAuth
clients. The size and SHA-256 of every package are checked against
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
servers were introduced.

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

**Where:** `GITHUB_APP_PRIVATE_KEY` in the orchestrator
environment. `src/github/index.ts` signs App tokens with it.

**Exposure:** the key authenticates as the App. The App can
request a token for any installation of it: every connected
account's selected repositories, across organisations.

**Control in place:** the key stays in the orchestrator
environment with the other platform keys and never enters a
sandbox. Installation ids stay in encrypted connection payloads.

**Residual risk:** a control-plane compromise reaches every
connected account's selected repositories.

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

**Where:** `/run/guilds/git-tokens.json`, `guilds-git-credential`,
and `GH_TOKEN` in `shell` commands.

**Exposure:** git and `gh` need the installation token inside the
sandbox. Any process there can read it, including third-party
code a package install runs (SEC-4) and a steered agent (SEC-8).

**Control in place:** each token lives one hour. It reaches only
the guild's repositories that use its connection, with contents
and pull requests write. It is kept off the workspace disk,
replaced before it expires, and redacted from tool results.

**Fix to make:** a control-plane git proxy that holds the
credential and checks the branch. Until then a process can push
to any unprotected branch of those repositories for that hour.
Protecting the default branch is the operator's control on
GitHub.

## SEC-9 — Graft's hosted features can send repository history to its vendor

**Status:** open.

**Found:** 2026-09-30, building code search.

**Where:** the Graft CLI in `agent-runtime` and the Graft-backed
tools in `runtime/cigale-code`.

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
(`apps/orchestrator/src/toolbox/code.ts`, `runtime/cigale-code`)
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
its installation token (SEC-10); the token cannot reach other
guilds' repositories.

## SEC-7 — A coding agent's workspace can fill the shared disk

**Status:** open.

**Found:** 2026-09-30, building coding agents.

**Where:** the workspace check in `GenerationLoop` and
`workspace_size` in `runtime/cigale-code`.

**Exposure:** a coding agent installs packages, builds, and
clones into `/home/agent`. That folder is on the sandbox host's
disk. Every agent on that host shares it.

**Control in place:** after each generation the orchestrator
measures the workspace with `du` inside the sandbox and stores it
on the agent. Above the agent's `max_workspace_mib` (default
10240), and never above the host `WORKSPACE_MAX_MIB` (default
10240), the next generation fails at start with `workspace.full`.
The Usage tab shows used against the agent's max.

**Residual risk:** one generation can write past the cap before
the check, and a background command can keep writing until the
idle stop.

## SEC-6 — Coding agents run commands as root in the container

**Status:** open.

**Found:** 2026-09-30, building coding agents.

**Where:** the `shell` tool. Scripts and the CLI tab run as root
too.

**Exposure:** commands run as root inside the agent's container.
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
calls until the sandbox's idle stop. That is the process SEC-3
needs. It can swap a checked folder for a link while a tool that
opens workspace paths in the orchestrator (Drive, Qonto,
`secret_store`) runs.

**Control in place:** the code tools never open a workspace path
in the orchestrator. They run inside the container through
`cigale-code`, where a link resolves inside the container.
Background commands end with the idle stop.

**Fix to make:** SEC-3's fix closes this.

## SEC-4 — Package installs run third-party code beside the agent's secrets

**Status:** open.

**Found:** 2026-09-30, building coding agents.

**Where:** a coding agent's `shell`. `npm install`, `pip
install`, `mise install`, build scripts, and test suites run
third-party code.

**Exposure:** that code runs in the agent's container with the
agent's secrets in its environment. Egress is open.

**Control in place:** secrets reach an agent only by grant. A
coding agent gets the ones its operator granted it.

**Residual risk:** anything granted can be read and sent.
Default-deny egress is not built.

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
