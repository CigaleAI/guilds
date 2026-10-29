# Changelog

Each entry is a version, its effect on a running box (`no impact`,
`rebuild`, or `breaking`), and what an operator can see. What each
digit means is in [Contributing](docs/CONTRIBUTING.md#versions). The
commands for each effect are in
[Maintain](docs/operations/maintain.md#update).

## Unreleased

**No impact.** `PUT /api/bindings` refuses a `catalog_kind`,
`catalog_id` or `scope` that is not a string, an `enabled` that is not
a boolean, and a `scope_id` or `connection_id` that is neither a string
nor null, and `DELETE /api/bindings` refuses a request without
`catalog_kind`, `catalog_id` or `scope`. Each answers 422, before the
request's user is identified, and names the first field at fault.
Before, the values were read as text and `enabled` as a truth value,
a missing query value was refused by the binding's own checks, and a
body missing several fields named each of them.

**No impact.** `GET /api/builder/capabilities/search` refuses a `q`
given more than once with a 422, before the request's user is
identified. Before, it searched for everything.

**No impact.** `PATCH /api/auth/me` refuses a `name` that is not a
string, and a `timezone` or `color` that is neither a string nor null,
with a 422 that names the field, before the request's user is
identified. Before, a `name` was read as text, so `null` was refused as
an invalid name and a number was checked as its digits.

**No impact.** A request that a route's TypeBox schema refuses, such
as an avatar asked for with two `seed` values, or a request to an
extension's route that declares a schema, answers 422 with a `detail`
that lists the problem as `{ type, loc, msg, input }`. A value of the
wrong JSON type is refused, never converted. Before, it answered 400
with Fastify's message, and a number or a boolean sent where the
schema asked for another scalar type was converted to it. A route
that declares a body schema refuses a request whose body is not a JSON
object the same way.

**No impact.** Every Studio tool refuses a call whose arguments do not
match the parameters the tool declares, with the first mismatch, such
as `/limit: Expected integer` or `/action: Expected required property`.
Before, a mistyped argument counted as left out, a numeric string was
read as a `seq_start` or `seq_end`, a missing `run_id`, `agent_id`, or
`action` was refused with `run not found`, `agent handle required`, or
`action must be create, edit, or delete`, a collection `access` that is
not an object was refused with `access must be an object`, and a Memory
edit without `base_version` was proposed without a check of the live
version. An optional argument sent as `null` counts as left out, where
a collection's `name` or `purpose` sent as `null` was read as the text
`null`.

**No impact.** The browser and terminal views of an agent's sandbox
proxy a path only to the sandbox daemon. Before, a path written as a URL
made the orchestrator send the request to the host it named, with the
sandbox's authorization header
([SEC-52](docs/architecture/security-register.md#sec-52--the-sandbox-proxy-sent-a-request-to-any-host-a-proxied-path-named)).

**No impact.** Applying a recipe gives each seed note its access list
as it writes the note, and each collection it creates its access list
in the same write. An apply that fails on a note's access list, such as
an agent note that names its own role among its writers, fails before
the notes after it are written, where every note was written first. A
created collection whose access list cannot be given is not created.

**No impact.** Applying a recipe creates its agents before it writes
its seed notes. An apply whose agents cannot be created fails before
any seed note is written, where the organisation's and guild's seed
notes were written first and stayed.

**No impact.** A Studio collection request with an unreadable `scope`
or `access` is refused for it before the collection's name, purpose,
columns and `base_updated_at` are checked. Before, a request wrong in
both ways was refused for the collection first.

**No impact.** Applying a Studio note edit rewrites the note where it
sits, as an agent's `note_write` with a path does, still refusing a
note written since the edit was read. The note keeps its title and
search text as they are, and a note whose owner holds the limit of
10 000 live artifacts is edited, where the edit was refused with
`artifact limit reached`.

**No impact.** The Studio References view leaves out a guild note
only when the store refuses to read it, such as a note the operator
cannot read or one deleted since it was listed. A failure to read the
store fails the request, where it left the note out.

**No impact.** The Builder's Validate and the coach's
`builder_validate_recipe` find what the library's Validate finds. A
connector the box lacks that the registry offers is named with the
registry's version, where both said `unknown or unpublished
connector`. The coach's tool checks a tagged handoff's budget against
the recipe's `group_agent_message_limit`, where it checked it against 20.

**No impact.** Creating an agent in a guild at its agent limit answers
409 with `this guild is limited to N agents`, where it answered 500.

**No impact.** Reading a Memory revision by its display path refuses
a path in another organisation with `artifact is not in this
organisation`. Before, an operator handed another organisation's
revision path, by a caller that did not check it, read that agent's
archived Memory
([SEC-50](docs/architecture/security-register.md#sec-50--an-operators-read-of-a-memory-revision-path-is-not-limited-to-its-organisation)).

**No impact.** Capturing a guild as a recipe leaves out a note of a
private guild the user does not operate, whether `include_notes` names
it by display path or by file name. Before, any member who could see
one guild got such a note's text in the recipe draft
([SEC-51](docs/architecture/security-register.md#sec-51--a-recipe-capture-copies-the-notes-of-private-guilds-its-operator-does-not-operate)).

**Rebuild.** Migrations 0015 and 0016 drop `studio_sessions.coach_snapshot`
and `studio_sessions.coach_agent_id`, which held nothing, and the
defaults of `studio_sessions.source_guild_snapshot` and
`recipe_applies.preview`, which every insert sets. Every JSON column
has the type its writers store: runs, sessions and messages, connector
OAuth clients, login settings, tool input schemas, collection columns,
record bodies, studio drafts, recipe bodies and apply previews. A row
read back is used as stored: a field the type requires and the row
lacks fails where it is read, where some readers filled it in before.

**No impact.** A file path in another organisation is refused with
`artifact is not in this organisation` before any other check of the
path, by `studio_list_file_changes`, a Studio focus pin, and an agent's
`note_get`, `note_delete` and `code_task` notes. Before, Studio said
`path is not in this organisation` or `focus file is not in this
organisation`, and an agent got `artifact not found` or the tool's hint
about records and collections.

**No impact.** The Studio inspector, `studio_get_agent_context` and a
Task draft's preflight show an embed warning, or keep the stored Task
hash as the prior effective hash, only when the store refuses the
Task's embeds, such as past the embed budget. A failure to read the
store fails the request, where it was shown as that warning.

**No impact.** A tool result keeps the metadata fields the app reads
(`exit_code`, `cwd`, `path`, `range`, `content_hash`, `lines`,
`log_path`, `timed_out`, `background_id`, `state`, `matches`,
`files`); other keys a sandbox helper reports are not stored. Tool
call arguments are read only as the JSON string both providers send.

**No impact.** A stored recipe opens as stored: reading it no longer
re-applies the recipe checks, which run on every write, import and
registry install.

**No impact.** A remote connector tool whose input schema has a
malformed `type`, `properties` or `required` is offered with
`{"type": "object"}`; an operator-edited input schema with one of
those malformed is refused with a 422 naming the field. A member that
does not exist is a 404.

**No impact.** Capturing a guild as a recipe keeps each agent note
with the role of the agent that owns it, so applying the recipe gives
the note to that role's agent. Before, every captured agent note went
to the recipe's first agent.

**No impact.** A recipe's `design.specialization[].reason` and
`design.handoffs[].kind` are checked against the values the Builder
is told to use. A recipe with another value is refused, naming the
allowed ones, where it was read as written.

**No impact.** The built-in connectors (CoinGecko, X, TwitterAPI.io,
Alchemy, DexPaprika, Google Drive, Gmail, Qonto, Tavily) check each
provider response against the shape they read. A response that does
not match fails the tool call with the field at fault, such as
`CoinGecko returned an unexpected response at /coins/0: …`, where a
malformed item was skipped before. Output for well-formed responses
is unchanged.

**No impact.** A registry connector installed without code signs in
with the credential fields its manifest declares, the ones its Connect
form shows, and its endpoint receives the first of them. Before, such
a connector took a `token` field whatever its manifest declared.

**Rebuild.** Migration 0014 gives every stored agent config each
setting it predates, with the value the app already read for it, so
a config holds every key. Applying a recipe refuses a role whose
config does not validate as an agent's.

**No impact.** The Studio's Tools view takes an organisation's
bindings into account for every agent of the guild: a tool the
organisation turns off is no longer listed as offered.

**Rebuild.** Agents share whole files. A file is an artifact at agent,
guild, or organisation level with a description and an access list;
its bytes sit in the blob store under `ATTACHMENTS_ROOT`. Agents move
files between their home and the store with `file_find`, `file_fetch`,
`file_put`, and `file_delete`, offered to every agent by platform
binding. Operators upload, download, share, and delete files from the
new **State › Files** view of a guild and of an agent, and give each
file an access list like a note's ([Files](docs/concepts/files.md)).
Migration 0013 adds the `file` kind.

**Rebuild.** The diff of a run's changes, the diff of a `code_task`,
and its log answer 503 when the agent's secrets cannot be read, where
they were shown unredacted
([SEC-49](docs/architecture/security-register.md#sec-49--a-runs-diff-and-a-code-tasks-log-were-served-unredacted-when-the-agents-secrets-could-not-be-read)).

**Breaking for API clients.** The notes routes moved from `/files` to
`/notes`: `/api/agents/:id/notes`, `/api/guilds/:id/notes`, and
`/api/org/notes`. The guild's notes view is **State › Notes** at
`/guilds/<id>/state/notes`. The live event `guild.files.changed` is
`guild.artifacts.changed`. An extension that imported `BlobStore` from
`attachments/types.js` imports it from `lib/blob-store.js`. `GET` and
`DELETE /api/agents/:id/scripts/:name` answer a name that is not a
script name with 422 in place of 404.

**Breaking for extensions.** `Repositories` and the export
`db/repositories.js` are gone. The `ServerExtension` factories and
`AppDeps` take the database connection as `db`, a `Queryable`, in
place of `repo`. An extension calls the functions of `db/orgs.js`,
`db/users.js`, `db/connectors.js`, `db/mcp.js`, and `db/usage.js`
with that connection, or a transaction's client, as the first
argument, and each takes one input object per write. A new
organisation's hook is `AppDeps.orgCreated`. `ModelsRepository` is
`ModelsDatabase`, built with `modelsDatabase(db)`
([Extension points](docs/architecture/extension-points.md)).
The export `usage.js` is `usage/index.js`, and `http/usage-view.js` is
`usage/view.js`: `usageForOrg` and `usageForPlatform` take
`{ db, studio, builder }`, which `AppDeps` satisfies. `currentUser`
and `currentOrg` (`http/identity.js`) take that connection as their
first argument. The seeds are under `seed/`: the exports
`db/seed/catalog.js` and `db/seed/mcp-manifests.js` are
`seed/catalog.js` and `seed/mcp-manifests.js`, and `connect` and
`DatabaseExtension` are exported from `seed/connect.js`.
`createPool` takes the handler for a connection that fails while
idle as its second argument, `reportPoolError` from
`observability/runtime.js` for the default report. `getMcpServer`,
`getMcpServerBySlug`, `listServers`, and `updateMcpServerConfig`
are exported from `connectors/servers.js`, with `listServers(db,
scope)` in place of `listMcpServers` and the caller's filter; the functions of
`db/connectors.js` return the stored row, `ConnectorRow`, and are
`getConnector`, `getConnectorBySlug`, `listOrgConnectors`, and
`setConnectorOauthClient`. An `IdentityProvider`'s `currentUser`
resolves to a `UserRow` (`db/users.js`), and `serverItem`
(`mcp/view.js`) takes a `LoadedConnector`. `ArtifactStore`
is the store's dependencies, `{ db, templatesRoot }`, built with
`artifactStore(db, templatesRoot)`; what were its methods are
functions that take it first, one module per sub-domain:
`artifacts/notes.js`, `memory.js`, `collections.js`, `records.js`,
and `access-lists.js` (`writeNote(store, actor, …)`). The export
`recipes/schema.js` is `recipes/parse.js`, which exports
`parseRecipe`, and `credentials/items.js` is `mcp/view.js`.
`RegistryClient.recipe` (`registry/client.js`) is `recipeFile`, which
answers the recipe's bytes checked against the index; `parseRecipe`
reads the document from them. The export
`mcp/index.js` is four: `mcp/pool.js` (`McpPool`, built with
`mcpPool(db)`; its methods take no connection),
`mcp/service.js` (`connectionTools`, `currentTools`, `callTool`,
`retireLogin`), `mcp/errors.js`, and `mcp/database.js`. The connect
flows are under `mcp/`: `connectors/connect.js` is `mcp/connect-token.js`.
`agentMcpConnection` (`access/runtime.js`) is `agentLogins`, which
answers every connected login of the agent, and `McpPool.state` and
`previewConnectorState` take those logins. `GenerationLoopServices.mcp`
is required. An agent's configuration is the new export
`agents/config.js`: `CONFIG_KEYS`, the `DEFAULT_*` settings,
`BROWSER_LANGUAGES`, `withCodingLimits`, `validateBrowserLanguage`,
`validateThinkingLevel`, `assertCodingAgent`, whose previous config is
an `AgentConfig`, and `validateAgentConfig`, which was
`validateConfig`. `isValidSecretAliases` says whether a value is
secret aliases a config takes. `agents/validation.js` keeps
`AgentValidationError` and the name, focus, wake-trigger and avatar
validators. `memoryOf`, `scriptingOf`, `maxScriptsOf`,
`maxWorkspaceMibOf`, `browserLanguageOf`, `secretAliasesOf`,
`keepToolResultGenerationsOf` and the `addMissing*` functions are
gone: an agent row's `config` holds every setting, read by name.
`DEFAULT_AVATAR_SHAPE` and `DEFAULT_AVATAR_COLOR` are in
`avatars/clay.ts`, which the package does not export.
The export `observability/instrument.js` is `instrument.js`. Loading
`observability/log.js` no longer starts Sentry: a process that does
not load `instrument.js` calls `startErrorReporting`, exported from
`error-reporting.js`, first. A domain's service is built from the
connection, and the function that bound its queries is not exported:
`agentScripts(db)` (`scripts/catalog.js`) builds `Scripts`, in place
of `scriptDatabase`, and `agentSchedules(db)` (`schedules/service.js`)
builds `Schedules`, in place of `scheduleDatabase` and
`scheduleQueries`. `ensureClient` (`oauth/index.js`) takes the
connection, a connector and a redirect URI, in place of
`oauthDatabase(db)` and fetch options.
`prepareWorkspace` (`sandbox/index.js`) takes no options and makes no
browser profile; `prepareBrowserWorkspace` makes the home of an agent
with a browser, its profile included. A sandbox provider's
`stopAgent(sandbox, seat, { purge })` is `purgeAgent(sandbox, seat)`,
which stops the agent's processes and removes its runtime files.
`NotesStore` (`notes/store.js`) reads, lists and writes an agent's
notes with `readPrivateNote`, `listPrivateNotes` and `writePrivateNote`,
and lists a guild's shared notes with `listSharedNotes(orgSlug,
guildName, prefix)`, in place of `readNote`, `listNotes` and
`writeNote`, which took a scope. A shared note is read and written
with `readSharedFile` and `writeSharedFile` alone. `notesRoot` and
`resolveScopePath` are gone.

**Breaking for extending repositories.** The Makefile variables
`EDITION`, `EDITION_TEST_PACKAGES`, and `EDITION_COMPOSE_FILES` are
`DEV_STACK`, `EXTENSION_TEST_PACKAGES`, and `EXTENSION_COMPOSE_FILES`.
`scripts/check.sh` reads the root it checks from `CHECK_ROOT` in
place of `EDITION_ROOT`.

**Breaking.** Agents run on machines: containers an organisation
sizes and shares between its agents. A box whose agents each run in
a sandbox of their own moves them onto machines.
[Back up](docs/operations/maintain.md#back-up) first, then:

1. Pull and run `./setup.sh`. It builds `agent-runtime:0.4`. A
   `.env` that sets `SANDBOX_IMAGE` must name `agent-runtime:0.4`
   or an image built from this `runtime/`. Nothing reads
   `SANDBOX_IMAGE_LITE`. Remove it from `.env`.
2. Start the stack with `docker compose up --detach --wait --build`.
   Migration 0004 places every agent on a machine:
   - Each organisation gets a `standard` machine named `default`.
     It holds every agent with neither browser nor coding, 32 at
     most per machine (`default-2`, `default-3`… for the rest).
   - Every other agent gets a machine of its own, named after it,
     with the tier and size its configuration held.
   - A machine's disk cap is 10240 MiB, or its agents' measured
     use plus 1024 MiB when that is larger.
   - The tier and size leave agent configurations and active run
     snapshots.
3. Before generation starts, the server destroys every sandbox
   labelled with an `agent_id`. It moves each
   `WORKSPACE_ROOT/<agent id>` into
   `WORKSPACE_ROOT/<machine id>/<agent id>`. Repositories, scripts,
   and the `.browser` profile with its logins move with it.
4. Reinstall the tools an agent installed in its home with
   `/home/agent` written into them: Python virtualenvs, mise
   installs, and npm installs. The home is `/home/<agent id>`. Run
   the install again from the agent's **CLI** tab, or let the agent
   run it.
5. Update API clients and extensions to the machine API. Agent create
   takes `machine_id`, required when the organisation has more than
   one machine. Agent payloads carry `machine_id` and `machine`. A
   machine holds the tier and size
   ([Machines](docs/concepts/machines.md)). An extension's
   `SandboxProvider`, `GenerationSandboxes`, and `machineHost` are
   keyed by machine
   ([Extension points](docs/architecture/extension-points.md)).

To share machines, move agents onto one under each agent's
**Settings**, **Machine**. Then delete the machines left empty under
**Settings**, **Machines**.

**Breaking.** Notes and tables share one access list per item. Each
row gives the organisation, a guild, or an agent `read` or `write`; an
agent row can also be `none`, which shuts that agent out. An agent's
own row wins, otherwise it gets the better of its guild's row and the
organisation's. Access is edited on the item: a table's **Access** tab,
and **Access** on an open note. A guild's and an agent's **State**,
**Access** lists what it reaches. Migration 0012:

- Copies every live table's rows, gives a guild's own table a
  `write` row for its guild, and gives every organisation table
  without an organisation row the organisation at `read`. An
  organisation table no guild was given is now readable by every
  agent.
- Gives each guild note its guild at `write` and each organisation
  note the organisation at `read`.
- Drops the `read_guild`, `read_org`, `write_guild`, and `write_org`
  grants. Overrides set on one agent are not carried over: that agent
  follows its guild's and the organisation's rows.

Update API clients and recipes:

- `/api/notes/:id/access` and `/api/collections/:id/access` read and
  replace an item's list. The guild and agent `collection-access`
  routes are gone, and `GET /api/collections/:id` no longer carries
  `access_list`.
- The bindings API refuses `artifact_grant`.
- A recipe whose role sets `grants` is refused.
- A Task embed resolves as its agent: a note the agent cannot read
  is not inlined, and the prompt says the file is not reachable.

**Model keys** lists Anthropic. An organisation connects its Claude
API key and offers Claude models to agents, Studio, and the Builder,
called through Anthropic's Messages API.

Studio reads the about and description of the organisation's other
guilds the operator can see. Its tables are the source guild's own and
the organisation's. It adds columns to an organisation table and
changes the guild's rows in its access list, but no longer renames, rewrites, or
deletes one; those changes are made on the **Tables** page. Another
guild's own tables and their records are out of Studio's reach.

A Task or a note references a note as `[[display-path]]`: the run
keeps the link, and the agent reads the note with `note_get` when it
needs it. **Insert › Note** chooses **Embed** or **Reference**, with an
info tooltip on the difference. **Insert › Column** picks a table's
column and inserts it as `` `table.column` ``. A column's description
holds up to 1,000 characters, in a multi-line box. A guild's and an
agent's **State** has a **Tables** sub-tab listing the tables they
reach with their columns, and **Access** always shows its **Tables**
and **Notes** sections.

A routine's timing, description, and instruction can be changed in
place. The agent's **Routine** tab has **Edit routine**,
`PATCH /api/agents/:id/schedules/:schedule_id` takes `cron` or
`window`, `description`, and `instruction` beside `paused`, and agents
in chat get the `schedule_update` tool. A new timing on a running
routine plans its next wake-up from now.
