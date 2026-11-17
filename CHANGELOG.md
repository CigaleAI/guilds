# Changelog

Each entry is a version. It says whether the version is breaking,
gives the steps to upgrade a box to it, and lists what changed. What
each digit means, and how an entry is written, is in
[Contributing](docs/CONTRIBUTING.md#versions). The commands every
upgrade runs are in [Maintain](docs/operations/maintain.md#update).

## Unreleased

**Added.** The Drive card's **Folder** shows the picked folder's
name, its full path as the login can read it, and **Open in Google
Drive**. The saved folder is read again on reload, and search results
show their paths. A path the login cannot read in full, a parent with a
blank name, a parent Drive cannot be reached for, cycles, and paths
past 32 folders read **Full path unavailable**. The name and the link
still show, and the saved setting stays. While a save is pending, no
search result can be picked. **Remove folder** asks first, says
nothing in Drive is deleted or trashed and the login stays connected,
and clears only the unsaved pick. The saved folder stays until another
is picked and saved. An inherited login's folder has no removal. Every
login's **Save settings** stays off while a required setting is
missing or empty.

**Added.** While a table's **Access** tab is open, the Tables list
groups the tables by who their access lists reach: **Organisation**,
each guild, and **Individual agents**. A table with no read or write
row in sight is under **Access not fully known**; a read in progress or
failed is listed apart, with **Retry**.

**Added.** A table's **Columns** view says below **Save columns**
why it is off: no column changes to save, the columns being saved,
or each column's rule break by its position and name.

**Fixed.** A subscription agent on Cursor keeps the calls of Cursor's
own tools, its shell commands, file reads, searches, and edits, as rows
of its run with their results. A Cursor tool call event carries fields
of its own beside the tool, and each such event was dropped.

## 0.2.0

**Breaking.** An agent can run on the operator's own Claude Code,
Codex, Cursor, or Antigravity subscription: each of its turns is one
run of that vendor's CLI, a harness, in place of a model on a key.
Such an agent is a subscription agent, and it is the only agent that
works in repositories. The coding agent, its lead model, and the code
tools are removed. A repository can live on any HTTPS git host.

### Upgrade

Back up first ([Maintain](docs/operations/maintain.md#back-up)): the
migrations of this version remove data and cannot be undone.

1. Update the checkout, write the new settings, and rebuild the
   orchestrator, the runtime image, and the operator app together:

   ```text
   git pull
   ./setup.sh
   docker compose up --detach --wait --build
   ```

   `./setup.sh` adds `HARNESS_MCP_PUBLISH` and
   `HARNESS_MCP_SANDBOX_HOST` to `.env` for the Docker engine it
   finds. Migrations `0028` to `0033` apply at boot.
2. Let agent sandboxes reach the new MCP listener, port
   `HARNESS_MCP_PORT` (8090 by default) at the address in
   `HARNESS_MCP_PUBLISH`. On a Linux engine that is the default
   bridge's gateway: a host firewall must accept the port from the
   bridge. Nothing else needs to reach it.
3. Open each former coding agent's Settings. It is a subscription
   agent on the harness it had, with its repositories and its harness
   credential. Its lead model is gone. One on Cursor or Antigravity
   that picks no repository does not run until it picks one.
4. Give each agent that opens pull requests the GitHub connector's
   `create_pull_request` tool, which starts Off. A harness pushes its
   branch with git and holds no `GH_TOKEN`.
5. Pick a model for each agent on a `kimi/` model, and a default model
   for an organisation whose default was one. Kimi Code keys are
   deleted.
6. Update what calls the API, recipe files kept outside the box, and
   extensions, from the lists below.

### Breaking changes

- **Coding agents.** `config.coding` is an unknown key: a create or an
  update that carries it is 422 `unknown keys: coding`. An agent with a
  `harness` has no `model`; one with both is 422. `repositories` on an
  agent with a model is 422. The migration turns each coding agent
  that had a harness into a subscription agent: it keeps its harness,
  harness model and effort, repositories, `max_steps`, and
  `max_tool_calls`, loses its model, and its `temperature`,
  `thinking_level`, `max_tokens`, `max_input_tokens`, and
  `keep_tool_result_generations` take their defaults. A coding agent
  that had no harness keeps its model and loses its repositories. A
  new agent's limits do not start at 200 steps and 200 tool calls.
- **Tools.** `code_task`, `shell`, `shell_status`, `file_read`, and
  `code_search` are removed, with their bindings. A harness uses its
  own shell, file, and search tools.
- **Repositories.** An agent works on the repositories it picks in
  `config.repositories`, not on every repository of its guild; the
  migration gives each coding agent the repositories it had cloned. A
  client that saves a config without `repositories` unpicks them all.
  A repository's `github_id` is `remote_id`. A harness's GitHub token
  pushes branches and does nothing else, and no run sets `GH_TOKEN`.
- **Runs.** A run has no chain: no continuation run, no
  `run.continued` event, and no `chain`, `continued_by_run_id`,
  `repos`, or `harness_task` in its metadata. A message's `source` is
  `system`, `ui`, `schedule`, `group_chat`, or `wake`, with no
  `previous_run_id`. The routes of a `code_task` call's diff and log,
  and of a run's whole changes, are removed; a turn's diff is at
  `GET /api/runs/:id/turns/:call_id/changes/:repository/diff`. A
  stubbed tool result carries no `path` or `range`. Old runs open with
  every message; the migration removes their chain links, their
  run-level changes, and the removed tools' metadata fields.
- **Models.** Kimi Code is not a provider. The organisation models
  payload has no provider `kind` and no model `coding_only`. The
  migration deletes each organisation's Kimi Code key and clears a
  Kimi default model.
- **API.** The agent list and the machine list's agents carry
  `model_source` (`key` or `subscription`) and no `coding`.
  `GET /api/harnesses` returns `{ harnesses }`, each with
  `needs_repository`. The Builder capabilities payload has
  `subscription` in place of `coding`. An apply preview's
  `creates.agents` have no `coding`. Organisation limits name
  `max_subscription_agents`, and its refusal reads "limit reached:
  subscription agents".
- **Recipes.** `config.coding` on a role is the `config.unknown`
  error. A role with a harness and no model is a subscription role,
  the only role that lists repositories, in `config.repositories`. A
  recipe that lists repositories asks for no GitHub connection of its
  own. The findings are `harness.model`, `repositories.key`,
  `repositories.unknown`, `repositories.invalid`,
  `repositories.unused`, `subscription.repository`, and
  `subscription.setting`; `coding.flag`, `model.coding`,
  `harness.coding`, and `repositories.coding` are removed. The
  migration rewrites the recipes the box stores.
- **Configuration.** The orchestrator listens on a second port
  (`HARNESS_MCP_HOST`, `HARNESS_MCP_PORT`, `HARNESS_MCP_URL`), which
  the Compose file publishes. The runtime image changes with the
  orchestrator: an image of 0.1.0 runs no turn.
- **Extensions.** `OrgLimits.maxSubscriptionAgents`,
  `countsAsSubscriptionAgent`, `assertCanAddSubscriptionAgent`,
  `AddedAgents.subscriptionAgents`, `AGENT_MINIMUMS.harness`, and
  `SUBSCRIPTION_CAPABILITY` replace their coding names, and the cap
  counts every agent with a harness. `countOrgSubscriptionAgents` is
  in `db/orgs.ts`. `AgentNeeds` is `{ browser, harness }`.
  `AgentConfig.model` is `string | null`, and `AgentConfig` has no
  `coding`. `Server` gains `harnessMcp`, a second app to listen on.
  `GitProvider.mint` takes the repositories alone. `ProviderKind`,
  `isCodingOnlyModel`, `isMarketplaceModel`, `GitTokenScope`, and the
  `CODING_*` exports are removed. `CostSource` gains `subscription`.
- **Database.** `repositories.github_id` is `remote_id`, and
  `repositories` gains `provider`, `secret_id`, and `username`.
  `run_wakes` has no `root_run_id`. Agent configs and run snapshots
  gain `repositories` and `max_turn_minutes` and lose `coding`.

### Added

- **Subscription agents.** An agent's **Model source** is a model on a
  key or a subscription on a harness. Claude Code and Codex run under
  the run's system prompt in place of their own. Cursor and
  Antigravity keep their vendor's prompt and read the run's as rules,
  so they run only an agent with a repository. A subscription agent
  runs every way a run starts: a direct message, a group delivery, a
  routine, a wake-up. It takes attached images as files in its home.
  The Guild Builder and Prompt Studio write and publish to one.
  `HARNESSES_OFF` turns a harness off for the box.
- **Guilds tools in a harness.** A harness calls the tools its agent
  is offered, connectors included, on the orchestrator's MCP listener,
  under a token that lasts one generation. The run keeps each call as
  it keeps a model's.
- **Run limits and usage.** `max_turn_minutes`, 30 by default, stops a
  turn. `max_tool_calls` counts the harness's own calls with the
  Guilds ones. `max_steps` bounds a Claude Code turn. A turn's tokens
  are recorded at no cost, with `cost_source: "subscription"`.
- **Repositories on any HTTPS host.** A guild repository takes a
  GitHub login or an access token kept as a secret of the
  organisation, with the username git sends. Removing a repository
  from a guild unpicks it from its agents.
- **Turn changes.** A run records what each turn changed in each
  repository, in `turn_changes`, shown under **Turn `<n>`** in its
  **Changes** panel with the diff.

### Security

New register entries:
[SEC-61](docs/architecture/security-register.md#sec-61--a-repositorys-access-token-is-long-lived-and-written-to-its-agents-machine),
[SEC-62](docs/architecture/security-register.md#sec-62--a-subscription-agents-harness-holds-its-whole-prompt-beside-its-secrets-and-the-network),
[SEC-63](docs/architecture/security-register.md#sec-63--on-docker-desktop-every-sandbox-reaches-the-operator-app),
[SEC-64](docs/architecture/security-register.md#sec-64--a-subscription-agents-mcp-token-lets-any-process-on-its-machine-call-its-guilds-tools),
[SEC-65](docs/architecture/security-register.md#sec-65--an-image-attached-to-a-subscription-agents-message-is-a-file-every-process-on-its-machine-reads),
[SEC-66](docs/architecture/security-register.md#sec-66--a-subscription-agents-harness-pushes-to-its-repositories-and-what-it-reads-can-steer-the-push),
[SEC-67](docs/architecture/security-register.md#sec-67--cursor-and-antigravity-run-a-subscription-agents-turn-under-their-vendors-own-system-prompt).
On Docker Desktop every sandbox reaches the operator app's port
(SEC-63): such a box is a development box.

## 0.1.0

The baseline: the first version.
