# Security register

Security issues found in guilds.run, fixed or still open. Unlike
the other chapters, this one keeps history. Each entry says what
was exposed, how it was fixed or what fixing it takes, and what
risk remains. Entries are not removed once fixed. Newest first.
Ids are never reused. A status is **Open**, **Open, accepted** (the
risk is kept by design), or **Fixed** with its date.

| Id | Issue | Status |
|---|---|---|
| [SEC-48](#sec-48--a-run-that-listed-a-logins-tools-for-the-first-time-was-offered-the-ones-that-start-off) | A run that listed a login's tools for the first time was offered the ones that start Off | Fixed 2026-10-26 |
| [SEC-47](#sec-47--github-content-an-agent-reads-through-its-tools-can-steer-its-writes-to-the-logins-repositories) | GitHub content an agent reads through its tools can steer its writes to the login's repositories | Open |
| [SEC-46](#sec-46--deleting-an-agent-a-guild-or-an-organisation-leaves-its-files-bytes-in-the-blob-store) | Deleting an agent, a guild, or an organisation leaves its files' bytes in the blob store | Open |
| [SEC-45](#sec-45--shared-files-carry-arbitrary-bytes-between-agents-and-operators) | Shared files carry arbitrary bytes between agents and operators | Open, accepted |
| [SEC-44](#sec-44--a-recipe-preview-confirms-a-private-guilds-table-and-its-column-types) | A recipe preview confirms a private guild's table and its column types | Open |
| [SEC-43](#sec-43--studio-shows-a-private-guilds-tables-and-records-to-operators-who-cannot-see-that-guild) | Studio shows a private guild's tables and records to operators who cannot see that guild | Fixed 2026-10-21 |
| [SEC-42](#sec-42--a-task-can-embed-a-private-guilds-note-that-its-runs-and-studio-then-show) | A Task can embed a private guild's note that its runs and Studio then show | Fixed 2026-10-22 |
| [SEC-41](#sec-41--an-organisation-could-be-left-without-an-owner) | An organisation could be left without an owner | Fixed 2026-10-18 |
| [SEC-40](#sec-40--a-tool-binding-written-before-a-server-listed-the-tool-turned-it-on) | A tool binding written before a server listed the tool turned it on | Fixed 2026-10-18 |
| [SEC-39](#sec-39--an-operator-could-take-an-agents-name-in-a-guild-they-operate) | An operator could take an agent's name in a guild they operate | Fixed 2026-10-18 |
| [SEC-38](#sec-38--the-antigravity-harness-loads-a-repositorys-customisations-and-runs-with-its-permission-prompts-off) | The Antigravity harness loads a repository's customisations and runs with its permission prompts off | Open |
| [SEC-37](#sec-37--any-organisation-member-can-read-and-change-a-private-guilds-notes-and-databases-through-organisation-wide-routes) | Any organisation member can read and change a private guild's notes and databases through organisation-wide routes | Fixed 2026-10-18 |
| [SEC-36](#sec-36--evidence-the-studio-coach-reads-can-steer-a-proposed-routine-that-wakes-an-agent-unattended) | Evidence the Studio coach reads can steer a proposed routine that wakes an agent unattended | Open, accepted |
| [SEC-35](#sec-35--evidence-the-studio-coach-reads-can-steer-a-proposal-to-widen-an-agents-access) | Evidence the Studio coach reads can steer a proposal to widen an agent's access | Open, accepted |
| [SEC-34](#sec-34--a-studio-session-kept-working-after-its-user-could-no-longer-see-the-guild) | A Studio session kept working after its user could no longer see the guild | Fixed 2026-10-17 |
| [SEC-33](#sec-33--any-organisation-owner-or-admin-can-find-users-by-name-and-add-them-without-their-consent) | Any organisation owner or admin can find users by name and add them without their consent | Open |
| [SEC-32](#sec-32--the-harness-log-the-app-reads-is-redacted-only-with-the-agents-secret-values) | The harness log the app reads is redacted only with the agent's secret values | Open |
| [SEC-31](#sec-31--cursor-runs-a-repositorys-hooks) | Cursor runs a repository's hooks | Open, accepted |
| [SEC-30](#sec-30--personal-harness-subscriptions-used-inside-a-shared-organisation-may-fall-outside-the-vendors-terms) | Personal harness subscriptions used inside a shared organisation may fall outside the vendor's terms | Open |
| [SEC-29](#sec-29--a-repository-can-carry-configuration-its-coding-harness-loads) | A repository can carry configuration its coding harness loads | Open |
| [SEC-28](#sec-28--a-coding-harness-runs-with-its-permission-prompts-off) | A coding harness runs with its permission prompts off | Open |
| [SEC-27](#sec-27--harness-subscription-tokens-and-logins-are-readable-on-the-agents-machine) | Harness subscription tokens and logins are readable on the agent's machine | Open |
| [SEC-26](#sec-26--a-member-could-place-an-agent-beside-a-private-guilds-agents) | A member could place an agent beside a private guild's agents | Fixed 2026-10-13 |
| [SEC-25](#sec-25--the-machine-list-named-the-agents-and-guilds-of-private-guilds) | The machine list named the agents and guilds of private guilds | Fixed 2026-10-13 |
| [SEC-24](#sec-24--agents-on-one-machine-can-read-each-others-homes-tokens-and-sessions) | Agents on one machine can read each other's homes, tokens, and sessions | Open, accepted |
| [SEC-23](#sec-23--a-runtime-connector-may-declare-an-instance-key-of-its-own) | A runtime connector may declare an instance key of its own | Fixed 2026-10-10 |
| [SEC-22](#sec-22--the-github-app-manifest-callback-takes-a-creation-code-from-the-browser) | The GitHub App manifest callback takes a creation code from the browser | Fixed 2026-10-10 |
| [SEC-21](#sec-21--platform-keys-are-written-through-the-api) | Platform keys are written through the API | Fixed 2026-10-10 |
| [SEC-20](#sec-20--connector-code-installed-at-runtime-runs-inside-the-orchestrator) | Connector code installed at runtime runs inside the orchestrator | Open, accepted |
| [SEC-19](#sec-19--a-registrys-index-is-unsigned-so-verified-is-only-that-registrys-word) | A registry's index is unsigned, so `verified` is only that registry's word | Fixed 2026-10-09 where `REGISTRY_PUBLIC_KEY` is set |
| [SEC-18](#sec-18--a-connector-installed-at-runtime-could-claim-the-boxs-credentials) | A connector installed at runtime could claim the box's credentials | Fixed 2026-10-09 |
| [SEC-17](#sec-17--an-organisations-own-mcp-server-makes-the-orchestrator-call-a-url-it-chose) | An organisation's own MCP server makes the orchestrator call a URL it chose | Open, accepted |
| [SEC-16](#sec-16--a-listed-tool-whose-name-reads-as-harmless-now-starts-on) | A listed tool whose name reads as harmless now starts On | Open, accepted |
| [SEC-15](#sec-15--outside-session-mode-the-api-answers-requests-from-any-web-origin) | Outside `session` mode the API answers requests from any web origin | Fixed 2026-10-06 |
| [SEC-14](#sec-14--a-box-outside-the-gcp-cut-encrypts-under-the-all-zero-development-key) | A box outside the GCP cut encrypts under the all-zero development key | Fixed 2026-10-06 |
| [SEC-13](#sec-13--chat-image-uploads-could-persist-unsanitized-bytes-or-leak-across-organisations) | Chat image uploads could persist unsanitized bytes or leak across organisations | Fixed 2026-10-03 |
| [SEC-12](#sec-12--the-github-apps-private-key-mints-tokens-for-every-installation) | The GitHub App's private key mints tokens for every installation | Open |
| [SEC-11](#sec-11--a-github-install-callback-could-name-another-accounts-installation) | A GitHub install callback could name another account's installation | Fixed 2026-09-30 |
| [SEC-10](#sec-10--a-coding-agents-repository-token-is-readable-by-any-process-in-its-sandbox) | A coding agent's repository token is readable by any process in its sandbox | Open |
| [SEC-9](#sec-9--grafts-hosted-features-can-send-repository-history-to-its-vendor) | Graft's hosted features can send repository history to its vendor | Fixed 2026-10-13 |
| [SEC-8](#sec-8--content-a-coding-agent-reads-can-steer-its-commands) | Content a coding agent reads can steer its commands | Open |
| [SEC-7](#sec-7--a-coding-agents-workspace-can-fill-the-shared-disk) | A coding agent's workspace can fill the shared disk | Open |
| [SEC-6](#sec-6--coding-agents-run-commands-as-root-in-the-container) | Coding agents run commands as root in the container | Open |
| [SEC-5](#sec-5--background-commands-make-the-sec-3-race-practical) | Background commands make the SEC-3 race practical | Open |
| [SEC-4](#sec-4--package-installs-run-third-party-code-beside-the-agents-secrets) | Package installs run third-party code beside the agent's secrets | Open |
| [SEC-3](#sec-3--check-then-open-race-on-agent-workspace-paths) | Check-then-open race on agent workspace paths | Open |
| [SEC-2](#sec-2--any-organisation-member-could-write-organisation-wide-secrets) | Any organisation member could write organisation-wide secrets | Fixed 2026-09-30 |
| [SEC-1](#sec-1--links-planted-in-an-agent-workspace-redirect-orchestrator-file-access) | Links planted in an agent workspace redirect orchestrator file access | Fixed 2026-09-30 |

## SEC-48 — A run that listed a login's tools for the first time was offered the ones that start Off

**Status:** fixed 2026-10-26.

**Found:** 2026-10-26, checking the GitHub connector's tools on a live
login.

**Where:** `agentRuntime` in `apps/orchestrator/src/access/runtime.ts`
and `httpAccess` in `apps/orchestrator/src/http/access.ts`.

**Exposure:** both read the bindings covering the agent, then synced
each login's tools, then resolved those tools against the bindings
they had read. A sync writes the Off binding of each tool it lists
for the first time (SEC-16), after that read. A run whose start
listed a login's tools for the first time, or a tool the server had
just added, was offered every such tool that starts Off: tools that
write, delete, send, or merge, on any connector. The run's agent
could call them. The access view showed them On until the next load.

**Fix:** both read the bindings again after the syncs and resolve
tools against those.

**Residual risk:** a run or a view that started before the fix and
listed a tool for the first time was offered it once. The Off binding
it wrote stands, so later runs are not.

## SEC-47 — GitHub content an agent reads through its tools can steer its writes to the login's repositories

**Status:** open.

**Found:** 2026-10-26, giving the GitHub connector its tools.

**Where:** `apps/orchestrator/src/connectors/github/connector.json`,
`mintLoginToken` in `apps/orchestrator/src/github/tokens.ts`, and the
pool's GitHub App session in `apps/orchestrator/src/mcp/index.ts`.

**Exposure:** any agent a GitHub login's connector is on for, coding
or not, reads issues, pull requests, comments, files, and CI logs
through GitHub's hosted MCP server. Anyone who can write to those
repositories, or comment on a public one, writes that text.
Instructions planted in it can steer the agent to call the writing
tools that are On: comment, edit issues, open, review, or merge pull
requests, write files, push, or trigger workflows, on any repository
the login picked. The token the session sends holds every permission
the installation grants, which is broader than the coding token's
`contents` and `pull_requests`. A login at the organisation or a guild
serves every agent below it.

**Control in place:** the token stays in the orchestrator and never
enters a sandbox. GitHub limits it to the login's picked repositories
by id, and it expires within an hour. Tools that write start Off
([What starts Off](../tools-and-connectors/connectors.md#what-starts-off)).
Creating and forking repositories are not listed. Branch protection
and required reviews on GitHub still apply to the App.

**Fix:** not yet. Fixing it takes minting the tool token with only the
permissions its toolsets use, and keeping writes on untrusted content
behind an operator's approval.

**Residual risk:** an agent with a GitHub writing tool On can be
steered to use it on any repository its login picked. Content it
reads can also steer its other tools, as it can a coding agent's
commands (SEC-8).

## SEC-46 — Deleting an agent, a guild, or an organisation leaves its files' bytes in the blob store

**Status:** open.

**Found:** 2026-10-26, designing shared files.

**Where:** `ArtifactFiles` in `apps/orchestrator/src/artifacts/files.ts`
writes each file version to the blob store under
`<org_id>/files/<artifact id>/v<version>`; agent, guild, and
organisation deletion in `apps/orchestrator/src/http/routes.ts` and
`apps/orchestrator/src/db/` removes `artifacts` rows by cascade.

**Exposure:** `file_delete`, `DELETE /api/files/:file_id`, and a replace
remove the object they retire. A cascade does not: the rows go, the
objects stay. Bytes an operator meant to remove by deleting an agent or
a guild survive on disk or in the bucket, unreferenced, until someone
removes them by hand. Nothing serves them: every read goes through a
live row and its access list.

**Control in place:** the objects cannot be reached through the API.
The per-organisation cap counts live rows only, so orphans do not
block new files.

**Fix:** not yet. Fixing it takes removing a file's objects when its
owner is deleted, or a sweep that removes objects no live row names.

**Residual risk:** until then, deleted owners' file bytes stay in the
blob store.

## SEC-45 — Shared files carry arbitrary bytes between agents and operators

**Status:** open, accepted.

**Found:** 2026-10-26, designing shared files.

**Where:** `apps/orchestrator/src/artifacts/files.ts`,
`apps/orchestrator/src/toolbox/file.ts`,
`apps/orchestrator/src/http/file-routes.ts`.

**Exposure:** a file is any bytes up to 10 MiB. Unlike a chat image,
its content is not sniffed: the media type is what the uploader said or
what the name's extension says. A file one agent shares lands, through
`file_fetch`, in another agent's home, where a script or a coding
harness opens it: text inside can steer that agent the way content a
coding agent reads can (SEC-8), and an executable or an archive can
carry anything. An operator downloads a file an agent produced and
opens it on their own machine. Every operator of a guild reaches every
file the guild reaches.

**Control in place:** the orchestrator never opens a file's bytes.
Downloads are served with `Content-Disposition: attachment` and
`X-Content-Type-Options: nosniff`, so the browser saves the file and
never renders it, whatever its type says. The agent-side copy goes
through `readAgentFile` and `writeAgentFile`, which keep both ends
inside the agent's home (SEC-1, SEC-3). Each file carries a required
description and an access list, and every write is in the file
change log with its run and tool call. Size is capped per file and
per organisation. The system prompt says file content is data.

**Fix:** none planned. Scanning or sniffing bytes would not make them
safe to run, and a shared-file feature that refuses unknown types is
not one.

**Residual risk:** an agent that fetches a file and runs or parses it
trusts its sharer. An operator who opens a downloaded file trusts the
agent that made it.

## SEC-44 — A recipe preview confirms a private guild's table and its column types

**Status:** open.

**Found:** 2026-10-21, reviewing what the Builder and recipe apply can see outside a new guild.

**Where:** `planCollections` and `operator` in
`apps/orchestrator/src/recipes/apply.ts`, behind
`POST /api/recipes/:recipe_id/preview` in
`apps/orchestrator/src/http/recipe-routes.ts`.

**Exposure:** the preview matches each recipe collection by name against
every table in the organisation, read as an operator actor with no
hidden guilds. An organisation member can put a guessed name in a
recipe and preview it. If a private guild they do not operate owns a
table of that name, the preview says the table exists and returns its
collection id. Column differences then say which recipe columns it
lacks and which have another type, so repeated previews map its columns.

**Control in place:** every lookup is limited to the recipe's
organisation, and the name has to be guessed. Records are never
returned.

**Fix:** not yet. Fixing it takes matching recipe collections against
organisation tables only, since a recipe can reuse nothing else, with
the previewing operator's hidden guilds.

**Residual risk:** until then, a private guild's table names and column
types can be probed by any organisation member who can preview a recipe.

## SEC-43 — Studio shows a private guild's tables and records to operators who cannot see that guild

**Status:** fixed 2026-10-21.

**Found:** 2026-10-21, reviewing what a Studio session can read outside its source guild.

**Where:** `operatorContext` in
`apps/orchestrator/src/artifacts/store.ts`, which built an operator
actor with no hidden guilds, used by `listTables`, `readTable`, and
`tableContext` in `apps/orchestrator/src/studio/tables.ts`. Record and
collection display paths in `studio_get_artifact`,
`studio_list_file_changes` (`apps/orchestrator/src/studio/tools.ts`),
and file focus pins (`apps/orchestrator/src/studio/focus.ts`) were
accepted for any collection of the organisation.

**Exposure:** the table store filters collections and grants by the
actor's hidden guilds, and the Studio actor hid none. A Studio session
listed every table of a private guild the operator did not operate,
with that guild's name, the table's purpose, columns, and record count.
`studio_get_collection` returned its latest records and the names of
the private guild's agents holding grants on it. A record path of any
table, private guilds included, could be read and its change history
listed. The coach read all of it as evidence and could quote it to the
operator.

**Fix:** a single reach rule (`apps/orchestrator/src/studio/reach.ts`)
limits every Studio table and path read to the source guild's own
collections and the organisation's, so no other guild's own collection
or record is in reach. Table reads build the operator actor with the
operator's hidden guilds, so grants held in a private guild they do not
operate are left out of what an organisation collection shows.

**Residual risk:** none known for collections.

## SEC-42 — A Task can embed a private guild's note that its runs and Studio then show

**Status:** fixed 2026-10-22.

**Found:** 2026-10-19, building the Studio's References view.

**Where:** `inlineTaskEmbeds` and `snapshotTaskEmbeds` in
`apps/orchestrator/src/artifacts/embeds.ts`, which were called with an
operator actor that carried no hidden guilds: run creation in
`apps/orchestrator/src/generation/index.ts`, the Studio agent inspector
in `apps/orchestrator/src/studio/index.ts`, draft previews in
`apps/orchestrator/src/studio/drafts.ts`, and `studio_get_agent_context`
in `apps/orchestrator/src/studio/tools.ts`.

**Exposure:** saving a Task does not check what its embeds name. An
operator of one guild could embed the display path of a guild- or
agent-level note of a private guild they do not operate. Each run of
that agent then carried the note's text in its system prompt, which the
run's System tab shows to everyone who can see the agent's guild. The
Studio Prompt tab of that agent showed it too, in the effective prompt.
Reading it this way took knowing the note's display path, which holds
the private guild's id.

**Fix:** every place that inlines a Task's embeds, run creation and the
three Studio previews, resolves them as the Task's own agent
(`taskEmbedActor` in `apps/orchestrator/src/artifacts/embeds.ts`), so a
note is inlined only when its access list gives that agent, its guild,
or the organisation `read` or `write`. Any other embed becomes a marker
that names the path and says the file is not reachable; the note's text
never enters the prompt. The embed status route and the Studio's
References view check each Task as its agent the same way and report
such an embed as not reachable.

**Residual risk:** a private guild's note reaches another guild's runs
only when its access list gives that guild, one of its agents, or the
organisation a row, which an operator of the private guild chose.

## SEC-41 — An organisation could be left without an owner

**Status:** fixed 2026-10-18.

**Found:** 2026-10-18, reviewing organisation membership changes.

**Where:** `DELETE /api/users/:id`, `PUT` and `DELETE
/api/orgs/:id/members/:user_id` in
`apps/orchestrator/src/http/routes.ts`; `deleteUser`,
`updateMemberRole`, and `deleteMember` in
`apps/orchestrator/src/db/repositories.ts`.

**Exposure:** deleting a user refused the last owner only when the
organisation had guilds. An organisation with other members and no
guild lost its only owner, and no member left could name an owner,
since only an owner manages owners. Demoting and leaving counted the
owners and then wrote in a separate statement, so two owners demoted
or leaving at the same moment could both pass the count.

**Fix:** the repository refuses, with 409, to delete, demote, or
remove the organisation's only owner while it has other members or
guilds. Each change first locks the owner rows of the organisations it
touches, so owner changes in one organisation run one at a time and
each sees the owners the one before it left.

**Residual risk:** an organisation already left without an owner stays
without one.

## SEC-40 — A tool binding written before a server listed the tool turned it on

**Status:** fixed 2026-10-18.

**Found:** 2026-10-18, reviewing tool switches.

**Where:** `PUT /api/bindings` in
`apps/orchestrator/src/http/routes.ts`; `isListedMcpTool` in
`apps/orchestrator/src/db/repositories.ts`.

**Exposure:** an `mcp_tool` binding took any non-empty `catalog_id`.
A binding written On for a name no server listed took effect when a
server later listed a tool by that name. The Off a destructive tool
starts with is written only where no binding exists (SEC-16), so that
tool started On.

**Fix:** an `mcp_tool` binding needs the namespaced name of a tool a
server visible to the organisation lists; any other name is 404.

**Residual risk:** bindings written before the fix stay. A tool a
server stops listing keeps its binding, and the binding applies again
if the server lists the tool once more.

## SEC-39 — An operator could take an agent's name in a guild they operate

**Status:** fixed 2026-10-18.

**Found:** 2026-10-18, reviewing the guild tag checks.

**Where:** `PATCH /api/auth/me` in
`apps/orchestrator/src/http/me-routes.ts`; `updateUserProfile` in
`apps/orchestrator/src/db/repositories.ts`.

**Exposure:** agents and operators share a guild's tags. Adding an
operator, creating an agent, and renaming an agent refuse a name the
other side holds, but a user renaming themselves did not. An operator
could take the name of an agent in a guild they operate, so one tag
named both: a mention meant for the agent could reach the operator,
and the operator's group messages read as the agent's.

**Fix:** renaming refuses, with 409, a name an agent holds in any
guild the user operates. The check and the write run in one
transaction.

**Residual risk:** like the other tag checks, the check takes no lock,
so an agent created with the same name at the same moment can still
clash.

## SEC-38 — The Antigravity harness loads a repository's customisations and runs with its permission prompts off

**Status:** open.

**Found:** 2026-10-18, auditing the architecture documentation.

**Where:** the Antigravity driver in `runtime/guilds-harness`, pinned
to the Antigravity CLI `ANTIGRAVITY_VERSION` in `runtime/Dockerfile`
and started through `runtime/agy`.

**Exposure:** every call runs `agy` with
`--dangerously-skip-permissions`, and the driver writes the CLI's
settings with `toolPermission` and `artifactReviewPolicy` set to
`always-proceed`. The harness runs every command and edit it decides
on, as root (SEC-6), with the agent's granted secrets in its
environment, and through the machine with every agent on it
(SEC-24). The CLI has no switch to ignore customisations: a
repository's own `.agents/`, `GEMINI.md`, and `AGENTS.md` load.
Whoever can push to a repository an Antigravity agent works on can
steer it, as with the instruction files of SEC-28. Whether a
repository's `.agents/` can also carry code that runs on load, as
Cursor's hooks do (SEC-31), is not checked. The Google sign-in is
`~/.gemini/antigravity-cli/antigravity-oauth-token` in the agent's
home, readable
by every process on the machine (SEC-27), and everyone who starts the
agent's runs uses that subscription (SEC-30).

**Control in place:** before every call the driver removes the
user-level customisations in `~/.gemini/` (`GEMINI.md`, `AGENTS.md`,
hooks, MCP configuration, skills, plugins, workflows, and sidecars)
and rewrites the CLI's settings. It passes `--disable-slash-commands`.
It removes from the harness's environment the variables that would
move it off the Google sign-in (`GEMINI_API_KEY`,
`GOOGLE_GEMINI_BASE_URL`, `AGY_ADC_AUTH`, `AGY_LLM_GATEWAY_URL`,
`AGY_ACCOUNT`, and the Google Cloud project variables), and
`GH_TOKEN` and `GITHUB_TOKEN` like every harness. The settings never
spend paid credits past the plan and turn telemetry off. The image
the release workflow publishes carries no Antigravity CLI.

**Fix to make:** establish what a repository's `.agents/` can run on
load. Until then an operator who wants no repository customisation to
reach the harness picks Claude Code or Codex for that agent.

## SEC-37 — Any organisation member can read and change a private guild's notes and databases through organisation-wide routes

**Status:** fixed 2026-10-18.

**Found:** 2026-10-18, auditing the architecture documentation.

**Where:** `GET /api/org/embeddable-notes`, `/api/collections` and
its record routes, and `GET /api/file-changes` in
`apps/orchestrator/src/http/routes.ts`; `operatorFor` in
`apps/orchestrator/src/http/artifact-notes.ts`; `canReadLevel`,
`accessibleCollections`, and `readableCollectionsSql` in
`apps/orchestrator/src/artifacts/store.ts`.

**Exposure:** these routes check only that the user is a member of
the organisation. They then act as an operator actor, which reads
every level in the organisation. A private guild is visible only to
its operators (`canSeeGuild`), but through these routes any member:

- lists up to 500 notes of the organisation with their content,
  agent and guild notes of private guilds included, and reads any
  note by its display path (`/api/org/embeddable-notes`)
- lists every collection of the organisation, a private guild's own
  tables included, and reads, writes, and deletes their records,
  columns, and the tables themselves (`/api/collections…`)
- reads the change history of any display path in the organisation:
  who wrote it, when, and from which run and tool call
  (`/api/file-changes`, which checks no read access at all)

**Control in place:** every query is limited to the caller's
organisation. Guild-scoped routes use `ownedGuild`, which refuses a
guild the user cannot see.

**Fix:** the operator actor of a request carries the private guilds of
the organisation the user does not operate, with their agents
(`operatorFor` and `hiddenGuildsFor`). The artifact store leaves their
guild- and agent-level notes, Memory revisions, and own tables out of
every read, listing, search, and write, refuses them as a table's
guild or a grant's subject, and leaves them out of a table's grant
listing. The file-change routes answer only for display paths the user
can read.

Since 2026-10-22, access to notes and collections is one explicit
access list per item, the `artifact_access` table
(`apps/orchestrator/src/artifacts/access.ts`). A row gives the
organisation, a guild, or one agent `read` or `write`, and an agent
row may be `none`. An agent's own row wins; otherwise it takes the
better of its guild's row and the organisation's row; no row is no
access. A note's level and a collection's owning guild are placement
only. Operators reach every note and collection except those of the
private guilds they do not operate, by the rule above. The access
routes (`/api/notes/:note_id/access`, `/api/collections/:collection_id/access`)
leave out the rows of those guilds and their agents, keep them
unchanged on a `PUT`, and refuse those guilds and agents as subjects.
The `reach` routes leave out their items. Every change to a list is
logged in `config_changes`.

The migration (`apps/orchestrator/drizzle/0012_artifact_access.sql`)
carried every row of the previous collection grants over, and wrote a
guild `write` row for each guild's own collection and each guild note,
and an organisation `read` row for each organisation note and each
organisation collection that had no organisation row. An organisation
collection no guild had been granted therefore became readable by
every agent of the organisation. It deleted
every note grant binding (`artifact_grant`) at every scope without
carrying it over. An agent, a guild, or an organisation whose note
reach was set apart from the defaults therefore follows the new rows:
one that was held back from guild or organisation notes reads them
again, and one that could write organisation notes no longer can,
until an operator adds an agent or guild row on those notes. A new
organisation collection or note starts with the organisation at
`read`, so every agent of the organisation reads it from creation.

**Residual risk:** an organisation table a private guild is granted
stays visible to every member, as every organisation table is; only
the grant to that guild is hidden. The same holds for an organisation
note with a row for a private guild. The operator actors that recipe
apply, capture, and generation build carry no hidden guilds; each acts
for one guild its caller can see.

## SEC-36 — Evidence the Studio coach reads can steer a proposed routine that wakes an agent unattended

**Status:** open, accepted.

**Found:** 2026-10-18, adding routine requests to Prompt Studio.

**Where:** `studio_edit_routine` (actions `create` and `edit`) in
`apps/orchestrator/src/studio/tools.ts` and
`apps/orchestrator/src/studio/routines.ts`.

**Exposure:** the coach reads run transcripts, notes, Memory, group
messages, and data from logins the operator granted to the session.
Any of it can carry text written to steer a model. Steered text could
lead the coach to propose a routine, or a new instruction for one,
that hands an agent attacker-chosen work on every wake-up, with no one
posting, using whatever tools that agent holds.

**Control in place:** the coach writes nothing. A routine request is a
card the operator applies or declines. The card shows the agent, the
timing, and the complete instruction before and after, and says when
the agent wakes. Applying writes only that routine, as the operator,
after checking its agent, timing, description, instruction, and pause
have not moved since the request. The routine's instruction reaches
the agent as a user message on a schedule run, which offers no
schedule tools, so a routine cannot create further routines. The
Studio template treats everything it reads as evidence, never
instructions.

Since 2026-10-19, every routine create, edit, pause, resume, and
delete appends a `config_changes` row with its actor. A routine
applied from a Studio card links to the session and the coach message
that proposed it; one an agent changed links to its run and tool call.
A steered routine can be traced back to the proposal or the step that
made it. The log records; it blocks nothing.

**Residual risk:** an operator who applies a request without reading
the instruction can schedule steered work. Closing it fully takes
refusing routine creation and instruction changes from Studio and
leaving them to the Routine tab.

## SEC-35 — Evidence the Studio coach reads can steer a proposal to widen an agent's access

**Status:** open, accepted.

**Found:** 2026-10-17, adding access requests to Prompt Studio.

**Where:** `studio_edit_access` in `apps/orchestrator/src/studio/tools.ts`
and `apps/orchestrator/src/studio/access.ts`.

**Exposure:** the coach reads run transcripts, notes, Memory, group
messages, and data from logins the operator granted to the session.
Any of it can carry text written to steer a model. Steered text could
lead the coach to propose turning on, for one agent, a native tool, a
file level, a connection, or a connection tool that changes data in an
external service.

**Control in place:** the coach writes nothing. An access request is a
card the operator applies or declines, and applying writes only that
agent's own bindings, as the operator, after checking the agent's
resolved access has not moved since the request. The card shows the
access before and after, marks each connection tool that changes data,
and names every such tool the request gives back. The Studio template
treats everything it reads as evidence, never instructions. A request
that widens access is marked as such, and **Apply all** skips it: it
needs its own apply (added 2026-10-19, with the workspace's approval
tray).

**Residual risk:** an operator who applies a request without reading it
can give an agent a tool that changes data. Closing it fully takes
refusing access widening from Studio and leaving it to the Access pane.

## SEC-34 — A Studio session kept working after its user could no longer see the guild

**Status:** fixed 2026-10-17.

**Found:** 2026-10-17, checking who may apply a Studio access request.

**Where:** `StudioService.getOwnedSession` and `listSessions` in
`apps/orchestrator/src/studio/index.ts`.

**Exposure:** Studio checked that its user could see the source guild
only when a session was created. A user later removed from a private
guild's operators, or whose guild became private, kept the sessions
they had opened: they could read the guild's evidence through the
coach, publish Task drafts, and apply edits to Memory, notes, tables,
and access.

**Fix:** every session request loads the source guild and answers 404
when the user cannot see it, and the session list leaves out sessions
on such guilds.

**Residual risk:** none known. A session whose guild was deleted stays
readable, as before; its live tools are off.

## SEC-33 — Any organisation owner or admin can find users by name and add them without their consent

**Status:** open.

**Found:** 2026-10-17, adding members by name from Settings, Members.

**Where:** `POST /api/orgs/:id/members` in
`apps/orchestrator/src/http/routes.ts`.

**Exposure:** the route takes a user's `name` as well as their id.
Names are short, readable, and unique on the box, so they can be
guessed, unlike ids. A 404 for an unknown name and a 201 or 409 for a
known one tell the caller whether that name holds an account. Every
user owns their personal organisation, so on `trusted-header` every
user can test names that the user directory would hide from them,
and add the account they find to an organisation of theirs. The
added user is not asked. The organisation then shows in their
switcher, a guild admin there can make them an operator, and that
guild's agents can tag them into their Inbox. On `compat-cookie`
whoever reaches the box already reads the whole directory, so the
route reveals nothing new there.

**Control in place:** only an owner or admin of the organisation adds
a member, and only an owner adds an owner. The added user can leave
with `DELETE /api/orgs/:id/members/<their id>`; the app has no
control for leaving. No data of theirs is shared with the
organisation.

**Residual risk:** on a box shared by several teams behind a proxy,
anyone can list who has an account by trying names, and can place
someone in an organisation they did not choose. Fixing it takes an
invitation the user accepts before the membership exists, or keeping
name lookups to the instance admin.

## SEC-32 — The harness log the app reads is redacted only with the agent's secret values

**Status:** open.

**Found:** 2026-10-16, adding the **Log** view of a `code_task` call.

**Where:** `GET /api/runs/:id/tasks/:call_id/log`
(`apps/orchestrator/src/http/coding-routes.ts`), `harnessLog` in
`apps/orchestrator/src/generation/index.ts`, `readHarnessLog` in
`apps/orchestrator/src/toolbox/harness.ts`, and the `log` op of
`runtime/guilds-harness`.

**Exposure:** a harness's event log is stored unredacted in the
agent's home. It holds what the harness read and ran, which can
include values that are not the agent's secrets: the GitHub tokens
minted for the run, a login file's values (SEC-27), and whatever a
file in a repository or the home holds. The endpoint serves the log
to any member who can see the run's guild.

**Control in place:** the log passes redaction with the agent's
secret values before it leaves the machine's helper output, and its
progress lines are cut at 240 characters like live progress. Only a
`code_task` result naming its harness and log can be read, from the
run's own `.runs/` folder, by call id; the helper refuses ids that are
not a single safe path segment and a log that is a symlink. The same
members can already open the agent's terminal and read the file
unredacted.

**Residual risk:** a value that is not one of the agent's secrets
shows as written. A run's GitHub tokens expire within the hour, so a
log read later shows an expired token.

## SEC-31 — Cursor runs a repository's hooks

**Status:** open, accepted on 2026-10-13: Cursor stays available for every repository.

**Found:** 2026-10-13, removing the local state of coding harnesses.

**Where:** the Cursor driver in `runtime/guilds-harness`, pinned to
the Cursor CLI `2026.10.01-e373342`.

**Exposure:** the Cursor CLI runs the hooks a repository declares in
`.cursor/hooks.json` (or `.cursor/hooks/`) on events of its turn,
without the model deciding to run them, and has no flag or variable
to turn project hooks off. Whoever can push to a repository a Cursor
agent works on can run commands in that agent's sandbox, as root
(SEC-6), with its granted secrets in their environment and its git
token through the credential helper (SEC-10), and through the
machine with every agent on it (SEC-24).

**Control in place:** none on the hooks themselves. The driver removes
user-level hooks from `~/.cursor/` before every call, so only the
repository's own hooks run, and those are versioned in the
repository, where review sees them. Claude Code and Codex run no
project hooks (SEC-29). The guild's repositories are the ones its
operators add.

**Residual risk:** a Cursor agent on a repository that takes pushes
from people the organisation does not trust runs their hooks. An
operator who wants no repository hook to run picks Claude Code or
Codex for that agent.

## SEC-30 — Personal harness subscriptions used inside a shared organisation may fall outside the vendor's terms

**Status:** open.

**Found:** 2026-10-13, building coding harnesses.

**Where:** a coding agent's harness credential: the secret its
harness's token variable reads (`CLAUDE_CODE_OAUTH_TOKEN` or
`CURSOR_API_KEY`, or the secret `secret_aliases` maps it to) granted
to it, or a login stored in its home (`runtime/guilds-harness`;
Antigravity has only the login, SEC-38), the
**Harness** select on Create agent and agent Settings
(`apps/web/src/features/agent/settings/configForm.tsx`), and the
**Subscription token** select under it
(`apps/web/src/features/agent/settings/HarnessReadiness.tsx`).

**Exposure:** a harness runs on a subscription, often an operator's
personal one. In an organisation, everyone who can start the agent's
runs uses it: direct runs, group and schedule wakes, and other
agents on its machine that read the credential (SEC-27). A vendor's
terms may restrict a personal subscription to its holder or to
interactive use. The vendor may then suspend the account.

**Control in place:** the note under the **Harness** select reads
"Tasks run on your own subscription. Ensure shared use complies
with your vendor plan." A harness runs only
on a credential someone granted to the agent or logged in with. The
**Subscription token** select lets each agent run on a token its own
operator added, under any secret name, so a shared agent need not
run on another member's subscription. Organisation model keys never
reach the sandbox.

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
`--setting-sources ""`, so no user, project, or local settings are
loaded; `--strict-mcp-config`, so no MCP server loads that the call
does not pass, and it passes none; skills off; and `--settings` with
`disableAllHooks`. The managed settings, which no user or project
file overrides, turn hooks off and project MCP servers off. Every
Codex call ignores `config.toml` and execution-policy rules, disables
hooks, plugins, apps, and memories, and sets `mcp_servers` empty.
Cursor calls never pass `--approve-mcps`. Before every call the driver
removes the harness's user-level configuration and memory from the
agent's home, so what the agent, its commands, an earlier harness
turn, or another agent on the machine (SEC-24) wrote there does not
reach the next call.

**Residual risk:** Cursor runs a repository's hooks (SEC-31).
Instruction files in the repository (`CLAUDE.md`, `AGENTS.md`,
`.cursor/rules`) are read and can steer the harness (SEC-28). Between
the reset and the start of the CLI, another process on the machine
can write configuration back; the window is the time of one exec.

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
no guild tools, no MCP servers, and no hooks but a repository's Cursor hooks (SEC-29, SEC-31). `GH_TOKEN` and
`GITHUB_TOKEN` are never in its environment, nor the variables that
would move it to metered API billing. Since 2026-10-14 those include
`CLAUDE_CODE_USE_BEDROCK` and `CLAUDE_CODE_USE_VERTEX` for Claude
Code; until then a Claude Code agent granted either for other work
could run its harness on metered Bedrock or Vertex. The brief's preamble
tells it never to push or open pull requests. The `coding` prompt
block tells the agent that the harness's final message is data, and
to check its work before pushing it.

**Residual risk:** a steered harness can do anything the sandbox and
the agent's secrets allow: read and send them out, change the
working tree, and push to the guild repositories' unprotected
branches through git (SEC-10). It reaches the other agents on its
machine (SEC-24). Nothing enforces the preamble.

On 2026-10-14 a technical control on `git push` was considered. The
credential helper reaches git through the system configuration and
through `GIT_CONFIG_COUNT` and `GIT_CONFIG_KEY_*` in the environment
(`runtime/Dockerfile`). Passing the harness an environment with
`GIT_CONFIG_COUNT=1` and only the entry that empties the helper would
leave git inside the harness with no GitHub token: a push would fail
instead of being discouraged, and so would a `git fetch` from the
harness. The helper stays so the harness can fetch. The control on
`git push` remains the brief's preamble and the agent's
check-then-push prompt.

## SEC-27 — Harness subscription tokens and logins are readable on the agent's machine

**Status:** open.

**Found:** 2026-10-13, building coding harnesses.

**Where:** the harness credentials in `apps/orchestrator/src/coding/harnesses.ts`
and `runtime/guilds-harness`: the secrets the token variables
`CLAUDE_CODE_OAUTH_TOKEN` and `CURSOR_API_KEY` read, under their own
names or through the agent's secret aliases
(`apps/orchestrator/src/access/runtime.ts`), in the environment of
the agent's commands, and the logins stored in the agent's home
(`~/.claude/.credentials.json`, `~/.codex/auth.json`,
`~/.config/cursor/auth.json`, and the Antigravity Google sign-in
under `~/.gemini/antigravity-cli/`, SEC-38).

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
value joins run redaction like every secret; an alias is the same
value, so redaction covers it under either name. The driver never writes
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

**Status:** open, accepted, by design since 2026-10-13. A machine
is one trust boundary inside an organisation.

**Found:** 2026-10-13, building machines.

**Where:** one container per machine (`RunSandboxes.ensure`,
`apps/orchestrator/src/sandbox/index.ts`), with every agent's home
at `/home/<agent id>` and its runtime files, git tokens among them,
at `/run/guilds/<agent id>/`
([Agent home](../concepts/agent-home.md)).

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

**Status:** fixed 2026-10-10, by design, as connector-declared
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

**Status:** fixed 2026-10-10, by design, as the manifest flow
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

**Status:** fixed 2026-10-10, by design, when the platform keys
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

**Status:** open, accepted, by design since 2026-10-09; opt-in.

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

**Status:** fixed 2026-10-09 where `REGISTRY_PUBLIC_KEY` is set; open
on a box that does not set it.

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

**Status:** open, accepted, by design since 2026-10-09; mitigated.

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

**Status:** open, accepted, by design since 2026-10-09; mitigated.

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

**Status:** fixed 2026-10-13, when Graft left the image.

**Found:** 2026-09-30, building code search.

**Where:** the Graft CLI in `agent-runtime` and the Graft-backed
tools in `runtime/guilds-code`.

**Exposure:** Graft has model-written and hosted features
(`build --deep`, `trail`, `viz`, `init`, `mcp`) that send code or
repository history to a model provider or to its vendor. It
reports usage.

**Fix:** Graft is no longer installed in the runtime image, and
the tools it backed (`code_map`, `code_find`, `code_outline`,
`code_callers`, and `code_search` mode `symbols`) no longer exist.
Code work goes through the coding harness (SEC-28).

**Residual risk:** an agent or its harness can still install Graft,
or any other package, with a command (SEC-4).

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
repository content, issue text, command output, and the harness's
final message are data, never instructions, and that a repository's
contributor guide sets code conventions only. Secrets reach an agent
only by grant.

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

**Where:** the `shell` tool and the coding harness `code_task`
starts. Scripts and the CLI tab run as root too.

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
`guilds-code` and `guilds-harness`, where a link resolves inside the
container.
Background commands end with the idle stop.

**Fix to make:** SEC-3's fix closes this.

## SEC-4 — Package installs run third-party code beside the agent's secrets

**Status:** open.

**Found:** 2026-09-30, building coding agents.

**Where:** a coding agent's `shell` and its harness. `npm install`,
`pip install`, `mise install`, build scripts, and test suites run
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
[Secrets](../concepts/secrets.md).

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
